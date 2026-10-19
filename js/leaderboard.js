/**
 * Trendz Tracker - Leaderboard Controller (js/leaderboard.js)
 *
 * Serves both Students and Admins on /pages/leaderboard.html:
 * - Guard: requireAuth(['student', 'admin'])
 * - Student view: own level only, top 10 + own row below top 10 if outside it, "You" highlight, no links.
 * - Admin view: level filter ('all' or specific level from profiles), up to 200 rows,
 *   names link to /pages/student-detail.html?id=<student_id>, no "You" highlight.
 * - Never calculates points, ranks, or streaks in JavaScript; strictly uses RPCs
 *   `leaderboard(p_board, p_period, p_level, p_limit)` and `competition_rules()`.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import {
  fetchLeaderboard,
  fetchCompetitionRules,
  formatLeaderboardValue,
  buildHowItWorksText,
  getLeaderboardEmptyMessage
} from './leaderboardData.js';
import { setupAdminNav } from './modal.js';
import { getSupabase, DemoDB } from './supabaseClient.js';

let currentProfile = null;
let isAdmin = false;
let currentBoard = 'points'; // 'points' | 'streak' | 'practice_days' | 'improved'
let currentPeriod = 'week'; // 'week' | 'month' | 'all'
let currentLevel = 'all'; // used by admin only
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

function getBoardLabel(board) {
  switch (board) {
    case 'points':
      return 'Points';
    case 'streak':
      return 'Streak';
    case 'practice_days':
      return 'Practice days';
    case 'improved':
      return 'Most improved';
    default:
      return 'Leaderboard';
  }
}

function getPeriodLabel(period) {
  switch (period) {
    case 'week':
      return 'This week';
    case 'month':
      return 'This month';
    case 'all':
      return 'All time';
    default:
      return 'This week';
  }
}

function getValueColumnHeader(board) {
  switch (board) {
    case 'points':
      return 'Points';
    case 'streak':
      return 'Streak';
    case 'practice_days':
      return 'Practice days';
    case 'improved':
      return 'Accuracy Gain';
    default:
      return 'Value';
  }
}

/**
 * Updates the "How it works" explanation banner and card headings for the active board/period.
 */
function updateBoardChrome() {
  // 1. Show or hide the period switch (only visible for 'points' and 'practice_days')
  const periodWrapper = document.getElementById('period-switch-wrapper');
  const usesPeriod = currentBoard === 'points' || currentBoard === 'practice_days';
  if (periodWrapper) {
    periodWrapper.style.display = usesPeriod ? 'inline-flex' : 'none';
  }

  // 2. Update "How it works" explanation from competition_rules()
  const howItWorksEl = document.getElementById('how-it-works-text');
  if (howItWorksEl) {
    howItWorksEl.textContent = buildHowItWorksText(currentBoard, competitionRules);
  }

  // 3. Update card title & value column header
  const cardTitleEl = document.getElementById('board-card-title');
  if (cardTitleEl) {
    const boardTitle = getBoardLabel(currentBoard);
    cardTitleEl.textContent = usesPeriod
      ? `${boardTitle} — ${getPeriodLabel(currentPeriod)}`
      : boardTitle;
  }

  const thValueEl = document.getElementById('th-board-value');
  if (thValueEl) {
    thValueEl.textContent = getValueColumnHeader(currentBoard);
  }

  // 4. Update scope badge
  const scopeBadgeEl = document.getElementById('board-scope-badge');
  if (scopeBadgeEl) {
    if (isAdmin) {
      scopeBadgeEl.textContent =
        currentLevel === 'all' || !currentLevel
          ? 'All Levels (up to 200 rows)'
          : `${currentLevel} (up to 200 rows)`;
    } else {
      scopeBadgeEl.textContent = currentProfile?.level
        ? `${currentProfile.level} (Your level only)`
        : 'Your level only';
    }
  }
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
    const effectivePeriod =
      currentBoard === 'streak' || currentBoard === 'improved' ? 'week' : currentPeriod;
    const effectiveLevel = isAdmin ? (currentLevel === 'all' ? 'all' : currentLevel) : null;
    const effectiveLimit = isAdmin ? 200 : 10;

    const rows = await fetchLeaderboard(
      {
        board: currentBoard,
        period: effectivePeriod,
        level: effectiveLevel,
        limit: effectiveLimit
      },
      currentProfile
    );

    if (!rows || rows.length === 0) {
      if (tbody) tbody.innerHTML = '';
      if (tableEl) tableEl.style.display = 'none';
      if (emptyTitle) emptyTitle.textContent = `No ${getBoardLabel(currentBoard).toLowerCase()} rankings yet`;
      if (emptyDesc) emptyDesc.textContent = getLeaderboardEmptyMessage(currentBoard, effectivePeriod);
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableEl) tableEl.style.display = 'table';

    const htmlRows = [];

    rows.forEach((row, index) => {
      const rankNum = Number(row.rank);
      // Do NOT show the "You" highlight for admins
      const isMe = !isAdmin && row.is_me === true;
      const isOutsideTop10 = !isAdmin && isMe && (rankNum > 10 || index >= 10);

      // If the student is outside the top 10, insert a clear visual separator row before their row
      if (isOutsideTop10) {
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
              ${youBadgeHtml}
            </div>
          </td>
          <td class="num" style="text-align: right; font-weight: 700; color: ${isMe ? 'var(--color-primary)' : 'var(--text-main)'};">
            ${escapeHtml(formatLeaderboardValue(currentBoard, row.value))}
          </td>
        </tr>
      `);
    });

    if (tbody) {
      tbody.innerHTML = htmlRows.join('');
    }
  } catch (err) {
    console.error('Error loading leaderboard:', err);
    if (tbody) tbody.innerHTML = '';
    if (errorMsgEl) {
      errorMsgEl.textContent = err.message || 'Unable to load leaderboard rankings right now.';
    }
    if (errorBanner) errorBanner.style.display = 'flex';
  }
}

/**
 * Sets up board tabs, period switch, and admin level selector listeners.
 */
function setupControls() {
  // Board Tabs
  const boardButtons = document.querySelectorAll('[data-board]');
  boardButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetBoard = btn.getAttribute('data-board');
      if (!targetBoard || targetBoard === currentBoard) return;

      currentBoard = targetBoard;
      boardButtons.forEach(b => {
        const active = b.getAttribute('data-board') === currentBoard;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });

      loadActiveBoard();
    });
  });

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

  // Admin Level Filter
  const levelSelect = document.getElementById('select-leaderboard-level');
  if (levelSelect) {
    levelSelect.addEventListener('change', () => {
      currentLevel = levelSelect.value || 'all';
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
