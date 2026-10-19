/**
 * Trendz Tracker — Elements Worksheet Drill Controller (js/elementDrill.js)
 *
 * Implements the student timed worksheet lifecycle for `/pages/element-drill.html?drill=<key>`:
 * 1. Intro Screen: Displays drill metadata, personal best, answer hint, and Start button.
 * 2. Active Worksheet:
 *    - Calls `POST /api/drill { action: 'start', drill }` (or DemoDB sample in Demo Mode).
 *    - Renders all questions in a responsive grid (1 col mobile, 2–3 cols desktop).
 *    - Each input uses `inputmode="numeric"` or `inputmode="text"` and `aria-label="Answer for question n"`.
 *    - `Enter`, `Tab`, and `ArrowDown` move focus to the next input.
 *    - Sticky timer bar updates every 250 ms from a fixed `performance.now()` end time;
 *      auto-submits and locks inputs at 00:00.
 * 3. Network-Resilient Submission:
 *    - Blank answers are sent as `null`.
 *    - If submitting fails due to a network error, preserves typed answers on screen
 *      and offers "Try sending again" until the session expires (`time_limit + 30s`).
 * 4. Result & Review Screen:
 *    - Shows `correct / attempted`, blank count, accuracy, time, `getScoreFeedback(correct, attempted)`
 *      colour + "n wrong" text, "New personal best" banner when earned, and full question review.
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import {
  DRILL_CATALOG,
  formatDrillTimeLimit,
} from './drillCatalog.js';
import {
  bestForDrill,
  isNewPersonalBest,
} from './drillStats.js';
import { fetchStudentElementResults } from './elementsCard.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToMMSS } from './timeUtils.js';

const TIMER_INTERVAL_MS = 250;
const EXPIRY_GRACE_SECONDS = 30;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let currentUser = null;
let currentDrillKey = '';
let currentDrillMeta = null;
let previousBestForDrill = null;

// Active session state
let activeSessionId = null;
let activeQuestions = [];
let activeTimeLimitSec = 60;
let timerIntervalId = null;
let expiryCheckIntervalId = null;
let worksheetStartPerfMs = 0;
let worksheetEndPerfMs = 0;
let worksheetExpiresPerfMs = 0;
let isStarting = false;
let isSubmitting = false;
let hasSubmitted = false;

async function initElementDrillPage() {
  const user = await requireAuth(['student', 'admin']);
  if (!user) return;
  currentUser = user;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  const params = new URLSearchParams(window.location.search);
  currentDrillKey = String(params.get('drill') || '').trim();
  currentDrillMeta = DRILL_CATALOG[currentDrillKey] || null;

  const startBtn = document.getElementById('btn-start-drill');
  const submitNowBtn = document.getElementById('btn-submit-now');
  const retrySubmitBtn = document.getElementById('btn-retry-submit');
  const expiredNewSetBtn = document.getElementById('btn-expired-new-set');
  const sameDrillAgainBtn = document.getElementById('btn-same-drill-again');
  const worksheetForm = document.getElementById('worksheet-form');

  if (!currentDrillMeta) {
    showIntroError('Unknown drill selected. Please choose a drill from the Elements catalog.');
    if (startBtn) startBtn.disabled = true;
    return;
  }

  document.title = `${currentDrillMeta.title} - Elements Drill - Trendz Tracker`;

  await populateIntroScreen();

  if (!currentDrillMeta.enabled) {
    showIntroError('This drill is marked "Coming soon" and is not enabled yet.');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = 'Coming soon';
    }
    return;
  }

  startBtn?.addEventListener('click', () => handleStartDrill());

  submitNowBtn?.addEventListener('click', () => {
    submitWorksheet(false);
  });

  worksheetForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWorksheet(false);
  });

  retrySubmitBtn?.addEventListener('click', () => {
    submitWorksheet(true);
  });

  expiredNewSetBtn?.addEventListener('click', () => {
    resetToIntroScreen();
  });

  sameDrillAgainBtn?.addEventListener('click', () => {
    resetToIntroScreen();
  });
}

async function populateIntroScreen() {
  const groupEl = document.getElementById('intro-drill-group');
  const titleEl = document.getElementById('intro-drill-title');
  const questionsEl = document.getElementById('intro-drill-questions');
  const timeEl = document.getElementById('intro-drill-time');
  const hintEl = document.getElementById('intro-drill-hint');
  const bestEl = document.getElementById('intro-drill-best');

  if (groupEl) groupEl.textContent = `${currentDrillMeta.group} · Elements Worksheet`;
  if (titleEl) titleEl.textContent = currentDrillMeta.title;
  if (questionsEl) questionsEl.textContent = `${currentDrillMeta.questions} questions`;
  if (timeEl) timeEl.textContent = formatDrillTimeLimit(currentDrillMeta.time_limit_seconds);
  if (hintEl) hintEl.textContent = currentDrillMeta.hint;

  const allResults = await fetchStudentElementResults(currentUser.id);
  previousBestForDrill = bestForDrill(allResults, currentDrillKey);

  if (bestEl) {
    if (previousBestForDrill) {
      const fb = getScoreFeedback(previousBestForDrill.correct, previousBestForDrill.total);
      const timeStr = formatSecondsToMMSS(previousBestForDrill.time_seconds);
      bestEl.innerHTML = `
        <span style="color: ${fb.colorVar};">${previousBestForDrill.correct}/${previousBestForDrill.total}</span>
        <span class="score-tag ${fb.badgeClass}" style="font-size: 11px; margin-left: 4px;">${escapeHtml(fb.wrongText)}</span>
        <span style="color: var(--text-muted); font-weight: 600; margin-left: 4px;">· ${escapeHtml(timeStr)}</span>
      `;
    } else {
      bestEl.textContent = 'No attempts yet';
    }
  }
}

function showIntroError(msg) {
  const alertEl = document.getElementById('intro-error-alert');
  if (!alertEl) return;
  if (!msg) {
    alertEl.style.display = 'none';
    alertEl.textContent = '';
    return;
  }
  alertEl.textContent = msg;
  alertEl.style.display = 'block';
}

async function getBearerToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function handleStartDrill() {
  if (isStarting || !currentDrillMeta || !currentDrillMeta.enabled) return;
  isStarting = true;
  showIntroError('');

  const startBtn = document.getElementById('btn-start-drill');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  }

  try {
    let payload = null;

    if (isSupabaseConfigured()) {
      const token = await getBearerToken();
      if (!token) {
        throw new Error('Your login session expired. Please sign in again.');
      }

      const res = await fetch('/api/drill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'start',
          drill: currentDrillKey,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Could not start drill (HTTP ${res.status}).`);
      }
      payload = data;
    } else if (isDemoMode()) {
      payload = DemoDB.mockElementDrillStart(currentDrillKey, currentDrillMeta);
    } else {
      throw new Error('Server connection is not configured.');
    }

    activeSessionId = payload.session_id;
    activeQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    activeTimeLimitSec = Number(payload.time_limit_seconds) || currentDrillMeta.time_limit_seconds;
    hasSubmitted = false;
    isSubmitting = false;

    renderWorksheet(payload);
  } catch (err) {
    showIntroError(err.message || 'Could not start the drill. Please try again.');
  } finally {
    isStarting = false;
    if (startBtn && currentDrillMeta?.enabled) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start Worksheet →';
    }
  }
}

function renderWorksheet(payload) {
  stopTimers();

  const introScreen = document.getElementById('drill-intro-screen');
  const worksheetScreen = document.getElementById('drill-worksheet-screen');
  const resultScreen = document.getElementById('drill-result-screen');
  const retryBanner = document.getElementById('worksheet-retry-banner');
  const submitNowBtn = document.getElementById('btn-submit-now');

  if (introScreen) introScreen.style.display = 'none';
  if (resultScreen) resultScreen.style.display = 'none';
  if (worksheetScreen) worksheetScreen.style.display = 'block';
  if (retryBanner) retryBanner.style.display = 'none';
  if (submitNowBtn) {
    submitNowBtn.disabled = false;
    submitNowBtn.textContent = 'Submit now';
  }

  const titleEl = document.getElementById('worksheet-drill-title');
  const hintEl = document.getElementById('worksheet-drill-hint');
  if (titleEl) titleEl.textContent = `${payload.title || currentDrillMeta.title} (${activeQuestions.length} questions)`;
  if (hintEl) hintEl.textContent = payload.hint || currentDrillMeta.hint;

  const gridEl = document.getElementById('worksheet-questions-grid');
  const inputMode = currentDrillMeta.inputmode === 'text' ? 'text' : 'numeric';

  if (gridEl) {
    gridEl.innerHTML = activeQuestions
      .map((qText, idx) => {
        const qNum = idx + 1;
        return `
          <div class="element-question-row">
            <span class="num" style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted); min-width: 28px;">
              ${qNum}.
            </span>
            <label for="element-ans-${qNum}" class="element-question-prompt">
              ${escapeHtml(qText)}
            </label>
            <input
              type="text"
              id="element-ans-${qNum}"
              data-question-index="${idx}"
              class="element-answer-input"
              inputmode="${inputMode}"
              aria-label="Answer for question ${qNum}"
              maxlength="40"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
            />
          </div>
        `;
      })
      .join('');
  }

  const inputs = getWorksheetInputs();
  inputs.forEach((input, idx) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        if (idx + 1 < inputs.length) {
          e.preventDefault();
          inputs[idx + 1].focus();
          inputs[idx + 1].select?.();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          submitWorksheet(false);
        }
      } else if (e.key === 'ArrowUp') {
        if (idx - 1 >= 0) {
          e.preventDefault();
          inputs[idx - 1].focus();
          inputs[idx - 1].select?.();
        }
      }
    });
  });

  // Start timer when the worksheet is rendered
  worksheetStartPerfMs = performance.now();
  worksheetEndPerfMs = worksheetStartPerfMs + activeTimeLimitSec * 1000;
  worksheetExpiresPerfMs =
    worksheetStartPerfMs + (activeTimeLimitSec + EXPIRY_GRACE_SECONDS) * 1000;

  updateTimerDisplay();
  timerIntervalId = setInterval(updateTimerDisplay, TIMER_INTERVAL_MS);

  // Focus first question input
  if (inputs.length > 0) {
    inputs[0].focus();
  }
}

function getWorksheetInputs() {
  const gridEl = document.getElementById('worksheet-questions-grid');
  if (!gridEl) return [];
  return Array.from(gridEl.querySelectorAll('.element-answer-input'));
}

function setWorksheetInputsDisabled(disabled) {
  const inputs = getWorksheetInputs();
  inputs.forEach((inp) => {
    inp.disabled = disabled;
  });
}

function collectWorksheetAnswers() {
  const inputs = getWorksheetInputs();
  return inputs.map((inp) => {
    const raw = typeof inp.value === 'string' ? inp.value.trim() : '';
    return raw === '' ? null : raw.slice(0, 40);
  });
}

function updateTimerDisplay() {
  const nowPerf = performance.now();
  const remainingMs = Math.max(0, worksheetEndPerfMs - nowPerf);
  const remainingSec = Math.ceil(remainingMs / 1000);

  const timerEl = document.getElementById('worksheet-timer-display');
  const progressEl = document.getElementById('worksheet-progress-bar');

  if (timerEl) {
    timerEl.textContent = formatSecondsToMMSS(remainingSec);
    if (remainingSec <= 10) {
      timerEl.style.color = 'var(--color-danger)';
    } else if (remainingSec <= 30) {
      timerEl.style.color = 'var(--color-score-warning)';
    } else {
      timerEl.style.color = 'var(--color-primary)';
    }
  }

  if (progressEl && activeTimeLimitSec > 0) {
    const pct = Math.max(0, Math.min(100, (remainingMs / (activeTimeLimitSec * 1000)) * 100));
    progressEl.style.width = `${pct.toFixed(1)}%`;
  }

  if (remainingMs <= 0) {
    stopTimers();
    setWorksheetInputsDisabled(true);
    if (!hasSubmitted && !isSubmitting) {
      submitWorksheet(true);
    }
  }
}

function stopTimers() {
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  if (expiryCheckIntervalId) {
    clearInterval(expiryCheckIntervalId);
    expiryCheckIntervalId = null;
  }
}

async function submitWorksheet(isAutoOrRetry = false) {
  if (isSubmitting || hasSubmitted || !activeSessionId) return;

  isSubmitting = true;
  stopTimers();
  setWorksheetInputsDisabled(true);

  const submitNowBtn = document.getElementById('btn-submit-now');
  const retryBanner = document.getElementById('worksheet-retry-banner');
  const retryBtn = document.getElementById('btn-retry-submit');

  if (submitNowBtn) {
    submitNowBtn.disabled = true;
    submitNowBtn.textContent = 'Submitting...';
  }
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Sending...';
  }

  const answers = collectWorksheetAnswers();
  const attemptedCount = answers.filter((a) => a !== null).length;
  const elapsedSeconds = Math.max(
    1,
    Math.min(
      activeTimeLimitSec,
      Math.round((performance.now() - worksheetStartPerfMs) / 1000)
    )
  );

  try {
    let resultData = null;

    if (isSupabaseConfigured()) {
      const token = await getBearerToken();
      if (!token) {
        throw new Error('Your login session has expired. Please sign in again.');
      }

      let res;
      try {
        res = await fetch('/api/drill', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'submit',
            session_id: activeSessionId,
            answers,
          }),
        });
      } catch {
        const netErr = new Error('Network error while sending your answers.');
        netErr.isNetworkError = true;
        throw netErr;
      }

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg = String(body.error || '');
        // Handle 0-attempted case gracefully on the result screen
        if (attemptedCount === 0 && msg.toLowerCase().includes('nothing was saved')) {
          hasSubmitted = true;
          renderResultScreen({
            correct: 0,
            attempted: 0,
            questions_total: activeQuestions.length,
            accuracy: 0,
            seconds: elapsedSeconds,
            detail: activeQuestions.map((q) => ({
              question: q,
              expected_display: '—',
              given: null,
              correct: false,
            })),
            noticeMessage: 'No questions were answered, so nothing was saved.',
          });
          return;
        }

        if (res.status >= 500) {
          const srvErr = new Error(
            msg || 'Server error while saving your drill. Please try sending again.'
          );
          srvErr.isNetworkError = true;
          throw srvErr;
        }

        const clientErr = new Error(msg || 'Could not submit this worksheet.');
        clientErr.isExpired = msg.toLowerCase().includes('time is up');
        throw clientErr;
      }

      resultData = body;
    } else if (isDemoMode()) {
      if (attemptedCount === 0) {
        hasSubmitted = true;
        renderResultScreen({
          correct: 0,
          attempted: 0,
          questions_total: activeQuestions.length,
          accuracy: 0,
          seconds: elapsedSeconds,
          detail: activeQuestions.map((q) => ({
            question: q,
            expected_display: '—',
            given: null,
            correct: false,
          })),
          noticeMessage: 'No questions were answered, so nothing was saved.',
        });
        return;
      }
      resultData = DemoDB.mockElementDrillSubmit(
        activeSessionId,
        answers,
        currentUser.id,
        currentDrillMeta
      );
    }

    hasSubmitted = true;
    if (retryBanner) retryBanner.style.display = 'none';
    renderResultScreen(resultData);
  } catch (err) {
    isSubmitting = false;

    if (err.isNetworkError) {
      showNetworkRetryBanner(err.message);
      return;
    }

    if (err.isExpired) {
      showExpiredBanner('Time is up — this drill session has expired. Please start a new set.');
      return;
    }

    // Other validation errors (e.g., finished faster than possible, or already submitted)
    showExpiredBanner(err.message || 'Could not submit this set. Please start a new set.');
  }
}

function showNetworkRetryBanner(message) {
  const retryBanner = document.getElementById('worksheet-retry-banner');
  const retryTitle = document.getElementById('worksheet-retry-title');
  const retrySubtitle = document.getElementById('worksheet-retry-subtitle');
  const retryBtn = document.getElementById('btn-retry-submit');
  const newSetBtn = document.getElementById('btn-expired-new-set');

  if (!retryBanner) return;
  retryBanner.style.display = 'block';

  const checkExpiry = () => {
    const nowPerf = performance.now();
    const msLeft = worksheetExpiresPerfMs - nowPerf;
    if (msLeft <= 0) {
      if (expiryCheckIntervalId) {
        clearInterval(expiryCheckIntervalId);
        expiryCheckIntervalId = null;
      }
      showExpiredBanner(
        'This worksheet set has expired while offline. Please start a new set.'
      );
      return;
    }
    const secLeft = Math.ceil(msLeft / 1000);
    if (retryTitle) {
      retryTitle.textContent =
        message || 'Could not send your answers due to a network problem.';
    }
    if (retrySubtitle) {
      retrySubtitle.textContent = `Your typed answers are still safe on screen. Try sending again within ${secLeft}s before the set expires.`;
    }
    if (retryBtn) {
      retryBtn.style.display = 'inline-flex';
      retryBtn.disabled = false;
      retryBtn.textContent = 'Try sending again';
    }
    if (newSetBtn) {
      newSetBtn.style.display = 'none';
    }
  };

  checkExpiry();
  if (expiryCheckIntervalId) clearInterval(expiryCheckIntervalId);
  expiryCheckIntervalId = setInterval(checkExpiry, 500);
}

function showExpiredBanner(message) {
  stopTimers();
  const retryBanner = document.getElementById('worksheet-retry-banner');
  const retryTitle = document.getElementById('worksheet-retry-title');
  const retrySubtitle = document.getElementById('worksheet-retry-subtitle');
  const retryBtn = document.getElementById('btn-retry-submit');
  const newSetBtn = document.getElementById('btn-expired-new-set');

  if (!retryBanner) return;
  retryBanner.style.display = 'block';
  if (retryTitle) retryTitle.textContent = message;
  if (retrySubtitle) {
    retrySubtitle.textContent = 'Click "Start a new set" to generate a fresh worksheet.';
  }
  if (retryBtn) retryBtn.style.display = 'none';
  if (newSetBtn) newSetBtn.style.display = 'inline-flex';
}

function renderResultScreen(result) {
  stopTimers();

  const introScreen = document.getElementById('drill-intro-screen');
  const worksheetScreen = document.getElementById('drill-worksheet-screen');
  const resultScreen = document.getElementById('drill-result-screen');

  if (introScreen) introScreen.style.display = 'none';
  if (worksheetScreen) worksheetScreen.style.display = 'none';
  if (resultScreen) resultScreen.style.display = 'block';

  const correct = Number(result.correct) || 0;
  const attempted = Number(result.attempted) || 0;
  const questionsTotal = Number(result.questions_total) || activeQuestions.length;
  const blankCount = Math.max(0, questionsTotal - attempted);
  const accuracy =
    result.accuracy !== undefined && result.accuracy !== null
      ? Number(result.accuracy)
      : attempted > 0
        ? Math.round((correct / attempted) * 1000) / 10
        : 0;
  const seconds = Number(result.seconds) || 0;

  // Mistake colour & text from shared js/scoreColors.js using wrong = attempted - correct
  const feedback = getScoreFeedback(correct, attempted);

  const headingEl = document.getElementById('result-heading');
  const subtitleEl = document.getElementById('result-subtitle');
  if (headingEl) headingEl.textContent = `${currentDrillMeta.title} — Results`;
  if (subtitleEl) {
    subtitleEl.textContent = `${questionsTotal} questions · Time limit ${formatDrillTimeLimit(currentDrillMeta.time_limit_seconds)}`;
  }

  const scoreTextEl = document.getElementById('result-score-text');
  const wrongBadgeEl = document.getElementById('result-wrong-badge');
  const blankTextEl = document.getElementById('result-blank-text');
  const blankSubEl = document.getElementById('result-blank-sub');
  const accTextEl = document.getElementById('result-accuracy-text');
  const timeTextEl = document.getElementById('result-time-text');
  const pbBannerEl = document.getElementById('result-personal-best-banner');
  const noticeBannerEl = document.getElementById('result-notice-banner');

  if (scoreTextEl) {
    scoreTextEl.textContent = `${correct} / ${attempted}`;
    scoreTextEl.style.color = feedback.colorVar;
  }

  if (wrongBadgeEl) {
    wrongBadgeEl.className = `score-tag ${feedback.badgeClass}`;
    const wrongNum = Math.max(0, attempted - correct);
    wrongBadgeEl.textContent = attempted > 0 ? feedback.wrongText : `${wrongNum} wrong`;
  }

  if (blankTextEl) blankTextEl.textContent = `${blankCount} left blank`;
  if (blankSubEl) blankSubEl.textContent = `out of ${questionsTotal} questions`;
  if (accTextEl) accTextEl.textContent = `${accuracy}%`;
  if (timeTextEl) timeTextEl.textContent = formatSecondsToMMSS(seconds);

  if (noticeBannerEl) {
    if (result.noticeMessage) {
      noticeBannerEl.textContent = result.noticeMessage;
      noticeBannerEl.style.display = 'block';
    } else {
      noticeBannerEl.style.display = 'none';
    }
  }

  // Personal best check
  const candidateRow = {
    correct,
    total: attempted,
    time_seconds: seconds,
  };
  const earnedPb =
    attempted > 0 && isNewPersonalBest(candidateRow, previousBestForDrill);

  if (pbBannerEl) {
    pbBannerEl.style.display = earnedPb ? 'block' : 'none';
  }
  if (earnedPb) {
    previousBestForDrill = {
      ...candidateRow,
      wrong: Math.max(0, attempted - correct),
    };
  }

  const tbody = document.getElementById('result-review-tbody');
  if (tbody) {
    const details = Array.isArray(result.detail) ? result.detail : [];
    tbody.innerHTML = details
      .map((item, idx) => {
        const isCorrect = Boolean(item.correct);
        const givenStr =
          item.given === null || item.given === undefined || item.given === ''
            ? '— (blank)'
            : String(item.given);
        const statusWord = isCorrect ? 'Correct' : 'Wrong';
        const statusClass = isCorrect ? 'score-tag-perfect' : 'score-tag-alert';

        return `
          <tr>
            <td class="num" style="color: var(--text-muted); font-weight: 600;">${idx + 1}</td>
            <td class="num" style="font-family: var(--font-mono); font-weight: 700; white-space: pre-wrap;">${escapeHtml(item.question)}</td>
            <td class="num" style="font-family: var(--font-mono); color: ${item.given ? 'var(--text-main)' : 'var(--text-dim)'};">
              ${escapeHtml(givenStr)}
            </td>
            <td class="num" style="font-family: var(--font-mono); font-weight: 700;">
              ${escapeHtml(item.expected_display)}
            </td>
            <td>
              <span class="score-tag ${statusClass}">${statusWord}</span>
            </td>
          </tr>
        `;
      })
      .join('');
  }
}

async function resetToIntroScreen() {
  stopTimers();
  activeSessionId = null;
  activeQuestions = [];
  hasSubmitted = false;
  isSubmitting = false;

  const introScreen = document.getElementById('drill-intro-screen');
  const worksheetScreen = document.getElementById('drill-worksheet-screen');
  const resultScreen = document.getElementById('drill-result-screen');

  if (worksheetScreen) worksheetScreen.style.display = 'none';
  if (resultScreen) resultScreen.style.display = 'none';
  if (introScreen) introScreen.style.display = 'block';

  await populateIntroScreen();
}

document.addEventListener('DOMContentLoaded', initElementDrillPage);
