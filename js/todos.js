/**
 * Trendz Tracker - Admin Daily To-Do Tasks Management (js/todos.js)
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { showToast } from './toast.js';
import { DRILL_CATALOG } from './drillCatalog.js';
import {
  MEMORIAD_MODULES,
  normalizeTaskInput,
  optionsForSection,
  formatTaskTarget,
  requiredCountLabelForSection,
} from './todoForm.js';

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
        if (error) {
          console.warn('Could not load categories:', error.message);
          allCategories = [];
          return;
        }
        allCategories = data || [];
        return;
      }
    }
    allCategories = DemoDB.getCategories();
  } catch (err) {
    console.warn('Could not load categories:', err);
    allCategories = isSupabaseConfigured() ? [] : DemoDB.getCategories();
  }
}

async function loadTodos() {
  const tbody = document.getElementById('todos-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-state">Loading daily tasks...</td></tr>';
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('daily_tasks')
          .select('*')
          .order('sort_order', { ascending: true });

        if (error) {
          console.error('Database error loading daily_tasks:', error);
          showToast('error', `Failed to load daily tasks: ${error.message}`);
          allTodos = [];
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
    console.error('Error loading daily_tasks:', err);
    showToast('error', `Failed to load daily tasks: ${err.message || 'Unknown error'}`);
    allTodos = isSupabaseConfigured() ? [] : DemoDB.getTodos();
    renderTodosTable();
  }
}

function clearFormErrors() {
  const errBox = document.getElementById('todo-form-errors');
  if (errBox) {
    errBox.style.display = 'none';
    errBox.textContent = '';
  }
}

function showFormErrors(errors) {
  const messages = Object.values(errors || {}).filter(Boolean);
  if (messages.length === 0) return;

  const errBox = document.getElementById('todo-form-errors');
  if (errBox) {
    errBox.innerHTML = messages.map((m) => `<div>• ${escapeHtml(m)}</div>`).join('');
    errBox.style.display = 'block';
  }
  showToast('error', messages[0]);
}

function updateTargetDropdown(selectedSection, currentTargetValue = '') {
  const catSelect = document.getElementById('todo-category');
  const catLabel = document.getElementById('todo-category-label');
  const catHint = document.getElementById('todo-category-hint');
  const reqCountLabel = document.getElementById('todo-required-count-label');

  const sec = String(selectedSection || 'round').trim().toLowerCase();
  if (reqCountLabel) {
    reqCountLabel.textContent = requiredCountLabelForSection(sec);
  }

  if (!catSelect) return;

  const options = optionsForSection(sec, allCategories, DRILL_CATALOG, MEMORIAD_MODULES);

  if (sec === 'flash') {
    if (catLabel) catLabel.textContent = 'Activity Filter';
    if (catHint) {
      catHint.textContent = 'Flash Anzan has no sub-categories; any completed round ticks this task.';
    }
    catSelect.innerHTML = '<option value="">Any Flash Anzan round</option>';
    catSelect.value = '';
    catSelect.disabled = true;
    return;
  }

  catSelect.disabled = false;

  let placeholder = 'Any category in this section';
  if (sec === 'elements') {
    if (catLabel) catLabel.textContent = 'Specific Drill (Optional)';
    if (catHint) catHint.textContent = 'Pick an enabled Elements worksheet drill or leave as any.';
    placeholder = 'Any drill in Elements';
  } else if (sec === 'memoriad') {
    if (catLabel) catLabel.textContent = 'Specific Module (Optional)';
    if (catHint) catHint.textContent = 'Pick one of the four Memoriad modules or leave as any.';
    placeholder = 'Any module in Memoriad';
  } else {
    if (catLabel) catLabel.textContent = 'Category Filter (Optional)';
    if (catHint) catHint.textContent = 'Dropdown shows active categories matching the chosen section.';
    placeholder = 'Any category in this section';
  }

  const normalizedCurrent = String(currentTargetValue || '').trim();
  let html = `<option value="">${escapeHtml(placeholder)}</option>`;
  options.forEach((opt) => {
    const isSelected = String(opt.value) === normalizedCurrent ? 'selected' : '';
    html += `<option value="${escapeHtml(opt.value)}" ${isSelected}>${escapeHtml(opt.label)}</option>`;
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
    { key: 'memoriad', label: '🧠 Memoriad' },
    { key: 'flash', label: '⚡ Flash Anzan' },
  ];

  let html = '';

  sectionDefs.forEach((sec) => {
    const tasks = allTodos
      .filter((t) => t.section === sec.key)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

    if (tasks.length === 0) return;

    html += `
      <tr class="section-divider-row">
        <th colspan="7">${escapeHtml(sec.label)} (${tasks.length} task${tasks.length === 1 ? '' : 's'})</th>
      </tr>
    `;

    tasks.forEach((todo, idx) => {
      const targetInfo = formatTaskTarget(todo, allCategories, DRILL_CATALOG, MEMORIAD_MODULES);
      const targetDisplay = targetInfo.isAny || targetInfo.unavailable
        ? `<em style="color: var(--text-muted);">${escapeHtml(targetInfo.text)}</em>`
        : escapeHtml(targetInfo.text);
      const levelDisplay = todo.level
        ? escapeHtml(todo.level)
        : '<span style="color: var(--text-dim);">All Levels</span>';
      const reqCount = Number(todo.required_count) || 1;
      const reqCountBadge = reqCount > 1
        ? `<span class="num" style="margin-left: 6px; font-size: var(--text-xs); font-weight: 600; color: var(--color-primary);">x ${reqCount} per day</span>`
        : '';
      const isFirst = idx === 0;
      const isLast = idx === tasks.length - 1;

      html += `
        <tr data-todo-id="${escapeHtml(todo.id)}">
          <td>
            <div style="display: flex; gap: 4px; align-items: center;">
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="up" data-id="${escapeHtml(todo.id)}" ${isFirst ? 'disabled' : ''} title="Move up within ${escapeHtml(sec.label)}" aria-label="Move task up">▲</button>
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="down" data-id="${escapeHtml(todo.id)}" ${isLast ? 'disabled' : ''} title="Move down within ${escapeHtml(sec.label)}" aria-label="Move task down">▼</button>
            </div>
          </td>
          <td>
            <strong style="color: var(--text-main);">${escapeHtml(todo.title)}</strong>${reqCountBadge}
          </td>
          <td>
            <span style="font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; color: var(--color-primary);">${escapeHtml(sec.key)}</span>
          </td>
          <td>${targetDisplay}</td>
          <td>${levelDisplay}</td>
          <td>
            <span class="badge ${todo.active ? 'badge-success' : 'badge-neutral'}">
              ${todo.active ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: 6px;">
              <button type="button" class="btn btn-outline btn-sm btn-edit-todo" data-id="${escapeHtml(todo.id)}">
                Edit
              </button>
              <button type="button" class="btn ${todo.active ? 'btn-outline' : 'btn-primary'} btn-sm btn-toggle-todo" data-id="${escapeHtml(todo.id)}" data-active="${Boolean(todo.active)}">
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
  document.querySelectorAll('.btn-reorder').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      const id = target.getAttribute('data-id');
      const dir = target.getAttribute('data-dir');
      await handleReorder(id, dir);
    });
  });

  // Edit buttons
  document.querySelectorAll('.btn-edit-todo').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      openEditModal(id);
    });
  });

  // Toggle active buttons
  document.querySelectorAll('.btn-toggle-todo').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const currentActive = e.currentTarget.getAttribute('data-active') === 'true';
      await handleToggleActive(id, !currentActive);
    });
  });
}

function openEditModal(todoId) {
  const todo = allTodos.find((t) => String(t.id) === String(todoId));
  if (!todo) return;

  clearFormErrors();
  document.getElementById('modal-todo-title').textContent = 'Edit Daily Task';
  document.getElementById('todo-id').value = todo.id;
  document.getElementById('todo-title').value = todo.title || '';
  document.getElementById('todo-section').value = todo.section || 'round';

  const currentTarget =
    todo.section === 'basics' || todo.section === 'round'
      ? todo.category_id || ''
      : todo.section === 'elements' || todo.section === 'memoriad'
        ? todo.activity_key || ''
        : '';

  updateTargetDropdown(todo.section, currentTarget);
  const reqCountEl = document.getElementById('todo-required-count');
  if (reqCountEl) {
    const loadedCount = Number(todo.required_count);
    reqCountEl.value = Number.isInteger(loadedCount) && loadedCount >= 1 ? String(loadedCount) : '1';
  }
  document.getElementById('todo-level').value = todo.level || '';
  document.getElementById('todo-active').checked = Boolean(todo.active);

  openModal('modal-todo');
}

function openAddModal() {
  clearFormErrors();
  document.getElementById('modal-todo-title').textContent = 'Add Daily Task';
  document.getElementById('form-todo').reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-active').checked = true;
  const reqCountEl = document.getElementById('todo-required-count');
  if (reqCountEl) reqCountEl.value = '1';
  const sectionSelect = document.getElementById('todo-section');
  sectionSelect.value = 'round';
  updateTargetDropdown('round', '');

  openModal('modal-todo');
}

async function handleFormSubmit(e) {
  e.preventDefault();
  clearFormErrors();

  const id = document.getElementById('todo-id').value.trim();
  const rawTitle = document.getElementById('todo-title').value;
  const rawSection = document.getElementById('todo-section').value;
  const rawTarget = document.getElementById('todo-category').value;
  const rawRequiredCount = document.getElementById('todo-required-count')?.value ?? '1';
  const rawLevel = document.getElementById('todo-level').value;
  const rawActive = document.getElementById('todo-active').checked;

  const normalized = normalizeTaskInput(
    {
      title: rawTitle,
      section: rawSection,
      category_id: rawTarget,
      activity_key: rawTarget,
      required_count: rawRequiredCount,
      level: rawLevel,
      active: rawActive,
    },
    rawSection
  );

  if (normalized.errors) {
    showFormErrors(normalized.errors);
    return;
  }

  const { title, section, category_id, activity_key, level, required_count, active } = normalized.value;

  const saveBtn = document.getElementById('btn-save-todo');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        if (id) {
          const { error } = await supabase
            .from('daily_tasks')
            .update({ title, section, category_id, activity_key, level, required_count, active })
            .eq('id', id);
          if (error) throw error;
          showToast('success', 'Task updated successfully');
        } else {
          const maxSort = allTodos.reduce((max, t) => Math.max(max, Number(t.sort_order) || 0), 0);
          const { error } = await supabase
            .from('daily_tasks')
            .insert([
              {
                title,
                section,
                category_id,
                activity_key,
                level,
                required_count,
                active,
                sort_order: maxSort + 1,
              },
            ]);
          if (error) throw error;
          showToast('success', 'Task added successfully');
        }
        closeModal('modal-todo');
        await loadTodos();
        return;
      }
    }

    // Demo Mode fallback
    if (id) {
      DemoDB.updateTodo(id, { title, section, category_id, activity_key, level, required_count, active });
      showToast('success', 'Task updated (Demo Mode)');
    } else {
      DemoDB.addTodo({ title, section, category_id, activity_key, level, required_count, active });
      showToast('success', 'Task added (Demo Mode)');
    }
    closeModal('modal-todo');
    await loadTodos();
  } catch (err) {
    console.error('Error saving task:', err);
    showToast('error', `Error saving task: ${err.message || 'Unknown error'}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Task';
  }
}

async function handleReorder(todoId, direction) {
  const current = allTodos.find((t) => String(t.id) === String(todoId));
  if (!current) return;

  const sectionTasks = allTodos
    .filter((t) => t.section === current.section)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  const index = sectionTasks.findIndex((t) => String(t.id) === String(todoId));
  if (index === -1) return;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= sectionTasks.length) return;

  const neighbor = sectionTasks[targetIndex];

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        let curOrder = Number(current.sort_order) || index + 1;
        let nbrOrder = Number(neighbor.sort_order) || targetIndex + 1;
        if (curOrder === nbrOrder) {
          curOrder = index + 1;
          nbrOrder = targetIndex + 1;
        }

        const [res1, res2] = await Promise.all([
          supabase.from('daily_tasks').update({ sort_order: nbrOrder }).eq('id', current.id),
          supabase.from('daily_tasks').update({ sort_order: curOrder }).eq('id', neighbor.id),
        ]);
        if (res1.error) throw res1.error;
        if (res2.error) throw res2.error;
        await loadTodos();
        return;
      }
    }

    DemoDB.reorderTodo(todoId, direction);
    await loadTodos();
  } catch (err) {
    console.error('Reorder error:', err);
    showToast('error', `Failed to reorder task: ${err.message || 'Unknown error'}`);
  }
}

async function handleToggleActive(todoId, newActive) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { error } = await supabase
          .from('daily_tasks')
          .update({ active: newActive })
          .eq('id', todoId);
        if (error) throw error;
        showToast('info', newActive ? 'Task activated' : 'Task deactivated');
        await loadTodos();
        return;
      }
    }

    DemoDB.toggleTodoActive(todoId);
    showToast('info', newActive ? 'Task activated (Demo)' : 'Task deactivated (Demo)');
    await loadTodos();
  } catch (err) {
    console.error('Toggle active error:', err);
    showToast('error', `Failed to update status: ${err.message || 'Unknown error'}`);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
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

  // Dynamic target selector reacting to section change
  document.getElementById('todo-section')?.addEventListener('change', (e) => {
    clearFormErrors();
    updateTargetDropdown(e.target.value, '');
  });

  await loadCategories();
  await loadTodos();
}

document.addEventListener('DOMContentLoaded', initTodosPage);
