#!/usr/bin/env node
/**
 * Trendz Tracker - Restore a database from a full Excel backup (scripts/restoreFromBackup.js)
 *
 * Admin/operator tool. Runs on your computer with credentials for the NEW project.
 * Nothing is written unless you pass --recreate-auth or --apply.
 *
 *   node scripts/restoreFromBackup.js trendz-full-backup-2026-11-26.xlsx
 *       Dry run: checks the file (checksums, row counts, JSON) and prints the restore plan.
 *
 *   --sql-out restore.sql
 *       Writes one SQL transaction that inserts every table parents-first. Run it with psql.
 *
 *   --recreate-auth --passwords-out temp-passwords.csv
 *       Recreates every login account with its ORIGINAL id and email through the Supabase
 *       admin API (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Each account gets a new random
 *       temporary password, written only to that CSV. Existing accounts are left untouched.
 *
 *   --apply
 *       Runs the SQL directly against RESTORE_DATABASE_URL (Postgres connection string).
 *       Refuses when any target table already has rows, unless --allow-nonempty is given
 *       (then rows with the same primary key are overwritten with the backup's values).
 *
 *   --only table1,table2     restore just these tables
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFullBackupWorkbook } from '../js/fullBackup.js';

const BATCH_ROWS = 500;

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function dollarQuote(text) {
  let tag = 'trz';
  while (text.includes(`$${tag}$`)) tag = `trz${crypto.randomBytes(4).toString('hex')}`;
  return `$${tag}$${text}$${tag}$`;
}

/** Summarises what a restore would do. */
export function planRestore(backup, { only = null } = {}) {
  const tables = backup.tables.filter((t) => !only || only.includes(t.name));
  return {
    exportedAt: backup.meta.exported_at,
    schemaVersion: backup.meta.schema_version,
    sourceProject: backup.meta.source_project,
    authUsers: backup.authUsers ? backup.authUsers.length : 0,
    tables: tables.map((t, i) => ({ order: i + 1, name: t.name, rows: t.rows.length, dependsOn: t.dependsOn })),
    totalRows: tables.reduce((n, t) => n + t.rows.length, 0),
  };
}

/**
 * Builds a single-transaction SQL script that restores every table in foreign-key order.
 * User triggers are paused per table so audit, streak and notification triggers do not
 * create extra rows; foreign keys and constraints stay enforced.
 */
export function buildRestoreSql(backup, { only = null, schema = 'public', batchRows = BATCH_ROWS } = {}) {
  const tables = backup.tables.filter((t) => !only || only.includes(t.name));
  const lines = [
    `-- Trendz Tracker restore script`,
    `-- Backup exported at ${backup.meta.exported_at} (schema ${backup.meta.schema_version})`,
    `-- Tables: ${tables.length}, rows: ${tables.reduce((n, t) => n + t.rows.length, 0)}`,
    'BEGIN;',
    "SET LOCAL statement_timeout = 0;",
  ];
  for (const t of tables) {
    const rel = `${quoteIdent(schema)}.${quoteIdent(t.name)}`;
    lines.push('', `-- ${t.name}: ${t.rows.length} rows`);
    if (t.rows.length === 0) continue;
    const cols = t.columns.map((c) => c.name);
    const colList = cols.map(quoteIdent).join(', ');
    const pk = t.primaryKey || [];
    const updates = cols.filter((c) => !pk.includes(c)).map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
    const conflict = pk.length
      ? updates.length
        ? ` ON CONFLICT (${pk.map(quoteIdent).join(', ')}) DO UPDATE SET ${updates.join(', ')}`
        : ` ON CONFLICT (${pk.map(quoteIdent).join(', ')}) DO NOTHING`
      : '';
    lines.push(`ALTER TABLE ${rel} DISABLE TRIGGER USER;`);
    for (let i = 0; i < t.rows.length; i += batchRows) {
      const json = JSON.stringify(t.rows.slice(i, i + batchRows));
      lines.push(
        `INSERT INTO ${rel} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${rel}, ${dollarQuote(json)}::json)${conflict};`
      );
    }
    lines.push(`ALTER TABLE ${rel} ENABLE TRIGGER USER;`);
  }
  lines.push('', 'COMMIT;', '');
  return lines.join('\n');
}

/** Returns tables in the target database that already contain rows. */
export async function findNonEmptyTables(client, tableNames, schema = 'public') {
  const busy = [];
  for (const name of tableNames) {
    const exists = await client.query('SELECT to_regclass($1) AS rel', [`${schema}.${name}`]);
    if (!exists.rows[0] || !exists.rows[0].rel) {
      throw new Error(`Table ${schema}.${name} does not exist in the target database. Run the migrations first.`);
    }
    const res = await client.query(`SELECT 1 FROM ${quoteIdent(schema)}.${quoteIdent(name)} LIMIT 1`);
    if (res.rows.length) busy.push(name);
  }
  return busy;
}

/**
 * Runs the restore SQL. `client` is a connected pg-compatible client ({ query }).
 * profiles is allowed to be non-empty because recreating logins can create profile rows.
 */
export async function applyRestore(backup, client, { only = null, allowNonEmpty = false, schema = 'public' } = {}) {
  const names = backup.tables.filter((t) => !only || only.includes(t.name)).map((t) => t.name);
  const busy = (await findNonEmptyTables(client, names, schema)).filter((n) => n !== 'profiles');
  if (busy.length && !allowNonEmpty) {
    throw new Error(
      `Refusing to restore: these tables already have rows: ${busy.join(', ')}. ` +
        'Restore into a fresh project, or pass --allow-nonempty to overwrite matching rows.'
    );
  }
  try {
    await client.query(buildRestoreSql(backup, { only, schema }));
  } catch (err) {
    // The script runs in one transaction; make sure the session is not left in a failed transaction.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  const counts = {};
  for (const name of names) {
    const res = await client.query(`SELECT count(*)::int AS n FROM ${quoteIdent(schema)}.${quoteIdent(name)}`);
    counts[name] = res.rows[0].n;
  }
  return counts;
}

export function generateTempPassword() {
  return `Tz-${crypto.randomBytes(9).toString('base64url')}`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Recreates login accounts with their original ids through the Supabase admin API.
 * Returns [{ id, email, status, password? }]; passwords are only returned for new accounts.
 */
export async function recreateAuthUsers(authUsers, adminClient, { passwordFor = generateTempPassword } = {}) {
  const results = [];
  for (const u of authUsers || []) {
    const { data: existing } = await adminClient.auth.admin.getUserById(u.id);
    if (existing && existing.user) {
      results.push({ id: u.id, email: u.email, status: 'already exists' });
      continue;
    }
    const password = passwordFor(u);
    const attrs = {
      id: u.id,
      email: u.email || undefined,
      phone: u.phone || undefined,
      password,
      email_confirm: Boolean(u.email_confirmed_at || u.confirmed_at),
      phone_confirm: Boolean(u.phone_confirmed_at),
      user_metadata: u.user_metadata || {},
      app_metadata: u.app_metadata || {},
    };
    const { error } = await adminClient.auth.admin.createUser(attrs);
    if (error) {
      results.push({ id: u.id, email: u.email, status: `failed: ${error.message}` });
      continue;
    }
    results.push({ id: u.id, email: u.email, status: 'created', password });
  }
  return results;
}

function parseArgs(argv) {
  const args = { file: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (['sql-out', 'passwords-out', 'only'].includes(key)) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else if (!args.file) {
      args.file = a;
    }
  }
  return args;
}

async function main() {
  const { file, flags } = parseArgs(process.argv.slice(2));
  if (!file || flags.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(file ? 0 : 1);
  }
  const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const backup = await readFullBackupWorkbook(new Uint8Array(fs.readFileSync(file)));
  const plan = planRestore(backup, { only });

  console.log(`Backup exported ${plan.exportedAt} from ${plan.sourceProject || 'unknown project'} (schema ${plan.schemaVersion})`);
  console.log(`File checks passed: ${plan.tables.length} tables, ${plan.totalRows} rows, ${plan.authUsers} login accounts.`);
  console.log('Restore order:');
  for (const t of plan.tables) console.log(`  ${String(t.order).padStart(2)}. ${t.name} (${t.rows})`);

  if (flags['sql-out']) {
    fs.writeFileSync(flags['sql-out'], buildRestoreSql(backup, { only }));
    console.log(`Wrote ${path.resolve(flags['sql-out'])}`);
  }

  if (flags['recreate-auth']) {
    if (!flags['passwords-out']) throw new Error('--recreate-auth needs --passwords-out <file.csv> for the temporary passwords.');
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the NEW project.');
    }
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const results = await recreateAuthUsers(backup.authUsers || [], admin);
    const csv = ['id,email,status,temporary_password', ...results.map((r) => [r.id, r.email, r.status, r.password || ''].map(csvCell).join(','))];
    fs.writeFileSync(flags['passwords-out'], csv.join('\r\n') + '\r\n', { mode: 0o600 });
    const created = results.filter((r) => r.status === 'created').length;
    const failed = results.filter((r) => r.status.startsWith('failed'));
    console.log(`Login accounts: ${created} created, ${results.length - created - failed.length} already existed, ${failed.length} failed.`);
    console.log(`Temporary passwords written to ${path.resolve(flags['passwords-out'])} - keep this file private.`);
    if (failed.length) process.exitCode = 1;
  }

  if (flags.apply) {
    const url = process.env.RESTORE_DATABASE_URL;
    if (!url) throw new Error('Set RESTORE_DATABASE_URL to the NEW database connection string.');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const counts = await applyRestore(backup, client, { only, allowNonEmpty: Boolean(flags['allow-nonempty']) });
      let bad = 0;
      for (const t of plan.tables) {
        const ok = counts[t.name] >= t.rows;
        if (!ok) bad++;
        console.log(`  ${ok ? 'ok ' : 'LOW'} ${t.name}: ${counts[t.name]} rows (backup ${t.rows})`);
      }
      console.log(bad ? `Restore finished with ${bad} tables below the backup count.` : 'Restore finished. All row counts match or exceed the backup.');
      if (bad) process.exitCode = 1;
    } finally {
      await client.end();
    }
  } else if (!flags['sql-out'] && !flags['recreate-auth']) {
    console.log('Dry run only. Nothing was written.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`Restore stopped: ${err.message}`);
    process.exit(1);
  });
}
