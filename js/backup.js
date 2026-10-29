/**
 * Trendz Tracker - Admin Data Backup & Full ZIP Export Controller (js/backup.js)
 *
 * Responsibilities:
 * 1. Admin route guard (`requireAuth(['admin'])`).
 * 2. Fetches & renders backup status (`POST /api/backup` `{ action: 'status' }`):
 *    - Staleness warning when last Google backup is > 2 days old or never run.
 *    - Configuration indicator (`Yes` / `No`) and `Open backup sheet ↗` link.
 *    - Cell usage capacity bar against Google Sheets' 10,000,000-cell limit (warning > 70%).
 *    - Per-table status table (18 tables: 12 snapshot + 6 append) and last 10 `backup_runs`.
 * 3. Runs multi-pass Google Sheet backup (`POST /api/backup` `{ action: 'run' }`):
 *    - Loops up to 300 passes while `status === 'partial'` with live progress bar and Cancel button.
 *    - Halts immediately on `done`, `busy`, user cancel, or error (never auto-retries errors).
 * 4. Runs in-browser "Download all data (ZIP)" export:
 *    - Reads all 18 tables in pages of 1,000 rows ordered by primary key using the admin's session.
 *    - Aborts immediately without downloading if any table read fails.
 *    - Converts each table to RFC 4180 CSV (with formula prefix guard `'`), adds `README.txt`,
 *      builds an uncompressed store-mode ZIP (`trendz-backup-YYYY-MM-DD.zip`), downloads it,
 *      and logs completion via `admin_log_export(p_rows, p_tables)`.
 */

import { logoutUser } from './auth.js';
import {
  EXPORT_TABLES,
  EXPORT_PAGE_SIZE,
  rowsToCsv,
  buildStoreZip,
  buildExportReadme,
} from './backupExport.js';
import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { setupAdminNav, openModal, closeModal, setupModalListeners } from './modal.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { showToast } from './toast.js';

const MAX_BACKUP_PASSES = 300;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

let isRunningSheetBackup = false;
let cancelSheetBackupRequested = false;
let isRunningZipExport = false;

/**
 * Formats an ISO timestamp in Indian Standard Time (`Asia/Kolkata`) with 3-letter month name.
 */
function formatTimestampIST(isoVal) {
  if (!isoVal) return 'Never';
  try {
    const d = new Date(isoVal);
    if (isNaN(d.getTime())) return String(isoVal);
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return String(isoVal);
  }
}

/**
 * Returns current YYYY-MM-DD date string in Indian Standard Time (`Asia/Kolkata`).
 */
function getTodayDateStringIST() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Formats an integer with thousands separators.
 */
function formatNum(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-IN');
}

function showActionAlert(type, message) {
  const alertEl = document.getElementById('backup-action-alert');
  if (!alertEl) return;
  alertEl.style.display = 'block';
  alertEl.textContent = message;

  if (type === 'error') {
    alertEl.style.background = 'var(--color-danger-subtle)';
    alertEl.style.border = '1px solid #fecaca';
    alertEl.style.color = 'var(--color-danger-text)';
  } else if (type === 'warning') {
    alertEl.style.background = 'var(--color-warning-subtle)';
    alertEl.style.border = '1px solid #fde68a';
    alertEl.style.color = 'var(--color-warning-text)';
  } else {
    alertEl.style.background = 'var(--color-accent-subtle)';
    alertEl.style.border = '1px solid #a7f3d0';
    alertEl.style.color = 'var(--color-accent-text)';
  }
}

function hideActionAlert() {
  const alertEl = document.getElementById('backup-action-alert');
  if (alertEl) {
    alertEl.style.display = 'none';
    alertEl.textContent = '';
  }
}

function updateProgressPanel({ visible, title = '', detail = '', percent = 0 }) {
  const panel = document.getElementById('backup-progress-panel');
  const titleEl = document.getElementById('backup-progress-title');
  const detailEl = document.getElementById('backup-progress-detail');
  const barEl = document.getElementById('backup-progress-bar');

  if (!panel) return;
  panel.style.display = visible ? 'block' : 'none';
  if (titleEl) titleEl.textContent = title;
  if (detailEl) detailEl.textContent = detail;
  if (barEl) {
    const clamped = Math.max(2, Math.min(100, Number(percent) || 0));
    barEl.style.width = `${clamped}%`;
  }
}

/**
 * Calls `/api/backup` with the admin's Bearer token.
 */
async function callBackupApi(action) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    if (action === 'status') {
      return DemoDB.getBackupStatus();
    }
    throw new Error(
      'Demo Mode is active: Google Sheet backup requires live Supabase and Google Service Account configuration. Use "Download all data (ZIP)" to test full archive export in Demo Mode.'
    );
  }

  const supabase = await getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Your admin session has expired. Please sign in again.');
  }

  const response = await fetch('/api/backup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ action }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !payload.status) {
    throw new Error(payload.error || `Backup API request failed (HTTP ${response.status}).`);
  }
  return payload;
}

/**
 * Renders the top cards, staleness warning, per-table status, and recent runs.
 */
function renderBackupStatus(statusData) {
  const data = statusData && typeof statusData === 'object' ? statusData : {};

  // 1. Staleness Warning (> 2 days since last successful Google backup, or never run)
  const stalenessBanner = document.getElementById('backup-staleness-banner');
  const stalenessTitle = document.getElementById('backup-staleness-title');
  const stalenessMsg = document.getElementById('backup-staleness-message');

  if (stalenessBanner && stalenessTitle && stalenessMsg) {
    const lastGoogleMs = data.lastSuccessAt ? new Date(data.lastSuccessAt).getTime() : 0;
    const ageMs = lastGoogleMs ? Date.now() - lastGoogleMs : Infinity;

    if (!lastGoogleMs) {
      stalenessBanner.style.display = 'block';
      stalenessTitle.textContent = '⚠️ Google Sheet Backup Has Not Run Yet';
      stalenessMsg.textContent = data.configured
        ? 'No completed Google Sheet backup has been recorded yet. Click "Back up to Google Sheet now" below to run the initial backup.'
        : 'Google Sheet backup is not configured yet (set GOOGLE_SERVICE_ACCOUNT_JSON and BACKUP_SHEET_ID on the server), or download a manual ZIP backup below.';
    } else if (ageMs > TWO_DAYS_MS) {
      const daysAgo = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      stalenessBanner.style.display = 'block';
      stalenessTitle.textContent = `⚠️ Last Google Sheet Backup Was ${daysAgo} Days Ago`;
      stalenessMsg.textContent = `The last completed Google Sheet backup finished on ${formatTimestampIST(data.lastSuccessAt)}. Run a backup now or inspect the recent run history below.`;
    } else {
      stalenessBanner.style.display = 'none';
    }
  }

  // 2. Summary Cards
  const cfgEl = document.getElementById('stat-backup-configured');
  const cfgSubEl = document.getElementById('stat-backup-configured-sub');
  const sheetLinkEl = document.getElementById('link-open-backup-sheet');

  if (cfgEl) {
    cfgEl.textContent = data.configured ? 'Yes' : 'No';
    cfgEl.style.color = data.configured ? 'var(--color-accent-text)' : 'var(--color-warning-text)';
  }
  if (cfgSubEl) {
    cfgSubEl.textContent = data.configured
      ? 'Service account & Sheet ID active'
      : 'Set GOOGLE_SERVICE_ACCOUNT_JSON & BACKUP_SHEET_ID';
  }
  if (sheetLinkEl) {
    if (data.configured && data.sheetUrl) {
      sheetLinkEl.href = data.sheetUrl;
      sheetLinkEl.style.display = 'inline-flex';
    } else {
      sheetLinkEl.style.display = 'none';
    }
  }

  const lastGoogleEl = document.getElementById('stat-last-google-backup');
  if (lastGoogleEl) {
    lastGoogleEl.textContent = formatTimestampIST(data.lastSuccessAt);
  }

  const lastExportEl = document.getElementById('stat-last-zip-export');
  if (lastExportEl) {
    lastExportEl.textContent = formatTimestampIST(data.lastExportAt);
  }

  const totalCells = Number(data.totalCellsWritten) || 0;
  const cellLimit = Number(data.cellLimit) || 10000000;
  const warnRatio = Number(data.cellWarnRatio) || 0.7;
  const ratio = cellLimit > 0 ? totalCells / cellLimit : 0;
  const pctStr = (ratio * 100).toFixed(1);

  const cellsValEl = document.getElementById('stat-cells-written');
  const cellsBarEl = document.getElementById('cells-capacity-bar');
  const cellsSubEl = document.getElementById('stat-cells-sub');

  if (cellsValEl) {
    cellsValEl.textContent = `${formatNum(totalCells)} cells`;
    cellsValEl.style.color = ratio >= warnRatio ? 'var(--color-warning-text)' : 'var(--text-main)';
  }
  if (cellsBarEl) {
    cellsBarEl.style.width = `${Math.min(100, Math.max(totalCells > 0 ? 1 : 0, ratio * 100))}%`;
    cellsBarEl.style.background =
      ratio >= warnRatio ? 'var(--color-warning)' : 'var(--color-primary)';
  }
  if (cellsSubEl) {
    cellsSubEl.textContent =
      ratio >= warnRatio
        ? `⚠️ ${formatNum(totalCells)} of ${formatNum(cellLimit)} (${pctStr}% — above 70% warning threshold)`
        : `${formatNum(totalCells)} of ${formatNum(cellLimit)} cells (${pctStr}%)`;
    cellsSubEl.style.color =
      ratio >= warnRatio ? 'var(--color-warning-text)' : 'var(--text-muted)';
  }

  // 3. Per-Table Status Table
  const tablesTbody = document.getElementById('backup-tables-tbody');
  if (tablesTbody) {
    const tables = Array.isArray(data.tables) ? data.tables : [];
    tablesTbody.innerHTML = '';

    if (tables.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.style.textAlign = 'center';
      td.style.padding = 'var(--space-6)';
      td.style.color = 'var(--text-muted)';
      td.textContent = 'No backup_state rows found.';
      tr.appendChild(td);
      tablesTbody.appendChild(tr);
    } else {
      for (const row of tables) {
        const tr = document.createElement('tr');

        const tdName = document.createElement('td');
        const codeEl = document.createElement('code');
        codeEl.style.fontSize = 'var(--text-xs)';
        codeEl.style.fontWeight = '600';
        codeEl.textContent = row.table_name;
        tdName.appendChild(codeEl);

        const tdMode = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = 'status-badge';
        badge.style.background =
          row.mode === 'append' ? 'var(--color-primary-subtle)' : 'var(--bg-subtle)';
        badge.style.color =
          row.mode === 'append' ? 'var(--color-primary)' : 'var(--text-muted)';
        badge.textContent = row.mode || 'snapshot';
        tdMode.appendChild(badge);

        const tdWaiting = document.createElement('td');
        tdWaiting.className = 'num';
        tdWaiting.style.textAlign = 'right';
        if (row.mode === 'append') {
          const waiting = Number(row.rows_waiting) || 0;
          tdWaiting.textContent = formatNum(waiting);
          if (waiting > 0) {
            tdWaiting.style.fontWeight = '700';
            tdWaiting.style.color = 'var(--color-warning-text)';
          }
        } else {
          tdWaiting.textContent = '—';
          tdWaiting.style.color = 'var(--text-muted)';
        }

        const tdWritten = document.createElement('td');
        tdWritten.className = 'num';
        tdWritten.style.textAlign = 'right';
        tdWritten.textContent = formatNum(row.rows_written || 0);

        const tdCells = document.createElement('td');
        tdCells.className = 'num';
        tdCells.style.textAlign = 'right';
        tdCells.textContent = formatNum(row.cells_written || 0);

        const tdLastRun = document.createElement('td');
        tdLastRun.className = 'num';
        tdLastRun.style.fontSize = 'var(--text-xs)';
        tdLastRun.textContent = row.last_run_at ? formatTimestampIST(row.last_run_at) : 'Never';

        const tdError = document.createElement('td');
        tdError.style.fontSize = 'var(--text-xs)';
        if (row.last_error) {
          tdError.style.color = 'var(--color-danger-text)';
          tdError.style.fontWeight = '600';
          tdError.textContent = row.last_error;
        } else {
          tdError.style.color = 'var(--text-muted)';
          tdError.textContent = '—';
        }

        tr.append(tdName, tdMode, tdWaiting, tdWritten, tdCells, tdLastRun, tdError);
        tablesTbody.appendChild(tr);
      }
    }
  }

  // 4. Recent Backup Runs Table (last 10)
  const runsTbody = document.getElementById('backup-runs-tbody');
  if (runsTbody) {
    const runs = Array.isArray(data.runs) ? data.runs : [];
    runsTbody.innerHTML = '';

    if (runs.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.style.textAlign = 'center';
      td.style.padding = 'var(--space-6)';
      td.style.color = 'var(--text-muted)';
      td.textContent = 'No backup runs recorded yet.';
      tr.appendChild(td);
      runsTbody.appendChild(tr);
    } else {
      for (const run of runs) {
        const tr = document.createElement('tr');

        const tdStarted = document.createElement('td');
        tdStarted.className = 'num';
        tdStarted.style.fontSize = 'var(--text-xs)';
        tdStarted.textContent = run.started_at ? formatTimestampIST(run.started_at) : '—';

        const tdFinished = document.createElement('td');
        tdFinished.className = 'num';
        tdFinished.style.fontSize = 'var(--text-xs)';
        tdFinished.textContent = run.finished_at ? formatTimestampIST(run.finished_at) : '—';

        const tdKind = document.createElement('td');
        tdKind.style.fontSize = 'var(--text-xs)';
        tdKind.style.fontWeight = '600';
        tdKind.textContent = run.kind || '—';

        const tdStatus = document.createElement('td');
        const stBadge = document.createElement('span');
        stBadge.className = 'status-badge';
        const statusStr = String(run.status || '').toLowerCase();
        if (statusStr === 'done') {
          stBadge.style.background = 'var(--color-accent-subtle)';
          stBadge.style.color = 'var(--color-accent-text)';
        } else if (statusStr === 'partial' || statusStr === 'running') {
          stBadge.style.background = 'var(--color-warning-subtle)';
          stBadge.style.color = 'var(--color-warning-text)';
        } else {
          stBadge.style.background = 'var(--color-danger-subtle)';
          stBadge.style.color = 'var(--color-danger-text)';
        }
        stBadge.textContent = run.status || 'unknown';
        tdStatus.appendChild(stBadge);

        const tdRows = document.createElement('td');
        tdRows.className = 'num';
        tdRows.style.textAlign = 'right';
        tdRows.textContent = formatNum(run.rows_written || 0);

        const tdErr = document.createElement('td');
        tdErr.style.fontSize = 'var(--text-xs)';
        const runTables = run.tables && typeof run.tables === 'object' ? run.tables : {};
        const hasTodoFinalized =
          runTables.todo_days_finalized !== undefined ||
          run.todo_days_finalized !== undefined ||
          run.kind === 'cron' ||
          run.kind === 'manual';
        const todoFinalizedVal =
          runTables.todo_days_finalized !== undefined
            ? Number(runTables.todo_days_finalized) || 0
            : run.todo_days_finalized !== undefined
              ? Number(run.todo_days_finalized) || 0
              : 0;
        const todoFinalizeErr = runTables.todo_finalize_error || run.todo_finalize_error || null;
        const todoFinalizedSuffix = hasTodoFinalized
          ? ` · todo_days_finalized: ${todoFinalizedVal}${todoFinalizeErr ? ` (todo_finalize: ${todoFinalizeErr})` : ''}`
          : '';

        if (run.error) {
          tdErr.style.color =
            run.error === 'more to do' ? 'var(--color-warning-text)' : 'var(--color-danger-text)';
          tdErr.textContent = `${run.error}${todoFinalizedSuffix}`;
        } else {
          tdErr.style.color = todoFinalizeErr ? 'var(--color-warning-text)' : 'var(--text-muted)';
          tdErr.textContent = `OK${todoFinalizedSuffix}`;
        }

        tr.append(tdStarted, tdFinished, tdKind, tdStatus, tdRows, tdErr);
        runsTbody.appendChild(tr);
      }
    }
  }

  // 5. Score Sheet Mirror Card (Phase 10d)
  const mirror = data.mirror && typeof data.mirror === 'object' ? data.mirror : {};
  const mirrorCfgEl = document.getElementById('stat-mirror-configured');
  const mirrorCfgSubEl = document.getElementById('stat-mirror-configured-sub');
  const mirrorLinkEl = document.getElementById('link-open-mirror-sheet');
  const mirrorUpEl = document.getElementById('stat-mirror-uptodate');
  const mirrorUpSubEl = document.getElementById('stat-mirror-uptodate-sub');
  const mirrorLastBuiltEl = document.getElementById('stat-mirror-last-built');
  const mirrorErrEl = document.getElementById('stat-mirror-last-error');
  const mirrorErrSubEl = document.getElementById('stat-mirror-error-sub');

  const isMirrorConfigured = Boolean(mirror.configured);
  if (mirrorCfgEl) {
    mirrorCfgEl.textContent = isMirrorConfigured ? 'Yes' : 'No';
    mirrorCfgEl.style.color = isMirrorConfigured
      ? 'var(--color-accent-text)'
      : 'var(--text-muted)';
  }
  if (mirrorCfgSubEl) {
    mirrorCfgSubEl.textContent = isMirrorConfigured
      ? 'MIRROR_SHEET_ID active'
      : 'Set MIRROR_SHEET_ID to enable';
  }
  if (mirrorLinkEl) {
    if (isMirrorConfigured && mirror.sheetUrl) {
      mirrorLinkEl.href = mirror.sheetUrl;
      mirrorLinkEl.style.display = 'inline-flex';
    } else {
      mirrorLinkEl.style.display = 'none';
    }
  }

  const mTotal = Number(mirror.total) || 0;
  const mUpToDate = Number(mirror.upToDate) || 0;
  const mRemaining = Number(mirror.remaining) || 0;

  if (mirrorUpEl) {
    mirrorUpEl.textContent = `${formatNum(mUpToDate)} of ${formatNum(mTotal)}`;
  }
  if (mirrorUpSubEl) {
    mirrorUpSubEl.textContent =
      mRemaining > 0
        ? `${formatNum(mRemaining)} waiting to build`
        : mTotal > 0
          ? 'All active students up to date'
          : 'No active students';
    mirrorUpSubEl.style.color =
      mRemaining > 0 ? 'var(--color-warning-text)' : 'var(--text-muted)';
  }

  if (mirrorLastBuiltEl) {
    mirrorLastBuiltEl.textContent = mirror.lastBuiltAt
      ? formatTimestampIST(mirror.lastBuiltAt)
      : 'Never';
  }

  const errList = Array.isArray(mirror.errors) ? mirror.errors : [];
  const primaryErr = mirror.lastError || (errList[0] && errList[0].error) || null;
  if (mirrorErrEl) {
    if (primaryErr) {
      mirrorErrEl.textContent = String(primaryErr);
      mirrorErrEl.style.color = 'var(--color-danger-text)';
    } else {
      mirrorErrEl.textContent = 'None';
      mirrorErrEl.style.color = 'var(--color-accent-text)';
    }
  }
  if (mirrorErrSubEl) {
    mirrorErrSubEl.textContent =
      errList.length > 0
        ? `${errList.length} student tab${errList.length === 1 ? '' : 's'} reported an error`
        : 'All student tabs healthy';
  }
}

/**
 * Loads and renders current backup status from `/api/backup`.
 */
async function loadBackupStatus() {
  try {
    const statusData = await callBackupApi('status');
    renderBackupStatus(statusData);
    return statusData;
  } catch (err) {
    showActionAlert('error', err.message || 'Failed to load backup status.');
    return null;
  }
}

/**
 * Runs multi-pass Google Sheet backup (`{ action: 'run' }`) up to 300 passes while `status === 'partial'`
 * (or until `mirror.remaining === 0`).
 * Stops immediately on `done`, `busy`, user cancel, or error.
 */
async function handleRunGoogleBackup(options = {}) {
  if (isRunningSheetBackup || isRunningZipExport) return;

  const isMirrorFocus = Boolean(options.mirrorFocus);
  const btnRun = document.getElementById('btn-run-google-backup');
  const btnCancel = document.getElementById('btn-cancel-google-backup');
  const btnZip = document.getElementById('btn-download-zip');
  const btnUpdateMirror = document.getElementById('btn-update-mirror-now');
  const btnRebuildMirror = document.getElementById('btn-rebuild-mirror-all');

  isRunningSheetBackup = true;
  cancelSheetBackupRequested = false;
  hideActionAlert();

  if (btnRun) btnRun.disabled = true;
  if (btnZip) btnZip.disabled = true;
  if (btnUpdateMirror) btnUpdateMirror.disabled = true;
  if (btnRebuildMirror) btnRebuildMirror.disabled = true;
  if (btnCancel) {
    btnCancel.style.display = 'inline-flex';
    btnCancel.disabled = false;
  }

  let totalRowsAcrossPasses = 0;
  let totalMirrorRebuiltAcrossPasses = 0;
  let totalTodoDaysFinalizedAcrossPasses = 0;

  try {
    for (let pass = 1; pass <= MAX_BACKUP_PASSES; pass++) {
      if (cancelSheetBackupRequested) {
        showActionAlert(
          'warning',
          `Backup paused by user before pass ${pass} (${formatNum(totalRowsAcrossPasses)} rows written, ${formatNum(totalMirrorRebuiltAcrossPasses)} score sheets updated, todo_days_finalized: ${totalTodoDaysFinalizedAcrossPasses}).`
        );
        break;
      }

      updateProgressPanel({
        visible: true,
        title: isMirrorFocus
          ? 'Updating Google Sheet backup & score-sheet mirror...'
          : 'Backing up tables to Google Sheet...',
        detail: `Pass ${pass} · ${formatNum(totalRowsAcrossPasses)} rows · ${formatNum(totalMirrorRebuiltAcrossPasses)} score sheets built · todo_days_finalized: ${totalTodoDaysFinalizedAcrossPasses}`,
        percent: Math.min(95, 10 + pass * 12),
      });

      const res = await callBackupApi('run');

      if (res?.busy) {
        showActionAlert(
          'warning',
          'Another backup run is currently in progress. Please wait for it to finish and refresh status.'
        );
        break;
      }

      const passRows = Number(res?.rows_written) || 0;
      const passRebuilt = Number(res?.mirror?.rebuilt) || 0;
      const passTodoFinalized =
        Number(res?.todo_days_finalized ?? res?.tables?.todo_days_finalized ?? 0) || 0;
      totalRowsAcrossPasses += passRows;
      totalMirrorRebuiltAcrossPasses += passRebuilt;
      totalTodoDaysFinalizedAcrossPasses += passTodoFinalized;

      if (!res?.ok || res?.status === 'failed' || (res?.error && res.error !== 'more to do')) {
        const errMsg = res?.error || 'Google Sheet backup stopped due to an error.';
        showActionAlert('error', `Backup failed on pass ${pass}: ${errMsg}`);
        showToast('error', errMsg);
        break;
      }

      const mirrorRemaining = Number(res?.mirror?.remaining) || 0;
      const mirrorLastError = res?.mirror?.lastError || null;
      if (res?.status === 'done' && (mirrorRemaining === 0 || (passRebuilt === 0 && mirrorLastError))) {
        updateProgressPanel({
          visible: true,
          title: mirrorLastError
            ? 'Google Sheet backup finished (mirror reported an error)'
            : 'Google Sheet backup & score-sheet mirror complete!',
          detail: `${formatNum(totalRowsAcrossPasses)} rows written · ${formatNum(totalMirrorRebuiltAcrossPasses)} score sheets built · todo_days_finalized: ${totalTodoDaysFinalizedAcrossPasses} in ${pass} pass${pass === 1 ? '' : 'es'}`,
          percent: 100,
        });
        if (mirrorLastError) {
          showActionAlert(
            'warning',
            `Raw backup completed (${formatNum(totalRowsAcrossPasses)} rows, todo_days_finalized: ${totalTodoDaysFinalizedAcrossPasses}), but the score-sheet mirror reported an error: ${mirrorLastError}`
          );
          showToast('warning', `Mirror error: ${mirrorLastError}`);
        } else {
          const mirrorNote = res?.mirror?.configured
            ? `, ${formatNum(totalMirrorRebuiltAcrossPasses)} student score sheet${totalMirrorRebuiltAcrossPasses === 1 ? '' : 's'} updated`
            : '';
          showActionAlert(
            'success',
            `Google Sheet backup completed (${formatNum(totalRowsAcrossPasses)} rows written${mirrorNote}, todo_days_finalized: ${totalTodoDaysFinalizedAcrossPasses} across ${pass} pass${pass === 1 ? '' : 'es'}).`
          );
          showToast('success', 'Backup & score sheets updated!');
        }
        break;
      }

      // status === 'partial' -> refresh table view and continue next pass if not cancelled
      await loadBackupStatus();

      if (cancelSheetBackupRequested) {
        showActionAlert(
          'warning',
          `Backup stopped after pass ${pass} (${formatNum(totalRowsAcrossPasses)} rows written). You can resume anytime.`
        );
        break;
      }

      if (pass === MAX_BACKUP_PASSES) {
        showActionAlert(
          'warning',
          `Reached maximum of ${MAX_BACKUP_PASSES} passes (${formatNum(totalRowsAcrossPasses)} rows written). Click "Back up to Google Sheet now" to continue.`
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to run Google Sheet backup.';
    showActionAlert('error', msg);
    showToast('error', msg);
  } finally {
    isRunningSheetBackup = false;
    cancelSheetBackupRequested = false;
    if (btnRun) btnRun.disabled = false;
    if (btnZip) btnZip.disabled = false;
    if (btnUpdateMirror) btnUpdateMirror.disabled = false;
    if (btnRebuildMirror) btnRebuildMirror.disabled = false;
    if (btnCancel) btnCancel.style.display = 'none';
    setTimeout(() => {
      if (!isRunningSheetBackup && !isRunningZipExport) {
        updateProgressPanel({ visible: false });
      }
    }, 1500);
    await loadBackupStatus();
  }
}

/**
 * Resets all fingerprints in `mirror_state` to `null` via `POST { action: 'rebuild_mirror' }`
 * and then runs the multi-pass backup loop until `remaining === 0`.
 */
async function handleRebuildAllMirrorTabs() {
  closeModal('modal-rebuild-mirror');
  if (isRunningSheetBackup || isRunningZipExport) return;

  try {
    hideActionAlert();
    await callBackupApi('rebuild_mirror');
    showToast('info', 'All student tabs queued for rebuild. Starting update...');
    await handleRunGoogleBackup({ mirrorFocus: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to trigger mirror rebuild.';
    showActionAlert('error', msg);
    showToast('error', msg);
  }
}

/**
 * Fetches all rows for a single table in pages of 1,000 ordered by its primary key
 * using the admin's authenticated Supabase session.
 * Throws immediately if any query fails so an incomplete ZIP is never created.
 */
async function fetchAllRowsForTableExport(supabase, tableMeta) {
  const fetchWithOrderCols = async (orderCols) => {
    const rows = [];
    let offset = 0;

    while (true) {
      let query = supabase.from(tableMeta.name).select('*');
      for (const col of orderCols) {
        query = query.order(col, { ascending: true });
      }
      query = query.range(offset, offset + EXPORT_PAGE_SIZE - 1);

      const { data, error } = await query;
      if (error) {
        throw error;
      }

      const page = Array.isArray(data) ? data : [];
      rows.push(...page);

      if (page.length < EXPORT_PAGE_SIZE) {
        break;
      }
      offset += EXPORT_PAGE_SIZE;
    }

    return rows;
  };

  try {
    return await fetchWithOrderCols(tableMeta.primaryKey);
  } catch (err) {
    const msg = String(err?.message || '');
    const code = String(err?.code || '');
    if (
      tableMeta.fallbackPrimaryKey &&
      (code === '42703' || msg.includes('does not exist'))
    ) {
      return await fetchWithOrderCols(tableMeta.fallbackPrimaryKey);
    }
    throw new Error(`Failed reading table "${tableMeta.name}": ${msg || 'database error'}`);
  }
}

/**
 * Reads all 18 tables in pages of 1,000, builds RFC 4180 CSVs + README.txt,
 * packages them into `trendz-backup-YYYY-MM-DD.zip`, triggers browser download,
 * and records the export via `admin_log_export`.
 */
async function handleDownloadAllDataZip() {
  if (isRunningZipExport || isRunningSheetBackup) return;

  const btnZip = document.getElementById('btn-download-zip');
  const btnRun = document.getElementById('btn-run-google-backup');

  isRunningZipExport = true;
  hideActionAlert();
  if (btnZip) btnZip.disabled = true;
  if (btnRun) btnRun.disabled = true;

  try {
    const useDemo = !isSupabaseConfigured();
    if (useDemo && !isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }

    const supabase = useDemo ? null : await getSupabase();
    const zipEntries = [];
    const tableRowCounts = {};
    let totalRows = 0;

    for (let i = 0; i < EXPORT_TABLES.length; i++) {
      const tableMeta = EXPORT_TABLES[i];
      const pct = Math.round(((i + 1) / (EXPORT_TABLES.length + 1)) * 100);

      updateProgressPanel({
        visible: true,
        title: `Reading table ${i + 1} of ${EXPORT_TABLES.length}: ${tableMeta.name}...`,
        detail: `${formatNum(totalRows)} rows read`,
        percent: pct,
      });

      const rows = useDemo
        ? DemoDB.getBackupTableRows(tableMeta.name)
        : await fetchAllRowsForTableExport(supabase, tableMeta);

      const csvText = rowsToCsv(rows, tableMeta.defaultColumns || tableMeta.primaryKey);
      zipEntries.push({
        name: `${tableMeta.name}.csv`,
        content: csvText,
      });

      tableRowCounts[tableMeta.name] = rows.length;
      totalRows += rows.length;
    }

    const dateIst = getTodayDateStringIST();
    const readmeText = buildExportReadme({
      dateIst,
      tableSummaries: tableRowCounts,
      totalRows,
    });

    zipEntries.push({
      name: 'README.txt',
      content: readmeText,
    });

    updateProgressPanel({
      visible: true,
      title: 'Packaging ZIP archive...',
      detail: `${EXPORT_TABLES.length} CSV files + README.txt (${formatNum(totalRows)} total rows)`,
      percent: 98,
    });

    const zipBytes = buildStoreZip(zipEntries, new Date());
    const fileName = `trendz-backup-${dateIst}.zip`;

    // Trigger browser download
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    // Log the manual export via RPC admin_log_export
    if (useDemo) {
      DemoDB.logBackupExport(totalRows, tableRowCounts);
    } else {
      const { error: logErr } = await supabase.rpc('admin_log_export', {
        p_rows: totalRows,
        p_tables: tableRowCounts,
      });
      if (logErr) {
        console.warn('admin_log_export RPC warning:', logErr.message);
      }
    }

    updateProgressPanel({
      visible: true,
      title: `Downloaded ${fileName}`,
      detail: `${formatNum(totalRows)} rows across ${EXPORT_TABLES.length} tables`,
      percent: 100,
    });

    showActionAlert(
      'success',
      `Downloaded ${fileName} with ${formatNum(totalRows)} total rows across all ${EXPORT_TABLES.length} tables.`
    );
    showToast('success', `Downloaded ${fileName}`);

    await loadBackupStatus();
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : 'ZIP export aborted because a table could not be read.';
    showActionAlert('error', `Export aborted (no incomplete ZIP was downloaded): ${msg}`);
    showToast('error', msg);
  } finally {
    isRunningZipExport = false;
    if (btnZip) btnZip.disabled = false;
    if (btnRun) btnRun.disabled = false;
    setTimeout(() => {
      if (!isRunningSheetBackup && !isRunningZipExport) {
        updateProgressPanel({ visible: false });
      }
    }, 1800);
  }
}

async function initBackupPage() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  setupAdminNav();
  setupModalListeners();

  // Populate Header User Info
  const userPill = document.getElementById('user-pill-container');
  const userNameEl = document.getElementById('header-user-name');
  if (userPill && userNameEl) {
    userNameEl.textContent = profile.full_name || profile.student_code || 'Admin';
    userPill.style.display = 'flex';
  }

  // Logout button
  const btnLogout = document.getElementById('btn-header-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      await logoutUser();
    });
  }

  // Demo Mode Banner
  const bannerPlaceholder = document.getElementById('config-banner-placeholder');
  if (bannerPlaceholder && isDemoMode()) {
    const banner = document.createElement('div');
    banner.className = 'demo-mode-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'DEMO MODE — data is fake';
    bannerPlaceholder.appendChild(banner);
  }

  // Wire buttons
  const btnRefresh = document.getElementById('btn-refresh-backup-status');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      hideActionAlert();
      loadBackupStatus();
    });
  }

  const btnRun = document.getElementById('btn-run-google-backup');
  if (btnRun) {
    btnRun.addEventListener('click', () => {
      handleRunGoogleBackup();
    });
  }

  const btnUpdateMirror = document.getElementById('btn-update-mirror-now');
  if (btnUpdateMirror) {
    btnUpdateMirror.addEventListener('click', () => {
      handleRunGoogleBackup({ mirrorFocus: true });
    });
  }

  const btnRebuildMirror = document.getElementById('btn-rebuild-mirror-all');
  if (btnRebuildMirror) {
    btnRebuildMirror.addEventListener('click', () => {
      openModal('modal-rebuild-mirror');
    });
  }

  const btnConfirmRebuildMirror = document.getElementById('btn-confirm-rebuild-mirror');
  if (btnConfirmRebuildMirror) {
    btnConfirmRebuildMirror.addEventListener('click', () => {
      handleRebuildAllMirrorTabs();
    });
  }

  const btnCancel = document.getElementById('btn-cancel-google-backup');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (isRunningSheetBackup) {
        cancelSheetBackupRequested = true;
        btnCancel.disabled = true;
      }
    });
  }

  const btnZip = document.getElementById('btn-download-zip');
  if (btnZip) {
    btnZip.addEventListener('click', () => {
      handleDownloadAllDataZip();
    });
  }

  await loadBackupStatus();
}

document.addEventListener('DOMContentLoaded', initBackupPage);

