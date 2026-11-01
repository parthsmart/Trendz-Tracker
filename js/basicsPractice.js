/**
 * Trendz Tracker — Online Basics Practice Controller (js/basicsPractice.js)
 *
 * Powers /pages/basics-practice.html?cat=<category_id> (Phase 10g):
 * - Protected by requireAuth(['student', 'admin']).
 * - Setup screen: category name, single choice of time ("30 seconds", "1 minute",
 *   "2 minutes", "5 minutes", "Unlimited (stopwatch)"), student's target benchmark
 *   from `basics_thresholds`, and Personal Best for this category and chosen mode
 *   (`timed` vs `unlimited`) from `js/practiceStats.js`.
 * - Active player screen: one question at a time (`createDrillPlayer` with
 *   `revisitSkipped: false`), numeric answer box (`autofocus`, Enter submits),
 *   Skip button (counts as wrong, moves on), no Back button.
 * - Top bar: for timed modes, remaining time counting down from a fixed end time
 *   (`performance.now()`, refreshed every 250 ms) with a progress bar; for unlimited,
 *   a stopwatch counting up. Always shows "Answered n" (never shows correct count
 *   during play) and a "Finish" button with confirmation.
 * - When time reaches zero, the round stops immediately and submits what has been
 *   answered (the question on screen at that moment is not counted).
 * - Results screen: correct out of attempted, accuracy, time used, correct per minute
 *   and attempted per minute (1 decimal place), colour from `js/scoreColors.js`
 *   ("n wrong"), target chip ("Target met" or "Below target") read from
 *   `results_with_target` for the saved row, review list of the first 100 attempted
 *   questions (wrong ones first, with a "Show all" toggle), "New personal best" note,
 *   "This round was saved to your scores.", and buttons "Same mode again" & "Change mode".
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { computeRemainingSeconds, createDrillPlayer } from './drillPlayer.js';
import { requireAuth } from './guard.js';
import {
  BASICS_TIME_MODES,
  bestForMode,
  compareModeResults,
  computePerMinuteRates,
  formatBasicsTargetText,
  isBasicsOnlineAvailable,
} from './practiceStats.js';
import { getScoreFeedback } from './scoreColors.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS } from './timeUtils.js';
import { showToast } from './toast.js';

let currentProfile = null;
let selectedCategory = null;
let selectedMode = 'timed'; // 'timed' | 'unlimited'
let selectedSeconds = 60; // 30 | 60 | 120 | 300 | null
let categoryResults = [];
let effectiveTarget = null;

// Active session & player state
let activeSessionId = null;
let activePlayer = null;
let activeMode = 'timed';
let activeSeconds = 60;
let timerStartMs = 0;
let countdownEndMs = 0;
let roundTimerId = null;
let roundEnded = false;
let pendingSubmissionAnswers = null;
let previousBestBeforeSubmit = null;
let isSubmitting = false;

// Review state
let currentReviewItems = [];
let showAllReviewItems = false;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, (tag) =>
    ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    }[tag] || tag)
  );
}

function showErrorBanner(msg) {
  const banner = document.getElementById('practice-error-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  banner.textContent = msg;
  banner.style.display = 'block';
}

function renderDemoBannerIfNeeded() {
  if (!isDemoMode()) return;
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; sample practice round:</strong>
        Running fixed sample questions and fixed result on localhost / preview host.
      </div>
    </div>
  `;
}

/**
 * Retrieves the student's Bearer token for /api/drill calls.
 */
async function getAccessToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

/**
 * Loads the target Basics category, student's target rule, and existing Basics rows.
 */
async function loadSetupData(categoryIdParam) {
  let categories = [];
  let thresholds = [];

  let preloadedResults = null;

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const initialQueries = [
        supabase
          .from('categories')
          .select('id, name, section, sort_order, active, digits, rows_count, operation')
          .eq('section', 'basics')
          .eq('active', true)
          .order('sort_order', { ascending: true }),
        supabase
          .from('basics_thresholds')
          .select('id, category_id, level, min_accuracy, max_time_seconds, min_questions_per_minute, active')
          .eq('active', true),
      ];
      if (categoryIdParam && currentProfile?.id) {
        initialQueries.push(
          supabase
            .from('results_with_target')
            .select(
              'id, student_id, student_round_id, category_id, correct, total, time_seconds, entry_date, created_at, source, practice_mode, min_accuracy, min_questions_per_minute, meets_target'
            )
            .eq('student_id', currentProfile.id)
            .eq('category_id', categoryIdParam)
            .order('created_at', { ascending: false })
            .limit(200)
        );
      }

      const [catRes, threshRes, resultsRes] = await Promise.all(initialQueries);
      if (!catRes.error && Array.isArray(catRes.data)) {
        categories = catRes.data;
      }
      if (!threshRes.error && Array.isArray(threshRes.data)) {
        thresholds = threshRes.data;
      }
      if (resultsRes && !resultsRes.error && Array.isArray(resultsRes.data)) {
        preloadedResults = resultsRes.data;
      }
    }
  }

  if (categories.length === 0) {
    categories = DemoDB.getCategories().filter(
      (c) => c.section === 'basics' && c.active !== false
    );
  }
  if (thresholds.length === 0 && !isSupabaseConfigured()) {
    thresholds = DemoDB.getBasicsThresholds().filter((t) => t.active !== false);
  }

  if (categoryIdParam) {
    selectedCategory = categories.find((c) => String(c.id) === String(categoryIdParam)) || null;
  }
  if (!selectedCategory) {
    selectedCategory = categories.find((c) => isBasicsOnlineAvailable(c)) || categories[0] || null;
  }

  const titleEl = document.getElementById('setup-category-title');
  const startBtn = document.getElementById('btn-start-practice');
  const backLinks = [
    document.getElementById('top-back-to-basics'),
    document.getElementById('setup-cancel-link'),
    document.getElementById('btn-back-to-basics'),
  ];

  if (selectedCategory) {
    const backHref = `/pages/basics.html?cat=${encodeURIComponent(selectedCategory.id)}`;
    backLinks.forEach((el) => {
      if (el) el.href = backHref;
    });
  }

  if (!selectedCategory || !isBasicsOnlineAvailable(selectedCategory)) {
    if (titleEl) {
      titleEl.textContent = selectedCategory
        ? `${selectedCategory.name} (Typed entry only)`
        : 'Category Not Found';
    }
    showErrorBanner(
      'This Basics category is not available for online practice. Please use typed entry on the Basics screen.'
    );
    if (startBtn) startBtn.disabled = true;
    return;
  }

  if (titleEl) {
    titleEl.textContent = selectedCategory.name;
  }

  renderTimeModeButtons();

  // Resolve student's target (level-specific rule beats default rule)
  const studentLevel = String(currentProfile?.level || '').trim().toLowerCase();
  let rule = null;
  if (studentLevel) {
    rule = thresholds.find(
      (t) =>
        t.category_id === selectedCategory.id &&
        t.level &&
        String(t.level).trim().toLowerCase() === studentLevel
    );
  }
  if (!rule) {
    rule = thresholds.find(
      (t) => t.category_id === selectedCategory.id && (!t.level || !String(t.level).trim())
    );
  }
  effectiveTarget = rule
    ? {
        min_accuracy:
          rule.min_accuracy !== null && rule.min_accuracy !== undefined
            ? Number(rule.min_accuracy)
            : null,
        min_questions_per_minute:
          rule.min_questions_per_minute !== null && rule.min_questions_per_minute !== undefined
            ? Number(rule.min_questions_per_minute)
            : null,
      }
    : null;

  if (
    preloadedResults !== null &&
    categoryIdParam &&
    String(selectedCategory.id) === String(categoryIdParam)
  ) {
    categoryResults = preloadedResults;
  } else {
    await refreshCategoryResults();
  }
  renderSetupSummary();
}

/**
 * Renders the 5 time mode buttons ("30 seconds", "1 minute", "2 minutes", "5 minutes", "Unlimited (stopwatch)").
 */
function renderTimeModeButtons() {
  const groupEl = document.getElementById('time-mode-group');
  if (!groupEl) return;

  groupEl.innerHTML = BASICS_TIME_MODES.map((item) => {
    const isSelected =
      item.mode === selectedMode &&
      (item.mode === 'unlimited' || Number(item.seconds) === Number(selectedSeconds));
    return `
      <button
        type="button"
        class="btn ${isSelected ? 'btn-primary' : 'btn-outline'} btn-time-mode"
        data-mode="${item.mode}"
        data-seconds="${item.seconds ?? ''}"
        aria-pressed="${isSelected ? 'true' : 'false'}"
      >
        ${escapeHtml(item.label)}
      </button>
    `;
  }).join('');

  groupEl.querySelectorAll('.btn-time-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      const modeVal = btn.getAttribute('data-mode');
      const secAttr = btn.getAttribute('data-seconds');
      if (modeVal === 'unlimited') {
        selectedMode = 'unlimited';
        selectedSeconds = null;
      } else {
        selectedMode = 'timed';
        selectedSeconds = Number(secAttr) || 60;
      }
      renderSetupSummary();
    });
  });
}

/**
 * Loads the student's historical rows for the selected Basics category.
 */
async function refreshCategoryResults() {
  if (!selectedCategory || !currentProfile) return;

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('results_with_target')
          .select(
            'id, student_id, student_round_id, category_id, correct, total, time_seconds, entry_date, created_at, source, practice_mode, min_accuracy, min_questions_per_minute, meets_target'
          )
          .eq('student_id', currentProfile.id)
          .eq('category_id', selectedCategory.id)
          .order('created_at', { ascending: false })
          .limit(200);

        if (!error && Array.isArray(data)) {
          categoryResults = data;
          return;
        }
      }
    }

    const demoRows = DemoDB.getResultsWithTarget(currentProfile.id, 'basics');
    const demoKey = `trendz_demo_basics_${currentProfile.id}`;
    let localAdded = [];
    try {
      localAdded = JSON.parse(localStorage.getItem(demoKey) || '[]');
    } catch {
      localAdded = [];
    }
    const merged = [
      ...localAdded,
      ...demoRows.filter((d) => !localAdded.some((l) => l.id === d.id)),
    ];
    categoryResults = merged.filter((r) => r.category_id === selectedCategory.id);
  } catch (err) {
    console.warn('Could not load basics results for best summary:', err);
  }
}

/**
 * Updates the target display and Personal Best card on the Setup screen.
 */
function renderSetupSummary() {
  const targetTextEl = document.getElementById('setup-target-text');
  const bestModeLabelEl = document.getElementById('setup-best-mode-label');
  const bestTextEl = document.getElementById('setup-best-text');

  if (bestModeLabelEl) {
    bestModeLabelEl.textContent = selectedMode === 'unlimited' ? 'Unlimited' : 'Timed';
  }

  if (targetTextEl) {
    const formattedTarget = formatBasicsTargetText(effectiveTarget);
    targetTextEl.textContent = formattedTarget || 'No target set for your level';
  }

  if (bestTextEl && selectedCategory) {
    const best = bestForMode(categoryResults, selectedCategory.id, selectedMode);
    if (best) {
      const cpm = Number(best.correct_per_minute || 0).toFixed(1);
      if (selectedMode === 'unlimited') {
        bestTextEl.textContent = `${cpm} correct / min (${best.correct}/${best.total}, ${best.accuracy}%)`;
      } else {
        bestTextEl.textContent = `${best.correct} correct (${best.accuracy}%, ${cpm} / min)`;
      }
    } else {
      bestTextEl.textContent =
        selectedMode === 'unlimited'
          ? 'No unlimited round recorded yet'
          : 'No timed round recorded yet';
    }
  }

  // Update active button state in time mode selector
  document.querySelectorAll('.btn-time-mode').forEach((btn) => {
    const m = btn.getAttribute('data-mode');
    const s = btn.getAttribute('data-seconds');
    const isSelected =
      m === selectedMode &&
      (m === 'unlimited' || Number(s) === Number(selectedSeconds));
    if (isSelected) {
      btn.className = 'btn btn-primary btn-time-mode';
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.className = 'btn btn-outline btn-time-mode';
      btn.setAttribute('aria-pressed', 'false');
    }
  });
}

function showScreen(screenId) {
  ['screen-setup', 'screen-player', 'screen-results'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = id === screenId ? 'block' : 'none';
    }
  });
}

/**
 * Starts the 250 ms timer for either:
 * - 'timed': countdown from `countdownEndMs = performance.now() + activeSeconds * 1000`
 *   with progress bar, auto-stopping immediately at 00:00.
 * - 'unlimited': stopwatch counting up from `timerStartMs = performance.now()`.
 */
function startRoundTimer() {
  stopRoundTimer();
  const nowPerf = performance.now();
  timerStartMs = nowPerf;
  const stopwatchEl = document.getElementById('player-stopwatch');
  const trackEl = document.getElementById('player-progress-bar-track');
  const fillEl = document.getElementById('player-progress-bar-fill');

  if (activeMode === 'timed' && Number(activeSeconds) > 0) {
    countdownEndMs = nowPerf + Number(activeSeconds) * 1000;
    if (stopwatchEl) stopwatchEl.textContent = formatSecondsToMMSS(Number(activeSeconds));
    if (trackEl) trackEl.style.display = 'block';
    if (fillEl) fillEl.style.width = '100%';

    roundTimerId = window.setInterval(() => {
      if (roundEnded) return;
      const tick = computeRemainingSeconds(
        countdownEndMs,
        performance.now(),
        Number(activeSeconds)
      );
      if (stopwatchEl) {
        stopwatchEl.textContent = formatSecondsToMMSS(tick.remainingSeconds);
      }
      if (fillEl) {
        fillEl.style.width = `${tick.progressPercent.toFixed(1)}%`;
      }
      if (tick.expired) {
        handleTimeUpAutoFinish();
      }
    }, 250);
  } else {
    countdownEndMs = 0;
    if (stopwatchEl) stopwatchEl.textContent = '0:00';
    if (trackEl) trackEl.style.display = 'none';

    roundTimerId = window.setInterval(() => {
      if (roundEnded) return;
      const elapsedSec = Math.max(0, Math.floor((performance.now() - timerStartMs) / 1000));
      if (stopwatchEl) {
        stopwatchEl.textContent = formatSecondsToMMSS(elapsedSec);
      }
    }, 250);
  }
}

function stopRoundTimer() {
  if (roundTimerId !== null) {
    clearInterval(roundTimerId);
    roundTimerId = null;
  }
}

/**
 * Triggered when a timed round's countdown reaches zero.
 * Immediately stops the round and submits only the questions already answered/skipped;
 * the question on screen at that moment is NOT counted.
 */
function handleTimeUpAutoFinish() {
  if (roundEnded || !activePlayer) return;
  roundEnded = true;
  stopRoundTimer();

  const reachedAnswers = activePlayer.finish();
  if (reachedAnswers === null) return;

  if (reachedAnswers.length === 0) {
    showErrorBanner('Time is up and no questions were answered, so nothing was saved.');
    showToast('info', 'Time is up — no questions were answered.');
    showScreen('screen-setup');
    return;
  }

  submitCompletedPracticeSet(reachedAnswers);
}

/**
 * Triggered when the student clicks the "Finish" button in the top bar.
 * Asks for confirmation (timed: ends early; unlimited: ends the round).
 */
function handleManualFinishClick() {
  if (roundEnded || !activePlayer || isSubmitting) return;

  const reachedCount = activePlayer.getAttemptedCount();
  if (reachedCount === 0) {
    const leave = window.confirm(
      'You have not answered any questions yet. End this round without saving?'
    );
    if (!leave) return;
    roundEnded = true;
    stopRoundTimer();
    activePlayer.finish();
    showScreen('screen-setup');
    return;
  }

  const promptMsg =
    activeMode === 'timed'
      ? `End this timed round early and submit the ${reachedCount} ${reachedCount === 1 ? 'question' : 'questions'} you have answered?`
      : `Finish this round and submit the ${reachedCount} ${reachedCount === 1 ? 'question' : 'questions'} you have answered?`;

  if (!window.confirm(promptMsg)) {
    const inputEl = document.getElementById('player-answer-input');
    if (inputEl) inputEl.focus();
    return;
  }

  roundEnded = true;
  stopRoundTimer();
  const reachedAnswers = activePlayer.finish();
  if (reachedAnswers !== null) {
    submitCompletedPracticeSet(reachedAnswers);
  }
}

/**
 * Renders the current question inside the one-question-at-a-time player:
 * - Always shows "Answered n" in the top bar (never shows how many are correct during play).
 * - Add/Sub (`type === 'add_sub'`): vertical column of signed numbers (`+ 4`, `- 3`),
 *   a horizontal line underneath, then the answer box.
 * - Multiplication (`type === 'mul'`): `"47 x 8"`.
 * - Division (`type === 'div'`): `"84 / 7"`.
 */
function renderCurrentPlayerQuestion() {
  if (!activePlayer) return;
  const state = activePlayer.getState();

  const answeredLabelEl = document.getElementById('player-answered-label');
  if (answeredLabelEl) {
    answeredLabelEl.textContent = `Answered ${state.attemptedCount}`;
  }

  // If the pool ran out, finish and submit immediately
  if (state.isFinished) {
    roundEnded = true;
    stopRoundTimer();
    const finalAnswers = activePlayer.finish();
    if (finalAnswers !== null) {
      submitCompletedPracticeSet(finalAnswers);
    }
    return;
  }

  const stageEl = document.getElementById('player-question-stage');
  const inputEl = document.getElementById('player-answer-input');
  const badgeEl = document.getElementById('player-category-badge');
  const modeChipEl = document.getElementById('player-mode-chip');

  if (badgeEl && selectedCategory) {
    badgeEl.textContent = selectedCategory.name;
  }
  if (modeChipEl) {
    modeChipEl.textContent = activeMode === 'unlimited' ? 'Unlimited' : 'Timed';
  }

  const q = state.currentQuestion;
  if (stageEl && q) {
    if (typeof q === 'object' && Array.isArray(q.rows)) {
      const rowsHtml = q.rows
        .map((num) => {
          const sign = num < 0 ? '-' : '+';
          const mag = Math.abs(Number(num));
          return `
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); width: 140px; padding: 2px 0; font-size: 1.65rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.25;">
              <span style="color: ${num < 0 ? 'var(--color-score-warning)' : 'var(--text-muted)'}; font-weight: 700;">${sign}</span>
              <span style="text-align: right; color: var(--text-main);">${mag}</span>
            </div>
          `;
        })
        .join('');

      stageEl.innerHTML = `
        <div style="display: inline-flex; flex-direction: column; align-items: center; padding: var(--space-2) var(--space-4);">
          ${rowsHtml}
          <div style="width: 156px; border-bottom: 3px solid var(--text-main); margin-top: var(--space-2);" aria-hidden="true"></div>
        </div>
      `;
    } else {
      const promptText =
        typeof q === 'object' && q !== null ? String(q.text || '') : String(q ?? '');
      stageEl.innerHTML = `
        <div style="font-size: 2.25rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); text-align: center; padding: var(--space-4);">
          ${escapeHtml(promptText)}
        </div>
      `;
    }
  }

  if (inputEl) {
    inputEl.value = '';
    inputEl.disabled = false;
    inputEl.focus();
  }
}

/**
 * Starts a new online Basics practice session via `POST /api/drill`.
 */
async function startPracticeSession() {
  if (!selectedCategory || isSubmitting) return;
  showErrorBanner('');

  const startBtn = document.getElementById('btn-start-practice');
  const sameModeBtn = document.getElementById('btn-same-mode-again');
  if (startBtn) startBtn.disabled = true;
  if (sameModeBtn) sameModeBtn.disabled = true;

  try {
    let payload = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/drill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'start',
          kind: 'basics',
          category_id: selectedCategory.id,
          mode: selectedMode,
          seconds: selectedMode === 'timed' ? selectedSeconds : null,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not start online practice round.');
      }
      payload = data;
    } else if (isDemoMode()) {
      payload = DemoDB.mockBasicsDrillStart(
        selectedCategory.id,
        selectedMode,
        selectedSeconds
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    activeSessionId = payload.session_id;
    activeMode = payload.mode === 'unlimited' ? 'unlimited' : 'timed';
    activeSeconds =
      activeMode === 'timed' ? Number(payload.seconds || selectedSeconds || 60) : null;

    if (payload.target !== undefined) {
      effectiveTarget = payload.target;
    }

    // Snapshot previous personal best for this category + mode before saving the new round
    previousBestBeforeSubmit = bestForMode(
      categoryResults,
      selectedCategory.id,
      activeMode
    );

    roundEnded = false;
    pendingSubmissionAnswers = null;
    const retryBox = document.getElementById('player-submit-retry-box');
    const answerForm = document.getElementById('player-answer-form');
    if (retryBox) retryBox.style.display = 'none';
    if (answerForm) answerForm.style.display = 'flex';

    activePlayer = createDrillPlayer(payload.questions || [], {
      mode: activeMode,
      revisitSkipped: false,
    });
    showScreen('screen-player');
    startRoundTimer();
    renderCurrentPlayerQuestion();
  } catch (err) {
    showErrorBanner(err.message || 'Could not start practice round.');
    showToast('error', err.message || 'Could not start practice round.');
  } finally {
    if (startBtn) startBtn.disabled = false;
    if (sameModeBtn) sameModeBtn.disabled = false;
  }
}

/**
 * Submits the reached answers array to `POST /api/drill` (`action: 'submit'`).
 * Prevents double submission and retains answers with "Try sending again" if network fails.
 */
async function submitCompletedPracticeSet(answersArray) {
  if (isSubmitting) return;
  isSubmitting = true;
  roundEnded = true;
  stopRoundTimer();
  pendingSubmissionAnswers = answersArray;
  showErrorBanner('');

  const inputEl = document.getElementById('player-answer-input');
  const nextBtn = document.getElementById('btn-next-question');
  const skipBtn = document.getElementById('btn-skip-question');
  const finishBtn = document.getElementById('btn-finish-round');
  if (inputEl) inputEl.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
  if (skipBtn) skipBtn.disabled = true;
  if (finishBtn) finishBtn.disabled = true;

  try {
    let resultData = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/drill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'submit',
          session_id: activeSessionId,
          answers: answersArray,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not submit your practice round.');
      }
      resultData = data;
    } else if (isDemoMode()) {
      resultData = DemoDB.mockBasicsDrillSubmit(
        activeSessionId,
        answersArray,
        currentProfile?.id || 'usr-101',
        selectedCategory?.id || 'cat-bas-1',
        activeMode
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    pendingSubmissionAnswers = null;
    await refreshCategoryResults();
    renderSetupSummary();
    await renderResultsScreen(resultData);
  } catch (err) {
    showErrorBanner(err.message || 'Failed to save your practice round.');
    showToast('error', err.message || 'Failed to save your practice round.');
    const retryBox = document.getElementById('player-submit-retry-box');
    const answerForm = document.getElementById('player-answer-form');
    if (answerForm) answerForm.style.display = 'none';
    if (retryBox) retryBox.style.display = 'block';
  } finally {
    isSubmitting = false;
    if (inputEl) inputEl.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
    if (skipBtn) skipBtn.disabled = false;
    if (finishBtn) finishBtn.disabled = false;
  }
}

/**
 * Renders the question-by-question review table (first 100 attempted questions,
 * wrong ones first, with a "Show all" toggle).
 */
function renderReviewList() {
  const reviewTbody = document.getElementById('result-review-tbody');
  const toggleBtn = document.getElementById('btn-toggle-review-all');
  const headingEl = document.getElementById('result-review-heading');
  if (!reviewTbody) return;

  // Sort wrong answers first, preserving original question order within each group
  const sorted = [...currentReviewItems].sort((a, b) => {
    if (!a.correct && b.correct) return -1;
    if (a.correct && !b.correct) return 1;
    return a.index - b.index;
  });

  const wrongItems = sorted.filter((item) => !item.correct);
  const hasBothWrongAndCorrect =
    wrongItems.length > 0 && wrongItems.length < sorted.length;

  const visibleItems =
    hasBothWrongAndCorrect && !showAllReviewItems ? wrongItems : sorted;

  if (headingEl) {
    headingEl.textContent = `Question Review (${currentReviewItems.length} shown, wrong ones first)`;
  }

  if (toggleBtn) {
    if (hasBothWrongAndCorrect) {
      toggleBtn.style.display = 'inline-flex';
      toggleBtn.textContent = showAllReviewItems
        ? `Show wrong only (${wrongItems.length})`
        : `Show all (${sorted.length})`;
    } else {
      toggleBtn.style.display = 'none';
    }
  }

  reviewTbody.innerHTML = visibleItems
    .map((item) => {
      const givenVal = item.given ?? item.answer ?? null;
      const givenDisplay =
        givenVal === null || givenVal === undefined || givenVal === ''
          ? '<em style="color: var(--text-dim);">Skipped</em>'
          : `<span class="num">${escapeHtml(String(givenVal))}</span>`;
      const expectedStr =
        item.expected_display !== undefined
          ? String(item.expected_display)
          : String(item.expected ?? '');
      const statusChip = item.correct
        ? '<span class="score-tag score-tag-perfect">Correct</span>'
        : '<span class="score-tag score-tag-warning">Wrong</span>';

      return `
        <tr>
          <td class="num" style="color: var(--text-muted);">${item.index}</td>
          <td class="num" style="font-weight: 700;">${escapeHtml(item.question)}</td>
          <td>${givenDisplay}</td>
          <td class="num" style="font-weight: 700;">${escapeHtml(expectedStr)}</td>
          <td>${statusChip}</td>
        </tr>
      `;
    })
    .join('');
}

/**
 * Fetches `meets_target` from `results_with_target` for the newly saved `result_id`
 * and renders the Results & Review screen.
 */
async function renderResultsScreen(resultData) {
  showScreen('screen-results');

  const correct = Number(resultData.correct) || 0;
  const attempted = Number(resultData.attempted ?? resultData.total) || 0;
  const usedSeconds = Number(resultData.used_seconds ?? resultData.seconds) || 0;
  const rates = computePerMinuteRates(correct, attempted, usedSeconds);
  const accuracy =
    resultData.accuracy !== undefined ? Number(resultData.accuracy) : rates.accuracy;
  const cpm =
    resultData.correct_per_minute !== undefined
      ? Number(resultData.correct_per_minute)
      : rates.correct_per_minute;
  const apm =
    resultData.attempted_per_minute !== undefined
      ? Number(resultData.attempted_per_minute)
      : rates.attempted_per_minute;

  const scoreEl = document.getElementById('result-score-text');
  const wrongBadgeEl = document.getElementById('result-wrong-badge');
  const accEl = document.getElementById('result-accuracy-text');
  const timeEl = document.getElementById('result-time-text');
  const secSubEl = document.getElementById('result-seconds-subtext');
  const cpmEl = document.getElementById('result-cpm-text');
  const apmEl = document.getElementById('result-apm-subtext');
  const modeChipEl = document.getElementById('result-mode-chip');
  const pbBannerEl = document.getElementById('result-pb-banner');
  const targetChipContainer = document.getElementById('result-target-chip-container');

  if (modeChipEl) {
    modeChipEl.textContent = activeMode === 'unlimited' ? 'Unlimited' : 'Timed';
  }

  if (scoreEl) scoreEl.textContent = `${correct} / ${attempted}`;

  const feedback = getScoreFeedback(correct, attempted);
  if (wrongBadgeEl) {
    wrongBadgeEl.textContent = feedback.wrongText;
    wrongBadgeEl.className = `score-tag ${feedback.badgeClass}`;
  }

  if (accEl) {
    accEl.textContent = `${accuracy}%`;
    accEl.style.color = feedback.colorVar;
  }

  if (timeEl) timeEl.textContent = formatSecondsToMMSS(usedSeconds);
  if (secSubEl) secSubEl.textContent = `${usedSeconds}s`;

  if (cpmEl) cpmEl.textContent = `${cpm.toFixed(1)} correct / min`;
  if (apmEl) apmEl.textContent = `${apm.toFixed(1)} attempted / min`;

  // Check if this round set a new personal best for this category & mode
  const candidateRow = {
    correct,
    total: attempted,
    attempted,
    time_seconds: usedSeconds,
    used_seconds: usedSeconds,
    practice_mode: activeMode,
  };
  const isNewPersonalBest =
    attempted > 0 &&
    (!previousBestBeforeSubmit ||
      compareModeResults(candidateRow, previousBestBeforeSubmit, activeMode) < 0);

  if (pbBannerEl) {
    pbBannerEl.style.display = isNewPersonalBest ? 'block' : 'none';
  }

  // Read meets_target strictly from results_with_target for the saved row (never calculate in JS)
  let meetsTarget = null;
  if (resultData.result_id) {
    const matchedLocal = categoryResults.find((r) => r.id === resultData.result_id);
    if (matchedLocal && matchedLocal.meets_target !== undefined) {
      meetsTarget = matchedLocal.meets_target;
    } else if (isSupabaseConfigured()) {
      try {
        const supabase = await getSupabase();
        if (supabase) {
          const { data: viewRow } = await supabase
            .from('results_with_target')
            .select('id, meets_target')
            .eq('id', resultData.result_id)
            .single();
          if (viewRow && viewRow.meets_target !== undefined) {
            meetsTarget = viewRow.meets_target;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  if (targetChipContainer) {
    if (meetsTarget === true) {
      targetChipContainer.innerHTML = `
        <span class="status-chip chip-verified" title="Meets target benchmark">
          🎯 Target met
        </span>
      `;
    } else if (meetsTarget === false) {
      targetChipContainer.innerHTML = `
        <span class="status-chip" style="background-color: rgba(239, 68, 68, 0.12); color: #B91C1C; border: 1px solid rgba(239, 68, 68, 0.3);" title="Below target benchmark">
          ⚠️ Below target
        </span>
      `;
    } else {
      targetChipContainer.innerHTML = '';
    }
  }

  const rawDetails = Array.isArray(resultData.detail) ? resultData.detail.slice(0, 100) : [];
  currentReviewItems = rawDetails.map((item, idx) => ({
    ...item,
    index: idx + 1,
  }));
  showAllReviewItems = false;
  renderReviewList();
}

async function initBasicsPracticePage() {
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

  renderDemoBannerIfNeeded();

  // Start button
  document
    .getElementById('btn-start-practice')
    ?.addEventListener('click', startPracticeSession);

  // Answer form submit (Enter key or Next button)
  document.getElementById('player-answer-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!activePlayer || isSubmitting || roundEnded) return;
    const inputEl = document.getElementById('player-answer-input');
    const val = inputEl ? inputEl.value : '';
    activePlayer.answer(val);
    renderCurrentPlayerQuestion();
  });

  // Skip button
  document.getElementById('btn-skip-question')?.addEventListener('click', () => {
    if (!activePlayer || isSubmitting || roundEnded) return;
    activePlayer.skip();
    renderCurrentPlayerQuestion();
  });

  // Finish button in top bar
  document
    .getElementById('btn-finish-round')
    ?.addEventListener('click', handleManualFinishClick);

  // Retry submit button if network failed
  document.getElementById('btn-retry-submit')?.addEventListener('click', () => {
    if (pendingSubmissionAnswers) {
      submitCompletedPracticeSet(pendingSubmissionAnswers);
    }
  });

  // Toggle "Show all" in question review
  document.getElementById('btn-toggle-review-all')?.addEventListener('click', () => {
    showAllReviewItems = !showAllReviewItems;
    renderReviewList();
  });

  // "Same mode again" button on results screen
  document.getElementById('btn-same-mode-again')?.addEventListener('click', () => {
    startPracticeSession();
  });

  // "Change mode" button on results screen
  document.getElementById('btn-change-mode')?.addEventListener('click', () => {
    showErrorBanner('');
    renderSetupSummary();
    showScreen('screen-setup');
  });

  const urlParams = new URLSearchParams(window.location.search);
  const catParam = urlParams.get('cat') || urlParams.get('category_id') || '';
  await loadSetupData(catParam);
}

document.addEventListener('DOMContentLoaded', initBasicsPracticePage);
