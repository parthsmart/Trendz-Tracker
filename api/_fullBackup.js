/**
 * Trendz Tracker - Full database export for the admin Excel backup (api/_fullBackup.js)
 *
 * Admin-only (the caller is verified in api/backup.js). Uses the service-role client so
 * every public table is readable, including service-role-only tables.
 *
 * - `handleFullBackupSchema`: discovers every public table and column from PostgREST's
 *   OpenAPI document and lists login accounts (safe fields only, never password hashes).
 * - `handleFullBackupPage`: returns one page of rows for one table, ordered by primary key,
 *   capped so each response stays under Vercel's body limit.
 */

import {
  FULL_BACKUP_KNOWN_TABLES,
  FULL_BACKUP_MAX_PAGE_CHARS,
  FULL_BACKUP_PAGE_SIZE,
  FULL_BACKUP_SCHEMA_VERSION,
  orderTablesForRestore,
  parseOpenApiTables,
  pickAuthUserFields,
} from '../js/fullBackup.js';

const SCHEMA_CACHE_MS = 60 * 1000;
let schemaCache = null;

export function resetFullBackupSchemaCache() {
  schemaCache = null;
}

/** Reads the PostgREST OpenAPI document with the service-role key. */
export async function fetchOpenApi({ url, serviceRoleKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${String(url).replace(/\/+$/, '')}/rest/v1/`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/openapi+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Could not read the database schema (HTTP ${response.status}).`);
  }
  return response.json();
}

export async function loadFullBackupSchema({ url, serviceRoleKey, fetchImpl, now = Date.now }) {
  if (schemaCache && now() - schemaCache.at < SCHEMA_CACHE_MS) return schemaCache.value;
  const openapi = await fetchOpenApi({ url, serviceRoleKey, fetchImpl });
  const parsed = parseOpenApiTables(openapi, { knownTables: FULL_BACKUP_KNOWN_TABLES });
  if (parsed.tables.length === 0) throw new Error('The database schema returned no tables.');
  schemaCache = { at: now(), value: parsed };
  return parsed;
}

/** Lists every login account, 1,000 per call, keeping only safe fields. */
export async function listAllAuthUsers(supabase, perPage = 1000) {
  const users = [];
  for (let page = 1; page < 10000; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list login accounts: ${error.message}`);
    const batch = (data && data.users) || [];
    users.push(...batch.map(pickAuthUserFields));
    if (batch.length < perPage) break;
  }
  return users;
}

function projectRefFromUrl(url) {
  const m = /^https?:\/\/([a-z0-9-]+)\.supabase\.co/i.exec(String(url || ''));
  return m ? m[1] : '';
}

export async function handleFullBackupSchema({ supabase, url, serviceRoleKey, fetchImpl, includeAuth = true }) {
  const { tables, skipped, missingKnown } = await loadFullBackupSchema({ url, serviceRoleKey, fetchImpl });
  const { order, cyclic } = orderTablesForRestore(tables);
  const authUsers = includeAuth ? await listAllAuthUsers(supabase) : null;
  return {
    ok: true,
    exported_at: new Date().toISOString(),
    source_project: projectRefFromUrl(url),
    schema_version: FULL_BACKUP_SCHEMA_VERSION,
    page_size: FULL_BACKUP_PAGE_SIZE,
    tables,
    restore_order: order,
    cyclic,
    skipped,
    missing_known: missingKnown,
    auth_users: authUsers,
  };
}

/**
 * Returns rows [offset, offset + 1000) of one table, ordered by its primary key
 * (or every column when it has none). Trims the page when it would be too large.
 */
export async function handleFullBackupPage({ supabase, url, serviceRoleKey, fetchImpl, table, offset }) {
  const { tables } = await loadFullBackupSchema({ url, serviceRoleKey, fetchImpl });
  const meta = tables.find((t) => t.name === table);
  if (!meta) return { httpStatus: 400, body: { ok: false, error: `Unknown table "${String(table).slice(0, 64)}".` } };
  const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const orderCols = meta.primaryKey.length
    ? meta.primaryKey
    : meta.columns.filter((c) => !/json/.test(c.format)).map((c) => c.name);
  let query = supabase.from(meta.name).select('*');
  for (const col of orderCols) query = query.order(col, { ascending: true });
  const { data, error } = await query.range(start, start + FULL_BACKUP_PAGE_SIZE - 1);
  if (error) throw new Error(`Failed reading ${meta.name}: ${error.message}`);

  const rows = Array.isArray(data) ? data : [];
  let size = 0;
  let keep = rows.length;
  for (let i = 0; i < rows.length; i++) {
    size += JSON.stringify(rows[i]).length + 1;
    if (size > FULL_BACKUP_MAX_PAGE_CHARS && i > 0) {
      keep = i;
      break;
    }
  }
  const page = rows.slice(0, keep);
  const trimmed = keep < rows.length;
  const finished = !trimmed && rows.length < FULL_BACKUP_PAGE_SIZE;
  return {
    httpStatus: 200,
    body: {
      ok: true,
      table: meta.name,
      offset: start,
      rows: page,
      next_offset: finished ? null : start + page.length,
    },
  };
}
