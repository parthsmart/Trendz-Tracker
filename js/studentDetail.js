/**
 * Trendz Tracker - Student Detail Controller (js/studentDetail.js)
 * 
 * Read-only teacher inspection of an individual student's practice record:
 * - Admin-only route guard: students are automatically redirected to /pages/student.html
 * - Friendly "Student Not Found" state if ?id=... is missing or invalid
 * - Read-only banner and zero mutate/edit actions
 * - Renders shared dashboard modules: streak, to-do list, basics, resources, score sheet, and charts
 */

import { requireAuth } from './guard.js';
import { isDemoMode } from './demoDb.js';
import { setupAdminNav } from './modal.js';
import { formatDisplayDateIST } from './stats.js';
import { fetchStudentDashboardData, resolveStudentProfile } from './dashboardData.js';
import {
  escapeHtml,
  renderStreakCard,
  renderTodoList,
  renderBasicsThisWeek,
  renderFlashThisWeek,
  renderResources,
  renderAttendanceCard,
  renderWeeklyTestsCard,
  setupScoreSheetController,
  setupProgressChartsController
} from './dashboardComponents.js';
import { renderElementsCard } from './elementsCard.js';
import { renderMemoriadCard } from './memoriadCard.js';

async function initStudentDetail() {
  // 1. Guard check: Strictly admin-only.
  // If a student tries to open this page, requireAuth redirects them to /pages/student.html
  const loggedInProfile = await requireAuth(['admin']);
  if (!loggedInProfile) return;

  // Render header details & admin nav dropdown/hamburger
  renderHeaderUser(loggedInProfile);
  setupAdminNav();

  // Render demo banner if running on demo host
  if (isDemoMode()) {
    renderDemoBanner();
  }

  // 2. Read student ID from URL (?id=...)
  const urlParams = new URLSearchParams(window.location.search);
  const studentId = urlParams.get('id');

  const contentBox = document.getElementById('student-dashboard-content');
  const notFoundBox = document.getElementById('student-not-found-box');
  const notFoundMsg = document.getElementById('student-not-found-msg');

  if (!studentId || !studentId.trim()) {
    showStudentNotFound('No student ID was specified in the URL.');
    return;
  }

  // 3. Resolve student profile
  const profile = await resolveStudentProfile(studentId.trim());
  if (!profile) {
    showStudentNotFound(`We could not find any active or registered student with ID "${escapeHtml(studentId.trim())}". They may have been deactivated or removed.`);
    return;
  }

  // Render Student Hero Details
  renderStudentDetails(profile);

  // 4. Fetch and render dashboard data
  try {
    const data = await fetchStudentDashboardData(profile.id);

    // Date
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatDisplayDateIST(data.todayIST);

    // Streak card
    renderStreakCard(data.streak);

    // To-do list (isReadOnly = true -> badges only, no edit links)
    renderTodoList(data.todos, 'todo-list-container', true, data.categories);

    // Basics this week
    renderBasicsThisWeek(data.results, data.categories, data.todayIST);

    // Flash Anzan this week (Phase 7)
    renderFlashThisWeek(data.activityResults, data.todayIST);

    // Elements Worksheet Drills Card (Phase 8, read-only for admin)
    await renderElementsCard({
      studentId: profile.id,
      containerId: 'elements-week-container',
      isReadOnly: true,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults
    });

    // Memoriad Competition Practice Card (Phase 9b-1, read-only for admin)
    await renderMemoriadCard({
      studentId: profile.id,
      containerId: 'memoriad-week-container',
      isReadOnly: true,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults
    });

    // Attendance Card (Phase 4a)
    renderAttendanceCard(data.attendance, 'attendance-card-container');

    // Weekly Tests Card (Phase 4b)
    renderWeeklyTestsCard(data.weeklyTests, data.categories, 'weekly-tests-card-container');

    // Resources
    renderResources(data.resources);

    // Score Sheet (Series selector, 5-round pagination, sticky category column)
    setupScoreSheetController({
      results: data.results,
      categories: data.categories,
      roundSeries: data.roundSeries,
      categorySeries: data.categorySeries,
      studentRounds: data.studentRounds
    });

    // Progress charts (7 days vs 4 weeks toggle, week-over-week comparison, dual bar charts, text summaries)
    setupProgressChartsController({
      results: data.results,
      todayIST: data.todayIST,
      containerId: 'charts-wrapper-container'
    });

  } catch (err) {
    console.error('Failed to load student detail dashboard:', err);
  }

  function showStudentNotFound(message) {
    if (contentBox) contentBox.style.display = 'none';
    if (notFoundBox) notFoundBox.style.display = 'block';
    if (notFoundMsg && message) notFoundMsg.textContent = message;
  }
}

function renderStudentDetails(profile) {
  const nameEl = document.getElementById('detail-student-name');
  const codeEl = document.getElementById('detail-student-code');
  const levelEl = document.getElementById('detail-student-level');
  const statusEl = document.getElementById('detail-student-status');

  const cardNameEl = document.getElementById('card-student-name');
  const cardCodeEl = document.getElementById('card-student-code');
  const cardLevelEl = document.getElementById('card-student-level');

  const fullName = profile.full_name || profile.name || 'Unnamed Student';
  const code = profile.student_code || profile.id || '—';
  const level = profile.level || 'Unassigned';
  const isActive = profile.active !== false;

  if (nameEl) nameEl.textContent = fullName;
  if (codeEl) codeEl.textContent = code;
  if (levelEl) levelEl.textContent = level;

  if (cardNameEl) cardNameEl.textContent = fullName;
  if (cardCodeEl) cardCodeEl.textContent = code;
  if (cardLevelEl) cardLevelEl.textContent = level;

  if (statusEl) {
    if (isActive) {
      statusEl.className = 'badge badge-active';
      statusEl.textContent = 'Active Student';
    } else {
      statusEl.className = 'badge badge-inactive';
      statusEl.textContent = 'Deactivated';
    }
  }

  const reviewBtn = document.getElementById('btn-review-entries');
  if (reviewBtn) {
    reviewBtn.href = `/pages/review.html?studentId=${encodeURIComponent(profile.id)}`;
  }

  const reportBtn = document.getElementById('btn-monthly-report');
  if (reportBtn) {
    reportBtn.href = `/pages/monthly-report.html?studentId=${encodeURIComponent(profile.id)}`;
  }
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  if (container) container.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = 'Teacher';

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
        Inspecting demo student in local preview environment.
      </div>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initStudentDetail);
