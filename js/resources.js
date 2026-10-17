/**
 * Trendz Tracker - Admin Resources Management (js/resources.js)
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners } from './modal.js';
import { showToast } from './toast.js';

let allResources = [];

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
          allResources = DemoDB.getResources();
        } else {
          allResources = data || [];
        }
        renderResourcesTable();
        return;
      }
    }

    allResources = DemoDB.getResources();
    renderResourcesTable();
  } catch (err) {
    console.warn('Error loading resources:', err);
    allResources = DemoDB.getResources();
    renderResourcesTable();
  }
}

function renderResourcesTable() {
  const tbody = document.getElementById('resources-tbody');
  if (!tbody) return;

  if (allResources.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">
          No learning resources published yet. Click <strong>+ Add Resource</strong> above to add curriculum guides or worksheets.
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
          <div style="display: inline-flex; gap: 6px;">
            <button type="button" class="btn btn-outline btn-sm btn-edit-resource" data-id="${res.id}">
              Edit
            </button>
            <button type="button" class="btn ${res.active ? 'btn-outline' : 'btn-primary'} btn-sm btn-toggle-resource" data-id="${res.id}" data-active="${res.active}">
              ${res.active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
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

function openEditModal(resourceId) {
  const res = allResources.find(r => r.id === resourceId);
  if (!res) return;

  document.getElementById('modal-resource-title').textContent = 'Edit Learning Resource';
  document.getElementById('resource-id').value = res.id;
  document.getElementById('resource-title').value = res.title;
  document.getElementById('resource-url').value = res.url;
  document.getElementById('resource-topic').value = res.topic || '';
  document.getElementById('resource-desc').value = res.description || '';
  document.getElementById('resource-active').checked = !!res.active;

  openModal('modal-resource');
}

function openAddModal() {
  document.getElementById('modal-resource-title').textContent = 'Add Learning Resource';
  document.getElementById('form-resource').reset();
  document.getElementById('resource-id').value = '';
  document.getElementById('resource-active').checked = true;

  openModal('modal-resource');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('resource-id').value;
  const title = document.getElementById('resource-title').value.trim();
  const url = document.getElementById('resource-url').value.trim();
  const topic = document.getElementById('resource-topic').value.trim() || 'General';
  const description = document.getElementById('resource-desc').value.trim();
  const active = document.getElementById('resource-active').checked;

  if (!title) {
    showToast('Please enter a resource title', 'warning');
    return;
  }

  // Strict browser URL validation
  if (!isValidHttpUrl(url)) {
    showToast('URL must start with http:// or https://', 'error');
    return;
  }

  const saveBtn = document.getElementById('btn-save-resource');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        if (id) {
          const { error } = await supabase
            .from('resources')
            .update({ title, url, topic, description, active })
            .eq('id', id);
          if (error) throw error;
          showToast('Resource updated successfully', 'success');
        } else {
          const maxSort = allResources.reduce((max, r) => Math.max(max, r.sort_order || 0), 0);
          const { error } = await supabase
            .from('resources')
            .insert([{ title, url, topic, description, active, sort_order: maxSort + 1 }]);
          if (error) throw error;
          showToast('Resource added successfully', 'success');
        }
        closeModal('modal-resource');
        await loadResources();
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
    closeModal('modal-resource');
    await loadResources();
  } catch (err) {
    console.error('Error saving resource:', err);
    showToast(`Error saving resource: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Resource';
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

async function initResourcesPage() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'Teacher';
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();

  document.getElementById('btn-open-add-resource')?.addEventListener('click', openAddModal);
  document.getElementById('form-resource')?.addEventListener('submit', handleFormSubmit);

  await loadResources();
}

document.addEventListener('DOMContentLoaded', initResourcesPage);
