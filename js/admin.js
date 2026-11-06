/**
 * Trendz Tracker - Admin Student Management
 * Renders roster, handles student creation, password resets, and active status toggling.
 */

import { createStudent, resetStudentPassword, toggleStudentActive, toggleStudentLeaderboardVisible } from './api.js';
import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupModalListeners, setupAdminNav } from './modal.js';
import { initProfileEditor, openEditProfileModal, openProfileAuditDrawer } from './profileEditor.js';
import { collectExistingLevels } from './profileForm.js';
import { DemoDB, getSupabase, clearStaleSupabaseSession } from './supabaseClient.js';
import { showToast } from './toast.js';
import { buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let submitAndAddAnotherStudent = false;
let currentLoggedInProfile = null;

let allStudents = [];
let currentFilter = {
  search: '',
  level: '',
  status: '',
};

/**
 * Random secure alphanumeric password generator
 */
function generateRandomPassword(length = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$';
  let pwd = '';
  for (let i = 0; i < length; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

/**
 * Fetch all student profiles from Supabase or DemoDB
 */
async function loadStudents() {
  const tbody = document.getElementById('students-table-body');
  const emptyState = document.getElementById('students-empty-state');

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (!supabase) {
        allStudents = DemoDB.getStudents();
      } else if (currentLoggedInProfile?.role === 'teacher') {
        const { data: assignments, error: assignErr } = await supabase
          .from('teacher_student_assignments')
          .select('student_id')
          .eq('teacher_id', currentLoggedInProfile.id);

        if (assignErr) throw assignErr;
        const assignedIds = (assignments || []).map((a) => a.student_id);

        if (assignedIds.length === 0) {
          allStudents = [];
        } else {
          const { data, error } = await supabase
            .from('profiles')
            .select('id, student_code, full_name, level, role, active, leaderboard_visible, created_at')
            .in('id', assignedIds)
            .eq('role', 'student')
            .order('created_at', { ascending: false });

          if (error) throw error;
          allStudents = data || [];
        }
      } else {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, student_code, full_name, level, role, active, leaderboard_visible, created_at')
          .eq('role', 'student')
          .order('created_at', { ascending: false });

        if (error) {
          const msg = error.message || '';
          if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
            clearStaleSupabaseSession();
            window.location.href = '/index.html';
            return;
          }
          throw new Error(msg);
        }
        allStudents = data || [];
      }
    } else {
      allStudents = DemoDB.getStudents();
    }

    syncLevelFilterOptions();
    renderTable();
    updateStats();
  } catch (err) {
    console.error('Error loading students:', err);
    showToast('error', 'Failed to load students: ' + (err.message || 'Network error'));
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: var(--space-6);">
            <div style="color: var(--color-danger); margin-bottom: var(--space-3); font-weight: 500;">
              Error loading student roster: ${escapeHtml(err.message)}
            </div>
            <button type="button" id="btn-retry-load-students" class="btn btn-outline btn-sm">
              ↻ Try Again
            </button>
          </td>
        </tr>
      `;
      document.getElementById('btn-retry-load-students')?.addEventListener('click', () => {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" style="text-align: center; padding: var(--space-6); color: var(--text-muted);">
              <span class="spinner" style="margin-right: 8px;"></span> Loading student roster...
            </td>
          </tr>
        `;
        loadStudents();
      });
    }
  }
}

/**
 * Update the 3 quick metric cards
 */
function updateStats() {
  const totalEl = document.getElementById('stat-total-students');
  const activeEl = document.getElementById('stat-active-students');
  const inactiveEl = document.getElementById('stat-inactive-students');

  const total = allStudents.length;
  const active = allStudents.filter(s => s.active).length;
  const inactive = total - active;

  if (totalEl) totalEl.textContent = total;
  if (activeEl) activeEl.textContent = active;
  if (inactiveEl) inactiveEl.textContent = inactive;
}

/**
 * Sync the #filter-level dropdown options with levels present on student profiles
 */
function syncLevelFilterOptions() {
  const selectEl = document.getElementById('filter-level');
  if (!selectEl) return;
  const currentVal = selectEl.value;
  const defaultLevels = ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Master'];
  const existing = collectExistingLevels(allStudents);
  const merged = collectExistingLevels([
    ...defaultLevels,
    ...existing
  ]);

  selectEl.innerHTML = [
    '<option value="">All Levels</option>',
    ...merged.map(lvl => `<option value="${escapeHtml(lvl)}">${escapeHtml(lvl)}</option>`)
  ].join('');

  if (currentVal && merged.some(l => l.toLowerCase() === currentVal.toLowerCase())) {
    selectEl.value = currentVal;
  }
}

/**
 * Filter and render students table rows
 */
function renderTable() {
  const tbody = document.getElementById('students-table-body');
  const emptyState = document.getElementById('students-empty-state');

  const filtered = allStudents.filter(student => {
    const searchMatch = !currentFilter.search ||
      student.student_code.toLowerCase().includes(currentFilter.search) ||
      student.full_name.toLowerCase().includes(currentFilter.search);

    const levelMatch = !currentFilter.level || (student.level && student.level.toLowerCase() === currentFilter.level.toLowerCase());

    const statusMatch = !currentFilter.status ||
      (currentFilter.status === 'active' && student.active) ||
      (currentFilter.status === 'inactive' && !student.active);

    return searchMatch && levelMatch && statusMatch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  tbody.innerHTML = filtered.map(student => {
    const isVisible = student.leaderboard_visible !== false;
    return `
    <tr class="${student.active ? '' : 'row-inactive'}">
      <td class="num" style="font-weight: 600; color: var(--color-primary-text);">
        ${escapeHtml(student.student_code)}
      </td>
      <td>
        <a href="/pages/student-detail.html?id=${encodeURIComponent(student.id)}" class="student-name-link" style="color: var(--color-primary); font-weight: 600; text-decoration: none;">
          ${escapeHtml(student.full_name)}
        </a>
      </td>
      <td style="color: var(--text-muted);">
        ${student.level ? escapeHtml(student.level) : '<span style="color: var(--text-dim);">—</span>'}
      </td>
      <td>
        <span class="status-indicator ${student.active ? 'active' : 'inactive'}">
          ${student.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td>
        <label
          style="display: inline-flex; align-items: center; gap: 8px; cursor: ${currentLoggedInProfile?.role === 'teacher' ? 'default' : 'pointer'}; font-size: var(--text-xs); font-weight: 600; color: ${isVisible ? 'var(--color-accent-text)' : 'var(--text-dim)'};"
          title="Hidden students do not appear on any board."
        >
          <input
            type="checkbox"
            class="chk-leaderboard-visible"
            data-id="${student.id}"
            data-visible="${isVisible}"
            ${isVisible ? 'checked' : ''}
            ${currentLoggedInProfile?.role === 'teacher' ? 'disabled' : ''}
            aria-label="Show ${escapeHtml(student.full_name)} on leaderboards. Hidden students do not appear on any board."
            style="width: 16px; height: 16px; accent-color: var(--color-primary); cursor: ${currentLoggedInProfile?.role === 'teacher' ? 'default' : 'pointer'};"
          />
          <span>${isVisible ? 'Shown' : 'Hidden'}</span>
        </label>
      </td>
      <td style="text-align: right;">
        ${
          currentLoggedInProfile?.role === 'teacher'
            ? `<a href="/pages/student-detail.html?id=${encodeURIComponent(student.id)}" class="btn btn-outline btn-sm">View Profile</a>`
            : `
          <div style="display: inline-flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end;">
            <button
              type="button"
              class="btn btn-outline btn-sm btn-edit-profile"
              data-id="${student.id}"
              title="Edit student profile"
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-profile-history"
              data-id="${student.id}"
              title="View profile change history"
            >
              Change history
            </button>
            <button
              type="button"
              class="btn btn-outline btn-sm btn-reset-pwd"
              data-id="${student.id}"
              data-name="${escapeHtml(student.full_name)}"
              data-code="${escapeHtml(student.student_code)}"
              title="Reset student password"
            >
              Reset Pwd
            </button>
            <button
              type="button"
              class="btn ${student.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-active"
              data-id="${student.id}"
              data-active="${student.active}"
              title="${student.active ? 'Deactivate student' : 'Activate student'}"
            >
              ${student.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
          `
        }
      </td>
    </tr>
  `;
  }).join('');

  // Attach action listeners
  attachRowListeners();
}

/**
 * Attach button click handlers for Reset Password and Toggle Active
 */
function attachRowListeners() {
  document.querySelectorAll('.btn-edit-profile').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.getAttribute('data-id');
      const student = allStudents.find(s => s.id === studentId);
      if (student) {
        openEditProfileModal(student);
      }
    });
  });

  document.querySelectorAll('.btn-profile-history').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.getAttribute('data-id');
      const student = allStudents.find(s => s.id === studentId);
      if (student) {
        openProfileAuditDrawer(student);
      }
    });
  });

  document.querySelectorAll('.btn-reset-pwd').forEach(btn => {
    btn.addEventListener('click', () => {
      const studentId = btn.getAttribute('data-id');
      const studentName = btn.getAttribute('data-name');
      const studentCode = btn.getAttribute('data-code');

      document.getElementById('reset-student-id').value = studentId;
      document.getElementById('reset-student-display-name').textContent = studentName;
      document.getElementById('reset-student-display-code').textContent = studentCode;
      document.getElementById('reset-new-password').value = generateRandomPassword();
      document.getElementById('reset-error').style.display = 'none';

      openModal('reset-password-modal');
    });
  });

  document.querySelectorAll('.btn-toggle-active').forEach(btn => {
    btn.addEventListener('click', async () => {
      const studentId = btn.getAttribute('data-id');
      const currentActive = btn.getAttribute('data-active') === 'true';
      const actionName = currentActive ? 'deactivate' : 'activate';

      btn.disabled = true;
      try {
        await toggleStudentActive(studentId, currentActive);
        showToast('success', `Student has been ${actionName}d.`);
        await loadStudents();
      } catch (err) {
        showToast('error', `Failed to ${actionName} student: ` + err.message);
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.chk-leaderboard-visible').forEach(chk => {
    chk.addEventListener('change', async () => {
      const studentId = chk.getAttribute('data-id');
      const currentVisible = chk.getAttribute('data-visible') === 'true';

      chk.disabled = true;
      try {
        await toggleStudentLeaderboardVisible(studentId, currentVisible);
        showToast(
          'success',
          currentVisible
            ? 'Student hidden from leaderboards.'
            : 'Student is now shown on leaderboards.'
        );
        await loadStudents();
      } catch (err) {
        chk.checked = currentVisible;
        chk.disabled = false;
        showToast('error', 'Failed to update leaderboard visibility: ' + (err.message || 'Database error'));
      }
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

/**
 * Initialize Admin Page
 */
async function initAdmin() {
  const profile = await requireAuth(['teacher', 'admin']);
  if (!profile) return;
  currentLoggedInProfile = profile;

  if (profile.role === 'teacher') {
    if (profile.permissions?.can_view_students === false) {
      window.location.href = '/pages/teacher.html';
      return;
    }
    const addBtn = document.getElementById('btn-open-create-student');
    if (addBtn) addBtn.style.display = 'none';
    const importLink = document.querySelector('a[href*="import.html"]');
    if (importLink) importLink.style.display = 'none';
    const heading = document.querySelector('h1');
    if (heading) {
      heading.innerHTML = 'My Students <span class="badge badge-info" style="font-size: var(--text-xs); vertical-align: middle; margin-left: 8px;">Assigned students only</span>';
    }
  }

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();
  if (profile.role === 'admin') {
    setupAdminNav(profile);
  }

  initProfileEditor({
    getExistingLevels: () => collectExistingLevels(allStudents),
    onProfileSaved: async () => {
      await loadStudents();
    }
  });

  function updateCreateStudentSummary() {
    const summaryEl = document.getElementById('create-student-live-summary');
    if (!summaryEl) return;
    summaryEl.textContent = buildModalLiveSummary('studentCreate', {
      student_code: document.getElementById('new-student-code')?.value || '',
      full_name: document.getElementById('new-full-name')?.value || '',
      level: document.getElementById('new-level')?.value || '',
    });
  }

  function resetCreateStudentForm() {
    document.getElementById('create-student-form')?.reset();
    const pwdEl = document.getElementById('new-temp-password');
    if (pwdEl) pwdEl.value = generateRandomPassword();
    const errEl = document.getElementById('create-error');
    if (errEl) errEl.style.display = 'none';
    ['error-new-student-code', 'error-new-full-name', 'error-new-temp-password'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    setMoreOptionsOpen(document.getElementById('create-student-more-options'), false);
    updateCreateStudentSummary();
  }

  // "Add Student" modal trigger
  document.getElementById('btn-open-create-modal')?.addEventListener('click', () => {
    resetCreateStudentForm();
    openModal('create-student-modal');
  });

  ['new-student-code', 'new-full-name', 'new-level'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateCreateStudentSummary);
  });

  const btnSaveAddAnotherStudent = document.getElementById('btn-save-add-another-student');
  const createStudentForm = document.getElementById('create-student-form');
  if (btnSaveAddAnotherStudent && createStudentForm) {
    btnSaveAddAnotherStudent.addEventListener('click', () => {
      submitAndAddAnotherStudent = true;
      createStudentForm.requestSubmit();
    });
  }

  // Password generator triggers
  document.getElementById('btn-generate-password')?.addEventListener('click', () => {
    document.getElementById('new-temp-password').value = generateRandomPassword();
  });
  document.getElementById('btn-generate-reset-password')?.addEventListener('click', () => {
    document.getElementById('reset-new-password').value = generateRandomPassword();
  });

  // Search & Filter listeners
  document.getElementById('search-students')?.addEventListener('input', (e) => {
    currentFilter.search = e.target.value.trim().toLowerCase();
    renderTable();
  });

  document.getElementById('filter-level')?.addEventListener('change', (e) => {
    currentFilter.level = e.target.value;
    renderTable();
  });

  document.getElementById('filter-status')?.addEventListener('change', (e) => {
    currentFilter.status = e.target.value;
    renderTable();
  });

  // Create Student Form submit
  createStudentForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-error');
    const submitBtn = document.getElementById('btn-submit-create');
    const btnText = document.getElementById('btn-create-text');

    errorEl.style.display = 'none';
    ['error-new-student-code', 'error-new-full-name', 'error-new-temp-password'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    const student_code = document.getElementById('new-student-code').value.trim();
    const full_name = document.getElementById('new-full-name').value.trim();
    const level = document.getElementById('new-level').value.trim();
    const password = document.getElementById('new-temp-password').value.trim();

    if (!student_code || !full_name || !password) {
      if (!student_code) {
        const el = document.getElementById('error-new-student-code');
        if (el) { el.textContent = 'Student ID is required.'; el.style.display = 'block'; }
      }
      if (!full_name) {
        const el = document.getElementById('error-new-full-name');
        if (el) { el.textContent = 'Full name is required.'; el.style.display = 'block'; }
      }
      if (!password) {
        const el = document.getElementById('error-new-temp-password');
        if (el) { el.textContent = 'Temporary password is required.'; el.style.display = 'block'; }
      }
      errorEl.textContent = 'Please fill out all required fields.';
      errorEl.style.display = 'block';
      submitAndAddAnotherStudent = false;
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      await createStudent({ student_code, full_name, level, password });
      showToast('success', `Student account ${student_code} created successfully.`);
      const addAnother = submitAndAddAnotherStudent;
      submitAndAddAnotherStudent = false;
      await loadStudents();
      if (addAnother) {
        resetCreateStudentForm();
      } else {
        closeModal('create-student-modal');
      }
    } catch (err) {
      submitAndAddAnotherStudent = false;
      errorEl.textContent = err.message || 'Failed to create student account.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Save';
    }
  });

  // Reset Password Form submit
  document.getElementById('reset-password-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('reset-error');
    const submitBtn = document.getElementById('btn-submit-reset');
    const btnText = document.getElementById('btn-reset-text');

    errorEl.style.display = 'none';

    const studentId = document.getElementById('reset-student-id').value;
    const newPassword = document.getElementById('reset-new-password').value.trim();

    if (!newPassword || newPassword.length < 6) {
      errorEl.textContent = 'Password must be at least 6 characters.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Updating...';

    try {
      await resetStudentPassword(studentId, newPassword);
      showToast('success', 'Student password updated successfully.');
      closeModal('reset-password-modal');
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to reset student password.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Update Password';
    }
  });

  // Initial student roster load
  await loadStudents();
}

document.addEventListener('DOMContentLoaded', initAdmin);
