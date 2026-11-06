/**
 * Trendz Tracker - Admin Resources Management (js/resources.js)
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { showToast } from './toast.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let allResources = [];
let teacherAssignedStudents = [];
let submitAndAddAnotherResource = false;

/**
 * Validates that a URL strictly starts with http:// or https://
 * @param {string} url
 * @returns {boolean}
 */
export function isValidHttpUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

async function loadResources() {
  const tbody = document.getElementById('resources-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-state">Loading resources...</td></tr>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('resources')
          .select('*')
          .order('sort_order', { ascending: true });

        if (error) {
          console.warn('Database error loading resources:', error.message);
          allResources = [];
        } else {
          allResources = data || [];
        }
        renderResourcesTable();
        return;
      }
    }

    allResources = isSupabaseConfigured() ? [] : DemoDB.getResources();
    renderResourcesTable();
  } catch (err) {
    console.warn('Error loading resources:', err);
    allResources = isSupabaseConfigured() ? [] : DemoDB.getResources();
    renderResourcesTable();
  }
}

function renderResourcesTable() {
  const tbody = document.getElementById('resources-tbody');
  if (!tbody) return;

  if (allResources.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state-cell">
          <div class="empty-state">
            <h3 class="empty-state-title">No learning resources published yet</h3>
            <p class="empty-state-desc">Click <strong>+ Add Resource</strong> above to add curriculum guides, competition rulebooks, or practice worksheets.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = allResources.map((res, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === allResources.length - 1;
    const safeUrl = isValidHttpUrl(res.url) ? res.url.trim() : '#';

    return `
      <tr data-resource-id="${res.id}">
        <td>
          <div style="display: flex; gap: 4px; align-items: center;">
            <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="up" data-id="${res.id}" ${isFirst ? 'disabled' : ''} title="Move up" aria-label="Move resource up">▲</button>
            <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="down" data-id="${res.id}" ${isLast ? 'disabled' : ''} title="Move down" aria-label="Move resource down">▼</button>
          </div>
        </td>
        <td>
          <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(res.title)}</div>
          ${res.description ? `<div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">${escapeHtml(res.description)}</div>` : ''}
        </td>
        <td>
          <span style="font-size: var(--text-xs); color: var(--text-main); font-weight: 500;">
            ${escapeHtml(res.topic || 'General')}
          </span>
        </td>
        <td>
          <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="font-size: var(--text-xs); color: var(--color-primary); word-break: break-all;">
            ${escapeHtml(res.url)} ↗
          </a>
        </td>
        <td>
          <span class="badge ${res.active ? 'badge-success' : 'badge-neutral'}">
            ${res.active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td style="text-align: right;">
          ${
            currentLoggedInProfile?.role === 'teacher' && res.created_by !== currentLoggedInProfile.id
              ? '<span class="badge badge-neutral">Shared</span>'
              : `
            <div style="display: inline-flex; gap: 6px;">
              <button type="button" class="btn btn-outline btn-sm btn-edit-resource" data-id="${res.id}">
                Edit
              </button>
              <button type="button" class="btn ${res.active ? 'btn-outline' : 'btn-secondary'} btn-sm btn-toggle-resource" data-id="${res.id}" data-active="${res.active}">
                ${res.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
            `
          }
        </td>
      </tr>
    `;
  }).join('');

  attachTableEventListeners();
}

function attachTableEventListeners() {
  document.querySelectorAll('.btn-reorder').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const dir = e.currentTarget.getAttribute('data-dir');
      await handleReorder(id, dir);
    });
  });

  document.querySelectorAll('.btn-edit-resource').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      openEditModal(id);
    });
  });

  document.querySelectorAll('.btn-toggle-resource').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const currentActive = e.currentTarget.getAttribute('data-active') === 'true';
      await handleToggleActive(id, !currentActive);
    });
  });
}

function clearResourceErrors() {
  const errBanner = document.getElementById('resource-error-banner');
  if (errBanner) errBanner.style.display = 'none';
  ['error-resource-title', 'error-resource-topic', 'error-resource-url'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function showResourceError(msg, fieldErrId = null) {
  if (fieldErrId) {
    const el = document.getElementById(fieldErrId);
    if (el) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  }
  const errBanner = document.getElementById('resource-error-banner');
  if (errBanner) {
    errBanner.textContent = msg;
    errBanner.style.display = 'block';
  } else {
    showToast(msg, 'error');
  }
}

function updateResourceLiveSummary() {
  const summaryEl = document.getElementById('resource-live-summary');
  if (!summaryEl) return;
  summaryEl.textContent = buildModalLiveSummary('resource', {
    title: document.getElementById('resource-title')?.value || '',
    topic: document.getElementById('resource-topic')?.value || '',
    active: Boolean(document.getElementById('resource-active')?.checked),
  });
}

async function openEditModal(resourceId) {
  const res = allResources.find(r => r.id === resourceId);
  if (!res) return;

  if (currentLoggedInProfile?.role === 'teacher' && res.created_by && res.created_by !== currentLoggedInProfile.id) {
    showToast('You can only edit resources that you created.', 'error');
    return;
  }

  clearResourceErrors();
  document.getElementById('modal-resource-title').textContent = 'Edit Learning Resource';
  document.getElementById('resource-id').value = res.id;
  document.getElementById('resource-title').value = res.title;
  document.getElementById('resource-url').value = res.url;
  document.getElementById('resource-topic').value = res.topic || '';
  document.getElementById('resource-desc').value = res.description || '';
  document.getElementById('resource-active').checked = !!res.active;

  const recGroup = document.getElementById('resource-recipients-group');
  const recList = document.getElementById('resource-recipients-list');
  if (recGroup && recList) {
    if (currentLoggedInProfile?.role === 'teacher') {
      recGroup.style.display = 'block';
      let currentRecipients = new Set();
      if (isSupabaseConfigured()) {
        try {
          const supabase = await getSupabase();
          const { data: recData } = await supabase
            .from('resource_recipients')
            .select('student_id')
            .eq('resource_id', res.id);
          (recData || []).forEach((r) => currentRecipients.add(r.student_id));
        } catch (err) {
          console.warn('Could not load resource recipients:', err);
        }
      }
      recList.innerHTML = teacherAssignedStudents.length === 0
        ? '<div class="form-hint" style="padding: 4px;">No assigned students found.</div>'
        : teacherAssignedStudents
            .map((s) => {
              const checked = currentRecipients.has(s.id);
              return `
                <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; font-size: 0.9rem;">
                  <input type="checkbox" value="${s.id}" ${checked ? 'checked' : ''} />
                  <span>${escapeHtml(s.full_name || 'Student')} (${escapeHtml(s.student_code || '')})</span>
                </label>
              `;
            })
            .join('');
    } else {
      recGroup.style.display = 'none';
      recList.innerHTML = '';
    }
  }

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  if (btnSaveAnother) btnSaveAnother.style.display = 'none';

  setMoreOptionsOpen(
    document.getElementById('resource-more-options'),
    shouldOpenMoreOptions([res.description, res.active === false ? 'inactive' : ''], true)
  );

  updateResourceLiveSummary();
  openModal('modal-resource');
}

function openAddModal() {
  clearResourceErrors();
  document.getElementById('modal-resource-title').textContent = 'Add Learning Resource';
  document.getElementById('form-resource').reset();
  document.getElementById('resource-id').value = '';
  document.getElementById('resource-active').checked = true;

  const recGroup = document.getElementById('resource-recipients-group');
  const recList = document.getElementById('resource-recipients-list');
  if (recGroup && recList) {
    if (currentLoggedInProfile?.role === 'teacher') {
      recGroup.style.display = 'block';
      recList.innerHTML = teacherAssignedStudents.length === 0
        ? '<div class="form-hint" style="padding: 4px;">No assigned students found.</div>'
        : teacherAssignedStudents
            .map((s) => `
              <label style="display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; font-size: 0.9rem;">
                <input type="checkbox" value="${s.id}" checked />
                <span>${escapeHtml(s.full_name || 'Student')} (${escapeHtml(s.student_code || '')})</span>
              </label>
            `)
            .join('');
    } else {
      recGroup.style.display = 'none';
      recList.innerHTML = '';
    }
  }

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  if (btnSaveAnother) btnSaveAnother.style.display = 'inline-flex';

  setMoreOptionsOpen(document.getElementById('resource-more-options'), false);
  updateResourceLiveSummary();
  openModal('modal-resource');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  clearResourceErrors();
  const id = document.getElementById('resource-id').value;
  const title = document.getElementById('resource-title').value.trim();
  const url = document.getElementById('resource-url').value.trim();
  const topicRaw = document.getElementById('resource-topic').value.trim();
  const topic = topicRaw || 'General';
  const description = document.getElementById('resource-desc').value.trim();
  const active = document.getElementById('resource-active').checked;

  if (!title) {
    showResourceError('Please enter a resource title.', 'error-resource-title');
    submitAndAddAnotherResource = false;
    return;
  }

  if (!topicRaw) {
    showResourceError('Please enter a topic or grouping.', 'error-resource-topic');
    submitAndAddAnotherResource = false;
    return;
  }

  // Strict browser URL validation
  if (!isValidHttpUrl(url)) {
    showResourceError('URL must start with http:// or https://.', 'error-resource-url');
    submitAndAddAnotherResource = false;
    return;
  }

  let selectedRecipients = null;
  if (currentLoggedInProfile?.role === 'teacher') {
    const checkedBoxes = Array.from(
      document.querySelectorAll('#resource-recipients-list input[type="checkbox"]:checked')
    );
    selectedRecipients = checkedBoxes.map((cb) => cb.value);
    if (selectedRecipients.length === 0) {
      showResourceError('Please select at least one student recipient for this resource.');
      submitAndAddAnotherResource = false;
      return;
    }
  }

  const saveBtn = document.getElementById('btn-save-resource');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const maxSort = allResources.reduce((max, r) => Math.max(max, r.sort_order || 0), 0);
        const resourcePayload = {
          title,
          url,
          topic,
          description,
          active,
          sort_order: id ? undefined : maxSort + 1,
        };

        const { error } = await supabase.rpc('save_resource_atomic', {
          p_resource_id: id || null,
          p_resource: resourcePayload,
          p_recipients: currentLoggedInProfile?.role === 'teacher' ? (selectedRecipients || []) : null,
        });
        if (error) throw error;

        showToast(id ? 'Resource updated successfully' : 'Resource added successfully', 'success');
        const addAnother = submitAndAddAnotherResource && !id;
        submitAndAddAnotherResource = false;
        await loadResources();
        if (addAnother) {
          openAddModal();
        } else {
          closeModal('modal-resource');
        }
        return;
      }
    }

    // Demo Mode fallback
    if (id) {
      DemoDB.updateResource(id, { title, url, topic, description, active });
      showToast('Resource updated (Demo Mode)', 'success');
    } else {
      DemoDB.addResource({ title, url, topic, description });
      showToast('Resource added (Demo Mode)', 'success');
    }
    const addAnother = submitAndAddAnotherResource && !id;
    submitAndAddAnotherResource = false;
    await loadResources();
    if (addAnother) {
      openAddModal();
    } else {
      closeModal('modal-resource');
    }
  } catch (err) {
    submitAndAddAnotherResource = false;
    console.error('Error saving resource:', err);
    showResourceError(`Error saving resource: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function handleReorder(resourceId, direction) {
  const index = allResources.findIndex(r => r.id === resourceId);
  if (index === -1) return;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= allResources.length) return;

  const current = allResources[index];
  const neighbor = allResources[targetIndex];

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const curOrder = current.sort_order;
        const nbrOrder = neighbor.sort_order;

        await Promise.all([
          supabase.from('resources').update({ sort_order: nbrOrder }).eq('id', current.id),
          supabase.from('resources').update({ sort_order: curOrder }).eq('id', neighbor.id)
        ]);
        await loadResources();
        return;
      }
    }

    DemoDB.reorderResource(resourceId, direction);
    await loadResources();
  } catch (err) {
    console.error('Reorder error:', err);
    showToast('Failed to reorder resource', 'error');
  }
}

async function handleToggleActive(resourceId, newActive) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { error } = await supabase
          .from('resources')
          .update({ active: newActive })
          .eq('id', resourceId);
        if (error) throw error;
        showToast(newActive ? 'Resource activated' : 'Resource deactivated', 'info');
        await loadResources();
        return;
      }
    }

    DemoDB.toggleResourceActive(resourceId);
    showToast(newActive ? 'Resource activated (Demo)' : 'Resource deactivated (Demo)', 'info');
    await loadResources();
  } catch (err) {
    console.error('Toggle active error:', err);
    showToast('Failed to update status', 'error');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let currentLoggedInProfile = null;

export async function initResourcesPage() {
  const profile = await requireAuth(['teacher', 'admin']);
  if (!profile) return;
  currentLoggedInProfile = profile;

  if (profile.role === 'teacher' && profile.permissions?.can_manage_resources === false) {
    window.location.href = '/pages/teacher.html';
    return;
  }

  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || (profile.role === 'admin' ? 'Admin' : 'Teacher');
  if (roleEl) roleEl.textContent = profile.student_code || (profile.role === 'admin' ? 'Admin' : 'Teacher');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();
  if (profile.role === 'admin') {
    setupAdminNav(profile);
  }

  if (profile.role === 'teacher' && isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      const { data: assignments } = await supabase
        .from('teacher_student_assignments')
        .select('student_id')
        .eq('teacher_id', profile.id);
      const assignedIds = (assignments || []).map((a) => a.student_id);
      if (assignedIds.length > 0) {
        const { data: students } = await supabase
          .from('profiles')
          .select('id, full_name, student_code')
          .in('id', assignedIds)
          .eq('role', 'student')
          .eq('active', true)
          .order('student_code');
        teacherAssignedStudents = students || [];
      }
    } catch (err) {
      console.warn('Could not load teacher assigned students for resources:', err);
    }
  }

  document.getElementById('btn-open-add-resource')?.addEventListener('click', openAddModal);
  document.getElementById('form-resource')?.addEventListener('submit', handleFormSubmit);

  ['resource-title', 'resource-topic', 'resource-active'].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', updateResourceLiveSummary);
    el?.addEventListener('change', updateResourceLiveSummary);
  });

  const btnSaveAnother = document.getElementById('btn-save-add-another-resource');
  const formEl = document.getElementById('form-resource');
  if (btnSaveAnother && formEl) {
    btnSaveAnother.addEventListener('click', () => {
      submitAndAddAnotherResource = true;
      formEl.requestSubmit();
    });
  }

  await loadResources();
}

document.addEventListener('DOMContentLoaded', initResourcesPage);
