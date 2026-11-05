/**
 * Trendz Tracker — Phase 5c Unit & Integration Tests (tests/backup.test.js)
 *
 * Tests:
 * 1. Single source of truth table configuration & helpers (api/_backupTables.js)
 * 2. RFC 4180 CSV serializer, formula injection protection, CRC-32, and Store ZIP builder & parser (js/backupExport.js)
 * 3. Google service-account RS256 JWT signing, token caching, retry logic, and secret redaction (api/_google.js)
 * 4. Backup handler auth, lock management, snapshot & append cursor pagination, and time-budget partial pass (api/backup.js)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it, beforeEach } from 'node:test';

import {
  BACKUP_TABLES,
  SNAPSHOT_TABLES,
  APPEND_TABLES,
  BACKUP_TABLE_MAP,
  SNAPSHOT_MAX_ROWS,
  PAGE_SIZE,
  SHEETS_UPDATE_CHUNK_ROWS,
  GOOGLE_SHEETS_CELL_LIMIT,
  GOOGLE_SHEETS_WARN_RATIO,
  convertValueForSheets,
  serializeRowForSheets,
  resolveAppendHeader,
  buildKeysetOrFilter,
  colIndexToLetter,
  JMCWC_BACKUP_TABLES,
  FORBIDDEN_PUBLIC_OR_MIRROR_TABLES,
  PRIVATE_SERVER_BACKUP_TABLES,
  RESTORE_TABLE_ORDER,
  sanitizeTablesForPublicBackupOrMirror,
  computeStudentDeletionJmcwcCounts,
  restoreJmcwcTablesFromPrivateBackup,
} from '../api/_backupTables.js';
import { generateQuestionsFromBlueprint } from '../api/_jmcwcGenerate.js';
import { gradeAttempt } from '../api/_jmcwcGrade.js';
import {
  getGoogleBackupConfig,
  hasGoogleBackupConfig,
  clearGoogleTokenCache,
  sanitizeGoogleErrorMessage,
  buildServiceAccountJwt,
  googleFetchWithRetry,
  getAccessToken,
  formatSheetRange,
} from '../api/_google.js';
import {
  MIRROR_FORBIDDEN_TABLES,
  assertMirrorExcludesPayloads,
} from '../api/_mirror.js';
import backupHandler, {
  TIME_BUDGET_MS,
  STALE_LOCK_MS,
  SAFE_HORIZON_MS,
  TOTAL_CRON_TIMEOUT_MS,
  CRON_RESERVED_MS,
  CRON_MAX_RUNTIME_MS,
  MIN_PASS_BUDGET_MS,
  sanitizeBackupError,
  executeBackupRunPass,
  handlePrivateJmcwcBackup,
} from '../api/backup.js';
import {
  EXPORT_PAGE_SIZE,
  EXPORT_TABLES,
  sanitizeCsvFormulaPrefix,
  formatCsvCell,
  rowsToCsv,
  crc32,
  buildStoreZip,
  parseStoreZip,
  buildExportReadme,
} from '../js/backupExport.js';

describe('Phase 5c — 1. Table Configuration & Sheet Value Helpers (api/_backupTables.js)', () => {
  it('defines all 22 tables (16 snapshot + 6 append) in exact order', () => {
    assert.equal(BACKUP_TABLES.length, 22);
    assert.equal(SNAPSHOT_TABLES.length, 16);
    assert.equal(APPEND_TABLES.length, 6);

    const expectedSnapshot = [
      'profiles',
      'round_series',
      'categories',
      'category_series',
      'basics_thresholds',
      'daily_tasks',
      'resources',
      'competition_settings',
      'category_aliases',
      'attendance_sessions',
      'weekly_tests',
      'weekly_test_sections',
      'weekly_test_attempts',
      'weekly_test_removals',
      'announcements',
      'import_batches',
    ];
    assert.deepEqual(
      SNAPSHOT_TABLES.map((t) => t.name),
      expectedSnapshot
    );

    const expectedAppend = [
      'student_rounds',
      'results',
      'weekly_test_scores',
      'attendance',
      'activity_results',
      'result_audit',
    ];
    assert.deepEqual(
      APPEND_TABLES.map((t) => t.name),
      expectedAppend
    );
  });

  it('assigns cursorColumn updated_at to 5 append tables and changed_at to result_audit', () => {
    for (const t of SNAPSHOT_TABLES) {
      assert.equal(t.cursorColumn, null, `Snapshot table ${t.name} must have null cursorColumn`);
      assert.ok(Array.isArray(t.primaryKey) && t.primaryKey.length >= 1);
    }

    for (const t of APPEND_TABLES) {
      assert.deepEqual(t.primaryKey, ['id']);
      if (t.name === 'result_audit') {
        assert.equal(t.cursorColumn, 'changed_at');
      } else {
        assert.equal(t.cursorColumn, 'updated_at');
      }
    }

    assert.equal(BACKUP_TABLE_MAP.get('results')?.mode, 'append');
    assert.equal(BACKUP_TABLE_MAP.get('category_series')?.primaryKey.join(','), 'category_id,series_id');
    assert.equal(SNAPSHOT_MAX_ROWS, 20000);
    assert.equal(PAGE_SIZE, 1000);
    assert.equal(SHEETS_UPDATE_CHUNK_ROWS, 5000);
    assert.equal(GOOGLE_SHEETS_CELL_LIMIT, 10_000_000);
    assert.equal(GOOGLE_SHEETS_WARN_RATIO, 0.7);
  });

  it('converts values for Google Sheets RAW mode and truncates >49,000 char strings', () => {
    assert.equal(convertValueForSheets(null), '');
    assert.equal(convertValueForSheets(undefined), '');
    assert.equal(convertValueForSheets(true), true);
    assert.equal(convertValueForSheets(false), false);
    assert.equal(convertValueForSheets(42), 42);
    assert.equal(convertValueForSheets({ a: 1 }), '{"a":1}');
    assert.equal(convertValueForSheets('2026-10-19T10:20:30.123456+00:00'), '2026-10-19T10:20:30.123456+00:00');

    const huge = 'x'.repeat(49500);
    const convertedHuge = convertValueForSheets(huge);
    assert.equal(convertedHuge.length, 49000 + ' [TRUNCATED]'.length);
    assert.ok(convertedHuge.endsWith(' [TRUNCATED]'));

    const rowCells = serializeRowForSheets(
      { id: 'r1', correct: 18, note: null },
      ['id', 'correct', 'note', '_backed_up_at'],
      '2026-10-19T12:00:00Z'
    );
    assert.deepEqual(rowCells, ['r1', 18, '', '2026-10-19T12:00:00Z']);
  });

  it('builds evolving append headers without dropping existing columns and builds exact keyset filters', () => {
    const h1 = resolveAppendHeader(null, [{ id: '1', score: 10 }]);
    assert.deepEqual(h1.header, ['id', 'score', '_backed_up_at']);
    assert.equal(h1.changed, true);

    const h2 = resolveAppendHeader(h1.header, [{ id: '2', score: 20, new_col: 'abc' }]);
    assert.deepEqual(h2.header, ['id', 'score', '_backed_up_at', 'new_col']);
    assert.equal(h2.changed, true);

    const filter = buildKeysetOrFilter(
      'updated_at',
      '2026-10-19T08:15:00.123456+00:00',
      '11111111-2222-3333-4444-555555555555'
    );
    assert.equal(
      filter,
      'updated_at.gt.2026-10-19T08:15:00.123456+00:00,and(updated_at.eq.2026-10-19T08:15:00.123456+00:00,id.gt.11111111-2222-3333-4444-555555555555)'
    );

    assert.equal(colIndexToLetter(0), 'A');
    assert.equal(colIndexToLetter(25), 'Z');
    assert.equal(colIndexToLetter(26), 'AA');
    assert.equal(colIndexToLetter(51), 'AZ');
  });

  it('keeps browser EXPORT_TABLES in sync with BACKUP_TABLES', () => {
    assert.equal(EXPORT_PAGE_SIZE, 1000);
    assert.deepEqual(
      EXPORT_TABLES.map((t) => t.name),
      BACKUP_TABLES.map((t) => t.name)
    );
  });
});

describe('Phase 5c — 2. RFC 4180 CSV, Formula Protection, CRC-32 & Store ZIP (js/backupExport.js)', () => {
  it('protects against CSV formula injection while leaving negative/positive numbers untouched', () => {
    assert.equal(sanitizeCsvFormulaPrefix('=SUM(A1:A10)'), "'=SUM(A1:A10)");
    assert.equal(sanitizeCsvFormulaPrefix('+cmd|"/c calc"!A0'), "'+cmd|\"/c calc\"!A0");
    assert.equal(sanitizeCsvFormulaPrefix('-2+3+cmd'), "'-2+3+cmd");
    assert.equal(sanitizeCsvFormulaPrefix('@IMPORTXML()'), "'@IMPORTXML()");
    assert.equal(sanitizeCsvFormulaPrefix('-42.5'), '-42.5');
    assert.equal(sanitizeCsvFormulaPrefix('+100'), '+100');
  });

  it('formats CSV cells per RFC 4180 (nulls, booleans, quotes, commas, newlines, JSONB)', () => {
    assert.equal(formatCsvCell(null), '');
    assert.equal(formatCsvCell(undefined), '');
    assert.equal(formatCsvCell(true), 'true');
    assert.equal(formatCsvCell(false), 'false');
    assert.equal(formatCsvCell(42), '42');
    assert.equal(formatCsvCell('plain'), 'plain');
    assert.equal(formatCsvCell('has,comma'), '"has,comma"');
    assert.equal(formatCsvCell('has "quotes" inside'), '"has ""quotes"" inside"');
    assert.equal(formatCsvCell('line1\nline2'), '"line1\nline2"');
    assert.equal(formatCsvCell({ a: 1, b: 'two' }), '"{""a"":1,""b"":""two""}"');
  });

  it('converts row arrays to RFC 4180 CSV with CRLF line endings and fallback headers on empty tables', () => {
    const emptyCsv = rowsToCsv([], ['id', 'name']);
    assert.equal(emptyCsv, 'id,name\r\n');

    const rows = [
      { id: 'u1', name: 'Aarav, Jr.', verified: true, meta: { score: 10 }, note: null },
      { id: 'u2', name: 'Diya "Star"', verified: false, meta: null, note: '=BAD()' },
    ];
    const csv = rowsToCsv(rows, ['id', 'name']);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'id,name,verified,meta,note');
    assert.equal(lines[1], 'u1,"Aarav, Jr.",true,"{""score"":10}",');
    assert.equal(lines[2], 'u2,"Diya ""Star""",false,,\'=BAD()');
  });

  it('computes standard IEEE 802.3 CRC-32 checksums accurately', () => {
    // Standard CRC-32 check value for ASCII "123456789" is 0xCBF43926
    assert.equal(crc32('123456789'), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0x00000000);
  });

  it('builds and parses a valid uncompressed Store ZIP archive with 22 CSVs + README.txt', () => {
    const fixedDate = new Date('2026-10-19T12:30:00Z');
    const files = EXPORT_TABLES.map((t, idx) => ({
      name: `${t.name}.csv`,
      content: rowsToCsv([{ id: `row_${idx}`, idx }], t.defaultColumns),
    }));
    const readmeContent = buildExportReadme({
      dateIst: '2026-10-19',
      tableSummaries: Object.fromEntries(EXPORT_TABLES.map((t) => [t.name, 1])),
      totalRows: 22,
    });
    files.push({ name: 'README.txt', content: readmeContent });

    const zipBytes = buildStoreZip(files, fixedDate);
    const parsedEntries = parseStoreZip(zipBytes);

    assert.equal(parsedEntries.length, 23);
    assert.equal(parsedEntries[0].name, 'profiles.csv');
    assert.ok(parsedEntries[0].text.includes('row_0'));
    assert.equal(parsedEntries[22].name, 'README.txt');
    assert.ok(parsedEntries[22].text.includes('TRENDZ TRACKER — FULL DATA BACKUP ARCHIVE'));
    assert.ok(parsedEntries[22].text.includes('2026-10-19'));
  });
});

describe('Phase 5c — 3. Google Service-Account Crypto & Sheet Helpers (api/_google.js)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    clearGoogleTokenCache();
  });

  it('signs a valid RS256 JWT assertion verifiable with the public key', () => {
    const jwt = buildServiceAccountJwt({
      clientEmail: 'backup-bot@trendz-test.iam.gserviceaccount.com',
      privateKey,
      nowSec: 1760000000,
    });

    const parts = jwt.split('.');
    assert.equal(parts.length, 3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(payload.iss, 'backup-bot@trendz-test.iam.gserviceaccount.com');
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/spreadsheets');
    assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(payload.exp - payload.iat, 3600);

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    const isValid = verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'));
    assert.equal(isValid, true);
  });

  it('exchanges JWT for OAuth2 access token, caches it, and retries once on HTTP 429/503', async () => {
    const escapedPem = privateKey.replace(/\n/g, '\\n');
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: escapedPem,
      }),
      BACKUP_SHEET_ID: 'sheet_id_abc',
    };

    assert.equal(hasGoogleBackupConfig(env), true);
    assert.equal(getGoogleBackupConfig(env).sheetId, 'sheet_id_abc');

    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => JSON.stringify({ error: { message: 'Temporary overload' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'ya29.mock_secret_token', expires_in: 3600 }),
      };
    };

    const token1 = await getAccessToken({ env, fetchImpl: mockFetch, retryDelayMs: 5 });
    assert.equal(token1, 'ya29.mock_secret_token');
    assert.equal(calls, 2); // Retried once after 503

    // Second call uses in-memory cache without invoking fetch
    const token2 = await getAccessToken({ env, fetchImpl: mockFetch, retryDelayMs: 5 });
    assert.equal(token2, 'ya29.mock_secret_token');
    assert.equal(calls, 2);
  });

  it('redacts tokens and private keys from error messages and formats sheet ranges', () => {
    const dirty =
      'Failed with Bearer ya29.super_secret_token_123 and key -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
    const clean = sanitizeGoogleErrorMessage(dirty, ['custom_secret_xyz']);
    assert.ok(!clean.includes('ya29.super_secret_token_123'));
    assert.ok(!clean.includes('BEGIN PRIVATE KEY'));
    assert.equal(formatSheetRange('profiles', 'A1'), 'profiles!A1');
    assert.equal(formatSheetRange('Sheet 1', 'A2:G10'), "'Sheet 1'!A2:G10");
  });
});

describe('Phase 5c — 4. Backup Endpoint Auth, Lock & Pass Execution (api/backup.js)', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  beforeEach(() => {
    clearGoogleTokenCache();
  });

  it('exports expected constants and rejects unauthenticated or invalid HTTP method requests', async () => {
    assert.equal(TIME_BUDGET_MS, 8000);
    assert.equal(STALE_LOCK_MS, 180000);
    assert.equal(SAFE_HORIZON_MS, 60000);
    assert.ok(sanitizeBackupError(new Error('test error')).includes('test error'));

    let statusCode = null;
    const res = {
      setHeader() {},
      status(code) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };

    await backupHandler({ method: 'DELETE', headers: {} }, res);
    assert.equal(statusCode, 405);
  });

  it('returns { busy: true } when another backup_runs row is already running', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update() {
              return { eq: () => ({ lt: async () => ({ data: [], error: null }) }) };
            },
            select() {
              return {
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                  }),
                }),
              };
            },
          };
        }
        throw new Error(`Unexpected table ${table}`);
      },
    };

    const res = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'cron',
      env,
      retryDelayMs: 1,
    });
    console.log('TASK 3.1 RESULT:', JSON.stringify(res));
    assert.equal(res.httpStatus, 200);
    assert.deepEqual(res.body, { busy: true });
  });

  it('pauses gracefully with status "partial" and error "more to do" when the 8s time budget is reached', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    let fakeNow = 1760000000000;
    const nowFn = () => {
      // Advance clock by 9 seconds after initial setup so time budget triggers cleanly
      const current = fakeNow;
      fakeNow += 3000;
      return current;
    };

    let updatedRunPayload = null;
    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update(payload) {
              updatedRunPayload = payload;
              return {
                eq: () => ({
                  lt: async () => ({ data: [], error: null }),
                }),
              };
            },
            select() {
              return {
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: 'run-uuid-1' },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: [], error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        return {
          select() {
            return {
              order() {
                return this;
              },
              range: async () => ({ data: [{ id: 'p1', full_name: 'Student 1' }], error: null }),
            };
          },
        };
      },
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    const result = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'manual',
      createdBy: 'admin-1',
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn,
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'partial');
    assert.equal(result.body.error, 'more to do');
    assert.equal(updatedRunPayload.status, 'partial');
  });

  it('resumes multi-pass cycle by marking previously completed snapshot tables as cached_in_pass and advancing budget', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const fetchedTables = [];
    const stateRows = [
      {
        table_name: 'profiles',
        mode: 'snapshot',
        rows_written: 15,
        cells_written: 150,
        last_run_at: '2026-11-04T02:00:05.000Z',
        last_error: null,
      },
      {
        table_name: 'categories',
        mode: 'snapshot',
        rows_written: 20,
        cells_written: 160,
        last_run_at: '2026-11-04T02:00:06.000Z',
        last_error: null,
      },
    ];

    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update() {
              return {
                eq: () => ({
                  lt: async () => ({ data: [], error: null }),
                }),
              };
            },
            select(cols) {
              return {
                eq(col, val) {
                  return {
                    order: () => ({
                      limit: async () => {
                        if (val === 'done') {
                          return {
                            data: [{ id: 'run-done-yesterday', finished_at: '2026-11-03T02:00:00.000Z' }],
                            error: null,
                          };
                        }
                        return { data: [], error: null };
                      },
                    }),
                  };
                },
                order: () => ({
                  limit: async () => ({
                    data: [{ id: 'run-partial-today', status: 'partial', finished_at: '2026-11-04T02:00:08.000Z' }],
                    error: null,
                  }),
                }),
              };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: 'run-uuid-pass-2' },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: stateRows, error: null }),
            upsert: async () => ({ data: null, error: null }),
          };
        }
        fetchedTables.push(table);
        return {
          select() {
            return {
              order() {
                return this;
              },
              range: async () => ({ data: [{ id: 'row-1' }], error: null }),
            };
          },
        };
      },
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    let passClock = new Date('2026-11-04T02:00:20.000Z').getTime();
    const result = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => {
        const cur = passClock;
        passClock += 200;
        return cur;
      },
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.tables.profiles.status, 'cached_in_pass');
    assert.equal(result.body.tables.categories.status, 'cached_in_pass');
    assert.ok(!fetchedTables.includes('profiles'), 'profiles should not have been re-queried');
    assert.ok(!fetchedTables.includes('categories'), 'categories should not have been re-queried');
    assert.ok(fetchedTables.includes('category_series'), 'category_series should have been queried');
  });

  it('Task 3.1: multiple partial passes eventually finish into a done run across cycles', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    // Simulate pass where all snapshot tables already completed and append tables have 0 rows waiting
    const allSnapState = SNAPSHOT_TABLES.map((t) => ({
      table_name: t.name,
      mode: 'snapshot',
      rows_written: 10,
      cells_written: 100,
      last_run_at: '2026-11-04T02:00:10.000Z',
      last_error: null,
    }));

    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
              order: () => ({ limit: async () => ({ data: [{ id: 'p1', status: 'partial' }], error: null }) }),
            }),
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-p3' }, error: null }) }) }),
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: allSnapState, error: null }),
            upsert: async () => ({ data: null, error: null }),
          };
        }
        return {
          select: () => ({
            lte: () => ({
              order: () => ({
                order: () => ({
                  limit: async () => ({ data: [], error: null }), // 0 rows waiting in append tables
                }),
              }),
            }),
          }),
        };
      },
    };

    const res = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => new Date('2026-11-04T02:00:20.000Z').getTime(),
    });

    assert.equal(res.httpStatus, 200);
    assert.equal(res.body.status, 'done', 'Pass must finish as done when all snapshots cached and appends caught up');
    assert.equal(res.body.error, null);
  });

  it('Task 3.2: continuation on the following day recognizes active cycle without restarting at table 1', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    // Profiles was backed up yesterday at 20:30 during an interrupted cycle.
    // Last 'done' run was 2 days ago (2026-11-02).
    const stateRows = [
      {
        table_name: 'profiles',
        mode: 'snapshot',
        rows_written: 15,
        cells_written: 150,
        last_run_at: '2026-11-03T20:30:05.000Z',
        last_error: null,
      },
    ];

    let profilesQueried = false;
    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: (col, val) => ({
                order: () => ({
                  limit: async () => {
                    if (val === 'done') {
                      return { data: [{ id: 'done-2-days-ago', finished_at: '2026-11-02T20:30:00.000Z' }], error: null };
                    }
                    return { data: [], error: null };
                  },
                }),
              }),
              order: () => ({ limit: async () => ({ data: [{ id: 'partial-yesterday', status: 'partial' }], error: null }) }),
            }),
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-today' }, error: null }) }) }),
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: stateRows, error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        if (table === 'profiles') {
          profilesQueried = true;
        }
        const q = {
          order() { return q; },
          range: async () => ({ data: [{ id: 'r1' }], error: null }),
          lte() { return q; },
          gt() { return q; },
          limit: async () => ({ data: [], error: null, count: 0 }),
        };
        return {
          select: () => q,
        };
      },
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    const res = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => new Date('2026-11-04T20:30:00.000Z').getTime(), // 24 hours later
    });

    assert.equal(res.httpStatus, 200);
    assert.equal(res.body.tables.profiles.status, 'cached_in_pass');
    assert.equal(profilesQueried, false, 'Profiles table must not be re-queried during continuation');
  });

  it('Task 3.3: a new cycle refreshes snapshots after the previous cycle finishes with done', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    // Profiles was backed up yesterday at 20:30, and the previous cycle finished 'done' yesterday at 20:31
    const stateRows = [
      {
        table_name: 'profiles',
        mode: 'snapshot',
        rows_written: 15,
        cells_written: 150,
        last_run_at: '2026-11-04T20:30:05.000Z',
        last_error: null,
      },
    ];

    let profilesQueried = false;
    const mockSupabase = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: (col, val) => ({
                order: () => ({
                  limit: async () => {
                    if (val === 'done') {
                      return { data: [{ id: 'done-yesterday', finished_at: '2026-11-04T20:31:00.000Z' }], error: null };
                    }
                    return { data: [], error: null };
                  },
                }),
              }),
              order: () => ({ limit: async () => ({ data: [{ id: 'done-yesterday', status: 'done' }], error: null }) }),
            }),
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-new-cycle' }, error: null }) }) }),
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: stateRows, error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        if (table === 'profiles') {
          profilesQueried = true;
        }
        const q = {
          order() { return q; },
          range: async () => ({ data: [{ id: 'p1', full_name: 'Updated Student' }], error: null }),
          lte() { return q; },
          gt() { return q; },
          limit: async () => ({ data: [], error: null, count: 0 }),
        };
        return {
          select: () => q,
        };
      },
    };

    const res = await executeBackupRunPass({
      supabase: mockSupabase,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => new Date('2026-11-05T20:30:00.000Z').getTime(), // Today's new daily cycle
    });

    assert.equal(res.httpStatus, 200);
    assert.equal(profilesQueried, true, 'New cycle must refresh snapshot tables, not skip them as cached');
    assert.equal(res.body.tables.profiles.rows, 1);
  });

  it('Task 3.4 & 3.5: handles missing or failed previous completed run queries without crashing', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    // Case 1: Brand new installation (0 done runs)
    const mockSupabaseEmpty = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-first' }, error: null }) }) }),
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: [], error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        const q = {
          order() { return q; },
          range: async () => ({ data: [{ id: '1' }], error: null }),
          lte() { return q; },
          gt() { return q; },
          limit: async () => ({ data: [], error: null, count: 0 }),
        };
        return {
          select: () => q,
        };
      },
    };

    const resEmpty = await executeBackupRunPass({
      supabase: mockSupabaseEmpty,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => 1760000000000,
    });
    assert.equal(resEmpty.httpStatus, 200);
    assert.equal(resEmpty.body.ok, true);

    // Case 2: Database throws error querying last completed run
    const mockSupabaseDbErr = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => { throw new Error('Database connection reset during last-run check'); }
                }),
              }),
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
            insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'run-fallback' }, error: null }) }) }),
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: [], error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        const q = {
          order() { return q; },
          range: async () => ({ data: [{ id: '1' }], error: null }),
          lte() { return q; },
          gt() { return q; },
          limit: async () => ({ data: [], error: null, count: 0 }),
        };
        return {
          select: () => q,
        };
      },
    };

    const resFallback = await executeBackupRunPass({
      supabase: mockSupabaseDbErr,
      kind: 'cron',
      createdBy: null,
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => 1760000000000,
    });
    assert.equal(resFallback.httpStatus, 200);
    assert.equal(resFallback.body.ok, true);
  });

  it('Task 3.6: concurrent runs are rejected with { busy: true } preserving running process', async () => {
    const mockSupabaseBusy = {
      from(table) {
        if (table === 'backup_runs') {
          return {
            update: () => ({ eq: () => ({ lt: async () => ({ data: [], error: null }) }) }),
            select: () => ({
              eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }),
              order: () => ({ limit: async () => ({ data: [], error: null }) }),
            }),
            insert: () => ({
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique index idx_backup_runs_one_running' }
                }),
              }),
            }),
          };
        }
        return {};
      },
    };

    const res = await executeBackupRunPass({
      supabase: mockSupabaseBusy,
      kind: 'cron',
      createdBy: null,
      env: {
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
          private_key: privateKey,
        }),
        BACKUP_SHEET_ID: 'sheet_123',
      },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sheets: [] }) }),
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => 1760000000000,
    });

    console.log('TASK 3.1 RESULT:', JSON.stringify(res));
    assert.equal(res.httpStatus, 200);
    assert.deepEqual(res.body, { busy: true });
  });

  it('Task 3.7: cron deadline verification reserves buffer, clamps pass budget, and stops without false "done"', () => {
    assert.equal(TOTAL_CRON_TIMEOUT_MS, 60000);
    assert.equal(CRON_RESERVED_MS, 8000);
    assert.equal(CRON_MAX_RUNTIME_MS, 52000);
    assert.equal(MIN_PASS_BUDGET_MS, 2000);

    const cronStartMs = 1000000;

    // Simulation 1: 30s elapsed -> remainingMs = 52000 - 30000 = 22000 ms.
    // Clamped pass budget must be TIME_BUDGET_MS (8000 ms).
    const elapsed1 = 30000;
    const remaining1 = CRON_MAX_RUNTIME_MS - elapsed1;
    assert.ok(remaining1 >= MIN_PASS_BUDGET_MS);
    const passBudget1 = Math.min(TIME_BUDGET_MS, remaining1);
    assert.equal(passBudget1, 8000);

    // Simulation 2: 48s elapsed -> remainingMs = 52000 - 48000 = 4000 ms.
    // Clamped pass budget must be exactly 4000 ms, NOT 8000 ms.
    const elapsed2 = 48000;
    const remaining2 = CRON_MAX_RUNTIME_MS - elapsed2;
    assert.ok(remaining2 >= MIN_PASS_BUDGET_MS);
    const passBudget2 = Math.min(TIME_BUDGET_MS, remaining2);
    assert.equal(passBudget2, 4000, 'Pass budget must be clamped to remaining deadline time');

    // Simulation 3: 51s elapsed -> remainingMs = 52000 - 51000 = 1000 ms.
    // Remaining time < MIN_PASS_BUDGET_MS (2000 ms) -> loop must NOT start another pass!
    const elapsed3 = 51000;
    const remaining3 = CRON_MAX_RUNTIME_MS - elapsed3;
    const shouldStop = remaining3 < MIN_PASS_BUDGET_MS;
    assert.equal(shouldStop, true, 'Cron loop must stop before deadline without starting an overrun pass');
  });

  it('calls rpc todo_finalize at the start of every run, records todo_days_finalized: n, and never fails the run if todo_finalize errors', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'backup-bot@trendz-test.iam.gserviceaccount.com',
        private_key: privateKey,
      }),
      BACKUP_SHEET_ID: 'sheet_123',
    };

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: 'ya29.mock', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sheets: [] }),
      };
    };

    let rpcCalls = 0;
    let shouldFailFinalize = false;

    const buildMockSupabase = () => ({
      async rpc(fnName) {
        if (fnName === 'todo_finalize') {
          rpcCalls += 1;
          if (shouldFailFinalize) {
            return { data: null, error: { message: 'todo_finalize temporary db glitch' } };
          }
          return { data: 3, error: null };
        }
        return { data: [], error: null };
      },
      from(table) {
        if (table === 'backup_runs') {
          return {
            update() {
              return {
                eq: () => ({
                  lt: async () => ({ data: [], error: null }),
                }),
              };
            },
            select() {
              return {
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              };
            },
            insert() {
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: 'run-uuid-finalize' },
                    error: null,
                  }),
                }),
              };
            },
          };
        }
        if (table === 'backup_state') {
          return {
            select: async () => ({ data: [], error: null }),
            upsert: async () => ({ data: null, error: null }),
            update: () => ({ eq: async () => ({ data: null, error: null }) }),
          };
        }
        return {
          select() {
            return {
              order() {
                return this;
              },
              range: async () => ({ data: [], error: null }),
            };
          },
        };
      },
    });

    // 1. Success case: returns todo_days_finalized: 3
    let fakeNow1 = 1760000000000;
    const res1 = await executeBackupRunPass({
      supabase: buildMockSupabase(),
      kind: 'cron',
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => {
        const c = fakeNow1;
        fakeNow1 += 3000;
        return c;
      },
    });

    assert.equal(rpcCalls, 1);
    assert.equal(res1.httpStatus, 200);
    assert.equal(res1.body.ok, true);
    assert.equal(res1.body.todo_days_finalized, 3);
    assert.equal(res1.body.tables.todo_days_finalized, 3);

    // 2. Error case: todo_finalize returns error, but backup run still succeeds and records short message
    shouldFailFinalize = true;
    let fakeNow2 = 1760000000000;
    const res2 = await executeBackupRunPass({
      supabase: buildMockSupabase(),
      kind: 'manual',
      createdBy: 'admin-1',
      env,
      fetchImpl: mockFetch,
      retryDelayMs: 1,
      timeBudgetMs: 8000,
      nowFn: () => {
        const c = fakeNow2;
        fakeNow2 += 3000;
        return c;
      },
    });

    assert.equal(rpcCalls, 2);
    assert.equal(res2.httpStatus, 200);
    assert.equal(res2.body.ok, true);
    assert.equal(res2.body.todo_days_finalized, 0);
    assert.equal(res2.body.tables.todo_days_finalized, 0);
    assert.ok(res2.body.tables.todo_finalize_error.includes('todo_finalize temporary db glitch'));
  });

  it('Phase 17c — defines all 7 JMCWC tables in FK restore order, excludes jmcwc_payloads from public/mirror backups, and computes student deletion counts accurately', async () => {
    const expectedJmcwcTables = [
      'jmcwc_papers',
      'jmcwc_categories',
      'jmcwc_targets',
      'jmcwc_assignments',
      'jmcwc_attempts',
      'jmcwc_payloads',
      'jmcwc_scores',
    ];
    assert.deepEqual(
      JMCWC_BACKUP_TABLES.map((t) => t.name),
      expectedJmcwcTables
    );
    assert.equal(PRIVATE_SERVER_BACKUP_TABLES.length, 29);
    assert.equal(RESTORE_TABLE_ORDER.length, 32);

    // Public/Google Sheets BACKUP_TABLES and browser EXPORT_TABLES must never include jmcwc_payloads
    assert.ok(!BACKUP_TABLES.some((t) => t.name === 'jmcwc_payloads'));
    assert.ok(!EXPORT_TABLES.some((t) => t.name === 'jmcwc_payloads'));
    assert.deepEqual(FORBIDDEN_PUBLIC_OR_MIRROR_TABLES, ['jmcwc_payloads']);
    assert.deepEqual(MIRROR_FORBIDDEN_TABLES, ['jmcwc_payloads']);

    const sanitized = sanitizeTablesForPublicBackupOrMirror({
      profiles: [{ id: 's1' }],
      jmcwc_attempts: [{ id: 'a1' }],
      jmcwc_payloads: [{ attempt_id: 'a1', questions: [{ answer_key: '42' }] }],
    });
    assert.equal('jmcwc_payloads' in sanitized, false);
    assert.equal(sanitized.jmcwc_attempts.length, 1);

    assert.throws(
      () => assertMirrorExcludesPayloads({ jmcwc_payloads: [{ attempt_id: 'a1' }] }),
      /Security violation: jmcwc_payloads/
    );
    assert.equal(assertMirrorExcludesPayloads({ student: { id: 's1' }, rounds: [] }), true);

    // Private server backup exports all 7 JMCWC tables in FK restore order
    const mockPrivateSupabase = {
      from(tableName) {
        return {
          select() {
            return {
              order() {
                return this;
              },
              range: async () => ({
                data: [{ table: tableName }],
                error: null,
              }),
            };
          },
        };
      },
    };
    const privRes = await handlePrivateJmcwcBackup({ supabase: mockPrivateSupabase });
    assert.equal(privRes.httpStatus, 200);
    assert.equal(privRes.body.ok, true);
    assert.equal(privRes.body.private_server_only, true);
    assert.deepEqual(privRes.body.restore_order, expectedJmcwcTables);
    assert.equal(Object.keys(privRes.body.tables).length, 7);

    // Student deletion counts include student-owned JMCWC rows and preserve shared tables
    const delSummary = computeStudentDeletionJmcwcCounts('stu-1', {
      jmcwc_assignments: [{ student_id: 'stu-1', group_key: 'junior1' }, { student_id: 'stu-2', group_key: 'senior' }],
      jmcwc_attempts: [
        { id: 'att-1', student_id: 'stu-1' },
        { id: 'att-2', student_id: 'stu-1' },
        { id: 'att-3', student_id: 'stu-2' },
      ],
      jmcwc_payloads: [{ attempt_id: 'att-1' }, { attempt_id: 'att-2' }, { attempt_id: 'att-3' }],
      jmcwc_scores: [{ attempt_id: 'att-1' }, { attempt_id: 'att-3' }],
    });
    assert.deepEqual(delSummary.counts, {
      jmcwc_assignments: 1,
      jmcwc_attempts: 2,
      jmcwc_payloads: 2,
      jmcwc_scores: 1,
    });
    assert.equal(delSummary.total_rows_to_delete, 6);
    assert.deepEqual(delSummary.preserved_shared_tables, [
      'jmcwc_papers',
      'jmcwc_categories',
      'jmcwc_targets',
    ]);
  });

  it('Phase 17c — performs a complete private backup and restore round-trip preserving unfinished attempt jmcwc_payloads, answer_key, and dynamic marking metadata', async () => {
    const paperSpec = {
      sections: [
        {
          key: 'addition',
          questions: [
            {
              slot: 1,
              max_marks: 1,
              generator: 'addition',
              parameters: { scoring_mode: 'fixed', digits: [2, 2] },
            },
          ],
        },
        {
          key: 'multiplication',
          questions: [
            {
              slot: 1,
              max_marks: 3,
              generator: 'multiplication',
              parameters: {
                scoring_mode: 'dynamic',
                mark_rule: 'multiplication_digits_product',
                mark_range: [2, 6],
                digits: [2, 2],
              },
            },
          ],
        },
      ],
    };

    const { privateQuestions } = generateQuestionsFromBlueprint(paperSpec, {
      mode: 'flat',
      seed: 172026,
    });
    assert.equal(privateQuestions.length, 2);
    assert.ok(privateQuestions[0].answer_key, 'Generated question 0 must contain private answer_key');
    assert.ok(privateQuestions[1].answer_key, 'Generated question 1 must contain private answer_key');

    const correctAns0 = String(privateQuestions[0].answer_key.value);
    const unfinishedAnswers = {
      [privateQuestions[0].id]: correctAns0,
      // Question 1 left unanswered in this paused unfinished attempt
    };

    const liveDbState = {
      jmcwc_papers: [
        {
          id: 'paper-j1-uuid',
          group_key: 'junior1',
          version: '2026.1',
          spec: paperSpec,
          published: false,
          created_at: '2026-11-03T10:00:00Z',
        },
      ],
      jmcwc_categories: [
        { key: 'addition', label: 'Addition', position: 1, legacy_category_id: 'leg-add' },
        { key: 'multiplication', label: 'Multiplication', position: 4, legacy_category_id: null },
      ],
      jmcwc_targets: [
        { group_key: 'junior1', category_key: 'addition', target_seconds: 90, updated_at: '2026-11-03T10:00:00Z' },
      ],
      jmcwc_assignments: [
        { student_id: 'stu-restore-1', group_key: 'junior1', updated_at: '2026-11-03T10:00:00Z' },
      ],
      jmcwc_attempts: [
        {
          id: 'att-unfinished-1',
          student_id: 'stu-restore-1',
          request_id: 'req-unfinished-1',
          paper_id: 'paper-j1-uuid',
          group_key: 'junior1',
          mode: 'flat',
          category_key: null,
          target_seconds: null,
          status: 'paused',
          active_ms: 420000,
          lease_id: null,
          save_seq: 4,
          revision: 5,
          answers: unfinishedAnswers,
          created_at: '2026-11-03T10:05:00Z',
          last_seen_at: null,
          finished_at: null,
          submitted_reason: null,
        },
      ],
      jmcwc_payloads: [
        {
          attempt_id: 'att-unfinished-1',
          questions: privateQuestions,
        },
      ],
      jmcwc_scores: [],
    };

    const mockSupabaseForExport = {
      from(tableName) {
        return {
          select() {
            return {
              order() {
                return this;
              },
              range: async () => ({
                data: liveDbState[tableName] ? JSON.parse(JSON.stringify(liveDbState[tableName])) : [],
                error: null,
              }),
            };
          },
        };
      },
    };

    // 1. Export private server backup
    const backupRes = await handlePrivateJmcwcBackup({ supabase: mockSupabaseForExport });
    assert.equal(backupRes.httpStatus, 200);
    assert.equal(backupRes.body.private_server_only, true);
    assert.equal(backupRes.body.tables.jmcwc_payloads.length, 1);
    assert.deepEqual(
      backupRes.body.tables.jmcwc_payloads[0].questions[0].answer_key,
      privateQuestions[0].answer_key
    );

    // 2. Public/Mirror sanitizer strips jmcwc_payloads (so public exports cannot leak answer keys,
    //    and also demonstrating why excluding private payloads from every backup would lose saved papers)
    const publicSanitized = sanitizeTablesForPublicBackupOrMirror(backupRes.body.tables);
    assert.equal('jmcwc_payloads' in publicSanitized, false);
    assert.throws(
      () => restoreJmcwcTablesFromPrivateBackup(publicSanitized),
      /Incomplete JMCWC backup: missing table "jmcwc_payloads"/
    );

    // 3. Restore from the private server backup into a clean store in FK order
    const restored = restoreJmcwcTablesFromPrivateBackup(backupRes.body);
    assert.equal(restored.ok, true);
    assert.deepEqual(restored.restored_order, [
      'jmcwc_papers',
      'jmcwc_categories',
      'jmcwc_targets',
      'jmcwc_assignments',
      'jmcwc_attempts',
      'jmcwc_payloads',
      'jmcwc_scores',
    ]);

    // 4. Verify the restored unfinished attempt can be resumed, answered, and graded accurately
    const restoredAttempt = restored.tables.jmcwc_attempts[0];
    const restoredPayload = restored.tables.jmcwc_payloads[0];
    assert.equal(restoredAttempt.id, 'att-unfinished-1');
    assert.equal(restoredAttempt.status, 'paused');
    assert.equal(restoredAttempt.active_ms, 420000);
    assert.deepEqual(restoredAttempt.answers, unfinishedAnswers);

    // Student resumes after restore and answers question 1 before submitting
    const correctAns1 = String(restoredPayload.questions[1].answer_key.value);
    const completedAnswers = {
      ...restoredAttempt.answers,
      [restoredPayload.questions[1].id]: correctAns1,
    };
    const graded = gradeAttempt(restoredPayload.questions, completedAnswers);
    const expectedMaxMarks =
      restoredPayload.questions[0].max_marks + restoredPayload.questions[1].max_marks;
    assert.equal(graded.marks, expectedMaxMarks);
    assert.equal(graded.max_marks, expectedMaxMarks);
    assert.equal(graded.correct, 2);
    assert.equal(graded.wrong, 0);
    assert.equal(graded.skipped, 0);
  });
});

