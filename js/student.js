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
  setupScoreSheetController,
  setupProgressChartsController
} from './dashboardComponents.js';
import { loadAndRenderStudentHomework } from './studentHomeworkView.js';
import { renderElementsCard } from './elementsCard.js';
import { renderMemoriadCard } from './memoriadCard.js';
import { fetchMyNotificationsCached } from './notificationBadge.js';
import { formatTimeIST } from './liveClasses.js';
import { renderXpProgressCard } from './xpRewards.js';
import { renderDailyChallengeCard, renderStarsCard } from './homeGamify.js';
import { renderArenaCard } from './arenaHome.js';
import { fetchLeaderboard } from './leaderboardData.js';
import {
  renderPracticeTiles,
  renderHeroIdentity,
  renderMyDay,
  renderComingUp,
} from './studentHome.js';

let cachedDashboardData = null;
let progressTabLoaded = false;
let progressTabLoadingPromise = null;

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

/**
 * Re-renders the Practice tiles once the student's practice access is known,
 * so hidden sections (Flash Anzan, Oral Rounds) drop out. Non-blocking.
 */
async function refreshPracticeTilesWithAccess(profile) {
  if (!profile?.id || profile.practice_access) return;
  try {
    const { fetchStudentEffectiveAccess } = await import('./studentAccess.js');
    const supabase = !isDemoMode() && isSupabaseConfigured() ? await getSupabase() : null;
    const res = await fetchStudentEffectiveAccess(profile.id, { supabase, isDemo: isDemoMode(), DemoDB });
    if (res?.ok && res.settings) {
      renderPracticeTiles({ ...profile, practice_access: res.settings });
    }
  } catch {
    // Keep the tiles already shown.
  }
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
  renderHeroIdentity(loggedInProfile);
  renderPracticeTiles(loggedInProfile);
  refreshPracticeTilesWithAccess(loggedInProfile);
  setupFullPlanToggle();
  setupStudentHomeViewTabs(() => {
    ensureProgressTabLoaded(currentStudentId);
  });
  setupProgressWeekTabs();

  loadAndRenderStudentLiveClassCard(currentStudentId);
  renderXpProgressCard(document.getElementById('xp-progress-card'), {
    studentId: currentStudentId,
    loadBoard: () => fetchLeaderboard({ board: 'xp', period: 'week', limit: 5, scope: 'level' }, loggedInProfile),
  }).catch((err) => console.warn('Could not load XP:', err));
  renderDailyChallengeCard(document.getElementById('daily-challenge'))
    .then(() => {
      if (window.location.hash === '#daily-challenge') {
        document.getElementById('daily-challenge')?.scrollIntoView({ block: 'start' });
      }
    })
    .catch((err) => console.warn('Could not load the daily challenge:', err));
  renderStarsCard(document.getElementById('stars-card')).catch((err) =>
    console.warn('Could not load stars:', err)
  );
  renderArenaCard(document.getElementById('arena-card')).catch((err) =>
    console.warn('Could not load the arena card:', err)
  );
  // Weekly tests, homework and reminders are each fetched once and shared by
  // My Day and the Coming up panel (which also shows today's open weekly test).
  const testsPromise = fetchMyWeeklyTests(currentStudentId);

  // Today's Homework (Phase 20 - Independent of Streaks); full card lives in "View full plan"
  const homeworkPromise = loadAndRenderStudentHomework(currentStudentId, loggedInProfile.level)
    .then((items) => (Array.isArray(items) ? items : []))
    .catch(() => []);

  const remindersPromise = fetchMyNotificationsCached({ studentId: currentStudentId, forceRefresh: false })
    .then((items) => (Array.isArray(items) ? items : []))
    .catch((err) => {
      console.warn('Could not load reminders:', err);
      return [];
    });

  Promise.all([testsPromise, homeworkPromise, remindersPromise]).then(([tests, homework, reminders]) => {
    renderComingUp({
      activeTest: pickActiveWeeklyTest(tests),
      upcomingTests: groupTests(tests).upcoming,
      homework,
      reminders,
    });
  });

  // 2. Fetch and render "Today's Focus" dashboard data first (Score Sheet deferred until tab open)
  try {
    const data = await fetchStudentDashboardData(currentStudentId, { includeScoreSheet: false });
    cachedDashboardData = data;

    // Date in "Today" Header (India time)
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatTodayHeadingIST(data.todayIST);

    // Today's Plan: full list (inside "View full plan") + My Day split view
    renderTodoList(data.todos, 'todo-list-container', false, data.categories);
    homeworkPromise.then((homework) => {
      renderMyDay({
        todos: data.todos,
        categories: data.categories,
        homework,
        onOpenFullPlan: (hwId) => setFullPlanOpen(true, hwId),
      });
    });

    // Compact Streak & Shield Card
    renderStreakCard(data.streak, data.todos);

    // Three Small 7-Day Summary Cards: Accuracy, Speed (q/min), Practice days
    renderTodaySummaryMetrics(data.results, data.activityResults, data.todayIST);

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

async function fetchMyWeeklyTests(studentId) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('my_weekly_tests');
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    }
    if (isDemoMode() && DemoDB && DemoDB.mockMyWeeklyTests) {
      const tests = DemoDB.mockMyWeeklyTests(studentId);
      return Array.isArray(tests) ? tests : [];
    }
  } catch (err) {
    console.warn('Could not load weekly tests:', err);
  }
  return [];
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
              <a href="/pages/my-live-classes.html" style="font-size: var(--text-xs); font-weight: 600; color: var(--color-primary); text-decoration: none;">All classes &rarr;</a>
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
 * Today's open weekly test for the Coming up panel (in progress first, then not started).
 */
function pickActiveWeeklyTest(tests) {
  const { availableNow } = groupTests(Array.isArray(tests) ? tests : []);
  if (!availableNow || availableNow.length === 0) return null;
  const withState = availableNow.map((t) => ({ test: t, completion: getWeeklyTestCompletionState(t) }));
  const chosen =
    withState.find((item) => item.completion.state === 'partially_completed') ||
    withState.find((item) => item.completion.state === 'not_started') ||
    withState[0];
  const isOnline = String(chosen.test.type || chosen.test.test_type || 'offline').toLowerCase() === 'online';
  return { ...chosen, isOnline };
}

/**
 * "View full plan" shows the complete to-do list and the homework card (with history).
 */
function setFullPlanOpen(open, hwId = null) {
  const panel = document.getElementById('sh-full-plan');
  const btn = document.getElementById('btn-toggle-full-plan');
  if (!panel || !btn) return;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.innerHTML = open ? 'Hide full plan &lsaquo;' : 'View full plan &rsaquo;';
  if (open) {
    const target =
      (hwId && document.querySelector(`#homework-list-container [data-hw-id="${CSS.escape(String(hwId))}"]`)) || panel;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function setupFullPlanToggle() {
  const panel = document.getElementById('sh-full-plan');
  document.getElementById('btn-toggle-full-plan')?.addEventListener('click', () => {
    setFullPlanOpen(Boolean(panel?.hidden));
  });
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

/**
 * Score Sheet & Progress: one "This week" card with a tab per section (Basics, Flash, ...).
 */
function setupProgressWeekTabs() {
  const tabs = document.querySelectorAll('[data-week-tab]');
  const panes = document.querySelectorAll('[data-week-pane]');
  if (tabs.length === 0) return;
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-week-tab');
      tabs.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panes.forEach((pane) => {
        pane.hidden = pane.getAttribute('data-week-pane') !== key;
      });
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

