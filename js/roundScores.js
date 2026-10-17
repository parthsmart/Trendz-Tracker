/**
 * Trendz Tracker - Student Round Scores Module
 * Handles loading rounds, 24 championship categories, score calculation,
 * verified protection, and non-upsert batch persistence.
 */

import { isSupabaseConfigured } from './config.js';
import { requireAuth } from './guard.js';
import { getScoreFeedback } from './scoreColors.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS, parseTimeToSeconds, setupEnterKeyNavigation } from './timeUtils.js';
import { showToast } from './toast.js';

let currentProfile = null;
let activeRounds = [];
let roundCategories = [];
let selectedRoundNumber = null;
let existingResultsMap = new Map(); // category_id -> result object
let initialRowValues = new Map(); // category_id -> JSON string of initial values to detect dirty rows

/**
 * Format a date string (e.g. "2026-10-03") into "3 Oct 2026"
 */
function formatRoundDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Load list of rounds
 */
async function loadRounds() {
  const selectEl = document.getElementById('select-round');
  selectEl.innerHTML = '<option value="">Loading rounds...</option>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      // Fetch rounds ordered by round_number descending
      const { data, error } = await supabase
        .from('rounds')
        .select('*')
        .order('round_number', { ascending: false });

      if (error) throw new Error(error.message);
      activeRounds = data || [];
    } else {
      // Demo Mode rounds
      activeRounds = [
        { round_number: 244, round_date: '2026-10-03', round_type: 'Category wise' },
        { round_number: 243, round_date: '2026-10-02', round_type: 'Category wise' },
        { round_number: 242, round_date: '2026-10-01', round_type: 'Category wise' },
      ];
    }

    if (activeRounds.length === 0) {
      selectEl.innerHTML = '<option value="">No rounds available</option>';
      document.getElementById('score-rows-container').innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <h3 class="empty-state-title">No rounds available yet</h3>
          <p class="empty-state-desc">Your teacher has not created any competition rounds. Please check back later.</p>
        </div>
      `;
      return;
    }

    selectEl.innerHTML = activeRounds.map(r => `
      <option value="${r.round_number}">
        Round ${r.round_number} - ${formatRoundDate(r.round_date)}
      </option>
    `).join('');

    // Default to newest round (first in array)
    selectedRoundNumber = activeRounds[0].round_number;
    selectEl.value = selectedRoundNumber;

    // Load categories and round data
    await loadCategories();
    await loadRoundResults();
  } catch (err) {
    console.error('Error loading rounds:', err);
    showToast('error', 'Failed to load rounds: ' + err.message);
  }
}

/**
 * Load active round categories in sort order
 */
async function loadCategories() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('section', 'round')
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error) throw new Error(error.message);
    roundCategories = data || [];
  } else {
    roundCategories = DemoDB.getCategories()
      .filter(c => c.section === 'round' && c.active)
      .sort((a, b) => a.sort_order - b.sort_order);
  }
}

/**
 * Load student's existing scores for the selected round
 */
async function loadRoundResults() {
  const container = document.getElementById('score-rows-container');
  container.innerHTML = '<div style="padding: var(--space-4);"><div class="skeleton-row"></div><div class="skeleton-row"></div></div>';

  existingResultsMap.clear();
  initialRowValues.clear();

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('results')
        .select('*')
        .eq('student_id', currentProfile.id)
        .eq('round_number', selectedRoundNumber);

      if (error) throw new Error(error.message);

      (data || []).forEach(res => {
        existingResultsMap.set(res.category_id, res);
      });
    } else {
      // In Demo Mode, retrieve from localStorage
      const demoKey = `trendz_demo_results_${currentProfile.id}_r${selectedRoundNumber}`;
      const saved = JSON.parse(localStorage.getItem(demoKey) || '[]');
      saved.forEach(res => existingResultsMap.set(res.category_id, res));
    }

    renderCategoryRows();
    updateProgressDisplay();
  } catch (err) {
    console.error('Error loading round results:', err);
    showToast('error', 'Failed to load round scores: ' + err.message);
  }
}

/**
 * Render all 24 categories with prefilled data, verified locks, and live evaluation
 */
function renderCategoryRows() {
  const container = document.getElementById('score-rows-container');

  if (roundCategories.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3 class="empty-state-title">No round categories found</h3>
      </div>
    `;
    return;
  }

  let html = '';

  roundCategories.forEach(cat => {
    const existing = existingResultsMap.get(cat.id);
    const isVerified = existing && existing.verified === true;
    const isSurpriseTask = cat.name.toLowerCase().includes('surprise');

    const correctVal = existing && existing.correct !== null ? existing.correct : '';
    const totalVal = existing && existing.total !== null ? existing.total : '';
    const timeVal = existing && existing.time_seconds !== null ? formatSecondsToMMSS(existing.time_seconds) : '';
    const noteVal = existing && existing.note ? existing.note : '';

    // Cache initial state to detect changes during save
    initialRowValues.set(cat.id, JSON.stringify({
      correct: correctVal,
      total: totalVal,
      time: timeVal,
      note: noteVal,
      existingId: existing ? existing.id : null,
      isVerified
    }));

    // Feedback
    let feedback = { wrongText: '—', badgeClass: 'score-tag-neutral' };
    if (correctVal !== '' || totalVal !== '') {
      feedback = getScoreFeedback(correctVal, totalVal);
    }

    html += `
      <div class="score-entry-row ${isVerified ? 'row-verified' : ''}" data-category-id="${cat.id}">
        <!-- Category Name -->
        <div class="cell-category">
          <div style="font-weight: 700; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(cat.name)}
          </div>
          <span class="num" style="font-size: 11px; color: var(--text-dim);">#${cat.sort_order}</span>
        </div>

        <!-- Correct Input -->
        <div>
          <input
            type="text"
            inputmode="numeric"
            class="form-input score-input input-correct"
            placeholder="0"
            value="${correctVal}"
            ${isVerified ? 'readonly disabled' : ''}
            data-cat-id="${cat.id}"
            aria-label="${escapeHtml(cat.name)} correct answers"
          />
        </div>

        <!-- Total Input -->
        <div>
          <input
            type="text"
            inputmode="numeric"
            class="form-input score-input input-total"
            placeholder="0"
            value="${totalVal}"
            ${isVerified ? 'readonly disabled' : ''}
            data-cat-id="${cat.id}"
            aria-label="${escapeHtml(cat.name)} total attempted"
          />
        </div>

        <!-- Time Input (mm:ss or seconds) -->
        <div>
          <input
            type="text"
            inputmode="numeric"
            class="form-input score-input input-time"
            placeholder="0:00"
            value="${timeVal}"
            ${isVerified ? 'readonly disabled' : ''}
            data-cat-id="${cat.id}"
            aria-label="${escapeHtml(cat.name)} time elapsed"
          />
        </div>

        <!-- Accuracy & Wrong Count Feedback -->
        <div class="cell-feedback" style="display: flex; align-items: center;">
          <span class="score-tag ${feedback.badgeClass} feedback-badge" data-cat-id="${cat.id}">
            ${feedback.wrongText}
          </span>
        </div>

        <!-- Status Column (Saved / Verified by teacher) -->
        <div style="text-align: right;">
          ${isVerified ? `
            <span class="verified-lock-indicator" title="Verified by teacher (locked)">
              🔒 Verified
            </span>
          ` : existing ? `
            <span class="status-indicator active" style="font-size: 11px;" title="Saved in database">
              Saved
            </span>
          ` : `
            <span class="status-indicator inactive" style="font-size: 11px;">
              Unsaved
            </span>
          `}
        </div>

        ${isSurpriseTask ? `
          <div style="grid-column: 1 / -1; margin-top: 4px;">
            <input
              type="text"
              class="form-input input-note"
              placeholder="Surprise Task notes or topic description..."
              value="${escapeHtml(noteVal)}"
              ${isVerified ? 'readonly disabled' : ''}
              data-cat-id="${cat.id}"
              style="min-height: 36px; font-size: var(--text-xs);"
            />
          </div>
        ` : ''}
      </div>
    `;
  });

  container.innerHTML = html;

  attachLiveInputListeners();
  setupEnterKeyNavigation(container);
}

/**
 * Attach input listeners for live score calculations and time formatting
 */
function attachLiveInputListeners() {
  const container = document.getElementById('score-rows-container');

  // Live feedback on typing correct/total
  container.querySelectorAll('.input-correct, .input-total').forEach(input => {
    input.addEventListener('input', () => {
      const catId = input.getAttribute('data-cat-id');
      const row = container.querySelector(`[data-category-id="${catId}"]`);
      if (!row) return;

      const correctInput = row.querySelector('.input-correct');
      const totalInput = row.querySelector('.input-total');
      const badge = row.querySelector('.feedback-badge');

      const correctVal = correctInput.value.trim();
      const totalVal = totalInput.value.trim();

      const feedback = getScoreFeedback(correctVal, totalVal);
      badge.textContent = feedback.wrongText;
      badge.className = `score-tag ${feedback.badgeClass} feedback-badge`;

      updateProgressDisplay();
    });
  });

  // Time format on blur
  container.querySelectorAll('.input-time').forEach(input => {
    input.addEventListener('blur', () => {
      const raw = input.value.trim();
      if (!raw) return;

      const seconds = parseTimeToSeconds(raw);
      if (seconds !== null) {
        input.value = formatSecondsToMMSS(seconds);
      }
    });
  });
}

/**
 * Updates the progress line ("17 of 24 done")
 */
function updateProgressDisplay() {
  const displayEl = document.getElementById('progress-display');
  if (!displayEl) return;

  const totalCategories = roundCategories.length;
  if (totalCategories === 0) return;

  let completedCount = 0;
  const rows = document.querySelectorAll('.score-entry-row');

  rows.forEach(row => {
    const correctVal = row.querySelector('.input-correct')?.value.trim();
    const totalVal = row.querySelector('.input-total')?.value.trim();

    // Considered complete if total > 0 or has entered values
    if (totalVal && !isNaN(Number(totalVal)) && Number(totalVal) > 0) {
      completedCount++;
    } else if (correctVal && !isNaN(Number(correctVal)) && Number(correctVal) >= 0) {
      completedCount++;
    }
  });

  displayEl.textContent = `${completedCount} of ${totalCategories} completed`;
}

/**
 * Save all modified / new rows for the current round
 */
async function saveRoundScores() {
  const saveBtn = document.getElementById('btn-save-round');
  const saveBtnBottom = document.getElementById('btn-save-round-bottom');
  const btnText = document.getElementById('save-btn-text');

  // Prevent double submit
  saveBtn.disabled = true;
  if (saveBtnBottom) saveBtnBottom.disabled = true;
  btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

  try {
    const rows = Array.from(document.querySelectorAll('.score-entry-row'));
    const updates = [];
    const inserts = [];

    for (const row of rows) {
      const catId = row.getAttribute('data-category-id');
      const initial = JSON.parse(initialRowValues.get(catId) || '{}');

      // Skip verified rows
      if (initial.isVerified) continue;

      const correctRaw = row.querySelector('.input-correct')?.value.trim() || '';
      const totalRaw = row.querySelector('.input-total')?.value.trim() || '';
      const timeRaw = row.querySelector('.input-time')?.value.trim() || '';
      const noteRaw = row.querySelector('.input-note')?.value.trim() || '';

      // Check if row changed
      const isDirty = (
        correctRaw !== String(initial.correct || '') ||
        totalRaw !== String(initial.total || '') ||
        timeRaw !== String(initial.time || '') ||
        noteRaw !== String(initial.note || '')
      );

      if (!isDirty) continue;

      // If all fields are empty, do not save
      if (correctRaw === '' && totalRaw === '' && timeRaw === '' && noteRaw === '') {
        continue;
      }

      // Browser validation
      const correctNum = correctRaw !== '' ? parseInt(correctRaw, 10) : null;
      const totalNum = totalRaw !== '' ? parseInt(totalRaw, 10) : null;
      const timeSeconds = timeRaw !== '' ? parseTimeToSeconds(timeRaw) : null;

      if (correctNum !== null && isNaN(correctNum)) {
        throw new Error('Correct answers must be a whole number.');
      }
      if (totalNum !== null && isNaN(totalNum)) {
        throw new Error('Total attempted must be a whole number.');
      }
      if (correctNum !== null && totalNum !== null && correctNum > totalNum) {
        throw new Error('Correct answers cannot be more than the total.');
      }
      if (correctNum !== null && (totalNum === null || totalNum <= 0)) {
        throw new Error('Total attempted must be greater than 0 when entering correct answers.');
      }

      const payload = {
        student_id: currentProfile.id,
        category_id: catId,
        round_number: selectedRoundNumber,
        correct: correctNum,
        total: totalNum,
        time_seconds: timeSeconds,
        note: noteRaw || null,
        // CRITICAL DATABASE RULE: Never send entry_date on updates, and do not send entry_date
        // on today's inserts so the database default (today_ist()) applies!
      };

      if (initial.existingId) {
        // Update existing row by ID (never send entry_date)
        updates.push({ id: initial.existingId, ...payload });
      } else {
        // Insert new row (do NOT send entry_date)
        inserts.push(payload);
      }
    }

    if (updates.length === 0 && inserts.length === 0) {
      showToast('info', 'No changes to save.');
      return;
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // Execute updates
      for (const item of updates) {
        const { id, ...updateFields } = item;
        const { error } = await supabase
          .from('results')
          .update(updateFields)
          .eq('id', id);

        if (error) throw new Error(error.message);
      }

      // Execute inserts (without entry_date)
      if (inserts.length > 0) {
        const { error } = await supabase
          .from('results')
          .insert(inserts);

        if (error) throw new Error(error.message);
      }
    } else {
      // Demo Mode save in localStorage
      const demoKey = `trendz_demo_results_${currentProfile.id}_r${selectedRoundNumber}`;
      let list = JSON.parse(localStorage.getItem(demoKey) || '[]');

      updates.forEach(up => {
        const idx = list.findIndex(r => r.id === up.id);
        if (idx !== -1) list[idx] = { ...list[idx], ...up };
      });

      inserts.forEach(ins => {
        list.push({ id: `res-demo-${Date.now()}-${Math.random()}`, ...ins, verified: false });
      });

      localStorage.setItem(demoKey, JSON.stringify(list));
    }

    showToast('success', 'Round scores saved successfully!');
    await loadRoundResults();
  } catch (err) {
    console.error('Save error:', err);
    // Show friendly toast for database trigger errors
    showToast('error', err.message || 'Failed to save scores.');
  } finally {
    saveBtn.disabled = false;
    if (saveBtnBottom) saveBtnBottom.disabled = false;
    btnText.textContent = 'Save Changes';
  }
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
 * Initialize Round Scores Page
 */
async function initRoundScores() {
  currentProfile = await requireAuth(['student', 'admin']);
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  // Round selection change
  document.getElementById('select-round')?.addEventListener('change', async (e) => {
    selectedRoundNumber = parseInt(e.target.value, 10);
    if (!isNaN(selectedRoundNumber)) {
      await loadRoundResults();
    }
  });

  // Save buttons
  document.getElementById('btn-save-round')?.addEventListener('click', saveRoundScores);
  document.getElementById('btn-save-round-bottom')?.addEventListener('click', saveRoundScores);

  // Initial load
  await loadRounds();
}

document.addEventListener('DOMContentLoaded', initRoundScores);
