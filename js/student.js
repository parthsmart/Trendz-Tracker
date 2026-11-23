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
import './infoTooltip.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { formatTodayHeadingIST } from './periods.js';
import { fetchStudentDashboardData, fetchStudentScoreSheetData } from './dashboardData.js';
import { groupTests, isSectionStartable, getWeeklyTestCompletionState } from './weeklyTestView.js';
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
import { loadAndRenderStudentHomework } from './studentHomeworkView.js';
import { renderElementsCard } from './elementsCard.js';
import { renderMemoriadCard } from './memoriadCard.js';
import { fetchMyNotificationsCached } from './notificationBadge.js';
import { formatTimeIST } from './liveClasses.js';
import {
  stageLabel,
  formatEventDateChipIST,
  sanitizeNotificationLink,
} from './notificationsView.js';

let cachedDashboardData = null;
let progressTabLoaded = false;
let progressTabLoadingPromise = null;

function observeOnceWhenVisible(element, callback) {
  if (!element || typeof callback !== 'function') return;
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
    callback();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          callback();
          break;
        }
      }
    },
    { rootMargin: '160px 0px' }
  );
  observer.observe(element);
}

async function ensureProgressTabLoaded(studentId) {
  if (progressTabLoaded) return;
  if (progressTabLoadingPromise) return progressTabLoadingPromise;

  progressTabLoadingPromise = (async () => {
    try {
      const scoreSheetData = await fetchStudentScoreSheetData(studentId);
      const data = cachedDashboardData;
      if (!data) return;

      const fullResults =
        Array.isArray(scoreSheetData.allResults) && scoreSheetData.allResults.length > 0
          ? scoreSheetData.allResults
          : data.results;

      data.roundSeries = scoreSheetData.roundSeries;
      data.categorySeries = scoreSheetData.categorySeries;
      data.studentRounds = scoreSheetData.studentRounds;
      data.resources = scoreSheetData.resources;
      data.results = fullResults;

      // Score Sheet Table with Series Selector, 5-Round Pagination & Sticky Column
      setupScoreSheetController({
        results: fullResults,
        categories: data.categories,
        roundSeries: data.roundSeries,
        categorySeries: data.categorySeries,
        studentRounds: data.studentRounds
      });

      // Progress Charts (7-day vs 4-week toggle, week-over-week comparison, dual bar charts, text summaries)
      setupProgressChartsController({
        results: fullResults,
        todayIST: data.todayIST,
        containerId: 'charts-wrapper-container'
      });

      // Basics Card
      renderBasicsThisWeek(fullResults, data.categories, data.todayIST);

      // Flash Anzan Card (Phase 7)
      renderFlashThisWeek(data.activityResults, data.todayIST);

      // Elements Worksheet Drills Card (Phase 8)
      await renderElementsCard({
        studentId,
        containerId: 'elements-week-container',
        isReadOnly: false,
        todayIST: data.todayIST,
        preloadedResults: data.activityResults
      });

      // Memoriad Competition Practice Card (Phase 9b-1)
      await renderMemoriadCard({
        studentId,
        containerId: 'memoriad-week-container',
        isReadOnly: false,
        todayIST: data.todayIST,
        preloadedResults: data.activityResults
      });

      // Attendance Card (Phase 4a)
      renderAttendanceCard(data.attendance, 'attendance-card-container');

      // Learning Resources
      renderResources(data.resources);

      progressTabLoaded = true;
    } catch (err) {
      console.error('Failed to load Score Sheet & Progress tab:', err);
    } finally {
      progressTabLoadingPromise = null;
    }
  })();

  return progressTabLoadingPromise;
}

async function initStudentDashboard() {
  // 1. Guard check: Strictly for logged-in students.
  // /pages/student.html must NEVER read a student id from the URL or anywhere else.
  // Verified admin sessions return to /pages/admin.html; verified teachers return to /pages/teacher.html.
  const loggedInProfile = await requireAuth(['student']);
  if (!loggedInProfile) return;

  const currentStudentId = loggedInProfile.id;

  // Render header details
  renderHeaderUser(loggedInProfile);
  renderStudentHero(loggedInProfile);
  setupStudentHomeViewTabs(() => {
    ensureProgressTabLoaded(currentStudentId);
  });

  // Load Available Weekly Test banner (Phase 13a), compact reminders strip (Phase 13b), and Live Class card
  loadAndRenderAvailableWeeklyTestCard(currentStudentId);
  loadAndRenderHomeRemindersStrip(currentStudentId);
  loadAndRenderStudentLiveClassCard(currentStudentId);

  // Lazy-load Leaderboard summary card when scrolled near viewport (Candidate D)
  const lbContainer = document.getElementById('leaderboard-card-container');
  observeOnceWhenVisible(lbContainer, () => {
    loadAndRenderLeaderboardCard('leaderboard-card-container', loggedInProfile);
  });

  // 2. Fetch and render "Today's Focus" dashboard data first (Score Sheet deferred until tab open)
  try {
    const data = await fetchStudentDashboardData(currentStudentId, { includeScoreSheet: false });
    cachedDashboardData = data;

    // Date in "Today" Header (India time)
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatTodayHeadingIST(data.todayIST);

    // Today's Plan (To-Do List)
    renderTodoList(data.todos, 'todo-list-container', false, data.categories);

    // Today's Homework (Phase 20 - Independent of Streaks)
    loadAndRenderStudentHomework(currentStudentId, loggedInProfile.level);

    // Compact Streak & Shield Card
    renderStreakCard(data.streak, data.todos);

    // Three Small 7-Day Summary Cards: Accuracy, Speed (q/min), Practice days
    renderTodaySummaryMetrics(data.results, data.activityResults, data.todayIST);

    // Weekly Tests Card (Phase 4b)
    renderWeeklyTestsCard(data.weeklyTests, data.categories, 'weekly-tests-card-container');

    // If user already switched to Progress or Show All while initial data was loading, load Tab 2 now
    const progressPane = document.getElementById('student-pane-progress');
    if (progressPane && progressPane.style.display !== 'none') {
      await ensureProgressTabLoaded(currentStudentId);
    }
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

    const testsWithState = availableNow.map((t) => ({
      test: t,
      completion: getWeeklyTestCompletionState(t),
    }));

    // Prioritize an incomplete test (in-progress first, then not-started); otherwise take first completed
    const chosen =
      testsWithState.find((item) => item.completion.state === 'partially_completed') ||
      testsWithState.find((item) => item.completion.state === 'not_started') ||
      testsWithState[0];

    const activeTest = chosen.test;
    const completion = chosen.completion;
    const isOnline =
      String(activeTest.type || activeTest.test_type || 'offline').toLowerCase() === 'online';

    let badgeHtml = '';
    let actionBtnHtml = '';
    let subtitleText = '';

    if (completion.state === 'completed') {
      badgeHtml = `<span class="badge" style="background: #DEF7EC; color: #03543F; font-size: 11px; font-weight: 700;">Completed</span>`;
      subtitleText = isOnline
        ? `All ${completion.totalCount} sections completed &middot; Scores submitted`
        : 'Scores recorded by your trainer';
      actionBtnHtml = `
        <a href="/pages/weekly-test.html" class="btn btn-outline btn-sm" style="text-decoration: none;">
          View results
        </a>
      `;
    } else if (completion.state === 'partially_completed') {
      badgeHtml = `<span class="badge" style="background: #FEF08A; color: #713F12; font-size: 11px; font-weight: 700;">In progress</span>`;
      subtitleText = `${completion.submittedCount} of ${completion.totalCount} completed &middot; ${completion.todoCount} still to do`;
      actionBtnHtml = `
        <a href="/pages/weekly-test.html" class="btn btn-primary btn-sm" style="text-decoration: none;">
          Continue
        </a>
      `;
    } else {
      badgeHtml = `<span class="badge badge-primary" style="font-size: 11px; font-weight: 700;">To do</span>`;
      subtitleText = isOnline
        ? `${completion.totalCount} ${completion.totalCount === 1 ? 'section' : 'sections'} to do`
        : 'Scheduled for today (with your trainer)';
      actionBtnHtml = `
        <a href="/pages/weekly-test.html" class="btn btn-primary btn-sm" style="text-decoration: none;">
          Start
        </a>
      `;
    }

    container.innerHTML = `
      <section class="card" style="margin-bottom: var(--space-4); padding: var(--space-4) var(--space-5); border: 1px solid var(--color-primary); background: var(--color-primary-subtle);" aria-label="Available Weekly Test">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);">
          <div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <span style="font-weight: 800; font-size: var(--text-base); color: var(--text-main);">
                Weekly test: ${escapeHtml(activeTest.title)}
              </span>
              ${badgeHtml}
            </div>
            <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
              ${subtitleText}
            </div>
          </div>
          ${actionBtnHtml}
        </div>
      </section>
    `;
  } catch (err) {
    console.warn('Could not load available weekly test card:', err);
  }
}

/**
 * Loads and renders compact Live Class card (Webinar.gg) when an eligible class is upcoming or active.
 */
export async function loadAndRenderStudentLiveClassCard(studentId) {
  const container = document.getElementById('student-live-class-card-container');
  if (!container) return;

  try {
    let classes = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('get_eligible_live_classes_for_student', {
        p_student_id: studentId,
      });
      if (!error && Array.isArray(data)) {
        classes = data;
      }
    } else if (isDemoMode() && DemoDB && DemoDB.getEligibleLiveClassesForStudent) {
      classes = DemoDB.getEligibleLiveClassesForStudent(studentId);
    }

    if (!classes || classes.length === 0) {
      container.innerHTML = '';
      return;
    }

    // Pick top class (ordered by status priority: live -> waiting -> scheduled)
    const cls = classes[0];
    const now = Date.now();
    const scheduledTime = new Date(cls.scheduled_start_time).getTime();
    const isPastStart = !isNaN(scheduledTime) && now >= scheduledTime;

    // Distinguish upcoming, waiting for the teacher, live, ended, and canceled states.
    // Use confirmed provider state for Live. A scheduled start time alone does not mean the teacher is live.
    let statusState = cls.status;
    if (cls.status === 'scheduled' && isPastStart) {
      statusState = 'waiting';
    }

    let badgeHtml = '';
    let btnHtml = '';

    if (statusState === 'cancelled') {
      badgeHtml = `<span class="badge badge-danger" style="font-weight: 600;">Cancelled</span>`;
      btnHtml = `<button type="button" class="btn btn-outline btn-sm" disabled style="opacity: 0.6;">Cancelled</button>`;
    } else if (statusState === 'ended') {
      badgeHtml = `<span class="badge badge-neutral" style="font-weight: 500;">Class Ended</span>`;
      btnHtml = `<button type="button" class="btn btn-outline btn-sm" disabled style="opacity: 0.6;">Ended</button>`;
    } else if (statusState === 'live') {
      badgeHtml = `<span class="badge badge-success" style="font-weight: 700; animation: pulse 2s infinite;"><span style="color: #22c55e;">●</span> Live Now</span>`;
      btnHtml = `<a href="/pages/live-room.html?classId=${cls.id}" class="btn btn-primary btn-sm" style="text-decoration: none; font-weight: 600;">Join live class &rarr;</a>`;
    } else if (statusState === 'waiting') {
      badgeHtml = `<span class="badge badge-warning" style="font-weight: 600;">Waiting for Teacher</span>`;
      btnHtml = `<a href="/pages/live-room.html?classId=${cls.id}" class="btn btn-primary btn-sm" style="text-decoration: none; font-weight: 600;">Join live class &rarr;</a>`;
    } else {
      // Upcoming
      badgeHtml = `<span class="badge badge-info" style="font-weight: 500;">Upcoming</span>`;
      btnHtml = `<a href="/pages/live-room.html?classId=${cls.id}" class="btn btn-primary btn-sm" style="text-decoration: none; font-weight: 600;">Join live class &rarr;</a>`;
    }

    const teacherName = cls.teacher_name || 'Assigned Teacher';
    const isLiveCard = statusState === 'live';

    container.innerHTML = `
      <section class="card" style="margin-bottom: var(--space-4); padding: var(--space-4) var(--space-5); background: ${isLiveCard ? '#f0fdf4' : 'var(--bg-surface, #ffffff)'}; border: 1px solid ${isLiveCard ? '#86efac' : 'var(--border-hairline)'};">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-3);">
          <div style="display: flex; flex-direction: column; gap: 4px;">
            <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
              <span style="font-size: var(--text-xs); font-weight: 700; color: var(--color-primary); text-transform: uppercase; letter-spacing: 0.05em;">Live Class</span>
              <span aria-hidden="true">&middot;</span>
              ${badgeHtml}
            </div>
            <h3 style="margin: 0; font-size: var(--text-base); font-weight: 700; color: var(--text-main);">
              ${escapeHtml(cls.title || 'Abacus Live Class')}
            </h3>
            <div style="font-size: var(--text-xs); color: var(--text-muted); display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
              <span>Teacher: <strong style="color: var(--text-main);">${escapeHtml(teacherName)}</strong></span>
              <span aria-hidden="true">&middot;</span>
              <span>Start: <strong class="num" style="color: var(--text-main);">${formatTimeIST(cls.scheduled_start_time)}</strong></span>
              <span aria-hidden="true">&middot;</span>
              <span>Duration: ${cls.duration_minutes || 60}m</span>
            </div>
          </div>
          <div>
            ${btnHtml}
          </div>
        </div>
      </section>
    `;
  } catch (err) {
    console.warn('Could not load student live class card:', err);
    container.innerHTML = '';
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
function setupStudentHomeViewTabs(onProgressVisible = null) {
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
      if (typeof onProgressVisible === 'function') onProgressVisible();
    } else if (mode === 'all') {
      focusPane.style.display = '';
      progressPane.style.display = '';
      if (typeof onProgressVisible === 'function') onProgressVisible();
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

