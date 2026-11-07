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
import { keyAction } from './competitionKeys.js';
import { questionLayout, formatQuestionText } from './questionLayout.js';
import {
  parseTestRunnerQuery,
  RUNNER_EXIT_CONFIRM_TEXT,
} from './weeklyTestRunner.js';

const TIMER_INTERVAL_MS = 250;
const EXPIRY_GRACE_SECONDS = 30;
const TEST_EXPIRY_GRACE_SECONDS = 60;
const HIGHLIGHT_STORAGE_KEY = 'tt_element_highlight_active';


function renderPrepCountdownOverlay(startCount, onComplete) {
  let count = startCount;
  const overlay = document.createElement('div');
  overlay.id = 'prep-countdown-overlay';
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 99999;
    color: #fff;
    font-family: inherit;
    user-select: none;
  `;
  overlay.innerHTML = `
    <div style="font-size: 1.15rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; opacity: 0.9; margin-bottom: 8px;">
      Daily Task &middot; Get Ready
    </div>
    <div id="prep-num" style="font-size: 5.5rem; font-weight: 900; line-height: 1; color: #60A5FA;">
      ${count}
    </div>
    <div style="font-size: var(--text-xs); opacity: 0.75; margin-top: 16px;">
      Assigned Duration: ${activeTimeLimitSec || 60}s &middot; Starting automatically
    </div>
  `;
  document.body.appendChild(overlay);

  const numEl = document.getElementById('prep-num');
  const timer = setInterval(() => {
    count--;
    if (count > 0) {
      if (numEl) numEl.textContent = String(count);
    } else if (count === 0) {
      if (numEl) {
        numEl.textContent = 'GO!';
        numEl.style.color = '#34D399';
      }
    } else {
      clearInterval(timer);
      overlay.remove();
      onComplete();
    }
  }, 1000);
}

function updateTodoSubmitButtonState() {
  if (!isTodoMode) return;
  const answered = collectWorksheetAnswers().filter((a) => a !== null).length;
  const btn = document.getElementById('btn-bottom-submit');
  if (btn) {
    btn.disabled = answered < activeQuestions.length;
    btn.textContent =
      answered < activeQuestions.length
        ? `Submit (${answered} of ${activeQuestions.length} answered)`
        : `Submit Worksheet (${answered}/${activeQuestions.length})`;
  }
}

function loadHighlightPreference() {
  try {
    const raw = window.localStorage.getItem(HIGHLIGHT_STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {
    // Ignore storage access errors (private browsing / restricted storage)
  }
  return true;
}

function saveHighlightPreference(enabled) {
  try {
    window.localStorage.setItem(HIGHLIGHT_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage access errors
  }
}

function isTouchCapableDevice() {
  try {
    return (
      'ontouchstart' in window ||
      (navigator && Number(navigator.maxTouchPoints) > 0) ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(hover: none), (pointer: coarse)').matches)
    );
  } catch {
    return false;
  }
}

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


// Daily To-do runner mode (?todo_task_id=<id>)
let todoTaskId = null;
let isTodoMode = false;
let assignedTask = null;
let solvingStartPerfMs = 0;
let solvingEndPerfMs = 0;

// Weekly Test runner mode (?test=<id>&section=<id>)
let isTestMode = false;
let activeTestId = null;
let activeSectionId = null;
let activeTestTitle = 'Weekly Test';

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
let highlightActiveEnabled = true;
let activeQuestionIndex = 0;

async function initElementDrillPage() {
  const user = await requireAuth(['student', 'admin']);
  if (!user) return;
  currentUser = user;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  const runnerQuery = parseTestRunnerQuery(window.location.search);
  isTestMode = runnerQuery.isTestMode;
  activeTestId = runnerQuery.testId;
  activeSectionId = runnerQuery.sectionId;

  const params = new URLSearchParams(window.location.search);
  const todoParam = params.get('todo_task_id');
  if (todoParam) {
    todoTaskId = todoParam;
    isTodoMode = true;
    if (isDemoMode() && DemoDB?.getTodo) {
      assignedTask = DemoDB.getTodo(todoTaskId);
    } else if (isSupabaseConfigured()) {
      try {
        const supabase = await getSupabase();
        const { data: tRow } = await supabase
          .from('daily_tasks')
          .select('id, title, duration_seconds, required_count, section, category_id, activity_key')
          .eq('id', todoTaskId)
          .maybeSingle();
        if (tRow) assignedTask = tRow;
      } catch {
        // Fall back to server authoritative response
      }
    }
  }

  currentDrillKey = String(params.get('drill') || '').trim();
  currentDrillMeta = DRILL_CATALOG[currentDrillKey] ? { ...DRILL_CATALOG[currentDrillKey] } : null;
  if (currentDrillMeta && assignedTask && assignedTask.duration_seconds > 0) {
    currentDrillMeta.time_limit_seconds = assignedTask.duration_seconds;
  }

  const startBtn = document.getElementById('btn-start-drill');
  const submitNowBtn = document.getElementById('btn-submit-now');
  const exitTestBtn = document.getElementById('btn-exit-test-worksheet');
  const retrySubmitBtn = document.getElementById('btn-retry-submit');
  const expiredNewSetBtn = document.getElementById('btn-expired-new-set');
  const sameDrillAgainBtn = document.getElementById('btn-same-drill-again');
  const worksheetForm = document.getElementById('worksheet-form');
  const highlightToggleEl = document.getElementById('toggle-highlight-active-question');
  const touchNavEl = document.getElementById('worksheet-touch-nav');
  const touchPrevBtn = document.getElementById('btn-touch-prev-question');
  const touchNextBtn = document.getElementById('btn-touch-next-question');

  // Restore "Highlight the active question" preference (default on)
  highlightActiveEnabled = loadHighlightPreference();
  if (highlightToggleEl) {
    highlightToggleEl.checked = highlightActiveEnabled;
    highlightToggleEl.addEventListener('change', () => {
      highlightActiveEnabled = Boolean(highlightToggleEl.checked);
      saveHighlightPreference(highlightActiveEnabled);
      applyActiveQuestionHighlight();
    });
  }

  // Reveal touch navigation buttons on touch-capable devices
  if (touchNavEl && isTouchCapableDevice()) {
    touchNavEl.classList.add('is-touch-device');
  }

  // Prevent touch/mouse press on Previous/Next from blurring the active input before moving focus
  const keepFocusOnPointerDown = (e) => {
    e.preventDefault();
  };
  touchPrevBtn?.addEventListener('pointerdown', keepFocusOnPointerDown);
  touchNextBtn?.addEventListener('pointerdown', keepFocusOnPointerDown);
  touchPrevBtn?.addEventListener('click', () => {
    moveQuestionFocus(activeQuestionIndex - 1);
  });
  touchNextBtn?.addEventListener('click', () => {
    moveQuestionFocus(activeQuestionIndex + 1);
  });

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
    if (isTestMode) {
      window.location.href = '/pages/weekly-test.html';
      return;
    }
    resetToIntroScreen();
  });

  sameDrillAgainBtn?.addEventListener('click', () => {
    resetToIntroScreen();
  });

  exitTestBtn?.addEventListener('click', () => {
    if (!hasSubmitted && activeSessionId) {
      if (!window.confirm(RUNNER_EXIT_CONFIRM_TEXT)) return;
    }
    stopTimers();
    activeSessionId = null;
    window.location.href = '/pages/weekly-test.html';
  });

  if (isTestMode) {
    const headerEl = document.querySelector('.app-header');
    if (headerEl) headerEl.style.display = 'none';

    const backLink = document.getElementById('link-intro-back');
    if (backLink) {
      backLink.href = '/pages/weekly-test.html';
      backLink.textContent = '← Back to Weekly Test';
    }
    if (startBtn) startBtn.style.display = 'none';

    window.addEventListener('beforeunload', (e) => {
      if (isTestMode && activeSessionId && !hasSubmitted) {
        e.preventDefault();
        e.returnValue = RUNNER_EXIT_CONFIRM_TEXT;
        return e.returnValue;
      }
    });

    await handleStartTestSection();
    return;
  }

  if (!currentDrillMeta) {
    showIntroError('Activity no longer available. Please choose a drill from the Elements catalog.');
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

  if (isTodoMode && currentDrillMeta.enabled) {
    const bannerPlaceholder = document.getElementById('config-banner-placeholder');
    if (bannerPlaceholder) {
      bannerPlaceholder.innerHTML = `
        <div class="banner banner-info" style="margin-bottom: var(--space-4);">
          <strong>Daily Task:</strong> ${escapeHtml(assignedTask?.title || 'Daily Task')} &middot; Assigned Duration: <strong>${currentDrillMeta.time_limit_seconds}s (Locked)</strong>
        </div>
      `;
    }
    setTimeout(() => {
      handleStartDrill();
    }, 200);
  }
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
        throw new Error('Your sign-in has expired. Please sign in again.');
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
          todo_task_id: todoTaskId || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Could not start drill (HTTP ${res.status}).`);
      }
      payload = data;
    } else if (isDemoMode()) {
      payload = DemoDB.mockElementDrillStart(currentDrillKey, currentDrillMeta);
      if (assignedTask && assignedTask.duration_seconds > 0) {
        payload.time_limit_seconds = assignedTask.duration_seconds;
        payload.duration_seconds = assignedTask.duration_seconds;
        if (payload.settings) {
          payload.settings.time_limit_seconds = assignedTask.duration_seconds;
          payload.settings.duration_seconds = assignedTask.duration_seconds;
        }
      }
    } else {
      throw new Error('Connection is not configured.');
    }

    activeSessionId = payload.session_id;
    activeQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    const returnedLimit = Number(
      payload.duration_seconds ??
      payload.time_limit_seconds ??
      payload.settings?.duration_seconds ??
      payload.settings?.time_limit_seconds
    );
    activeTimeLimitSec = returnedLimit > 0 ? returnedLimit : currentDrillMeta.time_limit_seconds;
    if (currentDrillMeta) {
      currentDrillMeta.time_limit_seconds = activeTimeLimitSec;
    }

    if (isTodoMode) {
      const bannerPlaceholder = document.getElementById('config-banner-placeholder');
      if (bannerPlaceholder) {
        const taskTitle = assignedTask?.title || payload.settings?.todo_title || payload.title || 'Daily Task';
        bannerPlaceholder.innerHTML = `
          <div class="banner banner-info" style="margin-bottom: var(--space-4);">
            <strong>Daily Task:</strong> ${escapeHtml(taskTitle)} &middot; Assigned Duration: <strong>${activeTimeLimitSec}s (Locked)</strong>
          </div>
        `;
      }
    }

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

async function handleStartTestSection() {
  if (isStarting) return;
  isStarting = true;
  showIntroError('');

  const titleEl = document.getElementById('intro-drill-title');
  const groupEl = document.getElementById('intro-drill-group');
  if (groupEl) groupEl.textContent = 'Weekly Test · Elements Section';
  if (titleEl) titleEl.textContent = 'Starting section...';

  try {
    let payload = null;

    if (isSupabaseConfigured()) {
      const token = await getBearerToken();
      if (!token) {
        throw new Error('Your sign-in has expired. Please sign in again.');
      }

      const res = await fetch('/api/weekly-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'start',
          test_id: activeTestId,
          section_id: activeSectionId,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Could not start test section (HTTP ${res.status}).`);
      }
      payload = data;
    } else if (isDemoMode()) {
      payload = DemoDB.mockStartWeeklyTestSection(
        currentUser.id,
        activeTestId,
        null,
        activeSectionId
      );
    } else {
      throw new Error('Connection is not configured.');
    }

    currentDrillKey = String(payload.drill || currentDrillKey || '').trim();
    currentDrillMeta = DRILL_CATALOG[currentDrillKey] || {
      key: currentDrillKey,
      title: payload.drill_title || payload.title || 'Elements Section',
      questions: Array.isArray(payload.questions) ? payload.questions.length : 0,
      time_limit_seconds: Number(payload.time_limit_seconds) || 60,
      hint: payload.hint || '',
      inputmode: 'numeric',
      enabled: true,
    };
    activeTestTitle = payload.title || 'Weekly Test';
    activeSessionId = payload.session_id;
    activeQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    activeTimeLimitSec = Number(payload.time_limit_seconds) || currentDrillMeta.time_limit_seconds;
    hasSubmitted = false;
    isSubmitting = false;

    document.title = `${activeTestTitle} — ${currentDrillMeta.title} - Trendz Tracker`;

    renderWorksheet({
      ...payload,
      title: payload.drill_title || currentDrillMeta.title,
    });
  } catch (err) {
    if (titleEl) titleEl.textContent = 'Cannot start section';
    showIntroError(err.message || 'Could not start this weekly test section.');
  } finally {
    isStarting = false;
  }
}

/**
 * Moves focus to the target question index without wrap-around (stops at 0 and inputs.length - 1).
 */
function moveQuestionFocus(targetIndex) {
  const inputs = getWorksheetInputs();
  if (inputs.length === 0) return;
  const clampedIndex = Math.max(0, Math.min(inputs.length - 1, targetIndex));
  const targetInput = inputs[clampedIndex];
  if (!targetInput || targetInput.disabled) return;
  activeQuestionIndex = clampedIndex;
  targetInput.focus();
  targetInput.select?.();
}

/**
 * Updates the `.active-question-highlight` class on question rows and touch button disabled states.
 */
function applyActiveQuestionHighlight(scrollRowIntoView = false) {
  const gridEl = document.getElementById('worksheet-questions-grid');
  if (!gridEl) return;

  const rows = Array.from(gridEl.querySelectorAll('.element-question-row'));
  const activeEl = document.activeElement;

  rows.forEach((row, idx) => {
    const input = row.querySelector('.element-answer-input');
    const isFocusedRow = Boolean(input && activeEl === input);
    if (highlightActiveEnabled && isFocusedRow) {
      row.classList.add('active-question-highlight');
      if (scrollRowIntoView && typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } else {
      row.classList.remove('active-question-highlight');
    }
    if (isFocusedRow) {
      activeQuestionIndex = idx;
    }
  });

  const touchPrevBtn = document.getElementById('btn-touch-prev-question');
  const touchNextBtn = document.getElementById('btn-touch-next-question');
  if (touchPrevBtn) {
    touchPrevBtn.disabled = activeQuestionIndex <= 0;
  }
  if (touchNextBtn) {
    touchNextBtn.disabled = rows.length === 0 || activeQuestionIndex >= rows.length - 1;
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
    if (isTodoMode) {
      submitNowBtn.style.display = 'none';
    } else {
      submitNowBtn.style.display = '';
      submitNowBtn.disabled = false;
      submitNowBtn.textContent = 'Submit now';
    }
  }

  let bottomSubmitContainer = document.getElementById('todo-bottom-submit-container');
  if (isTodoMode) {
    if (!bottomSubmitContainer) {
      bottomSubmitContainer = document.createElement('div');
      bottomSubmitContainer.id = 'todo-bottom-submit-container';
      bottomSubmitContainer.style.cssText = 'margin-top: var(--space-6); text-align: center;';
      bottomSubmitContainer.innerHTML = `
        <button type="button" id="btn-bottom-submit" class="btn btn-primary" disabled style="min-width: 220px; font-size: var(--text-base); padding: 12px 24px;">
          Submit (0 of ${activeQuestions.length} answered)
        </button>
        <p id="todo-submit-hint" style="font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 6px;">
          Answer all questions to submit early, or wait for timer to auto-submit.
        </p>
      `;
      const formEl = document.getElementById('worksheet-form');
      if (formEl) formEl.appendChild(bottomSubmitContainer);
      document.getElementById('btn-bottom-submit')?.addEventListener('click', () => {
        submitWorksheet(false);
      });
    } else {
      bottomSubmitContainer.style.display = 'block';
    }
  } else if (bottomSubmitContainer) {
    bottomSubmitContainer.style.display = 'none';
  }

  const titleEl = document.getElementById('worksheet-drill-title');
  const hintEl = document.getElementById('worksheet-drill-hint');
  const testBadgeEl = document.getElementById('worksheet-test-badge');
  const exitTestBtn = document.getElementById('btn-exit-test-worksheet');
  if (testBadgeEl) {
    testBadgeEl.style.display = isTestMode ? 'inline-flex' : 'none';
    testBadgeEl.textContent = activeTestTitle;
  }
  if (exitTestBtn) {
    exitTestBtn.style.display = isTestMode ? 'inline-flex' : 'none';
  }
  if (titleEl) titleEl.textContent = `${payload.title || currentDrillMeta.title} (${activeQuestions.length} questions)`;
  if (hintEl) hintEl.textContent = payload.hint || currentDrillMeta.hint;

  const gridEl = document.getElementById('worksheet-questions-grid');
  const inputMode = currentDrillMeta.inputmode === 'text' ? 'text' : 'numeric';

  if (gridEl) {
    gridEl.innerHTML = activeQuestions
      .map((qText, idx) => {
        const qNum = idx + 1;
        const layout = questionLayout(qText);
        const displayText = formatQuestionText(qText);
        return `
          <div class="element-question-row" data-row-index="${idx}">
            <span class="element-question-num num">${qNum}.</span>
            <label for="element-ans-${qNum}" class="element-question-prompt"><span class="element-question-text element-question-text--${layout}" data-layout="${layout}">${escapeHtml(displayText)}</span></label>
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

  activeQuestionIndex = 0;
  const inputs = getWorksheetInputs();
  inputs.forEach((input, idx) => {
    input.addEventListener('focus', () => {
      activeQuestionIndex = idx;
      applyActiveQuestionHighlight(true);
    });

    input.addEventListener('blur', () => {
      applyActiveQuestionHighlight(false);
    });

    input.addEventListener('input', () => {
      updateTodoSubmitButtonState();
    });

    input.addEventListener('keydown', (e) => {
      // Never intercept any key when Ctrl, Alt, or Meta is pressed
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }

      // Phase 8c: Numpad / keyboard '+' (next) and '-' (previous).
      // Do NOT handle 'step' ('*') on this page because Prime Factors accepts '*' as multiplication.
      const shortcut = keyAction(e);
      if (shortcut === 'next') {
        e.preventDefault();
        if (idx + 1 < inputs.length) {
          inputs[idx + 1].focus();
          inputs[idx + 1].select?.();
        }
        return;
      }
      if (shortcut === 'previous') {
        e.preventDefault();
        if (idx - 1 >= 0) {
          inputs[idx - 1].focus();
          inputs[idx - 1].select?.();
        }
        return;
      }

      if (e.key === 'Enter' || e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        if (idx + 1 < inputs.length) {
          e.preventDefault();
          inputs[idx + 1].focus();
          inputs[idx + 1].select?.();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (isTodoMode) {
            const answered = collectWorksheetAnswers().filter((a) => a !== null).length;
            if (answered === activeQuestions.length) {
              submitWorksheet(false);
            }
          } else {
            submitWorksheet(false);
          }
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

  const startWorksheetSession = () => {
    setWorksheetInputsDisabled(false);
    worksheetStartPerfMs = performance.now();
    worksheetEndPerfMs = worksheetStartPerfMs + activeTimeLimitSec * 1000;
    const graceSec = isTestMode ? TEST_EXPIRY_GRACE_SECONDS : EXPIRY_GRACE_SECONDS;
    worksheetExpiresPerfMs =
      worksheetStartPerfMs + (activeTimeLimitSec + graceSec) * 1000;

    updateTimerDisplay();
    timerIntervalId = setInterval(updateTimerDisplay, TIMER_INTERVAL_MS);
    updateTodoSubmitButtonState();

    if (inputs.length > 0) {
      inputs[0].focus();
    }
  };

  if (isTodoMode) {
    setWorksheetInputsDisabled(true);
    const prepSec = Number(payload.prep_seconds ?? payload.settings?.prep_seconds ?? 3);
    renderPrepCountdownOverlay(prepSec, () => {
      startWorksheetSession();
    });
  } else {
    startWorksheetSession();
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

  const candidateEndMs = performance.now();
  const answers = collectWorksheetAnswers();
  const attemptedCount = answers.filter((a) => a !== null).length;

  if (!isAutoOrRetry && isTodoMode) {
    if (attemptedCount < activeQuestions.length) {
      return;
    }
  }

  isSubmitting = true;
  stopTimers();
  setWorksheetInputsDisabled(true);

  const submitNowBtn = document.getElementById('btn-submit-now');
  const retryBanner = document.getElementById('worksheet-retry-banner');
  const retryBtn = document.getElementById('btn-retry-submit');
  const bottomSubmitBtn = document.getElementById('btn-bottom-submit');

  if (submitNowBtn) {
    submitNowBtn.disabled = true;
    submitNowBtn.textContent = 'Submitting...';
  }
  if (bottomSubmitBtn) {
    bottomSubmitBtn.disabled = true;
    bottomSubmitBtn.textContent = 'Submitting...';
  }
  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Sending...';
  }

  const elapsedSeconds = isAutoOrRetry && (worksheetEndPerfMs - candidateEndMs <= 0)
    ? activeTimeLimitSec
    : Math.max(
        1,
        Math.min(
          activeTimeLimitSec,
          Math.round((candidateEndMs - worksheetStartPerfMs) / 1000)
        )
      );

  try {
    let resultData = null;

    if (isSupabaseConfigured()) {
      const token = await getBearerToken();
      if (!token) {
        throw new Error('Your sign-in has expired. Please sign in again.');
      }

      const endpoint = isTestMode ? '/api/weekly-test' : '/api/drill';
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'submit',
            session_id: activeSessionId,
            answers,
            duration_seconds: elapsedSeconds,
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
            msg || 'Could not save your drill right now. Please try sending again.'
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
      resultData = isTestMode
        ? DemoDB.mockSubmitWeeklyTestSection(currentUser.id, activeSessionId, answers)
        : DemoDB.mockElementDrillSubmit(
            activeSessionId,
            answers,
            currentUser.id,
            currentDrillMeta,
            elapsedSeconds
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
      showExpiredBanner(
        isTestMode
          ? 'Time is up — this weekly test section has expired.'
          : 'Time is up — this worksheet has expired. Please start a new set.'
      );
      return;
    }

    // Other validation errors (e.g., finished faster than possible, or already submitted)
    showExpiredBanner(
      err.message ||
        (isTestMode
          ? 'Could not submit this weekly test section.'
          : 'Could not submit this set. Please start a new set.')
    );
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
  if (newSetBtn) {
    newSetBtn.style.display = 'inline-flex';
    newSetBtn.textContent = isTestMode ? 'Back to Weekly Test' : 'Start a new set';
  }
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
  const testSavedBannerEl = document.getElementById('result-test-saved-banner');
  const noticeBannerEl = document.getElementById('result-notice-banner');
  const sameDrillAgainBtn = document.getElementById('btn-same-drill-again');
  const allDrillsLink = document.getElementById('btn-result-all-drills');

  if (isTestMode) {
    if (sameDrillAgainBtn) sameDrillAgainBtn.style.display = 'none';
    if (allDrillsLink) {
      allDrillsLink.href = '/pages/weekly-test.html';
      allDrillsLink.className = 'btn btn-primary btn-sm';
      allDrillsLink.textContent = 'Back to Weekly Test';
    }
    if (testSavedBannerEl) {
      if (attempted > 0) {
        testSavedBannerEl.textContent = `✓ Saved as part of ${result.title || activeTestTitle}`;
        testSavedBannerEl.style.display = 'block';
      } else {
        testSavedBannerEl.style.display = 'none';
      }
    }
  } else {
    if (testSavedBannerEl) testSavedBannerEl.style.display = 'none';
  }

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

  // Personal best check (practice mode only)
  const candidateRow = {
    correct,
    total: attempted,
    time_seconds: seconds,
  };
  const earnedPb =
    !isTestMode && attempted > 0 && isNewPersonalBest(candidateRow, previousBestForDrill);

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

        const qLayout = questionLayout(item.question);
        const qDisplay = formatQuestionText(item.question);

        return `
          <tr>
            <td class="num" style="color: var(--text-muted); font-weight: 600;">${idx + 1}</td>
            <td class="num"><span class="element-question-text element-question-text--${qLayout}">${escapeHtml(qDisplay)}</span></td>
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
