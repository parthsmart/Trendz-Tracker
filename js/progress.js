/**
 * Trendz Tracker - Progress page controller (js/progress.js)
 *
 * The student's score sheet, progress charts, this week by section (Basics, Flash Anzan,
 * Elements, Memoriad, Attendance) and learning resources. This used to be the
 * "Score Sheet & Progress" view on the student home; it is reached from the
 * "Progress" tile in Practice & More.
 *
 * Like /pages/student.html it ALWAYS shows the logged-in student's own data and
 * never reads a student id from the URL.
 */

import { requireAuth } from './guard.js';
import './infoTooltip.js';
import { fetchStudentDashboardData, fetchStudentScoreSheetData } from './dashboardData.js';
import {
  renderBasicsThisWeek,
  renderFlashThisWeek,
  renderResources,
  renderAttendanceCard,
  setupScoreSheetController,
  setupProgressChartsController,
} from './dashboardComponents.js';
import { renderElementsCard } from './elementsCard.js';
import { renderMemoriadCard } from './memoriadCard.js';

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

/** One "This week" card with a tab per section (Basics, Flash, ...). */
function setupProgressWeekTabs() {
  const tabs = document.querySelectorAll('[data-week-tab]');
  const panes = document.querySelectorAll('[data-week-pane]');
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

async function initProgressPage() {
  const profile = await requireAuth(['student']);
  if (!profile) return;
  const studentId = profile.id;

  renderHeaderUser(profile);
  setupProgressWeekTabs();

  try {
    const [data, scoreSheetData] = await Promise.all([
      fetchStudentDashboardData(studentId, { includeScoreSheet: false }),
      fetchStudentScoreSheetData(studentId),
    ]);

    const fullResults =
      Array.isArray(scoreSheetData.allResults) && scoreSheetData.allResults.length > 0
        ? scoreSheetData.allResults
        : data.results;

    // Score sheet with series selector, 5-round pagination and sticky column
    setupScoreSheetController({
      results: fullResults,
      categories: data.categories,
      roundSeries: scoreSheetData.roundSeries,
      categorySeries: scoreSheetData.categorySeries,
      studentRounds: scoreSheetData.studentRounds,
    });

    // Progress charts (7-day vs 4-week toggle, week-over-week comparison)
    setupProgressChartsController({
      results: fullResults,
      todayIST: data.todayIST,
      containerId: 'charts-wrapper-container',
    });

    renderBasicsThisWeek(fullResults, data.categories, data.todayIST);
    renderFlashThisWeek(data.activityResults, data.todayIST);

    await renderElementsCard({
      studentId,
      containerId: 'elements-week-container',
      isReadOnly: false,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults,
    });

    await renderMemoriadCard({
      studentId,
      containerId: 'memoriad-week-container',
      isReadOnly: false,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults,
    });

    renderAttendanceCard(data.attendance, 'attendance-card-container');
    renderResources(scoreSheetData.resources);
  } catch (err) {
    console.error('Failed to load the Progress page:', err);
  }
}

document.addEventListener('DOMContentLoaded', initProgressPage);
