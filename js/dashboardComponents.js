/**
 * Trendz Tracker - Shared Dashboard Visual Components (js/dashboardComponents.js)
 * 
 * Reusable visual renderers for both:
 * - /pages/student.html (student self-view)
 * - /pages/student-detail.html (teacher read-only view)
 * 
 * Includes:
 * 1. Streak & Milestone Shield Card
 * 2. Today's To-Do List (interactive deep links for student, read-only badges for teacher)
 * 3. Basics This Week (7-day summary)
 * 4. Learning Resources (topic-grouped)
 * 5. 5-Round Score Sheet Matrix with pagination & sticky category column
 * 6. Inline SVG Progress Charts with "7 days" vs "4 weeks" toggle, week-over-week comparison, and text summaries
 */

import { getScoreFeedback } from './scoreColors.js';
import { buildFlashCardSummary } from './flashStats.js';
import { isBasicsOnlineAvailable } from './practiceStats.js';
import { taskLink, isTaskActivityAvailable } from './todoForm.js';
import { progressText, percent, summary } from './todoProgress.js';
import {
  getISTDateYMD,
  getWeekBoundsIST,
  getLast7DaysBoundsIST,
} from './periods.js';
import {
  formatDisplayDateIST,
  formatSecondsToTime,
  getISTDateString,
  calculateBasicsWeeklySummary,
  buildRoundScoreMatrix,
  calculate7DayDualTrend,
  calculate4WeekSummary,
  calculateCategoryHistory
} from './stats.js';

/**
 * Escapes HTML characters for safe DOM insertion
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validates that a resource URL strictly starts with http:// or https://
 */
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/**
 * --------------------------------------------------------------------------
 * 1. Streak & Shield Card
 * Supports both the compact 1-row Student Home streak card and Admin detail card.
 * Uses active_today from streak_for directly without recomputing the rule.
 * --------------------------------------------------------------------------
 */
export function renderStreakCard(streakData, todos = []) {
  const streak = streakData || { current_streak: 0, best_streak: 0, shields: 0, active_today: false };
  const todoSummary = summary(todos);

  const currentEl = document.getElementById('stat-current-streak');
  const bestEl = document.getElementById('stat-best-streak');
  const shieldCountEl = document.getElementById('stat-shield-count');
  const shieldLblEl = document.getElementById('stat-shield-lbl');
  const todayBadgeEl = document.getElementById('streak-today-badge');
  const ruleNoteEl = document.getElementById('streak-rule-note');
  const milestoneLabelEl = document.getElementById('milestone-next-label');

  if (currentEl) currentEl.textContent = streak.current_streak || 0;
  if (bestEl) bestEl.textContent = streak.best_streak || 0;

  const shieldCount = Number(streak.shields) || 0;
  if (shieldCountEl) shieldCountEl.textContent = shieldCount;

  if (shieldLblEl) {
    if (shieldCount > 0) {
      shieldLblEl.textContent = shieldCount === 1 ? '1 shield ready' : `${shieldCount} shields ready`;
    } else {
      const cur = Number(streak.current_streak) || 0;
      const nextShieldDay = Math.ceil((cur + 1) / 10) * 10;
      shieldLblEl.textContent = `Next shield at day ${nextShieldDay}`;
    }
  }

  if (todayBadgeEl) {
    if (streak.active_today) {
      todayBadgeEl.innerHTML = `<span style="color: var(--color-score-perfect);">Today counts: Yes</span>`;
    } else {
      todayBadgeEl.innerHTML = `<span style="color: var(--text-muted);">Today counts: Not yet</span>`;
    }
  }

  if (ruleNoteEl) {
    if (todoSummary.total > 0) {
      ruleNoteEl.textContent = `A day counts for your streak only when all of today's tasks are done (${todoSummary.done} of ${todoSummary.total} done).`;
    } else {
      ruleNoteEl.textContent = 'No tasks today, so any practice counts.';
    }
  }

  // Milestones: 7, 25, 50, 100 (present on teacher detail view)
  const milestones = [7, 25, 50, 100];
  const curStreak = Number(streak.current_streak) || 0;
  let nextMilestone = null;

  milestones.forEach(m => {
    const node = document.getElementById(`milestone-${m}`);
    if (node) {
      if (curStreak >= m) {
        node.classList.add('achieved');
      } else {
        node.classList.remove('achieved');
        if (!nextMilestone) nextMilestone = m;
      }
    }
  });

  if (milestoneLabelEl) {
    if (nextMilestone) {
      const daysLeft = nextMilestone - curStreak;
      milestoneLabelEl.textContent = `${daysLeft} more day${daysLeft === 1 ? '' : 's'} to reach ${nextMilestone}-day milestone!`;
    } else {
      milestoneLabelEl.textContent = 'Grand 100-Day Champion! Outstanding dedication!';
    }
  }
}

/**
 * --------------------------------------------------------------------------
 * 1b. Student Home Top 3 Summary Metric Cards (Last 7 Days in IST)
 * Renders:
 * - Accuracy (with exact IST range, e.g. "Last 7 days: 22 to 28 Oct")
 * - Speed in questions per minute (same exact IST range)
 * - Practice days ("4 of the last 7 days", same exact IST range)
 * --------------------------------------------------------------------------
 */
export function renderTodaySummaryMetrics(results = [], activityResults = [], todayIST = '') {
  const bounds = getLast7DaysBoundsIST(todayIST || new Date());
  const rangeLabel = bounds.label; // e.g. "Last 7 days: 22 to 28 Oct"

  const accEl = document.getElementById('metric-7d-accuracy');
  const accRangeEl = document.getElementById('metric-7d-accuracy-range');
  const spdEl = document.getElementById('metric-7d-speed');
  const spdRangeEl = document.getElementById('metric-7d-speed-range');
  const daysEl = document.getElementById('metric-7d-days');
  const daysRangeEl = document.getElementById('metric-7d-days-range');

  if (accRangeEl) accRangeEl.textContent = rangeLabel;
  if (spdRangeEl) spdRangeEl.textContent = rangeLabel;
  if (daysRangeEl) daysRangeEl.textContent = rangeLabel;

  const trend7d = calculate7DayDualTrend(results, bounds.endYmd);
  let sumCorrect = 0;
  let sumTotal = 0;
  let sumTimedQuestions = 0;
  let sumTimedSeconds = 0;
  const activeDates = new Set();

  for (const day of trend7d) {
    if (day.total > 0) {
      sumCorrect += day.correct;
      sumTotal += day.total;
      activeDates.add(day.date);
    }
    if (day.total > 0 && day.timeSeconds > 0) {
      sumTimedQuestions += day.total;
      sumTimedSeconds += day.timeSeconds;
    }
  }

  // Also include activity_results (Flash Anzan, Elements, Memoriad) in active practice days
  if (Array.isArray(activityResults)) {
    for (const row of activityResults) {
      if (!row) continue;
      const total = Number(row.total) || 0;
      if (total <= 0) continue;
      const dStr = getISTDateYMD(row.created_at || row.entry_date);
      if (dStr >= bounds.startYmd && dStr <= bounds.endYmd) {
        activeDates.add(dStr);
      }
    }
  }

  if (accEl) {
    if (sumTotal > 0) {
      const pct = Math.round((sumCorrect / sumTotal) * 1000) / 10;
      const fb = getScoreFeedback(sumCorrect, sumTotal);
      accEl.textContent = `${pct}%`;
      accEl.style.color = fb.colorVar;
    } else {
      accEl.textContent = 'No tries';
      accEl.style.color = 'var(--text-muted)';
    }
  }

  if (spdEl) {
    if (sumTimedQuestions > 0 && sumTimedSeconds > 0) {
      const qpm = Math.round((sumTimedQuestions / (sumTimedSeconds / 60)) * 10) / 10;
      spdEl.textContent = `${qpm} q/min`;
      spdEl.style.color = 'var(--text-main)';
    } else {
      spdEl.textContent = 'No timed tries';
      spdEl.style.color = 'var(--text-muted)';
    }
  }

  if (daysEl) {
    daysEl.textContent = `${activeDates.size} of the last 7 days`;
    daysEl.style.color = activeDates.size > 0 ? 'var(--color-primary)' : 'var(--text-muted)';
  }
}

/**
 * --------------------------------------------------------------------------
 * 2. Today's Plan (To-Do List)
 * - Header line: "n of m tasks done today" (from summary(todos)).
 * - Each task shows its title, progress "2 of 4" with a small progress bar,
 *   a tick with the word "Done" when done is true, and the link as now.
 * - Completed tasks stay in the list.
 * --------------------------------------------------------------------------
 * @param {Array<object>} todos - Items from todo_for() RPC
 * @param {string} containerId - DOM container ID
 * @param {boolean} isReadOnly - If true (teacher detail view), do not render edit action links
 * @param {Array<object>} [categories=[]] - Categories list to detect online-available basics tasks
 */
export function renderTodoList(todos = [], containerId = 'todo-list-container', isReadOnly = false, categories = []) {
  const container = document.getElementById(containerId);
  const countEl = document.getElementById('todo-progress-count');
  if (!container) return;

  const todoSummary = summary(todos);
  if (countEl) {
    countEl.textContent = todoSummary.text;
    if (todoSummary.total > 0 && todoSummary.done === todoSummary.total) {
      countEl.style.color = 'var(--color-score-perfect)';
    } else {
      countEl.style.color = 'var(--color-primary)';
    }
  }

  if (!todos || todos.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No tasks assigned for today.
      </div>
    `;
    return;
  }

  // Group strictly by section
  const sectionMap = new Map();
  const sectionOrder = ['round', 'basics', 'elements', 'memoriad', 'flash'];
  const sectionTitles = {
    round: 'Competition Rounds',
    basics: 'Speed Drills (Basics)',
    elements: 'Elements',
    memoriad: 'Memoriad',
    flash: 'Flash Anzan'
  };

  todos.forEach(t => {
    const sec = t.task_section || 'round';
    if (!sectionMap.has(sec)) sectionMap.set(sec, []);
    sectionMap.get(sec).push(t);
  });

  let html = `<div style="display: flex; flex-direction: column; gap: var(--space-3);">`;

  sectionOrder.forEach(secKey => {
    if (!sectionMap.has(secKey)) return;
    const items = sectionMap.get(secKey);
    const secTitle = sectionTitles[secKey] || secKey;

    html += `
      <div class="todo-section-group">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: var(--space-1);">
          ${escapeHtml(secTitle)}
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-1);">
          ${items.map(t => {
            const isDone = t.done === true;
            const progLabel = progressText(t.done_count, t.required_count);
            const progPct = percent(t.done_count, t.required_count);
            const isAvailable = isTaskActivityAvailable(t, categories);
            const targetLink = taskLink(t);
            const sec = (t.task_section || 'round').toLowerCase();

            const matchedBasicsCat = sec === 'basics' && t.task_category_id && Array.isArray(categories)
              ? categories.find(c => String(c.id) === String(t.task_category_id))
              : null;
            const canPracticeOnline = matchedBasicsCat ? isBasicsOnlineAvailable(matchedBasicsCat) : false;

            const doneBadgeHtml = isDone
              ? `<span class="badge badge-active" style="font-size: 11px;">✓ Done</span>`
              : isReadOnly
                ? `<span class="badge badge-inactive" style="font-size: 11px;">Pending</span>`
                : '';

            let actionButtonsHtml = '';
            if (!isAvailable) {
              actionButtonsHtml = `<span style="font-size: var(--text-xs); color: var(--text-muted); font-style: italic;">Activity no longer available</span>`;
            } else if (isReadOnly) {
              actionButtonsHtml = doneBadgeHtml;
            } else if (sec === 'basics') {
              const onlineHref = canPracticeOnline
                ? `/pages/basics-practice.html?cat=${encodeURIComponent(t.task_category_id)}`
                : '/pages/basics.html';
              actionButtonsHtml = `
                ${doneBadgeHtml}
                <a href="${onlineHref}" class="btn btn-primary btn-sm" style="text-decoration: none;">Practice online</a>
                <a href="${targetLink}" class="btn btn-outline btn-sm" style="text-decoration: none;">Log result</a>
              `;
            } else if (sec === 'round') {
              actionButtonsHtml = `
                ${doneBadgeHtml}
                <a href="${targetLink}" class="btn btn-outline btn-sm" style="text-decoration: none;">Log result</a>
              `;
            } else {
              // elements, memoriad, flash: online practice only
              actionButtonsHtml = `
                ${doneBadgeHtml}
                <a href="${targetLink}" class="btn btn-primary btn-sm" style="text-decoration: none;">Practice online</a>
              `;
            }

            return `
              <div class="todo-task-item ${isDone ? 'todo-task-done' : ''}" style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: var(--space-3); min-width: 0; flex: 1 1 220px; flex-wrap: wrap;">
                  <span class="todo-checkbox ${isDone ? 'checked' : ''}" aria-hidden="true">
                    ${isDone ? '✓' : '○'}
                  </span>
                  <span class="todo-task-title" style="font-size: var(--text-sm); font-weight: 600; color: ${isDone ? 'var(--text-muted)' : 'var(--text-main)'};">
                    ${escapeHtml(t.task_title)}
                  </span>
                  <div style="display: inline-flex; align-items: center; gap: 6px;">
                    <span class="num" style="font-size: var(--text-xs); font-weight: 600; color: ${isDone ? 'var(--color-score-perfect)' : 'var(--text-muted)'};">
                      ${escapeHtml(progLabel)}
                    </span>
                    <div
                      role="progressbar"
                      aria-valuenow="${progPct}"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-label="${escapeHtml(t.task_title)} progress: ${escapeHtml(progLabel)}"
                      style="width: 56px; height: 6px; background: var(--border-subtle); border-radius: 3px; overflow: hidden;"
                    >
                      <div style="width: ${progPct}%; height: 100%; background: ${isDone ? 'var(--color-score-perfect)' : 'var(--color-primary)'}; transition: width 0.2s ease;"></div>
                    </div>
                  </div>
                </div>
                <div style="display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap;">
                  ${actionButtonsHtml}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

/**
 * --------------------------------------------------------------------------
 * 3. Basics Card (Reporting Periods: This Week vs Last 7 Days vs All Time)
 * --------------------------------------------------------------------------
 */
export function renderBasicsThisWeek(results = [], categories = [], todayIST, containerId = 'basics-week-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const weekBounds = getWeekBoundsIST(todayIST || new Date());
  const bounds7d = getLast7DaysBoundsIST(todayIST || new Date());
  const summary = calculateBasicsWeeklySummary(results, categories, bounds7d.endYmd);

  const basicsCatIds = new Set(
    (categories || []).filter(c => c && c.section === 'basics').map(c => c.id)
  );

  let weekTries = 0;
  let weekCorrect = 0;
  let weekQuestions = 0;
  let allTimeTries = 0;
  let allTimeCorrect = 0;
  let allTimeQuestions = 0;

  (results || []).forEach(res => {
    if (!res || !basicsCatIds.has(res.category_id)) return;
    const total = Number(res.total) || 0;
    const correct = Math.max(0, Number(res.correct) || 0);
    if (total <= 0) return;

    allTimeTries += 1;
    allTimeCorrect += correct;
    allTimeQuestions += total;

    const dKey = getISTDateString(res.entry_date || res.created_at);
    if (dKey >= weekBounds.startYmd && dKey <= weekBounds.endYmd) {
      weekTries += 1;
      weekCorrect += correct;
      weekQuestions += total;
    }
  });

  const allTimePct = allTimeQuestions > 0 ? Math.round((allTimeCorrect / allTimeQuestions) * 1000) / 10 : 0;

  // Collect recent Basics entries (up to 5) across the 7-day window to show individual source chips
  const recentBasicsEntries = summary
    .flatMap(item => item.entries || [])
    .slice(0, 5);

  const thisWeekText = weekTries === 0
    ? 'No tries this week'
    : `This week: ${weekTries} ${weekTries === 1 ? 'try' : 'tries'}, ${weekCorrect} correct (of ${weekQuestions})`;

  let html = `
    <!-- This Week (Monday to Sunday in IST) -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3);">
      <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px;">
        <span style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          This week (${escapeHtml(weekBounds.rangeText)})
        </span>
        <span style="font-size: 11px; color: var(--text-dim);">India time</span>
      </div>
      <div class="num" style="font-size: var(--text-sm); font-weight: 700; color: ${weekTries === 0 ? 'var(--text-muted)' : 'var(--text-main)'}; margin-top: 4px;">
        ${escapeHtml(thisWeekText)}
      </div>
    </div>

    <!-- Last 7 Days Category Breakdown -->
    <div style="margin-bottom: var(--space-3);">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: var(--space-2);">
        ${escapeHtml(bounds7d.label)}
      </div>
      ${summary.length === 0 ? `
        <div class="empty-state" style="padding: var(--space-3); font-size: var(--text-xs);">
          No tries in the last 7 days (${escapeHtml(bounds7d.shortRange)}).
        </div>
      ` : `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--space-2);">
          ${summary.map(item => {
            const feedback = getScoreFeedback(item.totalCorrect, item.totalQuestions);
            const targetHtml = item.targetEvaluatedCount > 0
              ? `<div style="margin-top: 4px;"><span class="badge ${item.targetMetCount === item.targetEvaluatedCount ? 'badge-success' : 'badge-warning'}" style="font-size: 10px;">🎯 ${item.targetMetCount} of ${item.targetEvaluatedCount} met target</span></div>`
              : '';
            const siteChipHtml = item.siteCount > 0
              ? `<div style="margin-top: 4px;"><span class="status-chip chip-verified" style="font-size: 10px;">Recorded by the site (${item.siteCount})</span></div>`
              : '';
            return `
              <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3); text-align: center;">
                <div style="font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); text-transform: uppercase;">
                  ${escapeHtml(item.categoryName)}
                </div>
                <div style="font-size: 1.25rem; font-weight: 800; color: ${feedback.colorVar}; margin: 2px 0;">
                  ${item.avgAccuracy}%
                </div>
                <div style="font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums;">
                  ${item.avgSpeed} q/min
                </div>
                <div style="font-size: 10px; color: var(--text-dim); margin-top: 2px;">
                  ${item.entryCount} ${item.entryCount === 1 ? 'try' : 'tries'} (${item.totalCorrect}/${item.totalQuestions})
                </div>
                ${targetHtml}
                ${siteChipHtml}
              </div>
            `;
          }).join('')}
        </div>
        ${recentBasicsEntries.length > 0 ? `
          <div style="margin-top: var(--space-3); border-top: 1px solid var(--border-hairline); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 4px;">
            ${recentBasicsEntries.map(entry => {
              const fb = getScoreFeedback(entry.correct, entry.total);
              const isSite = entry.source === 'site';
              const modeLabel = entry.practiceMode === 'timed' ? 'Timed' : (entry.practiceMode === 'unlimited' ? 'Unlimited' : null);
              const attemptedPerMinute = modeLabel && Number(entry.total) > 0 && Number(entry.timeSeconds) > 0
                ? (Math.round((Number(entry.total) / (Number(entry.timeSeconds) / 60)) * 10) / 10).toFixed(1)
                : null;
              const modeChip = modeLabel
                ? ` <span class="status-chip chip-unverified" style="font-size: 10px;">${modeLabel}</span>`
                : '';
              const statusChip = isSite
                ? `<span class="status-chip chip-verified" style="font-size: 10px;">Recorded by the site</span>${modeChip}`
                : `<span class="status-chip chip-unverified" style="font-size: 10px;">Typed</span>${modeChip}${entry.verified ? ` <span class="status-chip chip-verified" style="font-size: 10px;">🔒 Verified</span>` : ''}`;
              return `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); font-size: var(--text-xs); padding: 2px 0; flex-wrap: wrap;">
                  <div style="display: flex; align-items: center; gap: 6px;">
                    <strong style="color: var(--text-main);">${escapeHtml(entry.categoryName)}</strong>
                    <span class="num">${entry.correct}/${entry.total}</span>
                    <span class="score-tag ${fb.badgeClass}" style="font-size: 10px; padding: 1px 4px;">${fb.wrongText}</span>
                    ${attemptedPerMinute ? `<span class="num" style="font-size: 11px; color: var(--text-muted);">${attemptedPerMinute} / min</span>` : ''}
                  </div>
                  <div style="display: flex; align-items: center; gap: 6px;">
                    ${statusChip}
                    <span class="num" style="font-size: 11px; color: var(--text-dim);">${formatDisplayDateIST(entry.entryDate)}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
      `}
    </div>

    <!-- Visually Separate All-Time Section -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-top: 2px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3);">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 2px;">
        All time
      </div>
      <div class="num" style="font-size: var(--text-xs); color: var(--text-main); font-weight: 600;">
        ${allTimeTries > 0
          ? `All time: ${allTimeCorrect} of ${allTimeQuestions} correct (${allTimePct}%) across ${allTimeTries} ${allTimeTries === 1 ? 'try' : 'tries'}`
          : 'All time: No tries recorded yet.'}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

/**
 * --------------------------------------------------------------------------
 * 3b. Shared Flash Anzan Card
 * - Shows exact week range ("Mon 26 Oct to Sun 1 Nov") in India time
 * - Shows "This week: n tries, n correct" or "No tries this week" (distinct from "0 correct")
 * - Separately shows "All time at your most-practised settings: n of m correct (x%)"
 * --------------------------------------------------------------------------
 */
export function renderFlashThisWeek(activityResults = [], todayIST, containerId = 'flash-week-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const weekBounds = getWeekBoundsIST(todayIST || new Date());
  const summary = buildFlashCardSummary(activityResults, todayIST || new Date());
  const { triesThisWeek: triesCount, correctThisWeek: correctCount, mostPractised } = summary;

  const weekFeedback = triesCount > 0 ? getScoreFeedback(correctCount, triesCount) : null;
  const topFeedback = mostPractised ? getScoreFeedback(mostPractised.correct, mostPractised.tries) : null;

  const thisWeekLine = triesCount === 0
    ? 'No tries this week'
    : `This week: ${triesCount} ${triesCount === 1 ? 'try' : 'tries'}, ${correctCount} correct`;

  container.innerHTML = `
    <!-- This Week Section (Monday to Sunday in India time) -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3);">
      <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px;">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
          This week (${escapeHtml(weekBounds.rangeText)})
        </div>
        <span style="font-size: 11px; color: var(--text-dim);">India time</span>
      </div>
      <div class="num" style="font-size: 1.05rem; font-weight: 800; color: ${triesCount === 0 ? 'var(--text-muted)' : (weekFeedback ? weekFeedback.colorVar : 'var(--text-main)')}; margin-top: 4px;">
        ${escapeHtml(thisWeekLine)}
      </div>
    </div>

    <!-- Visually Separate All-Time Section -->
    <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-top: 2px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3);">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 4px;">
        All time
      </div>
      ${mostPractised ? `
        <div class="num" style="font-size: var(--text-sm); font-weight: 700; color: ${topFeedback ? topFeedback.colorVar : 'var(--text-main)'};">
          All time at your most-practised settings: ${mostPractised.correct} of ${mostPractised.tries} correct (${mostPractised.successRate}%)
        </div>
        <div class="num" style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
          Settings: ${escapeHtml(mostPractised.summary)}
        </div>
      ` : `
        <div style="font-size: var(--text-xs); color: var(--text-muted);">
          All time: No tries recorded yet.
        </div>
      `}
    </div>
  `;
}

/**
 * --------------------------------------------------------------------------
 * 4. Learning Resources (Topic Grouped)
 * --------------------------------------------------------------------------
 */
export function renderResources(resourcesList = [], containerId = 'resources-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const validResources = resourcesList.filter(r => isValidHttpUrl(r.url));
  const topicMap = new Map();

  validResources.forEach(res => {
    const topic = res.topic ? res.topic.trim() : 'General Guidelines';
    if (!topicMap.has(topic)) topicMap.set(topic, []);
    topicMap.get(topic).push(res);
  });

  if (topicMap.size === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No guidelines or study materials available.
      </div>
    `;
    return;
  }

  let html = `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3);">`;

  topicMap.forEach((items, topicName) => {
    html += `
      <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3);">
        <h3 style="font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--space-2);">
          ${escapeHtml(topicName)}
        </h3>
        <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2);">
          ${items.map(item => `
            <li>
              <a href="${escapeHtml(item.url.trim())}" target="_blank" rel="noopener noreferrer" style="font-size: var(--text-xs); font-weight: 600; color: var(--text-main); text-decoration: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 4px;" class="resource-link">
                <span>${escapeHtml(item.title)}</span>
                <span aria-hidden="true" style="color: var(--text-dim); flex-shrink: 0;">↗</span>
              </a>
              ${item.description ? `<p style="font-size: 11px; color: var(--text-muted); margin: 2px 0 0 0;">${escapeHtml(item.description)}</p>` : ''}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;
}

/**
 * --------------------------------------------------------------------------
 * 4.5 Attendance Summary Card
 * Displays attendance percentage, present, absent, excused counts from RPC attendance_summary
 * "Excused sessions are not counted"
 * --------------------------------------------------------------------------
 */
export function renderAttendanceCard(summary, containerId = 'attendance-card-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const pct = summary && summary.attendance_pct !== null && summary.attendance_pct !== undefined
    ? Number(summary.attendance_pct)
    : null;
  const pctDisplay = pct !== null ? `${Math.round(pct)}%` : '—';
  const present = summary?.present_count ?? 0;
  const absent = summary?.absent_count ?? 0;
  const excused = summary?.excused_count ?? 0;

  let colorVar = 'var(--text-main)';
  if (pct !== null) {
    if (pct >= 85) colorVar = 'var(--color-score-perfect)';
    else if (pct >= 70) colorVar = 'var(--color-primary)';
    else colorVar = 'var(--color-score-warning)';
  }

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-2); margin-bottom: var(--space-3); text-align: center;">
      <div style="padding: var(--space-2); background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-hairline);">
        <div style="font-size: 1.25rem; font-weight: 700; color: ${colorVar};">${pctDisplay}</div>
        <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-top: 2px;">Attendance</div>
      </div>
      <div style="padding: var(--space-2); background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-hairline);">
        <div style="font-size: 1.25rem; font-weight: 700; color: #10B981;">${present}</div>
        <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-top: 2px;">Present</div>
      </div>
      <div style="padding: var(--space-2); background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-hairline);">
        <div style="font-size: 1.25rem; font-weight: 700; color: #EF4444;">${absent}</div>
        <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-top: 2px;">Absent</div>
      </div>
      <div style="padding: var(--space-2); background: var(--bg-surface-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-hairline);">
        <div style="font-size: 1.25rem; font-weight: 700; color: #6B7280;">${excused}</div>
        <div style="font-size: 10px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-top: 2px;">Excused</div>
      </div>
    </div>
    <p style="font-size: 11px; color: var(--text-muted); margin: 0; line-height: 1.4;">
      <em>Excused classes are not counted.</em>
    </p>
  `;
}

/**
 * --------------------------------------------------------------------------
 * 4.6 Weekly Tests Card (Phase 4b)
 * Shows the student's last 3 weekly tests with date, title, category scores,
 * accuracy, time, and overall accuracy across those 3 tests.
 * --------------------------------------------------------------------------
 */
export function renderWeeklyTestsCard(weeklyTests, categories = [], containerId = 'weekly-tests-card-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const tests = Array.isArray(weeklyTests?.tests) ? weeklyTests.tests : [];
  const scores = Array.isArray(weeklyTests?.scores) ? weeklyTests.scores : [];

  const categoryMap = new Map();
  (categories || []).forEach(c => {
    categoryMap.set(c.id, c);
  });

  // Group scores by test_id
  const scoresByTest = new Map();
  scores.forEach(s => {
    const total = Number(s.total) || 0;
    if (total <= 0) return;
    if (!scoresByTest.has(s.test_id)) {
      scoresByTest.set(s.test_id, []);
    }
    scoresByTest.get(s.test_id).push(s);
  });

  // Sort tests newest first and pick the last 3 tests where the student has scores
  const sortedTests = [...tests]
    .filter(t => scoresByTest.has(t.id))
    .sort((a, b) => String(b.test_date || '').localeCompare(String(a.test_date || '')))
    .slice(0, 3);

  if (sortedTests.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
          No weekly test scores recorded yet.
        </p>
      </div>
    `;
    return;
  }

  // Calculate overall accuracy across these last 3 tests
  let overallCorrect = 0;
  let overallTotal = 0;
  sortedTests.forEach(t => {
    const testScores = scoresByTest.get(t.id) || [];
    testScores.forEach(s => {
      overallCorrect += Number(s.correct) || 0;
      overallTotal += Number(s.total) || 0;
    });
  });

  const overallAcc = overallTotal > 0 ? Math.round((overallCorrect / overallTotal) * 100) : null;

  const testBlocksHtml = sortedTests.map(test => {
    const testScores = [...(scoresByTest.get(test.id) || [])].sort((a, b) => {
      const catA = categoryMap.get(a.category_id);
      const catB = categoryMap.get(b.category_id);
      return (catA?.sort_order ?? 999) - (catB?.sort_order ?? 999);
    });

    const rowsHtml = testScores.map(s => {
      const cat = categoryMap.get(s.category_id);
      const catName = cat ? cat.name : 'Category';
      const correct = Number(s.correct) || 0;
      const total = Number(s.total) || 0;
      const acc = total > 0 ? Math.round((correct / total) * 100) : 0;
      const timeStr = s.time_seconds !== null && s.time_seconds !== undefined && s.time_seconds !== ''
        ? formatSecondsToTime(Number(s.time_seconds))
        : '—';

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: var(--text-xs); padding: 4px 0; border-top: 1px dashed var(--border-hairline);">
          <span style="color: var(--text-main); font-weight: 500;">${escapeHtml(catName)}</span>
          <div class="num" style="display: flex; align-items: center; gap: var(--space-3); color: var(--text-muted);">
            <span><strong style="color: var(--text-main);">${correct}/${total}</strong> (${acc}%)</span>
            <span style="min-width: 44px; text-align: right;">⏱ ${escapeHtml(timeStr)}</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3);">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-2); margin-bottom: 6px;">
          <strong style="font-size: var(--text-xs); color: var(--text-main);">${escapeHtml(test.title || 'Weekly Test')}</strong>
          <span class="num" style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">${formatDisplayDateIST(test.test_date)}</span>
        </div>
        <div>
          ${rowsHtml}
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) var(--space-3); background: var(--color-primary-subtle); border-radius: var(--radius-sm); margin-bottom: var(--space-3);">
      <span style="font-size: var(--text-xs); font-weight: 600; color: var(--color-primary-text);">
        Overall Accuracy (Last ${sortedTests.length} Test${sortedTests.length === 1 ? '' : 's'})
      </span>
      <strong class="num" style="font-size: var(--text-sm); font-weight: 800; color: var(--color-primary);">
        ${overallAcc !== null ? `${overallAcc}%` : '—'} (${overallCorrect}/${overallTotal})
      </strong>
    </div>
    <div style="display: flex; flex-direction: column; gap: var(--space-2);">
      ${testBlocksHtml}
    </div>
  `;
}

/**
 * --------------------------------------------------------------------------
 * 5. Competition Round Score Sheet Matrix with Series Selector & 5-Round Pagination
 * --------------------------------------------------------------------------
 */
export function setupScoreSheetController({
  results = [],
  categories = [],
  roundSeries = [],
  categorySeries = [],
  studentRounds = [],
  tableWrapperId = 'sheet-table-wrapper',
  rangeLabelId = 'sheet-range-label',
  olderBtnId = 'btn-sheet-older',
  newerBtnId = 'btn-sheet-newer'
}) {
  const ROUNDS_PER_PAGE = 5;
  let pageOffset = 0; // 0 = newest 5 rounds in selected series

  // Default to the current series (is_current = true), or the last series by sort_order
  const sortedSeries = [...roundSeries].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const defaultSeries = sortedSeries.find(s => s.is_current) || sortedSeries[sortedSeries.length - 1] || null;
  let selectedSeriesId = defaultSeries ? defaultSeries.id : null;

  // Inject or update Series Selector in the score sheet card header
  const olderBtnEl = document.getElementById(olderBtnId);
  const controlsContainer = olderBtnEl ? olderBtnEl.parentElement : null;
  if (controlsContainer && sortedSeries.length > 0 && !document.getElementById('select-sheet-series')) {
    const seriesWrap = document.createElement('div');
    seriesWrap.style.display = 'inline-flex';
    seriesWrap.style.alignItems = 'center';
    seriesWrap.style.gap = '6px';
    seriesWrap.style.marginRight = '8px';

    const lbl = document.createElement('label');
    lbl.htmlFor = 'select-sheet-series';
    lbl.textContent = 'Series:';
    lbl.style.fontSize = 'var(--text-xs)';
    lbl.style.fontWeight = '600';
    lbl.style.color = 'var(--text-muted)';

    const sel = document.createElement('select');
    sel.id = 'select-sheet-series';
    sel.className = 'form-select';
    sel.style.minHeight = '32px';
    sel.style.padding = '2px 28px 2px 10px';
    sel.style.fontSize = 'var(--text-xs)';
    sel.style.fontWeight = '600';

    sortedSeries.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.is_current ? `${s.name} (Current)` : s.name;
      sel.appendChild(opt);
    });

    if (selectedSeriesId) sel.value = selectedSeriesId;

    sel.addEventListener('change', () => {
      selectedSeriesId = sel.value;
      pageOffset = 0;
      renderPage();
    });

    seriesWrap.appendChild(lbl);
    seriesWrap.appendChild(sel);
    controlsContainer.insertBefore(seriesWrap, olderBtnEl);
  }

  function getSeriesCategories(seriesId) {
    const catMap = new Map(categories.map(c => [c.id, c]));
    const mappings = categorySeries
      .filter(cs => cs.series_id === seriesId)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    if (mappings.length > 0) {
      return mappings
        .map(cs => {
          const cat = catMap.get(cs.category_id);
          if (!cat || cat.section !== 'round') return null;
          return {
            ...cat,
            series_sort_order: cs.sort_order
          };
        })
        .filter(Boolean);
    }

    // Fallback if category_series is empty
    return categories
      .filter(c => c.section === 'round' && c.active !== false)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }

  function getRoundsForSelectedSeries() {
    if (!selectedSeriesId) return [];
    return studentRounds
      .filter(sr => sr.series_id === selectedSeriesId)
      .sort((a, b) => (b.round_number || 0) - (a.round_number || 0));
  }

  function renderPage() {
    const wrapper = document.getElementById(tableWrapperId);
    const rangeLabel = document.getElementById(rangeLabelId);
    const olderBtn = document.getElementById(olderBtnId);
    const newerBtn = document.getElementById(newerBtnId);
    if (!wrapper) return;

    const seriesRounds = getRoundsForSelectedSeries();
    const seriesCategories = getSeriesCategories(selectedSeriesId);
    const currentSeriesObj = sortedSeries.find(s => s.id === selectedSeriesId);
    const seriesName = currentSeriesObj ? currentSeriesObj.name : 'Simulator';

    if (seriesRounds.length === 0) {
      if (newerBtn) newerBtn.disabled = true;
      if (olderBtn) olderBtn.disabled = true;
      if (rangeLabel) {
        rangeLabel.textContent = `${seriesName} · No rounds recorded yet`;
      }
      wrapper.innerHTML = `<div class="empty-state" style="padding: var(--space-6);">No rounds recorded in ${escapeHtml(seriesName)} yet.</div>`;
      return;
    }

    const currentRounds = seriesRounds.slice(pageOffset, pageOffset + ROUNDS_PER_PAGE);

    // Button states
    if (newerBtn) newerBtn.disabled = pageOffset === 0;
    if (olderBtn) olderBtn.disabled = pageOffset + ROUNDS_PER_PAGE >= seriesRounds.length;

    // Build matrix using seriesCategories (ordered by category_series.sort_order) and currentRounds
    const matrix = buildRoundScoreMatrix(results, seriesCategories, currentRounds);

    // Range label e.g. "New simulator · Rounds 1–5 (10 Oct – 18 Oct)"
    if (rangeLabel) {
      const firstRound = currentRounds[currentRounds.length - 1].round_number;
      const lastRound = currentRounds[0].round_number;
      const dateFirst = matrix.roundHeaders[matrix.roundHeaders.length - 1]?.displayDate || '';
      const dateLast = matrix.roundHeaders[0]?.displayDate || '';
      rangeLabel.textContent = `${seriesName} · Rounds ${firstRound}–${lastRound} (${dateFirst} – ${dateLast})`;
    }

    // Render table
    let html = `
      <table class="sheet-table" aria-label="Competition Round Score Sheet">
        <thead>
          <tr>
            <th style="min-width: 140px;">Category</th>
            ${matrix.roundHeaders.map(h => `
              <th style="min-width: 100px;">
                <div>Round ${h.roundNumber}</div>
                <div style="font-size: 10px; color: var(--text-dim); font-weight: normal;">${h.displayDate}</div>
                ${h.isPartial ? `<span class="badge-partial-round" title="Partial round: some categories unattempted">Partial</span>` : ''}
              </th>
            `).join('')}
          </tr>
        </thead>
        <tbody>
    `;

    // Rows: Series Round Categories strictly in category_series.sort_order
    matrix.rows.forEach(row => {
      html += `
        <tr>
          <td><strong>${escapeHtml(row.category.name)}</strong></td>
          ${row.cells.map(cell => {
            if (!cell.hasData) {
              return `<td style="color: var(--text-dim);">—</td>`;
            }
            const verifiedMarker = cell.isVerified
              ? `<span title="Verified by teacher" style="font-size: 10px; margin-left: 2px;">🔒</span>`
              : '';
            const correctedMarker = cell.isCorrected
              ? `<span title="Corrected by teacher" style="font-size: 10px; margin-left: 2px; color: var(--color-primary);">✏️</span>`
              : '';

            // Handle text-only Surprise Task note cell
            if (cell.correct === null && cell.total === null && cell.note) {
              return `
                <td>
                  <div style="font-size: 11px; font-weight: 600; color: var(--text-main);">${escapeHtml(cell.note)}</div>
                  ${cell.isFlat ? '' : `<div style="font-size: 10px; color: var(--text-dim);">${cell.formattedTime}</div>`}
                </td>
              `;
            }

            const feedback = getScoreFeedback(cell.correct, cell.total);

            return `
              <td style="color: ${feedback.colorVar}; background-color: ${feedback.bgVar};">
                <div style="font-weight: 700; display: inline-flex; align-items: center; justify-content: center; gap: 2px;">
                  <span>${cell.correct}/${cell.total}</span>
                  ${verifiedMarker}
                  ${correctedMarker}
                </div>
                ${cell.isFlat ? '' : `<div style="font-size: 10px; color: var(--text-dim);">${cell.formattedTime}</div>`}
              </td>
            `;
          }).join('')}
        </tr>
      `;
    });

    // Summary Rows: Round Type, Time Taken, Final Score, Total Attempt, Marks to Correct
    html += `
      <tr class="sheet-summary-row">
        <td>Round Type</td>
        ${matrix.summary.roundType.map(s => `<td style="font-size: 11px;">${escapeHtml(s.value)}</td>`).join('')}
      </tr>
      <tr class="sheet-summary-row">
        <td>Time Taken</td>
        ${matrix.summary.timeTaken.map(s => `<td>${s.formatted}</td>`).join('')}
      </tr>
      <tr class="sheet-summary-row">
        <td>Final Score</td>
        ${matrix.summary.finalScore.map(s => `<td style="color: var(--color-score-perfect);">${s.value}</td>`).join('')}
      </tr>
      <tr class="sheet-summary-row">
        <td>Total Attempt</td>
        ${matrix.summary.totalAttempt.map(s => `<td>${s.value}</td>`).join('')}
      </tr>
      <tr class="sheet-summary-row">
        <td>Marks to Correct</td>
        ${matrix.summary.marksToCorrect.map(s => `
          <td style="color: ${s.value > 0 ? 'var(--color-score-warning)' : 'var(--color-score-perfect)'};">
            ${s.value}
          </td>
        `).join('')}
      </tr>
    `;

    html += `
        </tbody>
      </table>
    `;

    wrapper.innerHTML = html;
  }

  // Attach button listeners
  const olderBtn = document.getElementById(olderBtnId);
  const newerBtn = document.getElementById(newerBtnId);

  olderBtn?.addEventListener('click', () => {
    const seriesRounds = getRoundsForSelectedSeries();
    if (pageOffset + ROUNDS_PER_PAGE < seriesRounds.length) {
      pageOffset += ROUNDS_PER_PAGE;
      renderPage();
    }
  });

  newerBtn?.addEventListener('click', () => {
    if (pageOffset >= ROUNDS_PER_PAGE) {
      pageOffset -= ROUNDS_PER_PAGE;
      renderPage();
    }
  });

  // Initial render
  renderPage();
}

/**
 * --------------------------------------------------------------------------
 * 6. Inline SVG Progress Charts: 7 Days & 4 Weeks Toggle
 * --------------------------------------------------------------------------
 */
export function setupProgressChartsController({
  results = [],
  todayIST = '',
  containerId = 'charts-wrapper-container'
}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Render container shell with toggle header
  container.innerHTML = `
    <div class="card" style="margin-bottom: var(--space-8);">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3); border-bottom: 1px solid var(--border-hairline);">
        <div>
          <h2 class="card-title" style="margin-bottom: 2px;">Practice Progress Analytics</h2>
          <span style="font-size: var(--text-xs); color: var(--text-muted);">
            Calculation accuracy and speed progression in Indian time.
          </span>
        </div>

        <!-- Range Toggle Segmented Control -->
        <div class="chart-toggle-group" role="group" aria-label="Select chart period">
          <button type="button" class="btn btn-sm btn-chart-toggle active" id="btn-chart-7d" data-range="7d">
            7 Days
          </button>
          <button type="button" class="btn btn-sm btn-chart-toggle" id="btn-chart-4w" data-range="4w">
            4 Weeks
          </button>
        </div>
      </div>

      <div class="card-body" style="padding: var(--space-5);">
        <!-- Active View Container -->
        <div id="chart-view-target"></div>
      </div>
    </div>
  `;

  let currentView = '7d';

  function renderCurrentView() {
    const target = document.getElementById('chart-view-target');
    const btn7d = document.getElementById('btn-chart-7d');
    const btn4w = document.getElementById('btn-chart-4w');
    if (!target) return;

    if (currentView === '7d') {
      btn7d?.classList.add('active');
      btn4w?.classList.remove('active');
      render7DayView(target, results, todayIST);
    } else {
      btn4w?.classList.add('active');
      btn7d?.classList.remove('active');
      render4WeekView(target, results, todayIST);
    }
  }

  document.getElementById('btn-chart-7d')?.addEventListener('click', () => {
    currentView = '7d';
    renderCurrentView();
  });

  document.getElementById('btn-chart-4w')?.addEventListener('click', () => {
    currentView = '4w';
    renderCurrentView();
  });

  // Initial render
  renderCurrentView();
}

/**
 * Renders the 7-Day Dual Line Chart (one point per day, accuracy line & speed line)
 */
function render7DayView(target, results, todayIST) {
  const trend = calculate7DayDualTrend(results, todayIST);

  // Calculate averages for summary
  let accSum = 0;
  let accCount = 0;
  let spdSum = 0;
  let spdCount = 0;

  trend.forEach(item => {
    if (item.accuracy !== null) {
      accSum += item.accuracy;
      accCount++;
    }
    if (item.speed !== null) {
      spdSum += item.speed;
      spdCount++;
    }
  });

  const avgAcc = accCount > 0 ? (accSum / accCount).toFixed(1) : null;
  const avgSpd = spdCount > 0 ? (spdSum / spdCount).toFixed(1) : null;

  // Max speed for scale
  const maxSpd = trend.reduce((m, item) => Math.max(m, item.speed || 0), 30);
  const yMaxSpeed = Math.ceil((maxSpd + 5) / 5) * 5;

  // Dimensions
  const width = 640;
  const height = 260;
  const padLeft = 45;
  const padRight = 45;
  const padTop = 30;
  const padBottom = 35;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const count = trend.length;

  // Points
  const accPoints = [];
  const spdPoints = [];

  trend.forEach((item, idx) => {
    const x = padLeft + (idx / (count - 1)) * plotW;
    if (item.accuracy !== null) {
      const normY = item.accuracy / 100;
      const y = padTop + (1 - normY) * plotH;
      accPoints.push({ x, y, item, idx });
    }
    if (item.speed !== null) {
      const normY = item.speed / yMaxSpeed;
      const y = padTop + (1 - normY) * plotH;
      spdPoints.push({ x, y, item, idx });
    }
  });

  // Grid lines
  let gridSvg = '';
  for (let s = 0; s <= 4; s++) {
    const yPos = padTop + (1 - s / 4) * plotH;
    const accVal = s * 25;
    const spdVal = Math.round((s / 4) * yMaxSpeed);
    gridSvg += `
      <line x1="${padLeft}" y1="${yPos}" x2="${width - padRight}" y2="${yPos}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${padLeft - 6}" y="${yPos + 3}" fill="#10B981" font-size="10" text-anchor="end" font-weight="600">${accVal}%</text>
      <text x="${width - padRight + 6}" y="${yPos + 3}" fill="#3B82F6" font-size="10" text-anchor="start" font-weight="600">${spdVal}</text>
    `;
  }

  // X labels
  let xLabelsSvg = '';
  trend.forEach((item, idx) => {
    const x = padLeft + (idx / (count - 1)) * plotW;
    const dateLabel = item.displayDate.split(' ').slice(0, 2).join(' ');
    xLabelsSvg += `
      <text x="${x}" y="${height - 10}" fill="#64748B" font-size="10" text-anchor="middle">${dateLabel}</text>
    `;
  });

  // Paths
  const accPath = accPoints.length > 0 ? `M ${accPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}` : '';
  const spdPath = spdPoints.length > 0 ? `M ${spdPoints.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}` : '';

  // Dots
  const accDots = accPoints.map(p => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#10B981" stroke="#FFFFFF" stroke-width="2" class="chart-data-dot" tabindex="0" data-tooltip="<strong>${escapeHtml(p.item.displayDate)}</strong><br/>Accuracy: ${p.item.accuracy}% (${p.item.correct}/${p.item.total})">
      <title>${p.item.displayDate}: ${p.item.accuracy}%</title>
    </circle>
  `).join('');

  const spdDots = spdPoints.map(p => `
    <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#3B82F6" stroke="#FFFFFF" stroke-width="2" class="chart-data-dot" tabindex="0" data-tooltip="<strong>${escapeHtml(p.item.displayDate)}</strong><br/>Speed: ${p.item.speed} q/min (${p.item.total} in ${formatSecondsToTime(p.item.timeSeconds)})">
      <title>${p.item.displayDate}: ${p.item.speed} qpm</title>
    </circle>
  `).join('');

  target.innerHTML = `
    <!-- Legend -->
    <div style="display: flex; justify-content: center; gap: var(--space-6); margin-bottom: var(--space-3); font-size: var(--text-xs); font-weight: 600;">
      <div style="display: flex; align-items: center; gap: 6px; color: #10B981;">
        <span style="width: 12px; height: 12px; border-radius: 50%; background: #10B981; display: inline-block;"></span>
        <span>Accuracy (% left axis)</span>
      </div>
      <div style="display: flex; align-items: center; gap: 6px; color: #3B82F6;">
        <span style="width: 12px; height: 12px; border-radius: 50%; background: #3B82F6; display: inline-block;"></span>
        <span>Speed (questions/min right axis)</span>
      </div>
    </div>

    <!-- Responsive SVG -->
    <div style="position: relative; max-width: 100%; overflow-x: auto;">
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: auto; display: block;" role="img" aria-label="7-day dual accuracy and speed line chart">
        ${gridSvg}
        ${xLabelsSvg}
        ${accPath ? `<path d="${accPath}" fill="none" stroke="#10B981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
        ${spdPath ? `<path d="${spdPath}" fill="none" stroke="#3B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 2"/>` : ''}
        ${accDots}
        ${spdDots}
      </svg>
      <div class="svg-chart-tooltip" id="tooltip-7d"></div>
    </div>

    <!-- Short Text Summary -->
    <div style="margin-top: var(--space-3); padding-top: var(--space-3); border-top: 1px solid var(--border-hairline); font-size: var(--text-xs); color: var(--text-muted); text-align: center;">
      ${avgAcc !== null
        ? `7-day average accuracy: <strong>${avgAcc}%</strong> · Average speed: <strong>${avgSpd || '—'} questions/min</strong>.`
        : 'No practice entries recorded in the last 7 days.'
      }
    </div>
  `;

  attachTooltips(target, 'tooltip-7d');
}

/**
 * Renders the 4-Week Progress View:
 * - "This week vs last week" comparison line with up/down arrows and difference
 * - Two separate bar charts side by side on desktop: "Accuracy (%)" and "Speed (questions per minute)"
 * - Monday to Sunday Indian time weekly buckets ("Week of 12 Oct", current week lighter & marked "so far")
 * - Fixed 0-100% scale for accuracy; 0 to nice ceil for speed
 * - Value text displayed on/above each bar; tapping shows exact value and number of entries
 * - A week with no entries shows "No entries", never a zero bar
 * - Short text summary under each chart
 */
function render4WeekView(target, results, todayIST) {
  const summary = calculate4WeekSummary(results, todayIST);
  const { weeks, comparison, summaries } = summary;

  // Max speed for bar scaling
  const maxSpd = weeks.reduce((m, w) => Math.max(m, w.speed || 0), 25);
  const speedScaleMax = Math.ceil((maxSpd + 4) / 5) * 5;

  // Comparison Line Formatters
  const accComp = comparison.accuracy;
  const spdComp = comparison.speed;

  target.innerHTML = `
    <!-- Comparison Banner: This week vs last week -->
    <div class="week-comparison-banner" style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-5); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3);">
      <div style="font-size: var(--text-xs); font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: 0.05em;">
        This week vs last week
      </div>
      <div style="display: flex; gap: var(--space-4); align-items: center; font-size: var(--text-sm); font-variant-numeric: tabular-nums;">
        <div>
          <span style="color: var(--text-muted); font-size: var(--text-xs);">Accuracy: </span>
          <strong style="color: ${accComp.direction === 'up' ? 'var(--color-score-perfect)' : accComp.direction === 'down' ? 'var(--color-score-danger)' : 'var(--text-main)'};">
            ${escapeHtml(accComp.text)}
          </strong>
        </div>
        <span style="color: var(--border-hairline);" aria-hidden="true">|</span>
        <div>
          <span style="color: var(--text-muted); font-size: var(--text-xs);">Speed: </span>
          <strong style="color: ${spdComp.direction === 'up' ? 'var(--color-score-perfect)' : spdComp.direction === 'down' ? 'var(--color-score-danger)' : 'var(--text-main)'};">
            ${escapeHtml(spdComp.text)}
          </strong>
        </div>
      </div>
    </div>

    <!-- 2 Bar Charts Side-by-Side on Desktop, Stacked on Mobile -->
    <div class="chart-card-row" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">
      
      <!-- Chart 1: Accuracy (%) -->
      <div class="card" style="margin: 0; background: var(--bg-surface);">
        <div class="card-header" style="padding-bottom: var(--space-2);">
          <h3 class="card-title" style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
            Accuracy (%)
          </h3>
        </div>
        <div class="card-body" style="padding: var(--space-3);">
          <div style="position: relative;">
            ${buildBarChartSvg({
              weeks,
              valKey: 'accuracy',
              yMax: 100,
              yUnit: '%',
              baseColor: '#10B981',
              soFarColor: '#6EE7B7',
              chartId: 'bar-acc'
            })}
            <div class="svg-chart-tooltip" id="tooltip-bar-acc"></div>
          </div>
          <!-- Short text summary -->
          <p style="font-size: 11px; color: var(--text-muted); margin: var(--space-3) 0 0 0; text-align: center;">
            ${escapeHtml(summaries.accuracy)}
          </p>
        </div>
      </div>

      <!-- Chart 2: Speed (questions per minute) -->
      <div class="card" style="margin: 0; background: var(--bg-surface);">
        <div class="card-header" style="padding-bottom: var(--space-2);">
          <h3 class="card-title" style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted);">
            Speed (questions per minute)
          </h3>
        </div>
        <div class="card-body" style="padding: var(--space-3);">
          <div style="position: relative;">
            ${buildBarChartSvg({
              weeks,
              valKey: 'speed',
              yMax: speedScaleMax,
              yUnit: ' q/m',
              baseColor: '#3B82F6',
              soFarColor: '#93C5FD',
              chartId: 'bar-spd'
            })}
            <div class="svg-chart-tooltip" id="tooltip-bar-spd"></div>
          </div>
          <!-- Short text summary -->
          <p style="font-size: 11px; color: var(--text-muted); margin: var(--space-3) 0 0 0; text-align: center;">
            ${escapeHtml(summaries.speed)}
          </p>
        </div>
      </div>

    </div>
  `;

  attachTooltips(target, 'tooltip-bar-acc');
  attachTooltips(target, 'tooltip-bar-spd');
}

/**
 * Builds an inline SVG Bar Chart with 4 weekly columns.
 * If a week has no entries: displays centered "No entries" text, NEVER a zero bar!
 */
function buildBarChartSvg({ weeks, valKey, yMax, yUnit, baseColor, soFarColor, chartId }) {
  const width = 360;
  const height = 200;
  const padLeft = 35;
  const padRight = 15;
  const padTop = 25;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const baseline = height - padBottom;

  // Grid lines
  let gridSvg = '';
  for (let s = 0; s <= 4; s++) {
    const yVal = Math.round((s / 4) * yMax);
    const yPos = padTop + (1 - s / 4) * plotH;
    gridSvg += `
      <line x1="${padLeft}" y1="${yPos}" x2="${width - padRight}" y2="${yPos}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${padLeft - 6}" y="${yPos + 3}" fill="#64748B" font-size="9" text-anchor="end">${yVal}</text>
    `;
  }

  // 4 columns
  const colWidth = plotW / 4;
  const barWidth = Math.min(38, colWidth * 0.6);

  let columnsSvg = '';
  weeks.forEach((wk, idx) => {
    const colCenterX = padLeft + idx * colWidth + colWidth / 2;
    const hasData = wk.hasEntries && wk[valKey] !== null;

    // X-axis label
    const labelParts = wk.label.replace('Week of ', '').split(' ');
    const weekLabel = `${labelParts[0]} ${labelParts[1] || ''}`;

    let labelSvg = `
      <text x="${colCenterX}" y="${baseline + 14}" fill="#475569" font-size="10" text-anchor="middle" font-weight="600">
        ${escapeHtml(weekLabel)}
      </text>
    `;
    if (wk.isCurrentWeek) {
      labelSvg += `
        <text x="${colCenterX}" y="${baseline + 26}" fill="#64748B" font-size="9" text-anchor="middle">
          (so far)
        </text>
      `;
    }

    if (!hasData) {
      // NEVER a zero bar! Display centered "No entries" text
      columnsSvg += `
        <g>
          ${labelSvg}
          <text x="${colCenterX}" y="${baseline - 25}" fill="#94A3B8" font-size="10" text-anchor="middle" font-style="italic">
            No entries
          </text>
        </g>
      `;
    } else {
      const val = wk[valKey];
      const normHeight = Math.max(0, Math.min(1, val / yMax)) * plotH;
      const barY = baseline - normHeight;
      const barX = colCenterX - barWidth / 2;
      const color = wk.isCurrentWeek ? soFarColor : baseColor;

      const tooltipText = `<strong>${escapeHtml(wk.label)} ${wk.isCurrentWeek ? '(so far)' : ''}</strong><br/>` +
        `${valKey === 'accuracy' ? 'Accuracy' : 'Speed'}: ${val}${yUnit}<br/>` +
        `Based on ${wk.count} entries (${wk.correct}/${wk.total} correct)`;

      columnsSvg += `
        <g>
          ${labelSvg}
          <!-- Bar value text on/above bar -->
          <text x="${colCenterX}" y="${Math.max(12, barY - 4)}" fill="#0F172A" font-size="10" font-weight="700" text-anchor="middle">
            ${val}${valKey === 'accuracy' ? '%' : ''}
          </text>
          <!-- Bar rect -->
          <rect
            x="${barX.toFixed(1)}"
            y="${barY.toFixed(1)}"
            width="${barWidth.toFixed(1)}"
            height="${Math.max(2, normHeight).toFixed(1)}"
            rx="4"
            fill="${color}"
            class="chart-data-dot"
            tabindex="0"
            data-tooltip="${escapeHtml(tooltipText)}"
            style="cursor: pointer; transition: opacity 0.15s;"
          >
            <title>${wk.label}: ${val}${yUnit} (${wk.count} entries)</title>
          </rect>
        </g>
      `;
    }
  });

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" style="width: 100%; height: auto; display: block;" role="img" aria-label="4-week bar chart">
      ${gridSvg}
      ${columnsSvg}
    </svg>
  `;
}

/**
 * Attaches interactive tap and hover listeners to data dots and bars
 */
function attachTooltips(container, tooltipId) {
  const tooltip = document.getElementById(tooltipId);
  if (!tooltip) return;

  const elements = container.querySelectorAll('.chart-data-dot');
  elements.forEach(el => {
    const show = (e) => {
      const html = el.getAttribute('data-tooltip');
      if (!html) return;
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';

      const rect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const left = elRect.left - rect.left + elRect.width / 2;
      const top = Math.max(0, elRect.top - rect.top - 10);

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const hide = () => {
      tooltip.style.display = 'none';
    };

    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      show(e);
    });
  });

  document.addEventListener('click', () => {
    if (tooltip) tooltip.style.display = 'none';
  });
}
