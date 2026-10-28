/**
 * Trendz Tracker - Student Round Scores Module (js/roundScores.js)
 *
 * Phase 4c-0 / Phase 11a Architecture:
 * - Rounds belong to each student (`student_rounds`) and are scoped to a simulator series (`round_series`).
 * - Dropdown shows ONLY the logged-in student's own rounds in the current series (`round_series.is_current = true`),
 *   newest first ("Round 12 - 18 Oct 2026").
 * - "+ Start today's round" button calls `start_round(p_student, p_round_type)` which returns the round id,
 *   assigns the next round_number in the current series, uses today_ist(), and reuses today's empty round.
 * - Categories are loaded ONLY from `category_series` for the round's series (where `categories.active = true`),
 *   ordered strictly by `category_series.sort_order` (NOT `categories.sort_order`).
 * - Students can update `round_type` and `time_taken_seconds` on their own rounds from the last 7 days.
 * - Each category row displays one of six status chips:
 *   "Not entered", "Edited - not saved", "Saved",
 *   "Locked (verified)", "Locked (corrected by your teacher)", "Locked (older than 7 days)".
 * - Live inline field validation sits next to the field (correct cannot be more than attempted; no negative numbers).
 * - Save bar shows "n unsaved changes"; if saving fails, typed values stay intact, an alert (role="alert")
 *   with "Try again" is shown, and leaving with unsaved changes asks for confirmation.
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
let pendingNavigationCallback = null;

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
  } else if (DemoDB) {
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
    } else if (DemoDB) {
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
    } else if (DemoDB) {
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
      updateUnsavedCountUI(0);

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
  const lockExplanation = document.getElementById('round-lock-explanation');

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

  if (lockExplanation) {
    if (canEditMeta) {
      lockExplanation.textContent =
        'You can edit any unverified category in this round; entries verified or corrected by your teacher and rounds older than 7 days are locked.';
    } else {
      lockExplanation.textContent =
        'This round is older than 7 days, so all fields are locked; only rounds from the last 7 days that have not been verified or corrected by your teacher can be edited.';
    }
  }
}

/**
 * Start today's round via start_round
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
    } else if (DemoDB) {
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

  hideSaveErrorAlert();
  hideUnsavedLeaveBanner();

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
    } else if (DemoDB) {
      const saved = DemoDB.getRoundResults(selectedRoundId);
      saved.forEach(res => existingResultsMap.set(res.category_id, res));
    }

    renderCategoryRows();
    updateProgressDisplay();
    recalculateUnsavedChanges();
  } catch (err) {
    console.warn('Error loading round results:', err);
    showToast('error', formatFriendlyRoundError(err));
    renderCategoryRows();
    updateProgressDisplay();
    recalculateUnsavedChanges();
  }
}

/**
 * Builds the HTML for a row's status chip based on its state:
 * - "Locked (verified)"
 * - "Locked (corrected by your teacher)"
 * - "Locked (older than 7 days)"
 * - "Edited - not saved"
 * - "Saved"
 * - "Not entered"
 */
function buildRowStatusChipHtml({ isVerified, isCorrected, isOlderThan7Days, isDirty, hasExisting }) {
  if (isVerified) {
    return `
      <span class="status-chip chip-verified row-status-chip" title="Locked because your teacher verified this score.">
        🔒 Locked (verified)
      </span>
    `;
  }
  if (isCorrected) {
    return `
      <span class="status-chip chip-corrected row-status-chip" title="Locked because your teacher corrected this score.">
        ✏️ Locked (corrected by your teacher)
      </span>
    `;
  }
  if (isOlderThan7Days) {
    return `
      <span class="status-chip chip-inactive row-status-chip" title="Locked because this round is older than 7 days.">
        🔒 Locked (older than 7 days)
      </span>
    `;
  }
  if (isDirty) {
    return `
      <span class="status-chip chip-pending row-status-chip" title="You have edited this row; click Save Changes to save.">
        Edited - not saved
      </span>
    `;
  }
  if (hasExisting) {
    return `
      <span class="status-chip chip-done row-status-chip" title="Saved in your scores">
        Saved
      </span>
    `;
  }
  return `
    <span class="status-chip chip-unverified row-status-chip" title="No score entered for this category yet">
      Not entered
    </span>
  `;
}

/**
 * Render all categories in the series with prefilled data, lock states, and live evaluation
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

  const roundObj = studentRounds.find(r => r.id === selectedRoundId);
  const isOlderThan7Days =
    currentProfile?.role !== 'admin' &&
    roundObj &&
    !isRoundWithinLast7Days(roundObj.round_date, todayIST);

  let html = '';

  roundCategories.forEach(cat => {
    const existing = existingResultsMap.get(cat.id);
    const isVerified = Boolean(existing && (existing.verified === true || !!existing.verified_at || !!existing.verified_by));
    const isCorrected = Boolean(existing && (!!existing.corrected_at || !!existing.corrected_by));
    const isFlagged = Boolean(existing && existing.flagged === true);
    const flagNote = existing && existing.flag_note ? existing.flag_note : '';
    const isLocked = isVerified || isCorrected || isOlderThan7Days;
    const isSurpriseTask = cat.name.toLowerCase().includes('surprise');

    let lockReasonTooltip = '';
    if (isVerified) {
      lockReasonTooltip = 'Locked because your teacher verified this score.';
    } else if (isCorrected) {
      lockReasonTooltip = 'Locked because your teacher corrected this score.';
    } else if (isOlderThan7Days) {
      lockReasonTooltip = 'Locked because this round is older than 7 days.';
    }

    const correctVal = existing && existing.correct !== null && existing.correct !== undefined ? existing.correct : '';
    const totalVal = existing && existing.total !== null && existing.total !== undefined ? existing.total : '';
    const timeVal = existing && existing.time_seconds !== null && existing.time_seconds !== undefined ? formatSecondsToMMSS(existing.time_seconds) : '';
    const noteVal = existing && existing.note ? existing.note : '';

    // Cache initial state to detect changes during typing & save
    initialRowValues.set(cat.id, JSON.stringify({
      correct: String(correctVal),
      total: String(totalVal),
      time: String(timeVal),
      note: String(noteVal),
      existingId: existing ? existing.id : null,
      hasExisting: Boolean(existing),
      isVerified,
      isCorrected,
      isOlderThan7Days,
      isLocked
    }));

    // Feedback
    let feedback = { wrongText: '—', badgeClass: 'score-tag-neutral' };
    if (correctVal !== '' || totalVal !== '') {
      feedback = getScoreFeedback(correctVal, totalVal);
    }

    const statusBadgeHtml = buildRowStatusChipHtml({
      isVerified,
      isCorrected,
      isOlderThan7Days,
      isDirty: false,
      hasExisting: Boolean(existing)
    });

    html += `
      <div
        class="score-entry-row ${isLocked ? 'row-verified is-locked' : ''}"
        data-category-id="${escapeHtml(cat.id)}"
        ${lockReasonTooltip ? `title="${escapeHtml(lockReasonTooltip)}"` : ''}
      >
        <!-- Category Name & Series Order -->
        <div class="cell-category">
          <div style="font-weight: 700; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(cat.name)}
          </div>
          <span class="num" style="font-size: 11px; color: var(--text-dim);">#${cat.series_sort_order}</span>
        </div>

        <!-- Correct Input -->
        <div>
          <label class="sr-only" for="input-correct-${escapeHtml(cat.id)}">${escapeHtml(cat.name)} correct answers</label>
          <input
            type="text"
            id="input-correct-${escapeHtml(cat.id)}"
            inputmode="numeric"
            class="form-input score-input input-correct"
            placeholder="0"
            value="${escapeHtml(String(correctVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            ${lockReasonTooltip ? `title="${escapeHtml(lockReasonTooltip)}"` : ''}
            data-cat-id="${escapeHtml(cat.id)}"
            aria-label="${escapeHtml(cat.name)} correct answers"
          />
        </div>

        <!-- Total Input -->
        <div>
          <label class="sr-only" for="input-total-${escapeHtml(cat.id)}">${escapeHtml(cat.name)} total attempted</label>
          <input
            type="text"
            id="input-total-${escapeHtml(cat.id)}"
            inputmode="numeric"
            class="form-input score-input input-total"
            placeholder="0"
            value="${escapeHtml(String(totalVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            ${lockReasonTooltip ? `title="${escapeHtml(lockReasonTooltip)}"` : ''}
            data-cat-id="${escapeHtml(cat.id)}"
            aria-label="${escapeHtml(cat.name)} total attempted"
          />
        </div>

        <!-- Time Input (mm:ss or seconds) -->
        <div class="cell-time">
          <label class="sr-only" for="input-time-${escapeHtml(cat.id)}">${escapeHtml(cat.name)} time elapsed</label>
          <input
            type="text"
            id="input-time-${escapeHtml(cat.id)}"
            inputmode="numeric"
            class="form-input score-input input-time"
            placeholder="0:00"
            value="${escapeHtml(String(timeVal))}"
            ${isLocked ? 'readonly disabled' : ''}
            ${lockReasonTooltip ? `title="${escapeHtml(lockReasonTooltip)}"` : ''}
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

        <!-- Status Column -->
        <div class="cell-status" style="text-align: right;">
          ${statusBadgeHtml}
        </div>

        <!-- Inline Field Validation Message (sits next to the row fields) -->
        <div
          class="field-validation-msg"
          data-validation-for="${escapeHtml(cat.id)}"
          role="alert"
          style="display: none; grid-column: 1 / -1;"
        ></div>

        ${isFlagged ? `
          <div style="grid-column: 1 / -1; margin-top: 6px; padding: 6px 12px; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: var(--radius-sm); font-size: 12px; color: #92400E; display: flex; align-items: center; gap: 6px;">
            <span aria-hidden="true">⚠️</span>
            <span>Your teacher asked you to check this entry: <strong>${escapeHtml(flagNote || 'Please review your scores')}</strong></span>
          </div>
        ` : ''}

        ${isSurpriseTask ? `
          <div style="grid-column: 1 / -1; margin-top: 4px;">
            <label class="sr-only" for="input-note-${escapeHtml(cat.id)}">${escapeHtml(cat.name)} notes</label>
            <input
              type="text"
              id="input-note-${escapeHtml(cat.id)}"
              class="form-input input-note"
              placeholder="Surprise Task notes or topic description..."
              value="${escapeHtml(noteVal)}"
              ${isLocked ? 'readonly disabled' : ''}
              ${lockReasonTooltip ? `title="${escapeHtml(lockReasonTooltip)}"` : ''}
              data-cat-id="${escapeHtml(cat.id)}"
              aria-label="${escapeHtml(cat.name)} notes"
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
 * Validates a single category row's inputs and updates its inline `.field-validation-msg` element.
 * Returns the error message string if invalid, or null if valid.
 */
function validateRowFields(row, flatMode = false) {
  if (!row) return null;
  const msgEl = row.querySelector('.field-validation-msg');
  const correctInput = row.querySelector('.input-correct');
  const totalInput = row.querySelector('.input-total');
  const timeInput = row.querySelector('.input-time');

  const correctRaw = correctInput?.value.trim() || '';
  const totalRaw = totalInput?.value.trim() || '';
  const timeRaw = timeInput?.value.trim() || '';

  let errorMsg = null;

  if (correctRaw !== '' || totalRaw !== '' || (!flatMode && timeRaw !== '')) {
    const correctNum = correctRaw !== '' ? Number(correctRaw) : null;
    const totalNum = totalRaw !== '' ? Number(totalRaw) : null;

    if (
      (correctRaw !== '' && (Number.isNaN(correctNum) || correctNum < 0)) ||
      (totalRaw !== '' && (Number.isNaN(totalNum) || totalNum < 0)) ||
      (!flatMode && timeRaw.startsWith('-'))
    ) {
      errorMsg = 'Numbers cannot be negative.';
    } else if (
      (correctRaw !== '' && !Number.isInteger(correctNum)) ||
      (totalRaw !== '' && !Number.isInteger(totalNum))
    ) {
      errorMsg = 'Enter whole numbers only.';
    } else if (correctNum !== null && totalNum !== null && correctNum > totalNum) {
      errorMsg = 'Correct answers cannot be more than attempted.';
    } else if (correctNum !== null && correctNum > 0 && totalRaw !== '' && totalNum <= 0) {
      errorMsg = 'Total attempted must be greater than 0 when entering correct answers.';
    } else if (!flatMode && timeRaw !== '' && parseTimeToSeconds(timeRaw) === null) {
      errorMsg = 'Enter time as mm:ss or seconds.';
    }
  }

  if (msgEl) {
    if (errorMsg) {
      msgEl.textContent = errorMsg;
      msgEl.style.display = 'block';
    } else {
      msgEl.textContent = '';
      msgEl.style.display = 'none';
    }
  }

  if (correctInput) {
    correctInput.setAttribute('aria-invalid', errorMsg ? 'true' : 'false');
  }
  if (totalInput) {
    totalInput.setAttribute('aria-invalid', errorMsg ? 'true' : 'false');
  }

  return errorMsg;
}

/**
 * Checks whether a single row is dirty compared to initialRowValues
 */
function isRowDirty(row, flatMode) {
  if (!row) return false;
  const catId = row.getAttribute('data-category-id');
  const initial = JSON.parse(initialRowValues.get(catId) || '{}');
  if (initial.isLocked) return false;

  const correctRaw = row.querySelector('.input-correct')?.value.trim() || '';
  const totalRaw = row.querySelector('.input-total')?.value.trim() || '';
  const timeRaw = row.querySelector('.input-time')?.value.trim() || '';
  const noteRaw = row.querySelector('.input-note')?.value.trim() || '';

  if (flatMode) {
    return (
      correctRaw !== String(initial.correct ?? '') ||
      totalRaw !== String(initial.total ?? '') ||
      noteRaw !== String(initial.note ?? '')
    );
  }
  return (
    correctRaw !== String(initial.correct ?? '') ||
    totalRaw !== String(initial.total ?? '') ||
    timeRaw !== String(initial.time ?? '') ||
    noteRaw !== String(initial.note ?? '')
  );
}

/**
 * Updates each row's status chip ("Not entered" / "Saved" / "Edited - not saved")
 * and returns the total number of unsaved changes (dirty rows + dirty header metadata).
 */
function recalculateUnsavedChanges() {
  const typeSelect = document.getElementById('input-round-type');
  const timeTakenInput = document.getElementById('input-round-time-taken');
  const currentRoundType = (typeSelect?.value || 'Category wise').trim();
  const currentTimeTaken = (timeTakenInput?.value || '').trim();
  const flatMode = isFlatRound(currentRoundType);

  let unsavedCount = 0;

  if (
    selectedRoundId &&
    (currentRoundType !== initialRoundMeta.round_type ||
      currentTimeTaken !== initialRoundMeta.time_taken)
  ) {
    unsavedCount += 1;
  }

  const rows = document.querySelectorAll('#score-rows-container .score-entry-row');
  rows.forEach(row => {
    const catId = row.getAttribute('data-category-id');
    const initial = JSON.parse(initialRowValues.get(catId) || '{}');
    const dirty = isRowDirty(row, flatMode);
    if (dirty) {
      unsavedCount += 1;
    }

    const statusCell = row.querySelector('.cell-status');
    if (statusCell) {
      statusCell.innerHTML = buildRowStatusChipHtml({
        isVerified: Boolean(initial.isVerified),
        isCorrected: Boolean(initial.isCorrected),
        isOlderThan7Days: Boolean(initial.isOlderThan7Days),
        isDirty: dirty,
        hasExisting: Boolean(initial.hasExisting)
      });
    }
  });

  updateUnsavedCountUI(unsavedCount);
  return unsavedCount;
}

function updateUnsavedCountUI(count) {
  const label = `${count} unsaved ${count === 1 ? 'change' : 'changes'}`;
  const topBadge = document.getElementById('unsaved-changes-badge');
  const bottomBadge = document.getElementById('unsaved-changes-bottom');
  if (topBadge) topBadge.textContent = label;
  if (bottomBadge) bottomBadge.textContent = label;
}

/**
 * Attach input listeners for live score calculations, validation, unsaved count, and time formatting
 */
function attachLiveInputListeners() {
  const container = document.getElementById('score-rows-container');
  const getFlatMode = () => {
    const typeSelect = document.getElementById('input-round-type');
    return isFlatRound(typeSelect?.value || initialRoundMeta.round_type);
  };

  container.querySelectorAll('.input-correct, .input-total, .input-time, .input-note').forEach(input => {
    input.addEventListener('input', () => {
      const catId = input.getAttribute('data-cat-id');
      const row = container.querySelector(`[data-category-id="${catId}"]`);
      if (!row) return;

      const correctInput = row.querySelector('.input-correct');
      const totalInput = row.querySelector('.input-total');
      const badge = row.querySelector('.feedback-badge');

      const correctVal = correctInput?.value.trim() || '';
      const totalVal = totalInput?.value.trim() || '';

      if (badge) {
        const feedback = getScoreFeedback(correctVal, totalVal);
        badge.textContent = feedback.wrongText;
        badge.className = `score-tag ${feedback.badgeClass} feedback-badge`;
      }

      validateRowFields(row, getFlatMode());
      updateProgressDisplay();
      recalculateUnsavedChanges();
    });
  });

  // Time format on blur
  container.querySelectorAll('.input-time').forEach(input => {
    input.addEventListener('blur', () => {
      const raw = input.value.trim();
      const catId = input.getAttribute('data-cat-id');
      const row = container.querySelector(`[data-category-id="${catId}"]`);
      if (raw) {
        const seconds = parseTimeToSeconds(raw);
        if (seconds !== null) {
          input.value = formatSecondsToMMSS(seconds);
        }
      }
      if (row) {
        validateRowFields(row, getFlatMode());
      }
      recalculateUnsavedChanges();
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

function showSaveErrorAlert(message) {
  const alertEl = document.getElementById('round-save-error-alert');
  const msgEl = document.getElementById('round-save-error-msg');
  if (!alertEl || !msgEl) return;
  msgEl.textContent = message;
  alertEl.style.display = 'flex';
}

function hideSaveErrorAlert() {
  const alertEl = document.getElementById('round-save-error-alert');
  const msgEl = document.getElementById('round-save-error-msg');
  if (alertEl) alertEl.style.display = 'none';
  if (msgEl) msgEl.textContent = '';
}

function showUnsavedLeaveBanner(onConfirmDiscard) {
  const banner = document.getElementById('unsaved-leave-banner');
  if (!banner) return;
  pendingNavigationCallback = onConfirmDiscard;
  banner.style.display = 'flex';
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideUnsavedLeaveBanner() {
  const banner = document.getElementById('unsaved-leave-banner');
  if (banner) banner.style.display = 'none';
  pendingNavigationCallback = null;
}

/**
 * Save round metadata (round_type, time_taken_seconds) and modified/new score rows
 */
async function saveRoundScores() {
  if (!selectedRoundId) {
    showToast('info', "Please click '+ Start today's round' first.");
    return;
  }

  hideSaveErrorAlert();

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

    // 2. Check score rows and run field-level validation
    const flatMode = isFlatRound(newRoundType);
    const rows = Array.from(document.querySelectorAll('#score-rows-container .score-entry-row'));
    const updates = [];
    const inserts = [];

    for (const row of rows) {
      const catId = row.getAttribute('data-category-id');
      const initial = JSON.parse(initialRowValues.get(catId) || '{}');

      // Skip locked rows (verified, corrected by teacher, or older than 7 days)
      if (initial.isLocked || initial.isVerified || initial.isCorrected || initial.isOlderThan7Days) continue;

      const isDirty = isRowDirty(row, flatMode);
      if (!isDirty) continue;

      const correctRaw = row.querySelector('.input-correct')?.value.trim() || '';
      const totalRaw = row.querySelector('.input-total')?.value.trim() || '';
      const timeRaw = row.querySelector('.input-time')?.value.trim() || '';
      const noteRaw = row.querySelector('.input-note')?.value.trim() || '';

      if (flatMode) {
        if (correctRaw === '' && totalRaw === '' && noteRaw === '') {
          continue;
        }
      } else {
        if (correctRaw === '' && totalRaw === '' && timeRaw === '' && noteRaw === '') {
          continue;
        }
      }

      const rowValidationError = validateRowFields(row, flatMode);
      if (rowValidationError) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        throw new Error(rowValidationError);
      }

      const correctNum = correctRaw !== '' ? parseInt(correctRaw, 10) : null;
      const totalNum = totalRaw !== '' ? parseInt(totalRaw, 10) : null;
      const timeSeconds = !flatMode && timeRaw !== '' ? parseTimeToSeconds(timeRaw) : null;

      if (correctNum !== null && (totalNum === null || totalNum <= 0)) {
        const msgEl = row.querySelector('.field-validation-msg');
        const msg = 'Total attempted must be greater than 0 when entering correct answers.';
        if (msgEl) {
          msgEl.textContent = msg;
          msgEl.style.display = 'block';
        }
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        throw new Error(msg);
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
    } else if (DemoDB) {
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
    const friendly = formatFriendlyRoundError(err);
    // Keep every typed value intact, show alert (role="alert") with "Try again"
    showSaveErrorAlert(friendly);
    showToast('error', friendly);
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

  // Format round time taken on blur & track unsaved changes
  const timeTakenInput = document.getElementById('input-round-time-taken');
  timeTakenInput?.addEventListener('input', () => {
    recalculateUnsavedChanges();
  });
  timeTakenInput?.addEventListener('blur', () => {
    const raw = timeTakenInput.value.trim();
    if (raw) {
      const sec = parseTimeToSeconds(raw);
      if (sec !== null) {
        timeTakenInput.value = formatSecondsToMMSS(sec);
      }
    }
    recalculateUnsavedChanges();
  });

  // Round selection change (asks confirmation if there are unsaved changes)
  const selectRoundEl = document.getElementById('select-round');
  selectRoundEl?.addEventListener('change', async (e) => {
    const targetRoundId = e.target.value;
    const unsaved = recalculateUnsavedChanges();
    if (unsaved > 0) {
      // Revert select value until confirmed
      selectRoundEl.value = selectedRoundId || '';
      showUnsavedLeaveBanner(async () => {
        selectedRoundId = targetRoundId;
        if (selectRoundEl) selectRoundEl.value = selectedRoundId;
        if (selectedRoundId) {
          renderSelectedRoundMeta();
          await loadRoundResults();
        }
      });
      return;
    }

    selectedRoundId = targetRoundId;
    if (selectedRoundId) {
      renderSelectedRoundMeta();
      await loadRoundResults();
    }
  });

  // Round type change updates the screen immediately without losing typed values
  document.getElementById('input-round-type')?.addEventListener('change', (e) => {
    applyRoundTypeVisibility(e.target.value);
    recalculateUnsavedChanges();
  });

  // Start today's round button
  document.getElementById('btn-start-today-round')?.addEventListener('click', handleStartTodayRound);

  // Save buttons & Retry button in error alert
  document.getElementById('btn-save-round')?.addEventListener('click', saveRoundScores);
  document.getElementById('btn-save-round-bottom')?.addEventListener('click', saveRoundScores);
  document.getElementById('btn-retry-save-round')?.addEventListener('click', saveRoundScores);

  // Unsaved leave confirmation banner buttons
  document.getElementById('btn-leave-stay')?.addEventListener('click', () => {
    hideUnsavedLeaveBanner();
  });
  document.getElementById('btn-leave-discard')?.addEventListener('click', () => {
    const cb = pendingNavigationCallback;
    hideUnsavedLeaveBanner();
    if (typeof cb === 'function') {
      cb();
    }
  });

  // Intercept navigation links when there are unsaved changes
  document.querySelectorAll('a[href]').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      const unsaved = recalculateUnsavedChanges();
      if (unsaved > 0) {
        e.preventDefault();
        showUnsavedLeaveBanner(() => {
          updateUnsavedCountUI(0);
          initialRowValues.clear();
          window.location.href = href;
        });
      }
    });
  });

  // Browser tab close / reload confirmation when there are unsaved changes
  window.addEventListener('beforeunload', (e) => {
    const unsaved = recalculateUnsavedChanges();
    if (unsaved > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Initial load
  await loadCurrentSeriesAndToday();
  await loadStudentRounds();
}

document.addEventListener('DOMContentLoaded', initRoundScores);
