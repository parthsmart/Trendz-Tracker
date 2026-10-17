/**
 * Trendz Tracker - Admin Student Management
 * Renders roster, handles student creation, password resets, and active status toggling.
 */

import { createStudent, resetStudentPassword, toggleStudentActive } from './api.js';
import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { closeModal, openModal, setupModalListeners } from './modal.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';

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
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'student')
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      allStudents = data || [];
    } else {
      allStudents = DemoDB.getStudents();
    }

    renderTable();
    updateStats();
  } catch (err) {
    console.error('Error loading students:', err);
    showToast('error', 'Failed to load students: ' + err.message);
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--color-danger); padding: var(--space-6);">Error loading student roster.</td></tr>`;
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
  tbody.innerHTML = filtered.map(student => `
    <tr class="${student.active ? '' : 'row-inactive'}">
      <td class="num" style="font-weight: 600; color: var(--color-primary-text);">
        ${escapeHtml(student.student_code)}
      </td>
      <td style="font-weight: 500;">
        ${escapeHtml(student.full_name)}
      </td>
      <td style="color: var(--text-muted);">
        ${student.level ? escapeHtml(student.level) : '<span style="color: var(--text-dim);">—</span>'}
      </td>
      <td>
        <span class="status-indicator ${student.active ? 'active' : 'inactive'}">
          ${student.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style="text-align: right;">
        <div style="display: inline-flex; gap: var(--space-2);">
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
      </td>
    </tr>
  `).join('');

  // Attach action listeners
  attachRowListeners();
}

/**
 * Attach button click handlers for Reset Password and Toggle Active
 */
function attachRowListeners() {
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
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();

  // "Add Student" modal trigger
  document.getElementById('btn-open-create-modal')?.addEventListener('click', () => {
    document.getElementById('create-student-form').reset();
    document.getElementById('new-temp-password').value = generateRandomPassword();
    document.getElementById('create-error').style.display = 'none';
    openModal('create-student-modal');
  });

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
  document.getElementById('create-student-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('create-error');
    const submitBtn = document.getElementById('btn-submit-create');
    const btnText = document.getElementById('btn-create-text');

    errorEl.style.display = 'none';

    const student_code = document.getElementById('new-student-code').value.trim();
    const full_name = document.getElementById('new-full-name').value.trim();
    const level = document.getElementById('new-level').value.trim();
    const password = document.getElementById('new-temp-password').value.trim();

    if (!student_code || !full_name || !password) {
      errorEl.textContent = 'Please fill out all required fields.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Creating...';

    try {
      await createStudent({ student_code, full_name, level, password });
      showToast('success', `Student account ${student_code} created successfully.`);
      closeModal('create-student-modal');
      await loadStudents();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create student account.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = 'Create Student';
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
