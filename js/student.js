/**
 * Trendz Tracker - Student Dashboard Controller (js/student.js)
 * 
 * STRICT RULE:
 * /pages/student.html must NEVER read a student id from the URL or anywhere else.
 * It ALWAYS shows the logged-in student's own data.
 * 
 * Uses shared modules:
 * - js/dashboardData.js (fetchStudentDashboardData)
 * - js/dashboardComponents.js (streak, to-do list, basics, resources, score sheet, progress charts)
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { formatTodayHeadingIST } from './periods.js';
import { fetchStudentDashboardData } from './dashboardData.js';
import { groupTests, isSectionStartable } from './weeklyTestView.js';
import {
  renderStreakCard,
  renderTodaySummaryMetrics,
  renderTodoList,
  renderBasicsThisWeek,
  renderFlashThisWeek,
  renderResources,
  renderAttendanceCard,
  renderWeeklyTestsCard,
  setupScoreSheetController,
  setupProgressChartsController
} from './dashboardComponents.js';
import { loadAndRenderLeaderboardCard } from './leaderboardCard.js';
import { renderElementsCard } from './elementsCard.js';
import { renderMemoriadCard } from './memoriadCard.js';
import { fetchMyNotificationsCached } from './notificationBadge.js';
import {
  stageLabel,
  formatEventDateChipIST,
  sanitizeNotificationLink,
} from './notificationsView.js';

async function initStudentDashboard() {
  // 1. Guard check: Strictly for logged-in students (or admin viewing their own student record).
  // /pages/student.html must NEVER read a student id from the URL or anywhere else.
  // It always shows the logged-in student's own data.
  const loggedInProfile = await requireAuth(['student', 'admin']);
  if (!loggedInProfile) return;

  const currentStudentId = loggedInProfile.id;

  // Render header details
  renderHeaderUser(loggedInProfile);
  renderStudentHero(loggedInProfile);
  setupStudentHomeViewTabs();

  // Load Leaderboard summary card (Phase 5a), Available Weekly Test banner (Phase 13a), and compact reminders strip (Phase 13b)
  loadAndRenderLeaderboardCard('leaderboard-card-container', loggedInProfile);
  loadAndRenderAvailableWeeklyTestCard(currentStudentId);
  loadAndRenderHomeRemindersStrip(currentStudentId);

  // 2. Fetch and render all dashboard data using shared loader
  try {
    const data = await fetchStudentDashboardData(currentStudentId);

    // Date in "Today" Header (India time)
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatTodayHeadingIST(data.todayIST);

    // Today's Plan (To-Do List)
    renderTodoList(data.todos, 'todo-list-container', false, data.categories);

    // Compact Streak & Shield Card
    renderStreakCard(data.streak, data.todos);

    // Three Small 7-Day Summary Cards: Accuracy, Speed (q/min), Practice days
    renderTodaySummaryMetrics(data.results, data.activityResults, data.todayIST);

    // Basics Card
    renderBasicsThisWeek(data.results, data.categories, data.todayIST);

    // Flash Anzan Card (Phase 7)
    renderFlashThisWeek(data.activityResults, data.todayIST);

    // Elements Worksheet Drills Card (Phase 8)
    await renderElementsCard({
      studentId: currentStudentId,
      containerId: 'elements-week-container',
      isReadOnly: false,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults
    });

    // Memoriad Competition Practice Card (Phase 9b-1)
    await renderMemoriadCard({
      studentId: currentStudentId,
      containerId: 'memoriad-week-container',
      isReadOnly: false,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults
    });

    // Attendance Card (Phase 4a)
    renderAttendanceCard(data.attendance, 'attendance-card-container');

    // Weekly Tests Card (Phase 4b)
    renderWeeklyTestsCard(data.weeklyTests, data.categories, 'weekly-tests-card-container');

    // Learning Resources
    renderResources(data.resources);

    // Score Sheet Table with Series Selector, 5-Round Pagination & Sticky Column
    setupScoreSheetController({
      results: data.results,
      categories: data.categories,
      roundSeries: data.roundSeries,
      categorySeries: data.categorySeries,
      studentRounds: data.studentRounds
    });

    // Progress Charts (7-day vs 4-week toggle, week-over-week comparison, dual bar charts, text summaries)
    setupProgressChartsController({
      results: data.results,
      todayIST: data.todayIST,
      containerId: 'charts-wrapper-container'
    });

  } catch (err) {
    console.error('Failed to load student dashboard data:', err);
  }
}

function renderStudentHero(profile) {
  const nameEl = document.getElementById('student-display-name');
  const codeEl = document.getElementById('student-display-code');
  const levelEl = document.getElementById('student-display-level');

  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || profile.id || '—';
  if (levelEl) levelEl.textContent = profile.level || 'Unassigned';
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');
  if (container) container.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || 'STU';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

async function loadAndRenderAvailableWeeklyTestCard(studentId) {
  const container = document.getElementById('available-weekly-test-card-container');
  if (!container) return;

  try {
    let tests = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('my_weekly_tests');
      if (error) throw error;
      tests = Array.isArray(data) ? data : [];
    } else if (isDemoMode() && DemoDB && DemoDB.mockMyWeeklyTests) {
      tests = DemoDB.mockMyWeeklyTests(studentId);
    }

    const { availableNow } = groupTests(tests);
    if (!availableNow || availableNow.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Prefer an online test with sections still to do, or the first available test
    const activeTest =
      availableNow.find(
        (t) =>
          String(t.type || t.test_type).toLowerCase() === 'online' &&
          Array.isArray(t.sections) &&
          t.sections.some((sec) => isSectionStartable(sec, t.state))
      ) || availableNow[0];

    const isOnline =
      String(activeTest.type || activeTest.test_type || 'offline').toLowerCase() === 'online';
    const sections = Array.isArray(activeTest.sections) ? activeTest.sections : [];
    const todoCount = isOnline
      ? sections.filter((sec) => isSectionStartable(sec, activeTest.state)).length
      : 0;

    const subtitleText = isOnline
      ? `${todoCount} ${todoCount === 1 ? 'section' : 'sections'} still to do`
      : 'Scheduled for today (with your trainer)';

    container.innerHTML = `
      <section class="card" style="margin-bottom: var(--space-4); padding: var(--space-4) var(--space-5); border: 1px solid var(--color-primary); background: var(--color-primary-subtle);" aria-label="Available Weekly Test">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);">
          <div>
            <div style="font-weight: 800; font-size: var(--text-base); color: var(--text-main);">
              Weekly test: ${escapeHtml(activeTest.title)}
            </div>
            <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
              ${escapeHtml(subtitleText)}
            </div>
          </div>
          <a href="/pages/weekly-test.html" class="btn btn-primary btn-sm" style="text-decoration: none;">
            Start
          </a>
        </div>
      </section>
    `;
  } catch (err) {
    console.warn('Could not load available weekly test card:', err);
  }
}

/**
 * Phase 13b: Shows up to 3 reminders in a compact strip above the to-do list,
 * each with its link and a link "See all notifications".
 */
async function loadAndRenderHomeRemindersStrip(studentId) {
  const container = document.getElementById('student-home-reminders-strip-container');
  if (!container) return;

  try {
    const items = await fetchMyNotificationsCached({ studentId, forceRefresh: false });
    if (!Array.isArray(items) || items.length === 0) {
      container.innerHTML = '';
      return;
    }

    const topItems = items.slice(0, 3);
    const rowsHtml = topItems
      .map((item) => {
        const title = escapeHtml(item.title || 'Reminder');
        const dateChip = formatEventDateChipIST(item.event_date || item.created_at);
        const stageText = stageLabel(item.days_left);
        const link = sanitizeNotificationLink(
          item.link,
          item.kind === 'announcement' ? '/pages/notifications.html' : '/pages/weekly-test.html'
        );

        let stageBadge = '';
        if (stageText) {
          let stageStyle = 'color: var(--color-primary-text); font-weight: 700;';
          if (stageText === 'Today') {
            stageStyle = 'color: var(--color-danger-text); font-weight: 700;';
          } else if (stageText === 'Tomorrow') {
            stageStyle = 'color: var(--color-warning-text); font-weight: 700;';
          }
          stageBadge = `<span class="num" style="font-size: 12px; ${stageStyle}">${escapeHtml(stageText)}</span>`;
        }

        return `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: 8px 0; border-bottom: 1px solid var(--border-hairline);">
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; min-width: 0; font-size: var(--text-sm);">
              ${stageBadge}
              ${
                stageBadge && dateChip
                  ? `<span class="meta-separator" aria-hidden="true">·</span>`
                  : ''
              }
              ${
                dateChip
                  ? `<span class="num" style="font-size: 12px; font-weight: 600; color: var(--text-muted);">${escapeHtml(dateChip)}</span>`
                  : ''
              }
              <span class="meta-separator" aria-hidden="true">·</span>
              <a href="${escapeHtml(link)}" style="font-weight: 600; color: var(--text-main); text-decoration: none;">
                ${title}
              </a>
            </div>
            <a href="${escapeHtml(link)}" class="btn btn-outline btn-sm" style="font-size: 11px; padding: 2px 10px; text-decoration: none; flex-shrink: 0;">
              Open
            </a>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `
      <section class="card" style="margin-bottom: var(--space-4); padding: var(--space-3) var(--space-5); background: var(--bg-surface);" aria-label="Reminders and Notifications">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: 4px;">
          <div style="display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
            <span>Reminders</span>
            <span class="num">(${items.length})</span>
          </div>
          <a href="/pages/notifications.html" style="font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); text-decoration: none;">
            See all notifications &rarr;
          </a>
        </div>
        <div>
          ${rowsHtml}
        </div>
      </section>
    `;
  } catch (err) {
    console.warn('Could not load home reminders strip:', err);
  }
}

/**
 * Wires the calm view switcher on Student Home ("Today's Focus" | "Score Sheet & Progress" | "Show All")
 * so the page does not stack 16 cards on a single vertical scroll unless requested.
 */
function setupStudentHomeViewTabs() {
  const focusPane = document.getElementById('student-pane-focus');
  const progressPane = document.getElementById('student-pane-progress');
  const tabBtns = document.querySelectorAll('[data-student-view]');
  if (!focusPane || !progressPane || tabBtns.length === 0) return;

  const applyView = (mode) => {
    tabBtns.forEach((btn) => {
      const isMatch = btn.getAttribute('data-student-view') === mode;
      btn.classList.toggle('active', isMatch);
      btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });

    if (mode === 'progress') {
      focusPane.style.display = 'none';
      progressPane.style.display = '';
    } else if (mode === 'all') {
      focusPane.style.display = '';
      progressPane.style.display = '';
    } else {
      focusPane.style.display = '';
      progressPane.style.display = 'none';
    }
  };

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-student-view') || 'focus';
      applyView(mode);
    });
  });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', initStudentDashboard);

