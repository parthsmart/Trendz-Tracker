/**
 * Trendz Tracker - Student Round Scores Module (js/roundScores.js)
 *
 * Phase 4c-0 Architecture:
 * - Rounds belong to each student (`student_rounds`) and are scoped to a simulator series (`round_series`).
 * - Dropdown shows ONLY the logged-in student's own rounds in the current series (`round_series.is_current = true`),
 *   newest first ("Round 12 - 18 Oct 2026").
 * - "+ Start today's round" button calls RPC `start_round(p_student, p_round_type)` which returns the round id,
 *   assigns the next round_number in the current series, uses today_ist(), and reuses today's empty round.
 * - Categories are loaded ONLY from `category_series` for the round's series (where `categories.active = true`),
 *   ordered strictly by `category_series.sort_order` (NOT `categories.sort_order`).
 * - Students can update `round_type` and `time_taken_seconds` on their own rounds from the last 7 days.
 * - `results` rows use `student_round_id` (required for round categories; `round_number` no longer exists).
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { isFlatRound } from './roundType.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatDisplayDateIST, getISTDateString } from './stats.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS, parseTimeToSeconds, setupEnterKeyNavigation } from './timeUtils.js';
import { showToast } from './toast.js';

let currentProfile = null;
let todayIST = '';
let currentSeries = null;
let studentRounds = [];
let roundCategories = [];
let selectedRoundId = null;
let existingResultsMap = new Map(); // category_id -> result object
let initialRowValues = new Map(); // category_id -> JSON string of initial values to detect dirty rows
let initialRoundMeta = { round_type: 'Category wise', time_taken: '' };

/**
 * Formats database errors into clear, friendly messages for students
 */
function formatFriendlyRoundError(err) {
  const msg = String(err?.message || err || '').trim();
  const lower = msg.toLowerCase();

  if (lower.includes('not the student') || lower.includes('own round') || lower.includes('belongs to another')) {
    return 'You can only enter or update scores on your own practice rounds.';
  }
  if (lower.includes('non-current') || lower.includes('not current') || lower.includes('current series')) {
    return 'Students can only enter or edit scores in the current simulator series.';
  }
  if (lower.includes('not part of') || lower.includes('category_series') || lower.includes('round series')) {
    return 'One or more categories do not belong to this round’s simulator series.';
  }
  if (lower.includes('7 days') || lower.includes('seven days') || lower.includes('older than')) {
    return 'Rounds older than 7 days are locked and can only be edited by your teacher.';
  }
  if (lower.includes('row-level security') || lower.includes('rls') || lower.includes('permission denied')) {
    return 'This round or score is locked. Rounds older than 7 days or verified entries cannot be modified.';
  }
  return msg || 'Failed to save round scores.';
}

/**
 * Checks if a round date (YYYY-MM-DD) is within the last 7 days of todayIST (inclusive)
 */
function isRoundWithinLast7Days(roundDateStr, todayDateStr) {
  if (!roundDateStr || !todayDateStr) return true;
  try {
    const [y1, m1, d1] = roundDateStr.split('-').map(Number);
    const [y2, m2, d2] = todayDateStr.split('-').map(Number);
    const rUtc = Date.UTC(y1, m1 - 1, d1);
    const tUtc = Date.UTC(y2, m2 - 1, d2);
    const diffDays = Math.round((tUtc - rUtc) / 86400000);
    return diffDays <= 7;
  } catch {
    return true;
  }
}

/**
 * Resolve today_ist() and the current round_series
 */
async function loadCurrentSeriesAndToday() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const [todayRes, seriesRes] = await Promise.all([
      supabase.rpc('today_ist'),
      supabase
        .from('round_series')
        .select('*')
        .eq('is_current', true)
        .limit(1)
    ]);

    todayIST = !todayRes.error && todayRes.data
      ? getISTDateString(String(todayRes.data).trim())
      : getISTDateString(new Date());

    if (seriesRes.error) throw new Error(seriesRes.error.message);
    currentSeries = Array.isArray(seriesRes.data) && seriesRes.data.length > 0
      ? seriesRes.data[0]
      : null;
  } else {
    todayIST = await DemoDB.mockTodayIST();
    const allSeries = DemoDB.getRoundSeries();
    currentSeries = allSeries.find(s => s.is_current) || allSeries[allSeries.length - 1] || null;
  }

  const seriesBadge = document.getElementById('series-badge-display');
  if (seriesBadge && currentSeries) {
    seriesBadge.textContent = currentSeries.name;
    seriesBadge.style.display = 'inline-flex';
  }
}

/**
 * Load active round categories for a given series_id ordered strictly by category_series.sort_order
 */
async function loadSeriesCategories(seriesId) {
  if (!seriesId) {
    roundCategories = [];
    return;
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('category_series')
        .select(`
          category_id,
          series_id,
          sort_order,
          category:categories(id, name, section, active)
        `)
        .eq('series_id', seriesId)
        .order('sort_order', { ascending: true });

      if (error) throw new Error(error.message);

      roundCategories = (data || [])
        .filter(item => item.category && item.category.section === 'round' && item.category.active === true)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
        .map(item => ({
          id: item.category.id,
          name: item.category.name,
          section: item.category.section,
          active: item.category.active,
          series_sort_order: item.sort_order
        }));
    } else {
      const allCats = DemoDB.getCategories();
      const catMap = new Map(allCats.map(c => [c.id, c]));
      const catSeries = DemoDB.getCategorySeries()
        .filter(cs => cs.series_id === seriesId)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      roundCategories = catSeries
        .map(cs => {
          const cat = catMap.get(cs.category_id);
          if (!cat || cat.section !== 'round' || !cat.active) return null;
          return {
            id: cat.id,
            name: cat.name,
            section: cat.section,
            active: cat.active,
            series_sort_order: cs.sort_order
          };
        })
        .filter(Boolean);
    }
  } catch (err) {
    console.error('Error loading series categories:', err);
    showToast('error', 'Failed to load round categories: ' + formatFriendlyRoundError(err));
    roundCategories = [];
  }
}

/**
 * Load the logged-in student's rounds in the current series (newest first)
 */
async function loadStudentRounds(preselectRoundId = null) {
  const selectEl = document.getElementById('select-round');
  if (selectEl) {
    selectEl.innerHTML = '<option value="">Loading rounds...</option>';
  }

  try {
    if (!currentSeries) {
      await loadCurrentSeriesAndToday();
    }

    if (!currentSeries) {
      if (selectEl) selectEl.innerHTML = '<option value="">No active series found</option>';
      return;
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('student_rounds')
        .select('*')
        .eq('student_id', currentProfile.id)
        .eq('series_id', currentSeries.id)
        .order('round_number', { ascending: false });

      if (error) throw new Error(error.message);
      studentRounds = data || [];
    } else {
      studentRounds = DemoDB.getStudentRounds(currentProfile.id, currentSeries.id);
    }

    await loadSeriesCategories(currentSeries.id);

    if (studentRounds.length === 0) {
      if (selectEl) selectEl.innerHTML = '<option value="">No rounds started yet</option>';
      selectedRoundId = null;
      const metaCard = document.getElementById('round-meta-card');
      if (metaCard) metaCard.style.display = 'none';
      const saveBtn = document.getElementById('btn-save-round');
      const saveBtnBottom = document.getElementById('btn-save-round-bottom');
      if (saveBtn) saveBtn.disabled = true;
      if (saveBtnBottom) saveBtnBottom.disabled = true;

      const progressEl = document.getElementById('progress-display');
      if (progressEl) progressEl.textContent = '0 rounds started';

      document.getElementById('score-rows-container').innerHTML = `
        <div class="empty-state" style="padding: var(--space-8); text-align: center;">
          <div class="empty-state-icon" style="font-size: 2.25rem; margin-bottom: var(--space-2);">📋</div>
          <h3 class="empty-state-title">No rounds started in ${escapeHtml(currentSeries.name)} yet</h3>
          <p class="empty-state-desc" style="margin-bottom: var(--space-4);">
            Click <strong>+ Start today's round</strong> above to begin Round 1 for today.
          </p>
        </div>
      `;
      return;
    }

    const saveBtn = document.getElementById('btn-save-round');
    const saveBtnBottom = document.getElementById('btn-save-round-bottom');
    if (saveBtn) saveBtn.disabled = false;
    if (saveBtnBottom) saveBtnBottom.disabled = false;

    if (selectEl) {
      selectEl.innerHTML = studentRounds.map(r => `
        <option value="${escapeHtml(r.id)}">
          Round ${r.round_number} - ${formatDisplayDateIST(r.round_date)}
        </option>
      `).join('');
    }

    // Select requested round or default to newest round
    if (preselectRoundId && studentRounds.some(r => r.id === preselectRoundId)) {
      selectedRoundId = preselectRoundId;
    } else {
      selectedRoundId = studentRounds[0].id;
    }

    if (selectEl) {
      selectEl.value = selectedRoundId;
    }

    renderSelectedRoundMeta();
    await loadRoundResults();
  } catch (err) {
    console.error('Error loading student rounds:', err);
    showToast('error', formatFriendlyRoundError(err));
  }
}

/**
 * Toggles the per-category Time column visibility based on whether the selected round type is flat.
 * Uses CSS class toggling so typed values in Correct, Total, and Time inputs are never lost.
 */
function applyRoundTypeVisibility(roundType) {
  const tableCard = document.getElementById('round-scores-table-card');
  if (!tableCard) return;
  tableCard.classList.toggle('is-flat-round', isFlatRound(roundType));
}

/**
 * Renders the Round Type & Time Taken bar for the selected round
 */
function renderSelectedRoundMeta() {
  const metaCard = document.getElementById('round-meta-card');
  const typeSelect = document.getElementById('input-round-type');
  const timeInput = document.getElementById('input-round-time-taken');
  const lockNotice = document.getElementById('round-meta-lock-notice');

  const roundObj = studentRounds.find(r => r.id === selectedRoundId);
  if (!roundObj || !metaCard) {
    if (metaCard) metaCard.style.display = 'none';
    return;
  }

  metaCard.style.display = 'block';

  const roundTypeVal = roundObj.round_type || 'Category wise';
  const timeFormatted = roundObj.time_taken_seconds !== null && roundObj.time_taken_seconds !== undefined
    ? formatSecondsToMMSS(roundObj.time_taken_seconds)
    : '';

  if (typeSelect) {
    // Ensure custom round_type from sheet import exists as an option
    const hasOpt = Array.from(typeSelect.options).some(o => o.value === roundTypeVal);
    if (!hasOpt) {
      const opt = document.createElement('option');
      opt.value = roundTypeVal;
      opt.textContent = roundTypeVal;
      typeSelect.appendChild(opt);
    }
    typeSelect.value = roundTypeVal;
  }

  if (timeInput) {
    timeInput.value = timeFormatted;
  }

  initialRoundMeta = {
    round_type: roundTypeVal,
    time_taken: timeFormatted
  };

  applyRoundTypeVisibility(roundTypeVal);

  // Students can update round_type and time_taken_seconds on their own rounds from the last 7 days
  const canEditMeta = currentProfile.role === 'admin' || isRoundWithinLast7Days(roundObj.round_date, todayIST);

  if (typeSelect) typeSelect.disabled = !canEditMeta;
  if (timeInput) timeInput.disabled = !canEditMeta;

  if (lockNotice) {
    if (canEditMeta) {
      lockNotice.textContent = `Round ${roundObj.round_number} · ${formatDisplayDateIST(roundObj.round_date)}`;
    } else {
      lockNotice.textContent = `🔒 Round header is older than 7 days (read-only)`;
    }
  }
}

/**
 * Start today's round via RPC start_round
 */
async function handleStartTodayRound() {
  const btn = document.getElementById('btn-start-today-round');
  const btnText = document.getElementById('btn-start-round-text');
  if (!btn || !btnText) return;

  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Starting...';

  try {
    const typeSelect = document.getElementById('input-round-type');
    const preferredType = typeSelect?.value || 'Category wise';
    let roundId = null;

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('start_round', {
        p_student: currentProfile.id,
        p_round_type: preferredType
      });
      if (error) throw new Error(error.message);
      roundId = typeof data === 'object' && data !== null ? (data.id || data.round_id || data) : data;
    } else {
      roundId = await DemoDB.mockStartRound(currentProfile.id, preferredType);
    }

    await loadStudentRounds(roundId ? String(roundId) : null);

    const selectedRound = studentRounds.find(r => r.id === selectedRoundId);
    if (selectedRound) {
      showToast('success', `Round ${selectedRound.round_number} (${formatDisplayDateIST(selectedRound.round_date)}) is ready.`);
    } else {
      showToast('success', `Today's round is ready.`);
    }
  } catch (err) {
    console.error('Error starting round:', err);
    showToast('error', formatFriendlyRoundError(err));
  } finally {
    btn.disabled = false;
    btnText.textContent = "+ Start today's round";
  }
}

/**
 * Load student's existing scores for the selected student_round_id
 */
async function loadRoundResults() {
  const container = document.getElementById('score-rows-container');
  if (!selectedRoundId) return;

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
        .eq('student_round_id', selectedRoundId);

      if (error) throw new Error(error.message);
      (data || []).forEach(res => {
        existingResultsMap.set(res.category_id, res);
      });
    } else {
      const saved = DemoDB.getRoundResults(selectedRoundId);
      saved.forEach(res => existingResultsMap.set(res.category_id, res));
    }

    renderCategoryRows();
    updateProgressDisplay();
  } catch (err) {
    console.warn('Error loading round results:', err);
    showToast('error', formatFriendlyRoundError(err));
    renderCategoryRows();
    updateProgressDisplay();
  }
}

/**
 * Render all categories in the series with prefilled data, verified locks, and live evaluation
 */
function renderCategoryRows() {
  const container = document.getElementById('score-rows-container');

  if (roundCategories.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: var(--space-6);">
        <h3 class="empty-state-title">No active categories configured for this simulator series</h3>
      </div>
    `;
    return;
  }

  let html = '';

  roundCategories.forEach(cat => {
    const existing = existingResultsMap.get(cat.id);
    const isVerified = existing && (existing.verified === true || !!existing.verified_at || !!existing.verified_by);
    const isCorrected = existing && (!!existing.corrected_at || !!existing.corrected_by);
    const isFlagged = existing && existing.flagged === true;
    const flagNote = existing && existing.flag_note ? existing.flag_note : '';
    const isLocked = isVerified || isCorrected;
    const isSurpriseTask = cat.name.toLowerCase().includes('surprise');

    const correctVal = existing && existing.correct !== null && existing.correct !== undefined ? existing.correct : '';
    const totalVal = existing && existing.total !== null && existing.total !== undefined ? existing.total : '';
    const timeVal = existing && existing.time_seconds !== null && existing.time_seconds !== undefined ? formatSecondsToMMSS(existing.time_seconds) : '';
    const noteVal = existing && existing.note ? existing.note : '';

    // Cache initial state to detect changes during save
    initialRowValues.set(cat.id, JSON.stringify({
      correct: correctVal,
      total: totalVal,
      time: timeVal,
      note: noteVal,
      existingId: existing ? existing.id : null,
      isVerified,
      isCorrected,
      isLocked
    }));

    // Feedback
    let feedback = { wrongText: '—', badgeClass: 'score-tag-neutral' };
    if (correctVal !== '' || totalVal !== '') {
      feedback = getScoreFeedback(correctVal, totalVal);
    }

    // Status column
    let statusBadgeHtml = '';
    if (isVerified) {
      statusBadgeHtml = `
        <span class="verified-lock-indicator" title="Verified by teacher (locked)">
          🔒 Verified
        </span>
      `;
    } else if (isCorrected) {
      statusBadgeHtml = `
        <span class="status-chip chip-corrected" title="Corrected by teacher (locked)">
          ✏️ Corrected by teacher
        </span>
      `;
    } else if (isFlagged) {
      statusBadgeHtml = `
        <div class="status-chip chip-flagged" style="display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left; font-size: 11px; max-width: 220px; white-space: normal; line-height: 1.25; padding: 4px 6px;">
          <span style="font-weight: 600;">⚠️ Your teacher asked you to check this entry</span>
          ${flagNote ? `<span style="font-size: 10px; color: #78350F; margin-top: 2px;">Note: ${escapeHtml(flagNote)}</span>` : ''}
        </div>
      `;
    } else if (existing) {
      statusBadgeHtml = `
        <span class="status-indicator active" style="font-size: 11px;" title="Saved in database">
          Saved
        </span>
      `;
    } else {
      statusBadgeHtml = `
        <span class="status-indicator inactive" style="font-size: 11px;">
          Unsaved
        </span>
      `;
    }

    html += `
      <div class="score-entry-row ${isLocked ? 'row-verified' : ''}" data-category-id="${escapeHtml(cat.id)}">
        <!-- Category Name & Series Order -->
        <div class="cell-category">
          <div style="font-weight: 700; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(cat.name)}
          </div>
          <span class="num" style="font-size: 11px; color: var(--text-dim);">#${cat.series_sort_order}</span>
        </div>

        <!-- Correct Input -->
        <div>
          <input
            type="text"
            inputmode="numeric"
            class="form-input score-input input-correct"
            placeholder="0"
            value="${escapeHtml(String(correctVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            data-cat-id="${escapeHtml(cat.id)}"
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
            value="${escapeHtml(String(totalVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            data-cat-id="${escapeHtml(cat.id)}"
            aria-label="${escapeHtml(cat.name)} total attempted"
          />
        </div>

        <!-- Time Input (mm:ss or seconds) -->
        <div class="cell-time">
          <input
            type="text"
            inputmode="numeric"
            class="form-input score-input input-time"
            placeholder="0:00"
            value="${escapeHtml(String(timeVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            data-cat-id="${escapeHtml(cat.id)}"
            aria-label="${escapeHtml(cat.name)} time elapsed"
          />
        </div>

        <!-- Accuracy & Wrong Count Feedback -->
        <div class="cell-feedback" style="display: flex; align-items: center;">
          <span class="score-tag ${feedback.badgeClass} feedback-badge" data-cat-id="${escapeHtml(cat.id)}">
            ${feedback.wrongText}
          </span>
        </div>

        <!-- Status Column (Saved / Verified / Corrected / Flagged) -->
        <div style="text-align: right;">
          ${statusBadgeHtml}
        </div>

        ${isFlagged ? `
          <div style="grid-column: 1 / -1; margin-top: 6px; padding: 6px 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: var(--radius-sm); font-size: 12px; color: #92400E; display: flex; align-items: center; gap: 6px;">
            <span aria-hidden="true">⚠️</span>
            <span>Your teacher asked you to check this entry: <strong>${escapeHtml(flagNote || 'Please review your scores')}</strong></span>
          </div>
        ` : ''}

        ${isSurpriseTask ? `
          <div style="grid-column: 1 / -1; margin-top: 4px;">
            <input
              type="text"
              class="form-input input-note"
              placeholder="Surprise Task notes or topic description..."
              value="${escapeHtml(noteVal)}"
              ${isLocked ? 'readonly disabled' : ''}
              data-cat-id="${escapeHtml(cat.id)}"
              style="min-height: 36px; font-size: var(--text-xs);"
            />
          </div>
        ` : ''}
      </div>
    `;
  });

  container.innerHTML = html;

  const typeSelect = document.getElementById('input-round-type');
  applyRoundTypeVisibility(typeSelect?.value || initialRoundMeta.round_type);

  attachLiveInputListeners();
  setupEnterKeyNavigation(container);

  // Check if URL requested focus on a specific category (?cat=...)
  const urlParams = new URLSearchParams(window.location.search);
  const focusCatId = urlParams.get('cat');
  if (focusCatId) {
    const targetRow = container.querySelector(`[data-category-id="${focusCatId}"]`);
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstInput = targetRow.querySelector('.input-correct:not([disabled])');
      if (firstInput) firstInput.focus();
    }
  }
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
 * Updates the progress line ("17 of 24 completed")
 */
function updateProgressDisplay() {
  const displayEl = document.getElementById('progress-display');
  if (!displayEl) return;

  const totalCategories = roundCategories.length;
  if (totalCategories === 0) {
    displayEl.textContent = '0 categories';
    return;
  }

  let completedCount = 0;
  const rows = document.querySelectorAll('#score-rows-container .score-entry-row');

  rows.forEach(row => {
    const correctVal = row.querySelector('.input-correct')?.value.trim();
    const totalVal = row.querySelector('.input-total')?.value.trim();
    const noteVal = row.querySelector('.input-note')?.value.trim();

    if (totalVal && !isNaN(Number(totalVal)) && Number(totalVal) > 0) {
      completedCount++;
    } else if (correctVal && !isNaN(Number(correctVal)) && Number(correctVal) >= 0) {
      completedCount++;
    } else if (noteVal) {
      completedCount++;
    }
  });

  displayEl.textContent = `${completedCount} of ${totalCategories} completed`;
}

/**
 * Save round metadata (round_type, time_taken_seconds) and modified/new score rows
 */
async function saveRoundScores() {
  if (!selectedRoundId) {
    showToast('info', "Please click '+ Start today's round' first.");
    return;
  }

  const saveBtn = document.getElementById('btn-save-round');
  const saveBtnBottom = document.getElementById('btn-save-round-bottom');
  const btnText = document.getElementById('save-btn-text');

  saveBtn.disabled = true;
  if (saveBtnBottom) saveBtnBottom.disabled = true;
  btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

  try {
    // 1. Check if round metadata (round_type, time_taken_seconds) changed
    const typeSelect = document.getElementById('input-round-type');
    const timeTakenInput = document.getElementById('input-round-time-taken');

    const newRoundType = (typeSelect?.value || 'Category wise').trim();
    const newTimeTakenRaw = (timeTakenInput?.value || '').trim();
    let newTimeTakenSeconds = null;

    if (newTimeTakenRaw !== '') {
      newTimeTakenSeconds = parseTimeToSeconds(newTimeTakenRaw);
      if (newTimeTakenSeconds === null) {
        throw new Error('Round Time Taken must be in h:mm:ss, mm:ss, or seconds format (e.g. 1:08:37 or 45:00).');
      }
    }

    const isMetaDirty =
      newRoundType !== initialRoundMeta.round_type ||
      newTimeTakenRaw !== initialRoundMeta.time_taken;

    // 2. Check score rows
    const flatMode = isFlatRound(newRoundType);
    const rows = Array.from(document.querySelectorAll('#score-rows-container .score-entry-row'));
    const updates = [];
    const inserts = [];

    for (const row of rows) {
      const catId = row.getAttribute('data-category-id');
      const initial = JSON.parse(initialRowValues.get(catId) || '{}');

      // Skip locked rows (verified or corrected by teacher)
      if (initial.isLocked || initial.isVerified || initial.isCorrected) continue;

      const correctRaw = row.querySelector('.input-correct')?.value.trim() || '';
      const totalRaw = row.querySelector('.input-total')?.value.trim() || '';
      const timeRaw = row.querySelector('.input-time')?.value.trim() || '';
      const noteRaw = row.querySelector('.input-note')?.value.trim() || '';

      const isDirty = flatMode
        ? (
            correctRaw !== String(initial.correct ?? '') ||
            totalRaw !== String(initial.total ?? '') ||
            noteRaw !== String(initial.note ?? '')
          )
        : (
            correctRaw !== String(initial.correct ?? '') ||
            totalRaw !== String(initial.total ?? '') ||
            timeRaw !== String(initial.time ?? '') ||
            noteRaw !== String(initial.note ?? '')
          );

      if (!isDirty) continue;

      if (flatMode) {
        if (correctRaw === '' && totalRaw === '' && noteRaw === '') {
          continue;
        }
      } else {
        if (correctRaw === '' && totalRaw === '' && timeRaw === '' && noteRaw === '') {
          continue;
        }
      }

      const correctNum = correctRaw !== '' ? parseInt(correctRaw, 10) : null;
      const totalNum = totalRaw !== '' ? parseInt(totalRaw, 10) : null;
      const timeSeconds = !flatMode && timeRaw !== '' ? parseTimeToSeconds(timeRaw) : null;

      if (correctRaw !== '' && (correctNum === null || isNaN(correctNum) || correctNum < 0)) {
        throw new Error('Correct answers must be a whole number.');
      }
      if (totalRaw !== '' && (totalNum === null || isNaN(totalNum) || totalNum < 0)) {
        throw new Error('Total attempted must be a whole number.');
      }
      if (!flatMode && timeRaw !== '' && timeSeconds === null) {
        throw new Error('Category time must be formatted as mm:ss or seconds.');
      }
      if (correctNum !== null && totalNum !== null && correctNum > totalNum) {
        throw new Error('Correct answers cannot be more than the total.');
      }
      if (correctNum !== null && (totalNum === null || totalNum <= 0)) {
        throw new Error('Total attempted must be greater than 0 when entering correct answers.');
      }

      const payload = {
        student_id: currentProfile.id,
        student_round_id: selectedRoundId,
        category_id: catId,
        correct: correctNum,
        total: totalNum,
        note: noteRaw || null
        // CRITICAL DATABASE RULE: Never send entry_date on updates or today's inserts!
      };

      // For flat rounds, never send per-category time so existing stored times are never deleted or changed
      if (!flatMode) {
        payload.time_seconds = timeSeconds;
      }

      if (initial.existingId) {
        updates.push({ id: initial.existingId, ...payload });
      } else {
        inserts.push(payload);
      }
    }

    if (!isMetaDirty && updates.length === 0 && inserts.length === 0) {
      showToast('info', 'No changes to save.');
      return;
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      // Update student_rounds header if modified
      if (isMetaDirty) {
        const { error: metaErr } = await supabase
          .from('student_rounds')
          .update({
            round_type: newRoundType,
            time_taken_seconds: newTimeTakenSeconds
          })
          .eq('id', selectedRoundId);

        if (metaErr) throw new Error(metaErr.message);
      }

      // Execute updates on results
      for (const item of updates) {
        const { id, ...updateFields } = item;
        const { error } = await supabase
          .from('results')
          .update(updateFields)
          .eq('id', id);

        if (error) throw new Error(error.message);
      }

      // Execute inserts on results (without entry_date)
      if (inserts.length > 0) {
        const { error } = await supabase
          .from('results')
          .insert(inserts);

        if (error) throw new Error(error.message);
      }
    } else {
      if (isMetaDirty) {
        DemoDB.updateStudentRound(selectedRoundId, {
          round_type: newRoundType,
          time_taken_seconds: newTimeTakenSeconds
        });
      }
      DemoDB.saveRoundResults(selectedRoundId, updates, inserts);
    }

    // Refresh local round object metadata if changed
    const roundObj = studentRounds.find(r => r.id === selectedRoundId);
    if (roundObj && isMetaDirty) {
      roundObj.round_type = newRoundType;
      roundObj.time_taken_seconds = newTimeTakenSeconds;
      renderSelectedRoundMeta();
    }

    showToast('success', 'Round scores saved successfully!');
    await loadRoundResults();
  } catch (err) {
    console.error('Save error:', err);
    showToast('error', formatFriendlyRoundError(err));
  } finally {
    saveBtn.disabled = false;
    if (saveBtnBottom) saveBtnBottom.disabled = false;
    btnText.textContent = 'Save Changes';
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder || !isDemoMode()) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Using simulated per-student rounds and series categories.
      </div>
    </div>
  `;
}

/**
 * Initialize Round Scores Page
 */
async function initRoundScores() {
  currentProfile = await requireAuth(['student', 'admin']);
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');
  if (pillContainer) pillContainer.style.display = 'flex';
  if (nameEl) nameEl.textContent = currentProfile.full_name || 'Student';
  if (codeEl) codeEl.textContent = currentProfile.student_code || 'STU';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });

  renderDemoBanner();

  // Format round time taken on blur
  const timeTakenInput = document.getElementById('input-round-time-taken');
  timeTakenInput?.addEventListener('blur', () => {
    const raw = timeTakenInput.value.trim();
    if (!raw) return;
    const sec = parseTimeToSeconds(raw);
    if (sec !== null) {
      timeTakenInput.value = formatSecondsToMMSS(sec);
    }
  });

  // Round selection change
  document.getElementById('select-round')?.addEventListener('change', async (e) => {
    selectedRoundId = e.target.value;
    if (selectedRoundId) {
      renderSelectedRoundMeta();
      await loadRoundResults();
    }
  });

  // Round type change updates the screen immediately without losing typed values
  document.getElementById('input-round-type')?.addEventListener('change', (e) => {
    applyRoundTypeVisibility(e.target.value);
  });

  // Start today's round button
  document.getElementById('btn-start-today-round')?.addEventListener('click', handleStartTodayRound);

  // Save buttons
  document.getElementById('btn-save-round')?.addEventListener('click', saveRoundScores);
  document.getElementById('btn-save-round-bottom')?.addEventListener('click', saveRoundScores);

  // Initial load
  await loadCurrentSeriesAndToday();
  await loadStudentRounds();
}

document.addEventListener('DOMContentLoaded', initRoundScores);
