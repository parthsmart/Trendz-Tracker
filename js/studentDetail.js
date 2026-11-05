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
import { setupAdminNav, openModal, closeModal } from './modal.js';
import { initProfileEditor, openEditProfileModal, openProfileAuditDrawer } from './profileEditor.js';
import { formatDisplayDateIST } from './stats.js';
import { fetchStudentDashboardData, resolveStudentProfile } from './dashboardData.js';
import { sendStudentMessage } from './studentMessages.js';
import { showToast } from './toast.js';
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

let currentStudentProfile = null;
let lastDashboardData = null;
let activeMessageNonce = null;

async function initStudentDetail() {
  // 1. Guard check: Strictly admin-only.
  // If a student tries to open this page, requireAuth redirects them to /pages/student.html
  const loggedInProfile = await requireAuth(['admin']);
  if (!loggedInProfile) return;

  // Render header details & admin nav dropdown/hamburger
  renderHeaderUser(loggedInProfile);
  setupAdminNav(loggedInProfile);

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

  currentStudentProfile = profile;

  // Render Student Hero Details
  renderStudentDetails(currentStudentProfile);

  // Initialize shared profile editor & change history drawer
  initProfileEditor({
    onProfileSaved: async (updatedProfile) => {
      const refreshed = (await resolveStudentProfile(updatedProfile.id || currentStudentProfile.id)) || updatedProfile;
      currentStudentProfile = refreshed;
      renderStudentDetails(currentStudentProfile);
      await loadAndRenderStudentDashboard(currentStudentProfile.id);
    }
  });

  document.getElementById('btn-send-student-message')?.addEventListener('click', () => {
    if (currentStudentProfile) {
      openSendMessageModal(currentStudentProfile, lastDashboardData);
    }
  });

  document.getElementById('btn-edit-student-profile')?.addEventListener('click', () => {
    if (currentStudentProfile) {
      openEditProfileModal(currentStudentProfile);
    }
  });

  document.getElementById('btn-student-change-history')?.addEventListener('click', () => {
    if (currentStudentProfile) {
      openProfileAuditDrawer(currentStudentProfile);
    }
  });

  setupSendMessageModalHandlers();

  // 4. Fetch and render dashboard data
  await loadAndRenderStudentDashboard(currentStudentProfile.id);

  function showStudentNotFound(message) {
    if (contentBox) contentBox.style.display = 'none';
    if (notFoundBox) notFoundBox.style.display = 'block';
    if (notFoundMsg && message) notFoundMsg.textContent = message;
  }
}

async function loadAndRenderStudentDashboard(studentId) {
  try {
    const data = await fetchStudentDashboardData(studentId);
    lastDashboardData = data;

    // Date
    const todayEl = document.getElementById('display-today-ist');
    if (todayEl) todayEl.textContent = formatDisplayDateIST(data.todayIST);

    // Streak card
    renderStreakCard(data.streak, data.todos);

    // To-do list (isReadOnly = true -> badges only, no edit links)
    renderTodoList(data.todos, 'todo-list-container', true, data.categories);

    // Basics this week
    renderBasicsThisWeek(data.results, data.categories, data.todayIST);

    // Flash Anzan this week (Phase 7)
    renderFlashThisWeek(data.activityResults, data.todayIST);

    // Elements Worksheet Drills Card (Phase 8, read-only for admin)
    await renderElementsCard({
      studentId,
      containerId: 'elements-week-container',
      isReadOnly: true,
      todayIST: data.todayIST,
      preloadedResults: data.activityResults
    });

    // Memoriad Competition Practice Card (Phase 9b-1, read-only for admin)
    await renderMemoriadCard({
      studentId,
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
}

function renderStudentDetails(profile) {
  const nameEl = document.getElementById('detail-student-name');
  const codeEl = document.getElementById('detail-student-code');
  const levelEl = document.getElementById('detail-student-level');
  const statusEl = document.getElementById('detail-student-status');

  const cardNameEl = document.getElementById('card-student-name');
  const cardCodeEl = document.getElementById('card-student-code');
  const cardLevelEl = document.getElementById('card-student-level');
  const cardLeaderboardEl = document.getElementById('card-student-leaderboard');

  const fullName = profile.full_name || profile.name || 'Unnamed Student';
  const code = profile.student_code || profile.id || '—';
  const level = profile.level || 'Unassigned';
  const isActive = profile.active !== false;
  const isLeaderboardVisible = profile.leaderboard_visible !== false;

  if (nameEl) nameEl.textContent = fullName;
  if (codeEl) codeEl.textContent = code;
  if (levelEl) levelEl.textContent = level;

  if (cardNameEl) cardNameEl.textContent = fullName;
  if (cardCodeEl) cardCodeEl.textContent = code;
  if (cardLevelEl) cardLevelEl.textContent = level;
  if (cardLeaderboardEl) {
    cardLeaderboardEl.textContent = isLeaderboardVisible ? 'Shown' : 'Hidden';
    cardLeaderboardEl.style.color = isLeaderboardVisible ? 'var(--color-accent-text)' : 'var(--text-dim)';
  }

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

function openSendMessageModal(profile, dashboardData) {
  const recipientEl = document.getElementById('modal-msg-recipient-text');
  if (recipientEl) {
    const fullName = profile.full_name || profile.name || 'Unnamed Student';
    const code = profile.student_code || profile.id || '—';
    const level = profile.level || '—';
    recipientEl.textContent = `${fullName} (${code}) · Level: ${level}`;
  }

  // Reset form inputs
  const linkTypeSelect = document.getElementById('modal-msg-link-type');
  const scoreGroup = document.getElementById('modal-msg-score-group');
  const scoreSelect = document.getElementById('modal-msg-score-select');
  const testGroup = document.getElementById('modal-msg-test-group');
  const testSelect = document.getElementById('modal-msg-test-select');
  const needsAttentionCb = document.getElementById('modal-msg-needs-attention');
  const attentionReasonWrap = document.getElementById('modal-msg-attention-reason-wrap');
  const attentionReasonInput = document.getElementById('modal-msg-attention-reason');
  const titleInput = document.getElementById('modal-msg-title');
  const bodyInput = document.getElementById('modal-msg-body');

  if (linkTypeSelect) linkTypeSelect.value = 'general';
  if (scoreGroup) scoreGroup.style.display = 'none';
  if (testGroup) testGroup.style.display = 'none';
  if (needsAttentionCb) needsAttentionCb.checked = false;
  if (attentionReasonWrap) attentionReasonWrap.style.display = 'none';
  if (attentionReasonInput) attentionReasonInput.value = '';
  if (titleInput) titleInput.value = '';
  if (bodyInput) bodyInput.value = '';

  // Populate scores select
  if (scoreSelect) {
    scoreSelect.innerHTML = '<option value="">Choose a recent score...</option>';
    const results = dashboardData?.results || [];
    results.slice(0, 30).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      const catName = r.categories?.name || r.category_name || 'Practice';
      const scoreStr = `${r.correct ?? 0}/${r.total ?? 0}`;
      const dateStr = r.entry_date ? formatDisplayDateIST(r.entry_date) : '';
      opt.textContent = `${dateStr} - ${catName} (Score: ${scoreStr})`;
      scoreSelect.appendChild(opt);
    });
  }

  // Populate weekly tests select
  if (testSelect) {
    testSelect.innerHTML = '<option value="">Choose a weekly test...</option>';
    const tests = dashboardData?.weeklyTests || [];
    tests.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      const dateStr = t.test_date ? formatDisplayDateIST(t.test_date) : '';
      opt.textContent = `${dateStr} - ${t.title || 'Weekly Test'}`;
      testSelect.appendChild(opt);
    });
  }

  activeMessageNonce = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `nonce-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  openModal('modal-send-student-message');
}

function setupSendMessageModalHandlers() {
  const modalId = 'modal-send-student-message';
  const linkTypeSelect = document.getElementById('modal-msg-link-type');
  const scoreGroup = document.getElementById('modal-msg-score-group');
  const testGroup = document.getElementById('modal-msg-test-group');
  const needsAttentionCb = document.getElementById('modal-msg-needs-attention');
  const attentionReasonWrap = document.getElementById('modal-msg-attention-reason-wrap');

  if (linkTypeSelect) {
    linkTypeSelect.addEventListener('change', () => {
      const val = linkTypeSelect.value;
      if (scoreGroup) scoreGroup.style.display = val === 'score' ? 'block' : 'none';
      if (testGroup) testGroup.style.display = val === 'weekly_test' ? 'block' : 'none';
    });
  }

  if (needsAttentionCb && attentionReasonWrap) {
    needsAttentionCb.addEventListener('change', () => {
      attentionReasonWrap.style.display = needsAttentionCb.checked ? 'block' : 'none';
    });
  }

  const closeBtn = document.getElementById('btn-close-message-modal');
  const cancelBtn = document.getElementById('btn-cancel-send-message');
  closeBtn?.addEventListener('click', () => closeModal(modalId));
  cancelBtn?.addEventListener('click', () => closeModal(modalId));

  const form = document.getElementById('form-send-student-message');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentStudentProfile) return;

      const titleInput = document.getElementById('modal-msg-title');
      const bodyInput = document.getElementById('modal-msg-body');
      const linkType = document.getElementById('modal-msg-link-type')?.value || 'general';
      const scoreSelect = document.getElementById('modal-msg-score-select');
      const testSelect = document.getElementById('modal-msg-test-select');
      const needsAttention = document.getElementById('modal-msg-needs-attention')?.checked || false;
      const attentionReason = document.getElementById('modal-msg-attention-reason')?.value?.trim() || null;
      const submitBtn = document.getElementById('btn-submit-send-message');

      const title = titleInput?.value?.trim() || '';
      const body = bodyInput?.value?.trim() || '';

      if (!title) {
        showToast('error', 'Title is required.');
        return;
      }
      if (!body) {
        showToast('error', 'Message body is required.');
        return;
      }

      let linkedType = null;
      let linkedId = null;
      if (linkType === 'score') {
        linkedType = 'score';
        linkedId = scoreSelect?.value || null;
        if (!linkedId) {
          showToast('error', 'Please choose a practice score to link.');
          return;
        }
      } else if (linkType === 'weekly_test') {
        linkedType = 'weekly_test';
        linkedId = testSelect?.value || null;
        if (!linkedId) {
          showToast('error', 'Please choose a weekly test to link.');
          return;
        }
      }

      try {
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Sending...';
        }

        await sendStudentMessage({
          studentId: currentStudentProfile.id,
          title,
          body,
          needsAttention,
          attentionReason: needsAttention ? attentionReason : null,
          linkedType,
          linkedId,
          clientNonce: activeMessageNonce,
        });

        showToast('success', 'Private message sent to student.');
        activeMessageNonce = null;
        closeModal(modalId);
      } catch (err) {
        console.error('Failed to send student message:', err);
        showToast('error', err.message || 'Failed to send student message');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Send Message';
        }
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', initStudentDetail);
