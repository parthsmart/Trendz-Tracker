/**
 * Trendz Tracker - Full database backup workbook model (js/fullBackup.js)
 *
 * Shared by the admin Backup page (browser), the server export endpoint and the
 * restore script (Node). Pure ES module: no DOM, no network, no environment access.
 *
 * Workbook layout (one .xlsx):
 *   README        - human-readable summary and restore steps
 *   _meta         - machine-readable key/value manifest (format, export time, schema version)
 *   _tables       - every table: row count, sheet(s), primary key, foreign-key parents, restore order
 *   _columns      - every column: position, PostgreSQL type, primary key, foreign key
 *   _auth_users   - login accounts (no password hashes, tokens or secrets)
 *   <table>       - one sheet per table, header row = exact column names, every row and column
 *   _overflow     - pieces of values longer than Excel's 32,767-character cell limit
 *   _skipped      - relations deliberately not exported (views) and why
 */

import { buildXlsx, readXlsx, XLSX_MAX_ROWS, XLSX_MAX_SHEET_NAME } from './xlsx.js';

export const FULL_BACKUP_FORMAT_VERSION = 1;

/** Latest migration file in supabase/migrations (kept in sync by tests/fullBackup.test.js). */
export const FULL_BACKUP_SCHEMA_VERSION = '31_live_duels';

export const FULL_BACKUP_PAGE_SIZE = 1000;

/** Keeps each /api/backup page response well under Vercel's 4.5 MB body limit. */
export const FULL_BACKUP_MAX_PAGE_CHARS = 3_000_000;

/** Characters per cell piece; below Excel's 32,767 limit. */
export const FULL_BACKUP_CELL_CHUNK = 32000;

/**
 * Relations that are not exported, with the reason. Everything else in the public
 * schema is exported automatically.
 */
export const FULL_BACKUP_EXCLUDED_RELATIONS = Object.freeze({
  results_with_target: 'View computed from results and targets; it holds no data of its own.',
  role_change_tickets: 'One-time tickets used inside a single role change; always empty between changes.',
});

/**
 * Every public table known when this file was last updated. The export discovers tables
 * from the live database, so new tables are included even before this list is updated;
 * the list is a safety net (missing tables are flagged in the workbook) and is checked
 * against the migrations by tests.
 */
export const FULL_BACKUP_KNOWN_TABLES = Object.freeze([
  'activity_results',
  'announcement_recipients',
  'announcements',
  'attendance',
  'attendance_audit',
  'attendance_sessions',
  'backup_runs',
  'backup_state',
  'badge_catalogue',
  'basics_thresholds',
  'categories',
  'category_aliases',
  'category_series',
  'centre_staff',
  'centre_visibility',
  'centres',
  'competition_settings',
  'daily_challenge_attempts',
  'daily_task_recipients',
  'daily_tasks',
  'daily_todo_log',
  'drill_sessions',
  'duel_ratings',
  'duels',
  'homework_assignments',
  'homework_bound_sessions',
  'homework_completions',
  'import_batches',
  'jmcwc_assignments',
  'live_duel_answers',
  'live_duel_config',
  'live_duel_keys',
  'live_duel_queue',
  'live_duels',
  'jmcwc_attempts',
  'jmcwc_categories',
  'jmcwc_papers',
  'jmcwc_payloads',
  'jmcwc_scores',
  'jmcwc_targets',
  'league_results',
  'league_tiers',
  'league_weeks',
  'lecture_categories',
  'lectures',
  'live_class_recording_audit_log',
  'live_class_recordings',
  'live_classes',
  'mirror_state',
  'notification_dismissals',
  'profile_audit',
  'profiles',
  'report_log',
  'resource_recipients',
  'resources',
  'result_audit',
  'reward_items',
  'reward_redemptions',
  'results',
  'role_audit',
  'rollout_boundaries',
  'round_series',
  'rounds',
  'score_correction_requests',
  'simple_practice_results',
  'student_messages',
  'student_practice_access',
  'student_badges',
  'student_leagues',
  'student_rounds',
  'student_xp_events',
  'teacher_audit_log',
  'teacher_permissions',
  'teacher_student_assignments',
  'weekly_test_attempts',
  'weekly_test_recipients',
  'weekly_test_removals',
  'weekly_test_scores',
  'weekly_test_sections',
  'weekly_tests',
  'xp_award_periods',
  'xp_season_results',
  'xp_seasons',
  'xp_awards',
]);

/** Tables whose rows are sensitive beyond normal student data (flagged in README). */
export const FULL_BACKUP_SENSITIVE_TABLES = Object.freeze({
  jmcwc_payloads: 'Main Round question papers with answer keys. Keep this file private.',
});

export const RESERVED_SHEETS = Object.freeze(['README', '_meta', '_tables', '_columns', '_auth_users', '_overflow', '_skipped']);

// ============================================================================
// Login accounts (auth.users) - safe subset only
// ============================================================================

export const AUTH_USER_COLUMNS = Object.freeze([
  { name: 'id', format: 'uuid' },
  { name: 'email', format: 'text' },
  { name: 'phone', format: 'text' },
  { name: 'role', format: 'text' },
  { name: 'aud', format: 'text' },
  { name: 'email_confirmed_at', format: 'timestamp with time zone' },
  { name: 'phone_confirmed_at', format: 'timestamp with time zone' },
  { name: 'confirmed_at', format: 'timestamp with time zone' },
  { name: 'last_sign_in_at', format: 'timestamp with time zone' },
  { name: 'created_at', format: 'timestamp with time zone' },
  { name: 'updated_at', format: 'timestamp with time zone' },
  { name: 'banned_until', format: 'timestamp with time zone' },
  { name: 'is_anonymous', format: 'boolean' },
  { name: 'is_sso_user', format: 'boolean' },
  { name: 'user_metadata', format: 'jsonb' },
  { name: 'app_metadata', format: 'jsonb' },
]);

/** Field names that must never appear in a backup. */
export const AUTH_FORBIDDEN_KEYS = Object.freeze([
  'encrypted_password',
  'password',
  'password_hash',
  'confirmation_token',
  'recovery_token',
  'email_change_token_new',
  'email_change_token_current',
  'phone_change_token',
  'reauthentication_token',
  'access_token',
  'refresh_token',
  'identities',
  'factors',
]);

function stripForbiddenKeys(value) {
  if (Array.isArray(value)) return value.map(stripForbiddenKeys);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (AUTH_FORBIDDEN_KEYS.includes(k)) continue;
    out[k] = stripForbiddenKeys(v);
  }
  return out;
}

/** Copies only the safe login-account fields from a Supabase admin user object. */
export function pickAuthUserFields(user) {
  const out = {};
  for (const col of AUTH_USER_COLUMNS) {
    const v = user ? user[col.name] : undefined;
    out[col.name] = v === undefined ? null : col.format === 'jsonb' ? stripForbiddenKeys(v) : v;
  }
  return out;
}

// ============================================================================
// Schema discovery (PostgREST OpenAPI) and restore order
// ============================================================================

const FK_RE = /<fk table='([^']+)' column='([^']+)'\/>/;

/**
 * Turns the PostgREST OpenAPI document into table definitions.
 *
 * @returns {{ tables: Array<{ name, columns, primaryKey, dependsOn }>, skipped: Array<{ name, reason }>, missingKnown: string[] }}
 */
export function parseOpenApiTables(openapi, { knownTables = FULL_BACKUP_KNOWN_TABLES } = {}) {
  const defs = (openapi && openapi.definitions) || {};
  const paths = (openapi && openapi.paths) || {};
  const tables = [];
  const skipped = [];

  for (const [name, def] of Object.entries(defs)) {
    if (FULL_BACKUP_EXCLUDED_RELATIONS[name]) {
      skipped.push({ name, reason: FULL_BACKUP_EXCLUDED_RELATIONS[name] });
      continue;
    }
    const pathItem = paths[`/${name}`];
    const writable = !pathItem || Boolean(pathItem.post);
    if (!writable && !knownTables.includes(name)) {
      skipped.push({ name, reason: 'Read-only relation (view); no stored rows to back up.' });
      continue;
    }
    const columns = Object.entries(def.properties || {}).map(([col, prop], i) => {
      const desc = String(prop.description || '');
      const fk = FK_RE.exec(desc);
      let format = String(prop.format || prop.type || 'text');
      if (prop.type === 'array' && prop.items && !format.endsWith('[]')) format = `${prop.items.format || prop.items.type || 'text'}[]`;
      return {
        name: col,
        position: i + 1,
        format,
        type: String(prop.type || ''),
        primaryKey: desc.includes('<pk/>'),
        references: fk ? `${fk[1]}.${fk[2]}` : null,
      };
    });
    const primaryKey = columns.filter((c) => c.primaryKey).map((c) => c.name);
    const dependsOn = [...new Set(columns.filter((c) => c.references).map((c) => c.references.split('.')[0]))].filter((t) => t !== name);
    tables.push({ name, columns, primaryKey, dependsOn });
  }

  tables.sort((a, b) => a.name.localeCompare(b.name));
  const found = new Set(tables.map((t) => t.name));
  const missingKnown = knownTables.filter((t) => !found.has(t));
  return { tables, skipped, missingKnown };
}

/**
 * Orders tables so every foreign-key parent comes before its children.
 * Parents outside the set (e.g. auth.users) are ignored. Cycles are appended at the end.
 */
export function orderTablesForRestore(tables) {
  const names = new Set(tables.map((t) => t.name));
  const deps = new Map(tables.map((t) => [t.name, new Set((t.dependsOn || []).filter((d) => names.has(d) && d !== t.name))]));
  const ordered = [];
  const done = new Set();
  let progressed = true;
  while (done.size < names.size && progressed) {
    progressed = false;
    const ready = [...names].filter((n) => !done.has(n) && [...deps.get(n)].every((d) => done.has(d))).sort();
    for (const n of ready) {
      ordered.push(n);
      done.add(n);
      progressed = true;
    }
  }
  const cyclic = [...names].filter((n) => !done.has(n)).sort();
  return { order: [...ordered, ...cyclic], cyclic };
}

// ============================================================================
// Value encoding
// ============================================================================

export function isJsonFormat(format) {
  const f = String(format || '').toLowerCase();
  return f === 'json' || f === 'jsonb' || f.endsWith('[]') || f.startsWith('array');
}

/**
 * Converts a database value into an Excel cell value without losing information:
 * - null -> blank cell; '' -> empty text cell
 * - booleans and finite numbers stay typed
 * - json/jsonb/array columns are written as JSON text
 * - timestamps, dates, uuids and text are written exactly as the database returned them
 */
export function encodeBackupValue(value, column) {
  if (value === null || value === undefined) return null;
  if (isJsonFormat(column && column.format)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Converts a parsed Excel cell back into a JSON value suitable for json_populate_recordset.
 * Numbers keep their exact text, JSON columns are parsed.
 */
export function decodeBackupCell(cell, column, where = '') {
  if (cell === null || cell === undefined) return null;
  if (cell.type === 'b') return Boolean(cell.value);
  const text = String(cell.value ?? '');
  if (isJsonFormat(column && column.format)) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON in ${where || column?.name || 'a JSON column'}; the cell may have been edited.`);
    }
  }
  const fmt = String(column?.format || '').toLowerCase();
  if (fmt === 'boolean') {
    if (/^(true|1)$/i.test(text)) return true;
    if (/^(false|0)$/i.test(text)) return false;
  }
  return text;
}

// ============================================================================
// Workbook build
// ============================================================================

function sheetNamesFor(table, parts, used) {
  const names = [];
  for (let p = 1; p <= parts; p++) {
    const suffix = p === 1 ? '' : `~${p}`;
    let base = table.slice(0, XLSX_MAX_SHEET_NAME - suffix.length);
    let name = base + suffix;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const extra = `~${p}.${n++}`;
      base = table.slice(0, XLSX_MAX_SHEET_NAME - extra.length);
      name = base + extra;
    }
    used.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

function formatIst(iso) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'long',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Builds the full backup workbook.
 *
 * @param {{
 *   exportedAt: string,
 *   sourceProject?: string,
 *   schemaVersion?: string,
 *   tables: Array<{ name: string, columns: Array<object>, primaryKey: string[], dependsOn: string[], rows: Array<Record<string, any>> }>,
 *   authUsers?: Array<Record<string, any>> | null,
 *   skipped?: Array<{ name: string, reason: string }>,
 *   missingKnown?: string[],
 *   maxRowsPerSheet?: number,
 *   compress?: boolean,
 *   onProgress?: (info: { phase: string, done: number, total: number, sheet?: string }) => void,
 * }} input
 * @returns {Promise<{ bytes: Uint8Array, summary: { tables: number, rows: number, authUsers: number, rowCounts: Record<string, number> } }>}
 */
export async function buildFullBackupWorkbook(input) {
  const {
    exportedAt,
    sourceProject = '',
    schemaVersion = FULL_BACKUP_SCHEMA_VERSION,
    tables,
    authUsers = null,
    skipped = [],
    missingKnown = [],
    maxRowsPerSheet = XLSX_MAX_ROWS - 1,
    compress = true,
    onProgress,
  } = input;

  const byName = new Map(tables.map((t) => [t.name, t]));
  const { order, cyclic } = orderTablesForRestore(tables);
  const used = new Set(RESERVED_SHEETS.map((s) => s.toLowerCase()));
  const overflow = [];
  const rowCounts = {};
  let totalRows = 0;
  const tableSheets = [];

  for (const name of order) {
    const t = byName.get(name);
    const rows = Array.isArray(t.rows) ? t.rows : [];
    rowCounts[name] = rows.length;
    totalRows += rows.length;
    const parts = Math.max(1, Math.ceil(rows.length / maxRowsPerSheet));
    const names = sheetNamesFor(name, parts, used);
    tableSheets.push({ table: t, sheetNames: names, rows });
  }

  const authRows = Array.isArray(authUsers) ? authUsers.map(pickAuthUserFields) : null;

  const sensitive = order.filter((n) => FULL_BACKUP_SENSITIVE_TABLES[n]);
  const readme = [
    ['Trendz Tracker - complete database backup'],
    [''],
    ['Exported at (UTC)', exportedAt],
    ['Exported at (IST)', formatIst(exportedAt)],
    ['Source project', sourceProject || 'unknown'],
    ['Schema version (latest migration)', schemaVersion],
    ['Tables', order.length],
    ['Rows (all tables)', totalRows],
    ['Login accounts', authRows ? authRows.length : 'not included'],
    [''],
    ['What is inside'],
    ['One sheet per database table. Row 1 holds the exact column names; every row and every column is included.'],
    ['IDs, foreign keys and timestamps are stored exactly as in the database (full precision, UTC offsets kept).'],
    ['JSON and list columns are stored as JSON text. Blank cell = NULL; an empty text cell = empty string.'],
    ['Values longer than 32,000 characters continue in the _overflow sheet.'],
    ['_tables lists every table with its row count and restore order; _columns lists every column and type.'],
    ['_auth_users holds login accounts (ID, email, timestamps, metadata). Passwords are NOT included and cannot be recovered.'],
    [''],
    ['How to restore'],
    ['1. Create a new Supabase project and run every SQL file in supabase/migrations in order.'],
    ['2. Run: node scripts/restoreFromBackup.js <this file>   (dry run: checks the file and prints the plan)'],
    ['3. Recreate logins with the same IDs: add --recreate-auth --passwords-out <file.csv> (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).'],
    ['   Every account gets a new temporary password written to that CSV; share them privately and ask users to change them.'],
    ['4. Write the data: add --sql-out restore.sql and run it with psql, or add --apply (needs RESTORE_DATABASE_URL).'],
    ['   Tables are inserted parents-first, triggers are paused so audit/streak rows are not duplicated, all in one transaction.'],
    ['5. See docs/RESTORE.md for the full guide.'],
    [''],
    ['Do not edit or re-save this file in Excel before restoring: Excel may change long numbers, dates or empty cells.'],
  ];
  for (const n of sensitive) readme.push([`Private: ${n}`, FULL_BACKUP_SENSITIVE_TABLES[n]]);
  if (missingKnown.length) readme.push(['Warning: tables expected but not found in the database', missingKnown.join(', ')]);
  if (cyclic.length) readme.push(['Warning: circular foreign keys (restore these together)', cyclic.join(', ')]);

  const meta = [
    ['format', 'trendz-full-backup'],
    ['format_version', FULL_BACKUP_FORMAT_VERSION],
    ['exported_at', exportedAt],
    ['source_project', sourceProject || ''],
    ['schema_version', schemaVersion],
    ['table_count', order.length],
    ['total_rows', totalRows],
    ['auth_users_included', Boolean(authRows)],
    ['auth_user_count', authRows ? authRows.length : 0],
    ['missing_known_tables', missingKnown.join(',')],
  ];

  const tablesSheet = tableSheets.map(({ table, sheetNames }, i) => [
    table.name,
    rowCounts[table.name],
    sheetNames.join(','),
    (table.primaryKey || []).join(','),
    (table.dependsOn || []).join(','),
    i + 1,
  ]);

  const columnsSheet = [];
  for (const { table } of tableSheets) {
    for (const c of table.columns) {
      columnsSheet.push([table.name, c.position, c.name, c.format, c.type || '', Boolean(c.primaryKey), c.references || null]);
    }
  }

  const totalCells = totalRows + (authRows ? authRows.length : 0);
  let doneRows = 0;
  const onRow = () => {
    doneRows += 1;
    if (onProgress && doneRows % 500 === 0) onProgress({ phase: 'writing', done: doneRows, total: totalCells });
  };

  function* tableRowsGenerator(table, rows, start, end, tableName) {
    const cols = table.columns;
    for (let r = start; r < end; r++) {
      const row = rows[r] || {};
      const out = new Array(cols.length);
      for (let c = 0; c < cols.length; c++) {
        let v = encodeBackupValue(row[cols[c].name], cols[c]);
        if (typeof v === 'string' && v.length > FULL_BACKUP_CELL_CHUNK) {
          const pieces = Math.ceil(v.length / FULL_BACKUP_CELL_CHUNK);
          for (let p = 0; p < pieces; p++) {
            overflow.push([tableName, r + 1, cols[c].name, p + 1, pieces, v.slice(p * FULL_BACKUP_CELL_CHUNK, (p + 1) * FULL_BACKUP_CELL_CHUNK)]);
          }
          v = v.slice(0, FULL_BACKUP_CELL_CHUNK);
        }
        out[c] = v;
      }
      yield out;
    }
  }

  const sheets = [
    { name: 'README', rows: readme, widths: [44, 120] },
    { name: '_meta', header: ['key', 'value'], rows: meta, widths: [24, 60] },
    { name: '_tables', header: ['table', 'rows', 'sheets', 'primary_key', 'depends_on', 'restore_order'], rows: tablesSheet, widths: [32, 10, 40, 30, 60, 14] },
    { name: '_columns', header: ['table', 'position', 'column', 'format', 'type', 'primary_key', 'references'], rows: columnsSheet, widths: [32, 10, 32, 28, 12, 12, 36] },
  ];
  if (authRows) {
    sheets.push({
      name: '_auth_users',
      header: AUTH_USER_COLUMNS.map((c) => c.name),
      rows: authRows.map((u) => AUTH_USER_COLUMNS.map((c) => encodeBackupValue(u[c.name], c))),
    });
  }
  for (const { table, sheetNames, rows } of tableSheets) {
    sheetNames.forEach((sheetName, p) => {
      const start = p * maxRowsPerSheet;
      const end = Math.min(rows.length, start + maxRowsPerSheet);
      sheets.push({
        name: sheetName,
        header: table.columns.map((c) => c.name),
        rows: tableRowsGenerator(table, rows, start, end, table.name),
        widths: table.columns.map((c) => (/timestamp/.test(c.format) ? 32 : c.format === 'uuid' ? 38 : 16)),
      });
    });
  }
  // Generators fill `overflow` while their sheets are written, so this sheet is built last.
  const overflowSheet = { name: '_overflow', header: ['table', 'row', 'column', 'part', 'parts', 'text'], rows: overflow };
  sheets.push(overflowSheet);
  sheets.push({ name: '_skipped', header: ['relation', 'reason'], rows: skipped.map((s) => [s.name, s.reason]) });

  const bytes = await buildXlsx(sheets, {
    compress,
    onRow,
    onSheet: (sheet, i) => onProgress && onProgress({ phase: 'sheet', done: i + 1, total: sheets.length, sheet }),
  });

  return {
    bytes,
    summary: { tables: order.length, rows: totalRows, authUsers: authRows ? authRows.length : 0, rowCounts },
  };
}

// ============================================================================
// Workbook read (restore side)
// ============================================================================

function sheetRowsAsObjects(sheet) {
  const [header = [], ...rows] = sheet ? sheet.rows : [];
  const names = header.map((c) => (c ? String(c.value) : ''));
  return { names, rows };
}

function cellText(cell) {
  return cell === null || cell === undefined ? '' : String(cell.value);
}

/**
 * Reads a full backup workbook back into tables of row objects (restore order),
 * verifying row counts against the manifest.
 */
export async function readFullBackupWorkbook(bytes, opts = {}) {
  let sheets;
  try {
    ({ sheets } = await readXlsx(bytes, opts));
  } catch (err) {
    throw new Error(`This backup file is damaged or is not a valid .xlsx file (${err && err.message ? err.message : err}).`);
  }
  const byName = new Map(sheets.map((s) => [s.name, s]));

  const metaSheet = byName.get('_meta');
  if (!metaSheet) throw new Error('This file is not a Trendz full backup (no _meta sheet).');
  const meta = {};
  for (const row of metaSheet.rows.slice(1)) if (row && row[0]) meta[cellText(row[0])] = row[1] ? row[1].value : null;
  if (meta.format !== 'trendz-full-backup') throw new Error('This file is not a Trendz full backup.');
  if (Number(meta.format_version) > FULL_BACKUP_FORMAT_VERSION) {
    throw new Error(`Backup format ${meta.format_version} is newer than this tool understands (${FULL_BACKUP_FORMAT_VERSION}).`);
  }

  const columnsByTable = new Map();
  for (const row of (byName.get('_columns')?.rows || []).slice(1)) {
    if (!row || !row[0]) continue;
    const t = cellText(row[0]);
    if (!columnsByTable.has(t)) columnsByTable.set(t, []);
    columnsByTable.get(t).push({
      name: cellText(row[2]),
      position: Number(cellText(row[1])),
      format: cellText(row[3]),
      type: cellText(row[4]),
      primaryKey: Boolean(row[5] && (row[5].value === true || /^true$/i.test(String(row[5].value)))),
      references: row[6] ? cellText(row[6]) : null,
    });
  }

  const overflow = new Map();
  for (const row of (byName.get('_overflow')?.rows || []).slice(1)) {
    if (!row || !row[0]) continue;
    const key = `${cellText(row[0])}\u0000${cellText(row[1])}\u0000${cellText(row[2])}`;
    if (!overflow.has(key)) overflow.set(key, []);
    overflow.get(key)[Number(cellText(row[3])) - 1] = cellText(row[5]);
  }

  const tables = [];
  const tableRows = (byName.get('_tables')?.rows || []).slice(1).filter((r) => r && r[0]);
  tableRows.sort((a, b) => Number(cellText(a[5])) - Number(cellText(b[5])));
  for (const row of tableRows) {
    const name = cellText(row[0]);
    const expected = Number(cellText(row[1]));
    const sheetNames = cellText(row[2]).split(',').filter(Boolean);
    const columns = (columnsByTable.get(name) || []).sort((a, b) => a.position - b.position);
    const colByName = new Map(columns.map((c) => [c.name, c]));
    const objects = [];
    for (const sheetName of sheetNames) {
      const sheet = byName.get(sheetName);
      if (!sheet) throw new Error(`Backup is incomplete: sheet "${sheetName}" for table ${name} is missing.`);
      const { names, rows } = sheetRowsAsObjects(sheet);
      for (const cells of rows) {
        const rowNumber = objects.length + 1;
        const obj = {};
        names.forEach((col, i) => {
          if (!col) return;
          let cell = cells ? cells[i] ?? null : null;
          const pieces = overflow.get(`${name}\u0000${rowNumber}\u0000${col}`);
          if (pieces) cell = { type: 's', value: pieces.join('') };
          obj[col] = decodeBackupCell(cell, colByName.get(col), `${name} row ${rowNumber} column ${col}`);
        });
        objects.push(obj);
      }
    }
    if (objects.length !== expected) {
      throw new Error(`Backup is damaged: ${name} should have ${expected} rows but has ${objects.length}.`);
    }
    tables.push({
      name,
      columns,
      primaryKey: cellText(row[3]).split(',').filter(Boolean),
      dependsOn: cellText(row[4]).split(',').filter(Boolean),
      rows: objects,
    });
  }

  let authUsers = null;
  const authSheet = byName.get('_auth_users');
  if (authSheet) {
    const { names, rows } = sheetRowsAsObjects(authSheet);
    const colByName = new Map(AUTH_USER_COLUMNS.map((c) => [c.name, c]));
    authUsers = rows.map((cells, r) => {
      const obj = {};
      names.forEach((col, i) => {
        if (col) obj[col] = decodeBackupCell(cells ? cells[i] ?? null : null, colByName.get(col), `_auth_users row ${r + 1} ${col}`);
      });
      return obj;
    });
  }

  return { meta, tables, authUsers };
}
