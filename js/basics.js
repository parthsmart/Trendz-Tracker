/**
 * Trendz Tracker - Student Basics Speed Drills Module
 * Handles recording mental calculation drills (digits and rows),
 * 7-day backdating management, date-grouped history, and non-overriding updates.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { getScoreFeedback } from './scoreColors.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS, parseTimeToSeconds } from './timeUtils.js';
import { formatSecondsToTime } from './stats.js';
import { isBasicsOnlineAvailable } from './practiceStats.js';
import { showToast } from './toast.js';

let currentProfile = null;
let basicsCategories = [];
let allBasicsResults = [];
let activeThresholds = [];
let editingDrillId = null;

/**
 * Format date into "3 Oct 2026"
 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Configure min/max on custom date input (up to 7 days back)
 */
function setupDateLimits() {
  const customDateInput = document.getElementById('basics-custom-date');
  if (!customDateInput) return;

  const now = new Date();
  const past7 = new Date();
  past7.setDate(now.getDate() - 7);

  customDateInput.max = now.toISOString().split('T')[0];
  customDateInput.min = past7.toISOString().split('T')[0];
  customDateInput.value = customDateInput.max;
}

/**
 * Load active basics categories
 */
async function loadBasicsCategories() {
  const selectEl = document.getElementById('basics-category-select');
  selectEl.innerHTML = '<option value="">Loading categories...</option>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('categories')
          .select('id, name, section, sort_order, active')
          .eq('section', 'basics')
          .eq('active', true)
          .order('sort_order', { ascending: true });

        if (!error && Array.isArray(data) && data.length > 0) {
          basicsCategories = data;
        } else {
          if (error) console.warn('Could not load categories from Supabase, using defaults:', error.message);
          basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
        }
      } else {
        basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
      }
    } else {
      basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
    }

    if (basicsCategories.length === 0) {
      selectEl.innerHTML = '<option value="">No basics categories found</option>';
      return;
    }

    selectEl.innerHTML = basicsCategories.map(c => `
      <option value="${c.id}">${escapeHtml(c.name)}</option>
    `).join('');

    // Preselect category if passed in URL query parameter (e.g. from Today's To-Do link)
    const urlParams = new URLSearchParams(window.location.search);
    const catParam = urlParams.get('cat') || urlParams.get('category') || urlParams.get('category_id');
    if (catParam && selectEl.querySelector(`option[value="${catParam}"]`)) {
      selectEl.value = catParam;
    }

    renderOnlinePracticeButtons();
    updateCategoryTargetDisplay(selectEl.value);
  } catch (err) {
    console.warn('Error in loadBasicsCategories, falling back to local categories:', err);
    basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
    if (basicsCategories.length > 0) {
      selectEl.innerHTML = basicsCategories.map(c => `
        <option value="${c.id}">${escapeHtml(c.name)}</option>
      `).join('');

      const urlParams = new URLSearchParams(window.location.search);
      const catParam = urlParams.get('cat') || urlParams.get('category') || urlParams.get('category_id');
      if (catParam && selectEl.querySelector(`option[value="${catParam}"]`)) {
        selectEl.value = catParam;
      }
      renderOnlinePracticeButtons();
      updateCategoryTargetDisplay(selectEl.value);
    } else {
      showToast('error', 'Failed to load categories: ' + (err.message || 'Network error'));
    }
  }

  // Update target badge when student changes chosen category
  selectEl.addEventListener('change', () => {
    updateCategoryTargetDisplay(selectEl.value);
  });
}

/**
 * Renders a "Practice online" button for each basics category that is available online
 */
function renderOnlinePracticeButtons() {
  const cardEl = document.getElementById('online-practice-categories-card');
  const listEl = document.getElementById('online-practice-buttons-list');
  if (!cardEl || !listEl) return;

  const onlineCats = basicsCategories.filter(c => isBasicsOnlineAvailable(c));
  if (onlineCats.length === 0) {
    cardEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = onlineCats.map(c => `
    <a
      href="/pages/basics-practice.html?cat=${encodeURIComponent(c.id)}"
      class="btn btn-primary btn-sm"
      style="text-decoration: none;"
    >
      ${escapeHtml(c.name)} &middot; Practice online
    </a>
  `).join('');
  cardEl.style.display = 'block';
}

/**
 * Loads active target thresholds from database or demoDb
 */
async function loadActiveThresholds() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('basics_thresholds')
        .select('id, category_id, level, min_accuracy, max_time_seconds, min_questions_per_minute, active')
        .eq('active', true);

      if (!error && data) {
        activeThresholds = data;
      }
    } else {
      activeThresholds = DemoDB.getBasicsThresholds().filter(t => t.active !== false);
    }
  } catch (err) {
    console.warn('Could not load basics thresholds:', err);
  }
}

/**
 * Shows the student's target (level rule if one exists, else the default)
 * e.g. "Target: 90% accuracy in 2:00 or less"
 */
function updateCategoryTargetDisplay(categoryId) {
  const container = document.getElementById('category-target-display');
  const textEl = document.getElementById('category-target-text');
  const onlineBtn = document.getElementById('btn-selected-practice-online');

  const selectedCat = basicsCategories.find(c => c.id === categoryId);
  if (onlineBtn) {
    if (selectedCat && isBasicsOnlineAvailable(selectedCat)) {
      onlineBtn.href = `/pages/basics-practice.html?cat=${encodeURIComponent(selectedCat.id)}`;
      onlineBtn.textContent = `Practice ${selectedCat.name} online →`;
      onlineBtn.style.display = 'inline-flex';
    } else {
      onlineBtn.style.display = 'none';
    }
  }

  if (!container || !textEl) return;

  if (!categoryId) {
    container.style.display = 'none';
    return;
  }

  const studentLevel = (currentProfile?.level || '').trim().toLowerCase();

  // 1. Level-specific rule beats default rule
  let rule = null;
  if (studentLevel) {
    rule = activeThresholds.find(t => t.category_id === categoryId && t.level && t.level.trim().toLowerCase() === studentLevel);
  }
  // 2. Fall back to default rule
  if (!rule) {
    rule = activeThresholds.find(t => t.category_id === categoryId && (!t.level || !t.level.trim()));
  }

  if (rule) {
    const parts = [`${rule.min_accuracy}% accuracy`];
    if (rule.min_questions_per_minute && Number(rule.min_questions_per_minute) > 0) {
      parts.push(`at least ${Number(rule.min_questions_per_minute)} questions per minute in timed rounds`);
    }
    if (rule.max_time_seconds) {
      parts.push(`in ${formatSecondsToTime(rule.max_time_seconds)} or less for typed entries`);
    }
    textEl.textContent = `Target: ${parts.join(', ')}`;
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
  }
}

/**
 * Load all basics results for this student
 */
async function loadBasicsHistory() {
  const todayContainer = document.getElementById('today-drills-container');
  const pastContainer = document.getElementById('past-drills-container');
  const todayBadge = document.getElementById('today-count-badge');

  todayContainer.innerHTML = '<div class="skeleton-row"></div>';
  pastContainer.innerHTML = '<div class="skeleton-row"></div>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const categoryIds = basicsCategories.map(c => c.id);

      if (categoryIds.length === 0) {
        todayContainer.innerHTML = '<p style="font-size: var(--text-sm); color: var(--text-dim);">No categories found.</p>';
        pastContainer.innerHTML = '';
        return;
      }

      if (supabase) {
        // Read entries from results_with_target view for authoritative meets_target calculation
        const { data, error } = await supabase
          .from('results_with_target')
          .select(`
            id,
            student_id,
            category_id,
            correct,
            total,
            time_seconds,
            note,
            entry_date,
            source,
            practice_mode,
            verified,
            verified_at,
            verified_by,
            corrected_at,
            corrected_by,
            flagged,
            flag_note,
            created_at,
            min_accuracy,
            min_questions_per_minute,
            max_time_seconds,
            meets_target,
            categories (
              name,
              sort_order
            )
          `)
          .eq('student_id', currentProfile.id)
          .in('category_id', categoryIds)
          .order('entry_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(200);

        if (error) {
          console.warn('Could not fetch basics results_with_target from Supabase:', error.message);
          allBasicsResults = [];
        } else {
          allBasicsResults = data || [];
        }
      } else {
        allBasicsResults = [];
      }
    } else {
      // Demo Mode retrieval with pre-computed meets_target
      const demoDbResults = DemoDB.getResultsWithTarget(currentProfile.id, 'basics');
      const demoKey = `trendz_demo_basics_${currentProfile.id}`;
      const localAdded = JSON.parse(localStorage.getItem(demoKey) || '[]');
      // Merge local additions with targets
      allBasicsResults = [...localAdded, ...demoDbResults.filter(d => !localAdded.some(l => l.id === d.id))];
    }

    renderHistory();
  } catch (err) {
    console.warn('Error loading basics history:', err);
    allBasicsResults = isSupabaseConfigured()
      ? []
      : DemoDB.getResultsWithTarget(currentProfile?.id || 'default', 'basics');
    renderHistory();
  }
}

/**
 * Render history split into Today's sessions and Past 7 days grouped by date
 */
function renderHistory() {
  const todayContainer = document.getElementById('today-drills-container');
  const pastContainer = document.getElementById('past-drills-container');
  const todayBadge = document.getElementById('today-count-badge');

  if (allBasicsResults.length === 0) {
    todayContainer.innerHTML = `
      <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
        No basics speed drills logged yet. Record your first drill above!
      </div>
    `;
    pastContainer.innerHTML = '';
    todayBadge.textContent = '(0)';
    return;
  }

  // Determine latest date in the dataset to act as "today" or use standard ISO comparison
  const latestDate = allBasicsResults[0]?.entry_date;

  const todayItems = allBasicsResults.filter(r => r.entry_date === latestDate);
  const pastItems = allBasicsResults.filter(r => r.entry_date !== latestDate);

  todayBadge.textContent = `(${todayItems.length})`;

  // Render Today's items
  if (todayItems.length === 0) {
    todayContainer.innerHTML = `
      <div class="card" style="padding: var(--space-4); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
        No speed drills logged yet for today.
      </div>
    `;
  } else {
    todayContainer.innerHTML = `
      <div class="card">
        ${todayItems.map(item => renderDrillRow(item)).join('')}
      </div>
    `;
  }

  // Render Past 7 days grouped by date
  if (pastItems.length === 0) {
    pastContainer.innerHTML = `
      <div class="card" style="padding: var(--space-4); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
        No earlier entries in the past 7 days.
      </div>
    `;
  } else {
    // Group by entry_date
    const grouped = new Map();
    pastItems.forEach(item => {
      const dateKey = item.entry_date;
      if (!grouped.has(dateKey)) grouped.set(dateKey, []);
      grouped.get(dateKey).push(item);
    });

    let pastHtml = '';
    grouped.forEach((items, dateKey) => {
      pastHtml += `
        <div class="card" style="margin-bottom: var(--space-4);">
          <div class="card-header" style="padding: var(--space-3) var(--space-5); background-color: var(--bg-surface-subtle);">
            <span style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
              📅 ${formatDateDisplay(dateKey)}
            </span>
            <span class="num" style="font-size: var(--text-xs); color: var(--text-dim);">
              ${items.length} ${items.length === 1 ? 'drill' : 'drills'}
            </span>
          </div>
          <div>
            ${items.map(item => renderDrillRow(item)).join('')}
          </div>
        </div>
      `;
    });
    pastContainer.innerHTML = pastHtml;
  }

  attachDrillActionListeners();
}

/**
 * Render single drill list row
 */
function renderDrillRow(drill) {
  const catName = drill.categories?.name || basicsCategories.find(c => c.id === drill.category_id)?.name || 'Basics';
  const feedback = getScoreFeedback(drill.correct, drill.total);
  const timeFormatted = formatSecondsToMMSS(drill.time_seconds);
  const isSite = drill.source === 'site';
  const practiceMode = drill.practice_mode === 'timed' ? 'Timed' : (drill.practice_mode === 'unlimited' ? 'Unlimited' : null);
  const attemptedPerMinute = practiceMode && Number(drill.total) > 0 && Number(drill.time_seconds) > 0
    ? (Math.round((Number(drill.total) / (Number(drill.time_seconds) / 60)) * 10) / 10).toFixed(1)
    : null;
  const isVerified = drill.verified === true || !!drill.verified_at || !!drill.verified_by;
  const isCorrected = !!drill.corrected_at || !!drill.corrected_by;
  const isFlagged = drill.flagged === true;
  const flagNote = drill.flag_note || '';
  const isLocked = isSite || isVerified || isCorrected;

  return `
    <div class="category-item ${isLocked ? 'row-verified' : ''}" style="margin-bottom: 0; border-radius: 0; border-bottom: 1px solid var(--border-hairline);" data-drill-id="${drill.id}">
      <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
        <span style="font-weight: 700; font-size: var(--text-sm); min-width: 70px;">
          ${escapeHtml(catName)}
        </span>
        <span class="num" style="font-size: var(--text-sm); font-weight: 600;">
          ${drill.correct} / ${drill.total}
        </span>
        <span class="score-tag ${feedback.badgeClass}">
          ${feedback.wrongText}
        </span>
        ${timeFormatted ? `
          <span class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
            ⏱️ ${timeFormatted}${attemptedPerMinute ? ` · ${attemptedPerMinute} / min` : ''}
          </span>
        ` : ''}
        ${drill.meets_target === true ? `
          <span class="status-chip chip-verified" title="Meets target benchmark">
            🎯 Target met
          </span>
        ` : drill.meets_target === false ? `
          <span class="status-chip" style="background-color: rgba(239, 68, 68, 0.12); color: #B91C1C; border: 1px solid rgba(239, 68, 68, 0.3);" title="Below target benchmark">
            ⚠️ Below target
          </span>
        ` : ''}
        ${isSite ? `
          <span class="status-chip chip-verified" title="Completed online and recorded by the site (locked)">
            Recorded by the site
          </span>
          ${practiceMode ? `<span class="status-chip chip-unverified">${practiceMode}</span>` : ''}
        ` : `
          <span class="status-chip chip-unverified" title="Manually typed score entry">
            Typed
          </span>
          ${practiceMode ? `<span class="status-chip chip-unverified">${practiceMode}</span>` : ''}
          ${isVerified ? `
            <span class="verified-lock-indicator" title="Verified by teacher (locked)">
              🔒 Verified
            </span>
          ` : ''}
        `}
        ${isCorrected ? `
          <span class="status-chip chip-corrected" title="Corrected by teacher (locked)">
            ✏️ Corrected by teacher
          </span>
        ` : ''}
        ${isFlagged ? `
          <div class="status-chip chip-flagged" style="display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left; font-size: 11px; max-width: 260px; white-space: normal; line-height: 1.25; padding: 4px 6px;">
            <span style="font-weight: 600;">⚠️ Your teacher asked you to check this entry</span>
            ${flagNote ? `<span style="font-size: 10px; color: #78350F; margin-top: 2px;">Note: ${escapeHtml(flagNote)}</span>` : ''}
          </div>
        ` : ''}
      </div>

      <div class="category-actions">
        ${!isLocked ? `
          <button
            type="button"
            class="btn btn-outline btn-sm btn-edit-drill"
            data-id="${drill.id}"
            title="Edit drill"
          >
            Edit
          </button>
          <button
            type="button"
            class="btn btn-outline btn-sm btn-delete-drill"
            data-id="${drill.id}"
            title="Delete drill"
          >
            Delete
          </button>
        ` : `
          <span style="font-size: 11px; color: var(--text-dim); padding-right: var(--space-2);">
            Locked
          </span>
        `}
      </div>
    </div>
  `;
}

/**
 * Attach click handlers for edit and delete buttons
 */
function attachDrillActionListeners() {
  document.querySelectorAll('.btn-edit-drill').forEach(btn => {
    btn.addEventListener('click', () => {
      const drillId = btn.getAttribute('data-id');
      const drill = allBasicsResults.find(r => r.id === drillId);
      if (!drill) return;

      if (drill.verified === true || !!drill.verified_at || !!drill.corrected_at) {
        showToast('error', 'This drill is locked and cannot be edited.');
        return;
      }

      editingDrillId = drill.id;
      document.getElementById('edit-drill-id').value = drill.id;
      document.getElementById('basics-category-select').value = drill.category_id;
      document.getElementById('basics-correct').value = drill.correct;
      document.getElementById('basics-total').value = drill.total;
      document.getElementById('basics-time').value = formatSecondsToMMSS(drill.time_seconds);

      // Hide date picker on edit as entry_date must never be changed on update
      document.getElementById('date-selection-group').style.display = 'none';

      document.getElementById('form-card-title').textContent = 'Edit Basics Drill';
      document.getElementById('btn-submit-drill-text').textContent = 'Update Drill';
      document.getElementById('btn-cancel-edit').style.display = 'inline-flex';

      updateLiveFeedback();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('.btn-delete-drill').forEach(btn => {
    btn.addEventListener('click', async () => {
      const drillId = btn.getAttribute('data-id');
      const drill = allBasicsResults.find(r => r.id === drillId);
      if (drill && (drill.verified === true || !!drill.verified_at || !!drill.corrected_at)) {
        showToast('error', 'This drill is locked and cannot be deleted.');
        return;
      }

      if (!confirm('Are you sure you want to delete this drill entry?')) return;

      btn.disabled = true;
      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .delete()
            .eq('id', drillId)
            .eq('student_id', currentProfile.id);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          allBasicsResults = allBasicsResults.filter(r => r.id !== drillId);
          localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
        }

        showToast('success', 'Drill entry deleted.');
        await loadBasicsHistory();
      } catch (err) {
        showToast('error', 'Failed to delete drill: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function cancelEditMode() {
  editingDrillId = null;
  document.getElementById('basics-form').reset();
  document.getElementById('edit-drill-id').value = '';
  document.getElementById('date-selection-group').style.display = 'flex';
  document.getElementById('form-card-title').textContent = 'Record a Basics Drill';
  document.getElementById('btn-submit-drill-text').textContent = 'Save Drill Entry';
  document.getElementById('btn-cancel-edit').style.display = 'none';
  document.getElementById('basics-live-feedback').textContent = '—';
  document.getElementById('basics-live-feedback').className = 'score-tag score-tag-neutral';
}

function updateLiveFeedback() {
  const correct = document.getElementById('basics-correct').value.trim();
  const total = document.getElementById('basics-total').value.trim();
  const feedbackEl = document.getElementById('basics-live-feedback');

  const feedback = getScoreFeedback(correct, total);
  feedbackEl.textContent = feedback.wrongText;
  feedbackEl.className = `score-tag ${feedback.badgeClass}`;
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
 * Initialize Basics Page
 */
async function initBasics() {
  currentProfile = await requireAuth(['student', 'admin']);
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupDateLimits();

  // Date preset toggle
  const datePreset = document.getElementById('basics-date-preset');
  const customDateContainer = document.getElementById('custom-date-container');

  datePreset?.addEventListener('change', () => {
    if (datePreset.value === 'custom') {
      customDateContainer.style.display = 'block';
    } else {
      customDateContainer.style.display = 'none';
    }
  });

  // Cancel edit handler
  document.getElementById('btn-cancel-edit')?.addEventListener('click', cancelEditMode);

  // Live score feedback listeners
  document.getElementById('basics-correct')?.addEventListener('input', updateLiveFeedback);
  document.getElementById('basics-total')?.addEventListener('input', updateLiveFeedback);

  // Time format on blur
  const timeInput = document.getElementById('basics-time');
  timeInput?.addEventListener('blur', () => {
    const raw = timeInput.value.trim();
    if (!raw) return;
    const sec = parseTimeToSeconds(raw);
    if (sec !== null) {
      timeInput.value = formatSecondsToMMSS(sec);
    }
  });

  // Form submit
  document.getElementById('basics-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('basics-form-error');
    const submitBtn = document.getElementById('btn-submit-drill');
    const btnText = document.getElementById('btn-submit-drill-text');

    errorEl.style.display = 'none';

    const category_id = document.getElementById('basics-category-select').value;
    const correctRaw = document.getElementById('basics-correct').value.trim();
    const totalRaw = document.getElementById('basics-total').value.trim();
    const timeRaw = document.getElementById('basics-time').value.trim();

    if (!category_id) {
      errorEl.textContent = 'Please choose a category.';
      errorEl.style.display = 'block';
      return;
    }

    const correct = parseInt(correctRaw, 10);
    const total = parseInt(totalRaw, 10);
    const time_seconds = timeRaw ? parseTimeToSeconds(timeRaw) : null;

    if (isNaN(correct) || correct < 0) {
      errorEl.textContent = 'Correct answers must be a non-negative number.';
      errorEl.style.display = 'block';
      return;
    }
    if (isNaN(total) || total <= 0) {
      errorEl.textContent = 'Total attempted must be greater than zero.';
      errorEl.style.display = 'block';
      return;
    }
    if (correct > total) {
      errorEl.textContent = 'Correct answers cannot be more than the total.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      if (editingDrillId) {
        // UPDATE: Never send entry_date when updating an existing row
        const updatePayload = {
          category_id,
          correct,
          total,
          time_seconds
        };

        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .update(updatePayload)
            .eq('id', editingDrillId)
            .eq('student_id', currentProfile.id);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          const idx = allBasicsResults.findIndex(r => r.id === editingDrillId);
          if (idx !== -1) {
            allBasicsResults[idx] = { ...allBasicsResults[idx], ...updatePayload };
            localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
          }
        }

        showToast('success', 'Basics drill updated successfully.');
        cancelEditMode();
      } else {
        // INSERT:
        // CRITICAL DATABASE RULE: When today is chosen, do NOT send entry_date so
        // default today_ist() is applied! Only send entry_date if custom earlier day chosen.
        const insertPayload = {
          student_id: currentProfile.id,
          category_id,
          correct,
          total,
          time_seconds,
          verified: false
        };

        if (datePreset.value === 'custom') {
          const pickedDate = document.getElementById('basics-custom-date').value;
          if (pickedDate) {
            insertPayload.entry_date = pickedDate;
          }
        }

        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .insert([insertPayload]);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          const newEntry = {
            id: `bas-${Date.now()}`,
            ...insertPayload,
            entry_date: insertPayload.entry_date || new Date().toISOString().split('T')[0],
            created_at: new Date().toISOString()
          };
          allBasicsResults.unshift(newEntry);
          localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
        }

        showToast('success', 'Basics speed drill recorded!');
        document.getElementById('basics-correct').value = '';
        document.getElementById('basics-total').value = '';
        document.getElementById('basics-time').value = '';
        document.getElementById('basics-live-feedback').textContent = '—';
        document.getElementById('basics-live-feedback').className = 'score-tag score-tag-neutral';
      }

      await loadBasicsHistory();
    } catch (err) {
      console.error('Save error:', err);
      // Show message from any database error in a friendly toast
      showToast('error', err.message || 'Failed to save drill.');
      errorEl.textContent = err.message || 'Failed to save drill.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = editingDrillId ? 'Update Drill' : 'Save Drill Entry';
    }
  });

  // Initial load: fetch categories and thresholds in parallel
  await Promise.all([loadBasicsCategories(), loadActiveThresholds()]);
  updateCategoryTargetDisplay(document.getElementById('basics-category-select')?.value);
  await loadBasicsHistory();
}

document.addEventListener('DOMContentLoaded', initBasics);
