/**
 * Trendz Tracker — Admin Teacher Management Controller (js/teachers.js)
 *
 * Exclusively accessible to admins (role === 'admin').
 * Provides:
 * 1. Teacher account listing with status and assigned student counts
 * 2. Create teacher modal (code, name, password, 10 permissions)
 * 3. Student assignment management with multi-select and search
 * 4. Granular permission editing
 * 5. Teacher password reset
 * 6. Teacher activation/deactivation
 * 7. Teacher audit log viewer
 */

import { requireAuth } from './guard.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { openModal, closeModal, setupModalListeners } from './modal.js';
import { showToast } from './toast.js';
import { createTeacher, manageTeacher, resetTeacherPassword } from './api.js';

let currentAdmin = null;
let allTeachers = [];
let allStudents = [];
let activeSearchQuery = '';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function initTeachersPage() {
  currentAdmin = await requireAuth(['admin']);
  if (!currentAdmin) return;

  setupModalListeners();
  setupUIEventListeners();
  await loadTeachersData();
}

/**
 * Loads teachers, their permissions, and assignment counts.
 */
export async function loadTeachersData() {
  if (!isSupabaseConfigured()) {
    allTeachers = [
      {
        id: 'demo-teacher-1',
        student_code: 'TCH01',
        full_name: 'Anita Sharma',
        role: 'teacher',
        level: 'Teacher',
        active: true,
        assigned_count: 5,
        permissions: {
          can_view_students: true,
          can_mark_attendance: true,
          can_correct_attendance: true,
          can_generate_reports: true,
          can_manage_tasks: true,
          can_manage_tests: true,
          can_publish_announcements: true,
          can_manage_resources: true,
          can_review_scores: true,
          can_request_corrections: true,
        },
      },
    ];
    renderTeachersTable();
    return;
  }

  const supabase = await getSupabase();

  try {
    const [teachersRes, permsRes, assignRes, studentsRes] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, student_code, full_name, role, level, active, created_at')
        .eq('role', 'teacher')
        .order('full_name', { ascending: true }),

      supabase.from('teacher_permissions').select('*'),

      supabase.from('teacher_student_assignments').select('teacher_id, student_id'),

      supabase
        .from('profiles')
        .select('id, student_code, full_name, level, active')
        .eq('role', 'student')
        .eq('active', true)
        .order('full_name', { ascending: true }),
    ]);

    if (teachersRes.error) throw teachersRes.error;

    allStudents = studentsRes.data || [];

    const permsMap = new Map();
    (permsRes.data || []).forEach((p) => permsMap.set(p.teacher_id, p));

    const assignCounts = new Map();
    (assignRes.data || []).forEach((a) => {
      assignCounts.set(a.teacher_id, (assignCounts.get(a.teacher_id) || 0) + 1);
    });

    allTeachers = (teachersRes.data || []).map((t) => ({
      ...t,
      permissions: permsMap.get(t.id) || {
        can_view_students: true,
        can_mark_attendance: true,
        can_correct_attendance: true,
        can_generate_reports: true,
        can_manage_tasks: true,
        can_manage_tests: true,
        can_publish_announcements: true,
        can_manage_resources: true,
        can_review_scores: true,
        can_request_corrections: true,
      },
      assigned_count: assignCounts.get(t.id) || 0,
    }));

    renderTeachersTable();
  } catch (err) {
    console.error('Error loading teachers:', err);
    showToast('error', 'Failed to load teachers: ' + err.message);
  }
}

/**
 * Renders the table of teachers.
 */
export function renderTeachersTable() {
  const container = document.getElementById('teachers-table-container');
  const badge = document.getElementById('teachers-count-badge');
  if (!container) return;

  const query = activeSearchQuery.trim().toLowerCase();
  const filtered = allTeachers.filter((t) => {
    if (!query) return true;
    return (
      (t.full_name || '').toLowerCase().includes(query) ||
      (t.student_code || '').toLowerCase().includes(query)
    );
  });

  if (badge) {
    badge.textContent = `${filtered.length} teacher${filtered.length === 1 ? '' : 's'}`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-8);">
        <p style="margin: 0 0 var(--space-2) 0; font-weight: 500;">No teachers found</p>
        <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
          ${query ? 'Try clearing your search query.' : 'Click "+ Add Teacher" to create the first teacher account.'}
        </p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Teacher</th>
            <th>Status</th>
            <th>Assigned Students</th>
            <th>Active Permissions</th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered
            .map((t) => {
              const activeCount = Object.values(t.permissions || {}).filter((v) => v === true).length;
              return `
              <tr data-teacher-id="${escapeHtml(t.id)}">
                <td>
                  <strong>${escapeHtml(t.full_name || 'Teacher')}</strong>
                  <div>
                    <span class="badge badge-neutral num" style="font-size: 11px;">${escapeHtml(t.student_code || '—')}</span>
                  </div>
                </td>
                <td>
                  <span class="badge ${t.active ? 'badge-success' : 'badge-neutral'}">
                    ${t.active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td>
                  <button type="button" class="btn btn-ghost btn-sm num btn-open-assign" data-id="${escapeHtml(t.id)}" title="Manage student assignments">
                    ${t.assigned_count} student${t.assigned_count === 1 ? '' : 's'} &rarr;
                  </button>
                </td>
                <td>
                  <button type="button" class="btn btn-ghost btn-sm btn-open-perms" data-id="${escapeHtml(t.id)}" title="Configure capabilities">
                    <span class="badge badge-info">${activeCount} / 10 enabled</span>
                  </button>
                </td>
                <td style="text-align: right;">
                  <div style="display: inline-flex; gap: var(--space-1); justify-content: flex-end; flex-wrap: wrap;">
                    <button type="button" class="btn btn-outline btn-sm btn-open-assign" data-id="${escapeHtml(t.id)}">
                      Assign
                    </button>
                    <button type="button" class="btn btn-outline btn-sm btn-open-perms" data-id="${escapeHtml(t.id)}">
                      Perms
                    </button>
                    <button type="button" class="btn btn-outline btn-sm btn-open-reset" data-id="${escapeHtml(t.id)}">
                      Reset Pwd
                    </button>
                    <button type="button" class="btn btn-outline btn-sm btn-toggle-active" data-id="${escapeHtml(t.id)}" data-active="${t.active}">
                      ${t.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button type="button" class="btn btn-ghost btn-sm btn-open-audit" data-id="${escapeHtml(t.id)}" title="View activity log">
                      Log
                    </button>
                  </div>
                </td>
              </tr>
            `;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  attachTableEventListeners();
}

function attachTableEventListeners() {
  const container = document.getElementById('teachers-table-container');
  if (!container) return;

  // Assign Students
  container.querySelectorAll('.btn-open-assign').forEach((btn) => {
    btn.addEventListener('click', () => {
      const teacherId = btn.getAttribute('data-id');
      const teacher = allTeachers.find((t) => t.id === teacherId);
      if (teacher) openAssignStudentsModal(teacher);
    });
  });

  // Edit Permissions
  container.querySelectorAll('.btn-open-perms').forEach((btn) => {
    btn.addEventListener('click', () => {
      const teacherId = btn.getAttribute('data-id');
      const teacher = allTeachers.find((t) => t.id === teacherId);
      if (teacher) openEditPermissionsModal(teacher);
    });
  });

  // Reset Password
  container.querySelectorAll('.btn-open-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const teacherId = btn.getAttribute('data-id');
      const teacher = allTeachers.find((t) => t.id === teacherId);
      if (teacher) openResetPasswordModal(teacher);
    });
  });

  // Toggle Active
  container.querySelectorAll('.btn-toggle-active').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const teacherId = btn.getAttribute('data-id');
      const currentActive = btn.getAttribute('data-active') === 'true';
      const teacher = allTeachers.find((t) => t.id === teacherId);
      if (!teacher) return;

      const confirmMsg = currentActive
        ? `Are you sure you want to deactivate ${teacher.full_name}? They will not be able to log in.`
        : `Activate ${teacher.full_name}?`;

      if (!window.confirm(confirmMsg)) return;

      try {
        await manageTeacher({ action: 'set_active', teacher_id: teacherId, active: !currentActive });
        showToast('success', `Teacher ${!currentActive ? 'activated' : 'deactivated'} successfully.`);
        await loadTeachersData();
      } catch (err) {
        showToast('error', err.message);
      }
    });
  });

  // Audit Log
  container.querySelectorAll('.btn-open-audit').forEach((btn) => {
    btn.addEventListener('click', () => {
      const teacherId = btn.getAttribute('data-id');
      const teacher = allTeachers.find((t) => t.id === teacherId);
      if (teacher) openAuditLogModal(teacher);
    });
  });
}

function setupUIEventListeners() {
  // Search
  const searchInput = document.getElementById('search-teachers-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      activeSearchQuery = e.target.value;
      renderTeachersTable();
    });
  }

  // Open Create Teacher Modal
  const openCreateBtn = document.getElementById('btn-open-create-teacher');
  if (openCreateBtn) {
    openCreateBtn.addEventListener('click', () => {
      const form = document.getElementById('create-teacher-form');
      if (form) form.reset();
      const errBox = document.getElementById('create-teacher-error');
      if (errBox) errBox.style.display = 'none';
      openModal('create-teacher-modal');
    });
  }

  // Handle Create Teacher Form Submit
  const createForm = document.getElementById('create-teacher-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const codeInput = document.getElementById('new-teacher-code');
      const nameInput = document.getElementById('new-teacher-name');
      const pwdInput = document.getElementById('new-teacher-password');
      const errBox = document.getElementById('create-teacher-error');
      const submitBtn = document.getElementById('btn-submit-create-teacher');

      const code = codeInput?.value?.trim();
      const name = nameInput?.value?.trim();
      const password = pwdInput?.value?.trim();

      if (!code || !name || !password) {
        if (errBox) {
          errBox.textContent = 'Please fill out all required fields.';
          errBox.style.display = 'block';
        }
        return;
      }

      if (password.length < 6) {
        if (errBox) {
          errBox.textContent = 'Password must be at least 6 characters long.';
          errBox.style.display = 'block';
        }
        return;
      }

      const permissions = {
        can_view_students: document.getElementById('perm-view-students')?.checked ?? true,
        can_mark_attendance: document.getElementById('perm-mark-attendance')?.checked ?? true,
        can_correct_attendance: document.getElementById('perm-correct-attendance')?.checked ?? true,
        can_generate_reports: document.getElementById('perm-generate-reports')?.checked ?? true,
        can_manage_tasks: document.getElementById('perm-manage-tasks')?.checked ?? true,
        can_manage_tests: document.getElementById('perm-manage-tests')?.checked ?? true,
        can_publish_announcements: document.getElementById('perm-publish-announcements')?.checked ?? true,
        can_manage_resources: document.getElementById('perm-manage-resources')?.checked ?? true,
        can_review_scores: document.getElementById('perm-review-scores')?.checked ?? true,
        can_request_corrections: document.getElementById('perm-request-corrections')?.checked ?? true,
      };

      if (submitBtn) submitBtn.disabled = true;
      if (errBox) errBox.style.display = 'none';

      try {
        await createTeacher({
          teacher_code: code,
          full_name: name,
          password,
          permissions,
        });

        closeModal('create-teacher-modal');
        showToast('success', `Teacher account "${name}" created successfully.`);
        await loadTeachersData();
      } catch (err) {
        if (errBox) {
          errBox.textContent = err.message;
          errBox.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // Handle Reset Password Form Submit
  const resetForm = document.getElementById('reset-teacher-password-form');
  if (resetForm) {
    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const teacherId = document.getElementById('reset-teacher-id')?.value;
      const pwdInput = document.getElementById('reset-teacher-new-pwd');
      const newPassword = pwdInput?.value?.trim();

      if (!teacherId || !newPassword || newPassword.length < 6) {
        alert('Please enter a password of at least 6 characters.');
        return;
      }

      try {
        await resetTeacherPassword(teacherId, newPassword);
        closeModal('reset-teacher-password-modal');
        showToast('success', 'Teacher password updated successfully.');
      } catch (err) {
        showToast('error', err.message);
      }
    });
  }
}

// -------------------------------------------------------------
// Assign Students Modal
// -------------------------------------------------------------
async function openAssignStudentsModal(teacher) {
  const teacherIdInput = document.getElementById('assign-teacher-id');
  const teacherNameEl = document.getElementById('assign-teacher-name');
  const listContainer = document.getElementById('assign-students-list');
  const countEl = document.getElementById('assign-selected-count');
  const searchInput = document.getElementById('search-assign-students');

  if (teacherIdInput) teacherIdInput.value = teacher.id;
  if (teacherNameEl) teacherNameEl.textContent = `${teacher.full_name} (${teacher.student_code})`;
  if (searchInput) searchInput.value = '';

  let assignedIds = new Set();

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data: assignments } = await supabase
      .from('teacher_student_assignments')
      .select('student_id')
      .eq('teacher_id', teacher.id);
    (assignments || []).forEach((a) => assignedIds.add(a.student_id));
  }

  function updateSelectedCount() {
    if (countEl) countEl.textContent = String(assignedIds.size);
  }

  function renderStudentCheckboxList(query = '') {
    const cleanQuery = query.trim().toLowerCase();
    const filtered = allStudents.filter((s) => {
      if (!cleanQuery) return true;
      return (
        (s.full_name || '').toLowerCase().includes(cleanQuery) ||
        (s.student_code || '').toLowerCase().includes(cleanQuery)
      );
    });

    if (filtered.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No matching students found.</div>';
      return;
    }

    listContainer.innerHTML = filtered
      .map((s) => {
        const isChecked = assignedIds.has(s.id);
        return `
          <label style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-radius: 4px; cursor: pointer; user-select: none;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <input type="checkbox" class="chk-assign-student" data-student-id="${escapeHtml(s.id)}" ${isChecked ? 'checked' : ''} />
              <span><strong>${escapeHtml(s.full_name)}</strong> <span class="num badge badge-neutral" style="font-size: 11px;">${escapeHtml(s.student_code)}</span></span>
            </div>
            <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(s.level || '')}</span>
          </label>
        `;
      })
      .join('');

    listContainer.querySelectorAll('.chk-assign-student').forEach((chk) => {
      chk.addEventListener('change', () => {
        const sid = chk.getAttribute('data-student-id');
        if (chk.checked) assignedIds.add(sid);
        else assignedIds.delete(sid);
        updateSelectedCount();
      });
    });
  }

  if (searchInput) {
    searchInput.oninput = (e) => renderStudentCheckboxList(e.target.value);
  }

  const selectAllBtn = document.getElementById('btn-assign-select-all');
  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      allStudents.forEach((s) => assignedIds.add(s.id));
      renderStudentCheckboxList(searchInput ? searchInput.value : '');
      updateSelectedCount();
    };
  }

  const clearAllBtn = document.getElementById('btn-assign-clear-all');
  if (clearAllBtn) {
    clearAllBtn.onclick = () => {
      assignedIds.clear();
      renderStudentCheckboxList(searchInput ? searchInput.value : '');
      updateSelectedCount();
    };
  }

  const saveBtn = document.getElementById('btn-save-assignments');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        await manageTeacher({
          action: 'update_assignments',
          teacher_id: teacher.id,
          assigned_student_ids: Array.from(assignedIds),
        });
        closeModal('assign-students-modal');
        showToast('success', `Assignments updated: ${assignedIds.size} student(s) assigned.`);
        await loadTeachersData();
      } catch (err) {
        showToast('error', err.message);
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  renderStudentCheckboxList();
  updateSelectedCount();
  openModal('assign-students-modal');
}

// -------------------------------------------------------------
// Edit Permissions Modal
// -------------------------------------------------------------
function openEditPermissionsModal(teacher) {
  const teacherIdInput = document.getElementById('edit-perms-teacher-id');
  const teacherNameEl = document.getElementById('edit-perms-teacher-name');

  if (teacherIdInput) teacherIdInput.value = teacher.id;
  if (teacherNameEl) teacherNameEl.textContent = `${teacher.full_name} (${teacher.student_code})`;

  const p = teacher.permissions || {};
  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val !== false;
  };

  setCheck('edit-perm-view-students', p.can_view_students);
  setCheck('edit-perm-mark-attendance', p.can_mark_attendance);
  setCheck('edit-perm-correct-attendance', p.can_correct_attendance);
  setCheck('edit-perm-generate-reports', p.can_generate_reports);
  setCheck('edit-perm-manage-tasks', p.can_manage_tasks);
  setCheck('edit-perm-manage-tests', p.can_manage_tests);
  setCheck('edit-perm-publish-announcements', p.can_publish_announcements);
  setCheck('edit-perm-manage-resources', p.can_manage_resources);
  setCheck('edit-perm-review-scores', p.can_review_scores);
  setCheck('edit-perm-request-corrections', p.can_request_corrections);

  const saveBtn = document.getElementById('btn-save-permissions');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      const updatedPerms = {
        can_view_students: document.getElementById('edit-perm-view-students')?.checked ?? true,
        can_mark_attendance: document.getElementById('edit-perm-mark-attendance')?.checked ?? true,
        can_correct_attendance: document.getElementById('edit-perm-correct-attendance')?.checked ?? true,
        can_generate_reports: document.getElementById('edit-perm-generate-reports')?.checked ?? true,
        can_manage_tasks: document.getElementById('edit-perm-manage-tasks')?.checked ?? true,
        can_manage_tests: document.getElementById('edit-perm-manage-tests')?.checked ?? true,
        can_publish_announcements: document.getElementById('edit-perm-publish-announcements')?.checked ?? true,
        can_manage_resources: document.getElementById('edit-perm-manage-resources')?.checked ?? true,
        can_review_scores: document.getElementById('edit-perm-review-scores')?.checked ?? true,
        can_request_corrections: document.getElementById('edit-perm-request-corrections')?.checked ?? true,
      };

      try {
        await manageTeacher({
          action: 'update_permissions',
          teacher_id: teacher.id,
          permissions: updatedPerms,
        });
        closeModal('edit-permissions-modal');
        showToast('success', 'Teacher permissions updated.');
        await loadTeachersData();
      } catch (err) {
        showToast('error', err.message);
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  openModal('edit-permissions-modal');
}

// -------------------------------------------------------------
// Reset Password Modal
// -------------------------------------------------------------
function openResetPasswordModal(teacher) {
  const idEl = document.getElementById('reset-teacher-id');
  const nameEl = document.getElementById('reset-teacher-display-name');
  const codeEl = document.getElementById('reset-teacher-display-code');
  const pwdInput = document.getElementById('reset-teacher-new-pwd');

  if (idEl) idEl.value = teacher.id;
  if (nameEl) nameEl.textContent = teacher.full_name;
  if (codeEl) codeEl.textContent = teacher.student_code;
  if (pwdInput) pwdInput.value = '';

  openModal('reset-teacher-password-modal');
}

// -------------------------------------------------------------
// Audit Log Modal
// -------------------------------------------------------------
async function openAuditLogModal(teacher) {
  const container = document.getElementById('teacher-audit-log-container');
  if (container) {
    container.innerHTML = '<div class="empty-state">Loading activity log...</div>';
  }

  openModal('teacher-audit-modal');

  try {
    const res = await manageTeacher({ action: 'get_audit_log', teacher_id: teacher.id });
    const logs = res.logs || [];

    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = '<div class="empty-state">No audit logs recorded for this teacher.</div>';
      return;
    }

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        ${logs
          .map((l) => {
            const dateStr = new Date(l.created_at).toLocaleString();
            return `
            <div style="padding: var(--space-3); border: 1px solid var(--border-color, #e2e8f0); border-radius: var(--radius-md, 6px); background: var(--bg-surface, #fff);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span class="badge badge-neutral" style="font-weight: 600;">${escapeHtml(l.action)}</span>
                <span style="font-size: 11px; color: var(--text-muted);">${escapeHtml(dateStr)}</span>
              </div>
              <pre style="margin: 0; font-size: 11px; color: var(--text-muted); white-space: pre-wrap; font-family: monospace;">${escapeHtml(JSON.stringify(l.details || {}, null, 2))}</pre>
            </div>
          `;
          })
          .join('')}
      </div>
    `;
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="banner banner-error">${escapeHtml(err.message)}</div>`;
    }
  }
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initTeachersPage();
  });
}
