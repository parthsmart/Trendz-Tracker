/**
 * Trendz Tracker - Backup Table Definitions & Pure Value/Keyset Helpers (api/_backupTables.js)
 *
 * Single source of truth for:
 * 1. The 12 Snapshot tables (small configuration/reference tables rewritten each run).
 * 2. The 6 Append tables (high-volume activity/audit tables incrementally backed up via keyset paging).
 * 3. Primary-key ordering columns and cursor columns for every table.
 * 4. Pure value conversion, dynamic header merging, and keyset filter helpers.
 *
 * Pure ES module: no DOM, no network calls, no environment access.
 */

export const SNAPSHOT_MAX_ROWS = 20000;
export const PAGE_SIZE = 1000;
export const SHEETS_UPDATE_CHUNK_ROWS = 5000;
export const MAX_SHEET_CELL_STRING_LENGTH = 49000;
export const TRUNCATED_SUFFIX = ' [TRUNCATED]';
export const GOOGLE_SHEETS_CELL_LIMIT = 10000000;
export const GOOGLE_SHEETS_WARN_RATIO = 0.7;

/**
 * 12 Snapshot tables (fully rewritten on each backup run, in this exact order).
 */
export const SNAPSHOT_TABLES = [
  {
    name: 'profiles',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'round_series',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'categories',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'category_series',
    mode: 'snapshot',
    primaryKey: ['category_id', 'series_id'],
    cursorColumn: null,
  },
  {
    name: 'basics_thresholds',
    mode: 'snapshot',
    primaryKey: ['id'],
    fallbackPrimaryKey: ['category_id'],
    cursorColumn: null,
  },
  {
    name: 'daily_tasks',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'resources',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'competition_settings',
    mode: 'snapshot',
    primaryKey: ['id'],
    fallbackPrimaryKey: ['key'],
    cursorColumn: null,
  },
  {
    name: 'category_aliases',
    mode: 'snapshot',
    primaryKey: ['alias'],
    fallbackPrimaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'attendance_sessions',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'weekly_tests',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'import_batches',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
];

/**
 * 6 Append tables (rows added when new or changed, in this exact order).
 */
export const APPEND_TABLES = [
  {
    name: 'student_rounds',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'updated_at',
  },
  {
    name: 'results',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'updated_at',
  },
  {
    name: 'weekly_test_scores',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'updated_at',
  },
  {
    name: 'attendance',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'updated_at',
  },
  {
    name: 'activity_results',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'updated_at',
  },
  {
    name: 'result_audit',
    mode: 'append',
    primaryKey: ['id'],
    cursorColumn: 'changed_at',
  },
];

/**
 * Combined ordered list of all 18 tables: snapshot tables first, then append tables.
 */
export const BACKUP_TABLES = [...SNAPSHOT_TABLES, ...APPEND_TABLES];

/**
 * Lookup map by table name.
 */
export const BACKUP_TABLE_MAP = new Map(BACKUP_TABLES.map((t) => [t.name, t]));

/**
 * Converts a single database value for Google Sheets RAW mode:
 * - null / undefined -> ""
 * - boolean -> boolean
 * - number -> number (or "" if non-finite)
 * - object / array -> JSON text (truncated at 49,000 chars with " [TRUNCATED]" if needed)
 * - string -> kept exact (timestamps and dates stay as strings returned); if > 49,000 chars,
 *             cut to 49,000 chars and suffixed with " [TRUNCATED]".
 *
 * @param {unknown} val
 * @returns {string | number | boolean}
 */
export function convertValueForSheets(val) {
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val === 'boolean') {
    return val;
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : '';
  }
  if (typeof val === 'object') {
    const jsonStr = JSON.stringify(val);
    if (jsonStr.length > MAX_SHEET_CELL_STRING_LENGTH) {
      return jsonStr.slice(0, MAX_SHEET_CELL_STRING_LENGTH) + TRUNCATED_SUFFIX;
    }
    return jsonStr;
  }
  const str = String(val);
  if (str.length > MAX_SHEET_CELL_STRING_LENGTH) {
    return str.slice(0, MAX_SHEET_CELL_STRING_LENGTH) + TRUNCATED_SUFFIX;
  }
  return str;
}

/**
 * Converts a row object into an array of cell values matching the provided header array.
 * For append tables, `_backed_up_at` is populated with `backedUpAtIso`.
 *
 * @param {Record<string, unknown>} row
 * @param {string[]} header
 * @param {string|null} [backedUpAtIso]
 * @returns {Array<string | number | boolean>}
 */
export function serializeRowForSheets(row, header, backedUpAtIso = null) {
  return header.map((col) => {
    if (col === '_backed_up_at') {
      return backedUpAtIso !== null && backedUpAtIso !== undefined
        ? convertValueForSheets(backedUpAtIso)
        : convertValueForSheets(row._backed_up_at ?? '');
    }
    return convertValueForSheets(row ? row[col] : '');
  });
}

/**
 * Builds or updates the header for an append table.
 * - Initial header: first row's keys (in order) plus "_backed_up_at" at the end.
 * - If later rows contain columns not in the current header, appends those new columns
 *   to the end of the header and never drops any existing column.
 *
 * @param {string[] | null | undefined} existingHeader
 * @param {Array<Record<string, unknown>>} rows
 * @returns {{ header: string[], changed: boolean }}
 */
export function resolveAppendHeader(existingHeader, rows) {
  const hasExisting = Array.isArray(existingHeader) && existingHeader.length > 0;
  const header = hasExisting ? [...existingHeader] : [];
  let changed = false;

  if (!hasExisting && Array.isArray(rows) && rows.length > 0) {
    const firstRowKeys = Object.keys(rows[0]).filter((k) => k !== '_backed_up_at');
    header.push(...firstRowKeys, '_backed_up_at');
    changed = true;
  }

  const seen = new Set(header);
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          header.push(key);
          changed = true;
        }
      }
    }
  }

  if (header.length > 0 && !seen.has('_backed_up_at')) {
    seen.add('_backed_up_at');
    header.push('_backed_up_at');
    changed = true;
  }

  return { header, changed };
}

/**
 * Builds the PostgREST `.or()` keyset filter string for `(cursorColumn, id)` paging.
 * Preserves the timestamp string exactly as returned by PostgreSQL without converting through `Date`,
 * so microsecond precision (e.g. `.123456+00:00`) is never lost.
 *
 * Format: `col.gt.X,and(col.eq.X,id.gt.Y)`
 *
 * @param {string} cursorColumn
 * @param {string} cursorValue
 * @param {string} cursorId
 * @returns {string}
 */
export function buildKeysetOrFilter(cursorColumn, cursorValue, cursorId) {
  const col = String(cursorColumn || '').trim();
  const val = String(cursorValue ?? '').trim();
  const id = String(cursorId ?? '').trim();
  if (!col || !val || !id) {
    throw new Error('buildKeysetOrFilter requires non-empty cursorColumn, cursorValue, and cursorId.');
  }
  return `${col}.gt.${val},and(${col}.eq.${val},id.gt.${id})`;
}

/**
 * Computes a 0-indexed column number to A1 column letters (0 -> 'A', 25 -> 'Z', 26 -> 'AA').
 *
 * @param {number} colIndexZeroBased
 * @returns {string}
 */
export function colIndexToLetter(colIndexZeroBased) {
  let n = Math.max(0, Math.floor(colIndexZeroBased));
  let letters = '';
  while (n >= 0) {
    letters = String.fromCharCode((n % 26) + 65) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}
