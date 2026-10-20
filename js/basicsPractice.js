/**
 * Trendz Tracker — Online Basics Practice Controller (js/basicsPractice.js)
 *
 * Powers /pages/basics-practice.html?cat=<category_id>:
 * - Protected by requireAuth(['student', 'admin']).
 * - Setup screen: category name, question count selector (5, 10, 20; default 10),
 *   student's target benchmark from `basics_thresholds`, and Personal Best for
 *   this category + question count (`bestResult` from `js/practiceStats.js`).
 * - Active player screen: driven by `createDrillPlayer` (`js/drillPlayer.js`),
 *   showing vertical signed rows with a horizontal line for `<N>d<R>r`,
 *   `"47 x 8"` for multiplication, and `"84 / 7"` for division, a visible
 *   count-up stopwatch, Enter/Next and Skip controls (no Back button).
 * - Results screen: `"This set was saved to your scores."`, score, accuracy,
 *   time, `getScoreFeedback` badge (`"n wrong"`), `"Target met"` / `"Below target"`
 *   chip read from `results_with_target` for the saved `result_id`, review table,
 *   and `"Again"` / `"Back to basics"` buttons.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { createDrillPlayer } from './drillPlayer.js';
import { requireAuth } from './guard.js';
import {
  BASICS_DEFAULT_QUESTIONS,
  BASICS_QUESTION_COUNTS,
  bestResult,
  isBasicsOnlineAvailable,
} from './practiceStats.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToTime } from './stats.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS } from './timeUtils.js';
import { showToast } from './toast.js';

let currentProfile = null;
let selectedCategory = null;
let selectedQuestionCount = BASICS_DEFAULT_QUESTIONS;
let categoryResults = [];
let effectiveTarget = null;

// Active session & player state
let activeSessionId = null;
let activePlayer = null;
let stopwatchStartMs = 0;
let stopwatchTimerId = null;
let pendingSubmissionAnswers = null;
let isSubmitting = false;

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
        <strong>DEMO MODE &mdash; sample practice set:</strong>
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

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const [catRes, threshRes] = await Promise.all([
        supabase
          .from('categories')
          .select('*')
          .eq('section', 'basics')
          .eq('active', true)
          .order('sort_order', { ascending: true }),
        supabase.from('basics_thresholds').select('*').eq('active', true),
      ]);
      if (!catRes.error && Array.isArray(catRes.data)) {
        categories = catRes.data;
      }
      if (!threshRes.error && Array.isArray(threshRes.data)) {
        thresholds = threshRes.data;
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
        min_accuracy: Number(rule.min_accuracy),
        max_time_seconds:
          rule.max_time_seconds !== null && rule.max_time_seconds !== undefined
            ? Number(rule.max_time_seconds)
            : null,
      }
    : null;

  await refreshCategoryResults();
  renderSetupSummary();
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
          .select('id, student_id, student_round_id, category_id, correct, total, time_seconds, entry_date, created_at, source, meets_target')
          .eq('student_id', currentProfile.id)
          .eq('category_id', selectedCategory.id)
          .order('created_at', { ascending: false });

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
  const bestLabelEl = document.getElementById('setup-best-qcount-label');
  const bestTextEl = document.getElementById('setup-best-text');

  if (bestLabelEl) {
    bestLabelEl.textContent = String(selectedQuestionCount);
  }

  if (targetTextEl) {
    if (effectiveTarget) {
      const accPart = `${effectiveTarget.min_accuracy}% accuracy`;
      const timePart = effectiveTarget.max_time_seconds
        ? ` in ${formatSecondsToTime(effectiveTarget.max_time_seconds)} or less`
        : '';
      targetTextEl.textContent = `${accPart}${timePart}`;
    } else {
      targetTextEl.textContent = 'No target set for your level';
    }
  }

  if (bestTextEl && selectedCategory) {
    const best = bestResult(categoryResults, selectedCategory.id, selectedQuestionCount);
    if (best) {
      const timeStr =
        best.time_seconds !== null && best.time_seconds !== undefined
          ? ` in ${formatSecondsToMMSS(best.time_seconds)}`
          : '';
      bestTextEl.textContent = `${best.correct} / ${best.total} (${best.accuracy}%)${timeStr}`;
    } else {
      bestTextEl.textContent = `No ${selectedQuestionCount}-question set recorded yet`;
    }
  }

  // Update active button state in question count selector
  document.querySelectorAll('.btn-qcount').forEach((btn) => {
    const countVal = Number(btn.getAttribute('data-count'));
    if (countVal === selectedQuestionCount) {
      btn.className = 'btn btn-primary btn-qcount';
      btn.setAttribute('aria-pressed', 'true');
    } else {
      btn.className = 'btn btn-outline btn-qcount';
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

function startStopwatch() {
  stopStopwatch();
  stopwatchStartMs = performance.now();
  const stopwatchEl = document.getElementById('player-stopwatch');
  if (stopwatchEl) stopwatchEl.textContent = '0:00';

  stopwatchTimerId = window.setInterval(() => {
    const elapsedSec = Math.max(0, Math.floor((performance.now() - stopwatchStartMs) / 1000));
    if (stopwatchEl) {
      stopwatchEl.textContent = formatSecondsToMMSS(elapsedSec);
    }
  }, 250);
}

function stopStopwatch() {
  if (stopwatchTimerId !== null) {
    clearInterval(stopwatchTimerId);
    stopwatchTimerId = null;
  }
}

/**
 * Renders the current question inside the one-question-at-a-time player:
 * - Add/Sub (`type === 'add_sub'`): vertical column of signed numbers (`+ 4`, `- 3`),
 *   a horizontal line underneath, then the answer box.
 * - Multiplication (`type === 'mul'`): `"47 x 8"`.
 * - Division (`type === 'div'`): `"84 / 7"`.
 */
function renderCurrentPlayerQuestion() {
  if (!activePlayer) return;
  const state = activePlayer.getState();

  if (state.isFinished) {
    const finalAnswers = activePlayer.finish();
    if (finalAnswers !== null) {
      submitCompletedPracticeSet(finalAnswers);
    }
    return;
  }

  const progressEl = document.getElementById('player-progress-label');
  const skippedBanner = document.getElementById('player-skipped-banner');
  const stageEl = document.getElementById('player-question-stage');
  const inputEl = document.getElementById('player-answer-input');
  const badgeEl = document.getElementById('player-category-badge');

  if (badgeEl && selectedCategory) {
    badgeEl.textContent = selectedCategory.name;
  }

  if (progressEl) {
    if (state.isRevisitingSkipped) {
      progressEl.textContent = `Skipped Question #${state.currentNumber} (${state.remainingInCurrentPass} remaining)`;
    } else {
      progressEl.textContent = `Question ${state.currentNumber} of ${state.total}`;
    }
  }

  if (skippedBanner) {
    skippedBanner.style.display = state.isRevisitingSkipped ? 'inline-flex' : 'none';
  }

  const q = state.currentQuestion;
  if (stageEl && q) {
    if (typeof q === 'object' && Array.isArray(q.rows)) {
      // Vertical rows with sign and a summation line underneath
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
  const againBtn = document.getElementById('btn-practice-again');
  if (startBtn) startBtn.disabled = true;
  if (againBtn) againBtn.disabled = true;

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
          questions: selectedQuestionCount,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not start online practice set.');
      }
      payload = data;
    } else if (isDemoMode()) {
      payload = DemoDB.mockBasicsDrillStart(selectedCategory.id);
    } else {
      throw new Error('Database connection is not configured.');
    }

    activeSessionId = payload.session_id;
    if (payload.target) {
      effectiveTarget = payload.target;
    }

    pendingSubmissionAnswers = null;
    const retryBox = document.getElementById('player-submit-retry-box');
    const answerForm = document.getElementById('player-answer-form');
    if (retryBox) retryBox.style.display = 'none';
    if (answerForm) answerForm.style.display = 'flex';

    activePlayer = createDrillPlayer(payload.questions || []);
    showScreen('screen-player');
    startStopwatch();
    renderCurrentPlayerQuestion();
  } catch (err) {
    showErrorBanner(err.message || 'Failed to start practice session.');
    showToast('error', err.message || 'Failed to start practice session.');
  } finally {
    if (startBtn) startBtn.disabled = false;
    if (againBtn) againBtn.disabled = false;
  }
}

/**
 * Submits the finished answers array to `POST /api/drill` (`action: 'submit'`).
 */
async function submitCompletedPracticeSet(answersArray) {
  if (isSubmitting) return;
  isSubmitting = true;
  stopStopwatch();
  pendingSubmissionAnswers = answersArray;
  showErrorBanner('');

  const inputEl = document.getElementById('player-answer-input');
  const nextBtn = document.getElementById('btn-next-question');
  const skipBtn = document.getElementById('btn-skip-question');
  if (inputEl) inputEl.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
  if (skipBtn) skipBtn.disabled = true;

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
        throw new Error(data.error || 'Could not submit your practice set.');
      }
      resultData = data;
    } else if (isDemoMode()) {
      resultData = DemoDB.mockBasicsDrillSubmit(
        activeSessionId,
        answersArray,
        currentProfile?.id || 'usr-101',
        selectedCategory?.id || 'cat-bas-1'
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    pendingSubmissionAnswers = null;
    await refreshCategoryResults();
    renderSetupSummary();
    await renderResultsScreen(resultData);
  } catch (err) {
    showErrorBanner(err.message || 'Failed to save your practice set.');
    showToast('error', err.message || 'Failed to save your practice set.');
    const retryBox = document.getElementById('player-submit-retry-box');
    if (retryBox) retryBox.style.display = 'block';
  } finally {
    isSubmitting = false;
    if (inputEl) inputEl.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
    if (skipBtn) skipBtn.disabled = false;
  }
}

/**
 * Fetches `meets_target` from `results_with_target` for the newly saved `result_id`
 * and renders the Results & Review screen.
 */
async function renderResultsScreen(resultData) {
  showScreen('screen-results');

  const correct = Number(resultData.correct) || 0;
  const total = Number(resultData.total) || 0;
  const accuracy =
    resultData.accuracy !== undefined
      ? Number(resultData.accuracy)
      : total > 0
        ? Math.round((correct / total) * 1000) / 10
        : 0;
  const seconds = Number(resultData.seconds) || 0;

  const scoreEl = document.getElementById('result-score-text');
  const wrongBadgeEl = document.getElementById('result-wrong-badge');
  const accEl = document.getElementById('result-accuracy-text');
  const timeEl = document.getElementById('result-time-text');
  const secSubEl = document.getElementById('result-seconds-subtext');
  const targetChipContainer = document.getElementById('result-target-chip-container');
  const reviewTbody = document.getElementById('result-review-tbody');

  if (scoreEl) scoreEl.textContent = `${correct} / ${total}`;

  const feedback = getScoreFeedback(correct, total);
  if (wrongBadgeEl) {
    wrongBadgeEl.textContent = feedback.wrongText;
    wrongBadgeEl.className = `score-tag ${feedback.badgeClass}`;
  }

  if (accEl) {
    accEl.textContent = `${accuracy}%`;
    accEl.style.color = feedback.colorVar;
  }

  if (timeEl) timeEl.textContent = formatSecondsToMMSS(seconds);
  if (secSubEl) secSubEl.textContent = `${seconds}s`;

  // Read meets_target from results_with_target for the saved row (resultData.result_id)
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

  if (reviewTbody) {
    const details = Array.isArray(resultData.detail) ? resultData.detail : [];
    reviewTbody.innerHTML = details
      .map((item, idx) => {
        const givenDisplay =
          item.given === null || item.given === undefined || item.given === ''
            ? '<em style="color: var(--text-dim);">Skipped</em>'
            : `<span class="num">${escapeHtml(String(item.given))}</span>`;
        const statusChip = item.correct
          ? '<span class="score-tag score-tag-perfect">Correct</span>'
          : '<span class="score-tag score-tag-warning">Wrong</span>';

        return `
          <tr>
            <td class="num" style="color: var(--text-muted);">${idx + 1}</td>
            <td class="num" style="font-weight: 700;">${escapeHtml(item.question)}</td>
            <td>${givenDisplay}</td>
            <td class="num" style="font-weight: 700;">${escapeHtml(String(item.expected_display))}</td>
            <td>${statusChip}</td>
          </tr>
        `;
      })
      .join('');
  }
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

  // Question count selector buttons (5 / 10 / 20)
  document.querySelectorAll('.btn-qcount').forEach((btn) => {
    btn.addEventListener('click', () => {
      const count = Number(btn.getAttribute('data-count'));
      if (BASICS_QUESTION_COUNTS.includes(count)) {
        selectedQuestionCount = count;
        renderSetupSummary();
      }
    });
  });

  // Start Practice button
  document
    .getElementById('btn-start-practice')
    ?.addEventListener('click', startPracticeSession);

  // Answer form submit (Enter key or Next button)
  document.getElementById('player-answer-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!activePlayer || isSubmitting) return;
    const inputEl = document.getElementById('player-answer-input');
    const val = inputEl ? inputEl.value : '';
    activePlayer.answer(val);
    renderCurrentPlayerQuestion();
  });

  // Skip button
  document.getElementById('btn-skip-question')?.addEventListener('click', () => {
    if (!activePlayer || isSubmitting) return;
    activePlayer.skip();
    renderCurrentPlayerQuestion();
  });

  // Retry submit button if network failed
  document.getElementById('btn-retry-submit')?.addEventListener('click', () => {
    if (pendingSubmissionAnswers) {
      submitCompletedPracticeSet(pendingSubmissionAnswers);
    }
  });

  // Again button on results screen
  document.getElementById('btn-practice-again')?.addEventListener('click', () => {
    startPracticeSession();
  });

  const urlParams = new URLSearchParams(window.location.search);
  const catParam = urlParams.get('cat') || urlParams.get('category_id') || '';
  await loadSetupData(catParam);
}

document.addEventListener('DOMContentLoaded', initBasicsPracticePage);
