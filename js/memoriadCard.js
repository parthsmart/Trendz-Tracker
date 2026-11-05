/**
 * Trendz Tracker — Shared Memoriad Dashboard Card Module (js/memoriadCard.js)
 *
 * Renders the "Memoriad Competition Practice" summary card for a given `studentId`:
 * - Tries this week (last 7 days in Indian Standard Time)
 * - Best score per available module (`Mental Calendar Dates`, `Mental Additions`)
 * - Link to `/pages/memoriad.html` for students (omitted when `isReadOnly === true` for admins)
 *
 * Used on both `/pages/student.html` (student dashboard) and
 * `/pages/student-detail.html` (admin read-only student detail view).
 */

import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { summarizeAllMemoriad, toIstDateString } from './memoriadStats.js';
import { getScoreFeedback } from './scoreColors.js';
import { getWeekBoundsIST } from './periods.js';
import { fetchAllRowsBatched } from './historyFilters.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function mergeSessionPreviewMemoriadRows(studentId, dbRows = []) {
  const base = Array.isArray(dbRows) ? [...dbRows] : [];
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return base;
    const raw = window.sessionStorage.getItem('tt_preview_memoriad_results');
    if (!raw) return base;
    const cached = JSON.parse(raw);
    if (!Array.isArray(cached)) return base;
    const seenIds = new Set(base.map((r) => r && r.id).filter(Boolean));
    for (const item of cached) {
      if (
        item &&
        item.student_id === studentId &&
        item.activity_type === 'memoriad' &&
        (!item.id || !seenIds.has(item.id))
      ) {
        if (item.id) seenIds.add(item.id);
        base.push(item);
      }
    }
    base.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    // Ignore sessionStorage errors
  }
  return base;
}

/**
 * Fetches a student's `activity_results` rows with `activity_type = 'memoriad'`.
 *
 * @param {string} studentId
 * @returns {Promise<Array<object>>}
 */
export async function fetchStudentMemoriadResults(studentId) {
  if (!studentId) return [];

  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        const rows = await fetchAllRowsBatched(async (from, to) => {
          const { data, error } = await supabase
            .from('activity_results')
            .select(
              'id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at'
            )
            .eq('student_id', studentId)
            .eq('activity_type', 'memoriad')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);
          if (error) throw error;
          return data || [];
        }, { batchSize: 1000 });

        if (Array.isArray(rows) && rows.length > 0) {
          return mergeSessionPreviewMemoriadRows(studentId, rows);
        }
      }
    } catch {
      // Fall through to DemoDB when in demo mode
    }
  }

  return mergeSessionPreviewMemoriadRows(
    studentId,
    DemoDB ? DemoDB.getActivityResults(studentId, 'memoriad') : []
  );
}

function renderModuleBestRow(label, summary, isCalendar = false) {
  const best = summary?.best;
  if (!best) {
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding: 6px 0; border-bottom: 1px solid var(--border-hairline);">
        <span style="font-size: var(--text-xs); font-weight: 600; color: var(--text-main);">${escapeHtml(label)}</span>
        <span style="font-size: var(--text-xs); color: var(--text-dim);">No tries yet</span>
      </div>
    `;
  }

  const feedback = getScoreFeedback(best.correct, best.attempted);
  const datesSuffix = isCalendar && best.dates ? ` (${best.dates}d)` : '';
  const timeStr = `${Number(best.used_seconds).toFixed(2)}s`;
  const pct = best.attempted > 0 ? Math.round((best.correct / best.attempted) * 100) : 0;
  const mainScoreText = `Score ${best.score} (${best.correct}/${best.attempted}, ${pct}%)`;

  return `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding: 6px 0; border-bottom: 1px solid var(--border-hairline); flex-wrap: wrap;">
      <span style="font-size: var(--text-xs); font-weight: 600; color: var(--text-main);">${escapeHtml(label)}${escapeHtml(datesSuffix)}</span>
      <div class="num" style="display: flex; align-items: center; gap: 6px;">
        <strong style="font-size: var(--text-xs); color: ${feedback.colorVar};">${escapeHtml(mainScoreText)}</strong>
        <span class="score-tag ${feedback.badgeClass}" style="font-size: 10px;">${escapeHtml(feedback.wrongText)}</span>
        <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(timeStr)}</span>
      </div>
    </div>
  `;
}

/**
 * Renders the Memoriad summary card for `studentId`.
 * Can be called as `renderMemoriadCard(studentId, options)` or `renderMemoriadCard({ studentId, ...options })`.
 *
 * @param {string|object} studentIdOrOpts
 * @param {object} [opts]
 * @param {string} [opts.containerId='memoriad-week-container']
 * @param {boolean} [opts.isReadOnly=false]
 * @param {string|Date} [opts.todayIST]
 * @param {Array<object>|null} [opts.preloadedResults=null]
 */
export async function renderMemoriadCard(studentIdOrOpts, opts = {}) {
  const config =
    typeof studentIdOrOpts === 'object' && studentIdOrOpts !== null
      ? studentIdOrOpts
      : { studentId: studentIdOrOpts, ...opts };

  const {
    studentId,
    containerId = 'memoriad-week-container',
    isReadOnly = false,
    todayIST,
    preloadedResults = null,
  } = config;

  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = Array.isArray(preloadedResults)
    ? mergeSessionPreviewMemoriadRows(
        studentId,
        preloadedResults.filter((r) => r && r.activity_type === 'memoriad')
      )
    : await fetchStudentMemoriadResults(studentId);

  const weekBounds = getWeekBoundsIST(todayIST || new Date());
  const summary = summarizeAllMemoriad(rows, todayIST || new Date());

  // Strictly compute Monday-to-Sunday IST week tries and correct answers
  let weekTries = 0;
  let weekCorrect = 0;
  let weekAttempted = 0;
  rows.forEach((r) => {
    if (!r) return;
    const dStr = toIstDateString(r.created_at || r.entry_date);
    if (dStr >= weekBounds.startYmd && dStr <= weekBounds.endYmd) {
      weekTries += 1;
      weekCorrect += Math.max(0, Number(r?.settings?.correct ?? r?.correct) || 0);
      weekAttempted += Math.max(0, Number(r?.settings?.attempted ?? r?.total) || 0);
    }
  });

  const thisWeekText =
    weekTries === 0
      ? 'No tries this week'
      : `This week: ${weekTries} ${weekTries === 1 ? 'try' : 'tries'}, ${weekCorrect} correct (of ${weekAttempted})`;

  const linkHtml = isReadOnly
    ? ''
    : `
      <div style="margin-top: var(--space-3); display: flex; justify-content: flex-end;">
        <a href="/pages/memoriad.html" class="btn btn-secondary btn-sm" style="text-decoration: none;">
          Open Memoriad &rarr;
        </a>
      </div>
    `;

  container.innerHTML = `
    <!-- This Week Section (Monday to Sunday in India time) -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3);">
      <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px;">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          This week (${escapeHtml(weekBounds.rangeText)})
        </div>
        <span style="font-size: 11px; color: var(--text-dim);">India time</span>
      </div>
      <div class="num" style="font-size: var(--text-sm); font-weight: 700; color: ${weekTries === 0 ? 'var(--text-muted)' : 'var(--text-main)'}; margin-top: 4px;">
        ${escapeHtml(thisWeekText)}
      </div>
    </div>

    <!-- Visually Separate All-Time Section -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-top: 2px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3);">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px;">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          All time &mdash; Best scores by module
        </div>
        <span class="num" style="font-size: 11px; color: var(--text-dim);">
          ${summary.totalTries} total ${summary.totalTries === 1 ? 'try' : 'tries'}
        </span>
      </div>
      ${renderModuleBestRow('Calendar Dates', summary.modules.calendar, true)}
      ${renderModuleBestRow('Mental Additions', summary.modules.additions, false)}
      ${renderModuleBestRow('Mental Multiplications', summary.modules.multiplications, false)}
      ${renderModuleBestRow('Mental Square Roots', summary.modules.square_roots, false)}
    </div>
    ${linkHtml}
  `;
}
