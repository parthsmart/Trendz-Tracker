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
import { showToast } from './toast.js';

let currentProfile = null;
let basicsCategories = [];
let allBasicsResults = [];
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
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('section', 'basics')
        .eq('active', true)
        .order('sort_order', { ascending: true });

      if (error) throw new Error(error.message);
      basicsCategories = data || [];
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
  } catch (err) {
    console.error('Error loading basics categories:', err);
    showToast('error', 'Failed to load categories: ' + err.message);
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

      const { data, error } = await supabase
        .from('results')
        .select(`
          id,
          student_id,
          category_id,
          correct,
          total,
          time_seconds,
          note,
          entry_date,
          verified,
          created_at,
          categories (
            name,
            sort_order
          )
        `)
        .eq('student_id', currentProfile.id)
        .in('category_id', categoryIds)
        .order('entry_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);
      allBasicsResults = data || [];
    } else {
      // Demo Mode retrieval
      const demoKey = `trendz_demo_basics_${currentProfile.id}`;
      allBasicsResults = JSON.parse(localStorage.getItem(demoKey) || '[]');
    }

    renderHistory();
  } catch (err) {
    console.error('Error loading basics history:', err);
    showToast('error', 'Failed to load basics history: ' + err.message);
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
        No earlier sessions in the past 7 days.
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
  const isVerified = drill.verified === true;

  return `
    <div class="category-item" style="margin-bottom: 0; border-radius: 0; border-bottom: 1px solid var(--border-hairline);" data-drill-id="${drill.id}">
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
            ⏱️ ${timeFormatted}
          </span>
        ` : ''}
        ${isVerified ? `
          <span class="verified-lock-indicator" title="Verified by teacher">
            🔒 Verified
          </span>
        ` : ''}
      </div>

      <div class="category-actions">
        ${!isVerified ? `
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
          round_number: null, // basics are not assigned to a round
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

  // Initial load
  await loadBasicsCategories();
  await loadBasicsHistory();
}

document.addEventListener('DOMContentLoaded', initBasics);
