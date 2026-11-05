/**
 * Trendz Tracker - Admin Basics Targets Controller (js/targets.js)
 * 
 * Manage speed and accuracy target rules for basics speed drills:
 * - Admin-only route guard
 * - Lists basics categories only, in sort order
 * - Displays default rule and any per-level rules for each category:
 *   "Accuracy at least 90% and time at most 2:00"
 * - Add, edit, and toggle active status for target rules
 * - Friendly database error messages (e.g. unique constraint duplicates)
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { formatSecondsToTime, parseTimeToSeconds } from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let submitAndAddAnotherTarget = false;

let currentProfile = null;
let basicsCategories = [];
let allThresholds = [];
let studentLevels = new Set();
let editingTargetId = null;

async function initTargetsPage() {
  currentProfile = await requireAuth(['admin']);
  if (!currentProfile) return;

  renderHeaderUser(currentProfile);
  setupAdminNav(currentProfile);
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupTargetModalHandlers();

  await loadTargetsData();
}

/**
 * Loads basics categories, existing target rules, and student levels
 */
async function loadTargetsData() {
  const container = document.getElementById('targets-list-container');
  if (container) {
    container.innerHTML = `
      <div class="loading-state" style="text-align: center; padding: var(--space-8);">
        Loading basics categories and target rules...
      </div>
    `;
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // 1. Basics categories only
      const { data: catData, error: catErr } = await supabase
        .from('categories')
        .select('*')
        .eq('section', 'basics')
        .order('sort_order', { ascending: true });

      if (catErr) throw catErr;
      basicsCategories = catData || [];

      // 2. All target thresholds
      const { data: targetData, error: targetErr } = await supabase
        .from('basics_thresholds')
        .select('*');

      if (targetErr) throw targetErr;
      allThresholds = targetData || [];

      // 3. Existing student levels
      const { data: profData } = await supabase
        .from('profiles')
        .select('level')
        .not('level', 'is', null);

      studentLevels.clear();
      (profData || []).forEach(p => {
        if (p.level && p.level.trim()) studentLevels.add(p.level.trim());
      });
    } else {
      // Demo mode
      basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics').sort((a, b) => a.sort_order - b.sort_order);
      allThresholds = DemoDB.getBasicsThresholds();
      DemoDB.getStudents().forEach(s => {
        if (s.level && s.level.trim()) studentLevels.add(s.level.trim());
      });
    }

    populateCategoryDropdown();
    populateLevelsDatalist();
    renderTargetsList();
  } catch (err) {
    console.error('Failed to load targets data:', err);
    if (container) {
      container.innerHTML = `
        <div class="banner banner-error" role="alert">
          Failed to load basics targets: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Populates the modal's category dropdown with basics categories only
 */
function populateCategoryDropdown() {
  const select = document.getElementById('target-category-select');
  if (!select) return;

  if (basicsCategories.length === 0) {
    select.innerHTML = '<option value="">No basics categories found</option>';
    return;
  }

  select.innerHTML = `
    <option value="">Select a basics category...</option>
    ${basicsCategories.map(c => `
      <option value="${c.id}">${escapeHtml(c.name)}</option>
    `).join('')}
  `;
}

/**
 * Populates the level datalist with levels from student profiles
 */
function populateLevelsDatalist() {
  const datalist = document.getElementById('levels-datalist');
  if (!datalist) return;

  const sortedLevels = Array.from(studentLevels).sort();
  datalist.innerHTML = sortedLevels.map(lvl => `
    <option value="${escapeHtml(lvl)}"></option>
  `).join('');
}

/**
 * Formats a target rule into human-readable text
 * e.g. "Accuracy at least 90%, at least 40 questions per minute in timed rounds, time at most 2:00 in fixed sets"
 * (showing whichever parts are configured).
 */
export function formatRuleDescription(rule) {
  const parts = [];
  if (rule && rule.min_accuracy !== null && rule.min_accuracy !== undefined) {
    parts.push(`Accuracy at least ${rule.min_accuracy}%`);
  }
  if (rule && rule.min_questions_per_minute !== null && rule.min_questions_per_minute !== undefined && Number(rule.min_questions_per_minute) > 0) {
    parts.push(`at least ${Number(rule.min_questions_per_minute)} questions per minute in timed rounds`);
  }
  if (rule && rule.max_time_seconds) {
    parts.push(`time at most ${formatSecondsToTime(rule.max_time_seconds)} in fixed sets`);
  }
  return parts.join(', ');
}

/**
 * Renders the list of basics categories and their rules
 */
function renderTargetsList() {
  const container = document.getElementById('targets-list-container');
  if (!container) return;

  if (basicsCategories.length === 0) {
    container.innerHTML = `
      <div class="card" style="padding: var(--space-8); text-align: center;">
        <div style="font-size: var(--text-base); font-weight: 600; color: var(--text-main); margin-bottom: var(--space-2);">
          No Basics Categories Found
        </div>
        <p style="font-size: var(--text-sm); color: var(--text-muted); margin-bottom: var(--space-4);">
          Create basics categories in Setup &rarr; Categories before defining targets.
        </p>
        <a href="/pages/categories.html" class="btn btn-outline btn-sm">Go to Categories</a>
      </div>
    `;
    return;
  }

  let html = '';

  basicsCategories.forEach(cat => {
    // Get all rules for this category
    const catRules = allThresholds.filter(t => t.category_id === cat.id);
    
    // Sort: default rule (level null) first, then alphabetically by level
    catRules.sort((a, b) => {
      if (!a.level && b.level) return -1;
      if (a.level && !b.level) return 1;
      return String(a.level || '').localeCompare(String(b.level || ''));
    });

    html += `
      <section class="card" style="margin-bottom: 0;" data-category-id="${cat.id}">
        <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h2 class="card-title" style="display: flex; align-items: center; gap: var(--space-2);">
              <span>${escapeHtml(cat.name)}</span>
              <span class="status-chip chip-unverified">Basics Track</span>
            </h2>
            <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
              ${catRules.length} ${catRules.length === 1 ? 'rule configured' : 'rules configured'}
            </div>
          </div>
          <button type="button" class="btn btn-outline btn-sm btn-add-cat-rule" data-cat-id="${cat.id}">
            + Add Rule
          </button>
        </div>

        <div class="card-body" style="padding: 0;">
    `;

    if (catRules.length === 0) {
      html += `
        <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-xs);">
          No target rules configured for <strong>${escapeHtml(cat.name)}</strong>.
          <br />
          Click <strong>+ Add Rule</strong> to set a default benchmark.
        </div>
      `;
    } else {
      html += `
        <table class="table" style="margin: 0;">
          <thead>
            <tr>
              <th style="width: 140px;">Scope / Level</th>
              <th>Target Benchmark</th>
              <th style="width: 100px; text-align: center;">Status</th>
              <th style="width: 160px; text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
      `;

      catRules.forEach(rule => {
        const isDefault = !rule.level || !rule.level.trim();
        const scopeBadge = isDefault
          ? `<span class="status-chip" style="background-color: var(--color-primary-subtle); color: var(--color-primary-text); font-weight: 700;">Default rule</span>`
          : `<span class="status-chip">Level: ${escapeHtml(rule.level)}</span>`;

        const ruleDesc = formatRuleDescription(rule);
        const isActive = rule.active !== false;

        const statusBadge = isActive
          ? `<span class="status-chip chip-verified">Active</span>`
          : `<span class="status-chip chip-unverified">Inactive</span>`;

        html += `
          <tr data-rule-id="${rule.id}">
            <td>${scopeBadge}</td>
            <td style="font-weight: 500;">
              ${escapeHtml(ruleDesc)}
            </td>
            <td style="text-align: center;">${statusBadge}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button type="button" class="btn btn-outline btn-sm btn-edit-rule" data-rule-id="${rule.id}" style="padding: 2px 8px; font-size: 11px;">
                Edit
              </button>
              <button type="button" class="btn btn-outline btn-sm btn-toggle-rule" data-rule-id="${rule.id}" style="padding: 2px 8px; font-size: 11px; margin-left: 4px;">
                ${isActive ? 'Deactivate' : 'Activate'}
              </button>
            </td>
          </tr>
        `;
      });

      html += `
          </tbody>
        </table>
      `;
    }

    html += `
        </div>
      </section>
    `;
  });

  container.innerHTML = html;

  attachListEventListeners();
}

/**
 * Attaches action handlers for list buttons (Add, Edit, Toggle Active)
 */
function attachListEventListeners() {
  // Add rule for specific category
  document.querySelectorAll('.btn-add-cat-rule').forEach(btn => {
    btn.onclick = () => {
      const catId = btn.getAttribute('data-cat-id');
      openTargetModal(null, catId);
    };
  });

  // Top header Add Target Rule button
  const topAddBtn = document.getElementById('btn-add-target');
  if (topAddBtn) {
    topAddBtn.onclick = () => openTargetModal(null);
  }

  // Edit rule
  document.querySelectorAll('.btn-edit-rule').forEach(btn => {
    btn.onclick = () => {
      const ruleId = btn.getAttribute('data-rule-id');
      const rule = allThresholds.find(t => t.id === ruleId);
      if (rule) openTargetModal(rule);
    };
  });

  // Toggle active
  document.querySelectorAll('.btn-toggle-rule').forEach(btn => {
    btn.onclick = async () => {
      const ruleId = btn.getAttribute('data-rule-id');
      const rule = allThresholds.find(t => t.id === ruleId);
      if (!rule) return;

      const newActive = !rule.active;
      btn.disabled = true;

      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('basics_thresholds')
            .update({ active: newActive })
            .eq('id', ruleId);

          if (error) throw error;
        } else {
          DemoDB.toggleBasicsThresholdActive(ruleId);
        }

        rule.active = newActive;
        showToast('success', `Rule marked as ${newActive ? 'Active' : 'Inactive'}.`);
        renderTargetsList();
      } catch (err) {
        console.error('Failed to toggle rule active state:', err);
        showToast('error', 'Failed to update rule: ' + err.message);
        btn.disabled = false;
      }
    };
  });
}

function updateTargetLiveSummary() {
  const summaryEl = document.getElementById('target-live-summary');
  if (!summaryEl) return;
  const catSelect = document.getElementById('target-category-select');
  const catName =
    basicsCategories.find((c) => c.id === catSelect?.value)?.name || 'Basics category';
  const levelVal = document.getElementById('target-level-input')?.value || '';
  const accVal = document.getElementById('target-accuracy-input')?.value ?? '';
  const qpmVal = document.getElementById('target-qpm-input')?.value || '';
  const timeVal = document.getElementById('target-time-input')?.value || '';
  const activeVal = Boolean(document.getElementById('target-active-input')?.checked);

  summaryEl.textContent = buildModalLiveSummary('target', {
    categoryName: catName,
    level: levelVal,
    min_accuracy: accVal,
    min_qpm: qpmVal,
    max_time: timeVal,
    active: activeVal,
  });
}

function clearTargetErrors() {
  const errBanner = document.getElementById('target-error-banner');
  if (errBanner) errBanner.style.display = 'none';
  ['error-target-category', 'error-target-accuracy', 'error-target-qpm', 'error-target-time'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

/**
 * Sets up the Target Modal form submission and controls
 */
function setupTargetModalHandlers() {
  const form = document.getElementById('target-form');
  if (!form) return;

  ['target-category-select', 'target-level-input', 'target-accuracy-input', 'target-qpm-input', 'target-time-input', 'target-active-input'].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener('input', updateTargetLiveSummary);
    el?.addEventListener('change', updateTargetLiveSummary);
  });

  const btnSaveAnother = document.getElementById('btn-save-add-another-target');
  if (btnSaveAnother) {
    btnSaveAnother.addEventListener('click', () => {
      submitAndAddAnotherTarget = true;
      form.requestSubmit();
    });
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btnSave = document.getElementById('btn-save-target');
    clearTargetErrors();

    const categoryId = document.getElementById('target-category-select').value;
    const levelRaw = document.getElementById('target-level-input').value.trim();
    const levelVal = levelRaw.length > 0 ? levelRaw : null;
    const accuracyRaw = document.getElementById('target-accuracy-input').value.trim();
    const accuracyVal = Number(accuracyRaw);
    const qpmRaw = (document.getElementById('target-qpm-input')?.value || '').trim();
    const timeRaw = document.getElementById('target-time-input').value.trim();
    const activeVal = document.getElementById('target-active-input').checked;

    // Browser validations
    if (!categoryId) {
      showModalError('Please select a basics category.', 'error-target-category');
      submitAndAddAnotherTarget = false;
      return;
    }

    if (accuracyRaw === '' || isNaN(accuracyVal) || accuracyVal < 0 || accuracyVal > 100) {
      showModalError('Minimum accuracy must be an integer between 0 and 100.', 'error-target-accuracy');
      submitAndAddAnotherTarget = false;
      return;
    }

    let qpmVal = null;
    if (qpmRaw.length > 0) {
      const parsedQpm = Number(qpmRaw);
      if (!Number.isFinite(parsedQpm) || parsedQpm <= 0 || parsedQpm > 500) {
        setMoreOptionsOpen(document.getElementById('target-more-options'), true);
        showModalError('Minimum questions per minute must be a positive number up to 500.', 'error-target-qpm');
        submitAndAddAnotherTarget = false;
        return;
      }
      qpmVal = Math.round(parsedQpm * 10) / 10;
    }

    let timeSecondsVal = null;
    if (timeRaw.length > 0) {
      timeSecondsVal = parseTimeToSeconds(timeRaw);
      if (timeSecondsVal === null || timeSecondsVal <= 0) {
        setMoreOptionsOpen(document.getElementById('target-more-options'), true);
        showModalError('Maximum time must be formatted as mm:ss (e.g. 2:00 or 1:30).', 'error-target-time');
        submitAndAddAnotherTarget = false;
        return;
      }
    }

    btnSave.disabled = true;

    try {
      if (editingTargetId) {
        // UPDATE existing rule
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('basics_thresholds')
            .update({
              category_id: categoryId,
              level: levelVal,
              min_accuracy: Math.round(accuracyVal),
              min_questions_per_minute: qpmVal,
              max_time_seconds: timeSecondsVal,
              active: activeVal
            })
            .eq('id', editingTargetId);

          if (error) throw error;
        } else {
          DemoDB.updateBasicsThreshold(editingTargetId, {
            category_id: categoryId,
            level: levelVal,
            min_accuracy: Math.round(accuracyVal),
            min_questions_per_minute: qpmVal,
            max_time_seconds: timeSecondsVal,
            active: activeVal
          });
        }
        showToast('success', 'Target rule updated successfully.');
      } else {
        // CREATE new rule
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('basics_thresholds')
            .insert({
              category_id: categoryId,
              level: levelVal,
              min_accuracy: Math.round(accuracyVal),
              min_questions_per_minute: qpmVal,
              max_time_seconds: timeSecondsVal,
              active: activeVal
            });

          if (error) throw error;
        } else {
          DemoDB.createBasicsThreshold({
            category_id: categoryId,
            level: levelVal,
            min_accuracy: Math.round(accuracyVal),
            min_questions_per_minute: qpmVal,
            max_time_seconds: timeSecondsVal,
            active: activeVal
          });
        }
        showToast('success', 'New target rule created.');
      }

      const addAnother = submitAndAddAnotherTarget && !editingTargetId;
      submitAndAddAnotherTarget = false;
      await loadTargetsData();
      if (addAnother) {
        openTargetModal(null, categoryId);
      } else {
        closeModal('target-modal');
      }
    } catch (err) {
      submitAndAddAnotherTarget = false;
      console.error('Failed to save target rule:', err);
      let friendlyMsg = err.message || 'Failed to save target rule.';
      if (friendlyMsg.includes('23505') || friendlyMsg.includes('already exists') || friendlyMsg.includes('unique constraint') || friendlyMsg.includes('idx_basics_thresholds')) {
        friendlyMsg = 'A target rule for this category and level already exists. Please edit the existing rule instead.';
      } else if (friendlyMsg.includes('check_basics_threshold_category')) {
        friendlyMsg = 'Only categories in the Basics section can have target rules.';
      }
      showModalError(friendlyMsg);
    } finally {
      btnSave.disabled = false;
    }
  };
}

/**
 * Displays an error inside the target modal banner and optional inline field
 */
function showModalError(msg, fieldErrorId = null) {
  if (fieldErrorId) {
    const fieldErr = document.getElementById(fieldErrorId);
    if (fieldErr) {
      fieldErr.textContent = msg;
      fieldErr.style.display = 'block';
    }
  }
  const errBanner = document.getElementById('target-error-banner');
  if (errBanner) {
    errBanner.textContent = msg;
    errBanner.style.display = 'block';
  } else {
    showToast('error', msg);
  }
}

/**
 * Opens the target modal for creating or editing
 */
function openTargetModal(rule = null, preselectedCatId = null) {
  const modalTitle = document.getElementById('target-modal-title');
  const idInput = document.getElementById('target-id-input');
  const catSelect = document.getElementById('target-category-select');
  const levelInput = document.getElementById('target-level-input');
  const accInput = document.getElementById('target-accuracy-input');
  const qpmInput = document.getElementById('target-qpm-input');
  const timeInput = document.getElementById('target-time-input');
  const activeInput = document.getElementById('target-active-input');
  const btnSaveAnother = document.getElementById('btn-save-add-another-target');
  const moreDetails = document.getElementById('target-more-options');

  clearTargetErrors();

  if (rule) {
    editingTargetId = rule.id;
    if (modalTitle) modalTitle.textContent = 'Edit Target Rule';
    if (idInput) idInput.value = rule.id;
    if (catSelect) catSelect.value = rule.category_id;
    if (levelInput) levelInput.value = rule.level || '';
    if (accInput) accInput.value = rule.min_accuracy;
    if (qpmInput) qpmInput.value = rule.min_questions_per_minute !== null && rule.min_questions_per_minute !== undefined ? String(rule.min_questions_per_minute) : '';
    if (timeInput) timeInput.value = rule.max_time_seconds ? formatSecondsToTime(rule.max_time_seconds) : '';
    if (activeInput) activeInput.checked = rule.active !== false;
    if (btnSaveAnother) btnSaveAnother.style.display = 'none';
    setMoreOptionsOpen(
      moreDetails,
      shouldOpenMoreOptions(
        [
          rule.level,
          rule.min_questions_per_minute,
          rule.max_time_seconds,
          rule.active === false ? 'inactive' : '',
        ],
        true
      )
    );
  } else {
    editingTargetId = null;
    if (modalTitle) modalTitle.textContent = 'Add Target Rule';
    if (idInput) idInput.value = '';
    if (catSelect) catSelect.value = preselectedCatId || (basicsCategories[0]?.id || '');
    if (levelInput) levelInput.value = '';
    if (accInput) accInput.value = '90';
    if (qpmInput) qpmInput.value = '';
    if (timeInput) timeInput.value = '';
    if (activeInput) activeInput.checked = true;
    if (btnSaveAnother) btnSaveAnother.style.display = 'inline-flex';
    setMoreOptionsOpen(moreDetails, false);
  }

  updateTargetLiveSummary();
  openModal('target-modal');
}

/**
 * Renders user details in the top navigation bar
 */
function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');

  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'ADMIN';
  if (container) container.style.display = 'flex';
}

/**
 * Renders the visible demo mode warning banner
 */
function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-warning" style="margin-bottom: var(--space-6);" role="alert">
      <strong>Demo Mode Active:</strong> You are exploring with mock data on localhost/preview. Supabase credentials are not configured.
    </div>
  `;
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

document.addEventListener('DOMContentLoaded', initTargetsPage);
