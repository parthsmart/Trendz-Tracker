import { setupStudentExperience, refreshNextPractice } from './studentExperience.js';
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
import { formatTodayHeadingIST } from './periods.js';
import { fetchStudentDashboardData } from './dashboardData.js';
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

async function initStudentDashboard() {
  setupStudentExperience();
  // 1. Guard check: Strictly for logged-in students (or admin viewing their own student record).
  // /pages/student.html must NEVER read a student id from the URL or anywhere else.
  // It always shows the logged-in student's own data.
  const loggedInProfile = await requireAuth(['student', 'admin']);
  if (!loggedInProfile) return;

  const currentStudentId = loggedInProfile.id;

  // Render header details
  renderHeaderUser(loggedInProfile);
  renderStudentHero(loggedInProfile);

  // Load Leaderboard summary card (Phase 5a) in parallel
  loadAndRenderLeaderboardCard('leaderboard-card-container', loggedInProfile);

  // 2. Fetch and render all dashboard data using shared loader
  try {
    const data = await fetchStudentDashboardData(currentStudentId);

    // Date in "Today" Header (India time)
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatTodayHeadingIST(data.todayIST);

    // Today's Plan (To-Do List)
    renderTodoList(data.todos, 'todo-list-container', false, data.categories);
    refreshNextPractice();

    // Compact Streak & Shield Card
    renderStreakCard(data.streak);

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

function renderDemoBanner() {
  const placeholder = document.getElementById('demo-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Sample scores, streaks, and to-do items loaded for local testing.
      </div>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initStudentDashboard);
