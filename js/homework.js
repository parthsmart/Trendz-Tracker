/**
 * Trendz Tracker — Admin & Teacher Homework Controller (js/homework.js)
 *
 * Enables admins and authorized teachers to assign homework independently of
 * Daily To-Do streaks.
 * - Permission-gated: teachers require can_manage_tasks permission.
 * - Teacher roster scoping: 'all' targets all authorized assigned students in roster.
 * - Supports all activity types including Main Round, Basics, Flash, Elements, Memoriad, Paper, Custom.
 * - Preserves assigned IST date, settings, duration, and full recipient history.
 * - Active vs History view toggles.
 */

import { requireAuth } from './guard.js';
import { setupAdminNav, setupModalListeners } from './modal.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { showToast } from './toast.js';
import {
  createHomeworkAssignment,
  formatHomeworkTypeLabel,
  verifyHomeworkCompletion,
} from './homeworkData.js';

let currentProfile = null;
let teacherStudentIds = [];
let allStudents = [];
let allCategories = [];
let activeTab = 'active'; // 'active' | 'history'
let cachedAssignments = [];
let cachedPendingSubmissions = [];

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getTodayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function initHomeworkPage() {
  currentProfile = await requireAuth(['admin', 'teacher']);
  if (!currentProfile) return;

  // Teacher permission gating: requires can_manage_tasks
  if (currentProfile.role === 'teacher') {
    const perms = currentProfile.teacher_permissions || {};
    if (perms.can_manage_tasks === false) {
      showToast('error', 'You do not have permission to manage homework tasks.');
      window.location.replace('/pages/teacher.html');
      return;
    }
  }

  setupAdminNav(currentProfile);
  setupModalListeners();

  // Set default assigned date to today IST
  const assignedDateInput = document.getElementById('hw-assigned-date');
  if (assignedDateInput && !assignedDateInput.value) {
    assignedDateInput.value = getTodayIST();
  }

  await loadStudentRoster();
  await loadCategories();
  setupTargetControls();
  setupActivityTypeControls();
  setupTabControls();
  setupFormHandler();
  await loadPendingSubmissions();
  await loadAssignments();
}

async function loadStudentRoster() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      if (currentProfile.role === 'admin') {
        const { data } = await supabase
          .from('profiles')
          .select('id, student_code, full_name, level, active')
          .eq('role', 'student')
          .eq('active', true)
          .order('full_name', { ascending: true });
        allStudents = data || [];
        teacherStudentIds = allStudents.map((s) => s.id);
      } else {
        // Teacher role: query assigned students
        const { data: assignments } = await supabase
          .from('teacher_student_assignments')
          .select('student_id, student:profiles!student_id (id, student_code, full_name, level, active)')
          .eq('teacher_id', currentProfile.id);

        allStudents = (assignments || [])
          .map((a) => a.student)
          .filter((s) => s && s.active !== false);
        teacherStudentIds = allStudents.map((s) => s.id);
      }
      populateStudentDropdown();
      return;
    }
  }

  // DemoDB fallback
  if (isDemoAllowedHost() && DemoDB) {
    allStudents = DemoDB.getStudents ? DemoDB.getStudents().filter((s) => s.active !== false) : [];
    teacherStudentIds = allStudents.map((s) => s.id);
    populateStudentDropdown();
  }
}

async function loadCategories() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const { data } = await supabase
        .from('categories')
        .select('id, name, section, sort_order')
        .in('section', ['basics', 'round'])
        .eq('active', true)
        .order('sort_order', { ascending: true });
      allCategories = data || [];
      populateCategoryDropdown();
      return;
    }
  }

  allCategories = [
    { id: 'cat-add', name: 'Addition & Subtraction', section: 'basics' },
    { id: 'cat-mul', name: 'Multiplication', section: 'basics' },
    { id: 'cat-div', name: 'Division', section: 'basics' },
    { id: 'cat-rnd-1', name: 'Main Round Stage 1', section: 'round' },
  ];
  populateCategoryDropdown();
}

function populateStudentDropdown() {
  const select = document.getElementById('hw-target-student');
  if (!select) return;

  select.innerHTML = [
    '<option value="">Choose a student...</option>',
    ...allStudents.map(
      (s) =>
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.full_name || s.student_code)} (${escapeHtml(s.student_code)}) · ${escapeHtml(s.level || 'No level')}</option>`
    ),
  ].join('');
}

function populateCategoryDropdown(sectionFilter = 'basics') {
  const select = document.getElementById('hw-category');
  if (!select) return;

  const filtered = allCategories.filter((c) => c.section === sectionFilter);
  select.innerHTML = [
    '<option value="">Any / General Category</option>',
    ...filtered.map(
      (c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`
    ),
  ].join('');
}

function setupTargetControls() {
  const targetTypeSelect = document.getElementById('hw-target-type');
  const levelGroup = document.getElementById('group-target-level');
  const studentGroup = document.getElementById('group-target-student');

  if (currentProfile?.role === 'teacher') {
    // For teachers, 'all' means all students in their authorized roster
    const allOption = targetTypeSelect?.querySelector('option[value="all"]');
    if (allOption) {
      allOption.textContent = 'All My Assigned Students (Roster)';
    }
  }

  targetTypeSelect?.addEventListener('change', () => {
    const val = targetTypeSelect.value;
    if (levelGroup) levelGroup.style.display = val === 'level' ? 'block' : 'none';
    if (studentGroup) studentGroup.style.display = val === 'student' ? 'block' : 'none';
  });
}

function setupActivityTypeControls() {
  const actSelect = document.getElementById('hw-activity-type');
  const catGroup = document.getElementById('group-hw-category');
  const durGroup = document.getElementById('group-hw-duration');
  const flashGroup = document.getElementById('group-hw-flash');
  const elemGroup = document.getElementById('group-hw-element');
  const memoGroup = document.getElementById('group-hw-memoriad');

  function updateVisibility() {
    const act = actSelect?.value || 'basics';

    if (catGroup) {
      catGroup.style.display = act === 'basics' || act === 'round' ? 'block' : 'none';
      populateCategoryDropdown(act === 'round' ? 'round' : 'basics');
    }
    if (durGroup) {
      durGroup.style.display = act === 'basics' ? 'block' : 'none';
    }
    if (flashGroup) {
      flashGroup.style.display = act === 'flash' ? 'block' : 'none';
    }
    if (elemGroup) {
      elemGroup.style.display = act === 'element' ? 'block' : 'none';
    }
    if (memoGroup) {
      memoGroup.style.display = act === 'memoriad' ? 'block' : 'none';
    }
  }

  actSelect?.addEventListener('change', updateVisibility);
  updateVisibility();
}

function setupTabControls() {
  const tabActive = document.getElementById('tab-hw-active');
  const tabHistory = document.getElementById('tab-hw-history');

  tabActive?.addEventListener('click', () => {
    activeTab = 'active';
    tabActive.classList.replace('btn-outline', 'btn-primary');
    tabActive.setAttribute('aria-selected', 'true');
    tabHistory.classList.replace('btn-primary', 'btn-outline');
    tabHistory.setAttribute('aria-selected', 'false');
    renderAssignmentsTable();
  });

  tabHistory?.addEventListener('click', () => {
    activeTab = 'history';
    tabHistory.classList.replace('btn-outline', 'btn-primary');
    tabHistory.setAttribute('aria-selected', 'true');
    tabActive.classList.replace('btn-primary', 'btn-outline');
    tabActive.setAttribute('aria-selected', 'false');
    renderAssignmentsTable();
  });
}

function setupFormHandler() {
  const form = document.getElementById('form-create-homework');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = document.getElementById('hw-title')?.value?.trim();
    const targetType = document.getElementById('hw-target-type')?.value;
    const targetLevel = document.getElementById('hw-target-level')?.value;
    const targetStudentId = document.getElementById('hw-target-student')?.value;
    const activityType = document.getElementById('hw-activity-type')?.value;
    const categoryId = document.getElementById('hw-category')?.value || null;
    const durationSeconds = activityType === 'basics' ? Number(document.getElementById('hw-duration')?.value) || 60 : null;
    const requiredCount = Number(document.getElementById('hw-required-count')?.value) || 1;
    const assignedDate = document.getElementById('hw-assigned-date')?.value || getTodayIST();
    const dueDate = document.getElementById('hw-due-date')?.value || null;
    const instructions = document.getElementById('hw-instructions')?.value?.trim() || null;
    const submitBtn = document.getElementById('btn-submit-homework');

    // Build settings JSONB
    let settings = {};
    if (activityType === 'flash') {
      settings = {
        digits: Number(document.getElementById('hw-flash-digits')?.value) || 2,
        count: Number(document.getElementById('hw-flash-count')?.value) || 10,
        speed_ms: Number(document.getElementById('hw-flash-speed')?.value) || 1000,
        mode: 'add',
      };
    } else if (activityType === 'element') {
      settings = {
        drill: document.getElementById('hw-element-drill')?.value || 'addition_stage_1',
      };
    } else if (activityType === 'memoriad') {
      settings = {
        module: document.getElementById('hw-memoriad-module')?.value || 'calendar',
      };
    }

    if (!title) {
      showToast('error', 'Please enter a homework title.');
      return;
    }

    if (targetType === 'student' && !targetStudentId) {
      showToast('error', 'Please select a student.');
      return;
    }

    try {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Assigning...';
      }

      await createHomeworkAssignment(
        {
          title,
          targetType,
          targetLevel: targetType === 'level' ? targetLevel : null,
          targetStudentId: targetType === 'student' ? targetStudentId : null,
          activityType,
          categoryId,
          settings,
          durationSeconds,
          requiredCount,
          assignedDate,
          dueDate,
          instructions,
        },
        currentProfile,
        teacherStudentIds
      );

      showToast('success', 'Homework assigned successfully.');
      form.reset();
      const assignedDateInput = document.getElementById('hw-assigned-date');
      if (assignedDateInput) assignedDateInput.value = getTodayIST();
      await loadPendingSubmissions();
      await loadAssignments();
    } catch (err) {
      console.error('Failed to create homework:', err);
      showToast('error', err.message || 'Failed to assign homework.');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Assign Homework →';
      }
    }
  });
}

async function loadAssignments() {
  const countBadge = document.getElementById('homework-count-badge');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        let q = supabase
          .from('homework_assignments')
          .select('id, title, instructions, target_type, target_level, target_student_id, activity_type, category_id, settings, duration_seconds, required_count, assigned_date, due_date, created_at, category:categories!category_id (name)')
          .order('created_at', { ascending: false });

        if (currentProfile.role === 'teacher') {
          q = q.eq('assigned_by', currentProfile.id);
        }

        const { data, error } = await q;
        if (error) throw error;
        cachedAssignments = data || [];
      }
    } else if (isDemoAllowedHost() && DemoDB && typeof DemoDB.getHomeworkAssignments === 'function') {
      cachedAssignments = DemoDB.getHomeworkAssignments(currentProfile);
    }

    if (countBadge) {
      countBadge.textContent = `${cachedAssignments.length} ${cachedAssignments.length === 1 ? 'assignment' : 'assignments'}`;
    }

    renderAssignmentsTable();
  } catch (err) {
    console.error('Failed to load assignments:', err);
    const tbody = document.getElementById('homework-table-body');
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--color-danger); padding: var(--space-4);">
            Could not load assignments: ${escapeHtml(err.message || 'Database error')}
          </td>
        </tr>
      `;
    }
  }
}

function renderAssignmentsTable() {
  const tbody = document.getElementById('homework-table-body');
  if (!tbody) return;

  const todayIST = getTodayIST();
  let displayed = cachedAssignments;

  if (activeTab === 'active') {
    // Show assignments whose assigned_date is today or due_date >= today or no due date
    displayed = cachedAssignments.filter((a) => {
      const aDate = a.assigned_date || (a.created_at ? a.created_at.slice(0, 10) : todayIST);
      if (aDate === todayIST) return true;
      if (a.due_date && a.due_date >= todayIST) return true;
      return false;
    });
  }

  if (displayed.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: var(--space-4);">
          ${activeTab === 'active' ? 'No active homework assignments for today.' : 'No homework assignments found.'}
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = displayed
    .map((a) => {
      let targetText = 'All Students';
      if (a.target_type === 'level') targetText = `Level: ${a.target_level || '—'}`;
      if (a.target_type === 'student') {
        const stu = allStudents.find((s) => s.id === a.target_student_id);
        targetText = stu ? `${stu.full_name} (${stu.student_code})` : 'Specific Student';
      }

      let settingsDesc = '—';
      if (a.activity_type === 'basics') {
        const catName = a.category?.name || 'Any Category';
        const dur = a.duration_seconds ? `${a.duration_seconds}s` : '60s';
        settingsDesc = `${catName} (${dur})`;
      } else if (a.activity_type === 'round') {
        settingsDesc = a.category?.name || 'Main Round';
      } else if (a.activity_type === 'flash') {
        const s = a.settings || {};
        settingsDesc = `${s.digits || 2}d · ${s.count || 10}n · ${(s.speed_ms || 1000) / 1000}s`;
      } else if (a.activity_type === 'element') {
        settingsDesc = a.settings?.drill || 'Drill';
      } else if (a.activity_type === 'memoriad') {
        settingsDesc = a.settings?.module || 'Module';
      }

      const assignedStr = a.assigned_date || (a.created_at ? a.created_at.slice(0, 10) : '—');
      const dueStr = a.due_date ? String(a.due_date) : 'No due date';

      return `
        <tr>
          <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(a.title)}</td>
          <td><span class="badge" style="font-size: 11px;">${escapeHtml(targetText)}</span></td>
          <td>${escapeHtml(formatHomeworkTypeLabel(a.activity_type))}</td>
          <td style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(settingsDesc)}</td>
          <td class="num">${a.required_count || 1} &times;</td>
          <td class="num" style="font-size: var(--text-xs);">${escapeHtml(assignedStr)}</td>
          <td class="num" style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(dueStr)}</td>
        </tr>
      `;
    })
    .join('');
}

async function loadPendingSubmissions() {
  const countBadge = document.getElementById('pending-homework-count-badge');
  const tbody = document.getElementById('pending-homework-table-body');
  if (!tbody) return;

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        if (currentProfile?.role === 'teacher' && teacherStudentIds.length === 0) {
          cachedPendingSubmissions = [];
        } else {
          let q = supabase
            .from('homework_completions')
            .select(`
              id,
              assignment_id,
              student_id,
              progress_count,
              status,
              notes,
              updated_at,
              created_at,
              student:profiles!student_id (id, student_code, full_name, level),
              assignment:homework_assignments!assignment_id (id, title, activity_type, required_count, assigned_by)
            `)
            .eq('status', 'pending_review')
            .order('updated_at', { ascending: false });

          // Teachers only query actionable submissions for students currently on their roster
          if (currentProfile?.role === 'teacher') {
            q = q.in('student_id', teacherStudentIds);
          }

          const { data, error } = await q;
          if (error) throw error;
          cachedPendingSubmissions = data || [];
        }
      }
    } else if (isDemoAllowedHost() && DemoDB && typeof DemoDB.getPendingHomeworkCompletions === 'function') {
      cachedPendingSubmissions = DemoDB.getPendingHomeworkCompletions(currentProfile);
    }

    // Strict boundary: For teacher role, show actionable submissions ONLY for students currently on their roster
    if (currentProfile?.role === 'teacher') {
      cachedPendingSubmissions = cachedPendingSubmissions.filter((c) => {
        return teacherStudentIds.includes(c.student_id);
      });
    }

    if (countBadge) {
      countBadge.textContent = `${cachedPendingSubmissions.length} pending`;
      if (cachedPendingSubmissions.length > 0) {
        countBadge.classList.add('badge-warning');
      } else {
        countBadge.classList.remove('badge-warning');
      }
    }

    renderPendingSubmissionsTable();
  } catch (err) {
    console.error('Failed to load pending submissions:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--color-danger); padding: var(--space-4);">
            Could not load pending submissions: ${escapeHtml(err.message || 'Database error')}
          </td>
        </tr>
      `;
    }
  }
}

function renderPendingSubmissionsTable() {
  const tbody = document.getElementById('pending-homework-table-body');
  if (!tbody) return;

  if (cachedPendingSubmissions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: var(--space-4);">
          No pending homework submissions to review.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = cachedPendingSubmissions
    .map((c) => {
      const studentName = c.student?.full_name || 'Student';
      const studentCode = c.student?.student_code || '—';
      const studentLevel = c.student?.level || 'No level';
      const assignTitle = c.assignment?.title || 'Untitled Homework';
      const activityType = c.assignment?.activity_type || 'paper';
      const typeLabel = formatHomeworkTypeLabel(activityType);
      const notes = c.notes ? escapeHtml(c.notes) : '<span style="color: var(--text-muted);">None</span>';

      let submittedDate = '—';
      if (c.updated_at || c.created_at) {
        const d = new Date(c.updated_at || c.created_at);
        submittedDate = d.toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'short',
          timeStyle: 'short',
        });
      }

      const canAction = currentProfile?.role === 'admin' || (currentProfile?.role === 'teacher' && teacherStudentIds.includes(c.student_id));
      const actionsHtml = canAction
        ? `
            <button type="button" class="btn btn-xs btn-primary btn-approve-hw" data-id="${escapeHtml(c.id)}" style="margin-right: 4px;">
              Approve
            </button>
            <button type="button" class="btn btn-xs btn-outline btn-reject-hw" data-id="${escapeHtml(c.id)}" style="color: var(--color-danger);">
              Reject
            </button>
          `
        : `<span style="font-size: var(--text-xs); color: var(--text-muted);">Not on roster</span>`;

      return `
        <tr data-completion-id="${escapeHtml(c.id)}">
          <td>
            <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(studentName)}</div>
            <div style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(studentCode)} &middot; ${escapeHtml(studentLevel)}</div>
          </td>
          <td>
            <div style="font-weight: 600;">${escapeHtml(assignTitle)}</div>
            <span class="badge" style="font-size: 10px;">${escapeHtml(typeLabel)}</span>
          </td>
          <td class="num" style="font-size: var(--text-xs);">${escapeHtml(submittedDate)}</td>
          <td style="font-size: var(--text-xs); max-width: 200px; word-break: break-word;">${notes}</td>
          <td style="text-align: right; white-space: nowrap;">
            ${actionsHtml}
          </td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.btn-approve-hw').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      await handleVerifyPendingSubmission(id, 'approve', btn);
    });
  });

  tbody.querySelectorAll('.btn-reject-hw').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const notes = window.prompt('Enter reason for returning / rejecting this submission (optional):');
      if (notes !== null) {
        await handleVerifyPendingSubmission(id, 'reject', btn, notes);
      }
    });
  });
}

async function handleVerifyPendingSubmission(completionId, decision, btn, notes = null) {
  if (!completionId) return;

  const targetSubmission = cachedPendingSubmissions.find((c) => c.id === completionId);
  if (currentProfile?.role === 'teacher') {
    const perms = currentProfile.teacher_permissions || {};
    if (perms.can_manage_tasks === false) {
      showToast('error', 'You do not have permission to verify homework tasks.');
      return;
    }
    if (targetSubmission && !teacherStudentIds.includes(targetSubmission.student_id)) {
      showToast('error', 'You are not authorized to verify this student\'s homework because they are not on your roster.');
      return;
    }
  }

  const origText = btn.textContent;
  try {
    btn.disabled = true;
    btn.textContent = decision === 'approve' ? 'Approving...' : 'Rejecting...';

    await verifyHomeworkCompletion(completionId, decision, notes);

    showToast('success', decision === 'approve' ? 'Homework approved successfully.' : 'Homework rejected.');
    await loadPendingSubmissions();
    await loadAssignments();
  } catch (err) {
    console.error('Failed to verify homework submission:', err);
    showToast('error', err.message || 'Failed to update submission.');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initHomeworkPage();
});
