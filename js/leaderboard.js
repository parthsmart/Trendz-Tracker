/**
 * Trendz Tracker - Leaderboard Controller (js/leaderboard.js)
 *
 * Serves both Students and Admins on /pages/leaderboard.html:
 * - Guard: requireAuth(['student', 'admin'])
 * - Student view: scope switch between own level ('level') and all trainees ('global'),
 *   top 10 + own row below top 10 if outside it, "You" highlight, level chip in global mode, no links.
 * - Admin view: level filter ('all' or specific level from profiles), up to 200 rows,
 *   names link to /pages/student-detail.html?id=<student_id>, no "You" highlight.
 * - Never calculates points, ranks, task days, times, speeds, or streaks in JavaScript;
 *   strictly uses RPCs `leaderboard(p_board, p_period, p_level, p_limit, p_scope)`,
 *   `todo_task_leaderboard(p_task, p_period, p_level, p_limit, p_scope)`,
 *   `global_leaderboard_enabled()`, and `competition_rules()`.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import {
  fetchLeaderboard,
  fetchWeeklyTestLeaderboard,
  fetchTodoTaskLeaderboard,
  fetchTodoLeaderboardTasks,
  fetchGlobalLeaderboardEnabled,
  fetchCompetitionRules,
  buildHowItWorksText,
  getLeaderboardEmptyMessage
} from './leaderboardData.js';
import {
  WEEKLY_TEST_BOARD_EXPLANATION,
  mapWeeklyTestLeaderboardRows
} from './weeklyTestBoard.js';
import {
  BOARD_LABELS,
  TASK_SPEED_EXPLANATION_TEXT,
  TASK_SPEED_EMPTY_MESSAGE,
  TASK_SPEED_UNAVAILABLE_MESSAGE,
  boardUsesPeriod,
  isSpeedRankableTask,
  scopeLabel,
  boardTitle,
  formatTaskFilterOptions,
  mapLeaderboardRows,
  mapTaskLeaderboardRows
} from './leaderboardView.js';
import { setupAdminNav } from './modal.js';
import {
  MIN_LEADERBOARD_DATE,
  getISTDateYMD,
  parsePeriod,
  periodValue,
  periodLabel,
  validatePeriodDate
} from './periods.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { showToast } from './toast.js';

const SCOPE_STORAGE_KEY = 'trendz_leaderboard_scope_v1';
const STATE_STORAGE_KEY = 'trendz_leaderboard_state_v2';
const VALID_BOARDS = ['points', 'weekly_tests', 'streak', 'practice_days', 'todo', 'improved'];

let currentProfile = null;
let isAdmin = false;
let todayIST = getISTDateYMD();
let currentBoard = 'points'; // 'points' | 'weekly_tests' | 'streak' | 'practice_days' | 'todo' | 'improved'
let currentPeriod = 'week'; // 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' | 'date:YYYY-MM-DD'
let currentPeriodChoice = 'week'; // 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' | 'date'
let currentCustomDate = '';
let currentLevel = 'all'; // used by admin only
let currentScope = 'level'; // 'level' | 'global' (used by students)
let todoTaskOptions = []; // [{ id, taskNumber, shortLabel, optionLabel, title, section, category_id, level, isSpeedRanked }]
let currentTaskId = 'all'; // 'all' or a daily_tasks.id
let globalEnabled = true;
let competitionRules = {
  weekly_test_multiplier: 2,
  attendance_present_points: 10,
  improved_min_entries: 5,
  leaderboard_names: 'first_name_initial'
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function readStoredScope() {
  try {
    const val = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (val === 'global' || val === 'level') {
      return val;
    }
  } catch {
    // Ignore storage errors
  }
  return 'level';
}

function writeStoredScope(scope) {
  try {
    localStorage.setItem(SCOPE_STORAGE_KEY, scope === 'global' ? 'global' : 'level');
  } catch {
    // Ignore storage errors
  }
}

function readStoredLeaderboardState() {
  try {
    const raw = localStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistLeaderboardState() {
  try {
    localStorage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({
        board: currentBoard,
        period: currentPeriod,
        task: currentTaskId,
        scope: currentScope,
        level: currentLevel
      })
    );
  } catch {
    // Ignore storage errors
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set('board', currentBoard);
    if (boardUsesPeriod(currentBoard)) {
      url.searchParams.set('period', currentPeriod);
    } else {
      url.searchParams.delete('period');
    }
    if (currentBoard === 'todo' && currentTaskId && currentTaskId !== 'all') {
      url.searchParams.set('task', currentTaskId);
    } else {
      url.searchParams.delete('task');
    }
    if (!isAdmin) {
      if (currentScope === 'global' && globalEnabled) {
        url.searchParams.set('scope', 'global');
      } else {
        url.searchParams.delete('scope');
      }
    } else if (currentLevel && currentLevel !== 'all') {
      url.searchParams.set('level', currentLevel);
    } else {
      url.searchParams.delete('level');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  } catch {
    // Ignore history API errors
  }
}

function restoreInitialSelections() {
  const stored = readStoredLeaderboardState();

  // 1. Restore from localStorage first
  if (stored) {
    if (typeof stored.board === 'string' && VALID_BOARDS.includes(stored.board)) {
      currentBoard = stored.board;
    }
    const parsedStoredPeriod = parsePeriod(stored.period, todayIST);
    if (parsedStoredPeriod) {
      currentPeriod = parsedStoredPeriod.value;
      currentPeriodChoice = parsedStoredPeriod.choice;
      if (parsedStoredPeriod.dateText) {
        currentCustomDate = parsedStoredPeriod.dateText;
      }
    }
    if (typeof stored.task === 'string' && stored.task.trim()) {
      currentTaskId = stored.task.trim();
    }
    if (isAdmin && typeof stored.level === 'string' && stored.level.trim()) {
      currentLevel = stored.level.trim();
    }
  }

  // 2. Override with valid URL query parameters (?board=todo&period=date:2026-10-30&task=<id>)
  try {
    const params = new URLSearchParams(window.location.search);
    const urlBoard = params.get('board');
    if (urlBoard && VALID_BOARDS.includes(urlBoard.trim())) {
      currentBoard = urlBoard.trim();
    }

    const urlPeriod = params.get('period');
    if (urlPeriod) {
      const parsedUrlPeriod = parsePeriod(urlPeriod, todayIST);
      if (parsedUrlPeriod) {
        currentPeriod = parsedUrlPeriod.value;
        currentPeriodChoice = parsedUrlPeriod.choice;
        if (parsedUrlPeriod.dateText) {
          currentCustomDate = parsedUrlPeriod.dateText;
        }
      }
    }

    const urlTask = params.get('task');
    if (urlTask && urlTask.trim()) {
      currentTaskId = urlTask.trim();
    }

    const urlLevel = params.get('level');
    if (isAdmin && urlLevel && urlLevel.trim()) {
      currentLevel = urlLevel.trim();
    }
  } catch {
    // Ignore URL parse errors
  }

  if (!currentCustomDate) {
    currentCustomDate = todayIST;
  }
}

function getBoardLabel(board) {
  return BOARD_LABELS[board] || 'Leaderboard';
}

function getValueColumnHeader(board) {
  switch (board) {
    case 'points':
      return 'Points';
    case 'streak':
      return 'Streak';
    case 'practice_days':
      return 'Practice days';
    case 'todo':
      return 'Days completed';
    case 'improved':
      return 'Accuracy Gain';
    default:
      return 'Value';
  }
}

function getSelectedTaskOption() {
  if (!currentTaskId || currentTaskId === 'all') return null;
  if (!Array.isArray(todoTaskOptions) || todoTaskOptions.length === 0) return null;
  return todoTaskOptions.find(opt => String(opt.id) === String(currentTaskId)) || null;
}

/**
 * Loads and renders the task filter controls for the Daily To-Do Leaderboard.
 */
async function syncTodoTaskFilterOptions() {
  const effectiveLevel = isAdmin ? (currentLevel === 'all' ? 'all' : currentLevel) : null;
  const effectiveScope = isAdmin
    ? currentLevel === 'all'
      ? 'global'
      : 'level'
    : currentScope;

  const rawTasks = await fetchTodoLeaderboardTasks(
    { level: effectiveLevel, scope: effectiveScope },
    currentProfile
  ).catch(() => []);

  todoTaskOptions = formatTaskFilterOptions(rawTasks);

  if (currentTaskId !== 'all') {
    const stillExists = todoTaskOptions.some(opt => String(opt.id) === String(currentTaskId));
    if (!stillExists) {
      currentTaskId = 'all';
    }
  }

  renderTodoTaskFilterUI();
}

/**
 * Renders the Task filter dropdown and quick chip buttons (with "All tasks" as default).
 */
function renderTodoTaskFilterUI() {
  const wrapper = document.getElementById('todo-task-filter-wrapper');
  const selectEl = document.getElementById('select-todo-task');
  const pillsContainer = document.getElementById('todo-task-pills');

  if (!wrapper) return;

  if (currentBoard !== 'todo') {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = 'flex';

  const isAllActive = !currentTaskId || currentTaskId === 'all';

  if (selectEl) {
    selectEl.disabled = false;
    const allOptionHtml = `<option value="all" ${isAllActive ? 'selected' : ''}>All tasks</option>`;
    const taskOptionsHtml = todoTaskOptions
      .map(
        opt =>
          `<option value="${escapeHtml(opt.id)}" ${String(opt.id) === String(currentTaskId) ? 'selected' : ''}>${escapeHtml(opt.title)}</option>`
      )
      .join('');
    selectEl.innerHTML = allOptionHtml + taskOptionsHtml;
  }

  if (pillsContainer) {
    pillsContainer.style.display = 'flex';
    const allChipHtml = `
      <button
        type="button"
        class="segmented-btn ${isAllActive ? 'active' : ''}"
        data-todo-task-id="all"
        aria-pressed="${isAllActive ? 'true' : 'false'}"
      >
        All tasks
      </button>
    `;
    const taskChipsHtml = todoTaskOptions
      .map(opt => {
        const isActive = String(opt.id) === String(currentTaskId);
        return `
          <button
            type="button"
            class="segmented-btn ${isActive ? 'active' : ''}"
            data-todo-task-id="${escapeHtml(opt.id)}"
            aria-pressed="${isActive ? 'true' : 'false'}"
            title="${escapeHtml(opt.optionLabel)}"
          >
            ${escapeHtml(opt.title)}
          </button>
        `;
      })
      .join('');
    pillsContainer.innerHTML = allChipHtml + taskChipsHtml;
  }
}

/**
 * Syncs the Board Tabs, Period Selector buttons, and Date Picker UI with current state.
 */
function syncToolbarControlsUI() {
  // Board tabs
  const boardButtons = document.querySelectorAll('[data-board]');
  boardButtons.forEach(b => {
    const active = b.getAttribute('data-board') === currentBoard;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // Period buttons
  const periodButtons = document.querySelectorAll('[data-period-choice]');
  periodButtons.forEach(b => {
    const choice = b.getAttribute('data-period-choice');
    const active = choice === currentPeriodChoice;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Date picker box
  const dateBox = document.getElementById('period-date-picker-box');
  const dateInput = document.getElementById('input-leaderboard-date');
  const dateError = document.getElementById('leaderboard-date-error');
  if (dateInput) {
    dateInput.setAttribute('min', MIN_LEADERBOARD_DATE);
    dateInput.setAttribute('max', todayIST);
    if (currentCustomDate && dateInput.value !== currentCustomDate) {
      dateInput.value = currentCustomDate;
    }
  }
  if (dateBox) {
    dateBox.style.display = currentPeriodChoice === 'date' ? 'inline-flex' : 'none';
  }
  if (dateError && currentPeriodChoice !== 'date') {
    dateError.style.display = 'none';
    dateError.textContent = '';
  }

  // Admin level dropdown
  const levelSelect = document.getElementById('select-leaderboard-level');
  if (isAdmin && levelSelect && levelSelect.value !== currentLevel) {
    const hasOpt = Array.from(levelSelect.options).some(o => o.value === currentLevel);
    if (hasOpt) {
      levelSelect.value = currentLevel;
    } else {
      currentLevel = 'all';
      levelSelect.value = 'all';
    }
  }
}

/**
 * Updates the student scope segmented control buttons and visibility.
 */
function syncScopeControlsUI() {
  const scopeContainer = document.getElementById('student-scope-controls');
  const btnLevel = document.getElementById('btn-scope-level');
  const btnGlobal = document.getElementById('btn-scope-global');

  if (isAdmin) {
    if (scopeContainer) scopeContainer.style.display = 'none';
    return;
  }

  if (btnLevel) {
    btnLevel.textContent = scopeLabel(currentProfile?.level, 'level');
    const isLevelActive = currentScope === 'level';
    btnLevel.classList.toggle('active', isLevelActive);
    btnLevel.setAttribute('aria-pressed', isLevelActive ? 'true' : 'false');
  }

  if (btnGlobal) {
    btnGlobal.textContent = scopeLabel(currentProfile?.level, 'global');
    btnGlobal.style.display = globalEnabled ? '' : 'none';
    const isGlobalActive = currentScope === 'global' && globalEnabled;
    btnGlobal.classList.toggle('active', isGlobalActive);
    btnGlobal.setAttribute('aria-pressed', isGlobalActive ? 'true' : 'false');
  }

  if (scopeContainer) {
    scopeContainer.style.display = 'inline-flex';
  }
}

/**
 * Renders the <thead> columns for the 5-column task speed board, 5-column weekly tests board, or 3-column standard board.
 * @param {boolean} isTaskSpeedBoard
 * @param {boolean} [isWeeklyTestsBoard=false]
 */
function renderTableHeader(isTaskSpeedBoard, isWeeklyTestsBoard = false) {
  const thead = document.getElementById('leaderboard-table-head');
  if (!thead) return;

  if (isWeeklyTestsBoard) {
    thead.innerHTML = `
      <tr>
        <th style="width: 90px;">Rank</th>
        <th>Student</th>
        <th style="text-align: right;">Points</th>
        <th style="text-align: right;">Correct of attempted</th>
        <th style="text-align: right;">Time</th>
      </tr>
    `;
  } else if (isTaskSpeedBoard) {
    thead.innerHTML = `
      <tr>
        <th style="width: 90px;">Rank</th>
        <th>Student</th>
        <th style="text-align: right;">Best</th>
        <th style="text-align: right;">Best round</th>
        <th style="text-align: right;">Rounds</th>
      </tr>
    `;
  } else {
    thead.innerHTML = `
      <tr>
        <th style="width: 90px;">Rank</th>
        <th>Student</th>
        <th id="th-board-value" style="text-align: right;">${escapeHtml(getValueColumnHeader(currentBoard))}</th>
      </tr>
    `;
  }
}

/**
 * Updates the "How it works" explanation banner, unavailable task banner, and card headings
 * for the active board/period/scope/task.
 */
function updateBoardChrome() {
  syncToolbarControlsUI();

  // 1. Show or hide the period selector (visible for 'points', 'weekly_tests', 'practice_days', and 'todo')
  const periodWrapper = document.getElementById('period-switch-wrapper');
  const usesPeriod = boardUsesPeriod(currentBoard);
  if (periodWrapper) {
    periodWrapper.style.display = usesPeriod ? 'flex' : 'none';
  }

  // 1b. Show or hide the Daily To-Do Task filter bar
  renderTodoTaskFilterUI();

  const selectedTaskOpt = currentBoard === 'todo' ? getSelectedTaskOption() : null;
  const isTaskSpeedBoard = Boolean(selectedTaskOpt && isSpeedRankableTask(selectedTaskOpt));
  const isWeeklyTestsBoard = currentBoard === 'weekly_tests';
  const isNonSpeedTaskSelected = Boolean(selectedTaskOpt && !isTaskSpeedBoard);

  // 2. Show or hide the "Speed ranking is not available for this kind of task yet." notice
  const unavailableBanner = document.getElementById('todo-task-unavailable-banner');
  const unavailableText = document.getElementById('todo-task-unavailable-text');
  if (unavailableBanner) {
    if (currentBoard === 'todo' && isNonSpeedTaskSelected) {
      if (unavailableText) {
        unavailableText.textContent = TASK_SPEED_UNAVAILABLE_MESSAGE;
      }
      unavailableBanner.style.display = 'flex';
    } else {
      unavailableBanner.style.display = 'none';
    }
  }

  // 3. Update "How it works" explanation
  const howItWorksEl = document.getElementById('how-it-works-text');
  if (howItWorksEl) {
    if (isWeeklyTestsBoard) {
      howItWorksEl.textContent = WEEKLY_TEST_BOARD_EXPLANATION;
    } else if (isTaskSpeedBoard) {
      howItWorksEl.textContent = TASK_SPEED_EXPLANATION_TEXT;
    } else {
      howItWorksEl.textContent = buildHowItWorksText(currentBoard, competitionRules, { isTaskSpeedBoard });
    }
  }

  // 4. Determine scope label for card header & badge
  let activeScopeLabel = '';
  if (isAdmin) {
    activeScopeLabel =
      currentLevel === 'all' || !currentLevel
        ? 'All levels (up to 200 rows)'
        : `${currentLevel} (up to 200 rows)`;
  } else {
    activeScopeLabel = scopeLabel(currentProfile?.level, currentScope);
  }

  // 5. Update card title ("<task title> - <period label> - <scope or level>") & exact range next to title
  const activeTaskTitle = selectedTaskOpt ? selectedTaskOpt.title : null;
  const cardTitleEl = document.getElementById('board-card-title');
  if (cardTitleEl) {
    cardTitleEl.textContent = boardTitle(
      currentBoard,
      currentPeriod,
      isAdmin ? activeScopeLabel : currentScope,
      currentProfile?.level,
      activeTaskTitle,
      todayIST
    );
  }

  const periodRangeEl = document.getElementById('board-period-range');
  if (periodRangeEl) {
    if (usesPeriod) {
      periodRangeEl.textContent = periodLabel(currentPeriod, todayIST);
      periodRangeEl.style.display = 'inline-flex';
    } else {
      periodRangeEl.textContent = '';
      periodRangeEl.style.display = 'none';
    }
  }

  // 6. Update table headers
  renderTableHeader(isTaskSpeedBoard, isWeeklyTestsBoard);

  // 7. Update scope badge
  const scopeBadgeEl = document.getElementById('board-scope-badge');
  if (scopeBadgeEl) {
    scopeBadgeEl.textContent = activeScopeLabel;
  }

  syncScopeControlsUI();
}

/**
 * Populates the Admin Level Filter dropdown with distinct levels from student profiles.
 */
async function populateAdminLevelsDropdown() {
  const selectEl = document.getElementById('select-leaderboard-level');
  if (!selectEl) return;

  const defaultLevels = ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Master'];
  const levelSet = new Set(defaultLevels);

  try {
    let profiles = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data } = await supabase
          .from('profiles')
          .select('level')
          .eq('role', 'student');
        profiles = data || [];
      }
    } else {
      profiles = DemoDB.getStudents();
    }

    profiles.forEach(p => {
      if (p.level && String(p.level).trim()) {
        levelSet.add(String(p.level).trim());
      }
    });
  } catch {
    // Keep default level options if profile query fails
  }

  const sortedLevels = Array.from(levelSet);
  selectEl.innerHTML =
    `<option value="all">All levels</option>` +
    sortedLevels
      .map(lvl => `<option value="${escapeHtml(lvl)}">${escapeHtml(lvl)}</option>`)
      .join('');
}

/**
 * Renders loading skeleton rows in the leaderboard table.
 * @param {number} [colSpan=3]
 */
function renderSkeleton(colSpan = 3) {
  const tbody = document.getElementById('leaderboard-table-body');
  const emptyState = document.getElementById('leaderboard-empty-state');
  const errorBanner = document.getElementById('leaderboard-error-banner');
  const tableEl = document.getElementById('leaderboard-table');

  if (errorBanner) errorBanner.style.display = 'none';
  if (emptyState) emptyState.style.display = 'none';
  if (tableEl) tableEl.style.display = 'table';

  if (tbody) {
    tbody.innerHTML = Array.from({ length: 5 })
      .map(
        () => `
        <tr>
          <td colspan="${colSpan}"><div class="skeleton-row" style="margin-bottom: 0;"></div></td>
        </tr>
      `
      )
      .join('');
  }
}

/**
 * Builds the Rank cell HTML (`#1`, `#2`, `#3`... strictly from row.rank).
 * @param {number} rankNum
 * @returns {string}
 */
function buildRankCellHtml(rankNum) {
  if (rankNum === 1) {
    return `<span class="num" style="font-weight: 700; color: #b45309;">#1</span>`;
  }
  if (rankNum === 2) {
    return `<span class="num" style="font-weight: 700; color: #475569;">#2</span>`;
  }
  if (rankNum === 3) {
    return `<span class="num" style="font-weight: 700; color: #9a3412;">#3</span>`;
  }
  return `<span class="num" style="font-weight: 700; color: var(--text-main);">#${escapeHtml(rankNum)}</span>`;
}

/**
 * Builds the Student cell HTML (with level chip in global scope and "You" badge for own row).
 * @param {Object} row
 * @returns {string}
 */
function buildStudentCellHtml(row) {
  const isMe = row.is_me;
  let nameCellHtml = `<span style="font-weight: ${isMe ? '700' : '600'}; color: var(--text-main);">${escapeHtml(row.display_name)}</span>`;
  if (isAdmin && row.student_id) {
    nameCellHtml = `
      <a
        href="/pages/student-detail.html?id=${encodeURIComponent(row.student_id)}"
        style="font-weight: 600; color: var(--color-primary); text-decoration: none;"
      >
        ${escapeHtml(row.display_name)}
      </a>
    `;
  }

  const levelChipHtml =
    row.show_level_chip && row.level
      ? `<span class="badge badge-neutral" style="margin-left: 8px;">${escapeHtml(row.level)}</span>`
      : '';

  const youBadgeHtml = isMe
    ? `<span class="badge badge-neutral" style="margin-left: 8px;">You</span>`
    : '';

  return `
    <div style="display: inline-flex; align-items: center; flex-wrap: wrap;">
      ${nameCellHtml}
      ${levelChipHtml}
      ${youBadgeHtml}
    </div>
  `;
}

/**
 * Fetches and renders the active leaderboard from RPC `leaderboard()`, `weekly_test_leaderboard()`, or `todo_task_leaderboard()`.
 */
async function loadActiveBoard() {
  if (currentBoard === 'todo' && todoTaskOptions.length === 0) {
    await syncTodoTaskFilterOptions();
  }

  persistLeaderboardState();
  updateBoardChrome();

  const selectedTaskOpt = currentBoard === 'todo' ? getSelectedTaskOption() : null;
  const isTaskSpeedBoard = Boolean(selectedTaskOpt && isSpeedRankableTask(selectedTaskOpt));
  const isWeeklyTestsBoard = currentBoard === 'weekly_tests';
  const colSpan = isTaskSpeedBoard || isWeeklyTestsBoard ? 5 : 3;

  renderSkeleton(colSpan);

  const tbody = document.getElementById('leaderboard-table-body');
  const emptyState = document.getElementById('leaderboard-empty-state');
  const emptyTitle = document.getElementById('leaderboard-empty-title');
  const emptyDesc = document.getElementById('leaderboard-empty-desc');
  const errorBanner = document.getElementById('leaderboard-error-banner');
  const errorMsgEl = document.getElementById('leaderboard-error-message');
  const tableEl = document.getElementById('leaderboard-table');

  try {
    const effectivePeriod = boardUsesPeriod(currentBoard) ? currentPeriod : 'week';
    const effectiveLevel = isAdmin ? (currentLevel === 'all' ? 'all' : currentLevel) : null;
    const effectiveLimit = isAdmin ? 200 : 10;
    const effectiveScope = isAdmin
      ? currentLevel === 'all'
        ? 'global'
        : 'level'
      : currentScope;

    if (isWeeklyTestsBoard) {
      const rawWtRows = await fetchWeeklyTestLeaderboard(
        {
          testId: null,
          period: effectivePeriod,
          level: effectiveLevel,
          limit: effectiveLimit,
          scope: effectiveScope
        },
        currentProfile
      );

      const mappedWtRows = mapWeeklyTestLeaderboardRows(rawWtRows, {
        scope: effectiveScope,
        isAdmin
      });

      if (mappedWtRows.length === 0) {
        if (tbody) tbody.innerHTML = '';
        if (tableEl) tableEl.style.display = 'none';
        if (emptyTitle) {
          emptyTitle.textContent = 'No weekly test rankings yet';
        }
        if (emptyDesc) {
          emptyDesc.textContent = getLeaderboardEmptyMessage('weekly_tests', effectivePeriod);
        }
        if (emptyState) emptyState.style.display = 'flex';
        return;
      }

      if (emptyState) emptyState.style.display = 'none';
      if (tableEl) tableEl.style.display = 'table';

      const htmlRows = [];
      mappedWtRows.forEach(row => {
        const isMe = row.is_me;
        if (row.is_outside_top_10) {
          htmlRows.push(`
            <tr class="section-divider-row" aria-label="Your rank outside top 10">
              <th colspan="5" style="text-align: center; font-size: var(--text-sm); color: var(--text-muted);">
                &bull; &bull; &bull; Your Rank &bull; &bull; &bull;
              </th>
            </tr>
          `);
        }

        const rowStyle = isMe
          ? 'background-color: var(--color-primary-subtle); font-weight: 700;'
          : '';

        htmlRows.push(`
          <tr style="${rowStyle}" data-is-me="${isMe ? 'true' : 'false'}">
            <td>${buildRankCellHtml(row.rank)}</td>
            <td>${buildStudentCellHtml(row)}</td>
            <td class="num" style="text-align: right; font-weight: 700; color: ${isMe ? 'var(--color-primary)' : 'var(--text-main)'};">
              ${escapeHtml(row.formatted_points)}
            </td>
            <td class="num" style="text-align: right; color: var(--text-main);">
              ${escapeHtml(row.formatted_score)}
            </td>
            <td class="num" style="text-align: right; color: var(--text-muted);">
              ${escapeHtml(row.formatted_time)}
            </td>
          </tr>
        `);
      });

      if (tbody) {
        tbody.innerHTML = htmlRows.join('');
      }
      return;
    }

    if (isTaskSpeedBoard && selectedTaskOpt) {
      const rawTaskRows = await fetchTodoTaskLeaderboard(
        {
          taskId: selectedTaskOpt.id,
          period: effectivePeriod,
          level: effectiveLevel,
          limit: effectiveLimit,
          scope: effectiveScope
        },
        currentProfile
      );

      const mappedTaskRows = mapTaskLeaderboardRows(rawTaskRows, {
        scope: effectiveScope,
        isAdmin
      });

      if (mappedTaskRows.length === 0) {
        if (tbody) tbody.innerHTML = '';
        if (tableEl) tableEl.style.display = 'none';
        if (emptyTitle) {
          emptyTitle.textContent = TASK_SPEED_EMPTY_MESSAGE;
        }
        if (emptyDesc) {
          emptyDesc.textContent = TASK_SPEED_EXPLANATION_TEXT;
        }
        if (emptyState) emptyState.style.display = 'flex';
        return;
      }

      if (emptyState) emptyState.style.display = 'none';
      if (tableEl) tableEl.style.display = 'table';

      const htmlRows = [];
      mappedTaskRows.forEach(row => {
        const isMe = row.is_me;
        if (row.is_outside_top_10) {
          htmlRows.push(`
            <tr class="section-divider-row" aria-label="Your rank outside top 10">
              <th colspan="5" style="text-align: center; font-size: var(--text-sm); color: var(--text-muted);">
                &bull; &bull; &bull; Your Rank &bull; &bull; &bull;
              </th>
            </tr>
          `);
        }

        const rowStyle = isMe
          ? 'background-color: var(--color-primary-subtle); font-weight: 700;'
          : '';

        htmlRows.push(`
          <tr style="${rowStyle}" data-is-me="${isMe ? 'true' : 'false'}">
            <td>${buildRankCellHtml(row.rank)}</td>
            <td>${buildStudentCellHtml(row)}</td>
            <td class="num" style="text-align: right; font-weight: 700; color: ${isMe ? 'var(--color-primary)' : 'var(--text-main)'};">
              ${escapeHtml(row.formatted_best)}
            </td>
            <td class="num" style="text-align: right; color: var(--text-main);">
              ${escapeHtml(row.formatted_best_round)}
            </td>
            <td class="num" style="text-align: right; color: var(--text-muted);">
              ${escapeHtml(row.formatted_rounds)}
            </td>
          </tr>
        `);
      });

      if (tbody) {
        tbody.innerHTML = htmlRows.join('');
      }
      return;
    }

    // Standard 3-column leaderboard (including "All tasks" and fallback for non-basics/no-category tasks)
    const rawRows = await fetchLeaderboard(
      {
        board: currentBoard,
        period: effectivePeriod,
        level: effectiveLevel,
        limit: effectiveLimit,
        scope: effectiveScope
      },
      currentProfile
    );

    const mappedRows = mapLeaderboardRows(rawRows, {
      board: currentBoard,
      scope: effectiveScope,
      isAdmin
    });

    if (mappedRows.length === 0) {
      if (tbody) tbody.innerHTML = '';
      if (tableEl) tableEl.style.display = 'none';
      if (emptyTitle) {
        emptyTitle.textContent = `No ${getBoardLabel(currentBoard).toLowerCase()} rankings yet`;
      }
      if (emptyDesc) {
        emptyDesc.textContent = getLeaderboardEmptyMessage(currentBoard, effectivePeriod, {
          isTaskSpeedBoard: false
        });
      }
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableEl) tableEl.style.display = 'table';

    const htmlRows = [];
    mappedRows.forEach(row => {
      const isMe = row.is_me;

      if (row.is_outside_top_10) {
        htmlRows.push(`
          <tr class="section-divider-row" aria-label="Your rank outside top 10">
            <th colspan="3" style="text-align: center; font-size: var(--text-sm); color: var(--text-muted);">
              &bull; &bull; &bull; Your Rank &bull; &bull; &bull;
            </th>
          </tr>
        `);
      }

      const rowStyle = isMe
        ? 'background-color: var(--color-primary-subtle); font-weight: 700;'
        : '';

      htmlRows.push(`
        <tr style="${rowStyle}" data-is-me="${isMe ? 'true' : 'false'}">
          <td>${buildRankCellHtml(row.rank)}</td>
          <td>${buildStudentCellHtml(row)}</td>
          <td class="num" style="text-align: right; font-weight: 700; color: ${isMe ? 'var(--color-primary)' : 'var(--text-main)'};">
            ${escapeHtml(row.formatted_value)}
          </td>
        </tr>
      `);
    });

    if (tbody) {
      tbody.innerHTML = htmlRows.join('');
    }
  } catch (err) {
    const errMsg = err?.message || 'Unable to load leaderboard rankings right now.';
    // When a request fails with the "switched off" message, show that message and fall back to the level scope
    if (!isAdmin && currentScope === 'global' && errMsg.toLowerCase().includes('switched off')) {
      showToast('info', 'The global leaderboard is switched off.');
      globalEnabled = false;
      currentScope = 'level';
      writeStoredScope('level');
      await syncTodoTaskFilterOptions();
      await loadActiveBoard();
      return;
    }

    console.error('Error loading leaderboard:', err);
    if (tbody) tbody.innerHTML = '';
    if (tableEl) tableEl.style.display = 'none';
    if (errorMsgEl) {
      errorMsgEl.textContent = errMsg;
    }
    if (errorBanner) errorBanner.style.display = 'flex';
  }
}

/**
 * Sets up board tabs, period selector, date input, task filter, student scope switch, and admin level selector listeners.
 */
function setupControls() {
  // Board Tabs
  const boardButtons = document.querySelectorAll('[data-board]');
  boardButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetBoard = btn.getAttribute('data-board');
      if (!targetBoard || targetBoard === currentBoard) return;

      currentBoard = targetBoard;
      if (currentBoard === 'todo') {
        await syncTodoTaskFilterOptions();
      }
      loadActiveBoard();
    });
  });

  // Daily To-Do Task Dropdown
  const taskSelectEl = document.getElementById('select-todo-task');
  if (taskSelectEl) {
    taskSelectEl.addEventListener('change', () => {
      const chosenId = taskSelectEl.value || 'all';
      if (chosenId === currentTaskId) return;
      currentTaskId = chosenId;
      renderTodoTaskFilterUI();
      loadActiveBoard();
    });
  }

  // Daily To-Do Task Quick Chip Buttons (All tasks + each task)
  const taskPillsEl = document.getElementById('todo-task-pills');
  if (taskPillsEl) {
    taskPillsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-todo-task-id]');
      if (!btn) return;
      const chosenId = btn.getAttribute('data-todo-task-id') || 'all';
      if (chosenId === currentTaskId) return;
      currentTaskId = chosenId;
      renderTodoTaskFilterUI();
      loadActiveBoard();
    });
  }

  // Period Selector Buttons (Today, Yesterday, This week, This month, This year, All time, Pick a date)
  const periodButtons = document.querySelectorAll('[data-period-choice]');
  const dateInput = document.getElementById('input-leaderboard-date');
  const dateError = document.getElementById('leaderboard-date-error');

  periodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-period-choice');
      if (!choice) return;

      if (dateError) {
        dateError.style.display = 'none';
        dateError.textContent = '';
      }

      if (choice === 'date') {
        currentPeriodChoice = 'date';
        const candidateDate = dateInput?.value || currentCustomDate || todayIST;
        const check = validatePeriodDate(candidateDate, todayIST);
        const validDate = check.valid ? check.dateText : todayIST;
        currentCustomDate = validDate;
        if (dateInput) dateInput.value = validDate;
        const resolved = periodValue('date', validDate, todayIST);
        if (resolved) {
          currentPeriod = resolved;
        }
        loadActiveBoard();
        return;
      }

      const resolved = periodValue(choice, '', todayIST);
      if (!resolved) return;
      if (choice === currentPeriodChoice && resolved === currentPeriod) return;

      currentPeriodChoice = choice;
      currentPeriod = resolved;
      loadActiveBoard();
    });
  });

  // Custom Date Input (India time, min 2020-01-01, max todayIST)
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const rawDate = dateInput.value;
      const check = validatePeriodDate(rawDate, todayIST);
      if (!check.valid) {
        if (dateError) {
          dateError.textContent = check.error || 'Enter a valid date.';
          dateError.style.display = 'inline-block';
        }
        return;
      }
      if (dateError) {
        dateError.textContent = '';
        dateError.style.display = 'none';
      }
      currentCustomDate = check.dateText;
      currentPeriodChoice = 'date';
      const resolved = periodValue('date', check.dateText, todayIST);
      if (resolved) {
        currentPeriod = resolved;
        loadActiveBoard();
      }
    });
  }

  // Student Scope Switch ('level' | 'global')
  const scopeButtons = document.querySelectorAll('[data-scope]');
  scopeButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetScope = btn.getAttribute('data-scope');
      if (!targetScope || targetScope === currentScope) return;
      if (targetScope === 'global' && !globalEnabled) return;

      currentScope = targetScope === 'global' ? 'global' : 'level';
      writeStoredScope(currentScope);
      syncScopeControlsUI();
      if (currentBoard === 'todo') {
        await syncTodoTaskFilterOptions();
      }
      loadActiveBoard();
    });
  });

  // Admin Level Filter
  const levelSelect = document.getElementById('select-leaderboard-level');
  if (levelSelect) {
    levelSelect.addEventListener('change', async () => {
      currentLevel = levelSelect.value || 'all';
      if (currentBoard === 'todo') {
        await syncTodoTaskFilterOptions();
      }
      loadActiveBoard();
    });
  }

  // Retry button
  document.getElementById('btn-retry-leaderboard')?.addEventListener('click', () => {
    loadActiveBoard();
  });
}

async function initLeaderboardPage() {
  // 1. Logged-in guard (both students and admins allowed)
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;

  currentProfile = profile;
  isAdmin = profile.role === 'admin';
  todayIST = getISTDateYMD();

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  // 2. Restore board, period, task, and level from localStorage & URL query parameters
  let desiredScope = readStoredScope();
  try {
    const params = new URLSearchParams(window.location.search);
    const urlScope = params.get('scope');
    if (urlScope === 'global' || urlScope === 'level') {
      desiredScope = urlScope;
    }
  } catch {
    // Ignore URL parse issues
  }
  if (!isAdmin) {
    currentScope = desiredScope === 'global' ? 'global' : 'level';
  }
  restoreInitialSelections();

  // 3. Configure Admin vs Student controls & wire UI listeners
  if (isAdmin) {
    const adminControls = document.getElementById('admin-leaderboard-controls');
    if (adminControls) adminControls.style.display = 'flex';
    setupAdminNav();
  } else {
    syncScopeControlsUI();
  }
  setupControls();

  // 4. Load role-specific scope/levels, competition_rules(), and initial board in parallel
  try {
    const roleSetupPromise = isAdmin
      ? populateAdminLevelsDropdown()
      : fetchGlobalLeaderboardEnabled().catch(() => false);

    const [roleResult, rules] = await Promise.all([
      roleSetupPromise,
      fetchCompetitionRules().catch(() => competitionRules),
      loadActiveBoard()
    ]);

    if (!isAdmin) {
      globalEnabled = Boolean(roleResult);
      if (!globalEnabled && currentScope === 'global') {
        currentScope = 'level';
        writeStoredScope('level');
        syncScopeControlsUI();
        await loadActiveBoard();
      } else {
        writeStoredScope(currentScope);
        syncScopeControlsUI();
      }
    }

    if (rules) {
      competitionRules = rules;
      updateBoardChrome();
    }
  } catch (err) {
    console.error('Failed to initialize leaderboard page:', err);
  }
}

document.addEventListener('DOMContentLoaded', initLeaderboardPage);
