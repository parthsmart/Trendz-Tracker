/**
 * Trendz Tracker - Admin Daily To-Do Tasks Management (js/todos.js)
 *
 * Phase 14a + Phase 14b Calmer UI:
 * - Unified modal form pattern (required fields first, collapsible More options, live summary sentence,
 *   Save and add another on create, inline field errors + top alert banner)
 * - Wording: "Type", "Specific activity (optional)", "Level (optional)"
 * - Emoji-free section headers and neutral status chips
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
  flashSummary,
} from './todoForm.js';
import {
  shouldOpenMoreOptions,
  buildModalLiveSummary,
  setMoreOptionsOpen,
} from './formPattern.js';

let allCategories = [];
let allTodos = [];
let titleFilledByFlashButton = false;

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

function getTodosTableBody() {
  return document.getElementById('todos-table-body') || document.getElementById('todos-tbody');
}

function getTargetSelectEl() {
  return document.getElementById('todo-target') || document.getElementById('todo-category');
}

async function loadTodos() {
  const tbody = getTodosTableBody();
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading-state">Loading daily tasks...</td></tr>';
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
        updateSummaryStats();
        renderTodosTable();
        return;
      }
    }

    allTodos = DemoDB.getTodos();
    updateSummaryStats();
    renderTodosTable();
  } catch (err) {
    console.error('Error loading daily_tasks:', err);
    showToast('error', `Failed to load daily tasks: ${err.message || 'Unknown error'}`);
    allTodos = isSupabaseConfigured() ? [] : DemoDB.getTodos();
    updateSummaryStats();
    renderTodosTable();
  }
}

function updateSummaryStats() {
  const totalEl = document.getElementById('stat-total-todos');
  const activeEl = document.getElementById('stat-active-todos');
  const breakdownEl = document.getElementById('stat-sections-breakdown');

  const total = allTodos.length;
  const active = allTodos.filter((t) => t.active !== false).length;
  if (totalEl) totalEl.textContent = String(total);
  if (activeEl) activeEl.textContent = String(active);

  if (breakdownEl) {
    const r = allTodos.filter((t) => t.section === 'round').length;
    const b = allTodos.filter((t) => t.section === 'basics').length;
    const e = allTodos.filter((t) => t.section === 'elements').length;
    const f = allTodos.filter((t) => t.section === 'flash').length;
    breakdownEl.textContent = `${r} R · ${b} B · ${e} E · ${f} F`;
  }
}

function clearFormErrors() {
  const errBox =
    document.getElementById('todo-error-banner') || document.getElementById('todo-form-errors');
  if (errBox) {
    errBox.style.display = 'none';
    errBox.textContent = '';
  }

  const fieldErrorIds = [
    'error-todo-title',
    'error-todo-section',
    'error-todo-required-count',
    'error-todo-level',
    'error-todo-flash-digits',
    'error-todo-flash-count',
    'error-todo-flash-speed',
    'error-todo-flash-mode',
  ];
  fieldErrorIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'none';
      el.textContent = '';
    }
  });
}

function showFormErrors(errors) {
  const safeErrors = errors || {};
  const messages = Object.values(safeErrors).filter(Boolean);
  if (messages.length === 0) return;

  const errBox =
    document.getElementById('todo-error-banner') || document.getElementById('todo-form-errors');
  if (errBox) {
    errBox.innerHTML = messages.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
    errBox.style.display = 'block';
  }

  const fieldMap = {
    title: 'error-todo-title',
    section: 'error-todo-section',
    required_count: 'error-todo-required-count',
    level: 'error-todo-level',
    flash_digits: 'error-todo-flash-digits',
    flash_count: 'error-todo-flash-count',
    flash_speed_ms: 'error-todo-flash-speed',
    flash_mode: 'error-todo-flash-mode',
  };

  Object.entries(fieldMap).forEach(([key, domId]) => {
    const msg = safeErrors[key];
    const el = document.getElementById(domId);
    if (el && msg) {
      el.textContent = msg;
      el.style.display = 'block';
    }
  });

  if (
    safeErrors.level ||
    safeErrors.flash_digits ||
    safeErrors.flash_count ||
    safeErrors.flash_speed_ms ||
    safeErrors.flash_mode
  ) {
    setMoreOptionsOpen(document.getElementById('todo-more-options'), true);
  }
}

function resetFlashSettingsFields() {
  const digitsEl = document.getElementById('todo-flash-digits');
  const countEl = document.getElementById('todo-flash-count');
  const speedEl = document.getElementById('todo-flash-speed');
  const modeEl = document.getElementById('todo-flash-mode');
  if (digitsEl) digitsEl.value = '';
  if (countEl) countEl.value = '';
  if (speedEl) speedEl.value = '';
  if (modeEl) modeEl.value = '';
}

function populateFlashSettingsFields(todo = {}) {
  const digitsEl = document.getElementById('todo-flash-digits');
  const countEl = document.getElementById('todo-flash-count');
  const speedEl = document.getElementById('todo-flash-speed');
  const modeEl = document.getElementById('todo-flash-mode');

  if (digitsEl) {
    digitsEl.value =
      todo.flash_digits !== null && todo.flash_digits !== undefined
        ? String(todo.flash_digits)
        : '';
  }
  if (countEl) {
    countEl.value =
      todo.flash_count !== null && todo.flash_count !== undefined
        ? String(todo.flash_count)
        : '';
  }
  if (speedEl) {
    if (todo.flash_speed_ms !== null && todo.flash_speed_ms !== undefined) {
      const ms = Number(todo.flash_speed_ms);
      speedEl.value = Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '';
    } else {
      speedEl.value = '';
    }
  }
  if (modeEl) {
    modeEl.value =
      todo.flash_mode === 'add' || todo.flash_mode === 'add_sub' ? todo.flash_mode : '';
  }
}

function readDraftFlashSettingsFromForm() {
  const rawDigits = document.getElementById('todo-flash-digits')?.value ?? '';
  const rawCount = document.getElementById('todo-flash-count')?.value ?? '';
  const rawSpeedSec = document.getElementById('todo-flash-speed')?.value ?? '';
  const rawMode = document.getElementById('todo-flash-mode')?.value ?? '';

  let flash_digits = null;
  if (rawDigits.trim() !== '') {
    const d = Number(rawDigits.trim());
    if (Number.isInteger(d) && d >= 1 && d <= 5) flash_digits = d;
  }

  let flash_count = null;
  if (rawCount.trim() !== '') {
    const c = Number(rawCount.trim());
    if (Number.isInteger(c) && c >= 2 && c <= 1000) flash_count = c;
  }

  let flash_speed_ms = null;
  if (rawSpeedSec.trim() !== '') {
    const sec = Number(rawSpeedSec.trim());
    const tenths = Math.round(sec * 10);
    if (
      Number.isFinite(sec) &&
      Math.abs(sec * 10 - tenths) <= 1e-6 &&
      tenths >= 2 &&
      tenths <= 50
    ) {
      flash_speed_ms = tenths * 100;
    }
  }

  let flash_mode = null;
  const m = rawMode.trim().toLowerCase();
  if (m === 'add' || m === 'add_sub') {
    flash_mode = m;
  }

  return { flash_digits, flash_count, flash_speed_ms, flash_mode };
}

function handleUseFlashSettingsAsTitle() {
  const titleEl = document.getElementById('todo-title');
  if (!titleEl) return;

  const currentTitle = titleEl.value.trim();
  if (currentTitle !== '' && !titleFilledByFlashButton) {
    return;
  }

  const draft = readDraftFlashSettingsFromForm();
  const summaryText = flashSummary(draft);
  titleEl.value = `Flash: ${summaryText}`;
  titleFilledByFlashButton = true;
  updateTodoLiveSummary();
}

function updateTodoLiveSummary() {
  const summaryEl = document.getElementById('todo-live-summary');
  if (!summaryEl) return;

  const section = document.getElementById('todo-section')?.value || 'basics';
  const reqCount = document.getElementById('todo-required-count')?.value || '1';
  const level = document.getElementById('todo-level')?.value || '';
  const active = document.getElementById('todo-active')?.checked !== false;

  let targetSummary = '';
  if (section === 'flash') {
    targetSummary = flashSummary(readDraftFlashSettingsFromForm());
  } else {
    const targetSel = getTargetSelectEl();
    if (targetSel && targetSel.value) {
      const selectedOpt = targetSel.options[targetSel.selectedIndex];
      targetSummary = selectedOpt ? selectedOpt.textContent.trim() : '';
    }
  }

  summaryEl.textContent = buildModalLiveSummary('todo', {
    section,
    required_count: reqCount,
    level,
    active,
    targetSummary,
  });
}

function updateTargetDropdown(selectedSection, currentTargetValue = '') {
  const targetGroup =
    document.getElementById('group-specific-activity') ||
    document.getElementById('todo-target-group');
  const flashGroup =
    document.getElementById('group-flash-settings') ||
    document.getElementById('todo-flash-settings-group');
  const catSelect = getTargetSelectEl();
  const catLabel =
    document.getElementById('label-todo-target') ||
    document.getElementById('todo-category-label');
  const catHint =
    document.getElementById('todo-target-hint') ||
    document.getElementById('todo-category-hint');
  const reqCountLabel =
    document.getElementById('label-todo-required-count') ||
    document.getElementById('todo-required-count-label');

  const sec = String(selectedSection || 'basics').trim().toLowerCase();
  if (reqCountLabel) {
    reqCountLabel.textContent = requiredCountLabelForSection(sec);
  }

  if (sec === 'flash') {
    if (targetGroup) targetGroup.style.display = 'none';
    if (flashGroup) flashGroup.style.display = 'block';
    if (catSelect) {
      catSelect.innerHTML = '<option value="">Any Flash Anzan try</option>';
      catSelect.value = '';
      catSelect.disabled = true;
    }
    setMoreOptionsOpen(document.getElementById('todo-more-options'), true);
    updateTodoLiveSummary();
    return;
  }

  if (targetGroup) targetGroup.style.display = '';
  if (flashGroup) flashGroup.style.display = 'none';

  if (!catSelect) return;

  const options = optionsForSection(sec, allCategories, DRILL_CATALOG, MEMORIAD_MODULES);

  catSelect.disabled = false;
  if (catLabel) catLabel.textContent = 'Specific activity (optional)';
  if (catHint) catHint.textContent = 'Leave on Any to count all activities in this type.';

  const placeholder = 'Any activity in this type';
  const normalizedCurrent = String(currentTargetValue || '').trim();
  let html = `<option value="">${escapeHtml(placeholder)}</option>`;
  options.forEach((opt) => {
    const isSelected = String(opt.value) === normalizedCurrent ? 'selected' : '';
    html += `<option value="${escapeHtml(opt.value)}" ${isSelected}>${escapeHtml(opt.label)}</option>`;
  });
  catSelect.innerHTML = html;
  updateTodoLiveSummary();
}

function renderTodosTable() {
  const tbody = getTodosTableBody();
  if (!tbody) return;

  if (allTodos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="empty-state-cell">
          <div class="empty-state">
            <h3 class="empty-state-title">No daily tasks configured yet</h3>
            <p class="empty-state-desc">Click <strong>+ Add Daily Task</strong> above to set the first daily requirement.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  const sectionDefs = [
    { key: 'round', label: 'Competition Rounds' },
    { key: 'basics', label: 'Basics Speed Drills' },
    { key: 'elements', label: 'Elements' },
    { key: 'memoriad', label: 'Memoriad' },
    { key: 'flash', label: 'Flash Anzan' },
  ];

  let html = '';

  sectionDefs.forEach((sec) => {
    const tasks = allTodos
      .filter((t) => t.section === sec.key)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

    if (tasks.length === 0) return;

    html += `
      <tr class="section-divider-row">
        <th colspan="8">${escapeHtml(sec.label)} (${tasks.length} task${tasks.length === 1 ? '' : 's'})</th>
      </tr>
    `;

    tasks.forEach((todo, idx) => {
      const targetInfo = formatTaskTarget(todo, allCategories, DRILL_CATALOG, MEMORIAD_MODULES);
      const targetDisplay =
        targetInfo.isAny || targetInfo.unavailable
          ? `<span style="color: var(--text-muted);">${escapeHtml(targetInfo.text)}</span>`
          : escapeHtml(targetInfo.text);
      const levelDisplay = todo.level
        ? escapeHtml(todo.level)
        : '<span style="color: var(--text-dim);">All levels</span>';
      const reqCount = Number(todo.required_count) || 1;
      const isFirst = idx === 0;
      const isLast = idx === tasks.length - 1;

      html += `
        <tr data-todo-id="${escapeHtml(todo.id)}" class="${todo.active === false ? 'row-inactive' : ''}">
          <td>
            <div style="display: flex; gap: var(--space-1); align-items: center;">
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="up" data-id="${escapeHtml(todo.id)}" ${isFirst ? 'disabled' : ''} title="Move up within ${escapeHtml(sec.label)}" aria-label="Move task up">&uarr;</button>
              <button type="button" class="btn btn-outline btn-xs btn-reorder" data-dir="down" data-id="${escapeHtml(todo.id)}" ${isLast ? 'disabled' : ''} title="Move down within ${escapeHtml(sec.label)}" aria-label="Move task down">&darr;</button>
            </div>
          </td>
          <td>
            <strong style="color: var(--text-main);">${escapeHtml(todo.title)}</strong>
          </td>
          <td>
            <span class="badge badge-neutral">${escapeHtml(sec.label)}</span>
          </td>
          <td>${targetDisplay}</td>
          <td class="num">${reqCount}</td>
          <td>${levelDisplay}</td>
          <td>
            <span class="badge badge-neutral">
              ${todo.active !== false ? 'Active' : 'Inactive'}
            </span>
          </td>
          <td style="text-align: right;">
            <div style="display: inline-flex; gap: var(--space-2);">
              <button type="button" class="btn btn-outline btn-sm btn-edit-todo" data-id="${escapeHtml(todo.id)}">
                Edit
              </button>
              <button type="button" class="btn btn-outline btn-sm btn-toggle-todo" data-id="${escapeHtml(todo.id)}" data-active="${Boolean(todo.active)}">
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
  document.querySelectorAll('.btn-reorder').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      const id = target.getAttribute('data-id');
      const dir = target.getAttribute('data-dir');
      await handleReorder(id, dir);
    });
  });

  document.querySelectorAll('.btn-edit-todo').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      openEditModal(id);
    });
  });

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
  titleFilledByFlashButton = false;
  document.getElementById('modal-todo-title').textContent = 'Edit Daily Task';
  document.getElementById('todo-id').value = todo.id;
  document.getElementById('todo-title').value = todo.title || '';
  document.getElementById('todo-section').value = todo.section || 'basics';

  const saveAddAnotherBtn = document.getElementById('btn-save-add-another-todo');
  if (saveAddAnotherBtn) saveAddAnotherBtn.style.display = 'none';

  const currentTarget =
    todo.section === 'basics' || todo.section === 'round'
      ? todo.category_id || ''
      : todo.section === 'elements' || todo.section === 'memoriad'
        ? todo.activity_key || ''
        : '';

  resetFlashSettingsFields();
  if (todo.section === 'flash') {
    populateFlashSettingsFields(todo);
  }
  updateTargetDropdown(todo.section, currentTarget);

  const reqCountEl = document.getElementById('todo-required-count');
  if (reqCountEl) {
    const loadedCount = Number(todo.required_count);
    reqCountEl.value =
      Number.isInteger(loadedCount) && loadedCount >= 1 ? String(loadedCount) : '1';
  }
  document.getElementById('todo-level').value = todo.level || '';
  document.getElementById('todo-active').checked = todo.active !== false;

  const hasOptionalValue = shouldOpenMoreOptions(
    [
      currentTarget,
      todo.level,
      todo.flash_digits,
      todo.flash_count,
      todo.flash_speed_ms,
      todo.flash_mode,
      todo.active === false ? 'inactive' : '',
    ],
    true
  );
  setMoreOptionsOpen(
    document.getElementById('todo-more-options'),
    hasOptionalValue || todo.section === 'flash'
  );

  updateTodoLiveSummary();
  openModal('modal-todo');
}

function openAddModal() {
  clearFormErrors();
  titleFilledByFlashButton = false;
  document.getElementById('modal-todo-title').textContent = 'Add Daily Task';
  document.getElementById('form-todo').reset();
  document.getElementById('todo-id').value = '';
  document.getElementById('todo-active').checked = true;

  const saveAddAnotherBtn = document.getElementById('btn-save-add-another-todo');
  if (saveAddAnotherBtn) saveAddAnotherBtn.style.display = 'inline-flex';

  resetFlashSettingsFields();
  const reqCountEl = document.getElementById('todo-required-count');
  if (reqCountEl) reqCountEl.value = '1';
  const sectionSelect = document.getElementById('todo-section');
  sectionSelect.value = 'basics';
  updateTargetDropdown('basics', '');
  setMoreOptionsOpen(document.getElementById('todo-more-options'), false);

  updateTodoLiveSummary();
  openModal('modal-todo');
}

async function submitTodoForm(keepOpenForAnother = false) {
  clearFormErrors();

  const id = document.getElementById('todo-id').value.trim();
  const rawTitle = document.getElementById('todo-title').value;
  const rawSection = document.getElementById('todo-section').value;
  const targetSel = getTargetSelectEl();
  const rawTarget = targetSel ? targetSel.value : '';
  const rawFlashDigits = document.getElementById('todo-flash-digits')?.value ?? '';
  const rawFlashCount = document.getElementById('todo-flash-count')?.value ?? '';
  const rawFlashSpeed = document.getElementById('todo-flash-speed')?.value ?? '';
  const rawFlashMode = document.getElementById('todo-flash-mode')?.value ?? '';
  const rawRequiredCount = document.getElementById('todo-required-count')?.value ?? '1';
  const rawLevel = document.getElementById('todo-level').value;
  const rawActive = document.getElementById('todo-active').checked;

  const normalized = normalizeTaskInput(
    {
      title: rawTitle,
      section: rawSection,
      category_id: rawTarget,
      activity_key: rawTarget,
      flash_digits: rawFlashDigits,
      flash_count: rawFlashCount,
      flash_speed_ms: rawFlashSpeed,
      flash_mode: rawFlashMode,
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

  const {
    title,
    section,
    category_id,
    activity_key,
    flash_digits,
    flash_count,
    flash_speed_ms,
    flash_mode,
    level,
    required_count,
    active,
  } = normalized.value;

  const taskPayload = {
    title,
    section,
    category_id,
    activity_key,
    flash_digits,
    flash_count,
    flash_speed_ms,
    flash_mode,
    level,
    required_count,
    active,
  };

  const saveBtn = document.getElementById('btn-save-todo');
  const addAnotherBtn = document.getElementById('btn-save-add-another-todo');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }
  if (addAnotherBtn) addAnotherBtn.disabled = true;

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        if (id) {
          const { error } = await supabase
            .from('daily_tasks')
            .update(taskPayload)
            .eq('id', id);
          if (error) throw error;
          showToast('success', 'Task updated successfully');
        } else {
          const maxSort = allTodos.reduce((max, t) => Math.max(max, Number(t.sort_order) || 0), 0);
          const { error } = await supabase
            .from('daily_tasks')
            .insert([
              {
                ...taskPayload,
                sort_order: maxSort + 1,
              },
            ]);
          if (error) throw error;
          showToast('success', 'Task added successfully');
        }
        await loadTodos();
        if (keepOpenForAnother && !id) {
          openAddModal();
        } else {
          closeModal('modal-todo');
        }
        return;
      }
    }

    // Demo Mode fallback
    if (id) {
      DemoDB.updateTodo(id, taskPayload);
      showToast('success', 'Task updated (Demo Mode)');
    } else {
      DemoDB.addTodo(taskPayload);
      showToast('success', 'Task added (Demo Mode)');
    }
    await loadTodos();
    if (keepOpenForAnother && !id) {
      openAddModal();
    } else {
      closeModal('modal-todo');
    }
  } catch (err) {
    console.error('Error saving task:', err);
    showFormErrors({ form: err.message || 'Unknown error saving task.' });
    showToast('error', `Error saving task: ${err.message || 'Unknown error'}`);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
    if (addAnotherBtn) addAnotherBtn.disabled = false;
  }
}

async function handleFormSubmit(e) {
  e.preventDefault();
  await submitTodoForm(false);
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
  document
    .getElementById('btn-save-add-another-todo')
    ?.addEventListener('click', () => submitTodoForm(true));
  document
    .getElementById('btn-flash-title-from-settings')
    ?.addEventListener('click', handleUseFlashSettingsAsTitle);

  document.getElementById('todo-title')?.addEventListener('input', () => {
    titleFilledByFlashButton = false;
    updateTodoLiveSummary();
  });

  document.getElementById('todo-section')?.addEventListener('change', (e) => {
    clearFormErrors();
    updateTargetDropdown(e.target.value, '');
  });

  [
    'todo-target',
    'todo-required-count',
    'todo-level',
    'todo-active',
    'todo-flash-digits',
    'todo-flash-count',
    'todo-flash-speed',
    'todo-flash-mode',
  ].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', updateTodoLiveSummary);
    el?.addEventListener('change', updateTodoLiveSummary);
  });

  await loadCategories();
  await loadTodos();
}

document.addEventListener('DOMContentLoaded', initTodosPage);
