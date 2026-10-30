/**
 * Trendz Tracker - Leaderboard Controller (js/leaderboard.js)
 *
 * Serves both Students and Admins on /pages/leaderboard.html:
 * - Guard: requireAuth(['student', 'admin'])
 * - Student view: scope switch between own level ('level') and all trainees ('global'),
 *   top 10 + own row below top 10 if outside it, "You" highlight, level chip in global mode, no links.
 * - Admin view: level filter ('all' or specific level from profiles), up to 200 rows,
 *   names link to /pages/student-detail.html?id=<student_id>, no "You" highlight.
 * - Never calculates points, ranks, task days, or streaks in JavaScript; strictly uses RPCs
 *   `leaderboard(p_board, p_period, p_level, p_limit, p_scope)`, `global_leaderboard_enabled()`, and `competition_rules()`.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import {
  fetchLeaderboard,
  fetchTodoLeaderboardTasks,
  fetchGlobalLeaderboardEnabled,
  fetchCompetitionRules,
  buildHowItWorksText,
  getLeaderboardEmptyMessage
} from './leaderboardData.js';
import {
  BOARD_LABELS,
  boardUsesPeriod,
  scopeLabel,
  boardTitle,
  formatTaskFilterOptions,
  mapLeaderboardRows
} from './leaderboardView.js';
import { setupAdminNav } from './modal.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { showToast } from './toast.js';

const SCOPE_STORAGE_KEY = 'trendz_leaderboard_scope_v1';

let currentProfile = null;
let isAdmin = false;
let currentBoard = 'points'; // 'points' | 'streak' | 'practice_days' | 'todo' | 'improved'
let currentPeriod = 'week'; // 'week' | 'month' | 'all'
let currentLevel = 'all'; // used by admin only
let currentScope = 'level'; // 'level' | 'global' (used by students)
let todoTaskOptions = []; // [{ id, taskNumber, shortLabel, optionLabel, title, section, level }]
let currentTaskId = null;
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
      return 'Fastest time';
    case 'improved':
      return 'Accuracy Gain';
    default:
      return 'Value';
  }
}

function getSelectedTaskOption() {
  if (!Array.isArray(todoTaskOptions) || todoTaskOptions.length === 0) return null;
  return (
    todoTaskOptions.find(opt => String(opt.id) === String(currentTaskId)) ||
    todoTaskOptions[0]
  );
}

/**
 * Loads and renders the Task 1, Task 2, Task 3... filter controls for the Daily To-Do Leaderboard.
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

  if (todoTaskOptions.length > 0) {
    const stillExists = todoTaskOptions.some(opt => String(opt.id) === String(currentTaskId));
    if (!stillExists) {
      currentTaskId = todoTaskOptions[0].id;
    }
  } else {
    currentTaskId = null;
  }

  renderTodoTaskFilterUI();
}

/**
 * Renders the Task filter dropdown and quick Task 1 / Task 2 / Task 3 buttons.
 */
function renderTodoTaskFilterUI() {
  const wrapper = document.getElementById('todo-task-filter-wrapper');
  const selectEl = document.getElementById('select-todo-task');
  const pillsContainer = document.getElementById('todo-task-pills');
  const metaEl = document.getElementById('todo-selected-task-meta');

  if (!wrapper) return;

  if (currentBoard !== 'todo') {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = 'flex';

  if (todoTaskOptions.length === 0) {
    if (selectEl) {
      selectEl.innerHTML = '<option value="">No active daily tasks found</option>';
      selectEl.disabled = true;
    }
    if (pillsContainer) {
      pillsContainer.innerHTML = '';
      pillsContainer.style.display = 'none';
    }
    if (metaEl) {
      metaEl.textContent = 'No active daily tasks configured';
    }
    return;
  }

  const selectedOpt = getSelectedTaskOption();
  if (selectedOpt && currentTaskId !== selectedOpt.id) {
    currentTaskId = selectedOpt.id;
  }

  if (selectEl) {
    selectEl.disabled = false;
    selectEl.innerHTML = todoTaskOptions
      .map(
        opt =>
          `<option value="${escapeHtml(opt.id)}" ${String(opt.id) === String(currentTaskId) ? 'selected' : ''}>${escapeHtml(opt.optionLabel)}</option>`
      )
      .join('');
  }

  if (pillsContainer) {
    pillsContainer.style.display = 'flex';
    pillsContainer.innerHTML = todoTaskOptions
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
            ${escapeHtml(opt.shortLabel)}: ${escapeHtml(opt.title)}
          </button>
        `;
      })
      .join('');
  }

  if (metaEl && selectedOpt) {
    metaEl.textContent = `${selectedOpt.shortLabel} of ${todoTaskOptions.length} · Ranked fastest to slowest attempt`;
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
 * Updates the "How it works" explanation banner and card headings for the active board/period/scope.
 */
function updateBoardChrome() {
  // 1. Show or hide the period switch (visible for 'points', 'practice_days', and 'todo')
  const periodWrapper = document.getElementById('period-switch-wrapper');
  const usesPeriod = boardUsesPeriod(currentBoard);
  if (periodWrapper) {
    periodWrapper.style.display = usesPeriod ? 'inline-flex' : 'none';
  }

  // 1b. Show or hide the Daily To-Do Task filter bar
  renderTodoTaskFilterUI();

  // 2. Update "How it works" explanation
  const howItWorksEl = document.getElementById('how-it-works-text');
  if (howItWorksEl) {
    howItWorksEl.textContent = buildHowItWorksText(currentBoard, competitionRules);
  }

  // 3. Determine scope label for card header & badge
  let activeScopeLabel = '';
  if (isAdmin) {
    activeScopeLabel =
      currentLevel === 'all' || !currentLevel
        ? 'All levels (up to 200 rows)'
        : `${currentLevel} (up to 200 rows)`;
  } else {
    activeScopeLabel = scopeLabel(currentProfile?.level, currentScope);
  }

  // 4. Update card title & value column header
  const selectedTaskOpt = currentBoard === 'todo' ? getSelectedTaskOption() : null;
  const activeTaskLabel = selectedTaskOpt
    ? `${selectedTaskOpt.shortLabel}: ${selectedTaskOpt.title}`
    : null;

  const cardTitleEl = document.getElementById('board-card-title');
  if (cardTitleEl) {
    cardTitleEl.textContent = boardTitle(
      currentBoard,
      currentPeriod,
      isAdmin ? activeScopeLabel : currentScope,
      currentProfile?.level,
      activeTaskLabel
    );
  }

  const thValueEl = document.getElementById('th-board-value');
  if (thValueEl) {
    thValueEl.textContent = getValueColumnHeader(currentBoard);
  }

  // 5. Update scope badge
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
 */
function renderSkeleton() {
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
          <td colspan="3"><div class="skeleton-row" style="margin-bottom: 0;"></div></td>
        </tr>
      `
      )
      .join('');
  }
}

/**
 * Fetches and renders the active leaderboard from RPC `leaderboard()`.
 */
async function loadActiveBoard() {
  if (currentBoard === 'todo' && todoTaskOptions.length === 0) {
    await syncTodoTaskFilterOptions();
  }
  updateBoardChrome();
  renderSkeleton();

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

    const rawRows = await fetchLeaderboard(
      {
        board: currentBoard,
        period: effectivePeriod,
        level: effectiveLevel,
        limit: effectiveLimit,
        scope: effectiveScope,
        taskId: currentBoard === 'todo' ? currentTaskId : null
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
        const selectedTaskOpt = currentBoard === 'todo' ? getSelectedTaskOption() : null;
        emptyTitle.textContent =
          currentBoard === 'todo'
            ? selectedTaskOpt
              ? `No timed attempts yet for ${selectedTaskOpt.shortLabel}`
              : 'No task attempts yet'
            : `No ${getBoardLabel(currentBoard).toLowerCase()} rankings yet`;
      }
      if (emptyDesc) {
        emptyDesc.textContent = getLeaderboardEmptyMessage(currentBoard, effectivePeriod);
      }
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableEl) tableEl.style.display = 'table';

    const htmlRows = [];

    mappedRows.forEach(row => {
      const rankNum = row.rank;
      const isMe = row.is_me;

      // If the student is outside the top 10, insert a clear visual separator row before their row
      if (row.is_outside_top_10) {
        htmlRows.push(`
          <tr class="section-divider-row" aria-label="Your rank outside top 10">
            <th colspan="3" style="text-align: center; font-size: 11px; color: var(--text-muted); letter-spacing: 0.5px;">
              &bull; &bull; &bull; Your Rank &bull; &bull; &bull;
            </th>
          </tr>
        `);
      }

      // Rank badge styling (1st, 2nd, 3rd medals + tabular number)
      let rankBadge = `<span class="num" style="font-weight: 700; color: var(--text-main);">#${escapeHtml(rankNum)}</span>`;
      if (rankNum === 1) {
        rankBadge = `<span class="num" style="font-weight: 700; color: #b45309;">🥇 #1</span>`;
      } else if (rankNum === 2) {
        rankBadge = `<span class="num" style="font-weight: 700; color: #475569;">🥈 #2</span>`;
      } else if (rankNum === 3) {
        rankBadge = `<span class="num" style="font-weight: 700; color: #9a3412;">🥉 #3</span>`;
      }

      // Display name (links to student detail page for admins using student_id; plain text for students)
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

      const levelChipHtml = row.show_level_chip && row.level
        ? `<span class="badge badge-inactive" style="margin-left: 8px; font-size: 11px;">${escapeHtml(row.level)}</span>`
        : '';

      const youBadgeHtml = isMe
        ? `<span class="badge badge-active" style="margin-left: 8px;">You</span>`
        : '';

      const rowStyle = isMe
        ? 'background-color: var(--color-primary-subtle); font-weight: 700;'
        : '';

      htmlRows.push(`
        <tr style="${rowStyle}" data-is-me="${isMe ? 'true' : 'false'}">
          <td>${rankBadge}</td>
          <td>
            <div style="display: inline-flex; align-items: center; flex-wrap: wrap;">
              ${nameCellHtml}
              ${levelChipHtml}
              ${youBadgeHtml}
            </div>
          </td>
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
      showToast('info', errMsg);
      globalEnabled = false;
      currentScope = 'level';
      writeStoredScope('level');
      await syncTodoTaskFilterOptions();
      await loadActiveBoard();
      return;
    }

    console.error('Error loading leaderboard:', err);
    if (tbody) tbody.innerHTML = '';
    if (errorMsgEl) {
      errorMsgEl.textContent = errMsg;
    }
    if (errorBanner) errorBanner.style.display = 'flex';
  }
}

/**
 * Sets up board tabs, period switch, task filter, student scope switch, and admin level selector listeners.
 */
function setupControls() {
  // Board Tabs
  const boardButtons = document.querySelectorAll('[data-board]');
  boardButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetBoard = btn.getAttribute('data-board');
      if (!targetBoard || targetBoard === currentBoard) return;

      currentBoard = targetBoard;
      boardButtons.forEach(b => {
        const active = b.getAttribute('data-board') === currentBoard;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });

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
      const chosenId = taskSelectEl.value;
      if (!chosenId || chosenId === currentTaskId) return;
      currentTaskId = chosenId;
      renderTodoTaskFilterUI();
      loadActiveBoard();
    });
  }

  // Daily To-Do Task Quick Pill Buttons (Task 1, Task 2, Task 3...)
  const taskPillsEl = document.getElementById('todo-task-pills');
  if (taskPillsEl) {
    taskPillsEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-todo-task-id]');
      if (!btn) return;
      const chosenId = btn.getAttribute('data-todo-task-id');
      if (!chosenId || chosenId === currentTaskId) return;
      currentTaskId = chosenId;
      renderTodoTaskFilterUI();
      loadActiveBoard();
    });
  }

  // Period Switch
  const periodButtons = document.querySelectorAll('[data-period]');
  periodButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetPeriod = btn.getAttribute('data-period');
      if (!targetPeriod || targetPeriod === currentPeriod) return;

      currentPeriod = targetPeriod;
      periodButtons.forEach(b => {
        const active = b.getAttribute('data-period') === currentPeriod;
        b.classList.toggle('active', active);
      });

      loadActiveBoard();
    });
  });

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

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  // 2. Configure Navigation Bar for Student vs Admin
  if (isAdmin) {
    const studentNav = document.getElementById('student-nav-zone');
    const adminNav = document.getElementById('admin-nav-zone');
    const mobileMenuBtn = document.getElementById('btn-mobile-menu');
    const brandLink = document.getElementById('header-brand-link');
    const adminControls = document.getElementById('admin-leaderboard-controls');

    if (studentNav) studentNav.style.display = 'none';
    if (adminNav) adminNav.style.display = '';
    if (mobileMenuBtn) mobileMenuBtn.style.display = '';
    if (brandLink) brandLink.setAttribute('href', '/pages/admin.html');
    if (adminControls) adminControls.style.display = 'flex';

    setupAdminNav();
    await populateAdminLevelsDropdown();
  } else {
    // Student scope setup: check URL ?scope=global or localStorage, and check global_leaderboard_enabled()
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

    globalEnabled = await fetchGlobalLeaderboardEnabled().catch(() => false);
    if (!globalEnabled) {
      currentScope = 'level';
    } else {
      currentScope = desiredScope === 'global' ? 'global' : 'level';
      writeStoredScope(currentScope);
    }
    syncScopeControlsUI();
  }

  // 3. Wire UI listeners
  setupControls();

  // 4. Load competition_rules() and initial board in parallel
  try {
    const [rules] = await Promise.all([
      fetchCompetitionRules().catch(() => competitionRules),
      loadActiveBoard()
    ]);
    if (rules) {
      competitionRules = rules;
      updateBoardChrome();
    }
  } catch (err) {
    console.error('Failed to initialize leaderboard page:', err);
  }
}

document.addEventListener('DOMContentLoaded', initLeaderboardPage);
