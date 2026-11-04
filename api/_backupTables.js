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
 * 16 Snapshot tables (fully rewritten on each backup run, in this exact order).
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
    name: 'weekly_test_sections',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'weekly_test_attempts',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'weekly_test_removals',
    mode: 'snapshot',
    primaryKey: ['id'],
    cursorColumn: null,
  },
  {
    name: 'announcements',
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
 * Combined ordered list of all 22 browser/sheet-accessible core tables: snapshot tables first, then append tables.
 */
export const BACKUP_TABLES = [...SNAPSHOT_TABLES, ...APPEND_TABLES];

/**
 * Lookup map by table name.
 */
export const BACKUP_TABLE_MAP = new Map(BACKUP_TABLES.map((t) => [t.name, t]));

/**
 * Phase 17c: All seven JMCWC tables in strict foreign-key dependency order.
 * Note:
 * - All seven JMCWC tables have RLS enabled with `service_role` access only.
 * - `jmcwc_payloads` contains generated question `answer_key` values and MUST NEVER
 *   be exposed in public backups, client exports, or Google Sheets mirrors.
 */
export const JMCWC_BACKUP_TABLES = [
  {
    name: 'jmcwc_papers',
    mode: 'snapshot',
    primaryKey: ['id'],
    orderBy: [
      { column: 'group_key', ascending: true },
      { column: 'version', ascending: true },
    ],
    dependsOn: [],
    sharedInstituteTable: true,
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_categories',
    mode: 'snapshot',
    primaryKey: ['key'],
    orderBy: [{ column: 'position', ascending: true }],
    dependsOn: ['categories'],
    sharedInstituteTable: true,
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_targets',
    mode: 'snapshot',
    primaryKey: ['group_key', 'category_key'],
    orderBy: [
      { column: 'group_key', ascending: true },
      { column: 'category_key', ascending: true },
    ],
    dependsOn: ['jmcwc_categories'],
    sharedInstituteTable: true,
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_assignments',
    mode: 'snapshot',
    primaryKey: ['student_id'],
    orderBy: [{ column: 'student_id', ascending: true }],
    dependsOn: ['profiles'],
    sharedInstituteTable: false,
    studentScopedColumn: 'student_id',
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_attempts',
    mode: 'snapshot',
    primaryKey: ['id'],
    orderBy: [
      { column: 'created_at', ascending: true },
      { column: 'id', ascending: true },
    ],
    dependsOn: ['profiles', 'jmcwc_papers', 'jmcwc_categories'],
    sharedInstituteTable: false,
    studentScopedColumn: 'student_id',
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_payloads',
    mode: 'snapshot',
    primaryKey: ['attempt_id'],
    orderBy: [{ column: 'attempt_id', ascending: true }],
    dependsOn: ['jmcwc_attempts'],
    sharedInstituteTable: false,
    studentScopedViaAttempt: true,
    privateServerOnly: true,
    containsAnswerKeys: true,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
  {
    name: 'jmcwc_scores',
    mode: 'snapshot',
    primaryKey: ['attempt_id'],
    orderBy: [
      { column: 'created_at', ascending: true },
      { column: 'attempt_id', ascending: true },
    ],
    dependsOn: ['jmcwc_attempts'],
    sharedInstituteTable: false,
    studentScopedViaAttempt: true,
    privateServerOnly: true,
    containsAnswerKeys: false,
    allowPublicBackup: false,
    allowSheetSync: false,
  },
];

export const JMCWC_BACKUP_TABLE_MAP = new Map(JMCWC_BACKUP_TABLES.map((t) => [t.name, t]));

/**
 * Tables that must NEVER be exposed in public backups or Google Sheets mirrors
 * because they contain private answer keys (`jmcwc_payloads.questions[*].answer_key`).
 */
export const FORBIDDEN_PUBLIC_OR_MIRROR_TABLES = Object.freeze(['jmcwc_payloads']);

/**
 * All 29 tables covered by private server-side admin backups (`BACKUP_TABLES` + `JMCWC_BACKUP_TABLES`).
 */
export const PRIVATE_SERVER_BACKUP_TABLES = [...BACKUP_TABLES, ...JMCWC_BACKUP_TABLES];

export const PRIVATE_SERVER_BACKUP_TABLE_MAP = new Map(
  PRIVATE_SERVER_BACKUP_TABLES.map((t) => [t.name, t])
);

/**
 * Authoritative foreign-key-safe restore sequence across all 29 application tables
 * (22 core tables + 7 JMCWC tables), plus `backup_runs` last.
 */
export const RESTORE_TABLE_ORDER = Object.freeze([
  // Tier 1: Root tables with no application-table foreign keys
  'categories',
  'round_series',
  'rounds',
  'profiles',
  'jmcwc_papers',
  // Tier 2: Tables referencing Tier 1
  'category_series',
  'category_aliases',
  'basics_thresholds',
  'daily_tasks',
  'resources',
  'competition_settings',
  'announcements',
  'weekly_tests',
  'attendance_sessions',
  'import_batches',
  'jmcwc_categories',
  'jmcwc_assignments',
  // Tier 3: Tables referencing Tier 1 & Tier 2
  'jmcwc_targets',
  'results',
  'activity_results',
  'weekly_test_sections',
  'weekly_test_scores',
  'weekly_test_attempts',
  'weekly_test_section_removals',
  'attendance',
  'jmcwc_attempts',
  // Tier 4: Audit logs, private attempt payloads, and graded attempt scores
  'result_audit',
  'profile_audit',
  'jmcwc_payloads',
  'jmcwc_scores',
  'report_log',
  'backup_runs',
]);

/**
 * Strips `jmcwc_payloads` and any nested `answer_key` properties from a table map
 * before any public export or Google Sheets mirror operation.
 *
 * @param {Record<string, Array<Record<string, any>>>} tablesMap
 * @returns {Record<string, Array<Record<string, any>>>}
 */
export function sanitizeTablesForPublicBackupOrMirror(tablesMap) {
  if (!tablesMap || typeof tablesMap !== 'object') return {};
  const clean = {};
  for (const [tableName, rows] of Object.entries(tablesMap)) {
    if (FORBIDDEN_PUBLIC_OR_MIRROR_TABLES.includes(tableName)) {
      continue;
    }
    if (!Array.isArray(rows)) {
      clean[tableName] = [];
      continue;
    }
    clean[tableName] = rows.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const copy = { ...row };
      delete copy.answer_key;
      if (Array.isArray(copy.questions)) {
        copy.questions = copy.questions.map((q) => {
          if (!q || typeof q !== 'object') return q;
          const qCopy = { ...q };
          delete qCopy.answer_key;
          return qCopy;
        });
      }
      return copy;
    });
  }
  return clean;
}

/**
 * Pure helper that computes student-deletion preview counts and post-deletion state
 * for a single student across all 7 JMCWC tables.
 * Guarantees that shared tables (`jmcwc_papers`, `jmcwc_categories`, `jmcwc_targets`)
 * are never deleted when deleting one student.
 *
 * @param {string} studentId
 * @param {object} tables - `{ jmcwc_papers, jmcwc_categories, jmcwc_targets, jmcwc_assignments, jmcwc_attempts, jmcwc_payloads, jmcwc_scores }`
 */
export function computeStudentDeletionJmcwcCounts(studentId, tables = {}) {
  const assignments = Array.isArray(tables.jmcwc_assignments) ? tables.jmcwc_assignments : [];
  const attempts = Array.isArray(tables.jmcwc_attempts) ? tables.jmcwc_attempts : [];
  const payloads = Array.isArray(tables.jmcwc_payloads) ? tables.jmcwc_payloads : [];
  const scores = Array.isArray(tables.jmcwc_scores) ? tables.jmcwc_scores : [];
  const papers = Array.isArray(tables.jmcwc_papers) ? tables.jmcwc_papers : [];
  const categories = Array.isArray(tables.jmcwc_categories) ? tables.jmcwc_categories : [];
  const targets = Array.isArray(tables.jmcwc_targets) ? tables.jmcwc_targets : [];

  const studentAssignments = assignments.filter((r) => r && r.student_id === studentId);
  const studentAttempts = attempts.filter((r) => r && r.student_id === studentId);
  const studentAttemptIds = new Set(studentAttempts.map((a) => a.id));
  const studentPayloads = payloads.filter((r) => r && studentAttemptIds.has(r.attempt_id));
  const studentScores = scores.filter((r) => r && studentAttemptIds.has(r.attempt_id));

  const totalToDelete =
    studentAssignments.length +
    studentAttempts.length +
    studentPayloads.length +
    studentScores.length;

  return {
    student_id: studentId,
    counts: {
      jmcwc_assignments: studentAssignments.length,
      jmcwc_attempts: studentAttempts.length,
      jmcwc_payloads: studentPayloads.length,
      jmcwc_scores: studentScores.length,
    },
    total_rows_to_delete: totalToDelete,
    total_jmcwc_rows: totalToDelete,
    preserved_shared_tables: ['jmcwc_papers', 'jmcwc_categories', 'jmcwc_targets'],
    preserved_shared_counts: {
      jmcwc_papers: papers.length,
      jmcwc_categories: categories.length,
      jmcwc_targets: targets.length,
    },
    remaining_tables: {
      jmcwc_papers: [...papers],
      jmcwc_categories: [...categories],
      jmcwc_targets: [...targets],
      jmcwc_assignments: assignments.filter((r) => !r || r.student_id !== studentId),
      jmcwc_attempts: attempts.filter((r) => !r || r.student_id !== studentId),
      jmcwc_payloads: payloads.filter((r) => !r || !studentAttemptIds.has(r.attempt_id)),
      jmcwc_scores: scores.filter((r) => !r || !studentAttemptIds.has(r.attempt_id)),
    },
  };
}

/**
 * Validates and restores all 7 JMCWC tables from a private server backup payload
 * in strict foreign-key order (`jmcwc_papers` -> `jmcwc_categories` -> `jmcwc_targets`
 * -> `jmcwc_assignments` -> `jmcwc_attempts` -> `jmcwc_payloads` -> `jmcwc_scores`).
 *
 * Ensures that every attempt in `jmcwc_attempts` (especially unfinished `paused`/`running`/`grading`
 * attempts) has its corresponding private `jmcwc_payloads` row with intact `questions[*].answer_key`
 * and `max_marks` marking data so saved papers are never lost on restore.
 *
 * @param {object} backupPayload - payload returned by `handlePrivateJmcwcBackup`
 * @returns {{ ok: true, restored_order: string[], tables: Record<string, Array<object>>, counts: Record<string, number> }}
 */
export function restoreJmcwcTablesFromPrivateBackup(backupPayload) {
  const sourceTables =
    backupPayload?.tables && typeof backupPayload.tables === 'object'
      ? backupPayload.tables
      : backupPayload;

  if (!sourceTables || typeof sourceTables !== 'object') {
    throw new Error('Invalid private JMCWC backup payload: missing tables object.');
  }

  const orderedNames = JMCWC_BACKUP_TABLES.map((t) => t.name);
  for (const name of orderedNames) {
    if (!Array.isArray(sourceTables[name])) {
      throw new Error(
        `Incomplete JMCWC backup: missing table "${name}". Private backups must include all 7 JMCWC tables.`
      );
    }
  }

  const restored = {};
  const counts = {};

  // 1. Restore in strict FK order and verify referential + marking integrity
  for (const name of orderedNames) {
    restored[name] = JSON.parse(JSON.stringify(sourceTables[name]));
    counts[name] = restored[name].length;
  }

  const paperIds = new Set(restored.jmcwc_papers.map((p) => p.id));
  const categoryKeys = new Set(restored.jmcwc_categories.map((c) => c.key));
  const attemptIds = new Set(restored.jmcwc_attempts.map((a) => a.id));
  const payloadByAttemptId = new Map(
    restored.jmcwc_payloads.map((p) => [p.attempt_id, p])
  );

  for (const target of restored.jmcwc_targets) {
    if (!categoryKeys.has(target.category_key)) {
      throw new Error(
        `Restore FK violation in jmcwc_targets: unknown category_key "${target.category_key}".`
      );
    }
  }

  for (const attempt of restored.jmcwc_attempts) {
    if (!paperIds.has(attempt.paper_id)) {
      throw new Error(
        `Restore FK violation in jmcwc_attempts: unknown paper_id "${attempt.paper_id}" for attempt "${attempt.id}".`
      );
    }
    const payload = payloadByAttemptId.get(attempt.id);
    if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
      throw new Error(
        `Restore integrity failure: attempt "${attempt.id}" (${attempt.status}) is missing its jmcwc_payloads row. Saved papers cannot be restored without jmcwc_payloads.`
      );
    }
    for (const q of payload.questions) {
      if (
        !q ||
        typeof q !== 'object' ||
        !Object.prototype.hasOwnProperty.call(q, 'answer_key') ||
        q.answer_key === undefined ||
        typeof q.max_marks !== 'number' ||
        !(q.max_marks > 0)
      ) {
        throw new Error(
          `Restore integrity failure: question "${q?.id || 'unknown'}" in attempt "${attempt.id}" is missing private answer_key or max_marks marking data.`
        );
      }
    }
  }

  for (const payload of restored.jmcwc_payloads) {
    if (!attemptIds.has(payload.attempt_id)) {
      throw new Error(
        `Restore FK violation in jmcwc_payloads: orphan attempt_id "${payload.attempt_id}".`
      );
    }
  }

  for (const score of restored.jmcwc_scores) {
    if (!attemptIds.has(score.attempt_id)) {
      throw new Error(
        `Restore FK violation in jmcwc_scores: orphan attempt_id "${score.attempt_id}".`
      );
    }
  }

  return {
    ok: true,
    restored_order: orderedNames,
    tables: restored,
    counts,
  };
}

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
