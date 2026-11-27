/**
 * Full Excel backup: coverage, workbook fidelity, server paging and restore round trip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  AUTH_FORBIDDEN_KEYS,
  FULL_BACKUP_CELL_CHUNK,
  FULL_BACKUP_EXCLUDED_RELATIONS,
  FULL_BACKUP_KNOWN_TABLES,
  FULL_BACKUP_MAX_PAGE_CHARS,
  FULL_BACKUP_SCHEMA_VERSION,
  buildFullBackupWorkbook,
  orderTablesForRestore,
  parseOpenApiTables,
  pickAuthUserFields,
  readFullBackupWorkbook,
} from '../js/fullBackup.js';
import { buildXlsx, readXlsx, readZip, escapeXmlText, unescapeXmlText } from '../js/xlsx.js';
import { handleFullBackupPage, handleFullBackupSchema, resetFullBackupSchemaCache } from '../api/_fullBackup.js';
import { applyRestore, buildRestoreSql, planRestore, recreateAuthUsers } from '../scripts/restoreFromBackup.js';
import backupHandler from '../api/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listSqlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSqlFiles(full));
    else if (entry.name.endsWith('.sql')) out.push(full);
  }
  return out;
}

describe('Full backup - coverage of every table', () => {
  it('knows every table created by any SQL file in the repo (add new tables to FULL_BACKUP_KNOWN_TABLES)', () => {
    const created = new Set();
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    for (const file of [...listSqlFiles(path.join(ROOT, 'supabase')), ...listSqlFiles(path.join(ROOT, 'docs'))]) {
      const sql = fs.readFileSync(file, 'utf8');
      for (const m of sql.matchAll(re)) created.add(m[1].toLowerCase());
    }
    assert.ok(created.size > 40, `expected many tables, found ${created.size}`);
    const uncovered = [...created].filter(
      (t) => !FULL_BACKUP_KNOWN_TABLES.includes(t) && !FULL_BACKUP_EXCLUDED_RELATIONS[t]
    );
    assert.deepEqual(uncovered, [], `Tables not covered by the full backup: ${uncovered.join(', ')}`);
  });

  it('has no duplicate known tables and records the latest migration as the schema version', () => {
    assert.equal(new Set(FULL_BACKUP_KNOWN_TABLES).size, FULL_BACKUP_KNOWN_TABLES.length);
    const migrations = fs
      .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
    assert.equal(FULL_BACKUP_SCHEMA_VERSION, migrations.at(-1).replace(/\.sql$/, ''));
  });

  it('discovers tables from the OpenAPI document, skips views and orders parents first', () => {
    const openapi = {
      paths: { '/kids': { get: {}, post: {} }, '/parents': { get: {}, post: {} }, '/results_with_target': { get: {} }, '/a_view': { get: {} } },
      definitions: {
        kids: {
          properties: {
            id: { description: 'Note:\nThis is a Primary Key.<pk/>', format: 'uuid', type: 'string' },
            parent_id: { description: "Note:\nThis is a Foreign Key to `parents.id`.<fk table='parents' column='id'/>", format: 'uuid', type: 'string' },
            tags: { format: 'text[]', type: 'array', items: { type: 'string' } },
          },
        },
        parents: { properties: { id: { description: '<pk/>', format: 'uuid', type: 'string' }, data: { format: 'jsonb' } } },
        results_with_target: { properties: { id: { description: '<pk/>', format: 'uuid' } } },
        a_view: { properties: { x: { format: 'integer', type: 'integer' } } },
      },
    };
    const { tables, skipped, missingKnown } = parseOpenApiTables(openapi, { knownTables: ['kids', 'parents', 'gone'] });
    assert.deepEqual(tables.map((t) => t.name), ['kids', 'parents']);
    assert.deepEqual(skipped.map((s) => s.name).sort(), ['a_view', 'results_with_target']);
    assert.deepEqual(missingKnown, ['gone']);
    const kids = tables[0];
    assert.deepEqual(kids.primaryKey, ['id']);
    assert.deepEqual(kids.dependsOn, ['parents']);
    assert.equal(kids.columns[1].references, 'parents.id');
    assert.equal(kids.columns[2].format, 'text[]');
    assert.deepEqual(orderTablesForRestore(tables).order, ['parents', 'kids']);
  });

  it('puts cycles last instead of looping', () => {
    const { order, cyclic } = orderTablesForRestore([
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
      { name: 'root', dependsOn: ['auth_users_outside_set'] },
    ]);
    assert.deepEqual(order, ['root', 'a', 'b']);
    assert.deepEqual(cyclic, ['a', 'b']);
  });
});

describe('Full backup - Excel workbook fidelity', () => {
  const tricky = [
    '=SUM(A1:A2)',
    '+91 98765',
    '-@cmd',
    'line1\r\nline2\ttab',
    'ctrl \u0001\u0007\u001f end',
    'literal _x0041_ stays',
    'emoji 🧮 हिन्दी',
    '<tag attr="x">&amp;</tag>',
    '   padded   ',
    '',
  ];

  it('escapes and unescapes XML text exactly', () => {
    for (const s of tricky) assert.equal(unescapeXmlText(escapeXmlText(s)), s);
  });

  it('writes formulas-looking text as plain text (never as formulas)', async () => {
    const bytes = await buildXlsx([{ name: 'S', header: ['v'], rows: [['=1+1']] }], { compress: false });
    const files = await readZip(bytes);
    const xml = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml'));
    assert.ok(xml.includes('t="inlineStr"'));
    assert.ok(!xml.includes('<f>'));
  });

  for (const compress of [true, false]) {
    it(`round-trips every value type exactly (compress=${compress})`, async () => {
      const long = 'x'.repeat(FULL_BACKUP_CELL_CHUNK * 2 + 17) + 'END';
      const columns = [
        { name: 'id', position: 1, format: 'uuid', type: 'string', primaryKey: true, references: null },
        { name: 'txt', position: 2, format: 'text', type: 'string', primaryKey: false, references: null },
        { name: 'n_int', position: 3, format: 'integer', type: 'integer', primaryKey: false, references: null },
        { name: 'n_num', position: 4, format: 'numeric', type: 'number', primaryKey: false, references: null },
        { name: 'flag', position: 5, format: 'boolean', type: 'boolean', primaryKey: false, references: null },
        { name: 'at', position: 6, format: 'timestamp with time zone', type: 'string', primaryKey: false, references: null },
        { name: 'doc', position: 7, format: 'jsonb', type: '', primaryKey: false, references: null },
        { name: 'ids', position: 8, format: 'uuid[]', type: 'array', primaryKey: false, references: null },
      ];
      const rows = tricky.map((t, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        txt: t,
        n_int: i - 3,
        n_num: i === 2 ? 0.1 + 0.2 : 1234.5678,
        flag: i % 2 === 0,
        at: '2026-11-26T05:30:12.345678+00:00',
        doc: i === 0 ? 'a json string' : i === 1 ? null : { nested: { arr: [1, 'two', null, true] }, text: t },
        ids: i === 3 ? [] : ['11111111-1111-4111-8111-111111111111'],
      }));
      rows.push({ id: '00000000-0000-4000-8000-999999999999', txt: long, n_int: null, n_num: null, flag: null, at: null, doc: { big: long }, ids: null });

      const { bytes, summary } = await buildFullBackupWorkbook({
        exportedAt: '2026-11-26T06:00:00.000Z',
        sourceProject: 'testproj',
        tables: [{ name: 'things', columns, primaryKey: ['id'], dependsOn: [], rows }],
        authUsers: [],
        compress,
      });
      assert.equal(summary.rows, rows.length);

      const back = await readFullBackupWorkbook(bytes);
      assert.equal(back.meta.source_project, 'testproj');
      const t = back.tables[0];
      assert.equal(t.rows.length, rows.length);
      rows.forEach((orig, i) => {
        const got = t.rows[i];
        assert.equal(got.id, orig.id);
        assert.equal(got.txt, orig.txt);
        assert.equal(got.n_int, orig.n_int === null ? null : String(orig.n_int));
        assert.equal(got.n_num, orig.n_num === null ? null : String(orig.n_num));
        assert.equal(got.flag, orig.flag);
        assert.equal(got.at, orig.at);
        assert.deepEqual(got.doc, orig.doc);
        assert.deepEqual(got.ids, orig.ids);
      });

      // A standard reader sees the long value split into the _overflow sheet.
      const { sheets } = await readXlsx(bytes);
      const overflow = sheets.find((s) => s.name === '_overflow');
      assert.ok(overflow.rows.length > 2);
      for (const s of sheets) for (const r of s.rows) for (const c of r || []) if (c && c.type === 's') assert.ok(c.value.length <= 32767);
    });
  }

  it('splits very large tables across several sheets and reads them back in order', async () => {
    const columns = [{ name: 'k', position: 1, format: 'integer', type: 'integer', primaryKey: true, references: null }];
    const rows = Array.from({ length: 7 }, (_, i) => ({ k: i + 1 }));
    const { bytes } = await buildFullBackupWorkbook({
      exportedAt: '2026-11-26T06:00:00.000Z',
      tables: [{ name: 'live_class_recording_audit_log', columns, primaryKey: ['k'], dependsOn: [], rows }],
      maxRowsPerSheet: 3,
    });
    const { sheets } = await readXlsx(bytes);
    const names = sheets.map((s) => s.name).filter((n) => n.startsWith('live_class'));
    assert.equal(names.length, 3);
    assert.ok(names.every((n) => n.length <= 31));
    const back = await readFullBackupWorkbook(bytes);
    assert.deepEqual(back.tables[0].rows.map((r) => r.k), ['1', '2', '3', '4', '5', '6', '7']);
  });

  it('rejects damaged files and files that are not full backups', async () => {
    const plain = await buildXlsx([{ name: 'Sheet1', rows: [['hi']] }]);
    await assert.rejects(readFullBackupWorkbook(plain), /not a Trendz full backup/);

    const { bytes } = await buildFullBackupWorkbook({
      exportedAt: '2026-11-26T06:00:00.000Z',
      tables: [{ name: 't', columns: [{ name: 'a', position: 1, format: 'text' }], primaryKey: [], dependsOn: [], rows: [{ a: 'x' }] }],
      compress: false,
    });
    const corrupted = new Uint8Array(bytes);
    const idx = Buffer.from(corrupted).indexOf('_meta');
    corrupted[corrupted.length - 200] ^= 0xff;
    assert.ok(idx > 0);
    await assert.rejects(readFullBackupWorkbook(corrupted), /damaged|Checksum|Corrupt|valid/);
  });
});

describe('Full backup - login accounts', () => {
  it('never keeps password hashes, tokens or identities', () => {
    const user = {
      id: 'u1',
      email: 'stu001@trendz.local',
      encrypted_password: '$2a$10$hash',
      confirmation_token: 'tok',
      identities: [{ identity_data: { sub: 'x' } }],
      user_metadata: { full_name: 'A', refresh_token: 'nope' },
      app_metadata: { provider: 'email', providers: ['email'] },
      created_at: '2026-01-01T00:00:00Z',
    };
    const safe = pickAuthUserFields(user);
    const text = JSON.stringify(safe);
    for (const k of AUTH_FORBIDDEN_KEYS) assert.ok(!text.includes(`"${k}"`), k);
    assert.ok(!text.includes('$2a$'));
    assert.equal(safe.email, 'stu001@trendz.local');
    assert.deepEqual(safe.app_metadata, { provider: 'email', providers: ['email'] });
  });

  it('recreates missing accounts with their original ids and skips existing ones', async () => {
    const created = [];
    const admin = {
      auth: {
        admin: {
          getUserById: async (id) => ({ data: { user: id === 'keep' ? { id } : null } }),
          createUser: async (attrs) => {
            created.push(attrs);
            return { data: { user: { id: attrs.id } }, error: null };
          },
        },
      },
    };
    const res = await recreateAuthUsers(
      [
        { id: 'keep', email: 'a@trendz.local' },
        { id: 'new-1', email: 'b@trendz.local', email_confirmed_at: '2026-01-01', user_metadata: { full_name: 'B' } },
      ],
      admin,
      { passwordFor: () => 'Temp-123' }
    );
    assert.deepEqual(res.map((r) => r.status), ['already exists', 'created']);
    assert.equal(created.length, 1);
    assert.equal(created[0].id, 'new-1');
    assert.equal(created[0].email_confirm, true);
    assert.equal(created[0].password, 'Temp-123');
  });
});

describe('Full backup - server export endpoint', () => {
  const openapi = {
    paths: { '/big': { post: {} } },
    definitions: {
      big: {
        properties: {
          id: { description: '<pk/>', format: 'integer', type: 'integer' },
          blob: { format: 'text', type: 'string' },
        },
      },
    },
  };
  const fetchImpl = async (url, init) => {
    assert.ok(String(url).endsWith('/rest/v1/'));
    assert.equal(init.headers.apikey, 'svc');
    return { ok: true, status: 200, json: async () => openapi };
  };

  function fakeSupabase(total, blobSize = 10) {
    const calls = [];
    return {
      calls,
      from(table) {
        const q = { table, orders: [], range: null };
        const api = {
          select() {
            return api;
          },
          order(col, opts) {
            q.orders.push([col, opts.ascending]);
            return api;
          },
          range(a, b) {
            q.range = [a, b];
            calls.push(q);
            const rows = [];
            for (let i = a; i <= Math.min(b, total - 1); i++) rows.push({ id: i + 1, blob: 'b'.repeat(blobSize) });
            return Promise.resolve({ data: rows, error: null });
          },
        };
        return api;
      },
      auth: {
        admin: {
          listUsers: async ({ page, perPage }) => {
            const all = Array.from({ length: 1500 }, (_, i) => ({ id: `u${i}`, email: `s${i}@trendz.local`, encrypted_password: 'hash' }));
            return { data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null };
          },
        },
      },
    };
  }

  it('returns every table, the restore order and all login accounts (paginated, safe fields)', async () => {
    resetFullBackupSchemaCache();
    const supabase = fakeSupabase(0);
    const res = await handleFullBackupSchema({ supabase, url: 'https://abcd.supabase.co', serviceRoleKey: 'svc', fetchImpl });
    assert.equal(res.ok, true);
    assert.equal(res.source_project, 'abcd');
    assert.deepEqual(res.restore_order, ['big']);
    assert.equal(res.auth_users.length, 1500);
    assert.ok(!JSON.stringify(res.auth_users).includes('encrypted_password'));
  });

  it('pages past 1,000 rows in primary-key order and rejects unknown tables', async () => {
    resetFullBackupSchemaCache();
    const supabase = fakeSupabase(2500);
    const seen = [];
    let offset = 0;
    while (offset !== null) {
      const { body } = await handleFullBackupPage({ supabase, url: 'u', serviceRoleKey: 'svc', fetchImpl, table: 'big', offset });
      seen.push(...body.rows.map((r) => r.id));
      offset = body.next_offset;
    }
    assert.equal(seen.length, 2500);
    assert.equal(new Set(seen).size, 2500);
    assert.deepEqual(supabase.calls[0].orders, [['id', true]]);

    const bad = await handleFullBackupPage({ supabase, url: 'u', serviceRoleKey: 'svc', fetchImpl, table: 'auth.users', offset: 0 });
    assert.equal(bad.httpStatus, 400);
  });

  it('trims oversized pages so responses stay under the hosting limit', async () => {
    resetFullBackupSchemaCache();
    const blobSize = Math.ceil(FULL_BACKUP_MAX_PAGE_CHARS / 300);
    const supabase = fakeSupabase(1000, blobSize);
    const { body } = await handleFullBackupPage({ supabase, url: 'u', serviceRoleKey: 'svc', fetchImpl, table: 'big', offset: 0 });
    assert.ok(body.rows.length < 1000 && body.rows.length > 0);
    assert.equal(body.next_offset, body.rows.length);
    assert.ok(JSON.stringify(body).length < 4_000_000);
  });

  it('requires an admin caller for full backup actions', async () => {
    let statusCode = null;
    const res = { setHeader() {}, status(c) { statusCode = c; return this; }, json() { return this; } };
    await backupHandler({ method: 'POST', headers: {}, body: { action: 'full_backup_schema' } }, res);
    assert.equal(statusCode, 401);
  });
});

describe('Full backup - restore into a fresh database (PGlite)', () => {
  const SCHEMA = `
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id), student_code text UNIQUE, full_name text, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.categories (id uuid PRIMARY KEY, name text NOT NULL, sort_order int NOT NULL DEFAULT 0);
    CREATE TABLE public.results (
      id uuid PRIMARY KEY, student_id uuid NOT NULL REFERENCES public.profiles(id), category_id uuid REFERENCES public.categories(id),
      correct int, total int, time_seconds numeric, note text, settings jsonb, tags text[], verified boolean DEFAULT false,
      entry_date date, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.result_audit (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), result_id uuid, action text, changed_at timestamptz DEFAULT now());
    CREATE TABLE public.daily_todo_log (student_id uuid REFERENCES public.profiles(id), day date, tasks_done int, PRIMARY KEY (student_id, day));
    CREATE FUNCTION public.audit_results() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.result_audit(result_id, action) VALUES (NEW.id, 'insert'); RETURN NEW; END $$;
    CREATE TRIGGER results_audit AFTER INSERT ON public.results FOR EACH ROW EXECUTE FUNCTION public.audit_results();
  `;
  const TABLES = ['categories', 'daily_todo_log', 'profiles', 'result_audit', 'results'];

  async function newDb() {
    const db = new PGlite();
    await db.exec(SCHEMA);
    return db;
  }
  const asClient = (db) => ({
    query: async (sql, params) => (params ? db.query(sql, params) : (await db.exec(sql)).at(-1) || { rows: [] }),
  });

  async function dumpTable(db, name) {
    const res = await db.query(`SELECT to_jsonb(t) AS j FROM public.${name} t ORDER BY 1`);
    return res.rows.map((r) => r.j);
  }

  async function exportLikePostgrest(db) {
    // Same shapes PostgREST returns: JSON values per column, columns in ordinal order.
    const tables = [];
    for (const name of TABLES) {
      const cols = await db.query(
        `SELECT a.attname AS name, a.attnum AS position, format_type(a.atttypid, a.atttypmod) AS format,
                coalesce((SELECT true FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) AS pk,
                (SELECT c2.relname FROM pg_constraint k JOIN pg_class c2 ON c2.oid = k.confrelid
                   WHERE k.conrelid = a.attrelid AND k.contype = 'f' AND a.attnum = ANY(k.conkey) AND c2.relnamespace = 'public'::regnamespace LIMIT 1) AS ref
         FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [`public.${name}`]
      );
      const columns = cols.rows.map((c) => ({
        name: c.name,
        position: c.position,
        format: c.format === 'timestamp with time zone' ? c.format : c.format,
        type: '',
        primaryKey: c.pk,
        references: c.ref ? `${c.ref}.id` : null,
      }));
      const rows = (await db.query(`SELECT row_to_json(t) AS j FROM public.${name} t`)).rows.map((r) => r.j);
      tables.push({
        name,
        columns,
        primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name),
        dependsOn: [...new Set(columns.filter((c) => c.references).map((c) => c.references.split('.')[0]))].filter((t) => t !== name),
        rows,
      });
    }
    return tables;
  }

  async function seed(db) {
    await db.exec(`
      INSERT INTO auth.users VALUES ('a0000000-0000-4000-8000-000000000001'), ('a0000000-0000-4000-8000-000000000002');
      INSERT INTO public.profiles VALUES
        ('a0000000-0000-4000-8000-000000000001', 'STU001', 'Asha ''Quote'' =Formula', true, '2026-01-02T03:04:05.123456+00'),
        ('a0000000-0000-4000-8000-000000000002', 'STU002', E'Line\\nBreak\\r\\nCRLF', false, '2026-01-03T00:00:00+00');
      INSERT INTO public.categories VALUES ('c0000000-0000-4000-8000-000000000001', 'Addition', 1);
      INSERT INTO public.results VALUES
        ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 9, 10, 61.25, '', '{"mode":"flash","speeds":[500,250],"note":"$trz$ inside"}', '{a,"b c",NULL}', true, '2026-11-25', '2026-11-25T10:11:12.999999+05:30'),
        ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, NULL, '2026-11-26T00:00:00Z');
      INSERT INTO public.daily_todo_log VALUES ('a0000000-0000-4000-8000-000000000001', '2026-11-25', 3);
    `);
  }

  it('restores every row and column exactly, parents first, without firing audit triggers', async () => {
    const source = await newDb();
    await seed(source);
    const tables = await exportLikePostgrest(source);
    const { bytes } = await buildFullBackupWorkbook({ exportedAt: '2026-11-26T06:00:00Z', tables, authUsers: [] });
    const backup = await readFullBackupWorkbook(bytes);

    const plan = planRestore(backup);
    const order = plan.tables.map((t) => t.name);
    assert.ok(order.indexOf('profiles') < order.indexOf('results'));
    assert.ok(order.indexOf('categories') < order.indexOf('results'));
    assert.ok(buildRestoreSql(backup).includes('DISABLE TRIGGER USER'));

    const target = await newDb();
    await target.exec(`INSERT INTO auth.users VALUES ('a0000000-0000-4000-8000-000000000001'), ('a0000000-0000-4000-8000-000000000002');`);
    const counts = await applyRestore(backup, asClient(target));
    assert.equal(counts.results, 2);
    assert.equal(counts.result_audit, 2, 'trigger must not add audit rows during restore');

    for (const name of TABLES) {
      assert.deepEqual(await dumpTable(target, name), await dumpTable(source, name), `table ${name} differs after restore`);
    }
    // Triggers are back on afterwards.
    await target.exec(`INSERT INTO public.results (id, student_id) VALUES ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000001')`);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM public.result_audit')).rows[0].n, 3);
  });

  it('refuses to overwrite a database that already has data unless told to', async () => {
    const source = await newDb();
    await seed(source);
    const backup = await readFullBackupWorkbook(
      (await buildFullBackupWorkbook({ exportedAt: '2026-11-26T06:00:00Z', tables: await exportLikePostgrest(source) })).bytes
    );
    await assert.rejects(applyRestore(backup, asClient(source)), /already have rows/);

    // profiles created by recreated logins are fine and get overwritten with the backup values.
    const target = await newDb();
    await target.exec(`
      INSERT INTO auth.users VALUES ('a0000000-0000-4000-8000-000000000001'), ('a0000000-0000-4000-8000-000000000002');
      INSERT INTO public.profiles (id, student_code, full_name) VALUES ('a0000000-0000-4000-8000-000000000001', 'STU001', 'placeholder');
    `);
    await applyRestore(backup, asClient(target));
    assert.deepEqual(await dumpTable(target, 'profiles'), await dumpTable(source, 'profiles'));

    // Without the matching login accounts the whole restore rolls back.
    const noAuth = await newDb();
    await assert.rejects(applyRestore(backup, asClient(noAuth)));
    assert.equal((await noAuth.query('SELECT count(*)::int AS n FROM public.categories')).rows[0].n, 0);
  });
});
