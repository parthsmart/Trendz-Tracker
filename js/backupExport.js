/**
 * Trendz Tracker - Pure RFC 4180 CSV & Uncompressed ("Store") ZIP Builder (js/backupExport.js)
 *
 * STRICT ARCHITECTURAL INVARIANTS:
 * - Zero external dependencies: hand-written IEEE 802.3 CRC32 and PKZIP Store (method 0) archive builder.
 * - Pure ES module: NO DOM, NO window/document, NO network calls, NO import.meta.env.
 * - Formula injection protection: any non-numeric string starting with `=`, `+`, `-`, or `@`
 *   is prefixed with a single quote (`'`).
 */

export const EXPORT_PAGE_SIZE = 1000;

/**
 * The 22 tables exported in a full backup ZIP, in the same canonical order as `api/_backupTables.js`.
 */
export const EXPORT_TABLES = [
  // 16 Snapshot tables
  { name: 'profiles', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'student_code', 'full_name', 'role', 'level', 'active', 'leaderboard_visible', 'created_at'] },
  { name: 'round_series', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'name', 'sort_order', 'is_current', 'created_at'] },
  { name: 'categories', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'name', 'section', 'sort_order', 'active', 'created_at'] },
  { name: 'category_series', mode: 'snapshot', primaryKey: ['category_id', 'series_id'], defaultColumns: ['category_id', 'series_id', 'sort_order'] },
  { name: 'basics_thresholds', mode: 'snapshot', primaryKey: ['id'], fallbackPrimaryKey: ['category_id'], defaultColumns: ['id', 'category_id', 'level', 'min_accuracy', 'max_time_seconds', 'active', 'created_at'] },
  { name: 'daily_tasks', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'title', 'section', 'category_id', 'level', 'sort_order', 'active', 'created_at'] },
  { name: 'resources', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'title', 'url', 'description', 'topic', 'sort_order', 'active', 'created_at'] },
  { name: 'competition_settings', mode: 'snapshot', primaryKey: ['id'], fallbackPrimaryKey: ['key'], defaultColumns: ['key', 'value', 'updated_at'] },
  { name: 'category_aliases', mode: 'snapshot', primaryKey: ['alias'], fallbackPrimaryKey: ['id'], defaultColumns: ['alias', 'category_id', 'created_at'] },
  { name: 'attendance_sessions', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'session_date', 'title', 'session_type', 'notes', 'created_by', 'created_at'] },
  { name: 'weekly_tests', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'test_date', 'title', 'notes', 'test_type', 'audience_level', 'opens_at', 'closes_at', 'remind_days_before', 'created_at'] },
  { name: 'weekly_test_sections', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'test_id', 'position', 'category_id', 'seconds'] },
  { name: 'weekly_test_attempts', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'test_id', 'student_id', 'category_id', 'session_id', 'status', 'started_at', 'finished_at'] },
  { name: 'weekly_test_removals', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'removed_by', 'removed_at', 'reason', 'title', 'test_date', 'scores_count', 'restored_at'] },
  { name: 'announcements', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'title', 'body', 'audience_level', 'active', 'created_by', 'created_at'] },
  { name: 'import_batches', mode: 'snapshot', primaryKey: ['id'], defaultColumns: ['id', 'student_id', 'file_name', 'conflict_mode', 'status', 'rounds_created', 'results_inserted', 'results_updated', 'results_skipped', 'acknowledgments', 'created_by', 'created_at', 'undone_at', 'undone_by'] },
  // 6 Append tables
  { name: 'student_rounds', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'student_id', 'series_id', 'round_number', 'round_date', 'round_type', 'time_taken_seconds', 'import_batch_id', 'created_at', 'updated_at'] },
  { name: 'results', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'student_id', 'category_id', 'student_round_id', 'round_number', 'correct', 'total', 'time_seconds', 'entry_date', 'note', 'verified', 'verified_at', 'verified_by', 'flagged', 'flag_note', 'corrected_at', 'corrected_by', 'import_batch_id', 'created_at', 'updated_at'] },
  { name: 'weekly_test_scores', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'test_id', 'student_id', 'category_id', 'correct', 'total', 'time_seconds', 'source', 'created_at', 'updated_at'] },
  { name: 'attendance', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'session_id', 'student_id', 'status', 'note', 'marked_by', 'created_at', 'updated_at'] },
  { name: 'activity_results', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'student_id', 'activity_type', 'score', 'entry_date', 'created_at', 'updated_at'] },
  { name: 'result_audit', mode: 'append', primaryKey: ['id'], defaultColumns: ['id', 'result_id', 'action', 'old_values', 'new_values', 'reason', 'changed_by', 'changed_at'] },
];

const PLAIN_NUMBER_REGEX = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/**
 * Protects against spreadsheet formula injection in CSV exports.
 * Any string starting with `=`, `+`, `-`, or `@` that is NOT a plain number
 * is prefixed with a single quote (`'`).
 *
 * @param {string} str
 * @returns {string}
 */
export function sanitizeCsvFormulaPrefix(str) {
  if (typeof str !== 'string' || str.length === 0) return '';
  const firstChar = str[0];
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    if (!PLAIN_NUMBER_REGEX.test(str.trim())) {
      return `'${str}`;
    }
  }
  return str;
}

/**
 * Formats a single value as an RFC 4180 CSV field with formula-prefix protection.
 *
 * @param {unknown} val
 * @returns {string}
 */
export function formatCsvCell(val) {
  if (val === null || val === undefined) {
    return '';
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (typeof val === 'number') {
    return Number.isFinite(val) ? String(val) : '';
  }

  const rawStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
  const safeStr = sanitizeCsvFormulaPrefix(rawStr);

  if (
    safeStr.includes(',') ||
    safeStr.includes('"') ||
    safeStr.includes('\r') ||
    safeStr.includes('\n')
  ) {
    return `"${safeStr.replace(/"/g, '""')}"`;
  }
  return safeStr;
}

/**
 * Converts an array of row objects into an RFC 4180 CSV string (`\r\n` line endings).
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} [fallbackColumns]
 * @returns {string}
 */
export function rowsToCsv(rows, fallbackColumns = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const colSet = new Set();

  for (const r of safeRows) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) {
        colSet.add(k);
      }
    }
  }

  if (colSet.size === 0 && Array.isArray(fallbackColumns)) {
    for (const k of fallbackColumns) {
      colSet.add(k);
    }
  }

  const columns = Array.from(colSet);
  if (columns.length === 0) {
    return '';
  }

  const lines = [];
  lines.push(columns.map((col) => formatCsvCell(col)).join(','));

  for (const row of safeRows) {
    const line = columns.map((col) => formatCsvCell(row ? row[col] : '')).join(',');
    lines.push(line);
  }

  return lines.join('\r\n') + '\r\n';
}

// ============================================================================
// Hand-Written IEEE 802.3 CRC32 Table & Calculator
// ============================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes the unsigned 32-bit CRC32 checksum of a Uint8Array or string.
 *
 * @param {Uint8Array | string} input
 * @returns {number}
 */
export function crc32(input) {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Converts a JavaScript Date into MS-DOS 16-bit time and 16-bit date fields for ZIP headers.
 * @param {Date} d
 * @returns {{ dosTime: number, dosDate: number }}
 */
function toDosDateTime(d = new Date()) {
  const year = Math.max(1980, d.getUTCFullYear());
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = Math.floor(d.getUTCSeconds() / 2);

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a valid PKZIP archive using the uncompressed "store" method (method 0).
 *
 * @param {Array<{ name: string, content: string | Uint8Array }>} files
 * @param {Date} [timestamp]
 * @returns {Uint8Array}
 */
export function buildStoreZip(files, timestamp = new Date()) {
  if (!Array.isArray(files)) {
    throw new Error('buildStoreZip requires an array of { name, content } file entries.');
  }

  const encoder = new TextEncoder();
  const { dosTime, dosDate } = toDosDateTime(timestamp);
  const UTF8_FLAG = 0x0800; // Bit 11: filename and comment are UTF-8 encoded

  const prepared = files.map((file) => {
    const cleanName = String(file?.name || 'file.txt').replace(/^\/+/, '');
    const nameBytes = encoder.encode(cleanName);
    const dataBytes =
      file?.content instanceof Uint8Array
        ? file.content
        : encoder.encode(String(file?.content ?? ''));
    const checksum = crc32(dataBytes);
    return {
      nameBytes,
      dataBytes,
      crc: checksum,
      size: dataBytes.length,
    };
  });

  // Calculate total archive byte length
  let localSectionBytes = 0;
  let centralDirBytes = 0;
  for (const item of prepared) {
    localSectionBytes += 30 + item.nameBytes.length + item.size;
    centralDirBytes += 46 + item.nameBytes.length;
  }
  const totalBytes = localSectionBytes + centralDirBytes + 22;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let offset = 0;

  const localOffsets = [];

  // 1. Write Local File Headers + File Data
  for (const item of prepared) {
    localOffsets.push(offset);

    view.setUint32(offset, 0x04034b50, true); // Local file header signature
    view.setUint16(offset + 4, 20, true); // Version needed to extract (2.0)
    view.setUint16(offset + 6, UTF8_FLAG, true); // General purpose bit flag (UTF-8)
    view.setUint16(offset + 8, 0, true); // Compression method: 0 (Store)
    view.setUint16(offset + 10, dosTime, true); // Last mod file time
    view.setUint16(offset + 12, dosDate, true); // Last mod file date
    view.setUint32(offset + 14, item.crc, true); // CRC-32
    view.setUint32(offset + 18, item.size, true); // Compressed size
    view.setUint32(offset + 22, item.size, true); // Uncompressed size
    view.setUint16(offset + 26, item.nameBytes.length, true); // File name length
    view.setUint16(offset + 28, 0, true); // Extra field length
    offset += 30;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;

    out.set(item.dataBytes, offset);
    offset += item.size;
  }

  const centralDirStartOffset = offset;

  // 2. Write Central Directory File Headers
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    const localHeaderOffset = localOffsets[i];

    view.setUint32(offset, 0x02014b50, true); // Central directory file header signature
    view.setUint16(offset + 4, 20, true); // Version made by (2.0)
    view.setUint16(offset + 6, 20, true); // Version needed to extract (2.0)
    view.setUint16(offset + 8, UTF8_FLAG, true); // General purpose bit flag (UTF-8)
    view.setUint16(offset + 10, 0, true); // Compression method: 0 (Store)
    view.setUint16(offset + 12, dosTime, true); // Last mod file time
    view.setUint16(offset + 14, dosDate, true); // Last mod file date
    view.setUint32(offset + 16, item.crc, true); // CRC-32
    view.setUint32(offset + 20, item.size, true); // Compressed size
    view.setUint32(offset + 24, item.size, true); // Uncompressed size
    view.setUint16(offset + 28, item.nameBytes.length, true); // File name length
    view.setUint16(offset + 30, 0, true); // Extra field length
    view.setUint16(offset + 32, 0, true); // File comment length
    view.setUint16(offset + 34, 0, true); // Disk number start
    view.setUint16(offset + 36, 0, true); // Internal file attributes
    view.setUint32(offset + 38, 0, true); // External file attributes
    view.setUint32(offset + 42, localHeaderOffset, true); // Relative offset of local header
    offset += 46;

    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;
  }

  const centralDirSize = offset - centralDirStartOffset;

  // 3. Write End of Central Directory Record (EOCD)
  view.setUint32(offset, 0x06054b50, true); // EOCD signature
  view.setUint16(offset + 4, 0, true); // Number of this disk
  view.setUint16(offset + 6, 0, true); // Disk where central directory starts
  view.setUint16(offset + 8, prepared.length, true); // Number of central directory records on this disk
  view.setUint16(offset + 10, prepared.length, true); // Total number of central directory records
  view.setUint32(offset + 12, centralDirSize, true); // Size of central directory (bytes)
  view.setUint32(offset + 16, centralDirStartOffset, true); // Offset of start of central directory
  view.setUint16(offset + 20, 0, true); // Comment length

  return out;
}

/**
 * Parses and validates a Store-mode ZIP archive (used by unit tests to verify archive integrity).
 *
 * @param {Uint8Array} zipBytes
 * @returns {Array<{ name: string, size: number, crc: number, text: string }>}
 */
export function parseStoreZip(zipBytes) {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder();

  // Locate EOCD at the end of the buffer
  const eocdOffset = zipBytes.byteLength - 22;
  if (eocdOffset < 0 || view.getUint32(eocdOffset, true) !== 0x06054b50) {
    throw new Error('Invalid ZIP archive: End of Central Directory signature not found.');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  let ptr = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at entry ${i}`);
    }
    const method = view.getUint16(ptr + 10, true);
    if (method !== 0) {
      throw new Error(`Unsupported compression method ${method}; expected 0 (store).`);
    }
    const expectedCrc = view.getUint32(ptr + 16, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);

    const name = decoder.decode(zipBytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    // Verify local file header
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header for ${name}`);
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataSlice = zipBytes.subarray(dataStart, dataStart + compressedSize);

    const actualCrc = crc32(dataSlice);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC32 mismatch for ${name}: expected ${expectedCrc}, got ${actualCrc}`);
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error(`Size mismatch for ${name}`);
    }

    entries.push({
      name,
      size: uncompressedSize,
      crc: actualCrc,
      text: decoder.decode(dataSlice),
    });
  }

  return entries;
}

/**
 * Builds the human-readable README.txt packaged inside `trendz-backup-YYYY-MM-DD.zip`.
 *
 * @param {{ dateIst: string, tableSummaries: Record<string, number>, totalRows: number }} params
 * @returns {string}
 */
export function buildExportReadme({ dateIst, tableSummaries = {}, totalRows = 0 }) {
  const lines = [
    '======================================================================',
    'TRENDZ TRACKER — FULL DATA BACKUP ARCHIVE',
    '======================================================================',
    `Backup Date (IST): ${dateIst || 'Unknown'}`,
    `Total Rows Exported: ${totalRows}`,
    '',
    'CONTENTS (18 CSV files):',
  ];

  for (const t of EXPORT_TABLES) {
    const count = Number(tableSummaries[t.name] ?? 0);
    lines.push(`  - ${t.name}.csv (${count} row${count === 1 ? '' : 's'})`);
  }

  lines.push(
    '',
    'HOW TO RESTORE INTO A NEW SUPABASE PROJECT:',
    '1. Recreate the database schema by running the 12 SQL scripts in',
    '   `supabase/migrations/` in numerical order (01 through 12) in the',
    '   Supabase SQL Editor.',
    '2. Create student/admin accounts in Supabase Auth (or import into',
    '   `profiles` after creating corresponding `auth.users` rows).',
    '3. Import the CSV files in foreign-key dependency order:',
    '   a) profiles.csv, round_series.csv, categories.csv, competition_settings.csv',
    '   b) category_series.csv, category_aliases.csv, basics_thresholds.csv,',
    '      daily_tasks.csv, resources.csv',
    '   c) attendance_sessions.csv, attendance.csv, weekly_tests.csv,',
    '      weekly_test_scores.csv',
    '   d) import_batches.csv, student_rounds.csv, results.csv,',
    '      activity_results.csv, result_audit.csv',
    '   Note: If any text cell was prefixed with a leading single quote (\')',
    '   to prevent spreadsheet formula injection, remove the leading single',
    '   quote if needed.',
    '4. Run `SELECT public.admin_schema_health();` in the SQL Editor to',
    '   verify all tables and row counts.',
    '5. See `docs/RESTORE.md` in the repository for the complete step-by-step',
    '   beginner restoration guide.',
    ''
  );

  return lines.join('\r\n');
}
