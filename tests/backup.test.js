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
} from '../api/_backupTables.js';
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
import backupHandler, {
  TIME_BUDGET_MS,
  STALE_LOCK_MS,
  SAFE_HORIZON_MS,
  sanitizeBackupError,
  executeBackupRunPass,
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
  it('defines all 18 tables (12 snapshot + 6 append) in exact order', () => {
    assert.equal(BACKUP_TABLES.length, 18);
    assert.equal(SNAPSHOT_TABLES.length, 12);
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

  it('builds and parses a valid uncompressed Store ZIP archive with 18 CSVs + README.txt', () => {
    const fixedDate = new Date('2026-10-19T12:30:00Z');
    const files = EXPORT_TABLES.map((t, idx) => ({
      name: `${t.name}.csv`,
      content: rowsToCsv([{ id: `row_${idx}`, idx }], t.defaultColumns),
    }));
    const readmeContent = buildExportReadme({
      dateIst: '2026-10-19',
      tableSummaries: Object.fromEntries(EXPORT_TABLES.map((t) => [t.name, 1])),
      totalRows: 18,
    });
    files.push({ name: 'README.txt', content: readmeContent });

    const zipBytes = buildStoreZip(files, fixedDate);
    const parsedEntries = parseStoreZip(zipBytes);

    assert.equal(parsedEntries.length, 19);
    assert.equal(parsedEntries[0].name, 'profiles.csv');
    assert.ok(parsedEntries[0].text.includes('row_0'));
    assert.equal(parsedEntries[18].name, 'README.txt');
    assert.ok(parsedEntries[18].text.includes('TRENDZ TRACKER — FULL DATA BACKUP ARCHIVE'));
    assert.ok(parsedEntries[18].text.includes('2026-10-19'));
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
});
