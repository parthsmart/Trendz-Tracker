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
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
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
import {
  fetchStudentEffectiveAccess,
  saveStudentAccessOverride,
  resetStudentAccessOverride,
  getTeacherLevelStudentCount,
  teacherBulkApplyLevelAccess,
  renderAccessEditorHtml,
  extractAccessSettingsFromEditor,
  wireAccessEditorEvents,
  PRESET_FULL_ACCESS,
} from './studentAccess.js';

let currentLoggedInProfile = null;
let currentStudentProfile = null;
let lastDashboardData = null;
let activeMessageNonce = null;

async function initStudentDetail() {
  const loggedInProfile = await requireAuth(['teacher', 'admin']);
  if (!loggedInProfile) return;

  if (loggedInProfile.role === 'teacher' && loggedInProfile.permissions?.can_view_students === false) {
    window.location.href = '/pages/teacher.html';
    return;
  }

  currentLoggedInProfile = loggedInProfile;

  // Render header details & role context
  renderHeaderUser(loggedInProfile);
  renderRoleContext(loggedInProfile);
  if (loggedInProfile.role === 'admin') {
    setupAdminNav(loggedInProfile);
  }

  // Hide Access button if teacher does not have task/access management permission
  const accessBtn = document.getElementById('btn-student-access');
  if (accessBtn && loggedInProfile.role === 'teacher' && loggedInProfile.permissions?.can_manage_tasks === false) {
    accessBtn.style.display = 'none';
  }

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

  // Verify assignment for teachers
  if (loggedInProfile.role === 'teacher' && isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data: assignment } = await supabase
      .from('teacher_student_assignments')
      .select('student_id')
      .eq('teacher_id', loggedInProfile.id)
      .eq('student_id', profile.id)
      .maybeSingle();

    if (!assignment) {
      showStudentNotFound('You do not have access to view this student. They are not in your assigned roster.');
      return;
    }
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

  document.getElementById('btn-student-access')?.addEventListener('click', () => {
    if (currentStudentProfile && currentLoggedInProfile) {
      openStudentAccessModal(currentStudentProfile, currentLoggedInProfile);
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
  setupStudentAccessModalHandlers();

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
    showToast('error', `Could not load student dashboard: ${err.message || 'Database error'}`);
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

  // Section "View all scores" links for Basics, Flash Anzan, Elements, and Memoriad
  const studentParam = encodeURIComponent(profile.id);
  const basicsLinkEl = document.getElementById('link-view-all-basics');
  if (basicsLinkEl) basicsLinkEl.href = `/pages/basics.html?student_id=${studentParam}`;
  const flashLinkEl = document.getElementById('link-view-all-flash');
  if (flashLinkEl) flashLinkEl.href = `/pages/flash.html?student_id=${studentParam}`;
  const elementsLinkEl = document.getElementById('link-view-all-elements');
  if (elementsLinkEl) elementsLinkEl.href = `/pages/elements.html?student_id=${studentParam}`;
  const memoriadLinkEl = document.getElementById('link-view-all-memoriad');
  if (memoriadLinkEl) memoriadLinkEl.href = `/pages/memoriad.html?student_id=${studentParam}`;
}

export function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  if (container) container.style.display = 'flex';
  const roleLabel = profile.role === 'admin' ? 'Admin' : (profile.role === 'teacher' ? 'Teacher' : 'Staff');
  if (nameEl) nameEl.textContent = profile.full_name || profile.name || roleLabel;
  if (roleEl) roleEl.textContent = roleLabel;

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

export function renderRoleContext(profile) {
  const banner = document.getElementById('role-context-banner');
  const bannerText = document.getElementById('role-context-banner-text');
  const backBtn = document.getElementById('btn-back-overview');
  const editProfileBtn = document.getElementById('btn-edit-student-profile');
  const sendMsgBtn = document.getElementById('btn-send-student-message');
  const auditBtn = document.getElementById('btn-student-change-history');

  if (banner) banner.style.display = 'flex';

  if (profile.role === 'admin') {
    if (bannerText) bannerText.innerHTML = 'Viewing as administrator';
    if (backBtn) {
      backBtn.href = '/pages/admin.html';
      backBtn.textContent = '← Back to Overview';
    }
    if (editProfileBtn) editProfileBtn.style.display = '';
    if (sendMsgBtn) sendMsgBtn.style.display = '';
    if (auditBtn) auditBtn.style.display = '';
  } else if (profile.role === 'teacher') {
    if (bannerText) bannerText.innerHTML = 'Viewing as teacher &mdash; read-only';
    if (backBtn) {
      backBtn.href = '/pages/teacher.html';
      backBtn.textContent = '← Back to Teacher Workspace';
    }
    // Teachers have read-only inspection on student detail: hide admin mutate actions
    if (editProfileBtn) editProfileBtn.style.display = 'none';
    if (sendMsgBtn) sendMsgBtn.style.display = 'none';
    if (auditBtn) auditBtn.style.display = 'none';
  }
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

// Request-generation cancellation guard for async modal selector loads
let activeMessageRequestGen = 0;
let activeModalTargetStudentId = null;

/**
 * Dynamically fetches eligible practice scores across all sections
 * (results: Basics & Round; activity_results: Elements, Flash Anzan, Memoriad)
 * for a specific student with request-generation race condition guards.
 */
export async function loadEligibleScoresForStudent(studentId, preselectedId = null) {
  const scoreSelect = document.getElementById('modal-msg-score-select');
  const retryBtn = document.getElementById('btn-retry-load-scores');
  if (!scoreSelect) return;

  const currentGen = ++activeMessageRequestGen;
  activeModalTargetStudentId = studentId;

  if (retryBtn) retryBtn.style.display = 'none';
  scoreSelect.innerHTML = '<option value="" disabled selected>Loading eligible practice scores...</option>';

  try {
    let combinedScores = [];

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const [resQuery, actQuery, jmcwcQuery] = await Promise.all([
          supabase
            .from('results')
            .select('id, student_id, category_id, correct, total, entry_date, created_at, categories (id, name, section)')
            .eq('student_id', studentId)
            .order('entry_date', { ascending: false })
            .limit(100),
          supabase
            .from('activity_results')
            .select('id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false })
            .limit(100),
          supabase
            .from('jmcwc_attempts')
            .select('id, student_id, group_key, mode, category_key, status, created_at, finished_at')
            .eq('student_id', studentId)
            .eq('status', 'submitted')
            .order('created_at', { ascending: false })
            .limit(100)
            .catch((err) => ({ data: null, error: err })),
        ]);

        if (resQuery.error) throw resQuery.error;
        if (actQuery.error) throw actQuery.error;
        if (jmcwcQuery?.error) {
          const isTableMissing =
            jmcwcQuery.error.code === '42P01' ||
            jmcwcQuery.error.code === 'PGRST204' ||
            jmcwcQuery.error.code === 'PGRST200' ||
            String(jmcwcQuery.error.message || '').includes('does not exist') ||
            String(jmcwcQuery.error.message || '').includes('relation "public.jmcwc_attempts" does not exist');
          if (!isTableMissing) {
            throw jmcwcQuery.error;
          }
        }

        const resultsList = (resQuery.data || []).map((r) => {
          const sectionLabel = r.categories?.section === 'round' ? 'Round' : 'Basics';
          const name = r.categories?.name || r.category_name || 'Practice';
          const dateStr = r.entry_date ? formatDisplayDateIST(r.entry_date) : '';
          return {
            id: r.id,
            type: sectionLabel,
            label: `[${sectionLabel}] ${dateStr} - ${name} (${r.correct ?? 0}/${r.total ?? 0})`,
            timestamp: new Date(r.created_at || r.entry_date || 0).getTime(),
          };
        });

        const actList = (actQuery.data || []).map((a) => {
          let typeLabel = 'Elements';
          if (a.activity_type === 'flash_anzan') typeLabel = 'Flash';
          else if (a.activity_type === 'memoriad') typeLabel = 'Memoriad';

          const dateStr = a.created_at ? formatDisplayDateIST(a.created_at) : '';
          return {
            id: a.id,
            type: typeLabel,
            label: `[${typeLabel}] ${dateStr} - ${a.activity_name || typeLabel} (${a.correct ?? 0}/${a.total ?? 0})`,
            timestamp: new Date(a.created_at || 0).getTime(),
          };
        });

        const jmcwcList = (jmcwcQuery?.data || []).map((j) => {
          const dateStr = j.created_at ? formatDisplayDateIST(j.created_at) : '';
          return {
            id: j.id,
            type: 'Main Round',
            label: `[Main Round] ${dateStr} - JMCWC Simulator (${j.group_key || 'Championship'})`,
            timestamp: new Date(j.created_at || 0).getTime(),
          };
        });

        combinedScores = [...resultsList, ...actList, ...jmcwcList].sort((a, b) => b.timestamp - a.timestamp);

        // If a specific preselected score is requested but not in the recent 100, fetch it directly
        if (preselectedId && !combinedScores.some((s) => String(s.id) === String(preselectedId))) {
          try {
            const [singleRes, singleAct, singleJmcwc] = await Promise.all([
              supabase.from('results').select('id, category_id, correct, total, entry_date, created_at, categories (name, section)').eq('id', preselectedId).single().catch(() => ({ data: null })),
              supabase.from('activity_results').select('id, activity_type, activity_name, correct, total, created_at').eq('id', preselectedId).single().catch(() => ({ data: null })),
              supabase.from('jmcwc_attempts').select('id, group_key, created_at').eq('id', preselectedId).single().catch(() => ({ data: null })),
            ]);

            if (singleRes?.data) {
              const r = singleRes.data;
              const sectionLabel = r.categories?.section === 'round' ? 'Round' : 'Basics';
              const name = r.categories?.name || 'Practice';
              const dateStr = r.entry_date ? formatDisplayDateIST(r.entry_date) : '';
              combinedScores.unshift({
                id: r.id,
                type: sectionLabel,
                label: `[${sectionLabel}] ${dateStr} - ${name} (${r.correct ?? 0}/${r.total ?? 0})`,
                timestamp: new Date(r.created_at || r.entry_date || 0).getTime(),
              });
            } else if (singleAct?.data) {
              const a = singleAct.data;
              let typeLabel = 'Elements';
              if (a.activity_type === 'flash_anzan') typeLabel = 'Flash';
              else if (a.activity_type === 'memoriad') typeLabel = 'Memoriad';
              const dateStr = a.created_at ? formatDisplayDateIST(a.created_at) : '';
              combinedScores.unshift({
                id: a.id,
                type: typeLabel,
                label: `[${typeLabel}] ${dateStr} - ${a.activity_name || typeLabel} (${a.correct ?? 0}/${a.total ?? 0})`,
                timestamp: new Date(a.created_at || 0).getTime(),
              });
            } else if (singleJmcwc?.data) {
              const j = singleJmcwc.data;
              const dateStr = j.created_at ? formatDisplayDateIST(j.created_at) : '';
              combinedScores.unshift({
                id: j.id,
                type: 'Main Round',
                label: `[Main Round] ${dateStr} - JMCWC Simulator (${j.group_key || 'Championship'})`,
                timestamp: new Date(j.created_at || 0).getTime(),
              });
            }
          } catch {
            // non-blocking fallback
          }
        }
      }
    } else if (isDemoMode() && DemoDB) {
      const allRes = DemoDB.getResults ? DemoDB.getResults() : [];
      const cats = DemoDB.getCategories ? DemoDB.getCategories() : [];
      const catMap = new Map(cats.map((c) => [c.id, c]));

      const resultsList = allRes
        .filter((r) => r.student_id === studentId)
        .map((r) => {
          const cat = catMap.get(r.category_id);
          const sectionLabel = cat?.section === 'round' ? 'Round' : 'Basics';
          const name = cat?.name || r.category_name || 'Practice';
          const dateStr = r.entry_date ? formatDisplayDateIST(r.entry_date) : '';
          return {
            id: r.id,
            type: sectionLabel,
            label: `[${sectionLabel}] ${dateStr} - ${name} (${r.correct ?? 0}/${r.total ?? 0})`,
            timestamp: new Date(r.created_at || r.entry_date || 0).getTime(),
          };
        });

      const allActs = DemoDB.getActivityResults ? DemoDB.getActivityResults(studentId) : [];
      const actList = (Array.isArray(allActs) ? allActs : [])
        .filter((a) => a.student_id === studentId)
        .map((a) => {
          let typeLabel = 'Elements';
          if (a.activity_type === 'flash_anzan') typeLabel = 'Flash';
          else if (a.activity_type === 'memoriad') typeLabel = 'Memoriad';
          const dateStr = a.created_at ? formatDisplayDateIST(a.created_at) : '';
          return {
            id: a.id,
            type: typeLabel,
            label: `[${typeLabel}] ${dateStr} - ${a.activity_name || typeLabel} (${a.correct ?? 0}/${a.total ?? 0})`,
            timestamp: new Date(a.created_at || 0).getTime(),
          };
        });

      const allJmcwc = DemoDB.getJmcwcAttempts ? DemoDB.getJmcwcAttempts(studentId) : [];
      const jmcwcList = (Array.isArray(allJmcwc) ? allJmcwc : [])
        .filter((j) => j.student_id === studentId)
        .map((j) => {
          const dateStr = j.created_at ? formatDisplayDateIST(j.created_at) : '';
          return {
            id: j.id,
            type: 'Main Round',
            label: `[Main Round] ${dateStr} - JMCWC Simulator (${j.group_key || 'Championship'})`,
            timestamp: new Date(j.created_at || 0).getTime(),
          };
        });

      combinedScores = [...resultsList, ...actList, ...jmcwcList].sort((a, b) => b.timestamp - a.timestamp);
    }

    // Cancellation / Race condition check: ignore response if newer request was launched or target student switched
    if (currentGen !== activeMessageRequestGen || activeModalTargetStudentId !== studentId) {
      return;
    }

    if (combinedScores.length === 0) {
      scoreSelect.innerHTML = '<option value="" disabled selected>No eligible practice scores found for this student</option>';
      return;
    }

    scoreSelect.innerHTML = '<option value="">Choose a practice score...</option>';

    // Build options, guaranteeing that preselectedId is included even if it falls beyond the initial slice
    let visibleScores = combinedScores.slice(0, 100);
    if (preselectedId && !visibleScores.some((s) => String(s.id) === String(preselectedId))) {
      const foundOlder = combinedScores.find((s) => String(s.id) === String(preselectedId));
      if (foundOlder) {
        visibleScores.unshift(foundOlder);
      }
    }

    visibleScores.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.label;
      if (preselectedId && String(preselectedId) === String(item.id)) {
        opt.selected = true;
      }
      scoreSelect.appendChild(opt);
    });

    if (preselectedId) {
      scoreSelect.value = preselectedId;
    }
  } catch (err) {
    if (currentGen !== activeMessageRequestGen || activeModalTargetStudentId !== studentId) {
      return;
    }
    console.error('Failed to load eligible scores for student message:', err);
    scoreSelect.innerHTML = '<option value="" disabled selected>Could not load practice scores</option>';
    if (retryBtn) {
      retryBtn.style.display = 'inline-block';
      retryBtn.onclick = () => loadEligibleScoresForStudent(studentId, preselectedId);
    }
  }
}

/**
 * Dynamically fetches eligible weekly tests for a specific student,
 * filtered by audience level and accessibility, with race condition guards.
 */
export async function loadEligibleTestsForStudent(studentId, preselectedId = null) {
  const testSelect = document.getElementById('modal-msg-test-select');
  const retryBtn = document.getElementById('btn-retry-load-tests');
  if (!testSelect) return;

  const currentGen = ++activeMessageRequestGen;
  activeModalTargetStudentId = studentId;

  if (retryBtn) retryBtn.style.display = 'none';
  testSelect.innerHTML = '<option value="" disabled selected>Loading weekly tests...</option>';

  try {
    let tests = [];
    const studentLevel = (currentStudentProfile?.level || '').trim().toLowerCase();

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('weekly_tests')
          .select('id, title, test_date, audience_level')
          .order('test_date', { ascending: false })
          .limit(100);

        if (error) throw error;
        tests = data || [];
      }
    } else if (isDemoMode() && DemoDB) {
      const rawTests = DemoDB.getWeeklyTests ? DemoDB.getWeeklyTests() : [];
      tests = Array.isArray(rawTests?.tests) ? rawTests.tests : (Array.isArray(rawTests) ? rawTests : []);
    }

    // Filter by student recipient level accessibility
    if (studentLevel) {
      tests = tests.filter((t) => {
        if (!t.audience_level || t.audience_level === 'all') return true;
        return t.audience_level.trim().toLowerCase() === studentLevel;
      });
    }

    // Cancellation / Race condition check
    if (currentGen !== activeMessageRequestGen || activeModalTargetStudentId !== studentId) {
      return;
    }

    if (tests.length === 0) {
      testSelect.innerHTML = '<option value="" disabled selected>No weekly tests found for this student</option>';
      return;
    }

    testSelect.innerHTML = '<option value="">Choose a weekly test...</option>';
    tests.slice(0, 100).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      const dateStr = t.test_date ? formatDisplayDateIST(t.test_date) : '';
      opt.textContent = `${dateStr} - ${t.title || 'Weekly Test'}`;
      if (preselectedId && String(preselectedId) === String(t.id)) {
        opt.selected = true;
      }
      testSelect.appendChild(opt);
    });

    if (preselectedId) {
      testSelect.value = preselectedId;
    }
  } catch (err) {
    if (currentGen !== activeMessageRequestGen || activeModalTargetStudentId !== studentId) {
      return;
    }
    console.error('Failed to load eligible weekly tests for student message:', err);
    testSelect.innerHTML = '<option value="" disabled selected>Could not load weekly tests</option>';
    if (retryBtn) {
      retryBtn.style.display = 'inline-block';
      retryBtn.onclick = () => loadEligibleTestsForStudent(studentId, preselectedId);
    }
  }
}

export function openSendMessageModal(profile, dashboardData, options = {}) {
  const recipientEl = document.getElementById('modal-msg-recipient-text');
  if (recipientEl && profile) {
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

  const initialLinkType = options.linkType || 'general';
  if (linkTypeSelect) linkTypeSelect.value = initialLinkType;
  if (scoreGroup) scoreGroup.style.display = initialLinkType === 'score' ? 'block' : 'none';
  if (testGroup) testGroup.style.display = initialLinkType === 'weekly_test' ? 'block' : 'none';
  if (needsAttentionCb) needsAttentionCb.checked = Boolean(options.needsAttention);
  if (attentionReasonWrap) attentionReasonWrap.style.display = options.needsAttention ? 'block' : 'none';
  if (attentionReasonInput) attentionReasonInput.value = options.attentionReason || '';
  if (titleInput) titleInput.value = options.title || '';
  if (bodyInput) bodyInput.value = options.body || '';

  // Populate scores select
  if (scoreSelect) {
    scoreSelect.innerHTML = '<option value="">Choose a recent score...</option>';
    const results = Array.isArray(dashboardData?.results) ? dashboardData.results : [];
    results.slice(0, 30).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      const catName = r.categories?.name || r.category_name || 'Practice';
      const scoreStr = `${r.correct ?? 0}/${r.total ?? 0}`;
      const dateStr = r.entry_date ? formatDisplayDateIST(r.entry_date) : '';
      opt.textContent = `${dateStr} - ${catName} (Score: ${scoreStr})`;
      if (options.scoreId && String(options.scoreId) === String(r.id)) {
        opt.selected = true;
      }
      scoreSelect.appendChild(opt);
    });
    if (options.scoreId) {
      scoreSelect.value = options.scoreId;
    }
  }

  // Populate weekly tests select (Contract: weeklyTests: { tests, scores } or fallback array)
  if (testSelect) {
    testSelect.innerHTML = '<option value="">Choose a weekly test...</option>';
    const rawWeeklyTests = dashboardData?.weeklyTests;
    const tests = Array.isArray(rawWeeklyTests?.tests)
      ? rawWeeklyTests.tests
      : (Array.isArray(rawWeeklyTests) ? rawWeeklyTests : []);
    tests.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      const dateStr = t.test_date ? formatDisplayDateIST(t.test_date) : '';
      opt.textContent = `${dateStr} - ${t.title || 'Weekly Test'}`;
      if (options.testId && String(options.testId) === String(t.id)) {
        opt.selected = true;
      }
      testSelect.appendChild(opt);
    });
    if (options.testId) {
      testSelect.value = options.testId;
    }
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

      // Clear alternate selector and trigger dynamic load
      if (val === 'score') {
        const testSel = document.getElementById('modal-msg-test-select');
        if (testSel) testSel.value = '';
        if (currentStudentProfile?.id) {
          loadEligibleScoresForStudent(currentStudentProfile.id);
        }
      } else if (val === 'weekly_test') {
        const scoreSel = document.getElementById('modal-msg-score-select');
        if (scoreSel) scoreSel.value = '';
        if (currentStudentProfile?.id) {
          loadEligibleTestsForStudent(currentStudentProfile.id);
        }
      } else {
        const scoreSel = document.getElementById('modal-msg-score-select');
        if (scoreSel) scoreSel.value = '';
        const testSel = document.getElementById('modal-msg-test-select');
        if (testSel) testSel.value = '';
      }
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

let currentAccessSettings = null;
let currentAccessSource = 'level';
let isStudentMainRoundEligible = true;

export async function openStudentAccessModal(studentProfile, staffProfile) {
  const modalId = 'modal-student-access';
  const nameEl = document.getElementById('modal-access-student-name');
  const badgeEl = document.getElementById('modal-access-provenance-badge');
  const mountEl = document.getElementById('student-access-editor-mount');
  const resetBtn = document.getElementById('btn-reset-student-access');
  const isDemo = isDemoMode();
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  if (nameEl) {
    const fullName = studentProfile.full_name || studentProfile.name || 'Student';
    nameEl.textContent = `${fullName} (${studentProfile.student_code || studentProfile.id || '—'}) · Level: ${studentProfile.level || 'Unassigned'}`;
  }

  if (badgeEl) {
    badgeEl.className = 'badge badge-neutral';
    badgeEl.textContent = 'Loading access...';
  }

  if (resetBtn) {
    resetBtn.style.display = 'none';
  }

  if (mountEl) {
    mountEl.innerHTML = `
      <div style="padding: var(--space-6); text-align: center; color: var(--text-muted);">
        <span class="spinner" style="margin-right: 8px;"></span> Loading practice access for student...
      </div>
    `;
  }

  openModal(modalId);

  try {
    const accessRes = await fetchStudentEffectiveAccess(studentProfile.id, {
      supabase,
      isDemo,
      DemoDB,
    });

    if (!accessRes || !accessRes.ok) {
      if (mountEl) {
        mountEl.innerHTML = `<div class="banner banner-error">Failed to load student access: ${escapeHtml(accessRes?.error || 'Unknown error')}</div>`;
      }
      return;
    }

    currentAccessSettings = accessRes.settings || PRESET_FULL_ACCESS;
    currentAccessSource = accessRes.scope; // 'student' | 'level' | 'default'
    isStudentMainRoundEligible = accessRes.main_round_eligible !== false;

    if (badgeEl) {
      if (accessRes.scope === 'student') {
        badgeEl.className = 'badge badge-primary';
        badgeEl.textContent = 'Student override';
      } else if (accessRes.scope === 'level') {
        badgeEl.className = 'badge badge-neutral';
        badgeEl.textContent = `From ${accessRes.level || studentProfile.level || 'Level'}`;
      } else {
        badgeEl.className = 'badge badge-neutral';
        badgeEl.textContent = 'Default (Full access)';
      }
    }

    if (resetBtn) {
      resetBtn.style.display = accessRes.scope === 'student' ? 'inline-block' : 'none';
    }

    const bulkBtn = document.getElementById('btn-bulk-apply-student-level');
    if (bulkBtn) {
      if (studentProfile.level && (staffProfile?.role === 'teacher' || staffProfile?.role === 'admin')) {
        bulkBtn.style.display = 'inline-block';
        bulkBtn.textContent = staffProfile?.role === 'teacher' ? 'Apply to my students in this level' : 'Apply to all students in this level';
      } else {
        bulkBtn.style.display = 'none';
      }
    }

    // Load basics categories from lastDashboardData or DemoDB/supabase
    let basicsCats = (lastDashboardData?.categories || []).filter((c) => c.section === 'basics');
    if (basicsCats.length === 0 && isDemo && DemoDB?.getCategories) {
      basicsCats = DemoDB.getCategories().filter((c) => c.section === 'basics');
    } else if (basicsCats.length === 0 && supabase) {
      const { data: catRows } = await supabase
        .from('categories')
        .select('*')
        .eq('section', 'basics')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (catRows) basicsCats = catRows;
    }

    if (mountEl) {
      mountEl.innerHTML = renderAccessEditorHtml({
        settings: currentAccessSettings,
        basicsCategories: basicsCats,
        isTeacher: staffProfile?.role === 'teacher',
        isEligibleForMainRound: isStudentMainRoundEligible,
        canToggleEligibility: staffProfile?.role === 'admin',
      });

      wireAccessEditorEvents(mountEl, (updated) => {
        currentAccessSettings = updated;
      });
    }
  } catch (err) {
    console.error('Failed to open student access modal:', err);
    if (mountEl) {
      mountEl.innerHTML = `<div class="banner banner-error">Error loading student access: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function setupStudentAccessModalHandlers() {
  const modalId = 'modal-student-access';
  const saveBtn = document.getElementById('btn-save-student-access');
  const resetBtn = document.getElementById('btn-reset-student-access');
  const cancelBtn = document.getElementById('btn-cancel-student-access');
  const closeBtn = document.getElementById('btn-close-access-modal');
  const mountEl = document.getElementById('student-access-editor-mount');

  const bulkBtn = document.getElementById('btn-bulk-apply-student-level');

  cancelBtn?.addEventListener('click', () => closeModal(modalId));
  closeBtn?.addEventListener('click', () => closeModal(modalId));

  bulkBtn?.addEventListener('click', async () => {
    if (!currentStudentProfile) return;
    const studentLevel = currentStudentProfile.level;
    if (!studentLevel) {
      showToast('error', 'Student has no assigned curriculum level.');
      return;
    }
    const isDemo = isDemoMode();
    const supabase = isSupabaseConfigured() ? await getSupabase() : null;

    bulkBtn.disabled = true;
    bulkBtn.textContent = 'Checking students...';

    try {
      const countRes = await getTeacherLevelStudentCount(studentLevel, {
        supabase,
        isDemo,
        DemoDB,
        currentProfile: currentLoggedInProfile,
      });
      const affectedCount = countRes.ok ? countRes.count : 0;
      const roleNoun = currentLoggedInProfile?.role === 'teacher' ? 'assigned to you' : 'in total';
      if (!confirm(`Apply these practice settings to all ${affectedCount} active students in ${studentLevel} ${roleNoun}?`)) {
        return;
      }

      bulkBtn.textContent = 'Applying...';
      const newSettings = extractAccessSettingsFromEditor(mountEl);
      const res = await teacherBulkApplyLevelAccess(studentLevel, newSettings, {
        supabase,
        isDemo,
        DemoDB,
        currentProfile: currentLoggedInProfile,
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || 'Failed to apply settings');
      }

      showToast('success', `Applied settings to ${res.affected_count ?? affectedCount} students in ${studentLevel}.`);
      closeModal(modalId);
    } catch (err) {
      console.error('Failed to bulk apply student access:', err);
      showToast('error', `Bulk apply failed: ${err.message}`);
    } finally {
      bulkBtn.disabled = false;
      bulkBtn.textContent = currentLoggedInProfile?.role === 'teacher' ? 'Apply to my students in this level' : 'Apply to all students in this level';
    }
  });

  saveBtn?.addEventListener('click', async () => {
    if (!currentStudentProfile) return;
    const isDemo = isDemoMode();
    const supabase = isSupabaseConfigured() ? await getSupabase() : null;

    const newSettings = extractAccessSettingsFromEditor(mountEl);
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving override...';

    try {
      const res = await saveStudentAccessOverride(currentStudentProfile.id, newSettings, {
        supabase,
        isDemo,
        DemoDB,
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || 'Failed to save access override');
      }

      showToast('success', `Saved practice access override for ${currentStudentProfile.full_name || 'student'}.`);
      closeModal(modalId);
    } catch (err) {
      console.error('Failed to save student access override:', err);
      showToast('error', `Failed to save override: ${err.message}`);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Access Override';
    }
  });

  resetBtn?.addEventListener('click', async () => {
    if (!currentStudentProfile) return;
    if (!confirm('Revert this student to their level defaults? This will remove their individual access override.')) {
      return;
    }

    const isDemo = isDemoMode();
    const supabase = isSupabaseConfigured() ? await getSupabase() : null;

    resetBtn.disabled = true;
    resetBtn.textContent = 'Reverting...';

    try {
      const res = await resetStudentAccessOverride(currentStudentProfile.id, {
        supabase,
        isDemo,
        DemoDB,
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || 'Failed to reset access override');
      }

      showToast('success', 'Student override removed. Level defaults now apply.');
      await openStudentAccessModal(currentStudentProfile, currentLoggedInProfile);
    } catch (err) {
      console.error('Failed to reset student access override:', err);
      showToast('error', `Failed to reset override: ${err.message}`);
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Use level settings';
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initStudentDetail);
}
