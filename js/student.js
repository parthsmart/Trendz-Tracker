/**
 * Trendz Tracker - Phase 3 Student Dashboard Controller (js/student.js)
 * 
 * Coordinates:
 * 1. Database-Authoritative RPCs (today_ist, streak_for, todo_for)
 * 2. 90-day Results aggregation via pure js/stats.js
 * 3. 5-Round Score Sheet Matrix with 5-round pagination & sticky category column
 * 4. Inline SVG Progress Charts (30-day Accuracy, 30-day Speed, Category Drilldown)
 * 5. Basics weekly rollup & Learning resources grouped by topic
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isDemoMode } from './demoDb.js';
import { getScoreFeedback } from './scoreColors.js';
import {
  getISTDateString,
  formatDisplayDateIST,
  formatSecondsToTime,
  calculateAccuracyTrend,
  calculateSpeedTrend,
  calculateCategoryHistory,
  calculateBasicsWeeklySummary,
  buildRoundScoreMatrix
} from './stats.js';

// Dashboard state
let currentStudentId = '';
let currentProfile = null;
let todayIST = '';
let allCategories = [];
let allResults = [];
let roundNumbersList = [];
let currentRoundPageOffset = 0; // 0 = latest 5 rounds
const ROUNDS_PER_PAGE = 5;

/**
 * Validates that a resource URL strictly starts with http:// or https://
 */
function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/**
 * Escapes HTML characters for safe DOM insertion
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Initializes the student dashboard with data fetching and event listeners
 */
async function initStudentDashboard() {
  // 1. Guard check: allow student and admin
  const loggedInProfile = await requireAuth(['student', 'admin']);
  if (!loggedInProfile) return;

  // 2. Resolve target studentId:
  // Default to logged-in user. If URL contains ?studentId=..., only allow if logged-in user is admin.
  const urlParams = new URLSearchParams(window.location.search);
  const requestedStudentId = urlParams.get('studentId');

  if (requestedStudentId && loggedInProfile.role === 'admin') {
    currentStudentId = requestedStudentId;
    currentProfile = await resolveStudentProfile(requestedStudentId);
  } else {
    currentStudentId = loggedInProfile.id;
    currentProfile = loggedInProfile;
  }

  // Render Header Details
  renderHeaderUser(loggedInProfile);
  renderStudentHero(currentProfile);

  // Render Demo Banner if running in demo mode
  renderDemoBanner();

  // 3. Load all dashboard data in parallel with Promise.all
  await loadDashboardData(currentStudentId);

  // 4. Attach interactive listeners
  attachPaginationListeners();
  attachCategoryDrilldownListener();
}

/**
 * Resolves a profile record by student ID (for admin inspecting a student)
 */
async function resolveStudentProfile(studentId) {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', studentId)
          .single();
        if (!error && data) return data;
      }
    } catch (err) {
      console.warn('Error fetching student profile for admin view:', err);
    }
  }

  const demoStudents = DemoDB.getStudents();
  return demoStudents.find(s => s.id === studentId || s.student_code === studentId) || {
    id: studentId,
    full_name: 'Selected Student',
    student_code: studentId,
    level: 'Level 3'
  };
}

/**
 * Renders header user pill
 */
function renderHeaderUser(profile) {
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');
  const pillContainer = document.getElementById('user-pill-container');

  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || 'STU';
  if (pillContainer) pillContainer.style.display = 'flex';
}

/**
 * Renders welcome hero information
 */
function renderStudentHero(profile) {
  const nameEl = document.getElementById('student-display-name');
  const codeEl = document.getElementById('student-display-code');
  const levelEl = document.getElementById('student-display-level');

  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || '—';
  if (levelEl) levelEl.textContent = profile.level || 'Unassigned';
}

/**
 * Renders persistent Demo Mode banner if demo mode is active
 */
function renderDemoBanner() {
  const placeholder = document.getElementById('demo-banner-placeholder');
  if (!placeholder) return;

  if (isDemoMode()) {
    placeholder.innerHTML = `
      <div class="demo-mode-alert-banner" role="alert">
        <span aria-hidden="true">⚠️</span>
        <span>DEMO MODE — data is fake</span>
      </div>
    `;
  } else {
    placeholder.innerHTML = '';
  }
}

/**
 * Master data fetch using Promise.all to fetch all dashboard dependencies in parallel
 */
export async function loadDashboardData(studentId) {
  try {
    const isLive = isSupabaseConfigured();
    let supabase = null;
    if (isLive) {
      supabase = await getSupabase();
    }

    // Prepare 90-days ago threshold
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

    // Execute independent requests together with Promise.all
    const [
      todayRes,
      streakRes,
      todoRes,
      categoriesRes,
      resourcesRes,
      resultsRes
    ] = await Promise.all([
      // 1. RPC today_ist()
      (async () => {
        if (supabase) {
          const { data, error } = await supabase.rpc('today_ist');
          if (!error && data) return data;
        }
        return await DemoDB.mockTodayIST();
      })(),

      // 2. RPC streak_for(p_student)
      (async () => {
        if (supabase) {
          const { data, error } = await supabase.rpc('streak_for', { p_student: studentId });
          if (!error && data) {
            // Some RPCs return an array of 1 row, others return a single object
            return Array.isArray(data) ? data[0] : data;
          }
        }
        return await DemoDB.mockStreakFor(studentId);
      })(),

      // 3. RPC todo_for(p_student)
      (async () => {
        if (supabase) {
          const { data, error } = await supabase.rpc('todo_for', { p_student: studentId });
          if (!error && data) return Array.isArray(data) ? data : [data];
        }
        return await DemoDB.mockTodoFor(studentId);
      })(),

      // 4. Categories table
      (async () => {
        if (supabase) {
          const { data, error } = await supabase
            .from('categories')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        }
        return DemoDB.getCategories().filter(c => c.active !== false);
      })(),

      // 5. Resources table (active, ordered by sort_order)
      (async () => {
        if (supabase) {
          const { data, error } = await supabase
            .from('resources')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        }
        return DemoDB.getResources().filter(r => r.active !== false);
      })(),

      // 6. Results table (last 90 days for this student)
      (async () => {
        if (supabase) {
          const { data, error } = await supabase
            .from('results')
            .select('*')
            .eq('student_id', studentId)
            .gte('entry_date', ninetyDaysAgo)
            .order('created_at', { ascending: false });
          if (!error && data) return data;
        }
        return DemoDB.getResults().filter(r => r.student_id === studentId || r.student_id === 'usr-101');
      })()
    ]);

    // Store fetched state
    todayIST = todayRes || getISTDateString(new Date());
    allCategories = categoriesRes || [];
    allResults = resultsRes || [];

    // Render Date in Header
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatDisplayDateIST(todayIST);

    // Render Streak & Shields Card
    renderStreakCard(streakRes);

    // Render Today's To-Do List
    renderTodoList(todoRes);

    // Render Basics This Week
    renderBasicsThisWeek(allResults, allCategories, todayIST);

    // Render Learning Resources (Grouped by Topic)
    renderResources(resourcesRes);

    // Prepare Rounds List for 5-Round Score Table Pagination
    setupRoundPaginationList(allResults);

    // Render Score Sheet Table for the first 5 rounds
    renderScoreSheetPage();

    // Render Progress Charts (30-day Accuracy, 30-day Speed)
    renderProgressCharts(allResults, todayIST);

    // Populate Category Drilldown Dropdown & Initial Chart
    setupCategoryDrilldown(allCategories, allResults);

  } catch (err) {
    console.error('Error loading dashboard data:', err);
  }
}

/**
 * --------------------------------------------------------------------------
 * Streak & Shield Card
 * --------------------------------------------------------------------------
 */
function renderStreakCard(streakData) {
  const streak = streakData || { current_streak: 0, best_streak: 0, shields: 0, active_today: false };

  const currentEl = document.getElementById('stat-current-streak');
  const bestEl = document.getElementById('stat-best-streak');
  const shieldCountEl = document.getElementById('stat-shield-count');
  const shieldLblEl = document.getElementById('stat-shield-lbl');
  const todayBadgeEl = document.getElementById('streak-today-badge');
  const milestoneLabelEl = document.getElementById('milestone-next-label');

  if (currentEl) currentEl.textContent = streak.current_streak || 0;
  if (bestEl) bestEl.textContent = streak.best_streak || 0;

  // Shields status ("Shield ready" or "Next shield at day X")
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

  // Active today indicator
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
      node.classList.remove('reached', 'target');
      if (curStreak >= m) {
        node.classList.add('reached');
      } else if (!nextMilestone) {
        nextMilestone = m;
        node.classList.add('target');
      }
    }
  });

  if (milestoneLabelEl) {
    if (nextMilestone) {
      const diff = nextMilestone - curStreak;
      milestoneLabelEl.textContent = `Next milestone: ${nextMilestone} days (${diff} more ${diff === 1 ? 'day' : 'days'} to reach)`;
    } else {
      milestoneLabelEl.textContent = `🏆 Outstanding! You have reached the Grand 100-day Milestone!`;
    }
  }
}

/**
 * --------------------------------------------------------------------------
 * Today's To-Do List
 * --------------------------------------------------------------------------
 */
function renderTodoList(tasks) {
  const container = document.getElementById('todo-list-container');
  const progressCountEl = document.getElementById('todo-progress-count');
  if (!container) return;

  if (!tasks || tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No tasks set by your teacher yet.
      </div>
    `;
    if (progressCountEl) progressCountEl.textContent = '0 tasks';
    return;
  }

  const completedCount = tasks.filter(t => t.done).length;
  const totalCount = tasks.length;

  if (progressCountEl) {
    progressCountEl.textContent = `${completedCount} of ${totalCount} done today`;
  }

  container.innerHTML = tasks.map(task => {
    // Generate direct entry link:
    // Round task -> /pages/round-scores.html
    // Basics task -> /pages/basics.html?cat=${task_category_id}
    let targetLink = '/pages/round-scores.html';
    if (task.task_section === 'basics') {
      targetLink = task.task_category_id ? `/pages/basics.html?cat=${task.task_category_id}` : '/pages/basics.html';
    } else if (task.task_section === 'round') {
      targetLink = '/pages/round-scores.html';
    }

    const isDone = !!task.done;

    return `
      <a href="${targetLink}" class="todo-task-item" aria-label="${escapeHtml(task.task_title)} - ${isDone ? 'Completed' : 'Pending'}">
        <div class="todo-check-circle ${isDone ? 'todo-check-done' : 'todo-check-pending'}" aria-hidden="true">
          ${isDone ? '✓' : ''}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: var(--text-xs); color: ${isDone ? 'var(--text-muted)' : 'var(--text-main)'}; ${isDone ? 'text-decoration: line-through;' : ''}">
            ${escapeHtml(task.task_title)}
          </div>
          <div style="font-size: 10px; color: var(--text-dim); text-transform: uppercase;">
            ${escapeHtml(task.task_section || 'general')}
          </div>
        </div>
        <span style="font-size: var(--text-xs); color: var(--text-dim);" aria-hidden="true">&rarr;</span>
      </a>
    `;
  }).join('');
}

/**
 * --------------------------------------------------------------------------
 * Basics This Week (Last 7 Days)
 * --------------------------------------------------------------------------
 */
function renderBasicsThisWeek(results, categories, todayISTDate) {
  const container = document.getElementById('basics-week-container');
  if (!container) return;

  const summary = calculateBasicsWeeklySummary(results, categories, todayISTDate);

  if (!summary || summary.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-3);">
        No mental basics logged in the last 7 days.
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: var(--space-2);">
      ${summary.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-2) var(--space-3); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px solid var(--border-hairline);">
          <div>
            <strong style="color: var(--text-main); font-size: var(--text-xs);">${escapeHtml(item.categoryName)}</strong>
            <div style="font-size: 11px; color: var(--text-muted);">${item.entryCount} ${item.entryCount === 1 ? 'drill' : 'drills'} this week</div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: var(--text-xs); font-weight: 700; color: ${item.avgAccuracy >= 95 ? 'var(--color-score-perfect)' : item.avgAccuracy >= 85 ? 'var(--color-score-warning)' : 'var(--color-score-alert)'};">
              ${item.avgAccuracy}% Accuracy
            </div>
            <div style="font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums;">
              ${item.avgSpeed} q/min
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * --------------------------------------------------------------------------
 * Learning Resources (Grouped by Topic)
 * --------------------------------------------------------------------------
 */
function renderResources(resources) {
  const container = document.getElementById('resources-container');
  if (!container) return;

  if (!resources || resources.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No learning resources published yet.
      </div>
    `;
    return;
  }

  // Group by topic
  const topicMap = new Map();
  resources.forEach(res => {
    // Only render valid http or https URLs
    if (!isValidHttpUrl(res.url)) return;

    const topic = res.topic || 'General Practice';
    if (!topicMap.has(topic)) {
      topicMap.set(topic, []);
    }
    topicMap.get(topic).push(res);
  });

  if (topicMap.size === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4);">
        No valid resources available.
      </div>
    `;
    return;
  }

  let html = `<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">`;

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
 * 5-Round Score Sheet Table & Pagination
 * --------------------------------------------------------------------------
 */
function setupRoundPaginationList(results) {
  const roundSet = new Set();
  results.forEach(r => {
    if (r.round_number) {
      roundSet.add(Number(r.round_number));
    }
  });

  // Sort descending: newest round first
  roundNumbersList = Array.from(roundSet).sort((a, b) => b - a);

  // If student has fewer than 5 rounds in results, pad with realistic descending round numbers
  if (roundNumbersList.length === 0) {
    roundNumbersList = [244, 243, 242, 241, 240];
  } else if (roundNumbersList.length < 5) {
    const min = roundNumbersList[roundNumbersList.length - 1];
    for (let pad = 1; roundNumbersList.length < 5 && min - pad > 0; pad++) {
      roundNumbersList.push(min - pad);
    }
  }

  currentRoundPageOffset = 0;
}

function renderScoreSheetPage() {
  const wrapper = document.getElementById('sheet-table-wrapper');
  const rangeLabel = document.getElementById('sheet-range-label');
  const olderBtn = document.getElementById('btn-sheet-older');
  const newerBtn = document.getElementById('btn-sheet-newer');
  if (!wrapper) return;

  const startIndex = currentRoundPageOffset;
  const currentRounds = roundNumbersList.slice(startIndex, startIndex + ROUNDS_PER_PAGE);

  if (currentRounds.length === 0) {
    wrapper.innerHTML = '<div class="empty-state">No round scores available.</div>';
    return;
  }

  // Update button states
  if (newerBtn) newerBtn.disabled = currentRoundPageOffset === 0;
  if (olderBtn) olderBtn.disabled = startIndex + ROUNDS_PER_PAGE >= roundNumbersList.length;

  // Build matrix using pure calculations
  const matrix = buildRoundScoreMatrix(allResults, allCategories, currentRounds);

  // Update range label e.g. "Rounds 240–244 (12 Oct – 17 Oct)"
  if (rangeLabel) {
    const firstRound = currentRounds[currentRounds.length - 1];
    const lastRound = currentRounds[0];
    const dateFirst = matrix.roundHeaders[matrix.roundHeaders.length - 1]?.displayDate || '';
    const dateLast = matrix.roundHeaders[0]?.displayDate || '';
    rangeLabel.textContent = `Rounds ${firstRound}–${lastRound} (${dateFirst} – ${dateLast})`;
  }

  // Render Table
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

  // Rows: Categories
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

  // Summary Rows:
  // 1. Time taken
  html += `
    <tr class="sheet-summary-row">
      <td>Time Taken</td>
      ${matrix.summary.timeTaken.map(s => `<td>${s.formatted}</td>`).join('')}
    </tr>
  `;

  // 2. Final score
  html += `
    <tr class="sheet-summary-row">
      <td>Final Score</td>
      ${matrix.summary.finalScore.map(s => `<td style="color: var(--color-score-perfect);">${s.value}</td>`).join('')}
    </tr>
  `;

  // 3. Total attempt
  html += `
    <tr class="sheet-summary-row">
      <td>Total Attempt</td>
      ${matrix.summary.totalAttempt.map(s => `<td>${s.value}</td>`).join('')}
    </tr>
  `;

  // 4. Marks to be corrected
  html += `
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

function attachPaginationListeners() {
  document.getElementById('btn-sheet-older')?.addEventListener('click', () => {
    if (currentRoundPageOffset + ROUNDS_PER_PAGE < roundNumbersList.length) {
      currentRoundPageOffset += ROUNDS_PER_PAGE;
      renderScoreSheetPage();
    }
  });

  document.getElementById('btn-sheet-newer')?.addEventListener('click', () => {
    if (currentRoundPageOffset >= ROUNDS_PER_PAGE) {
      currentRoundPageOffset -= ROUNDS_PER_PAGE;
      renderScoreSheetPage();
    }
  });
}

/**
 * --------------------------------------------------------------------------
 * Inline SVG Progress Charts (30-Day Accuracy & Speed)
 * --------------------------------------------------------------------------
 */
function renderProgressCharts(results, todayISTDate) {
  const accuracyData = calculateAccuracyTrend(results, 30, todayISTDate);
  const speedData = calculateSpeedTrend(results, 30, todayISTDate);

  renderSvgLineChart({
    containerId: 'chart-accuracy-container',
    data: accuracyData,
    valKey: 'accuracy',
    yMin: 0,
    yMax: 100,
    yUnit: '%',
    lineColor: '#10B981',
    fillColor: 'rgba(16, 185, 129, 0.1)',
    formatTooltip: (item) => `<strong>${item.displayDate}</strong><br/>Accuracy: ${item.accuracy}% (${item.correct}/${item.total})`
  });

  // Determine max speed for Y-axis scale
  const maxSpeed = speedData.reduce((m, item) => Math.max(m, item.speed || 0), 40);
  const yMaxSpeed = Math.ceil((maxSpeed + 5) / 10) * 10;

  renderSvgLineChart({
    containerId: 'chart-speed-container',
    data: speedData,
    valKey: 'speed',
    yMin: 0,
    yMax: yMaxSpeed,
    yUnit: ' q/m',
    lineColor: '#3B82F6',
    fillColor: 'rgba(59, 130, 246, 0.1)',
    formatTooltip: (item) => `<strong>${item.displayDate}</strong><br/>Speed: ${item.speed} questions/min (${item.totalQuestions} in ${formatSecondsToTime(item.totalSeconds)})`
  });
}

/**
 * Generic responsive inline SVG Line Chart with area fill and interactive data dots
 */
function renderSvgLineChart({
  containerId,
  data,
  valKey,
  yMin,
  yMax,
  yUnit,
  lineColor,
  fillColor,
  formatTooltip
}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const width = 600;
  const height = 240;
  const padLeft = 45;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const count = data.length;
  if (count === 0) {
    container.innerHTML = '<div class="empty-state">No trend data available</div>';
    return;
  }

  // Calculate coordinates
  const points = [];
  data.forEach((item, idx) => {
    const val = item[valKey];
    if (val !== null && val !== undefined) {
      const x = padLeft + (idx / (count - 1)) * plotW;
      const normalizedY = Math.max(0, Math.min(1, (val - yMin) / (yMax - yMin)));
      const y = padTop + (1 - normalizedY) * plotH;
      points.push({ x, y, item, idx });
    }
  });

  // SVG grid lines (4 horizontal bands)
  const gridSteps = 4;
  let gridLinesSvg = '';
  for (let s = 0; s <= gridSteps; s++) {
    const yVal = Math.round(yMin + (s / gridSteps) * (yMax - yMin));
    const yPos = padTop + (1 - s / gridSteps) * plotH;
    gridLinesSvg += `
      <line x1="${padLeft}" y1="${yPos}" x2="${width - padRight}" y2="${yPos}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="3 3"/>
      <text x="${padLeft - 6}" y="${yPos + 3}" fill="#64748B" font-size="10" text-anchor="end" font-family="monospace">${yVal}${yUnit}</text>
    `;
  }

  // X-axis date labels (show 5 evenly spaced dates)
  let xLabelsSvg = '';
  const xStep = Math.floor((count - 1) / 4);
  for (let i = 0; i < count; i += xStep) {
    const xPos = padLeft + (i / (count - 1)) * plotW;
    const labelDate = data[i]?.displayDate ? data[i].displayDate.split(' ').slice(0, 2).join(' ') : '';
    xLabelsSvg += `
      <text x="${xPos}" y="${height - 8}" fill="#64748B" font-size="10" text-anchor="middle">${labelDate}</text>
    `;
  }

  // Build polyline and area path
  let pathD = '';
  let areaD = '';

  if (points.length > 0) {
    pathD = `M ${points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}`;
    areaD = `${pathD} L ${points[points.length - 1].x.toFixed(1)},${height - padBottom} L ${points[0].x.toFixed(1)},${height - padBottom} Z`;
  }

  // Data Dots
  const dotsSvg = points.map(p => `
    <circle
      cx="${p.x.toFixed(1)}"
      cy="${p.y.toFixed(1)}"
      r="4"
      fill="${lineColor}"
      stroke="#FFFFFF"
      stroke-width="2"
      class="chart-data-dot"
      tabindex="0"
      data-tooltip="${escapeHtml(formatTooltip(p.item))}"
      style="cursor: pointer; transition: r 0.15s;"
    >
      <title>${p.item.displayDate}: ${p.item[valKey]}${yUnit}</title>
    </circle>
  `).join('');

  // Assemble full SVG
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="30-day trend chart">
      ${gridLinesSvg}
      ${xLabelsSvg}
      ${areaD ? `<path d="${areaD}" fill="${fillColor}"/>` : ''}
      ${pathD ? `<path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` : ''}
      ${dotsSvg}
    </svg>
    <div class="svg-chart-tooltip" id="tooltip-${containerId}"></div>
    <!-- Screen reader text fallback -->
    <div class="sr-only">
      30-day summary: Latest recorded value is ${points.length > 0 ? points[points.length - 1].item[valKey] + yUnit : 'none'}.
    </div>
  `;

  // Attach tap and hover tooltips
  setupChartTooltips(container, `tooltip-${containerId}`);
}

function setupChartTooltips(container, tooltipId) {
  const tooltip = document.getElementById(tooltipId);
  if (!tooltip) return;

  const dots = container.querySelectorAll('.chart-data-dot');
  dots.forEach(dot => {
    const show = (e) => {
      const html = dot.getAttribute('data-tooltip');
      if (!html) return;
      dot.setAttribute('r', '6');
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';

      const rect = container.getBoundingClientRect();
      const dotRect = dot.getBoundingClientRect();
      const left = dotRect.left - rect.left + dotRect.width / 2;
      const top = dotRect.top - rect.top;

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const hide = () => {
      dot.setAttribute('r', '4');
      tooltip.style.display = 'none';
    };

    dot.addEventListener('mouseenter', show);
    dot.addEventListener('mouseleave', hide);
    dot.addEventListener('focus', show);
    dot.addEventListener('blur', hide);
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      show(e);
    });
  });

  // Hide tooltip when clicking anywhere outside
  document.addEventListener('click', () => {
    tooltip.style.display = 'none';
  });
}

/**
 * --------------------------------------------------------------------------
 * Category History Drilldown
 * --------------------------------------------------------------------------
 */
function setupCategoryDrilldown(categories, results) {
  const select = document.getElementById('category-drilldown-select');
  if (!select) return;

  select.innerHTML = categories.map(c => `
    <option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.section)})</option>
  `).join('');

  if (categories.length > 0) {
    select.value = categories[0].id;
    renderCategoryDrilldownChart(categories[0].id, results);
  }
}

function attachCategoryDrilldownListener() {
  const select = document.getElementById('category-drilldown-select');
  if (!select) return;

  select.addEventListener('change', (e) => {
    renderCategoryDrilldownChart(e.target.value, allResults);
  });
}

function renderCategoryDrilldownChart(categoryId, results) {
  const container = document.getElementById('chart-category-container');
  if (!container) return;

  const history = calculateCategoryHistory(results, categoryId, 10);

  if (history.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-6);">
        No completed entries found for this category yet.
      </div>
    `;
    return;
  }

  // Render last 10 entries as visual progression bars with accuracy and speed
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2);">
      ${history.map((entry, idx) => {
        const feedback = getScoreFeedback(entry.correct, entry.total);
        return `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); background: var(--bg-surface-subtle); border-radius: var(--radius-md); border: 1px solid var(--border-hairline); gap: var(--space-3); flex-wrap: wrap;">
            <div style="min-width: 120px;">
              <strong style="color: var(--text-main); font-size: var(--text-xs);">#${idx + 1} · ${entry.roundNumber ? `Round ${entry.roundNumber}` : 'Drill'}</strong>
              <div style="font-size: 11px; color: var(--text-muted);">${entry.displayDate}</div>
            </div>

            <div style="flex: 1; min-width: 140px; display: flex; align-items: center; gap: var(--space-3);">
              <div style="flex: 1; height: 8px; background: #E2E8F0; border-radius: 4px; overflow: hidden;">
                <div style="width: ${entry.accuracy}%; height: 100%; background: ${feedback.colorVar}; border-radius: 4px;"></div>
              </div>
              <span style="font-size: var(--text-xs); font-weight: 700; color: ${feedback.colorVar}; min-width: 45px;">
                ${entry.accuracy}%
              </span>
            </div>

            <div style="text-align: right; min-width: 110px;">
              <div style="font-size: var(--text-xs); font-weight: 600; color: var(--text-main); font-variant-numeric: tabular-nums;">
                ${entry.correct}/${entry.total} in ${entry.formattedTime}
              </div>
              <div style="font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums;">
                ${entry.speed !== null ? `${entry.speed} q/min` : '—'}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initStudentDashboard);
