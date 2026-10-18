/**
 * Trendz Tracker - Admin Daily To-Do Tasks Management (js/todos.js)
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { showToast } from './toast.js';

let allCategories = [];
let allTodos = [];

async function loadCategories() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('categories')
          .select('*')
          .order('sort_order', { ascending: true });
        if (!error && data) {
          allCategories = data;
          return;
        }
      }
    }
    allCategories = DemoDB.getCategories();
  } catch (err) {
    console.warn('Could not load categories:', err);
    allCategories = DemoDB.getCategories();
  }
}

async function loadTodos() {
  const tbody = document.getElementById('todos-tbody');
  tbody.innerHTML = '<tr><td colspan="7" class="loading-state">Loading daily tasks...</td></tr>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('todos')
          .select('*')
          .order('sort_order', { ascending: true });

        if (error) {
          console.warn('Database error loading todos:', error.message);
          allTodos = DemoDB.getTodos();
        } else {
          allTodos = data || [];
        }
        renderTodosTable();
        return;
      }
    }

    allTodos = DemoDB.getTodos();
    renderTodosTable();
  } catch (err) {
    console.warn('Error loading todos:', err);
    allTodos = DemoDB.getTodos();
    renderTodosTable();
  }
}

function updateCategoryDropdown(selectedSection, currentCatId = '') {
  const catSelect = document.getElementById('todo-category');
  if (!catSelect) return;

  const filtered = allCategories.filter(c => c.section === selectedSection && c.active !== false);

  let html = '<option value="">Any category in this section</option>';
  filtered.forEach(cat => {
    const isSelected = cat.id === currentCatId ? 'selected' : '';
    html += `<option value="${cat.id}" ${isSelected}>${cat.name}</option>`;
  });
  catSelect.innerHTML = html;
}

function renderTodosTable() {
  const tbody = document.getElementById('todos-tbody');
  if (!tbody) return;

  if (allTodos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-state-cell">
          <div class="empty-state">
            <div class="empty-state-icon" aria-hidden="true">📋</div>
            <h3 class="empty-state-title">No daily tasks configured yet</h3>
            <p class="empty-state-desc">Click <strong>+ Add Task</strong> above to set the first daily requirement.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const sectionDefs = [
    { key: 'round', label: '🏆 Competition Rounds' },
    { key: 'basics', label: '⚡ Basics Speed Drills' },
    { key: 'elements', label: '🧩 Elements' },
    { key: 'flash', label: '⚡ Flash Anzan' }
  ];

  let html = '';

  sectionDefs.forEach(sec => {
    const tasks = allTodos
      .filter(t => t.section === sec.key)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

    if (tasks.length === 0) return;

    html += `
      <tr class="section-divider-row">
        <th colspan="7">${escapeHtml(sec.label)} (${tasks.length} task${tasks.length === 1 ? '' : 's'})</th>
      </tr>
    `;

    tasks.forEach((todo, idx) => {
      const cat = allCategories.find(c => c.id === todo.category_id);
      const catName = cat ? cat.name : (todo.category_id ? 'Unknown Category' : '<em>Any in section</em>');
      const levelDisplay = todo.level ? escapeHtml(todo.level) : '<span style="color: var(--text-dim);">All Levels</span>';
      const isFirst = idx === 0;
      const isLast = idx === tasks.length - 1;

      html += `
        <tr data-todo-id="${todo.id}">
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="up" data-id="${todo.id}" ${isFirst ? 'disabled' : ''} title="Move up within ${sec.label}" aria-label="Move task up">▲</button>
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="down" data-id="${todo.id}" ${isLast ? 'disabled' : ''} title="Move down within ${sec.label}" aria-label="Move task down">▼</button>
            </div>
          </td>
          <td>
            <strong style="color: var(--text-main);">${escapeHtml(todo.title)}</strong>
          </td>
          <td>
            <span style="font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; color: var(--color-primary);">${sec.key}</span>
          </td>
          <td>${catName}</td>
          <td>${levelDisplay}</td>
          <td>
            <span class="badge ${todo.active ? 'badge-success' : 'badge-neutral'}">
              ${todo.active ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 6px;">
              <button type="button" class="btn btn-outline btn-sm btn-edit-todo" data-id="${todo.id}">
                Edit
              </button>
              <button type="button" class="btn ${todo.active ? 'btn-outline' : 'btn-primary'} btn-sm btn-toggle-todo" data-id="${todo.id}" data-active="${todo.active}">
                ${todo.active ? 'Deactivate' : 'Activate'}
              </button>
            </div>
          </td>
        </tr>
      `;
    });
  });

  tbody.innerHTML = html;

  attachTableEventListeners();
}

function attachTableEventListeners() {
  // Reorder buttons
  document.querySelectorAll('.btn-reorder').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      const id = target.getAttribute('data-id');
      const dir = target.getAttribute('data-dir');
      await handleReorder(id, dir);
    });
  });

  // Edit buttons
  document.querySelectorAll('.btn-edit-todo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      openEditModal(id);
    });
  });

  // Toggle active buttons
  document.querySelectorAll('.btn-toggle-todo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const currentActive = e.currentTarget.getAttribute('data-active') === 'true';
      await handleToggleActive(id, !currentActive);
    });
  });
}

function openEditModal(todoId) {
  const todo = allTodos.find(t => t.id === todoId);
  if (!todo) return;

  document.getElementById('modal-todo-title').textContent = 'Edit Daily Task';
  document.getElementById('todo-id').value = todo.id;
  document.getElementById('todo-title').value = todo.title;
  document.getElementById('todo-section').value = todo.section;
  updateCategoryDropdown(todo.section, todo.category_id || '');
  document.getElementById('todo-level').value = todo.level || '';
  document.getElementById('todo-active').checked = !!todo.active;

  openModal('modal-todo');
}

function openAddModal() {
  document.getElementById('modal-todo-title').textContent = 'Add Daily Task';
  document.getElementById('form-todo').reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-active').checked = true;
  const sectionSelect = document.getElementById('todo-section');
  sectionSelect.value = 'round';
  updateCategoryDropdown('round', '');

  openModal('modal-todo');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('todo-id').value;
  const title = document.getElementById('todo-title').value.trim();
  const section = document.getElementById('todo-section').value;
  const category_id = document.getElementById('todo-category').value || null;
  const level = document.getElementById('todo-level').value.trim() || null;
  const active = document.getElementById('todo-active').checked;

  if (!title) {
    showToast('Please enter a task title', 'warning');
    return;
  }

  const saveBtn = document.getElementById('btn-save-todo');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        if (id) {
          // Update
          const { error } = await supabase
            .from('todos')
            .update({ title, section, category_id, level, active })
            .eq('id', id);
          if (error) throw error;
          showToast('Task updated successfully', 'success');
        } else {
          // Insert
          const maxSort = allTodos.reduce((max, t) => Math.max(max, t.sort_order || 0), 0);
          const { error } = await supabase
            .from('todos')
            .insert([{ title, section, category_id, level, active, sort_order: maxSort + 1 }]);
          if (error) throw error;
          showToast('Task added successfully', 'success');
        }
        closeModal('modal-todo');
        await loadTodos();
        return;
      }
    }

    // Demo Mode fallback
    if (id) {
      DemoDB.updateTodo(id, { title, section, category_id, level, active });
      showToast('Task updated (Demo Mode)', 'success');
    } else {
      DemoDB.addTodo({ title, section, category_id, level });
      showToast('Task added (Demo Mode)', 'success');
    }
    closeModal('modal-todo');
    await loadTodos();
  } catch (err) {
    console.error('Error saving task:', err);
    showToast(`Error saving task: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Task';
  }
}

async function handleReorder(todoId, direction) {
  const index = allTodos.findIndex(t => t.id === todoId);
  if (index === -1) return;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= allTodos.length) return;

  const current = allTodos[index];
  const neighbor = allTodos[targetIndex];

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        // Swap sort_order
        const curOrder = current.sort_order;
        const nbrOrder = neighbor.sort_order;

        await Promise.all([
          supabase.from('todos').update({ sort_order: nbrOrder }).eq('id', current.id),
          supabase.from('todos').update({ sort_order: curOrder }).eq('id', neighbor.id)
        ]);
        await loadTodos();
        return;
      }
    }

    DemoDB.reorderTodo(todoId, direction);
    await loadTodos();
  } catch (err) {
    console.error('Reorder error:', err);
    showToast('Failed to reorder task', 'error');
  }
}

async function handleToggleActive(todoId, newActive) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { error } = await supabase
          .from('todos')
          .update({ active: newActive })
          .eq('id', todoId);
        if (error) throw error;
        showToast(newActive ? 'Task activated' : 'Task deactivated', 'info');
        await loadTodos();
        return;
      }
    }

    DemoDB.toggleTodoActive(todoId);
    showToast(newActive ? 'Task activated (Demo)' : 'Task deactivated (Demo)', 'info');
    await loadTodos();
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

async function initTodosPage() {
  const profile = await requireAuth(['admin']);
  if (!profile) return;

  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const pillContainer = document.getElementById('user-pill-container');
  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'Teacher';
  if (pillContainer) pillContainer.style.display = 'flex';

  setupModalListeners();
  setupAdminNav();

  document.getElementById('btn-open-add-todo')?.addEventListener('click', openAddModal);
  document.getElementById('form-todo')?.addEventListener('submit', handleFormSubmit);

  // Dynamic category selector reacting to section change
  document.getElementById('todo-section')?.addEventListener('change', (e) => {
    updateCategoryDropdown(e.target.value, '');
  });

  await loadCategories();
  await loadTodos();
}

document.addEventListener('DOMContentLoaded', initTodosPage);
