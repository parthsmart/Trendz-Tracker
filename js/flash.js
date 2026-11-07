/**
 * Trendz Tracker — Flash Anzan Trainer Controller (js/flash.js)
 *
 * Phase 7b — Simplified to ONE QUESTION PER TRY:
 * - Never calculate sums, correctness, streaks, or points in JavaScript.
 * - `flash_start(p_settings)` returns `{ session_id, numbers: [signed integers], settings }`
 *   with `digits` (1..5), `count` (2..1000), `speed_ms` (200..5000), `mode` ('add' | 'add_sub').
 * - `flash_submit(p_session, p_answer)` sends a single integer or `null` ("I don't know")
 *   and returns `{ correct: boolean, expected, given, seconds }`.
 * - Uses `performance.now()` with an absolute schedule built by `buildTimeline(settings, count)`
 *   and drift correction (never chaining plain timeouts).
 * - Cancels the try immediately if the browser tab becomes hidden while numbers are showing.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import {
  DEFAULT_FLASH_SETTINGS,
  FLASH_LIMITS,
  clampFlashSettings,
  formatFlashSettingsSummary,
  formatFlashCompactSummary,
  formatSpeedDisplay,
  friendlyFlashError,
  getExpectedDurationInfo,
  getStatsForSettings,
  parseFlashAnswerInput,
  recentTries,
  secondsToSpeedMs,
  speedMsToSeconds,
  statsByKey,
  validateFlashSettings,
} from './flashStats.js';
import { buildTimeline } from './flashTimeline.js';
import {
  applyTaskToSettings,
  matchesTask,
  parseFlashTaskQuery,
} from './flashTaskMatch.js';
import { requireAuth } from './guard.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToTime } from './stats.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';
import { flashSummary } from './todoForm.js';
import {
  parseTestRunnerQuery,
  flashProgressText,
  RUNNER_EXIT_CONFIRM_TEXT,
} from './weeklyTestRunner.js';
import {
  filterAndSortHistory,
  paginateHistory,
  renderHistoryFilterToolbarHtml,
  renderHistoryPaginationHtml,
  toISTDateString,
  fetchAllRowsBatched,
  resolveEntrySource,
  renderSourceChipHtml,
  renderCompactHistoryRowHtml,
  practiceRecordStatus,
  formatFriendlyDateIST,
  formatAccuracyDisplay,
  resolveHistoryTargetStudent,
  renderTargetStudentBanner,
} from './historyFilters.js';

let flashHistoryFilters = {
  dateFrom: '',
  dateTo: '',
  category: 'all',
  source: 'all',
  sort: 'newest',
};
let flashHistoryPage = 1;
const FLASH_PAGE_SIZE = 20;

const FLASH_DIGIT_CATEGORIES = [
  { id: '1', name: '1 Digit' },
  { id: '2', name: '2 Digits' },
  { id: '3', name: '3 Digits' },
  { id: '4', name: '4 Digits' },
  { id: '5', name: '5 Digits' },
];

const STORAGE_KEY_SETTINGS = 'trendz_flash_settings_v2';
const STORAGE_KEY_SOUND = 'trendz_flash_sound_v1';

let currentProfile = null;
let activeHistoryStudent = null;
let currentSettings = { ...DEFAULT_FLASH_SETTINGS };
let activeTaskSpec = null; // Phase 14a: non-null when ?task=1 is present in URL
let activeTodoTaskId = null; // Phase 19: non-null when assigned daily task is active
let soundEnabled = false;
let audioCtx = null;
let cachedHistoryRows = [];

// Weekly test runner state (?test=<id>&section=<id>)
let isTestMode = false;
let activeTestId = null;
let activeSectionId = null;
let activeTestTitle = 'Weekly Test';
let activeTryNo = 1;
let activeQuestionCount = 5;

// Active try state
let activeTry = null; // { session_id, numbers, settings, phase: 'countdown'|'flashing'|'answering', cancelled, pendingAnswer }
let activeTimers = [];
let isStarting = false;
let isSubmitting = false;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Web Audio API Beep Generator (no external audio files or dependencies)
 */
function ensureAudioContext() {
  if (!soundEnabled) return null;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  } catch {
    return null;
  }
}

function playFlashBeep(isNegative = false) {
  if (!soundEnabled) return;
  const ctx = ensureAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(isNegative ? 660 : 880, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.06);
  } catch {
    // Ignore audio context errors if blocked by browser autoplay policy
  }
}

/**
 * Timer management for clean cancellation
 */
function clearActiveTimers() {
  while (activeTimers.length > 0) {
    const id = activeTimers.pop();
    clearTimeout(id);
  }
}

function waitMs(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      const idx = activeTimers.indexOf(id);
      if (idx !== -1) activeTimers.splice(idx, 1);
      resolve();
    }, Math.max(0, ms));
    activeTimers.push(id);
  });
}

/**
 * Load saved settings & sound preference from localStorage (wrapped in try/catch)
 */
function loadSavedPreferences() {
  try {
    const rawSettings =
      localStorage.getItem(STORAGE_KEY_SETTINGS) ||
      localStorage.getItem('trendz_flash_settings_v1');
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      currentSettings = clampFlashSettings(parsed);
    }
    const rawSound = localStorage.getItem(STORAGE_KEY_SOUND);
    if (rawSound !== null) {
      soundEnabled = rawSound === 'true';
    }
  } catch {
    currentSettings = { ...DEFAULT_FLASH_SETTINGS };
    soundEnabled = false;
  }
}

function savePreferences() {
  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(currentSettings));
    localStorage.setItem(STORAGE_KEY_SOUND, String(soundEnabled));
  } catch {
    // Ignore storage quota / privacy errors
  }
}

/**
 * Error banner display helper
 */
function showErrorBanner(message) {
  const banner = document.getElementById('flash-error-banner');
  if (!banner) return;
  if (!message) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  banner.innerHTML = `
    <span class="banner-icon" aria-hidden="true">⚠️</span>
    <div class="banner-body">${escapeHtml(message)}</div>
  `;
  banner.style.display = 'flex';
}

/**
 * Syncs Setup Screen controls, summary line, duration estimate, and per-settings stats table
 */
function syncSetupControlsUI() {
  currentSettings = clampFlashSettings(currentSettings);
  const { digits, count, speed_ms, mode } = currentSettings;

  // 1. Digits buttons & hidden input
  const digitsInput = document.getElementById('flash-digits');
  if (digitsInput) digitsInput.value = String(digits);
  const digitsLabel = document.getElementById('display-digits-val');
  if (digitsLabel) {
    digitsLabel.textContent = `${digits} ${digits === 1 ? 'digit' : 'digits'}`;
  }

  document.querySelectorAll('[data-digits]').forEach((btn) => {
    const btnDigits = Number(btn.getAttribute('data-digits'));
    const isActive = btnDigits === digits;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // 2. Mode buttons & hidden input
  const modeInput = document.getElementById('flash-mode');
  if (modeInput) modeInput.value = mode;
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    const btnMode = btn.getAttribute('data-mode');
    const isActive = btnMode === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // 3. Numbers in the question (2 to 1000)
  const countInput = document.getElementById('flash-count');
  const countDisplay = document.getElementById('display-count-val');
  if (countInput && document.activeElement !== countInput) {
    countInput.value = String(count);
  }
  if (countDisplay) countDisplay.textContent = `${count} numbers`;

  const btnCountDec = document.getElementById('btn-count-dec');
  const btnCountInc = document.getElementById('btn-count-inc');
  if (btnCountDec) btnCountDec.disabled = count <= FLASH_LIMITS.COUNT_MIN;
  if (btnCountInc) btnCountInc.disabled = count >= FLASH_LIMITS.COUNT_MAX;

  // 4. Speed per number (0.2 to 5.0 seconds)
  const speedSec = speedMsToSeconds(speed_ms);
  const speedInput = document.getElementById('flash-speed-seconds');
  const speedRange = document.getElementById('flash-speed-range');
  const speedDisplay = formatSpeedDisplay(speed_ms);

  if (speedInput && document.activeElement !== speedInput) {
    speedInput.value = speedSec.toFixed(1);
  }
  if (speedRange) speedRange.value = String(speed_ms);

  const speedCombinedEl = document.getElementById('display-speed-combined');
  const speedSecEl = document.getElementById('display-speed-seconds');
  const speedRateEl = document.getElementById('display-speed-rate');
  if (speedCombinedEl) speedCombinedEl.textContent = speedDisplay.secondsText;
  if (speedSecEl) speedSecEl.textContent = speedDisplay.secondsText;
  if (speedRateEl) speedRateEl.textContent = speedDisplay.perSecondText;

  const btnSpeedDec = document.getElementById('btn-speed-dec');
  const btnSpeedInc = document.getElementById('btn-speed-inc');
  if (btnSpeedDec) btnSpeedDec.disabled = speed_ms <= FLASH_LIMITS.SPEED_MS_MIN;
  if (btnSpeedInc) btnSpeedInc.disabled = speed_ms >= FLASH_LIMITS.SPEED_MS_MAX;

  // 5. Sound toggle
  const soundToggle = document.getElementById('flash-sound-toggle');
  if (soundToggle) soundToggle.checked = soundEnabled;

  // 6. One-line summary & expected duration
  const summaryText = formatFlashCompactSummary(currentSettings);
  const lastUsedEl = document.getElementById('flash-last-used-text');
  if (lastUsedEl) {
    lastUsedEl.textContent = summaryText;
  }
  const summaryLine = document.getElementById('flash-setup-summary-line');
  if (summaryLine) {
    summaryLine.textContent = summaryText;
  }

  const durationInfo = getExpectedDurationInfo(currentSettings);
  const durationBadge = document.getElementById('setup-duration-badge');
  const durationLine = document.getElementById('flash-setup-duration-line');
  if (durationBadge) {
    durationBadge.textContent = `Expected duration: ${durationInfo.displayText}`;
  }
  if (durationLine) {
    durationLine.textContent = `Expected duration: ${durationInfo.displayText}${
      durationInfo.requiresConfirmation ? ' (confirmation required over 5 minutes)' : ''
    }`;
  }

  // Hide long-duration confirmation prompt when settings change
  const longConfirmBox = document.getElementById('flash-long-confirm-box');
  if (longConfirmBox) longConfirmBox.style.display = 'none';

  // 7. Phase 14a: Live task banner comparison when ?task=1 is present
  updateTaskBannerUI();

  // 8. Refresh "Your results at these settings" table
  renderSetupStatsTables();
}

/**
 * Phase 14a: Updates the task requirements banner above the setup controls when `task=1` is present.
 */
function updateTaskBannerUI() {
  const banner = document.getElementById('flash-task-banner');
  const reqEl = document.getElementById('flash-task-banner-req');
  const statusEl = document.getElementById('flash-task-banner-status');
  const restoreBtn = document.getElementById('btn-restore-task-settings');

  if (!banner) return;

  if (!activeTaskSpec) {
    banner.style.display = 'none';
    return;
  }

  const setupEl = document.getElementById('flash-setup-screen');
  const isSetupVisible = !setupEl || setupEl.style.display !== 'none';
  banner.style.display = isSetupVisible ? 'block' : 'none';

  const summary = flashSummary(activeTaskSpec);
  if (reqEl) {
    reqEl.textContent = `Today's task needs: ${summary}. A try counts for the task only with these settings. Note: Flash Anzan stream duration is physically determined by items × speed (t = count × speed).`;
  }

  const isMatch = matchesTask(currentSettings, activeTaskSpec);
  if (statusEl) {
    if (isMatch) {
      statusEl.textContent = "✓ This try counts for today's task";
      statusEl.style.color = 'var(--color-score-perfect)';
    } else {
      statusEl.textContent = "⚠ These settings will not count for today's task";
      statusEl.style.color = 'var(--color-score-close)';
    }
  }

  if (restoreBtn) {
    restoreBtn.style.display = isMatch ? 'none' : 'inline-flex';
  }
}

/**
 * Renders "Your results at these settings" and "Most-practised settings" on the Setup screen
 */
function renderSetupStatsTables() {
  const currentTbody = document.getElementById('current-settings-stats-tbody');
  const mostTbody = document.getElementById('most-practised-stats-tbody');

  if (currentTbody) {
    const stat = getStatsForSettings(cachedHistoryRows, currentSettings);
    if (stat.tries === 0) {
      currentTbody.innerHTML = `
        <tr>
          <td class="num">${escapeHtml(stat.summary)}</td>
          <td class="num" style="text-align: right;">0</td>
          <td class="num" style="text-align: right;">0</td>
          <td style="text-align: right; color: var(--text-muted);">No tries yet</td>
        </tr>
      `;
    } else {
      const fb = getScoreFeedback(stat.correct, stat.tries);
      currentTbody.innerHTML = `
        <tr>
          <td class="num" style="font-weight: 600;">${escapeHtml(stat.summary)}</td>
          <td class="num" style="text-align: right; font-weight: 700;">${stat.tries}</td>
          <td class="num" style="text-align: right; font-weight: 700;">${stat.correct}</td>
          <td class="num" style="text-align: right; font-weight: 800; color: ${fb.colorVar};">${stat.successRate}%</td>
        </tr>
      `;
    }
  }

  if (mostTbody) {
    const allGroups = statsByKey(cachedHistoryRows).slice(0, 5);
    if (allGroups.length === 0) {
      mostTbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: var(--space-3);">
            No Flash Anzan tries recorded yet.
          </td>
        </tr>
      `;
    } else {
      mostTbody.innerHTML = allGroups
        .map((g) => {
          const fb = getScoreFeedback(g.correct, g.tries);
          return `
            <tr>
              <td class="num" style="font-weight: 600;">${escapeHtml(g.summary)}</td>
              <td class="num" style="text-align: right;">${g.tries}</td>
              <td class="num" style="text-align: right;">${g.correct}</td>
              <td class="num" style="text-align: right; font-weight: 800; color: ${fb.colorVar};">${g.successRate}%</td>
            </tr>
          `;
        })
        .join('');
    }
  }
}

/**
 * Switches visible screen between 'setup', 'play', and 'results'.
 * During an active round ('play'), hides the history dashboard and page header
 * so the flashing number stage fills the screen without distraction.
 */
function showScreen(screenName) {
  const setupEl = document.getElementById('flash-setup-screen');
  const playEl = document.getElementById('flash-play-screen');
  const resultsEl = document.getElementById('flash-results-screen');
  const historyEl = document.getElementById('flash-history-section');
  const pageHeaderEl = document.getElementById('flash-page-header');
  const bannerEl = document.getElementById('config-banner-placeholder');
  const taskBannerEl = document.getElementById('flash-task-banner');
  const appHeaderEl = document.querySelector('.app-header');

  const isPlaying = screenName === 'play';

  if (setupEl) setupEl.style.display = !isTestMode && screenName === 'setup' ? 'block' : 'none';
  if (playEl) playEl.style.display = isPlaying ? 'block' : 'none';
  if (resultsEl) resultsEl.style.display = screenName === 'results' ? 'block' : 'none';
  if (taskBannerEl) {
    taskBannerEl.style.display =
      !isTestMode && screenName === 'setup' && activeTaskSpec ? 'block' : 'none';
  }

  // Hide dashboard/history below, page heading, and top navigation bar during an active Flash Anzan round or in test mode
  if (historyEl) historyEl.style.display = isPlaying || isTestMode ? 'none' : 'block';
  if (pageHeaderEl) pageHeaderEl.style.display = isPlaying || isTestMode ? 'none' : '';
  if (bannerEl) bannerEl.style.display = isPlaying ? 'none' : '';
  if (appHeaderEl) appHeaderEl.style.display = isPlaying || isTestMode ? 'none' : '';

  if (isPlaying) {
    try {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      window.scrollTo(0, 0);
    }
  }
}

/**
 * Calls `flash_start(p_settings)` on Supabase (or DemoDB in demo mode)
 */
async function callFlashStartRpc(settings) {
  const payload = {
    digits: settings.digits,
    count: settings.count,
    speed_ms: settings.speed_ms,
    mode: settings.mode,
  };
  if (activeTodoTaskId) {
    payload.todo_task_id = activeTodoTaskId;
  }

  if (isDemoMode() && !isSupabaseConfigured()) {
    return DemoDB.mockFlashStart(payload, currentProfile?.id);
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database connection is not available.');
  }

  const { data, error } = await supabase.rpc('flash_start', {
    p_settings: payload,
  });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Calls `flash_submit(p_session, p_answer)` on Supabase (or DemoDB in demo mode)
 */
async function callFlashSubmitRpc(sessionId, answerValue) {
  if (isDemoMode() && !isSupabaseConfigured()) {
    return DemoDB.mockFlashSubmit(sessionId, answerValue, currentProfile?.id);
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database connection is not available.');
  }

  const { data, error } = await supabase.rpc('flash_submit', {
    p_session: sessionId,
    p_answer: answerValue,
  });

  if (error) {
    throw error;
  }
  return data;
}

/**
 * Handles `visibilitychange`: if the tab becomes hidden while countdown or numbers
 * are showing, CANCEL the try immediately (save nothing) and explain why.
 */
function handleVisibilityChange() {
  if (!document.hidden) return;
  if (!activeTry || activeTry.cancelled) return;

  if (activeTry.phase === 'countdown' || activeTry.phase === 'flashing') {
    activeTry.cancelled = true;
    clearActiveTimers();
    activeTry = null;
    if (isTestMode) {
      window.location.href = '/pages/weekly-test.html';
      return;
    }
    showScreen('setup');
    showErrorBanner(
      'You left the page, so this try was cancelled. Start again when you are ready.'
    );
  }
}

/**
 * Runs the 3-2-1 countdown and then flashes the numbers using `buildTimeline`
 * and `performance.now()` drift correction.
 */
async function runTrySequence() {
  if (!activeTry || activeTry.cancelled) return;

  const numbers = Array.isArray(activeTry.numbers) ? activeTry.numbers : [];
  const totalNumbers = numbers.length;
  const speedMs = Number(activeTry.settings.speed_ms) || 1000;

  const progressFill = document.getElementById('play-progress-fill');
  const summaryEl = document.getElementById('play-settings-summary');
  const stageBox = document.getElementById('flash-stage-box');
  const captionEl = document.getElementById('flash-stage-caption');
  const numberEl = document.getElementById('flash-number-display');
  const answerPanel = document.getElementById('flash-answer-panel');
  const stopConfirmBar = document.getElementById('flash-stop-confirm-bar');
  const stopBtn = document.getElementById('btn-flash-stop');
  const stopConfirmText = document.getElementById('flash-stop-confirm-text');
  const stopConfirmBtn = document.getElementById('btn-stop-confirm');

  if (summaryEl) {
    const baseSummary = formatFlashSettingsSummary(activeTry.settings);
    summaryEl.textContent = isTestMode
      ? `${activeTestTitle} · ${flashProgressText(activeTryNo, activeQuestionCount)} · ${baseSummary}`
      : baseSummary;
  }
  if (stopBtn) {
    stopBtn.textContent = isTestMode ? 'Exit' : 'Stop';
  }
  if (stopConfirmText) {
    stopConfirmText.textContent = isTestMode
      ? RUNNER_EXIT_CONFIRM_TEXT
      : 'Abandon this try? Nothing will be saved.';
  }
  if (stopConfirmBtn) {
    stopConfirmBtn.textContent = isTestMode ? 'Leave section' : 'Yes, abandon try';
  }
  if (progressFill) progressFill.style.width = '0%';
  if (stopConfirmBar) stopConfirmBar.style.display = 'none';
  if (answerPanel) answerPanel.style.display = 'none';
  if (stageBox) stageBox.style.display = 'flex';

  // 1. Countdown: 3, 2, 1
  activeTry.phase = 'countdown';
  for (const step of ['3', '2', '1']) {
    if (!activeTry || activeTry.cancelled) return;
    if (captionEl) captionEl.textContent = 'Get Ready';
    if (numberEl) {
      numberEl.className = 'flash-number-display flash-countdown num';
      numberEl.textContent = step;
    }
    await waitMs(650);
    if (!activeTry || activeTry.cancelled) return;
  }

  // Brief blank before first number
  if (captionEl) captionEl.textContent = '';
  if (numberEl) {
    numberEl.className = 'flash-number-display num';
    numberEl.textContent = '';
  }
  await waitMs(150);
  if (!activeTry || activeTry.cancelled) return;

  // 2. Flashing numbers using absolute schedule from `buildTimeline`
  activeTry.phase = 'flashing';
  const timeline = buildTimeline({ speed_ms: speedMs }, totalNumbers);
  const anchorMs = performance.now();

  for (const event of timeline) {
    if (!activeTry || activeTry.cancelled) return;

    const targetTimeMs = anchorMs + event.offsetMs;
    const waitDuration = targetTimeMs - performance.now();
    if (waitDuration > 0) {
      await waitMs(waitDuration);
      if (!activeTry || activeTry.cancelled) return;
    }

    if (event.type === 'number') {
      const val = Number(numbers[event.index]);
      const isNeg = val < 0;
      const displayStr = isNeg ? `-${Math.abs(val)}` : `${Math.abs(val)}`;

      if (numberEl) {
        numberEl.className = `flash-number-display num ${isNeg ? 'is-negative' : ''}`;
        numberEl.textContent = displayStr;
      }
      if (progressFill && totalNumbers > 0) {
        const pct = Math.min(100, Math.round(((event.index + 1) / totalNumbers) * 100));
        progressFill.style.width = `${pct}%`;
      }
      playFlashBeep(isNeg);
    } else if (event.type === 'blank') {
      if (numberEl) {
        numberEl.textContent = '';
      }
    } else if (event.type === 'done') {
      if (numberEl) {
        numberEl.textContent = '';
      }
      if (progressFill) {
        progressFill.style.width = '100%';
      }
    }
  }

  if (!activeTry || activeTry.cancelled) return;

  // 3. Transition to Answer Input Panel
  activeTry.phase = 'answering';
  if (stageBox) stageBox.style.display = 'none';
  if (answerPanel) answerPanel.style.display = 'flex';

  const answerInput = document.getElementById('flash-answer-input');
  const answerErr = document.getElementById('flash-answer-error');
  const retryBox = document.getElementById('flash-submit-retry-box');
  const submitBtn = document.getElementById('btn-answer-submit');
  const idkBtn = document.getElementById('btn-answer-idk');

  if (answerErr) {
    answerErr.style.display = 'none';
    answerErr.textContent = '';
  }
  if (retryBox) retryBox.style.display = 'none';
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit';
  }
  if (idkBtn) idkBtn.disabled = false;

  if (answerInput) {
    answerInput.disabled = false;
    answerInput.value = '';
    setTimeout(() => {
      try {
        answerInput.focus();
      } catch {
        // ignore focus error
      }
    }, 20);
  }
}

async function getBearerToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function callTestFlashStartApi() {
  if (isDemoMode() && !isSupabaseConfigured()) {
    return DemoDB.mockStartWeeklyTestSection(
      currentProfile?.id,
      activeTestId,
      null,
      activeSectionId
    );
  }
  const token = await getBearerToken();
  const res = await fetch('/api/weekly-test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      action: 'start',
      test_id: activeTestId,
      section_id: activeSectionId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Could not start test try (HTTP ${res.status}).`);
  }
  return data;
}

async function callTestFlashSubmitApi(sessionId, answerValue) {
  if (isDemoMode() && !isSupabaseConfigured()) {
    return DemoDB.mockSubmitWeeklyTestSection(
      currentProfile?.id,
      sessionId,
      answerValue
    );
  }
  const token = await getBearerToken();
  const res = await fetch('/api/weekly-test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      action: 'submit',
      session_id: sessionId,
      answer: answerValue,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Could not submit test try (HTTP ${res.status}).`);
  }
  return data;
}

/**
 * Starts a Flash Anzan try (after any long-duration confirmation)
 */
async function startTryExecution() {
  if (isStarting) return;
  showErrorBanner(null);

  if (isTestMode) {
    ensureAudioContext();
    isStarting = true;
    const nextTryBtn = document.getElementById('btn-test-next-try');
    if (nextTryBtn) {
      nextTryBtn.disabled = true;
      nextTryBtn.textContent = 'Starting...';
    }
    try {
      const response = await callTestFlashStartApi();
      const numbers = Array.isArray(response?.numbers) ? response.numbers : null;
      if (!response || !response.session_id || !Array.isArray(numbers) || numbers.length === 0) {
        throw new Error('Could not start the test try.');
      }

      activeTestTitle = response.title || activeTestTitle;
      activeTryNo = Number(response.try_no) || 1;
      activeQuestionCount = Number(response.question_count) || 5;
      currentSettings = response.settings
        ? clampFlashSettings(response.settings)
        : currentSettings;

      clearActiveTimers();
      activeTry = {
        session_id: response.session_id,
        numbers,
        settings: currentSettings,
        phase: 'countdown',
        cancelled: false,
        pendingAnswer: undefined,
      };

      showScreen('play');
      await runTrySequence();
    } catch (err) {
      showErrorBanner(err?.message || 'Could not start this weekly test section.');
      renderTestSectionErrorScreen(err?.message || 'Could not start this weekly test section.');
      showScreen('results');
    } finally {
      isStarting = false;
      if (nextTryBtn) {
        nextTryBtn.disabled = false;
        nextTryBtn.textContent = 'Next try →';
      }
    }
    return;
  }

  currentSettings = clampFlashSettings(currentSettings);
  const validation = validateFlashSettings(currentSettings);
  if (!validation.valid || !validation.settings) {
    showErrorBanner(validation.errors.join(' '));
    return;
  }

  savePreferences();
  ensureAudioContext();

  const startBtn = document.getElementById('btn-flash-start');
  isStarting = true;
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  }

  try {
    const response = await callFlashStartRpc(validation.settings);
    const numbers = Array.isArray(response?.numbers)
      ? response.numbers
      : Array.isArray(response?.questions?.[0])
        ? response.questions[0]
        : null;

    if (!response || !response.session_id || !Array.isArray(numbers) || numbers.length === 0) {
      throw new Error('Could not start the try. Please try again.');
    }

    clearActiveTimers();
    activeTry = {
      session_id: response.session_id,
      numbers,
      settings: response.settings
        ? clampFlashSettings(response.settings)
        : validation.settings,
      phase: 'countdown',
      cancelled: false,
      pendingAnswer: undefined,
    };

    showScreen('play');
    await runTrySequence();
  } catch (err) {
    const friendly = friendlyFlashError(err, 'start');
    showErrorBanner(friendly);
    showScreen('setup');
  } finally {
    isStarting = false;
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }
  }
}

/**
 * Submits the student's single integer answer (or `null` for "I don't know") via `flash_submit`
 */
async function submitTryAnswer(answerValue) {
  if (!activeTry || isSubmitting) return;
  isSubmitting = true;
  activeTry.pendingAnswer = answerValue;

  const answerInput = document.getElementById('flash-answer-input');
  const submitBtn = document.getElementById('btn-answer-submit');
  const idkBtn = document.getElementById('btn-answer-idk');
  const retryBox = document.getElementById('flash-submit-retry-box');
  const retryMsg = document.getElementById('flash-submit-retry-msg');
  const answerErr = document.getElementById('flash-answer-error');

  if (answerErr) answerErr.style.display = 'none';
  if (retryBox) retryBox.style.display = 'none';
  if (answerInput) answerInput.disabled = true;
  if (idkBtn) idkBtn.disabled = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
  }

  try {
    if (isTestMode) {
      const result = await callTestFlashSubmitApi(activeTry.session_id, answerValue);
      const finishedTry = activeTry;
      activeTry = null;

      renderTestTryResultScreen(result, finishedTry);
      showScreen('results');
      return;
    }

    const result = await callFlashSubmitRpc(activeTry.session_id, answerValue);
    const finishedTry = activeTry;
    activeTry = null;

    renderTryResultScreen(result, finishedTry);
    showScreen('results');
    await loadFlashHistory();
  } catch (err) {
    const exactMessage = isTestMode
      ? err?.message || 'Could not send your answer. Please try sending again.'
      : friendlyFlashError(err, 'submit');
    if (retryBox && retryMsg) {
      retryMsg.textContent = exactMessage;
      retryBox.style.display = 'block';
    } else {
      showErrorBanner(exactMessage);
    }
    if (answerInput) answerInput.disabled = false;
    if (idkBtn) idkBtn.disabled = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';
    }
  } finally {
    isSubmitting = false;
  }
}

function renderTestSectionErrorScreen(message) {
  const titleEl = document.getElementById('results-card-title');
  const summaryHeaderEl = document.getElementById('results-settings-summary');
  const outcomeBanner = document.getElementById('result-outcome-banner');
  const outcomeLabel = document.getElementById('result-outcome-label');
  const outcomeSub = document.getElementById('result-outcome-sub');
  const metricsGrid = document.getElementById('results-metrics-grid');
  const detailsEl = document.getElementById('res-numbers-details');
  const changeBtn = document.getElementById('btn-results-change-settings');
  const tryAgainBtn = document.getElementById('btn-results-try-again');
  const nextTryBtn = document.getElementById('btn-test-next-try');
  const backWeeklyBtn = document.getElementById('btn-test-back-weekly');
  const testSavedBanner = document.getElementById('result-test-saved-banner');

  if (titleEl) titleEl.textContent = 'Weekly Test Section';
  if (summaryHeaderEl) summaryHeaderEl.textContent = activeTestTitle;
  if (changeBtn) changeBtn.style.display = 'none';
  if (tryAgainBtn) tryAgainBtn.style.display = 'none';
  if (nextTryBtn) nextTryBtn.style.display = 'none';
  if (backWeeklyBtn) backWeeklyBtn.style.display = 'inline-flex';
  if (testSavedBanner) testSavedBanner.style.display = 'none';
  if (metricsGrid) metricsGrid.style.display = 'none';
  if (detailsEl) detailsEl.style.display = 'none';

  if (outcomeBanner && outcomeLabel) {
    outcomeBanner.style.background = 'rgba(220, 38, 38, 0.08)';
    outcomeBanner.style.borderColor = 'var(--color-score-danger)';
    outcomeLabel.style.color = 'var(--color-score-danger)';
    outcomeLabel.textContent = 'Section Unavailable';
  }
  if (outcomeSub) {
    outcomeSub.style.display = 'block';
    outcomeSub.textContent = message;
  }
}

/**
 * Renders the Weekly Test multi-try screen:
 * - When `result.done === false`: shows "Answer recorded" and "Next try" (never reveals right or wrong).
 * - When `result.done === true`: shows "<tries_correct> of <question_count> correct", total time,
 *   shared score colour feedback, "Saved as part of <test title>", and "Back to Weekly Test".
 */
function renderTestTryResultScreen(result, finishedTry) {
  const done = Boolean(result?.done);
  const tryNo = Number(result?.try_no) || activeTryNo;
  const qCount = Number(result?.question_count) || activeQuestionCount;
  const settings = finishedTry?.settings || currentSettings;
  const summaryStr = formatFlashSettingsSummary(settings);
  const testTitle = result?.title || activeTestTitle;

  const titleEl = document.getElementById('results-card-title');
  const summaryHeaderEl = document.getElementById('results-settings-summary');
  const outcomeBanner = document.getElementById('result-outcome-banner');
  const outcomeLabel = document.getElementById('result-outcome-label');
  const outcomeSub = document.getElementById('result-outcome-sub');
  const metricsGrid = document.getElementById('results-metrics-grid');
  const detailsEl = document.getElementById('res-numbers-details');
  const changeBtn = document.getElementById('btn-results-change-settings');
  const tryAgainBtn = document.getElementById('btn-results-try-again');
  const nextTryBtn = document.getElementById('btn-test-next-try');
  const backWeeklyBtn = document.getElementById('btn-test-back-weekly');
  const testSavedBanner = document.getElementById('result-test-saved-banner');

  if (changeBtn) changeBtn.style.display = 'none';
  if (tryAgainBtn) tryAgainBtn.style.display = 'none';
  if (detailsEl) detailsEl.style.display = 'none';

  if (!done) {
    if (titleEl) titleEl.textContent = flashProgressText(tryNo, qCount);
    if (summaryHeaderEl) summaryHeaderEl.textContent = `${testTitle} · ${summaryStr}`;
    if (testSavedBanner) testSavedBanner.style.display = 'none';
    if (metricsGrid) metricsGrid.style.display = 'none';

    if (outcomeBanner && outcomeLabel) {
      outcomeBanner.style.background = 'var(--color-primary-subtle)';
      outcomeBanner.style.borderColor = 'var(--color-primary)';
      outcomeLabel.style.color = 'var(--color-primary)';
      outcomeLabel.textContent = 'Answer recorded';
    }
    if (outcomeSub) {
      outcomeSub.style.display = 'block';
      outcomeSub.textContent = `${flashProgressText(tryNo, qCount)} complete. Click "Next try" when you are ready for try ${tryNo + 1} of ${qCount}.`;
    }
    if (nextTryBtn) {
      nextTryBtn.style.display = 'inline-flex';
      nextTryBtn.textContent = `Next try (${tryNo + 1} of ${qCount}) →`;
    }
    if (backWeeklyBtn) {
      backWeeklyBtn.style.display = 'inline-flex';
      backWeeklyBtn.className = 'btn btn-outline';
    }
    return;
  }

  // Final try complete (`done === true`)
  const triesCorrect = Number(result?.tries_correct ?? result?.correct) || 0;
  const secondsUsed = Number(result?.seconds_used) || 0;
  const fb = getScoreFeedback(triesCorrect, qCount);

  if (titleEl) titleEl.textContent = 'Flash Anzan Section Complete';
  if (summaryHeaderEl) summaryHeaderEl.textContent = `${testTitle} · ${summaryStr}`;
  if (nextTryBtn) nextTryBtn.style.display = 'none';
  if (backWeeklyBtn) {
    backWeeklyBtn.style.display = 'inline-flex';
    backWeeklyBtn.className = 'btn btn-primary';
  }
  if (testSavedBanner) {
    testSavedBanner.textContent = `✓ Saved as part of ${testTitle}`;
    testSavedBanner.style.display = 'block';
  }

  if (outcomeBanner && outcomeLabel) {
    outcomeBanner.style.background = fb.bgVar;
    outcomeBanner.style.borderColor = fb.colorVar;
    outcomeLabel.style.color = fb.colorVar;
    outcomeLabel.textContent = `${triesCorrect} of ${qCount} correct`;
  }
  if (outcomeSub) {
    outcomeSub.style.display = 'block';
    outcomeSub.style.color = fb.colorVar;
    outcomeSub.textContent = `${fb.wrongText} · Total time: ${formatSecondsToTime(secondsUsed)}`;
  }

  if (metricsGrid) {
    metricsGrid.style.display = 'grid';
    const givenEl = document.getElementById('res-stat-given');
    const expectedEl = document.getElementById('res-stat-expected');
    const timeEl = document.getElementById('res-stat-time');
    const settingsEl = document.getElementById('res-stat-settings');

    const givenLabel = givenEl?.previousElementSibling;
    const expectedLabel = expectedEl?.previousElementSibling;
    if (givenLabel) givenLabel.textContent = 'Section Score';
    if (expectedLabel) expectedLabel.textContent = 'Mistakes';
    if (givenEl) {
      givenEl.textContent = `${triesCorrect} / ${qCount}`;
      givenEl.style.color = fb.colorVar;
    }
    if (expectedEl) {
      expectedEl.textContent = fb.wrongText;
      expectedEl.style.color = fb.colorVar;
    }
    if (timeEl) timeEl.textContent = formatSecondsToTime(secondsUsed);
    if (settingsEl) settingsEl.textContent = summaryStr;
  }
}

/**
 * Renders the Result Screen immediately after answering (normal practice mode)
 */
function renderTryResultScreen(result, finishedTry) {
  const isCorrect = Boolean(result?.correct);
  const expected = result?.expected ?? '—';
  const given =
    result?.given !== undefined ? result.given : finishedTry?.pendingAnswer ?? null;
  const seconds = Math.max(0, Number(result?.seconds) || 0);
  const settings = finishedTry?.settings || currentSettings;
  const numbers = Array.isArray(finishedTry?.numbers) ? finishedTry.numbers : [];
  const summaryStr = formatFlashSettingsSummary(settings);

  const outcomeBanner = document.getElementById('result-outcome-banner');
  const outcomeLabel = document.getElementById('result-outcome-label');
  const outcomeSub = document.getElementById('result-outcome-sub');
  if (outcomeSub) outcomeSub.style.display = 'none';
  if (outcomeBanner && outcomeLabel) {
    if (isCorrect) {
      outcomeBanner.style.background = 'rgba(22, 163, 74, 0.08)';
      outcomeBanner.style.borderColor = 'var(--color-score-perfect)';
      outcomeLabel.style.color = 'var(--color-score-perfect)';
      outcomeLabel.textContent = 'Correct';
    } else {
      outcomeBanner.style.background = 'rgba(220, 38, 38, 0.08)';
      outcomeBanner.style.borderColor = 'var(--color-score-danger)';
      outcomeLabel.style.color = 'var(--color-score-danger)';
      outcomeLabel.textContent = 'Wrong';
    }
  }

  const summaryHeaderEl = document.getElementById('results-settings-summary');
  if (summaryHeaderEl) summaryHeaderEl.textContent = summaryStr;

  const givenEl = document.getElementById('res-stat-given');
  if (givenEl) {
    givenEl.textContent =
      given === null || given === undefined ? "I don't know" : String(given);
  }

  const expectedEl = document.getElementById('res-stat-expected');
  if (expectedEl) {
    expectedEl.textContent = String(expected);
  }

  const timeEl = document.getElementById('res-stat-time');
  if (timeEl) {
    timeEl.textContent = formatSecondsToTime(seconds);
  }

  const settingsEl = document.getElementById('res-stat-settings');
  if (settingsEl) {
    settingsEl.textContent = summaryStr;
  }

  const tryAgainConfirm = document.getElementById('results-try-again-confirm');
  if (tryAgainConfirm) tryAgainConfirm.style.display = 'none';

  // When the question had 100 numbers or fewer, show collapsed "Show the numbers" list
  const detailsEl = document.getElementById('res-numbers-details');
  const countSpan = document.getElementById('res-numbers-count');
  const listEl = document.getElementById('res-numbers-list');

  if (detailsEl && listEl) {
    detailsEl.open = false;
    if (
      numbers.length > 0 &&
      numbers.length <= FLASH_LIMITS.MAX_SHOW_NUMBERS_COUNT
    ) {
      if (countSpan) countSpan.textContent = String(numbers.length);
      listEl.innerHTML = numbers
        .map((n) => {
          const val = Number(n);
          const text = val < 0 ? `-${Math.abs(val)}` : `${Math.abs(val)}`;
          return `<li>${escapeHtml(text)}</li>`;
        })
        .join('');
      detailsEl.style.display = 'block';
    } else {
      listEl.innerHTML = '';
      detailsEl.style.display = 'none';
    }
  }
}

/**
 * Loads the student's `activity_results` (`activity_type = 'flash_anzan'`)
 * and updates both the Last 20 Tries table and the Setup Screen stats tables.
 */
async function loadFlashHistory() {
  const tbody = document.getElementById('flash-history-tbody');

  try {
    let rows = [];
    if (isDemoMode() && !isSupabaseConfigured()) {
      rows = DemoDB.getActivityResults((activeHistoryStudent && activeHistoryStudent.id) || currentProfile?.id, 'flash_anzan');
    } else {
      const supabase = await getSupabase();
      if (supabase && currentProfile?.id) {
        rows = await fetchAllRowsBatched(async (from, to) => {
          const { data, error } = await supabase
            .from('activity_results')
            .select('id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
            .eq('student_id', (activeHistoryStudent && activeHistoryStudent.id) || currentProfile.id)
            .eq('activity_type', 'flash_anzan')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);

          if (error) throw error;
          return data || [];
        }, { batchSize: 1000 });
      }
    }

    cachedHistoryRows = rows;
    renderSetupStatsTables();
    renderFlashHistoryView();
  } catch (err) {
    console.error('Failed to load Flash Anzan history:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-4); color: var(--color-score-danger);">
            Could not load recent Flash Anzan history.
          </td>
        </tr>
      `;
    }
  }
}

function renderFlashHistoryView() {
  const tbody = document.getElementById('flash-history-tbody');
  const toolbarContainer = document.getElementById('flash-history-toolbar-container');
  const paginationContainer = document.getElementById('flash-history-pagination-container');

  if (toolbarContainer) {
    toolbarContainer.innerHTML = renderHistoryFilterToolbarHtml({
      idPrefix: 'flash',
      categories: FLASH_DIGIT_CATEGORIES,
      currentFilters: flashHistoryFilters,
      hasTyped: false,
    });
    wireFlashFilterListeners();
  }

  if (!tbody) return;

  if (cachedHistoryRows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: var(--space-6); color: var(--text-muted);">
          No Flash Anzan tries completed yet. Start your first try above!
        </td>
      </tr>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  const filtered = filterAndSortHistory(cachedHistoryRows, flashHistoryFilters, {
    sectionKind: 'flash',
  });

  const paged = paginateHistory(filtered, {
    page: flashHistoryPage,
    pageSize: FLASH_PAGE_SIZE,
  });

  if (paged.totalCount === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: var(--space-6); color: var(--text-muted);">
          No Flash Anzan tries match the selected filters.
        </td>
      </tr>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  tbody.innerHTML = paged.items
    .map((row, idx) => {
      const correct = Number(row.correct) || 0;
      const total = Number(row.total) || 1;
      const fb = getScoreFeedback(correct, total);
      const isCorrect = correct >= total;
      const digits = row.settings?.digits ?? 1;
      const count = row.settings?.count ?? 5;
      const speedMs = row.settings?.speed_ms ?? 1000;
      const speedSec = speedMsToSeconds(speedMs);
      const mode = row.settings?.mode || 'add';
      const modeText = mode === 'add_sub' ? 'Addition & Subtraction' : 'Addition';
      const outcomeText = isCorrect ? '✅ Correct' : '❌ Missed';
      const speedDisplay = formatSpeedDisplay(speedMs);

      const isFlagged = row.flagged === true;
      const flagNote = row.flag_note || '';

      const entrySource = resolveEntrySource(row, 'flash');
      const isVerified = row.verified === true || !!row.verified_at || !!row.verified_by;
      const isCorrected = !!row.corrected_at || !!row.corrected_by;

      const lockExplanation = practiceRecordStatus(row, { readOnly: true });

      const detailsMeta = [
        { label: 'Result outcome', valueHtml: `<strong style="color: ${fb.colorVar};">${outcomeText}</strong>` },
        { label: 'Flash settings', valueHtml: `${digits} digits · ${count} numbers · ${speedSec}s · ${modeText}` },
        { label: 'Speed / rate', valueHtml: `${speedSec}s per number (${speedDisplay.perSecondText})` },
        { label: 'Entry source', valueHtml: renderSourceChipHtml(entrySource) },
        { label: 'Status & lock', valueHtml: lockExplanation },
      ];

      return renderCompactHistoryRowHtml({
        rowId: `flash-${row.id || idx}`,
        category: `${digits}D Flash`,
        categorySub: '',
        correct: correct,
        total: total,
        timeFormatted: formatSecondsToTime(row.time_seconds),
        dateVal: row.created_at,
        isFlagged: isFlagged,
        flagNote: flagNote,
        statusBadgeHtml: '',
        detailsMeta: detailsMeta,
        actionsHtml: '',
        mainRowAttrs: row.id ? `data-flash-id="${row.id}"` : '',
      });
    })
    .join('');

  if (paginationContainer) {
    paginationContainer.innerHTML = renderHistoryPaginationHtml({
      idPrefix: 'flash',
      page: paged.page,
      totalPages: paged.totalPages,
      totalCount: paged.totalCount,
    });

    document.getElementById('flash-btn-prev-page')?.addEventListener('click', () => {
      if (flashHistoryPage > 1) {
        flashHistoryPage--;
        renderFlashHistoryView();
      }
    });

    document.getElementById('flash-btn-next-page')?.addEventListener('click', () => {
      if (flashHistoryPage < paged.totalPages) {
        flashHistoryPage++;
        renderFlashHistoryView();
      }
    });
  }
}

function wireFlashFilterListeners() {
  const fromInput = document.getElementById('flash-filter-from');
  const toInput = document.getElementById('flash-filter-to');
  const catSelect = document.getElementById('flash-filter-cat');
  const sourceSelect = document.getElementById('flash-filter-source');
  const sortSelect = document.getElementById('flash-filter-sort');
  const clearBtn = document.getElementById('flash-btn-clear-filters');

  const onFilterChange = () => {
    flashHistoryFilters.dateFrom = fromInput?.value || '';
    flashHistoryFilters.dateTo = toInput?.value || '';
    flashHistoryFilters.category = catSelect?.value || 'all';
    flashHistoryFilters.source = sourceSelect?.value || 'all';
    flashHistoryFilters.sort = sortSelect?.value || 'newest';
    flashHistoryPage = 1;
    renderFlashHistoryView();
  };

  fromInput?.addEventListener('change', onFilterChange);
  toInput?.addEventListener('change', onFilterChange);
  catSelect?.addEventListener('change', onFilterChange);
  sourceSelect?.addEventListener('change', onFilterChange);
  sortSelect?.addEventListener('change', onFilterChange);

  clearBtn?.addEventListener('click', () => {
    flashHistoryFilters = {
      dateFrom: '',
      dateTo: '',
      category: 'all',
      source: 'all',
      sort: 'newest',
    };
    flashHistoryPage = 1;
    renderFlashHistoryView();
  });
}

/**
 * Binds all Setup, Play, and Results screen interactions
 */
function setupEventListeners() {
  // Visibility change listener to cancel active tries when leaving the tab
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // 1. Digits pills (1 to 5)
  document.querySelectorAll('[data-digits]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = Number(btn.getAttribute('data-digits'));
      if (Number.isInteger(val)) {
        currentSettings.digits = val;
        syncSetupControlsUI();
        savePreferences();
      }
    });
  });

  // 2. Mode pills ('add' | 'add_sub')
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-mode');
      if (m === 'add' || m === 'add_sub') {
        currentSettings.mode = m;
        syncSetupControlsUI();
        savePreferences();
      }
    });
  });

  // 3. Numbers in the question (2 to 1000) with -, +, and quick steps (-100, -10, +10, +100)
  const countInput = document.getElementById('flash-count');
  const applyCount = (val) => {
    const num = Number(val);
    if (!Number.isFinite(num)) return;
    currentSettings.count = Math.max(
      FLASH_LIMITS.COUNT_MIN,
      Math.min(FLASH_LIMITS.COUNT_MAX, Math.round(num))
    );
    syncSetupControlsUI();
    savePreferences();
  };

  document.getElementById('btn-count-dec')?.addEventListener('click', () => {
    applyCount(currentSettings.count - 1);
  });
  document.getElementById('btn-count-inc')?.addEventListener('click', () => {
    applyCount(currentSettings.count + 1);
  });

  document.querySelectorAll('[data-count-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const delta = Number(btn.getAttribute('data-count-step'));
      if (Number.isFinite(delta)) {
        applyCount(currentSettings.count + delta);
      }
    });
  });

  countInput?.addEventListener('input', () => {
    const raw = countInput.value.trim();
    if (raw === '') return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      currentSettings.count = Math.max(
        FLASH_LIMITS.COUNT_MIN,
        Math.min(FLASH_LIMITS.COUNT_MAX, Math.round(parsed))
      );
      syncSetupControlsUI();
      savePreferences();
    }
  });

  countInput?.addEventListener('blur', () => {
    applyCount(countInput.value);
    if (countInput) countInput.value = String(currentSettings.count);
  });

  // 4. Speed per number (0.2 to 5.0 seconds in steps of 0.1)
  const speedInput = document.getElementById('flash-speed-seconds');
  const speedRange = document.getElementById('flash-speed-range');

  const applySpeedMs = (ms) => {
    const num = Number(ms);
    if (!Number.isFinite(num)) return;
    const rounded = Math.round(num / 100) * 100;
    currentSettings.speed_ms = Math.max(
      FLASH_LIMITS.SPEED_MS_MIN,
      Math.min(FLASH_LIMITS.SPEED_MS_MAX, rounded)
    );
    syncSetupControlsUI();
    savePreferences();
  };

  document.getElementById('btn-speed-dec')?.addEventListener('click', () => {
    applySpeedMs(currentSettings.speed_ms - FLASH_LIMITS.SPEED_MS_STEP);
  });
  document.getElementById('btn-speed-inc')?.addEventListener('click', () => {
    applySpeedMs(currentSettings.speed_ms + FLASH_LIMITS.SPEED_MS_STEP);
  });

  speedRange?.addEventListener('input', () => {
    applySpeedMs(speedRange.value);
  });

  speedInput?.addEventListener('change', () => {
    const ms = secondsToSpeedMs(speedInput.value);
    if (Number.isFinite(ms)) {
      applySpeedMs(ms);
      speedInput.value = speedMsToSeconds(currentSettings.speed_ms).toFixed(1);
    } else {
      speedInput.value = speedMsToSeconds(currentSettings.speed_ms).toFixed(1);
    }
  });

  // 5. Sound toggle
  const soundToggle = document.getElementById('flash-sound-toggle');
  soundToggle?.addEventListener('change', () => {
    soundEnabled = Boolean(soundToggle.checked);
    savePreferences();
    if (soundEnabled) {
      playFlashBeep(false);
    }
  });

  // 6. Setup form submit -> check duration (> 5 minutes requires confirmation)
  const setupForm = document.getElementById('flash-setup-form');
  setupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (countInput && countInput.value.trim() !== '') {
      currentSettings.count = Math.max(
        FLASH_LIMITS.COUNT_MIN,
        Math.min(FLASH_LIMITS.COUNT_MAX, Math.round(Number(countInput.value) || currentSettings.count))
      );
    }
    syncSetupControlsUI();

    const durationInfo = getExpectedDurationInfo(currentSettings);
    if (durationInfo.requiresConfirmation) {
      const longBox = document.getElementById('flash-long-confirm-box');
      const longText = document.getElementById('flash-long-confirm-text');
      if (longBox && longText) {
        longText.textContent = durationInfo.confirmMessage;
        longBox.style.display = 'block';
        return;
      }
    }

    await startTryExecution();
  });

  document.getElementById('btn-confirm-long-cancel')?.addEventListener('click', () => {
    const longBox = document.getElementById('flash-long-confirm-box');
    if (longBox) longBox.style.display = 'none';
  });

  document.getElementById('btn-confirm-long-yes')?.addEventListener('click', async () => {
    const longBox = document.getElementById('flash-long-confirm-box');
    if (longBox) longBox.style.display = 'none';
    await startTryExecution();
  });

  // Toggle Settings Drawer
  const toggleSettingsBtn = document.getElementById('btn-toggle-flash-settings');
  const settingsDrawer = document.getElementById('flash-settings-drawer');
  toggleSettingsBtn?.addEventListener('click', () => {
    const isHidden = settingsDrawer?.hasAttribute('hidden');
    if (isHidden) {
      settingsDrawer?.removeAttribute('hidden');
      toggleSettingsBtn.setAttribute('aria-expanded', 'true');
      toggleSettingsBtn.classList.add('is-open');
    } else {
      settingsDrawer?.setAttribute('hidden', '');
      toggleSettingsBtn.setAttribute('aria-expanded', 'false');
      toggleSettingsBtn.classList.remove('is-open');
    }
  });

  // 7. Stop button with confirmation (abandons try and saves nothing)
  const stopConfirmBar = document.getElementById('flash-stop-confirm-bar');
  document.getElementById('btn-flash-stop')?.addEventListener('click', () => {
    if (stopConfirmBar) {
      stopConfirmBar.style.display =
        stopConfirmBar.style.display === 'flex' ? 'none' : 'flex';
    }
  });

  document.getElementById('btn-stop-cancel')?.addEventListener('click', () => {
    if (stopConfirmBar) stopConfirmBar.style.display = 'none';
  });

  document.getElementById('btn-stop-confirm')?.addEventListener('click', () => {
    if (activeTry) {
      activeTry.cancelled = true;
    }
    clearActiveTimers();
    activeTry = null;
    if (stopConfirmBar) stopConfirmBar.style.display = 'none';
    if (isTestMode) {
      window.location.href = '/pages/weekly-test.html';
      return;
    }
    showScreen('setup');
    showToast('Try abandoned. Nothing was saved.', 'info');
  });

  // 8. Answer box: digits only (no minus sign), up to 10 digits, Enter confirms
  const answerInput = document.getElementById('flash-answer-input');
  answerInput?.addEventListener('input', () => {
    const digitsOnly = answerInput.value.replace(/\D+/g, '').slice(0, 10);
    if (answerInput.value !== digitsOnly) {
      answerInput.value = digitsOnly;
    }
  });

  const answerForm = document.getElementById('flash-answer-form');
  answerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeTry || activeTry.phase !== 'answering' || isSubmitting) return;

    const rawVal = answerInput ? answerInput.value : '';
    const parsed = parseFlashAnswerInput(rawVal);
    const errEl = document.getElementById('flash-answer-error');
    if (!parsed.ok) {
      if (errEl) {
        errEl.textContent = parsed.error || 'Please enter digits only.';
        errEl.style.display = 'block';
      }
      return;
    }

    await submitTryAnswer(parsed.value);
  });

  // "I don't know" button submits null
  document.getElementById('btn-answer-idk')?.addEventListener('click', async () => {
    if (!activeTry || activeTry.phase !== 'answering' || isSubmitting) return;
    await submitTryAnswer(null);
  });

  // Retry button if flash_submit failed
  document.getElementById('btn-submit-retry')?.addEventListener('click', async () => {
    if (!activeTry || isSubmitting) return;
    await submitTryAnswer(
      activeTry.pendingAnswer !== undefined ? activeTry.pendingAnswer : null
    );
  });

  // Weekly Test "Next try" button
  document.getElementById('btn-test-next-try')?.addEventListener('click', async () => {
    if (!isTestMode || isStarting) return;
    await startTryExecution();
  });

  // 9. Result screen buttons: "Try again" (with short confirmation of settings) and "Change settings"
  const tryAgainConfirm = document.getElementById('results-try-again-confirm');
  const tryAgainConfirmText = document.getElementById('results-try-again-confirm-text');

  document.getElementById('btn-results-try-again')?.addEventListener('click', () => {
    if (tryAgainConfirm && tryAgainConfirmText) {
      const durationInfo = getExpectedDurationInfo(currentSettings);
      const extraWarn = durationInfo.requiresConfirmation
        ? ` (${durationInfo.confirmMessage})`
        : '';
      tryAgainConfirmText.textContent = `Ready to start: ${formatFlashSettingsSummary(
        currentSettings
      )}${extraWarn}`;
      tryAgainConfirm.style.display = 'flex';
    }
  });

  document.getElementById('btn-try-again-cancel')?.addEventListener('click', () => {
    if (tryAgainConfirm) tryAgainConfirm.style.display = 'none';
  });

  document.getElementById('btn-try-again-go')?.addEventListener('click', async () => {
    if (tryAgainConfirm) tryAgainConfirm.style.display = 'none';
    await startTryExecution();
  });

  document.getElementById('btn-results-change-settings')?.addEventListener('click', () => {
    syncSetupControlsUI();
    showScreen('setup');
    const drawer = document.getElementById('flash-settings-drawer');
    const toggleBtn = document.getElementById('btn-toggle-flash-settings');
    if (drawer && drawer.hasAttribute('hidden')) {
      drawer.removeAttribute('hidden');
      toggleBtn?.setAttribute('aria-expanded', 'true');
      toggleBtn?.classList.add('is-open');
    }
  });

  // Phase 14a: Restore task settings button
  document.getElementById('btn-restore-task-settings')?.addEventListener('click', () => {
    if (!activeTaskSpec) return;
    currentSettings = clampFlashSettings(applyTaskToSettings(currentSettings, activeTaskSpec));
    syncSetupControlsUI();
  });
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');
  if (container) container.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || 'STU';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

async function initFlashTrainerPage() {
  const profile = await requireAuth(['student', 'admin', 'teacher']);
  if (!profile) return;

  currentProfile = profile;
  renderHeaderUser(profile);

  const urlParams = new URLSearchParams(window.location.search);
  const requestedStudentId = urlParams.get('student_id') || urlParams.get('student');
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  const targetResult = await resolveHistoryTargetStudent({
    loggedInProfile: currentProfile,
    urlStudentId: requestedStudentId,
    supabase,
    isDemo: isDemoMode(),
    DemoDB,
  });

  if (targetResult.error) {
    showToast('error', targetResult.error);
    if (!targetResult.targetStudent) {
      const bannerPlaceholder = document.getElementById('config-banner-placeholder');
      if (bannerPlaceholder) {
        bannerPlaceholder.innerHTML = `<div class="banner banner-error" style="margin-bottom: var(--space-4);" role="alert">${targetResult.error}</div>`;
        bannerPlaceholder.style.display = 'block';
      }
      return;
    }
  }

  activeHistoryStudent = targetResult.targetStudent || currentProfile;

  if (!targetResult.isSelf && activeHistoryStudent) {
    const bannerPlaceholder = document.getElementById('config-banner-placeholder');
    renderTargetStudentBanner(bannerPlaceholder, activeHistoryStudent);

    // In student detail view, hide flash setup and runner so complete history is prominent
    const setupCard = document.getElementById('flash-setup-form')?.closest('.card') || document.getElementById('flash-setup-form');
    if (setupCard) setupCard.style.display = 'none';
  }
  if (!profile) return;

  currentProfile = profile;
  renderHeaderUser(profile);

  // 1. Load last-used settings from localStorage
  loadSavedPreferences();

  const runnerQuery = parseTestRunnerQuery(window.location.search);
  isTestMode = runnerQuery.isTestMode;
  activeTestId = runnerQuery.testId;
  activeSectionId = runnerQuery.sectionId;

  if (isTestMode) {
    setupEventListeners();
    window.addEventListener('beforeunload', (e) => {
      if (isTestMode && activeTry && !activeTry.cancelled) {
        e.preventDefault();
        e.returnValue = RUNNER_EXIT_CONFIRM_TEXT;
        return e.returnValue;
      }
    });
    showScreen('play');
    await startTryExecution();
    return;
  }

  // 2. Phase 14a: Read URL query parameters (?task=1, digits, count, speed, mode).
  // Valid task parameters win over last-used settings while task=1 is present.
  const parsedQuery = parseFlashTaskQuery(window.location.search);
  activeTodoTaskId = parsedQuery.todo_task_id || null;
  if (parsedQuery.isTask) {
    activeTaskSpec = parsedQuery.task;
  } else {
    activeTaskSpec = null;
  }
  if (parsedQuery.hasAnyParam) {
    currentSettings = clampFlashSettings(
      applyTaskToSettings(currentSettings, parsedQuery.task)
    );
  }

  syncSetupControlsUI();
  setupEventListeners();
  await loadFlashHistory();
}

document.addEventListener('DOMContentLoaded', initFlashTrainerPage);
