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
import {
  formatDisplayDateIST,
  formatSecondsToTime,
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
 * --------------------------------------------------------------------------
 */
export function renderStreakCard(streakData) {
  const streak = streakData || { current_streak: 0, best_streak: 0, shields: 0, active_today: false };

  const currentEl = document.getElementById('stat-current-streak');
  const bestEl = document.getElementById('stat-best-streak');
  const shieldCountEl = document.getElementById('stat-shield-count');
  const shieldLblEl = document.getElementById('stat-shield-lbl');
  const todayBadgeEl = document.getElementById('streak-today-badge');
  const milestoneLabelEl = document.getElementById('milestone-next-label');

  if (currentEl) currentEl.textContent = streak.current_streak || 0;
  if (bestEl) bestEl.textContent = streak.best_streak || 0;

  const shieldCount = Number(streak.shields) || 0;
  if (shieldCountEl) shieldCountEl.textContent = shieldCount;

  if (shieldLblEl) {
    if (shieldCount > 0) {
      shieldLblEl.textContent = shieldCount === 1 ? 'Shield Ready' : `${shieldCount} Shields Ready`;
    } else {
      const cur = Number(streak.current_streak) || 0;
      const nextShieldDay = Math.ceil((cur + 1) / 10) * 10;
      shieldLblEl.textContent = `Next shield at day ${nextShieldDay}`;
    }
  }

  if (todayBadgeEl) {
    if (streak.active_today) {
      todayBadgeEl.innerHTML = `<span style="color: var(--color-score-perfect);">✓ Completed Today</span>`;
    } else {
      todayBadgeEl.innerHTML = `<span style="color: var(--color-score-warning);">⏳ Pending Today</span>`;
    }
  }

  // Milestones: 7, 25, 50, 100
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
 * 2. Today's To-Do List
 * --------------------------------------------------------------------------
 * @param {Array<object>} todos - Items from todo_for() RPC
 * @param {string} containerId - DOM container ID
 * @param {boolean} isReadOnly - If true (teacher detail view), do not render edit action links
 */
export function renderTodoList(todos = [], containerId = 'todo-list-container', isReadOnly = false) {
  const container = document.getElementById(containerId);
  const countEl = document.getElementById('todo-progress-count');
  if (!container) return;

  if (!todos || todos.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No tasks assigned for today.
      </div>
    `;
    if (countEl) countEl.textContent = '0/0';
    return;
  }

  const completedCount = todos.filter(t => t.done).length;
  if (countEl) {
    countEl.textContent = `${completedCount}/${todos.length} Done`;
    if (completedCount === todos.length && todos.length > 0) {
      countEl.style.color = 'var(--color-score-perfect)';
    } else {
      countEl.style.color = 'var(--color-primary)';
    }
  }

  // Group strictly by section
  const sectionMap = new Map();
  const sectionOrder = ['round', 'basics', 'elements', 'flash'];
  const sectionTitles = {
    round: 'Competition Rounds',
    basics: 'Speed Drills',
    elements: 'Elements',
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
            const isDone = !!t.done;
            const targetLink = t.task_section === 'basics'
              ? `/pages/basics.html?cat=${encodeURIComponent(t.task_category_id || '')}`
              : `/pages/round-scores.html?cat=${encodeURIComponent(t.task_category_id || '')}`;

            return `
              <div class="todo-task-item ${isDone ? 'todo-task-done' : ''}" style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline);">
                <div style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;">
                  <span class="todo-checkbox ${isDone ? 'checked' : ''}" aria-hidden="true">
                    ${isDone ? '✓' : '○'}
                  </span>
                  <span style="font-size: var(--text-xs); font-weight: 600; color: ${isDone ? 'var(--text-muted)' : 'var(--text-main)'}; text-decoration: ${isDone ? 'line-through' : 'none'}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${escapeHtml(t.task_title)}
                  </span>
                </div>
                <div>
                  ${isReadOnly
                    ? `<span class="badge ${isDone ? 'badge-active' : 'badge-inactive'}" style="font-size: 10px;">${isDone ? 'Done' : 'Pending'}</span>`
                    : (isDone
                        ? `<span class="badge badge-active" style="font-size: 10px;">Done</span>`
                        : `<a href="${targetLink}" class="btn btn-primary btn-sm" style="font-size: 10px; padding: 2px 8px; text-decoration: none;">Start &rarr;</a>`
                      )
                  }
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
 * 3. Basics This Week Card (Past 7 Days)
 * --------------------------------------------------------------------------
 */
export function renderBasicsThisWeek(results, categories, todayIST, containerId = 'basics-week-container') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const summary = calculateBasicsWeeklySummary(results, categories, todayIST);

  if (summary.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No basics speed drills logged in the last 7 days.
      </div>
    `;
    return;
  }

  let html = `
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: var(--space-2);">
      ${summary.map(item => {
        const feedback = getScoreFeedback(item.totalCorrect, item.totalQuestions);
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
              ${item.entryCount} drill${item.entryCount === 1 ? '' : 's'} (${item.totalCorrect}/${item.totalQuestions})
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  container.innerHTML = html;
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
 * 5. Competition Round Score Sheet Matrix with 5-Round Pagination
 * --------------------------------------------------------------------------
 */
export function setupScoreSheetController({
  results = [],
  categories = [],
  tableWrapperId = 'sheet-table-wrapper',
  rangeLabelId = 'sheet-range-label',
  olderBtnId = 'btn-sheet-older',
  newerBtnId = 'btn-sheet-newer'
}) {
  const ROUNDS_PER_PAGE = 5;
  let pageOffset = 0; // 0 = newest 5 rounds

  // Extract distinct round numbers from results
  const roundSet = new Set();
  results.forEach(r => {
    if (r.round_number) {
      roundSet.add(Number(r.round_number));
    }
  });

  // Sort descending: newest round first
  let roundNumbersList = Array.from(roundSet).sort((a, b) => b - a);

  // If student has fewer than 5 rounds, pad with realistic descending numbers
  if (roundNumbersList.length === 0) {
    roundNumbersList = [244, 243, 242, 241, 240];
  } else if (roundNumbersList.length < 5) {
    const min = roundNumbersList[roundNumbersList.length - 1];
    for (let pad = 1; roundNumbersList.length < 5 && min - pad > 0; pad++) {
      roundNumbersList.push(min - pad);
    }
  }

  function renderPage() {
    const wrapper = document.getElementById(tableWrapperId);
    const rangeLabel = document.getElementById(rangeLabelId);
    const olderBtn = document.getElementById(olderBtnId);
    const newerBtn = document.getElementById(newerBtnId);
    if (!wrapper) return;

    const currentRounds = roundNumbersList.slice(pageOffset, pageOffset + ROUNDS_PER_PAGE);

    if (currentRounds.length === 0) {
      wrapper.innerHTML = '<div class="empty-state">No round scores available.</div>';
      return;
    }

    // Button states
    if (newerBtn) newerBtn.disabled = pageOffset === 0;
    if (olderBtn) olderBtn.disabled = pageOffset + ROUNDS_PER_PAGE >= roundNumbersList.length;

    // Build matrix
    const matrix = buildRoundScoreMatrix(results, categories, currentRounds);

    // Range label e.g. "Rounds 240–244 (12 Oct – 17 Oct)"
    if (rangeLabel) {
      const firstRound = currentRounds[currentRounds.length - 1];
      const lastRound = currentRounds[0];
      const dateFirst = matrix.roundHeaders[matrix.roundHeaders.length - 1]?.displayDate || '';
      const dateLast = matrix.roundHeaders[0]?.displayDate || '';
      rangeLabel.textContent = `Rounds ${firstRound}–${lastRound} (${dateFirst} – ${dateLast})`;
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

    // Rows: Round Categories strictly
    matrix.rows.forEach(row => {
      html += `
        <tr>
          <td><strong>${escapeHtml(row.category.name)}</strong></td>
          ${row.cells.map(cell => {
            if (!cell.hasData) {
              return `<td style="color: var(--text-dim);">—</td>`;
            }
            const feedback = getScoreFeedback(cell.correct, cell.total);
            return `
              <td style="color: ${feedback.colorVar}; background-color: ${feedback.bgVar};">
                <div style="font-weight: 700;">${cell.correct}/${cell.total}</div>
                <div style="font-size: 10px; color: var(--text-dim);">${cell.formattedTime}</div>
              </td>
            `;
          }).join('')}
        </tr>
      `;
    });

    // Summary Rows
    html += `
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
    if (pageOffset + ROUNDS_PER_PAGE < roundNumbersList.length) {
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
