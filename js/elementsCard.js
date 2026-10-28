/**
 * Trendz Tracker — Shared Elements Dashboard Card Module (js/elementsCard.js)
 *
 * Renders the "Elements" summary card for a given `studentId`:
 * - Sets completed this week (India time, Monday–Sunday)
 * - Last set completed (drill name, score correct/attempted, mistake badge, time)
 * - Link to `/pages/elements.html` for students (omitted when `isReadOnly` is true for admins)
 *
 * Used on both `/pages/student.html` (student dashboard) and
 * `/pages/student-detail.html` (admin read-only student detail view).
 */

import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { setsThisWeek, recentSets, formatDrillHistoryName } from './drillStats.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToMMSS } from './timeUtils.js';
import { getWeekBoundsIST } from './periods.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fetches a student's `activity_results` rows with `activity_type = 'element'`.
 *
 * @param {string} studentId
 * @returns {Promise<Array<object>>}
 */
export async function fetchStudentElementResults(studentId) {
  if (!studentId) return [];

  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('activity_results')
          .select(
            'id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at'
          )
          .eq('student_id', studentId)
          .eq('activity_type', 'element')
          .order('created_at', { ascending: false })
          .limit(200);
        if (!error && Array.isArray(data)) {
          return data;
        }
      }
    } catch {
      // Fall through to DemoDB when in demo mode
    }
  }

  return DemoDB ? DemoDB.getActivityResults(studentId, 'element') : [];
}

/**
 * Renders the Elements card for `studentId`.
 * Can be called as `renderElementsCard(studentId, options)` or `renderElementsCard({ studentId, ...options })`.
 *
 * @param {string|object} studentIdOrOpts
 * @param {object} [opts]
 * @param {string} [opts.containerId='elements-week-container']
 * @param {boolean} [opts.isReadOnly=false]
 * @param {string|Date} [opts.todayIST]
 * @param {Array<object>|null} [opts.preloadedResults=null]
 */
export async function renderElementsCard(studentIdOrOpts, opts = {}) {
  const config =
    typeof studentIdOrOpts === 'object' && studentIdOrOpts !== null
      ? studentIdOrOpts
      : { studentId: studentIdOrOpts, ...opts };

  const {
    studentId,
    containerId = 'elements-week-container',
    isReadOnly = false,
    todayIST,
    preloadedResults = null,
  } = config;

  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = Array.isArray(preloadedResults)
    ? preloadedResults.filter((r) => !r.activity_type || r.activity_type === 'element')
    : await fetchStudentElementResults(studentId);

  const weekBounds = getWeekBoundsIST(todayIST || new Date());
  const weekSets = setsThisWeek(rows, todayIST || new Date());
  const latestList = recentSets(rows, 1);
  const lastSet = latestList[0] || null;

  let weekCorrect = 0;
  let weekTotal = 0;
  weekSets.forEach((r) => {
    weekCorrect += Math.max(0, Number(r.correct) || 0);
    weekTotal += Math.max(0, Number(r.total) || 0);
  });

  let allTimeCorrect = 0;
  let allTimeTotal = 0;
  rows.forEach((r) => {
    allTimeCorrect += Math.max(0, Number(r.correct) || 0);
    allTimeTotal += Math.max(0, Number(r.total) || 0);
  });
  const allTimePct =
    allTimeTotal > 0 ? Math.round((allTimeCorrect / allTimeTotal) * 1000) / 10 : 0;

  const thisWeekText =
    weekSets.length === 0
      ? 'No tries this week'
      : `This week: ${weekSets.length} ${weekSets.length === 1 ? 'try' : 'tries'}, ${weekCorrect} correct (of ${weekTotal})`;

  let lastSetHtml = '';
  if (lastSet) {
    const drillTitle = formatDrillHistoryName(lastSet);
    const correct = Number(lastSet.correct) || 0;
    const total = Number(lastSet.total) || 0;
    const timeSec =
      lastSet.time_seconds !== null && lastSet.time_seconds !== undefined
        ? Number(lastSet.time_seconds)
        : 0;
    const formattedTime = formatSecondsToMMSS(timeSec);
    const feedback = getScoreFeedback(correct, total);

    lastSetHtml = `
      <div style="margin-top: var(--space-2); padding-top: var(--space-2); border-top: 1px dashed var(--border-subtle);">
        <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 2px;">
          Last Set
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <div style="font-size: var(--text-xs); font-weight: 700; color: var(--text-main);">
            ${escapeHtml(drillTitle)}
          </div>
          <div class="num" style="display: flex; align-items: center; gap: var(--space-2);">
            <strong style="font-size: var(--text-xs); color: ${feedback.colorVar};">${correct}/${total}</strong>
            <span class="score-tag ${feedback.badgeClass}" style="font-size: 10px;">${escapeHtml(feedback.wrongText)}</span>
            <span style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(formattedTime)}</span>
          </div>
        </div>
      </div>
    `;
  }

  const linkHtml = isReadOnly
    ? ''
    : `
      <div style="margin-top: var(--space-3); display: flex; justify-content: flex-end;">
        <a href="/pages/elements.html" class="btn btn-secondary btn-sm" style="text-decoration: none;">
          Open Elements Drills &rarr;
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
      <div class="num" style="font-size: var(--text-sm); font-weight: 700; color: ${weekSets.length === 0 ? 'var(--text-muted)' : 'var(--text-main)'}; margin-top: 4px;">
        ${escapeHtml(thisWeekText)}
      </div>
    </div>

    <!-- Visually Separate All-Time Section -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-top: 2px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3);">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 4px;">
        All time
      </div>
      <div class="num" style="font-size: var(--text-xs); font-weight: 600; color: var(--text-main);">
        ${rows.length > 0
          ? `All time: ${allTimeCorrect} of ${allTimeTotal} correct (${allTimePct}%) across ${rows.length} ${rows.length === 1 ? 'try' : 'tries'}`
          : 'All time: No tries recorded yet.'}
      </div>
      ${lastSetHtml}
    </div>
    ${linkHtml}
  `;
}
