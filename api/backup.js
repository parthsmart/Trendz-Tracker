/**
 * Trendz Tracker - Nightly & On-Demand Google Sheet Backup Endpoint (/api/backup.js)
 *
 * Supports:
 * 1. GET (Scheduled Vercel Cron run):
 *    - Requires `Authorization: Bearer <CRON_SECRET>` compared in constant time; returns 401 otherwise.
 *    - Executes one backup pass (`kind = 'cron'`).
 *
 * 2. POST (Authenticated Admin action):
 *    - Verified via `verifyAdminCaller(req)`.
 *    - Body `{ action: 'status' }`: returns configuration status, last successful backup/export timestamps,
 *      cell capacity usage against Google's 10M cell limit, per-table `backup_state` + `rows_waiting`,
 *      and the last 10 `backup_runs`.
 *    - Body `{ action: 'run' }`: executes one backup pass (`kind = 'manual'`, `created_by = admin.id`)
 *      with an 8-second time budget.
 *
 * SECURITY INVARIANTS:
 * - Never logs or returns `GOOGLE_SERVICE_ACCOUNT_JSON`, `private_key`, `access_token`, `CRON_SECRET`,
 *   `SUPABASE_SERVICE_ROLE_KEY`, or any student/database row data.
 */

import {
  BACKUP_TABLES,
  SNAPSHOT_TABLES,
  APPEND_TABLES,
  SNAPSHOT_MAX_ROWS,
  PAGE_SIZE,
  SHEETS_UPDATE_CHUNK_ROWS,
  GOOGLE_SHEETS_CELL_LIMIT,
  GOOGLE_SHEETS_WARN_RATIO,
  serializeRowForSheets,
  resolveAppendHeader,
  buildKeysetOrFilter,
  colIndexToLetter,
} from './_backupTables.js';
import {
  getCronSecret,
  getGoogleBackupConfig,
  hasGoogleBackupConfig,
  getGoogleMirrorConfig,
  hasGoogleMirrorConfig,
  hasSupabaseAdminConfig,
} from './_configHelper.js';
import {
  getSpreadsheetTabs,
  addSpreadsheetTab,
  valuesUpdate,
  valuesAppend,
  valuesClear,
  formatSheetRange,
  sanitizeGoogleErrorMessage,
  writeMirrorTab,
} from './_google.js';
import {
  tabNameFor,
  staleStudents,
  buildStudentTabModel,
  buildInfoModel,
} from './_mirror.js';
import { getAdminClient, getCallerClient, verifyAdminCaller } from './_supabaseAdmin.js';
import { verifyCronAuthorizationHeader } from './weekly-report.js';

export const TIME_BUDGET_MS = 8000;
export const STALE_LOCK_MS = 3 * 60 * 1000; // 3 minutes
export const SAFE_HORIZON_MS = 60 * 1000; // 1 minute

/**
 * Extracts Authorization header from Node/Express or Fetch Request.
 */
function readAuthorizationHeader(req) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') {
    return req.headers.get('authorization') || '';
  }
  return req.headers.authorization || req.headers.Authorization || '';
}

/**
 * Scrubs any secret or row data from an error message and truncates to 200 characters.
 */
export function sanitizeBackupError(err, secrets = []) {
  const raw = err instanceof Error ? err.message : String(err || 'Backup error');
  return sanitizeGoogleErrorMessage(raw, secrets).slice(0, 200);
}

/**
 * Checks whether the 8-second time budget has been reached.
 */
function isBudgetExhausted(startMs, budgetMs = TIME_BUDGET_MS, nowFn = Date.now) {
  return nowFn() - startMs >= budgetMs;
}

/**
 * Reads all rows from a snapshot table in pages of 1000 ordered by its primary key.
 * If the primary key column does not exist (e.g. schema variation between `id` and `key`),
 * automatically retries with `fallbackPrimaryKey`.
 * Stops if row count exceeds `SNAPSHOT_MAX_ROWS` (20,000).
 */
async function fetchSnapshotTableRows(supabase, tableConfig, checkBudget) {
  const tryOrderCols = async (orderCols) => {
    const allRows = [];
    let offset = 0;

    while (true) {
      if (checkBudget()) {
        return { budgetExhausted: true, rows: allRows, tooLarge: false };
      }

      let query = supabase.from(tableConfig.name).select('*');
      for (const col of orderCols) {
        query = query.order(col, { ascending: true });
      }
      query = query.range(offset, offset + PAGE_SIZE - 1);

      const { data, error } = await query;
      if (error) {
        throw error;
      }

      const page = Array.isArray(data) ? data : [];
      allRows.push(...page);

      if (allRows.length > SNAPSHOT_MAX_ROWS) {
        return { budgetExhausted: false, rows: allRows, tooLarge: true };
      }

      if (page.length < PAGE_SIZE) {
        break;
      }
      offset += PAGE_SIZE;
    }

    return { budgetExhausted: false, rows: allRows, tooLarge: false };
  };

  try {
    return await tryOrderCols(tableConfig.primaryKey);
  } catch (err) {
    const msg = String(err?.message || '');
    const code = String(err?.code || '');
    if (
      tableConfig.fallbackPrimaryKey &&
      (code === '42703' || msg.includes('does not exist'))
    ) {
      return await tryOrderCols(tableConfig.fallbackPrimaryKey);
    }
    throw new Error(`Failed reading ${tableConfig.name}: ${msg || 'database error'}`);
  }
}

/**
 * Counts how many rows are waiting to be backed up for an append table before the 1-minute safe horizon.
 */
async function countAppendRowsWaiting(supabase, tableConfig, stateRow, horizonIso) {
  try {
    let query = supabase
      .from(tableConfig.name)
      .select('id', { count: 'exact', head: true })
      .lte(tableConfig.cursorColumn, horizonIso);

    if (stateRow?.cursor_value && stateRow?.cursor_id) {
      query = query.or(
        buildKeysetOrFilter(tableConfig.cursorColumn, stateRow.cursor_value, stateRow.cursor_id)
      );
    }

    const { count, error } = await query;
    if (error) return 0;
    return Number(count) || 0;
  } catch {
    return 0;
  }
}

/**
 * Computes the current score-sheet mirror status summary.
 * Safe to call with either the service-role client or an admin caller client.
 */
export async function computeMirrorStatus({ supabase, env = process.env, rebuilt = 0, runErrors = null }) {
  const mirrorConfigured = hasGoogleMirrorConfig(env);
  let mirrorSheetUrl = null;
  if (mirrorConfigured) {
    try {
      const { mirrorSheetId } = getGoogleMirrorConfig(env);
      mirrorSheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(mirrorSheetId)}`;
    } catch {
      mirrorSheetUrl = null;
    }
  }

  let stateRows = [];
  try {
    const { data } = await supabase.from('mirror_state').select('*');
    if (Array.isArray(data)) {
      stateRows = data;
    }
  } catch {
    stateRows = [];
  }

  let fingerprints = null;
  try {
    if (typeof supabase.rpc === 'function') {
      const { data, error } = await supabase.rpc('mirror_fingerprints');
      if (!error && Array.isArray(data)) {
        fingerprints = data;
      }
    }
  } catch {
    fingerprints = null;
  }

  // Fallback when caller client cannot invoke service-role-only mirror_fingerprints()
  if (!fingerprints) {
    try {
      const { data: activeStudents } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'student')
        .eq('active', true);
      if (Array.isArray(activeStudents)) {
        const stateByStudent = new Map(stateRows.map((r) => [String(r.student_id), r]));
        fingerprints = activeStudents.map((s) => {
          const st = stateByStudent.get(String(s.id));
          return {
            student_id: s.id,
            fingerprint: st?.fingerprint || '__unknown__',
          };
        });
      }
    } catch {
      fingerprints = [];
    }
  }

  const fpList = Array.isArray(fingerprints) ? fingerprints : [];
  const staleList = staleStudents(fpList, stateRows);
  const total = fpList.length;
  const remaining = staleList.length;
  const upToDate = Math.max(0, total - remaining);

  let lastBuiltAt = null;
  const stateErrors = [];
  for (const r of stateRows) {
    if (r?.last_built_at) {
      if (!lastBuiltAt || new Date(r.last_built_at).getTime() > new Date(lastBuiltAt).getTime()) {
        lastBuiltAt = r.last_built_at;
      }
    }
    if (r?.last_error) {
      stateErrors.push({
        student_id: r.student_id,
        tab_name: r.tab_name || null,
        error: String(r.last_error),
      });
    }
  }

  const errors = Array.isArray(runErrors) ? runErrors : stateErrors;

  return {
    configured: mirrorConfigured,
    sheetUrl: mirrorSheetUrl,
    total,
    upToDate,
    rebuilt,
    remaining,
    lastBuiltAt,
    lastError: errors.length > 0 ? errors[0].error : null,
    errors,
  };
}

/**
 * Handles `POST { action: 'rebuild_mirror' }` by setting every `fingerprint` in `mirror_state` to `null`.
 */
export async function handleRebuildMirror({ supabase }) {
  const { error } = await supabase
    .from('mirror_state')
    .update({ fingerprint: null, last_error: null })
    .not('student_id', 'is', null);

  if (error) {
    throw new Error(`Failed resetting mirror_state fingerprints: ${error.message}`);
  }

  return {
    ok: true,
    reset: true,
  };
}

/**
 * Handles `POST { action: 'status' }`.
 */
export async function handleBackupStatus({ supabase, env = process.env }) {
  const configured = hasGoogleBackupConfig(env);
  let sheetUrl = null;
  if (configured) {
    try {
      const { sheetId } = getGoogleBackupConfig(env);
      sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}`;
    } catch {
      sheetUrl = null;
    }
  }

  const horizonIso = new Date(Date.now() - SAFE_HORIZON_MS).toISOString();

  const [stateRes, runsRes, lastGoogleRes, lastExportRes, mirror] = await Promise.all([
    supabase.from('backup_state').select('*'),
    supabase
      .from('backup_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    supabase
      .from('backup_runs')
      .select('finished_at, started_at, status, kind')
      .in('kind', ['cron', 'manual'])
      .eq('status', 'done')
      .order('finished_at', { ascending: false })
      .limit(1),
    supabase
      .from('backup_runs')
      .select('finished_at, started_at, status, kind')
      .eq('kind', 'export')
      .eq('status', 'done')
      .order('finished_at', { ascending: false })
      .limit(1),
    computeMirrorStatus({ supabase, env }),
  ]);

  const stateRows = Array.isArray(stateRes?.data) ? stateRes.data : [];
  const stateMap = new Map(stateRows.map((r) => [r.table_name, r]));

  // Compute rows_waiting in parallel for the 6 append tables
  const waitingCounts = new Map();
  await Promise.all(
    APPEND_TABLES.map(async (t) => {
      const st = stateMap.get(t.name);
      const count = await countAppendRowsWaiting(supabase, t, st, horizonIso);
      waitingCounts.set(t.name, count);
    })
  );

  let totalCellsWritten = 0;
  const tables = BACKUP_TABLES.map((t) => {
    const st = stateMap.get(t.name) || {};
    const cells = Number(st.cells_written) || 0;
    const rows = Number(st.rows_written) || 0;
    totalCellsWritten += cells;

    return {
      table_name: t.name,
      mode: st.mode || t.mode,
      cursor_column: st.cursor_column || t.cursorColumn || null,
      cursor_value: st.cursor_value || null,
      cursor_id: st.cursor_id || null,
      rows_waiting: t.mode === 'append' ? waitingCounts.get(t.name) || 0 : 0,
      rows_written: rows,
      cells_written: cells,
      last_run_at: st.last_run_at || null,
      last_error: st.last_error || null,
    };
  });

  const lastGoogleRow = Array.isArray(lastGoogleRes?.data) ? lastGoogleRes.data[0] : null;
  const lastExportRow = Array.isArray(lastExportRes?.data) ? lastExportRes.data[0] : null;

  return {
    ok: true,
    configured,
    sheetUrl,
    lastSuccessAt: lastGoogleRow?.finished_at || lastGoogleRow?.started_at || null,
    lastExportAt: lastExportRow?.finished_at || lastExportRow?.started_at || null,
    totalCellsWritten,
    cellLimit: GOOGLE_SHEETS_CELL_LIMIT,
    cellWarnRatio: GOOGLE_SHEETS_WARN_RATIO,
    tables,
    runs: Array.isArray(runsRes?.data) ? runsRes.data : [],
    mirror,
  };
}

/**
 * Executes a single backup pass with an 8-second time budget.
 *
 * @param {{
 *   supabase: any,
 *   kind: 'cron' | 'manual',
 *   createdBy?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   retryDelayMs?: number,
 *   timeBudgetMs?: number,
 *   nowFn?: () => number
 * }} options
 */
export async function executeBackupRunPass({
  supabase,
  kind,
  createdBy = null,
  env = process.env,
  fetchImpl,
  retryDelayMs,
  timeBudgetMs = TIME_BUDGET_MS,
  nowFn = Date.now,
}) {
  const startMs = nowFn();
  const googleCfg = getGoogleBackupConfig(env);
  const { sheetId, privateKey } = googleCfg;
  const secrets = [privateKey];
  const googleOpts = { env, fetchImpl, retryDelayMs };

  const nowIso = () => new Date(nowFn()).toISOString();
  const staleCutoffIso = new Date(startMs - STALE_LOCK_MS).toISOString();
  const horizonIso = new Date(startMs - SAFE_HORIZON_MS).toISOString();

  // 1. Mark stale 'running' runs (> 3 minutes old) as 'failed' (reason "stale")
  await supabase
    .from('backup_runs')
    .update({
      status: 'failed',
      finished_at: nowIso(),
      error: 'stale',
    })
    .eq('status', 'running')
    .lt('started_at', staleCutoffIso);

  // Check if there was a recent 'partial' run within the last 3 minutes so multi-pass
  // continuations don't re-rewrite snapshot tables that already succeeded seconds ago
  const { data: recentRuns } = await supabase
    .from('backup_runs')
    .select('id, status, finished_at')
    .order('started_at', { ascending: false })
    .limit(1);

  const lastRun = Array.isArray(recentRuns) ? recentRuns[0] : null;
  const isMultiPassContinuation =
    lastRun &&
    lastRun.status === 'partial' &&
    lastRun.finished_at &&
    startMs - new Date(lastRun.finished_at).getTime() < STALE_LOCK_MS;

  // 2. Insert a new 'running' row in backup_runs.
  // If the partial unique index rejects it, return { busy: true } without doing anything.
  const { data: runRow, error: lockError } = await supabase
    .from('backup_runs')
    .insert({
      kind,
      status: 'running',
      started_at: nowIso(),
      rows_written: 0,
      tables: {},
      error: null,
      created_by: kind === 'manual' ? createdBy || null : null,
    })
    .select('id')
    .single();

  if (lockError) {
    const errCode = String(lockError.code || '');
    const errMsg = String(lockError.message || '').toLowerCase();
    if (errCode === '23505' || errMsg.includes('unique') || errMsg.includes('duplicate')) {
      return { httpStatus: 200, body: { busy: true } };
    }
    throw new Error(sanitizeBackupError(`Failed to acquire backup lock: ${lockError.message}`, secrets));
  }

  const runId = runRow.id;
  let totalRowsWrittenThisRun = 0;
  const tablesSummary = {};
  let stoppedForBudget = false;
  let anyTableHasMoreRows = false;
  let activeTableName = null;
  let todoDaysFinalized = 0;
  let todoFinalizeError = null;

  // Step 0 (Phase 12a): Finalize finished daily to-do days via service-role RPC `todo_finalize`.
  // Must run once at the start of every run (cron and manual) and must NEVER fail the backup run.
  if (typeof supabase.rpc === 'function') {
    try {
      const { data: finalizeData, error: finalizeErr } = await supabase.rpc('todo_finalize');
      if (finalizeErr) {
        todoFinalizeError = sanitizeBackupError(finalizeErr.message || finalizeErr, secrets).slice(0, 120);
      } else if (typeof finalizeData === 'number' && Number.isFinite(finalizeData)) {
        todoDaysFinalized = Math.max(0, Math.floor(finalizeData));
      } else if (Array.isArray(finalizeData) && finalizeData.length > 0) {
        const first = finalizeData[0];
        if (typeof first === 'number' && Number.isFinite(first)) {
          todoDaysFinalized = Math.max(0, Math.floor(first));
        } else if (first && typeof first === 'object') {
          const v = Number(first.todo_days_finalized ?? first.days_finalized ?? first.count ?? 0);
          todoDaysFinalized = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        }
      } else if (finalizeData && typeof finalizeData === 'object') {
        const v = Number(finalizeData.todo_days_finalized ?? finalizeData.days_finalized ?? finalizeData.count ?? 0);
        todoDaysFinalized = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      } else {
        const v = Number(finalizeData);
        todoDaysFinalized = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      }
    } catch (finalizeEx) {
      todoFinalizeError = sanitizeBackupError(finalizeEx, secrets).slice(0, 120);
    }
  }

  tablesSummary.todo_days_finalized = todoDaysFinalized;
  if (todoFinalizeError) {
    tablesSummary.todo_finalize_error = todoFinalizeError;
  }

  let mirrorSummary = {
    configured: hasGoogleMirrorConfig(env),
    sheetUrl: null,
    total: 0,
    upToDate: 0,
    rebuilt: 0,
    remaining: 0,
    lastBuiltAt: null,
    lastError: null,
    errors: [],
  };

  const checkBudget = () => {
    if (isBudgetExhausted(startMs, timeBudgetMs, nowFn)) {
      stoppedForBudget = true;
      return true;
    }
    return false;
  };

  try {
    // Load existing backup_state for all tables
    const { data: stateRows, error: stateErr } = await supabase.from('backup_state').select('*');
    if (stateErr) {
      throw new Error(`Failed reading backup_state: ${stateErr.message}`);
    }
    const stateMap = new Map((stateRows || []).map((r) => [r.table_name, r]));

    // Load current spreadsheet tabs once
    const existingTabs = await getSpreadsheetTabs(sheetId, googleOpts);
    const tabMap = new Map(existingTabs.map((t) => [t.title, t]));

    const ensureTabExists = async (tabName, numCols) => {
      if (!tabMap.has(tabName)) {
        const created = await addSpreadsheetTab(sheetId, tabName, numCols, googleOpts);
        tabMap.set(tabName, created);
      }
      return tabMap.get(tabName);
    };

    // =========================================================================
    // PHASE A: SNAPSHOT TABLES (12 tables in exact order)
    // =========================================================================
    for (const tableConfig of SNAPSHOT_TABLES) {
      activeTableName = tableConfig.name;
      const st = stateMap.get(tableConfig.name) || {};

      // If continuing an interrupted multi-pass run and this snapshot table already
      // succeeded within the last 90 seconds, skip re-rewriting it so the budget advances
      if (
        isMultiPassContinuation &&
        st.last_run_at &&
        !st.last_error &&
        startMs - new Date(st.last_run_at).getTime() < 90 * 1000
      ) {
        tablesSummary[tableConfig.name] = {
          mode: 'snapshot',
          rows: Number(st.rows_written) || 0,
          status: 'cached_in_pass',
        };
        continue;
      }

      if (checkBudget()) {
        break;
      }

      const snapResult = await fetchSnapshotTableRows(supabase, tableConfig, checkBudget);
      if (snapResult.budgetExhausted) {
        break;
      }

      // Skip with a clear warning if > 20,000 rows
      if (snapResult.tooLarge) {
        const warnMsg = `Warning: ${tableConfig.name} has more than ${SNAPSHOT_MAX_ROWS} rows; skipped snapshot.`;
        await supabase.from('backup_state').upsert({
          table_name: tableConfig.name,
          mode: 'snapshot',
          last_run_at: nowIso(),
          last_error: warnMsg,
        });
        tablesSummary[tableConfig.name] = {
          mode: 'snapshot',
          rows: 0,
          skipped: true,
          warning: warnMsg,
        };
        continue;
      }

      const rows = snapResult.rows;
      let header = [];
      if (rows.length > 0) {
        const keySet = new Set();
        for (const r of rows) {
          Object.keys(r || {}).forEach((k) => keySet.add(k));
        }
        header = Array.from(keySet);
      } else if (Array.isArray(st.header) && st.header.length > 0) {
        header = [...st.header];
      } else {
        header = [...tableConfig.primaryKey];
      }

      const tabInfo = await ensureTabExists(tableConfig.name, header.length);

      // Write header at A1
      await valuesUpdate(sheetId, formatSheetRange(tableConfig.name, 'A1'), [header], googleOpts);

      // Write data starting at A2 in chunks of at most 5,000 rows
      if (rows.length > 0) {
        const serialized = rows.map((r) => serializeRowForSheets(r, header));
        for (let i = 0; i < serialized.length; i += SHEETS_UPDATE_CHUNK_ROWS) {
          const chunk = serialized.slice(i, i + SHEETS_UPDATE_CHUNK_ROWS);
          const startRowNumber = 2 + i;
          await valuesUpdate(
            sheetId,
            formatSheetRange(tableConfig.name, `A${startRowNumber}`),
            chunk,
            googleOpts
          );
        }
      }

      // Clear any leftover rows below the new data so the tab is valid at every moment
      const prevRowsWritten = Number(st.rows_written) || 0;
      const clearStartRow = rows.length + 2; // Row 1 is header, rows 2..(rows.length+1) are data
      const maxRowToClear = Math.max(prevRowsWritten + 2, Number(tabInfo?.rowCount) || 1000);
      if (rows.length === 0 || prevRowsWritten > rows.length) {
        const lastColLetter = colIndexToLetter(Math.max(header.length + 2, 25));
        const clearEndRow = Math.max(clearStartRow, maxRowToClear);
        await valuesClear(
          sheetId,
          formatSheetRange(tableConfig.name, `A${clearStartRow}:${lastColLetter}${clearEndRow}`),
          googleOpts
        );
      }

      const cellsWritten = (rows.length + 1) * header.length;
      const runAt = nowIso();

      await supabase.from('backup_state').upsert({
        table_name: tableConfig.name,
        mode: 'snapshot',
        rows_written: rows.length,
        cells_written: cellsWritten,
        header,
        last_run_at: runAt,
        last_error: null,
      });

      totalRowsWrittenThisRun += rows.length;
      tablesSummary[tableConfig.name] = {
        mode: 'snapshot',
        rows: rows.length,
        cells: cellsWritten,
      };
    }

    // =========================================================================
    // PHASE B: APPEND TABLES (6 tables in exact order, keyset paging + 1m horizon)
    // =========================================================================
    if (!stoppedForBudget) {
      for (const tableConfig of APPEND_TABLES) {
        activeTableName = tableConfig.name;
        const st = stateMap.get(tableConfig.name) || {};
        let cursorValue = st.cursor_value ? String(st.cursor_value) : null;
        let cursorId = st.cursor_id ? String(st.cursor_id) : null;
        let cumulativeRows = Number(st.rows_written) || 0;
        let cumulativeCells = Number(st.cells_written) || 0;
        let currentHeader = Array.isArray(st.header) ? [...st.header] : [];
        let rowsAppendedForTable = 0;

        while (true) {
          if (checkBudget()) {
            break;
          }

          let query = supabase
            .from(tableConfig.name)
            .select('*')
            .lte(tableConfig.cursorColumn, horizonIso)
            .order(tableConfig.cursorColumn, { ascending: true })
            .order('id', { ascending: true })
            .limit(PAGE_SIZE);

          if (cursorValue && cursorId) {
            query = query.or(
              buildKeysetOrFilter(tableConfig.cursorColumn, cursorValue, cursorId)
            );
          }

          const { data: pageData, error: pageError } = await query;
          if (pageError) {
            throw new Error(`Failed reading ${tableConfig.name}: ${pageError.message}`);
          }

          const pageRows = Array.isArray(pageData) ? pageData : [];
          if (pageRows.length === 0) {
            // Caught up up to safe horizon
            break;
          }

          const { header: mergedHeader, changed: headerChanged } = resolveAppendHeader(
            currentHeader,
            pageRows
          );
          const isNewTab = !tabMap.has(tableConfig.name);
          currentHeader = mergedHeader;

          await ensureTabExists(tableConfig.name, currentHeader.length);

          // Ensure row 1 has the latest header whenever the tab is new or new columns appeared
          if (isNewTab || headerChanged) {
            await valuesUpdate(
              sheetId,
              formatSheetRange(tableConfig.name, 'A1'),
              [currentHeader],
              googleOpts
            );
          }

          const backedUpAt = nowIso();
          const serializedPage = pageRows.map((r) =>
            serializeRowForSheets(r, currentHeader, backedUpAt)
          );

          await valuesAppend(
            sheetId,
            formatSheetRange(tableConfig.name, 'A1'),
            serializedPage,
            googleOpts
          );

          // Immediately advance cursor to the last row of this page, keeping exact timestamp string
          const lastRow = pageRows[pageRows.length - 1];
          const newCursorValue = String(lastRow[tableConfig.cursorColumn] ?? '');
          const newCursorId = String(lastRow.id ?? '');

          cursorValue = newCursorValue;
          cursorId = newCursorId;
          rowsAppendedForTable += pageRows.length;
          cumulativeRows += pageRows.length;
          cumulativeCells += pageRows.length * currentHeader.length;
          totalRowsWrittenThisRun += pageRows.length;

          await supabase.from('backup_state').upsert({
            table_name: tableConfig.name,
            mode: 'append',
            cursor_column: tableConfig.cursorColumn,
            cursor_value: cursorValue,
            cursor_id: cursorId,
            rows_written: cumulativeRows,
            cells_written: cumulativeCells,
            header: currentHeader,
            last_run_at: backedUpAt,
            last_error: null,
          });

          if (pageRows.length < PAGE_SIZE) {
            // Fewer than 1000 rows returned -> caught up for this table!
            break;
          }
        }

        tablesSummary[tableConfig.name] = {
          mode: 'append',
          rows_appended: rowsAppendedForTable,
          total_rows: cumulativeRows,
        };

        if (stoppedForBudget) {
          break;
        }
      }
    }

    activeTableName = null;

    // =========================================================================
    // PHASE C: READABLE SCORE-SHEET MIRROR (when MIRROR_SHEET_ID is set)
    // =========================================================================
    if (hasGoogleMirrorConfig(env)) {
      const mirrorCfg = getGoogleMirrorConfig(env);
      const mirrorSheetId = mirrorCfg.mirrorSheetId || mirrorCfg.sheetId;
      const mirrorSheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(mirrorSheetId)}`;

      if (!stoppedForBudget && typeof supabase.rpc === 'function') {
        try {
          const [{ data: fpRows, error: fpErr }, { data: mStateRows, error: msErr }] =
            await Promise.all([
              supabase.rpc('mirror_fingerprints'),
              supabase.from('mirror_state').select('*'),
            ]);

          if (fpErr) {
            throw new Error(`Failed reading mirror_fingerprints: ${fpErr.message}`);
          }
          if (msErr) {
            throw new Error(`Failed reading mirror_state: ${msErr.message}`);
          }

          const fingerprints = Array.isArray(fpRows) ? fpRows : [];
          const mirrorStateList = Array.isArray(mStateRows) ? [...mStateRows] : [];
          const fpByStudent = new Map(
            fingerprints.map((r) => [String(r.student_id), String(r.fingerprint ?? '')])
          );
          const stateByStudent = new Map(
            mirrorStateList.map((r) => [String(r.student_id), { ...r }])
          );

          const staleIds = staleStudents(fingerprints, mirrorStateList);
          let rebuiltCount = 0;
          const mirrorErrors = [];

          if (staleIds.length > 0 && !checkBudget()) {
            const existingMirrorTabs = await getSpreadsheetTabs(mirrorSheetId, googleOpts);
            const hasInfoTab = existingMirrorTabs.some(
              (t) => String(t.title || '').toUpperCase() === 'INFO'
            );

            for (const studentId of staleIds) {
              if (checkBudget()) {
                anyTableHasMoreRows = true;
                break;
              }

              const existingState = stateByStudent.get(studentId) || {};
              const targetFp = fpByStudent.get(studentId) || '';

              try {
                const { data: studentData, error: sdErr } = await supabase.rpc(
                  'mirror_student_data',
                  { p_student: studentId }
                );
                if (sdErr) {
                  throw new Error(sdErr.message || 'mirror_student_data failed');
                }

                const model = buildStudentTabModel(studentData || {});

                // Seed usedNames with tab names already assigned to OTHER students
                const usedNames = new Set();
                for (const [otherId, stRow] of stateByStudent.entries()) {
                  if (otherId !== studentId && stRow?.tab_name) {
                    usedNames.add(String(stRow.tab_name));
                  }
                }

                const chosenTabName = tabNameFor(studentData?.student || {}, usedNames);
                const written = await writeMirrorTab(
                  mirrorSheetId,
                  {
                    tabName: chosenTabName,
                    storedSheetId: existingState.sheet_id,
                    model,
                  },
                  existingMirrorTabs,
                  googleOpts
                );

                const builtAt = nowIso();
                const updatedRow = {
                  student_id: studentId,
                  fingerprint: targetFp,
                  sheet_id: written.sheetId,
                  tab_name: written.tabName,
                  last_built_at: builtAt,
                  last_error: null,
                };

                await supabase.from('mirror_state').upsert(updatedRow);
                stateByStudent.set(studentId, updatedRow);
                rebuiltCount += 1;
              } catch (studentErr) {
                const safeStudentErr = sanitizeBackupError(studentErr, secrets);
                const errRow = {
                  student_id: studentId,
                  fingerprint: existingState.fingerprint ?? null,
                  sheet_id: existingState.sheet_id ?? null,
                  tab_name: existingState.tab_name ?? null,
                  last_built_at: existingState.last_built_at ?? null,
                  last_error: safeStudentErr,
                };
                await supabase.from('mirror_state').upsert(errRow);
                stateByStudent.set(studentId, errRow);
                mirrorErrors.push({
                  student_id: studentId,
                  tab_name: existingState.tab_name || null,
                  error: safeStudentErr,
                });
              }
            }

            // Keep a first tab named INFO listing when the sheet was last updated and the read-only warning
            if (rebuiltCount > 0 || !hasInfoTab) {
              try {
                const infoStudents = [];
                for (const [sId, stRow] of stateByStudent.entries()) {
                  if (stRow?.tab_name) {
                    infoStudents.push({
                      student_id: sId,
                      name: stRow.tab_name.replace(/\s*\([^)]*\)\s*(\d+)?$/, ''),
                      code: '',
                      level: '',
                      tab_name: stRow.tab_name,
                      last_built_at: stRow.last_built_at || '',
                    });
                  }
                }
                const infoModel = buildInfoModel(infoStudents, nowIso());
                await writeMirrorTab(
                  mirrorSheetId,
                  {
                    tabName: 'INFO',
                    sheetIndex: 0,
                    model: infoModel,
                  },
                  existingMirrorTabs,
                  googleOpts
                );
              } catch {
                // Non-fatal if INFO tab update encounters a transient error
              }
            }
          }

          const updatedStateList = Array.from(stateByStudent.values());
          const remainingStale = staleStudents(fingerprints, updatedStateList);
          let latestBuilt = null;
          for (const r of updatedStateList) {
            if (r?.last_built_at) {
              if (!latestBuilt || new Date(r.last_built_at).getTime() > new Date(latestBuilt).getTime()) {
                latestBuilt = r.last_built_at;
              }
            }
          }

          mirrorSummary = {
            configured: true,
            sheetUrl: mirrorSheetUrl,
            total: fingerprints.length,
            upToDate: Math.max(0, fingerprints.length - remainingStale.length),
            rebuilt: rebuiltCount,
            remaining: remainingStale.length,
            lastBuiltAt: latestBuilt,
            lastError: mirrorErrors.length > 0 ? mirrorErrors[0].error : null,
            errors: mirrorErrors,
          };
          tablesSummary._mirror = {
            rebuilt: rebuiltCount,
            remaining: remainingStale.length,
            errors: mirrorErrors.length,
          };
        } catch (mirrorPhaseErr) {
          const safeMirrorErr = sanitizeBackupError(mirrorPhaseErr, secrets);
          const fallbackMirror = await computeMirrorStatus({ supabase, env });
          mirrorSummary = {
            ...fallbackMirror,
            configured: true,
            sheetUrl: mirrorSheetUrl,
            lastError: safeMirrorErr,
            errors: [{ student_id: null, tab_name: 'MIRROR_SHEET', error: safeMirrorErr }],
          };
          tablesSummary._mirror = {
            rebuilt: 0,
            remaining: fallbackMirror.remaining,
            errors: 1,
            error: safeMirrorErr,
          };
        }
      } else {
        mirrorSummary = await computeMirrorStatus({ supabase, env });
        if (mirrorSummary.remaining > 0) {
          anyTableHasMoreRows = true;
        }
      }
    }

    // Determine final status: 'done' if every table and mirror tab is caught up, else 'partial'
    const finalStatus = stoppedForBudget || anyTableHasMoreRows ? 'partial' : 'done';
    const finalError = finalStatus === 'partial' ? 'more to do' : null;
    const finishedAt = nowIso();

    await supabase
      .from('backup_runs')
      .update({
        status: finalStatus,
        finished_at: finishedAt,
        rows_written: totalRowsWrittenThisRun,
        tables: tablesSummary,
        error: finalError,
      })
      .eq('id', runId);

    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: finalStatus,
        rows_written: totalRowsWrittenThisRun,
        todo_days_finalized: todoDaysFinalized,
        ...(todoFinalizeError ? { todo_finalize_error: todoFinalizeError } : {}),
        tables: tablesSummary,
        mirror: mirrorSummary,
        error: finalError,
      },
    };
  } catch (err) {
    const safeErr = sanitizeBackupError(err, secrets);
    const finishedAt = nowIso();
    const failStatus = totalRowsWrittenThisRun > 0 ? 'partial' : 'failed';

    if (activeTableName) {
      await supabase
        .from('backup_state')
        .update({
          last_error: safeErr,
          last_run_at: finishedAt,
        })
        .eq('table_name', activeTableName);
    }

    await supabase
      .from('backup_runs')
      .update({
        status: failStatus,
        finished_at: finishedAt,
        rows_written: totalRowsWrittenThisRun,
        tables: tablesSummary,
        error: safeErr,
      })
      .eq('id', runId);

    return {
      httpStatus: 500,
      body: {
        ok: false,
        status: failStatus,
        rows_written: totalRowsWrittenThisRun,
        todo_days_finalized: todoDaysFinalized,
        ...(todoFinalizeError ? { todo_finalize_error: todoFinalizeError } : {}),
        tables: tablesSummary,
        mirror: mirrorSummary,
        error: safeErr,
      },
    };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // =========================================================================
  // 1. GET = Scheduled Cron Run
  // =========================================================================
  if (req.method === 'GET') {
    let cronSecret = '';
    try {
      cronSecret = getCronSecret();
    } catch (cfgErr) {
      return res.status(500).json({ ok: false, status: 'failed', error: cfgErr.message });
    }

    const authHeader = readAuthorizationHeader(req);
    if (!verifyCronAuthorizationHeader(authHeader, cronSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const supabase = getAdminClient();
      const result = await executeBackupRunPass({
        supabase,
        kind: 'cron',
        createdBy: null,
      });
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      const safeErr = sanitizeBackupError(err, [cronSecret]);
      return res.status(500).json({ ok: false, status: 'failed', error: safeErr });
    }
  }

  // =========================================================================
  // 2. POST = Admin Action ({ action: 'status' | 'run' | 'rebuild_mirror' })
  // =========================================================================
  if (req.method === 'POST') {
    let adminProfile;
    try {
      adminProfile = await verifyAdminCaller(req);
    } catch (authErr) {
      const msg = authErr.message || 'Unauthorized';
      const status = msg.startsWith('Forbidden') ? 403 : 401;
      return res.status(status).json({ error: msg });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = body.action;

    if (action !== 'status' && action !== 'run' && action !== 'rebuild_mirror') {
      return res.status(400).json({
        error:
          'Request body must specify { "action": "status" }, { "action": "run" }, or { "action": "rebuild_mirror" }.',
      });
    }

    try {
      const hasAdminKey = hasSupabaseAdminConfig();
      const supabase = hasAdminKey
        ? getAdminClient()
        : getCallerClient(adminProfile.accessToken);

      if (action === 'status') {
        const statusPayload = await handleBackupStatus({ supabase });
        return res.status(200).json(statusPayload);
      }

      if (action === 'rebuild_mirror') {
        const adminSupabase = getAdminClient();
        const rebuildPayload = await handleRebuildMirror({ supabase: adminSupabase });
        return res.status(200).json(rebuildPayload);
      }

      // action === 'run' requires service role and Google config
      const adminSupabase = getAdminClient();
      const result = await executeBackupRunPass({
        supabase: adminSupabase,
        kind: 'manual',
        createdBy: adminProfile.id,
      });
      return res.status(result.httpStatus).json(result.body);
    } catch (err) {
      const safeErr = sanitizeBackupError(err);
      return res.status(500).json({ ok: false, status: 'failed', error: safeErr });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

