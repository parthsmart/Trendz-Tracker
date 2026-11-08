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
import { ScoresheetController } from './roundScoresheet.js';
import {
  JMCWC_UNASSIGNED_GROUP_MESSAGE,
  formatJmcwcGroupLabel,
  formatJmcwcCategoryTitle,
  formatActiveDurationMs,
  formatDurationSeconds,
  formatNeutralTargetComparison,
  resolveManualCategoryTargetSeconds,
  computeMonotonicTimerState,
  buildLandingPageViewModel,
  describeQuestionInputSpec,
  splitMultiValueRaw,
  joinMultiValueRaw,
  buildSubmittedReviewViewModel,
  formatOnlineAttemptsForRoundHistory,
  createJmcwcRunnerController,
} from './jmcwcClient.js';

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

// Phase 17c JMCWC Online Practice state
let activeRoundScoresMode = 'manual'; // 'manual' | 'online'
let jmcwcOverviewData = null;
let jmcwcCategoriesList = [];
let jmcwcTargetsMap = {};
let jmcwcOnlineAttempts = [];
let jmcwcRunner = null;
let jmcwcCurrentSectionOrder = 1;
let jmcwcCurrentQuestionIndex = 0;
let pendingTakeoverAttemptId = null;
let isSubmittingPausedAttempt = false;
let scoresheetControllerInstance = null;

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
      renderCombinedRoundHistory();
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
    renderCombinedRoundHistory();
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
        ${existing?.id ? `data-result-id="${escapeHtml(existing.id)}"` : ''}
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

        <!-- Time Input (mm:ss or seconds) + Current Configured Target -->
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
          ${(() => {
            const targetSec = resolveManualCategoryTargetSeconds(cat, jmcwcCategoriesList, jmcwcTargetsMap);
            if (!targetSec) return '';
            const actualSec = existing && existing.time_seconds !== null && existing.time_seconds !== undefined
              ? Number(existing.time_seconds)
              : null;
            const comp = actualSec !== null ? formatNeutralTargetComparison(actualSec * 1000, targetSec) : null;
            return `
              <div class="num manual-cat-target-note" data-target-for="${escapeHtml(cat.id)}" data-target-sec="${targetSec}" style="font-size: 11px; color: var(--text-muted); margin-top: 3px; text-align: right;">
                ${escapeHtml(comp ? comp.comparisonText : `Target: ${formatDurationSeconds(targetSec)}`)}
              </div>
            `;
          })()}
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
  if (topBadge) {
    topBadge.textContent = label;
    topBadge.className = count > 0 ? 'badge badge-warning num' : 'badge badge-inactive num';
  }
  if (bottomBadge) {
    bottomBadge.textContent = label;
    bottomBadge.style.color = count > 0 ? 'var(--color-warning)' : 'var(--text-muted)';
    bottomBadge.style.borderColor = count > 0 ? '#fde68a' : 'var(--border-subtle)';
    bottomBadge.style.background = count > 0 ? 'var(--color-warning-subtle)' : 'var(--bg-surface)';
  }
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

  // Time format on blur & live neutral target comparison in manual entry
  container.querySelectorAll('.input-time').forEach(input => {
    const updateManualTargetNote = () => {
      const catId = input.getAttribute('data-cat-id');
      const noteEl = container.querySelector(`.manual-cat-target-note[data-target-for="${catId}"]`);
      if (!noteEl) return;
      const targetSec = Number(noteEl.getAttribute('data-target-sec')) || null;
      if (!targetSec) return;
      const raw = input.value.trim();
      const parsedSec = raw ? parseTimeToSeconds(raw) : null;
      if (parsedSec !== null) {
        const comp = formatNeutralTargetComparison(parsedSec * 1000, targetSec);
        noteEl.textContent = comp.comparisonText;
      } else {
        noteEl.textContent = `Target: ${formatDurationSeconds(targetSec)}`;
      }
    };
    input.addEventListener('input', updateManualTargetNote);
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
      updateManualTargetNote();
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
  const msgEl = document.getElementById('round-save-error-msg') || document.getElementById('round-save-error-text');
  if (!alertEl || !msgEl) return;
  msgEl.textContent = message;
  alertEl.style.display = 'flex';
}

function hideSaveErrorAlert() {
  const alertEl = document.getElementById('round-save-error-alert');
  const msgEl = document.getElementById('round-save-error-msg') || document.getElementById('round-save-error-text');
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
    stopRunnerSchedulers();
    if (jmcwcRunner) {
      try {
        await jmcwcRunner.pauseAttempt();
      } catch {
        // Best effort pause on sign-out
      }
    }
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
  await loadJmcwcOverviewAndAttempts();
  await loadStudentRounds();
  renderCombinedRoundHistory();
  setupJmcwcOnlinePracticeUI();
  await handleRoundScoresUrlParams();
}

/**
 * Handles incoming URL query parameters for round scores linking:
 * - ?roundId=<uuid>
 * - ?resultId=<uuid>
 * - Verifies recipient ownership and record existence
 * - Selects the referenced round in the UI
 * - Highlights the referenced result or category row
 * - Shows a user-facing toast error for missing or unauthorized records
 */
export async function handleRoundScoresUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const resultId = urlParams.get('resultId');
  const roundId = urlParams.get('roundId');
  if (!resultId && !roundId) return;

  const activeProfile = currentProfile || (isDemoMode() ? (JSON.parse(localStorage.getItem('trendz_current_user') || 'null') || { id: 'usr-101', role: 'student' }) : null);
  let targetRoundId = roundId || null;
  let targetCategoryId = null;

  // If resultId is provided, look up the score row to verify ownership and find the round
  if (resultId) {
    let resRow = null;
    if (isSupabaseConfigured()) {
      try {
        const supabase = await getSupabase();
        if (supabase) {
          const { data, error } = await supabase
            .from('results')
            .select('id, student_id, student_round_id, category_id')
            .eq('id', resultId)
            .maybeSingle();

          if (error || !data) {
            showToast('error', 'The referenced round score could not be found.');
            return;
          }
          resRow = data;
        }
      } catch {
        showToast('error', 'The referenced round score could not be found.');
        return;
      }
    } else if (DemoDB) {
      const allResults = typeof DemoDB.getResults === 'function'
        ? DemoDB.getResults()
        : DemoDB.results || JSON.parse(localStorage.getItem('trendz_demo_results_v3') || localStorage.getItem('tt_results') || '[]');
      resRow = allResults.find((r) => String(r.id) === String(resultId)) || null;
    }

    if (!resRow) {
      showToast('error', 'The referenced round score could not be found.');
      return;
    }

    if (activeProfile?.role !== 'admin' && resRow.student_id && resRow.student_id !== activeProfile?.id) {
      showToast('error', 'You do not have permission to view this round score.');
      return;
    }

    targetRoundId = targetRoundId || resRow.student_round_id;
    targetCategoryId = resRow.category_id;
  }

  // If we have a targetRoundId, verify its existence and ownership
  if (targetRoundId) {
    let roundRow = studentRounds.find((r) => String(r.id) === String(targetRoundId));

    if (!roundRow) {
      if (isSupabaseConfigured()) {
        try {
          const supabase = await getSupabase();
          if (supabase) {
            const { data, error } = await supabase
              .from('student_rounds')
              .select('id, student_id, round_number, round_date, series_id')
              .eq('id', targetRoundId)
              .maybeSingle();

            if (error || !data) {
              showToast('error', 'The referenced round could not be found.');
              return;
            }
            roundRow = data;
          }
        } catch {
          showToast('error', 'The referenced round could not be found.');
          return;
        }
      } else if (DemoDB) {
        const allRounds = typeof DemoDB.getAllStudentRounds === 'function'
          ? DemoDB.getAllStudentRounds()
          : DemoDB.student_rounds || JSON.parse(localStorage.getItem('trendz_demo_student_rounds_v1') || localStorage.getItem('tt_student_rounds') || '[]');
        roundRow = allRounds.find((r) => String(r.id) === String(targetRoundId)) || null;
      }
    }

    if (!roundRow) {
      showToast('error', 'The referenced round could not be found.');
      return;
    }

    if (activeProfile?.role !== 'admin' && roundRow.student_id && roundRow.student_id !== activeProfile?.id) {
      showToast('error', 'You do not have permission to view this round.');
      return;
    }

    // Switch to manual mode if in online mode
    if (activeRoundScoresMode !== 'manual' && typeof switchRoundScoresMode === 'function') {
      await switchRoundScoresMode('manual');
    }

    // If the round is in studentRounds, select it if not already selected
    if (studentRounds.some((r) => String(r.id) === String(targetRoundId))) {
      if (String(selectedRoundId) !== String(targetRoundId)) {
        selectedRoundId = targetRoundId;
        const selectRoundEl = document.getElementById('select-round');
        if (selectRoundEl) selectRoundEl.value = targetRoundId;
        renderSelectedRoundMeta();
        await loadRoundResults();
      }
    } else {
      // Round exists and belongs to student, but might belong to an archived series
      showToast('info', 'The referenced round belongs to another simulator series.');
    }
  }

  // Highlight the referenced result or category row
  setTimeout(() => {
    let rowEl = null;
    if (resultId) {
      rowEl = document.querySelector(`[data-result-id="${resultId}"]`);
    }
    if (!rowEl && targetCategoryId) {
      rowEl = document.querySelector(`[data-category-id="${targetCategoryId}"]`);
    }
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowEl.classList.add('row-linked-highlight');
      rowEl.style.outline = '2px solid var(--color-primary, #4338CA)';
      rowEl.style.backgroundColor = 'var(--bg-highlight, rgba(99, 102, 241, 0.12))';
      setTimeout(() => {
        rowEl.style.transition = 'background-color 2s ease, outline 2s ease';
        rowEl.style.backgroundColor = '';
        rowEl.style.outline = '';
      }, 3500);
    }
  }, 150);
}

// ============================================================================
// Phase 17c — JMCWC Online Practice & Combined History Controller
// ============================================================================

async function getJmcwcBearerToken() {
  if (!isSupabaseConfigured()) return '';
  try {
    const supabase = await getSupabase();
    if (!supabase) return '';
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || '';
  } catch {
    return '';
  }
}

export function parseJmcwcApiError(response, data) {
  const errorMessage =
    (typeof data?.error === 'string' && data.error) ||
    data?.error?.message ||
    data?.message ||
    `Request failed (${response?.status || 500})`;
  const errorCode = data?.code || data?.error?.code || (response?.status === 403 ? 'FORBIDDEN' : 'API_ERROR');
  const err = new Error(errorMessage);
  err.status = response?.status || 500;
  err.code = errorCode;
  return err;
}

export async function callJmcwcApi(payload) {
  const token = await getJmcwcBearerToken();
  if (!token) {
    throw new Error('Authentication required for JMCWC online practice.');
  }
  const response = await fetch('/api/jmcwc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    throw parseJmcwcApiError(response, data);
  }
  return data;
}

async function loadJmcwcOverviewAndAttempts() {
  const groupBadge = document.getElementById('jmcwc-assigned-group-badge');
  if (!isSupabaseConfigured()) {
    // In Demo Mode or unconfigured environment, online practice remains unavailable
    jmcwcOverviewData = {
      assigned_group: null,
      paper: null,
      categories: [],
      targets: {},
      unfinished_flat_count: 0,
      active_attempt_id: null,
    };
    jmcwcOnlineAttempts = [];
    renderJmcwcLandingState();
    return;
  }

  try {
    const overviewRes = await callJmcwcApi({ action: 'get_practice_overview' });
    let attemptsRes = { attempts: [] };
    // Only call assignment-dependent endpoints if the student has an assigned group
    if (overviewRes?.assigned !== false && overviewRes?.group_key) {
      attemptsRes = await callJmcwcApi({ action: 'list_attempts', limit: 50 });
    }

    jmcwcOverviewData = overviewRes;
    jmcwcCategoriesList = Array.isArray(overviewRes.categories) ? overviewRes.categories : [];
    jmcwcTargetsMap = overviewRes.targets && typeof overviewRes.targets === 'object' ? overviewRes.targets : {};
    jmcwcOnlineAttempts = Array.isArray(attemptsRes.attempts) ? attemptsRes.attempts : [];

    // Re-render manual category rows if already mounted so target labels appear
    if (roundCategories.length > 0 && selectedRoundId) {
      renderCategoryRows();
    }
  } catch (err) {
    console.warn('JMCWC overview check:', err.message);
    if (groupBadge) {
      groupBadge.textContent = 'JMCWC Group: Unassigned';
    }
    jmcwcOverviewData = {
      assigned_group: null,
      paper: null,
      categories: [],
      targets: {},
      unfinished_flat_count: 0,
      active_attempt_id: null,
    };
    jmcwcOnlineAttempts = [];
  }

  renderJmcwcLandingState();
  renderCombinedRoundHistory();
}

function showJmcwcOnlineError(msg) {
  const banner = document.getElementById('jmcwc-online-error-banner');
  const textEl = document.getElementById('jmcwc-online-error-text');
  if (!banner || !textEl) return;
  if (!msg) {
    banner.style.display = 'none';
    textEl.textContent = '';
    return;
  }
  textEl.textContent = msg;
  banner.style.display = 'flex';
}

function renderJmcwcLandingState() {
  const vm = buildLandingPageViewModel(jmcwcOverviewData || {}, jmcwcOnlineAttempts || []);

  const topGroupBadge = document.getElementById('jmcwc-assigned-group-badge');
  const onlineGroupLabel = document.getElementById('jmcwc-online-group-label');
  const unassignedBanner = document.getElementById('jmcwc-unassigned-banner');
  const unassignedText = document.getElementById('jmcwc-unassigned-text');
  const unavailableBanner = document.getElementById('jmcwc-unavailable-banner');
  const unavailableText = document.getElementById('jmcwc-unavailable-text');

  if (topGroupBadge) {
    topGroupBadge.textContent = vm.hasGroup
      ? `JMCWC Group: ${vm.groupLabel}`
      : 'JMCWC Group: Unassigned';
    topGroupBadge.className = vm.hasGroup ? 'badge badge-primary' : 'badge badge-neutral';
  }
  if (onlineGroupLabel) {
    onlineGroupLabel.textContent = vm.groupLabel;
  }

  if (unassignedBanner && unassignedText) {
    if (!vm.hasGroup) {
      unassignedText.textContent = vm.unassignedMessage || JMCWC_UNASSIGNED_GROUP_MESSAGE;
      unassignedBanner.style.display = 'flex';
    } else {
      unassignedBanner.style.display = 'none';
    }
  }

  if (unavailableBanner && unavailableText) {
    if (vm.hasGroup && !vm.hasPublishedPaper) {
      unavailableText.textContent = vm.paperUnavailableMessage || 'Online practice paper for your group is not published yet.';
      unavailableBanner.style.display = 'flex';
    } else {
      unavailableBanner.style.display = 'none';
    }
  }

  // Flat round card
  const flatSlotsBadge = document.getElementById('jmcwc-flat-slots-badge');
  const flatCapReason = document.getElementById('jmcwc-flat-cap-reason');
  const btnStartFlat = document.getElementById('btn-jmcwc-start-flat');
  const paperQcountEl = document.getElementById('jmcwc-landing-paper-qcount');

  if (paperQcountEl) {
    const fallbackTotal = Array.isArray(vm.categories)
      ? vm.categories.reduce((acc, c) => acc + (Number(c.question_count) || 0), 0)
      : 0;
    const resolvedQcount =
      vm.totalPaperQuestions != null && vm.totalPaperQuestions > 0
        ? vm.totalPaperQuestions
        : fallbackTotal > 0
          ? fallbackTotal
          : null;
    paperQcountEl.textContent = resolvedQcount != null ? String(resolvedQcount) : 'all';
  }

  if (flatSlotsBadge) {
    flatSlotsBadge.textContent = `${vm.unfinishedFlatCount} / ${vm.maxUnfinishedFlatRounds} unfinished`;
  }
  if (flatCapReason) {
    if (vm.newFlatDisabledReason && vm.unfinishedFlatCount >= vm.maxUnfinishedFlatRounds) {
      flatCapReason.textContent = vm.newFlatDisabledReason;
      flatCapReason.style.display = 'block';
    } else {
      flatCapReason.style.display = 'none';
      flatCapReason.textContent = '';
    }
  }
  if (btnStartFlat) {
    btnStartFlat.disabled = !vm.canStartNewFlat;
    btnStartFlat.title = vm.newFlatDisabledReason || 'Start a new 23-category JMCWC flat round';
  }

  // Category-wise card
  const catSelect = document.getElementById('select-jmcwc-category');
  const catTargetPreview = document.getElementById('jmcwc-category-target-preview');
  const btnStartCat = document.getElementById('btn-jmcwc-start-category');
  const catBadgeEl = document.getElementById('jmcwc-landing-category-qcount');

  if (catSelect) {
    const prevVal = catSelect.value;
    if (vm.categories.length === 0) {
      catSelect.innerHTML = '<option value="">No categories available</option>';
      catSelect.disabled = true;
      if (catBadgeEl) catBadgeEl.textContent = 'Practice';
    } else {
      catSelect.innerHTML = vm.categories.map(c => {
        const qCountStr = c.question_count != null ? ` (${c.question_count} questions)` : '';
        const targetStr = c.target_seconds ? ` (Target: ${c.target_formatted})` : '';
        return `
          <option value="${escapeHtml(c.id)}">
            #${c.section_order} ${escapeHtml(c.display_name)}${qCountStr}${targetStr}
          </option>
        `;
      }).join('');
      if (prevVal && vm.categories.some(c => c.id === prevVal)) {
        catSelect.value = prevVal;
      }
      catSelect.disabled = !vm.canStartCategory;
    }

    const updateCatTargetPreview = () => {
      const selectedCat = vm.categories.find(c => c.id === catSelect.value);
      if (catBadgeEl) {
        catBadgeEl.textContent = selectedCat && selectedCat.question_count != null
          ? `${selectedCat.question_count} questions`
          : 'Practice';
      }
      if (catTargetPreview) {
        catTargetPreview.textContent = selectedCat && selectedCat.target_seconds
          ? `Optional target: ${selectedCat.target_formatted} (no time limit or penalty)`
          : 'Optional target: No target configured';
      }
    };
    catSelect.onchange = updateCatTargetPreview;
    updateCatTargetPreview();
  }

  if (btnStartCat) {
    btnStartCat.disabled = !vm.canStartCategory || vm.categories.length === 0;
  }

  // Unfinished Flat Round cards
  const flatCardsContainer = document.getElementById('jmcwc-unfinished-flat-cards');
  if (flatCardsContainer) {
    if (vm.unfinishedFlatCards.length === 0) {
      flatCardsContainer.innerHTML = `<div style="font-size: var(--text-xs); color: var(--text-muted);">No unfinished flat rounds.</div>`;
    } else {
      flatCardsContainer.innerHTML = vm.unfinishedFlatCards.map(card => `
        <div class="card" style="padding: var(--space-4); border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle); display: flex; flex-direction: column; justify-content: space-between; gap: var(--space-3);">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
              <span class="badge ${card.status === 'running' ? 'badge-active' : 'badge-warning'}">${escapeHtml(card.status === 'running' ? 'Running' : 'Paused')}</span>
              <span class="num" style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(formatDisplayDateIST((card.started_at || '').slice(0, 10)))}</span>
            </div>
            <div class="num" style="font-size: var(--text-sm); font-weight: 700; color: var(--text-main); margin-bottom: 4px;">
              Answered: ${card.answered_count} / ${card.question_count}
            </div>
            <div class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
              Active time used: <strong>${escapeHtml(card.active_time_formatted)}</strong>
            </div>
            <div class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
              Remaining time: <strong>${escapeHtml(card.remaining_time_formatted)}</strong>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm btn-jmcwc-resume-attempt"
            data-attempt-id="${escapeHtml(card.id)}"
            style="width: 100%; min-height: 38px;"
          >
            Resume
          </button>
        </div>
      `).join('');

      flatCardsContainer.querySelectorAll('.btn-jmcwc-resume-attempt').forEach(btn => {
        btn.addEventListener('click', () => {
          const attemptId = btn.getAttribute('data-attempt-id');
          if (attemptId) handleResumeOnlineAttempt(attemptId, false);
        });
      });
    }
  }

  // Unfinished Category Practice cards
  const catSection = document.getElementById('jmcwc-unfinished-cat-section');
  const catCardsContainer = document.getElementById('jmcwc-unfinished-cat-cards');
  if (catSection && catCardsContainer) {
    if (vm.unfinishedCategoryCards.length === 0) {
      catSection.style.display = 'none';
      catCardsContainer.innerHTML = '';
    } else {
      catSection.style.display = 'block';
      catCardsContainer.innerHTML = vm.unfinishedCategoryCards.map(card => `
        <div class="card" style="padding: var(--space-4); border: 1px solid var(--border-subtle); background: var(--bg-surface-subtle); display: flex; flex-direction: column; justify-content: space-between; gap: var(--space-3);">
          <div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); margin-bottom: var(--space-2);">
              <span class="badge badge-neutral">${escapeHtml(card.category_name)}</span>
              <span class="num" style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(formatDisplayDateIST((card.started_at || '').slice(0, 10)))}</span>
            </div>
            <div class="num" style="font-size: var(--text-xs); color: var(--text-muted);">
              Answered: <strong>${card.answered_count} / ${card.question_count}</strong> · Elapsed: <strong>${escapeHtml(card.active_time_formatted)}</strong>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-jmcwc-resume-cat"
            data-attempt-id="${escapeHtml(card.id)}"
            style="width: 100%; min-height: 38px;"
          >
            Resume Category
          </button>
        </div>
      `).join('');

      catCardsContainer.querySelectorAll('.btn-jmcwc-resume-cat').forEach(btn => {
        btn.addEventListener('click', () => {
          const attemptId = btn.getAttribute('data-attempt-id');
          if (attemptId) handleResumeOnlineAttempt(attemptId, false);
        });
      });
    }
  }
}

/**
 * Renders the Combined Round Scores History table with `Manual` and `Online` labels.
 * Preserves legacy manual round numbering and restrictions, and never merges online weighted marks
 * into legacy accuracy, Points leaderboard, or weekly-test scores.
 */
function renderCombinedRoundHistory() {
  const tbody = document.getElementById('round-history-tbody');
  if (!tbody) return;

  const manualEntries = (studentRounds || []).map(r => ({
    source: 'Manual',
    id: r.id,
    title: `Round ${r.round_number}`,
    dateStr: r.round_date || (r.created_at ? r.created_at.slice(0, 10) : ''),
    sortMs: r.round_date ? Date.parse(r.round_date) : (r.created_at ? Date.parse(r.created_at) : 0),
    modeLabel: r.round_type || 'Category wise',
    timeText: r.time_taken_seconds !== null && r.time_taken_seconds !== undefined
      ? formatSecondsToMMSS(r.time_taken_seconds)
      : '—',
    summaryText: currentSeries ? `${currentSeries.name} (Manual series)` : 'Manual series round',
    status: 'manual',
  }));

  const onlineFormatted = formatOnlineAttemptsForRoundHistory(
    jmcwcOnlineAttempts || [],
    jmcwcCategoriesList || []
  ).map(o => ({
    source: 'Online',
    id: o.id,
    title: o.mode_label,
    dateStr: (o.date_iso || '').slice(0, 10),
    sortMs: o.date_iso ? Date.parse(o.date_iso) : 0,
    modeLabel: `${formatJmcwcGroupLabel(o.group_key)} · ${o.mode === 'flat' ? 'Flat Round' : 'Category-wise'}`,
    timeText: o.active_time_formatted,
    summaryText: o.is_submitted && o.marks_text
      ? `Marks: ${o.marks_text} (frozen max) · ${o.correct_count || 0} correct, ${o.partial_count || 0} partial`
      : `Unfinished (${o.status})`,
    status: o.status,
    is_submitted: o.is_submitted,
  }));

  const combined = [...manualEntries, ...onlineFormatted].sort((a, b) => (b.sortMs || 0) - (a.sortMs || 0));

  if (combined.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); font-size: var(--text-xs); padding: var(--space-4);">
          No manual or online rounds recorded yet.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = combined.map(item => `
    <tr>
      <td>
        <span class="badge ${item.source === 'Online' ? 'badge-primary' : 'badge-neutral'}">
          ${escapeHtml(item.source)}
        </span>
      </td>
      <td style="font-weight: 700; color: var(--text-main);">
        ${escapeHtml(item.title)}
      </td>
      <td class="num" style="color: var(--text-muted);">
        ${escapeHtml(item.dateStr ? formatDisplayDateIST(item.dateStr) : '—')}
      </td>
      <td>
        ${escapeHtml(item.modeLabel)}
      </td>
      <td class="num">
        ${escapeHtml(item.timeText)}
      </td>
      <td class="num" style="font-size: var(--text-xs);">
        ${escapeHtml(item.summaryText)}
      </td>
      <td style="text-align: right;">
        ${item.source === 'Manual' ? `
          <button
            type="button"
            class="btn btn-outline btn-sm btn-history-open-manual"
            data-round-id="${escapeHtml(item.id)}"
          >
            Open Manual
          </button>
        ` : item.is_submitted ? `
          <button
            type="button"
            class="btn btn-outline btn-sm btn-history-open-review"
            data-attempt-id="${escapeHtml(item.id)}"
          >
            Review
          </button>
        ` : `
          <button
            type="button"
            class="btn btn-primary btn-sm btn-history-resume-online"
            data-attempt-id="${escapeHtml(item.id)}"
          >
            Resume
          </button>
        `}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-history-open-manual').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rId = btn.getAttribute('data-round-id');
      await switchRoundScoresMode('manual');
      if (rId) {
        const selectEl = document.getElementById('select-round');
        if (selectEl) {
          selectEl.value = rId;
          selectEl.dispatchEvent(new Event('change'));
        }
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  tbody.querySelectorAll('.btn-history-open-review').forEach(btn => {
    btn.addEventListener('click', async () => {
      const attemptId = btn.getAttribute('data-attempt-id');
      await switchRoundScoresMode('online');
      if (attemptId) {
        await handleOpenCompletedReview(attemptId);
      }
    });
  });

  tbody.querySelectorAll('.btn-history-resume-online').forEach(btn => {
    btn.addEventListener('click', async () => {
      const attemptId = btn.getAttribute('data-attempt-id');
      await switchRoundScoresMode('online');
      if (attemptId) {
        await handleResumeOnlineAttempt(attemptId, false);
      }
    });
  });
}

async function ensureScoresheetMounted() {
  const container = document.getElementById('scoresheet-container');
  if (!container) return;
  if (!scoresheetControllerInstance) {
    scoresheetControllerInstance = new ScoresheetController({
      containerEl: container,
      currentProfile,
      todayIST,
      getSupabase,
      isDemo: !isSupabaseConfigured() && isDemoMode(),
      DemoDB,
      callJmcwcApi,
      showToast,
    });
    await scoresheetControllerInstance.init();
  } else {
    await scoresheetControllerInstance.loadAllStudentData();
    scoresheetControllerInstance.render();
  }
}

async function switchRoundScoresMode(targetMode) {
  if (targetMode === activeRoundScoresMode) return;

  if (activeRoundScoresMode === 'manual') {
    const unsaved = recalculateUnsavedChanges();
    if (unsaved > 0) {
      showUnsavedLeaveBanner(async () => {
        updateUnsavedCountUI(0);
        initialRowValues.clear();
        applyModeVisibility(targetMode);
        if (targetMode === 'preview') {
          await ensureScoresheetMounted();
        }
      });
      return;
    }
  } else if (activeRoundScoresMode === 'online' && jmcwcRunner) {
    const st = jmcwcRunner.getState();
    if (st.status === 'running') {
      await jmcwcRunner.pauseAttempt();
    }
  }

  applyModeVisibility(targetMode);
  if (targetMode === 'preview') {
    await ensureScoresheetMounted();
  }
}

function applyModeVisibility(mode) {
  activeRoundScoresMode = mode === 'online' ? 'online' : mode === 'preview' ? 'preview' : 'manual';
  const btnManual = document.getElementById('btn-mode-manual');
  const btnOnline = document.getElementById('btn-mode-online');
  const btnPreview = document.getElementById('btn-mode-preview');
  const manualPane = document.getElementById('jmcwc-manual-entry-pane');
  const onlinePane = document.getElementById('jmcwc-online-practice-pane');
  const previewPane = document.getElementById('main-round-preview-pane');
  const historyCard = document.getElementById('jmcwc-combined-history-card');

  if (btnManual && btnOnline) {
    btnManual.setAttribute('aria-selected', activeRoundScoresMode === 'manual' ? 'true' : 'false');
    btnOnline.setAttribute('aria-selected', activeRoundScoresMode === 'online' ? 'true' : 'false');
    if (btnPreview) {
      btnPreview.setAttribute('aria-selected', activeRoundScoresMode === 'preview' ? 'true' : 'false');
    }

    btnManual.className = activeRoundScoresMode === 'manual' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    btnOnline.className = activeRoundScoresMode === 'online' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    if (btnPreview) {
      btnPreview.className = activeRoundScoresMode === 'preview' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
    }
  }

  if (manualPane) manualPane.style.display = activeRoundScoresMode === 'manual' ? 'block' : 'none';
  if (onlinePane) onlinePane.style.display = activeRoundScoresMode === 'online' ? 'block' : 'none';
  if (previewPane) previewPane.style.display = activeRoundScoresMode === 'preview' ? 'block' : 'none';
  if (historyCard) historyCard.style.display = activeRoundScoresMode === 'preview' ? 'none' : 'block';
}

function showJmcwcSubview(subviewName) {
  const landing = document.getElementById('jmcwc-subview-landing');
  const runner = document.getElementById('jmcwc-subview-runner');
  const review = document.getElementById('jmcwc-subview-review');

  if (landing) landing.style.display = subviewName === 'landing' ? 'block' : 'none';
  if (runner) runner.style.display = subviewName === 'runner' ? 'block' : 'none';
  if (review) review.style.display = subviewName === 'review' ? 'block' : 'none';
}

function ensureJmcwcRunnerInstance() {
  if (jmcwcRunner) return jmcwcRunner;
  jmcwcRunner = createJmcwcRunnerController({
    userId: currentProfile?.id || '',
    getBearerToken: getJmcwcBearerToken,
    onStateChange: (state) => {
      renderJmcwcRunnerState(state);
    },
  });
  return jmcwcRunner;
}

function getRunnerQuestionsInOrder(state) {
  const sections = Array.isArray(state?.questions) ? state.questions : [];
  const flatQuestions = [];
  for (const sec of sections) {
    const qList = Array.isArray(sec.questions) ? sec.questions : [];
    for (const q of qList) {
      flatQuestions.push({
        ...q,
        section_order: sec.section_order,
        category_slug: sec.category_slug,
        category_name: sec.display_name || sec.category_slug,
      });
    }
  }
  return flatQuestions;
}

let jmcwcHeartbeatTimerId = null;
let jmcwcDisplayTimerId = null;
let jmcwcIsHeartbeatInFlight = false;
let jmcwcIsExpiryInFlight = false;
let jmcwcRunnerViewMode = 'worksheet'; // 'worksheet' | 'single'
let jmcwcRenderedWorksheetKey = null;

function formatWorksheetMathPromptHtml(promptStr) {
  if (!promptStr) return '';

  // Check if prompt is a pure stacked arithmetic problem ending in =
  // (Addition, Subtraction, Mixed adds/subs, Multiplication)
  const trimmed = String(promptStr).trim();
  if (/^(\d+)(\s*[\+\−\-\×\*]\s*\d+)+\s*=\s*$/.test(trimmed)) {
    const rawWithoutEqual = trimmed.replace(/\s*=\s*$/, '').trim();
    const tokenRegex = /([\+\−\-\×\*])?\s*(\d+)/g;
    const rows = [];
    let m;
    let isFirst = true;

    while ((m = tokenRegex.exec(rawWithoutEqual)) !== null) {
      const op = isFirst ? '' : (m[1] || '+');
      const num = m[2];
      rows.push({ op, num });
      isFirst = false;
    }

    if (rows.length >= 2) {
      const rowsHtml = rows
        .map(
          (r) =>
            `<div class="jmcwc-stacked-row"><span class="jmcwc-stacked-op">${escapeHtml(
              r.op
            )}</span><span class="jmcwc-stacked-num">${escapeHtml(r.num)}</span></div>`
        )
        .join('');
      return `<div class="jmcwc-stacked-math" role="math" aria-label="${escapeHtml(
        promptStr
      )}">${rowsHtml}<div class="jmcwc-stacked-line"></div></div>`;
    }
  }

  const escaped = escapeHtml(String(promptStr));

  // Format missing digit (?) or [?] boxes
  let formatted = escaped.replace(/(\(\?\)|\[\?\]|\?)/g, '<span class="jmcwc-missing-digit-box">?</span>');

  // Format fractions like 2 3/4 or 3/4
  formatted = formatted.replace(
    /(\d+)\s+(\d+)\/(\d+)/g,
    '$1 <span class="jmcwc-frac"><span class="jmcwc-num">$2</span><span class="jmcwc-den">$3</span></span>'
  );
  formatted = formatted.replace(
    /(^|[^\d])(\d+)\/(\d+)/g,
    '$1<span class="jmcwc-frac"><span class="jmcwc-num">$2</span><span class="jmcwc-den">$3</span></span>'
  );

  // Format roots
  formatted = formatted.replace(
    /√(\d+)/g,
    '<span class="jmcwc-root"><span class="jmcwc-radical">√</span><span class="jmcwc-radicand">$1</span></span>'
  );
  formatted = formatted.replace(
    /∛(\d+)/g,
    '<span class="jmcwc-root"><span class="jmcwc-radical">∛</span><span class="jmcwc-radicand">$1</span></span>'
  );

  // Format powers like 2^2 or 3^2
  formatted = formatted.replace(/(\d+)\^2/g, '$1²');
  formatted = formatted.replace(/(\d+)\^3/g, '$1³');

  return formatted;
}

function startRunnerSchedulers() {
  stopRunnerSchedulers();
  if (!jmcwcRunner) return;
  const st = jmcwcRunner.getState();
  if (st.status !== 'running' || st.questionsHidden) return;

  // 1. Regular monotonic timer update without rebuilding question inputs or losing focus
  jmcwcDisplayTimerId = setInterval(() => {
    if (!jmcwcRunner) return;
    const currentState = jmcwcRunner.getState();
    if (currentState.status !== 'running' || currentState.questionsHidden) {
      stopRunnerSchedulers();
      return;
    }

    const timer = jmcwcRunner.getTimerState();
    const timerValue = document.getElementById('jmcwc-runner-timer-value');
    if (timerValue) {
      timerValue.textContent =
        timer.mode === 'flat' ? timer.formattedRemaining : timer.formattedElapsed;
    }

    const targetCompEl = document.getElementById('jmcwc-runner-target-comparison');
    if (targetCompEl) {
      const isFlat = currentState.attempt?.mode === 'flat';
      const targetSec = resolveAttemptTargetSeconds(currentState.attempt);
      if (!isFlat && targetSec) {
        const comp = formatNeutralTargetComparison(timer.elapsedActiveMs, targetSec);
        targetCompEl.textContent = comp.comparisonText;
        targetCompEl.style.display = 'block';
      } else {
        targetCompEl.style.display = 'none';
      }
    }

    // Flat expiry detection: at 2 hours (7,200,000ms), immediately hide inputs and finalize
    if (timer.mode === 'flat' && timer.expired) {
      triggerFlatExpiry();
    }
  }, 250);

  // 2. Heartbeat every 10 seconds while running and visible
  jmcwcHeartbeatTimerId = setInterval(async () => {
    if (!jmcwcRunner) return;
    if (document.visibilityState !== 'visible') return;
    const currentState = jmcwcRunner.getState();
    if (currentState.status !== 'running' || currentState.questionsHidden) {
      stopRunnerSchedulers();
      return;
    }
    if (jmcwcIsHeartbeatInFlight) return; // Prevent overlapping requests
    jmcwcIsHeartbeatInFlight = true;
    try {
      await jmcwcRunner.sendHeartbeat();
    } catch (err) {
      console.warn('Heartbeat error:', err);
    } finally {
      jmcwcIsHeartbeatInFlight = false;
    }
  }, 10000);
}

function stopRunnerSchedulers() {
  if (jmcwcDisplayTimerId) {
    clearInterval(jmcwcDisplayTimerId);
    jmcwcDisplayTimerId = null;
  }
  if (jmcwcHeartbeatTimerId) {
    clearInterval(jmcwcHeartbeatTimerId);
    jmcwcHeartbeatTimerId = null;
  }
  jmcwcIsHeartbeatInFlight = false;
}

async function triggerFlatExpiry() {
  stopRunnerSchedulers();
  if (jmcwcIsExpiryInFlight || !jmcwcRunner) return;
  jmcwcIsExpiryInFlight = true;

  // Immediately hide inputs and questions in the DOM
  const activeWorkspace = document.getElementById('jmcwc-runner-active-workspace');
  if (activeWorkspace) {
    activeWorkspace.style.display = 'none';
    const gridEl = document.getElementById('jmcwc-worksheet-grid');
    if (gridEl) gridEl.innerHTML = '';
    const promptEl = document.getElementById('jmcwc-q-prompt');
    const inputContainer = document.getElementById('jmcwc-q-input-container');
    if (promptEl) promptEl.textContent = '';
    if (inputContainer) inputContainer.innerHTML = '';
  }
  jmcwcRenderedWorksheetKey = null;

  const veil = document.getElementById('jmcwc-runner-hidden-veil');
  const veilTitle = document.getElementById('jmcwc-veil-title');
  const veilDesc = document.getElementById('jmcwc-veil-desc');
  const btnVeilResume = document.getElementById('btn-jmcwc-veil-resume');
  const btnVeilSubmitPaused = document.getElementById('btn-jmcwc-veil-submit-paused');

  if (veil) veil.style.display = 'block';
  if (veilTitle) veilTitle.textContent = 'Active Time Limit Reached';
  if (veilDesc) {
    veilDesc.textContent =
      'Two-hour active time limit reached. Inputs are locked while your answers are being graded...';
  }
  if (btnVeilResume) btnVeilResume.style.display = 'none';
  if (btnVeilSubmitPaused) btnVeilSubmitPaused.style.display = 'none';

  try {
    await jmcwcRunner.handleFlatExpiry();
  } catch (err) {
    console.error('handleFlatExpiry error:', err);
  } finally {
    jmcwcIsExpiryInFlight = false;
  }
}

function renderJmcwcRunnerState(state) {
  if (!state || state.status === 'idle') return;

  if (state.status === 'submitted' && state.score) {
    stopRunnerSchedulers();
    renderCompletedReviewView({
      attempt: state.attempt,
      score: state.score,
      review_questions: state.reviewQuestions || [],
      targetSeconds: resolveAttemptTargetSeconds(state.attempt),
    });
    showJmcwcSubview('review');
    loadJmcwcOverviewAndAttempts();
    return;
  }

  showJmcwcSubview('runner');

  const modeBadge = document.getElementById('jmcwc-runner-mode-badge');
  const titleEl = document.getElementById('jmcwc-runner-title');
  const progressText = document.getElementById('jmcwc-runner-progress-text');
  const timerLabel = document.getElementById('jmcwc-runner-timer-label');
  const timerValue = document.getElementById('jmcwc-runner-timer-value');
  const targetCompEl = document.getElementById('jmcwc-runner-target-comparison');
  const saveBadge = document.getElementById('jmcwc-runner-save-badge');
  const btnPause = document.getElementById('btn-jmcwc-runner-pause');
  const veil = document.getElementById('jmcwc-runner-hidden-veil');
  const veilTitle = document.getElementById('jmcwc-veil-title');
  const veilDesc = document.getElementById('jmcwc-veil-desc');
  const btnVeilResume = document.getElementById('btn-jmcwc-veil-resume');
  const btnVeilSubmitPaused = document.getElementById('btn-jmcwc-veil-submit-paused');
  const activeWorkspace = document.getElementById('jmcwc-runner-active-workspace');
  const conflictBanner = document.getElementById('jmcwc-recovery-conflict-banner');

  const isFlat = state.attempt?.mode === 'flat';
  if (modeBadge) {
    modeBadge.textContent = isFlat ? 'Flat Round (2h Active)' : 'Category-wise';
  }

  const attCatKey = state.attempt?.category_key || state.attempt?.category_id;
  const catObj = attCatKey
    ? jmcwcCategoriesList.find((c) => (c.key || c.id) === attCatKey)
    : null;
  if (titleEl) {
    titleEl.textContent = isFlat
      ? `${formatJmcwcGroupLabel(state.attempt?.group_key)} Full Paper`
      : catObj
        ? catObj.display_name || catObj.label
        : 'Category Practice';
  }

  // Answered / Unanswered counts
  const counts = jmcwcRunner ? jmcwcRunner.getAnswerCounts() : { answeredCount: 0, totalCount: 0 };
  if (progressText) {
    progressText.textContent = `${counts.answeredCount} / ${counts.totalCount} answered`;
  }

  // Timer & optional neutral category target comparison
  if (timerLabel) {
    timerLabel.textContent = isFlat ? 'Remaining Active Time' : 'Elapsed Active Time';
  }
  if (timerValue && state.timer) {
    timerValue.textContent = isFlat
      ? state.timer.formattedRemaining
      : state.timer.formattedElapsed;
  }

  const targetSec = resolveAttemptTargetSeconds(state.attempt);
  if (targetCompEl) {
    if (!isFlat && targetSec && state.timer) {
      const comp = formatNeutralTargetComparison(state.timer.elapsedActiveMs, targetSec);
      targetCompEl.textContent = comp.comparisonText;
      targetCompEl.style.display = 'block';
    } else {
      targetCompEl.style.display = 'none';
      targetCompEl.textContent = '';
    }
  }

  // Save Status Indicator: Saving / Saved / Offline—paused
  if (saveBadge) {
    const label = state.saveStatusLabel || 'Saved';
    saveBadge.textContent = label;
    if (label === 'Saving') {
      saveBadge.className = 'badge badge-warning num';
    } else if (label === 'Offline—paused') {
      saveBadge.className = 'badge badge-inactive num';
    } else {
      saveBadge.className = 'badge badge-active num';
    }
  }

  // Local unsent recovery conflict prompt
  if (conflictBanner) {
    conflictBanner.style.display = state.recoveryConflict ? 'flex' : 'none';
  }

  // Immediately hide questions and inputs if paused, lease-lost, grading, or expired
  if (state.questionsHidden || state.status !== 'running') {
    stopRunnerSchedulers();
    if (activeWorkspace) {
      activeWorkspace.style.display = 'none';
      const gridEl = document.getElementById('jmcwc-worksheet-grid');
      if (gridEl) gridEl.innerHTML = '';
      const promptEl = document.getElementById('jmcwc-q-prompt');
      const inputContainer = document.getElementById('jmcwc-q-input-container');
      if (promptEl) promptEl.textContent = '';
      if (inputContainer) inputContainer.innerHTML = '';
    }
    jmcwcRenderedWorksheetKey = null;

    if (veil) veil.style.display = 'block';
    if (btnPause) btnPause.disabled = true;

    if (state.status === 'lease_lost') {
      if (veilTitle) veilTitle.textContent = 'Active Session Moved to Another Tab or Device';
      if (veilDesc) {
        veilDesc.textContent =
          state.errorMessage ||
          'Questions are hidden because this attempt was resumed elsewhere.';
      }
      if (btnVeilResume) {
        btnVeilResume.textContent = 'Take Over Here';
        btnVeilResume.style.display = 'inline-flex';
      }
      if (btnVeilSubmitPaused) btnVeilSubmitPaused.style.display = 'none';
    } else if (state.status === 'grading') {
      if (veilTitle) veilTitle.textContent = 'Finalizing & Grading Attempt...';
      if (veilDesc) {
        veilDesc.textContent =
          'Inputs are locked while the server finalizes your saved answers.';
      }
      if (btnVeilResume) btnVeilResume.style.display = 'none';
      if (btnVeilSubmitPaused) btnVeilSubmitPaused.style.display = 'none';
    } else {
      if (veilTitle) veilTitle.textContent = 'Attempt Paused';
      if (veilDesc) {
        veilDesc.textContent =
          'Questions and inputs are hidden while paused. Returning or reloading requires clicking Resume Attempt below.';
      }
      if (btnVeilResume) {
        btnVeilResume.textContent = 'Resume Attempt';
        btnVeilResume.style.display = 'inline-flex';
      }
      if (btnVeilSubmitPaused) {
        btnVeilSubmitPaused.style.display = 'inline-flex';
      }
    }
    return;
  }

  // Active running state
  if (veil) veil.style.display = 'none';
  if (activeWorkspace) activeWorkspace.style.display = 'block';
  if (btnPause) btnPause.disabled = false;

  startRunnerSchedulers();
  renderActiveRunnerQuestionWorkspace(state);
}

function resolveAttemptTargetSeconds(attempt) {
  if (!attempt || attempt.mode !== 'category') return null;
  const catKey = attempt.category_key || attempt.category_id;
  if (!catKey) return null;
  const t = jmcwcTargetsMap[catKey] ?? attempt.target_seconds;
  return Number.isInteger(t) && t > 0 ? t : null;
}

function renderActiveRunnerQuestionWorkspace(state) {
  const sections = Array.isArray(state.questions) ? state.questions : [];
  const allQuestions = getRunnerQuestionsInOrder(state);
  if (allQuestions.length === 0) {
    // Never leave a previous attempt's questions visible during an empty response.
    for (const id of ['jmcwc-worksheet-grid', 'jmcwc-q-prompt', 'jmcwc-q-input-container', 'jmcwc-sheet-section-title', 'jmcwc-runner-question-pills']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    }
    jmcwcRenderedWorksheetKey = null;
    return;
  }

  if (jmcwcCurrentQuestionIndex < 0 || jmcwcCurrentQuestionIndex >= allQuestions.length) {
    jmcwcCurrentQuestionIndex = 0;
  }

  const currentQ = allQuestions[jmcwcCurrentQuestionIndex];
  jmcwcCurrentSectionOrder = currentQ.section_order;

  // 1. Category section dropdown (visible when > 1 section)
  const navWrap = document.getElementById('jmcwc-runner-category-nav-wrap');
  const sectionSelect = document.getElementById('select-jmcwc-runner-section');
  if (navWrap && sectionSelect) {
    if (sections.length <= 1) {
      navWrap.style.display = 'none';
    } else {
      navWrap.style.display = 'block';
      sectionSelect.innerHTML = sections
        .map((sec) => {
          const secQs = Array.isArray(sec.questions) ? sec.questions : [];
          const secAnswered = secQs.filter((q) => {
            const v = state.answers?.[q.question_key];
            return v !== undefined && v !== null && String(v).trim() !== '';
          }).length;
          return `
          <option value="${sec.section_order}" ${sec.section_order === jmcwcCurrentSectionOrder ? 'selected' : ''}>
            Section ${sec.section_order}: ${escapeHtml(sec.display_name || sec.category_slug)} (${secAnswered}/${secQs.length} answered)
          </option>
        `;
        })
        .join('');

      sectionSelect.onchange = () => {
        const targetSecOrder = Number(sectionSelect.value);
        const firstIdx = allQuestions.findIndex((q) => q.section_order === targetSecOrder);
        if (firstIdx >= 0) {
          jmcwcCurrentQuestionIndex = firstIdx;
          jmcwcRenderedWorksheetKey = null;
          renderActiveRunnerQuestionWorkspace(jmcwcRunner.getState());
        }
      };
    }
  }

  // 2. Question pills for the current section
  const pillsContainer = document.getElementById('jmcwc-runner-question-pills');
  const sectionQuestions = allQuestions
    .map((q, globalIdx) => ({ ...q, globalIdx }))
    .filter((q) => q.section_order === jmcwcCurrentSectionOrder);

  if (pillsContainer) {
    pillsContainer.innerHTML = sectionQuestions
      .map((q) => {
        const rawAns = state.answers?.[q.question_key];
        const isAnswered = rawAns !== undefined && rawAns !== null && String(rawAns).trim() !== '';
        const isCurrent = q.globalIdx === jmcwcCurrentQuestionIndex;
        return `
        <button
          type="button"
          class="btn ${isCurrent ? 'btn-primary' : isAnswered ? 'btn-secondary' : 'btn-outline'} btn-sm num"
          data-global-q-idx="${q.globalIdx}"
          data-q-key="${q.question_key}"
          aria-label="Question ${q.question_index} (${isAnswered ? 'Answered' : 'Unanswered'}), ${q.marks} ${q.marks === 1 ? 'mark' : 'marks'}"
          aria-current="${isCurrent ? 'step' : 'false'}"
          style="min-width: 40px; min-height: 36px; font-weight: 700;"
        >
          ${q.question_index}${isAnswered ? ' ✓' : ''}
        </button>
      `;
      })
      .join('');

    pillsContainer.querySelectorAll('[data-global-q-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        jmcwcCurrentQuestionIndex = Number(btn.getAttribute('data-global-q-idx')) || 0;
        if (jmcwcRunnerViewMode === 'worksheet') {
          const qKey = btn.getAttribute('data-q-key');
          const targetInp = document.querySelector(`.jmcwc-sheet-input[data-q-key="${qKey}"]`);
          if (targetInp) {
            targetInp.focus();
            targetInp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else {
          renderActiveRunnerQuestionWorkspace(jmcwcRunner.getState());
        }
      });
    });
  }

  // 3. View Switcher buttons
  const btnViewWorksheet = document.getElementById('btn-jmcwc-view-worksheet');
  const btnViewSingle = document.getElementById('btn-jmcwc-view-single');
  const worksheetView = document.getElementById('jmcwc-runner-worksheet-view');
  const singleView = document.getElementById('jmcwc-runner-single-card-view');

  if (btnViewWorksheet && btnViewSingle && worksheetView && singleView) {
    btnViewWorksheet.onclick = () => {
      jmcwcRunnerViewMode = 'worksheet';
      btnViewWorksheet.className = 'btn btn-primary btn-sm';
      btnViewSingle.className = 'btn btn-ghost btn-sm';
      worksheetView.style.display = 'block';
      singleView.style.display = 'none';
      jmcwcRenderedWorksheetKey = null;
      renderActiveRunnerQuestionWorkspace(jmcwcRunner.getState());
    };
    btnViewSingle.onclick = () => {
      jmcwcRunnerViewMode = 'single';
      btnViewSingle.className = 'btn btn-primary btn-sm';
      btnViewWorksheet.className = 'btn btn-ghost btn-sm';
      worksheetView.style.display = 'none';
      singleView.style.display = 'block';
      jmcwcRenderedWorksheetKey = null;
      renderActiveRunnerQuestionWorkspace(jmcwcRunner.getState());
    };

    if (jmcwcRunnerViewMode === 'worksheet') {
      btnViewWorksheet.className = 'btn btn-primary btn-sm';
      btnViewSingle.className = 'btn btn-ghost btn-sm';
      worksheetView.style.display = 'block';
      singleView.style.display = 'none';
    } else {
      btnViewSingle.className = 'btn btn-primary btn-sm';
      btnViewWorksheet.className = 'btn btn-ghost btn-sm';
      worksheetView.style.display = 'none';
      singleView.style.display = 'block';
    }
  }

  // 4. Render or update Worksheet Grid View vs Single Card View
  if (jmcwcRunnerViewMode === 'worksheet') {
    renderWorksheetGridView(state, sectionQuestions, currentQ);
  } else {
    renderSingleCardView(state, allQuestions, currentQ);
  }
}

function renderWorksheetGridView(state, sectionQuestions, currentQ) {
  const titleEl = document.getElementById('jmcwc-sheet-section-title');
  const badgeEl = document.getElementById('jmcwc-sheet-answered-badge');
  const gridEl = document.getElementById('jmcwc-worksheet-grid');
  if (!gridEl) return;

  const activeSec = state.questions.find((s) => s.section_order === jmcwcCurrentSectionOrder);
  const secName = activeSec
    ? activeSec.display_name || activeSec.category_slug
    : currentQ.category_name;
  if (titleEl) {
    titleEl.textContent = `Section ${jmcwcCurrentSectionOrder}: ${secName}`;
  }

  const answeredInSec = sectionQuestions.filter((q) => {
    const v = state.answers?.[q.question_key];
    return v !== undefined && v !== null && String(v).trim() !== '';
  }).length;
  if (badgeEl) {
    badgeEl.textContent = `${answeredInSec} / ${sectionQuestions.length} answered`;
  }

  // If section already rendered, do NOT rebuild innerHTML to avoid destroying input elements / focus!
  // Section 1 occurs in every category attempt. Reuse DOM only for the same
  // attempt and immutable question content, never merely the same section number.
  const worksheetKey = JSON.stringify([
    state.attempt?.id,
    jmcwcCurrentSectionOrder,
    activeSec?.category_slug,
    sectionQuestions.map(q => [q.question_key, q.category_slug, q.prompt, q.input, q.marks]),
  ]);
  if (jmcwcRenderedWorksheetKey === worksheetKey && gridEl.children.length > 0) {
    for (const q of sectionQuestions) {
      const rawAns = state.answers?.[q.question_key];
      const isAns = rawAns !== undefined && rawAns !== null && String(rawAns).trim() !== '';
      const cell = document.getElementById(`jmcwc-qcell-${q.question_key}`);
      const chip = document.getElementById(`chip-q-${q.question_key}`);
      if (cell) cell.classList.toggle('is-answered', isAns);
      if (chip) {
        chip.textContent = isAns ? 'Answered' : 'Unanswered';
        chip.className = isAns ? 'status-chip chip-done' : 'status-chip chip-unverified';
      }
    }
    return;
  }

  jmcwcRenderedWorksheetKey = worksheetKey;

  // Build grid HTML for all questions in this section
  gridEl.innerHTML = sectionQuestions
    .map((q, idx) => {
      const rawVal = state.answers?.[q.question_key] ?? '';
      const isAns = String(rawVal).trim() !== '';
      const spec = describeQuestionInputSpec(q);
      const mathHtml = formatWorksheetMathPromptHtml(q.prompt);

      let inputHtml = '';
      if (spec.kind === 'day_of_week') {
        inputHtml = `
          <select
            class="form-select jmcwc-sheet-input num"
            data-q-idx="${idx}"
            data-q-key="${q.question_key}"
            aria-label="${escapeHtml(spec.ariaLabel)}"
            style="min-height: 40px; font-weight: 600;"
          >
            <option value="">-- Select day --</option>
            ${spec.options
              .map(
                (day) => `
              <option value="${escapeHtml(day)}" ${
                String(rawVal).trim().toLowerCase() === day.toLowerCase() ? 'selected' : ''
              }>
                ${escapeHtml(day)}
              </option>
            `
              )
              .join('')}
          </select>
        `;
      } else if (spec.kind === 'multi_value') {
        const parts = splitMultiValueRaw(rawVal, spec.slotCount);
        inputHtml = `
          <div style="display: flex; gap: 4px;">
            ${parts
              .map(
                (pVal, pIdx) => `
              <input
                type="text"
                class="form-input num jmcwc-sheet-input jmcwc-sheet-multi-sub"
                data-q-idx="${idx}"
                data-q-key="${q.question_key}"
                data-slot-idx="${pIdx}"
                inputmode="${escapeHtml(spec.inputMode)}"
                placeholder="Val ${pIdx + 1}"
                value="${escapeHtml(pVal)}"
                autocomplete="off"
                spellcheck="false"
                aria-label="Question ${q.question_index} value ${pIdx + 1}"
                style="min-height: 40px; font-weight: 600;"
              />
            `
              )
              .join('')}
          </div>
        `;
      } else {
        const tokensHtml =
          spec.quickInsertTokens && spec.quickInsertTokens.length > 0
            ? `<div style="display: flex; gap: 4px; margin-top: 4px;">
                ${spec.quickInsertTokens
                  .map(
                    (t) =>
                      `<button type="button" class="jmcwc-token-btn" data-q-key="${q.question_key}" data-token="${escapeHtml(t)}">${escapeHtml(t)}</button>`
                  )
                  .join('')}
              </div>`
            : '';

        inputHtml = `
          <input
            type="text"
            class="form-input num jmcwc-sheet-input"
            data-q-idx="${idx}"
            data-q-key="${q.question_key}"
            inputmode="${escapeHtml(spec.inputMode)}"
            placeholder="${escapeHtml(spec.placeholder)}"
            value="${escapeHtml(String(rawVal))}"
            autocomplete="off"
            spellcheck="false"
            aria-label="${escapeHtml(spec.ariaLabel)}"
            style="min-height: 40px; font-size: 15px; font-weight: 700;"
          />
          ${tokensHtml}
        `;
      }

      return `
        <div class="jmcwc-worksheet-cell ${isAns ? 'is-answered' : ''}" id="jmcwc-qcell-${q.question_key}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <strong style="font-size: 13px;">#${q.question_index}</strong>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span class="status-chip ${isAns ? 'chip-done' : 'chip-unverified'}" id="chip-q-${q.question_key}">
                ${isAns ? 'Answered' : 'Unanswered'}
              </span>
              <span class="badge badge-neutral num" style="font-size: 11px;">${q.marks}m</span>
            </div>
          </div>

          <div class="num" style="font-size: 16px; font-weight: 700; color: var(--text-main); margin-bottom: 8px; font-variant-numeric: tabular-nums;">
            ${mathHtml}
          </div>

          <div>
            ${inputHtml}
          </div>
        </div>
      `;
    })
    .join('');

  // Wire event handlers for the inputs in the worksheet
  const allSheetInputs = Array.from(gridEl.querySelectorAll('.jmcwc-sheet-input'));
  allSheetInputs.forEach((inp) => {
    const qKey = inp.getAttribute('data-q-key');

    if (inp.tagName === 'SELECT') {
      inp.addEventListener('change', () => {
        jmcwcRunner.recordAnswer(qKey, inp.value);
        updateCellAnsweredState(qKey, inp.value);
      });
    } else if (inp.classList.contains('jmcwc-sheet-multi-sub')) {
      const parentCell = inp.closest('.jmcwc-worksheet-cell');
      const subInputs = Array.from(parentCell.querySelectorAll('.jmcwc-sheet-multi-sub'));
      inp.addEventListener('input', () => {
        const joined = joinMultiValueRaw(subInputs.map((s) => s.value));
        jmcwcRunner.recordAnswer(qKey, joined);
        updateCellAnsweredState(qKey, joined);
      });
    } else {
      inp.addEventListener('input', () => {
        jmcwcRunner.recordAnswer(qKey, inp.value);
        updateCellAnsweredState(qKey, inp.value);
      });
    }

    // Keyboard navigation: Enter or ArrowDown moves to next; ArrowUp moves to previous
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextInp = allSheetInputs[allSheetInputs.indexOf(inp) + 1];
        if (nextInp) nextInp.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevInp = allSheetInputs[allSheetInputs.indexOf(inp) - 1];
        if (prevInp) prevInp.focus();
      }
    });
  });

  // Wire quick token buttons
  gridEl.querySelectorAll('.jmcwc-token-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qKey = btn.getAttribute('data-q-key');
      const token = btn.getAttribute('data-token');
      const targetInp = gridEl.querySelector(`input.jmcwc-sheet-input[data-q-key="${qKey}"]`);
      if (targetInp) {
        targetInp.value += token;
        targetInp.dispatchEvent(new Event('input'));
        targetInp.focus();
      }
    });
  });
}

function updateCellAnsweredState(qKey, value) {
  const isAns = value !== undefined && value !== null && String(value).trim() !== '';
  const cell = document.getElementById(`jmcwc-qcell-${qKey}`);
  const chip = document.getElementById(`chip-q-${qKey}`);
  if (cell) cell.classList.toggle('is-answered', isAns);
  if (chip) {
    chip.textContent = isAns ? 'Answered' : 'Unanswered';
    chip.className = isAns ? 'status-chip chip-done' : 'status-chip chip-unverified';
  }
  const pillBtn = document.querySelector(`#jmcwc-runner-question-pills [data-q-key="${qKey}"]`);
  if (pillBtn) {
    const qNum = pillBtn.textContent.replace(/[^\d]/g, '');
    pillBtn.textContent = `${qNum}${isAns ? ' ✓' : ''}`;
  }
  const progressText = document.getElementById('jmcwc-runner-progress-text');
  if (progressText && jmcwcRunner) {
    const counts = jmcwcRunner.getAnswerCounts();
    progressText.textContent = `${counts.answeredCount} / ${counts.totalCount} answered`;
  }
  const badgeEl = document.getElementById('jmcwc-sheet-answered-badge');
  if (badgeEl) {
    const totalInSec = document.querySelectorAll('.jmcwc-worksheet-cell').length;
    const ansInSec = document.querySelectorAll('.jmcwc-worksheet-cell.is-answered').length;
    badgeEl.textContent = `${ansInSec} / ${totalInSec} answered`;
  }
}

function renderSingleCardView(state, allQuestions, currentQ) {
  const secLabel = document.getElementById('jmcwc-q-section-label');
  const numLabel = document.getElementById('jmcwc-q-number-label');
  const ansChip = document.getElementById('jmcwc-q-answered-chip');
  const marksBadge = document.getElementById('jmcwc-q-marks-badge');
  const promptEl = document.getElementById('jmcwc-q-prompt');
  const inputContainer = document.getElementById('jmcwc-q-input-container');
  const hintEl = document.getElementById('jmcwc-q-input-hint');

  const rawValue = state.answers?.[currentQ.question_key] ?? '';
  const isAnswered = String(rawValue).trim() !== '';

  if (secLabel) secLabel.textContent = `Section ${currentQ.section_order} · ${currentQ.category_name}`;
  if (numLabel) numLabel.textContent = `Question ${currentQ.question_index}`;
  if (ansChip) {
    ansChip.textContent = isAnswered ? 'Answered' : 'Unanswered';
    ansChip.className = isAnswered ? 'status-chip chip-done' : 'status-chip chip-unverified';
  }
  if (marksBadge) {
    marksBadge.textContent = `${currentQ.marks} ${currentQ.marks === 1 ? 'mark' : 'marks'}`;
  }
  if (promptEl) {
    promptEl.innerHTML = formatWorksheetMathPromptHtml(currentQ.prompt || '');
  }

  const spec = describeQuestionInputSpec(currentQ);
  if (hintEl) {
    hintEl.textContent = spec.helperText || '';
  }

  if (inputContainer) {
    if (spec.kind === 'day_of_week') {
      inputContainer.innerHTML = `
        <label for="jmcwc-active-answer-input" class="form-label">${escapeHtml(spec.ariaLabel)}</label>
        <select
          id="jmcwc-active-answer-input"
          class="form-select"
          aria-label="${escapeHtml(spec.ariaLabel)}"
          style="max-width: 320px; min-height: 44px; font-weight: 600;"
        >
          <option value="">-- Select day of week (or leave blank to skip) --</option>
          ${spec.options
            .map(
              (day) => `
            <option value="${escapeHtml(day)}" ${
              String(rawValue).trim().toLowerCase() === day.toLowerCase() ? 'selected' : ''
            }>
              ${escapeHtml(day)}
            </option>
          `
            )
            .join('')}
        </select>
      `;
      const sel = document.getElementById('jmcwc-active-answer-input');
      sel?.addEventListener('change', () => {
        jmcwcRunner.recordAnswer(currentQ.question_key, sel.value);
        updateQuestionChipInPlace(currentQ, sel.value);
      });
      sel?.focus();
    } else if (spec.kind === 'multi_value') {
      const parts = splitMultiValueRaw(rawValue, spec.slotCount);
      inputContainer.innerHTML = `
        <fieldset style="border: none; padding: 0; margin: 0;">
          <legend class="form-label" style="margin-bottom: var(--space-2);">${escapeHtml(spec.ariaLabel)}</legend>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-2);">
            ${parts
              .map(
                (partVal, idx) => `
              <div>
                <label for="jmcwc-multi-slot-${idx}" style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px;">
                  Value ${idx + 1}
                </label>
                <input
                  type="text"
                  id="jmcwc-multi-slot-${idx}"
                  class="form-input num jmcwc-multi-input"
                  data-slot-idx="${idx}"
                  inputmode="${escapeHtml(spec.inputMode)}"
                  placeholder="${escapeHtml(spec.placeholder)}"
                  value="${escapeHtml(partVal)}"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="Question ${currentQ.question_index} value ${idx + 1} of ${spec.slotCount}"
                  style="min-height: 44px; font-size: var(--text-base); font-weight: 600;"
                />
              </div>
            `
              )
              .join('')}
          </div>
        </fieldset>
      `;
      const multiInputs = Array.from(inputContainer.querySelectorAll('.jmcwc-multi-input'));
      const syncMulti = () => {
        const currentValues = multiInputs.map((inp) => inp.value);
        const joined = joinMultiValueRaw(currentValues);
        jmcwcRunner.recordAnswer(currentQ.question_key, joined);
        updateQuestionChipInPlace(currentQ, joined);
      };
      multiInputs.forEach((inp, idx) => {
        inp.addEventListener('input', syncMulti);
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (idx + 1 < multiInputs.length) {
              multiInputs[idx + 1].focus();
            } else {
              navigateRunnerQuestion(1);
            }
          }
        });
      });
      multiInputs[0]?.focus();
    } else {
      const tokensHtml =
        spec.quickInsertTokens && spec.quickInsertTokens.length > 0
          ? `<div style="display: flex; gap: 6px; margin-top: 6px;">
              ${spec.quickInsertTokens
                .map(
                  (t) =>
                    `<button type="button" class="jmcwc-token-btn" data-token="${escapeHtml(t)}">${escapeHtml(t)}</button>`
                )
                .join('')}
            </div>`
          : '';

      inputContainer.innerHTML = `
        <label for="jmcwc-active-answer-input" class="form-label">${escapeHtml(spec.ariaLabel)}</label>
        <input
          type="text"
          id="jmcwc-active-answer-input"
          class="form-input num"
          inputmode="${escapeHtml(spec.inputMode)}"
          placeholder="${escapeHtml(spec.placeholder)}"
          value="${escapeHtml(String(rawValue))}"
          autocomplete="off"
          spellcheck="false"
          aria-label="${escapeHtml(spec.ariaLabel)}"
          style="max-width: 380px; min-height: 46px; font-size: var(--text-md); font-weight: 700;"
        />
        ${tokensHtml}
      `;
      const inp = document.getElementById('jmcwc-active-answer-input');
      inp?.addEventListener('input', () => {
        jmcwcRunner.recordAnswer(currentQ.question_key, inp.value);
        updateQuestionChipInPlace(currentQ, inp.value);
      });
      inp?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          navigateRunnerQuestion(1);
        }
      });
      inputContainer.querySelectorAll('.jmcwc-token-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (inp) {
            inp.value += btn.getAttribute('data-token');
            inp.dispatchEvent(new Event('input'));
            inp.focus();
          }
        });
      });
      inp?.focus();
    }
  }

  // Previous / Next buttons state
  const btnPrev = document.getElementById('btn-jmcwc-q-prev');
  const btnNext = document.getElementById('btn-jmcwc-q-next');
  if (btnPrev) btnPrev.disabled = jmcwcCurrentQuestionIndex <= 0;
  if (btnNext) btnNext.disabled = jmcwcCurrentQuestionIndex >= allQuestions.length - 1;
}

function updateQuestionChipInPlace(currentQ, rawVal) {
  const isAnswered = rawVal !== undefined && rawVal !== null && String(rawVal).trim() !== '';
  const ansChip = document.getElementById('jmcwc-q-answered-chip');
  if (ansChip) {
    ansChip.textContent = isAnswered ? 'Answered' : 'Unanswered';
    ansChip.className = isAnswered ? 'status-chip chip-done' : 'status-chip chip-unverified';
  }
  const progressText = document.getElementById('jmcwc-runner-progress-text');
  if (progressText && jmcwcRunner) {
    const counts = jmcwcRunner.getAnswerCounts();
    progressText.textContent = `${counts.answeredCount} / ${counts.totalCount} answered`;
  }
  const pillBtn = document.querySelector(`#jmcwc-runner-question-pills [data-global-q-idx="${jmcwcCurrentQuestionIndex}"]`);
  if (pillBtn) {
    pillBtn.textContent = `${currentQ.question_index}${isAnswered ? ' ✓' : ''}`;
  }
}

function navigateRunnerQuestion(delta) {
  if (!jmcwcRunner) return;
  const st = jmcwcRunner.getState();
  if (st.status !== 'running' || st.questionsHidden) return;
  const allQuestions = getRunnerQuestionsInOrder(st);
  const nextIdx = jmcwcCurrentQuestionIndex + delta;
  if (nextIdx >= 0 && nextIdx < allQuestions.length) {
    jmcwcCurrentQuestionIndex = nextIdx;
    renderActiveRunnerQuestionWorkspace(st);
  }
}

function isTakeoverConflict(err) {
  if (!err) return false;
  const status = Number(err.statusCode ?? err.status);
  const code = String(err.code || '');
  const msg = String(err.message || '').toLowerCase();
  return (
    code === 'TAKEOVER_CONFIRMATION_REQUIRED' ||
    ((status === 409 || status === 400) &&
      (msg.includes('takeover') ||
        msg.includes('another simulator round') ||
        msg.includes('another active session') ||
        msg.includes('currently active')))
  );
}

async function handleStartOnlineFlatRound() {
  showJmcwcOnlineError('');
  const runner = ensureJmcwcRunnerInstance();
  try {
    jmcwcCurrentQuestionIndex = 0;
    await runner.startAttempt({ mode: 'flat', categoryId: null });
    await loadJmcwcOverviewAndAttempts();
  } catch (err) {
    if (isTakeoverConflict(err)) {
      pendingTakeoverAttemptId =
        err.attemptId ||
        runner.getState()?.takeoverConfirmation?.attemptId ||
        runner.getState()?.attempt?.id ||
        null;
      openInlineModal('jmcwc-takeover-modal');
      return;
    }
    showJmcwcOnlineError(err.message);
    showToast('error', err.message);
  }
}

async function handleStartOnlineCategoryPractice() {
  showJmcwcOnlineError('');
  const catSelect = document.getElementById('select-jmcwc-category');
  const categoryId = catSelect?.value || '';
  if (!categoryId) {
    showToast('info', 'Please select a category first.');
    return;
  }
  const runner = ensureJmcwcRunnerInstance();
  try {
    jmcwcCurrentQuestionIndex = 0;
    await runner.startAttempt({ mode: 'category', categoryId });
    await loadJmcwcOverviewAndAttempts();
  } catch (err) {
    if (isTakeoverConflict(err)) {
      pendingTakeoverAttemptId =
        err.attemptId ||
        runner.getState()?.takeoverConfirmation?.attemptId ||
        runner.getState()?.attempt?.id ||
        null;
      openInlineModal('jmcwc-takeover-modal');
      return;
    }
    showJmcwcOnlineError(err.message);
    showToast('error', err.message);
  }
}

async function handleResumeOnlineAttempt(attemptId, takeover = false) {
  showJmcwcOnlineError('');
  const runner = ensureJmcwcRunnerInstance();
  try {
    jmcwcCurrentQuestionIndex = 0;
    await runner.resumeAttempt(attemptId, { takeover });
    await loadJmcwcOverviewAndAttempts();
  } catch (err) {
    if (isTakeoverConflict(err)) {
      pendingTakeoverAttemptId = attemptId;
      openInlineModal('jmcwc-takeover-modal');
      return;
    }
    showJmcwcOnlineError(err.message);
    showToast('error', err.message);
  }
}

async function handleOpenCompletedReview(attemptId) {
  showJmcwcOnlineError('');
  try {
    const res = await callJmcwcApi({
      action: 'get_attempt_review',
      attempt_id: attemptId,
    });
    renderCompletedReviewView({
      attempt: res.attempt,
      score: res.score,
      review_questions: res.review_questions || [],
      targetSeconds: resolveAttemptTargetSeconds(res.attempt),
    });
    showJmcwcSubview('review');
  } catch (err) {
    showJmcwcOnlineError(err.message);
    showToast('error', err.message);
  }
}

function renderCompletedReviewView({ attempt, score, review_questions, targetSeconds }) {
  const vm = buildSubmittedReviewViewModel({
    attempt,
    score,
    review_questions,
    targetSeconds,
  });

  const modeLabel = document.getElementById('jmcwc-review-mode-label');
  const titleEl = document.getElementById('jmcwc-review-title');
  const marksEl = document.getElementById('jmcwc-review-marks');
  const partialEl = document.getElementById('jmcwc-review-partial-note');
  const countsEl = document.getElementById('jmcwc-review-counts');
  const timeEl = document.getElementById('jmcwc-review-active-time');
  const targetCompEl = document.getElementById('jmcwc-review-target-comparison');
  const tbody = document.getElementById('jmcwc-review-tbody');

  if (modeLabel) {
    modeLabel.textContent = `${vm.groupLabel} · ${vm.mode === 'flat' ? 'Flat Round' : 'Category-wise'}`;
  }
  if (titleEl) {
    const datePart = vm.submittedAt ? ` (${formatDisplayDateIST(vm.submittedAt.slice(0, 10))})` : '';
    titleEl.textContent = `Completed Attempt Review${datePart}`;
  }
  if (marksEl) {
    marksEl.textContent = `${vm.earnedMarks} / ${vm.maxMarks}`;
  }
  if (partialEl) {
    partialEl.textContent = `Partial marks awarded: ${vm.partialMarks} (${vm.partialCount} questions)`;
  }
  if (countsEl) {
    countsEl.textContent = `${vm.correctCount} correct · ${vm.partialCount} partial · ${vm.wrongCount} wrong · ${vm.skippedCount} skipped`;
  }
  if (timeEl) {
    timeEl.textContent = vm.activeTimeFormatted;
  }
  if (targetCompEl) {
    targetCompEl.textContent = vm.targetComparison ? vm.targetComparison.comparisonText : '';
  }

  if (tbody) {
    tbody.innerHTML = vm.questions.map(q => {
      const verdictBadgeClass =
        q.verdict === 'correct'
          ? 'badge-active'
          : q.verdict === 'partial'
            ? 'badge-warning'
            : q.verdict === 'skipped'
              ? 'badge-neutral'
              : 'badge-danger';
      return `
        <tr>
          <td class="num" style="font-weight: 700;">#${q.index}</td>
          <td style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(q.category_name)}</td>
          <td class="num" style="font-weight: 600;">${escapeHtml(q.prompt)}</td>
          <td class="num">${q.submitted_raw ? escapeHtml(q.submitted_raw) : '<span style="color: var(--text-dim);">Skipped</span>'}</td>
          <td class="num">
            <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">${escapeHtml(q.expected_answer_label)}:</div>
            <div style="font-weight: 700;">${escapeHtml(q.expected_display)}</div>
          </td>
          <td class="num" style="text-align: right; font-weight: 700;">
            ${q.awarded_marks} / ${q.max_marks}
          </td>
          <td style="font-size: var(--text-xs);">
            <span class="badge ${verdictBadgeClass}" style="margin-bottom: 4px; display: inline-block;">
              ${escapeHtml(q.verdict)}
            </span>
            ${q.explanation ? `<div style="color: var(--text-muted);">${escapeHtml(q.explanation)}</div>` : ''}
          </td>
        </tr>
      `;
    }).join('');
  }
}

function openInlineModal(modalId) {
  const el = document.getElementById(modalId);
  if (!el) return;
  el.classList.add('is-open');
  el.style.display = 'flex';
  el.setAttribute('aria-hidden', 'false');
}

function closeInlineModal(modalId) {
  const el = document.getElementById(modalId);
  if (!el) return;
  el.classList.remove('is-open');
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
}

function openSubmitConfirmationModal(isPausedSubmit = false) {
  if (!jmcwcRunner) return;
  isSubmittingPausedAttempt = Boolean(isPausedSubmit);
  const counts = jmcwcRunner.getAnswerCounts();

  const pausedNotice = document.getElementById('jmcwc-submit-paused-notice');
  const ansEl = document.getElementById('jmcwc-submit-answered-count');
  const unansEl = document.getElementById('jmcwc-submit-unanswered-count');
  const confirmBtnText = document.getElementById('btn-jmcwc-confirm-submit-text');

  if (pausedNotice) {
    pausedNotice.style.display = isSubmittingPausedAttempt ? 'block' : 'none';
  }
  if (ansEl) ansEl.textContent = String(counts.answeredCount);
  if (unansEl) unansEl.textContent = String(counts.unansweredCount);
  if (confirmBtnText) {
    confirmBtnText.textContent = isSubmittingPausedAttempt
      ? 'Resume & Submit Now'
      : 'Submit Attempt';
  }

  openInlineModal('jmcwc-submit-confirm-modal');
}

function setupJmcwcOnlinePracticeUI() {
  // Mode tabs
  document.getElementById('btn-mode-manual')?.addEventListener('click', () => {
    switchRoundScoresMode('manual');
  });
  document.getElementById('btn-mode-online')?.addEventListener('click', () => {
    switchRoundScoresMode('online');
  });
  document.getElementById('btn-mode-preview')?.addEventListener('click', () => {
    switchRoundScoresMode('preview');
  });

  // Start Flat / Category buttons
  document.getElementById('btn-jmcwc-start-flat')?.addEventListener('click', handleStartOnlineFlatRound);
  document.getElementById('btn-jmcwc-start-category')?.addEventListener('click', handleStartOnlineCategoryPractice);

  // Runner controls
  document.getElementById('btn-jmcwc-runner-pause')?.addEventListener('click', async () => {
    stopRunnerSchedulers();
    if (!jmcwcRunner) return;
    await jmcwcRunner.pauseAttempt();
    await loadJmcwcOverviewAndAttempts();
  });

  document.getElementById('btn-jmcwc-runner-submit')?.addEventListener('click', () => {
    stopRunnerSchedulers();
    if (!jmcwcRunner) return;
    const st = jmcwcRunner.getState();
    openSubmitConfirmationModal(st.status === 'paused');
  });

  document.getElementById('btn-jmcwc-runner-exit')?.addEventListener('click', async () => {
    stopRunnerSchedulers();
    if (jmcwcRunner) {
      const st = jmcwcRunner.getState();
      if (st.status === 'running') {
        await jmcwcRunner.pauseAttempt();
      }
    }
    showJmcwcSubview('landing');
    await loadJmcwcOverviewAndAttempts();
  });

  // Veil controls (Paused / Lease-lost)
  document.getElementById('btn-jmcwc-veil-resume')?.addEventListener('click', async () => {
    if (!jmcwcRunner) return;
    const st = jmcwcRunner.getState();
    const attemptId = st.attempt?.id;
    if (!attemptId) return;
    if (st.status === 'lease_lost') {
      pendingTakeoverAttemptId = attemptId;
      openInlineModal('jmcwc-takeover-modal');
      return;
    }
    await handleResumeOnlineAttempt(attemptId, false);
  });

  document.getElementById('btn-jmcwc-veil-submit-paused')?.addEventListener('click', () => {
    openSubmitConfirmationModal(true);
  });

  document.getElementById('btn-jmcwc-veil-back')?.addEventListener('click', async () => {
    showJmcwcSubview('landing');
    await loadJmcwcOverviewAndAttempts();
  });

  // Local recovery conflict buttons
  document.getElementById('btn-jmcwc-recover-local')?.addEventListener('click', async () => {
    if (!jmcwcRunner) return;
    await jmcwcRunner.resolveRecoveryConflict('recover');
  });
  document.getElementById('btn-jmcwc-discard-local')?.addEventListener('click', async () => {
    if (!jmcwcRunner) return;
    await jmcwcRunner.resolveRecoveryConflict('discard');
  });

  // Previous / Next buttons & keyboard navigation
  document.getElementById('btn-jmcwc-q-prev')?.addEventListener('click', () => {
    navigateRunnerQuestion(-1);
  });
  document.getElementById('btn-jmcwc-q-next')?.addEventListener('click', () => {
    navigateRunnerQuestion(1);
  });

  // Submit confirmation modal actions
  document.getElementById('btn-jmcwc-close-submit-modal')?.addEventListener('click', () => {
    closeInlineModal('jmcwc-submit-confirm-modal');
  });
  document.getElementById('btn-jmcwc-cancel-submit')?.addEventListener('click', () => {
    closeInlineModal('jmcwc-submit-confirm-modal');
  });
  document.getElementById('btn-jmcwc-confirm-submit')?.addEventListener('click', async () => {
    if (!jmcwcRunner) return;
    const btn = document.getElementById('btn-jmcwc-confirm-submit');
    if (btn) btn.disabled = true;
    try {
      await jmcwcRunner.submitAttempt({ resumeIfPaused: isSubmittingPausedAttempt });
      closeInlineModal('jmcwc-submit-confirm-modal');
    } catch (err) {
      closeInlineModal('jmcwc-submit-confirm-modal');
      showJmcwcOnlineError(err.message);
      showToast('error', err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Takeover confirmation modal actions
  document.getElementById('btn-jmcwc-close-takeover-modal')?.addEventListener('click', () => {
    pendingTakeoverAttemptId = null;
    closeInlineModal('jmcwc-takeover-modal');
  });
  document.getElementById('btn-jmcwc-cancel-takeover')?.addEventListener('click', () => {
    pendingTakeoverAttemptId = null;
    closeInlineModal('jmcwc-takeover-modal');
  });
  document.getElementById('btn-jmcwc-confirm-takeover')?.addEventListener('click', async () => {
    const attemptId = pendingTakeoverAttemptId;
    pendingTakeoverAttemptId = null;
    closeInlineModal('jmcwc-takeover-modal');
    if (attemptId) {
      await handleResumeOnlineAttempt(attemptId, true);
    }
  });

  // Close review button
  document.getElementById('btn-jmcwc-close-review')?.addEventListener('click', async () => {
    showJmcwcSubview('landing');
    await loadJmcwcOverviewAndAttempts();
  });

  // Best-effort save/pause on pagehide, visibilitychange (hidden), and beforeunload
  window.addEventListener('pagehide', () => {
    stopRunnerSchedulers();
    if (jmcwcRunner) {
      jmcwcRunner.handleVisibilityHiddenOrPageHide();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopRunnerSchedulers();
      if (jmcwcRunner) {
        jmcwcRunner.handleVisibilityHiddenOrPageHide();
      }
    }
  });
  window.addEventListener('beforeunload', () => {
    stopRunnerSchedulers();
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initRoundScores);
}
