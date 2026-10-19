/**
 * Trendz Tracker - Flash Anzan Trainer Controller (js/flash.js)
 *
 * STRICT RULES:
 * - Never calculate sums, correctness, streaks, or points in JavaScript.
 * - The browser only displays the numbers returned by flash_start(p_settings)
 *   and sends the student's answers (array of integers or nulls) to flash_submit(p_session, p_answers).
 * - Never insert, update, or delete rows in activity_results from the browser;
 *   only read the student's own activity_results rows for history display.
 * - Uses Web Audio API for the optional beep and plain JavaScript for timing.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import {
  FLASH_LIMITS,
  FLASH_PRESETS,
  detectFlashPreset,
  formatFlashSettingsSummary,
  formatNumberSequence,
  formatSpeedDisplay,
  friendlyFlashError,
  parseFlashAnswerInput,
  secondsToSpeedMs,
  speedMsToSeconds,
  validateFlashSettings,
} from './flashPresets.js';
import { requireAuth } from './guard.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToTime, getISTDateString } from './stats.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { showToast } from './toast.js';

const STORAGE_KEY_SETTINGS = 'trendz_flash_settings_v1';
const STORAGE_KEY_SOUND = 'trendz_flash_sound_v1';

let currentProfile = null;
let currentSettings = { ...FLASH_PRESETS.beginner.settings };
let soundEnabled = false;
let audioCtx = null;

// Active session state
let activeSession = null; // { session_id, questions, settings, startedAtMs, currentIndex, answers, cancelled }
let activeTimers = [];
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
    // 880 Hz (A5) for positive addition, 660 Hz (E5) for negative subtraction
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
 * Timer management for clean cancellation when stopping a set
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
 * Load saved settings & sound preference from localStorage
 */
function loadSavedPreferences() {
  try {
    const rawSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (rawSettings) {
      const parsed = JSON.parse(rawSettings);
      const validated = validateFlashSettings(parsed);
      if (validated.valid && validated.settings) {
        currentSettings = validated.settings;
      }
    }
    const rawSound = localStorage.getItem(STORAGE_KEY_SOUND);
    if (rawSound !== null) {
      soundEnabled = rawSound === 'true';
    }
  } catch {
    // Fallback to defaults
  }
}

function savePreferences() {
  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(currentSettings));
    localStorage.setItem(STORAGE_KEY_SOUND, String(soundEnabled));
  } catch {
    // Ignore storage quota errors
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
    banner.innerHTML = '';
    return;
  }
  banner.innerHTML = `
    <span class="banner-icon" aria-hidden="true">⚠️</span>
    <div class="banner-body">${escapeHtml(message)}</div>
  `;
  banner.style.display = 'flex';
}

/**
 * Syncs all Setup Screen controls and badges with currentSettings
 */
function syncSetupControlsUI(forceCustomHighlight = false) {
  const { digits, count, speed_ms, questions, mode } = currentSettings;
  const presetKey = forceCustomHighlight ? 'custom' : detectFlashPreset(currentSettings);

  // 1. Preset buttons & badge
  document.querySelectorAll('.flash-preset-btn').forEach((btn) => {
    const key = btn.getAttribute('data-preset');
    btn.classList.toggle('active', key === presetKey);
  });

  const presetBadge = document.getElementById('setup-active-preset-badge');
  if (presetBadge) {
    const labelMap = {
      beginner: 'Beginner Preset',
      intermediate: 'Intermediate Preset',
      advanced: 'Advanced Preset',
      custom: 'Custom Settings',
    };
    presetBadge.textContent = labelMap[presetKey] || 'Custom Settings';
  }

  // 2. Digits buttons & hidden input
  const digitsInput = document.getElementById('flash-digits');
  if (digitsInput) digitsInput.value = String(digits);
  const digitsLabel = document.getElementById('display-digits-val');
  if (digitsLabel) digitsLabel.textContent = `${digits} ${digits === 1 ? 'digit' : 'digits'}`;

  document.querySelectorAll('[data-digits]').forEach((btn) => {
    const btnDigits = Number(btn.getAttribute('data-digits'));
    const isActive = btnDigits === digits;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // 3. Mode buttons & hidden input
  const modeInput = document.getElementById('flash-mode');
  if (modeInput) modeInput.value = mode;
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    const btnMode = btn.getAttribute('data-mode');
    const isActive = btnMode === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });

  // 4. Numbers per question (count)
  const countInput = document.getElementById('flash-count');
  const countRange = document.getElementById('flash-count-range');
  const countDisplay = document.getElementById('display-count-val');
  if (countInput && document.activeElement !== countInput) countInput.value = String(count);
  if (countRange) countRange.value = String(count);
  if (countDisplay) countDisplay.textContent = `${count} numbers`;

  const btnCountDec = document.getElementById('btn-count-dec');
  const btnCountInc = document.getElementById('btn-count-inc');
  if (btnCountDec) btnCountDec.disabled = count <= FLASH_LIMITS.COUNT_MIN;
  if (btnCountInc) btnCountInc.disabled = count >= FLASH_LIMITS.COUNT_MAX;

  // 5. Speed per number (seconds & numbers/sec)
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
  if (speedCombinedEl) {
    speedCombinedEl.textContent = `${speedDisplay.secondsText} · ${speedDisplay.perSecondText}`;
  }
  if (speedSecEl) speedSecEl.textContent = speedDisplay.secondsText;
  if (speedRateEl) speedRateEl.textContent = speedDisplay.perSecondText;

  const btnSpeedDec = document.getElementById('btn-speed-dec');
  const btnSpeedInc = document.getElementById('btn-speed-inc');
  if (btnSpeedDec) btnSpeedDec.disabled = speed_ms <= FLASH_LIMITS.SPEED_MS_MIN;
  if (btnSpeedInc) btnSpeedInc.disabled = speed_ms >= FLASH_LIMITS.SPEED_MS_MAX;

  // 6. Questions per set
  const questionsInput = document.getElementById('flash-questions');
  const questionsRange = document.getElementById('flash-questions-range');
  const questionsDisplay = document.getElementById('display-questions-val');
  if (questionsInput && document.activeElement !== questionsInput) {
    questionsInput.value = String(questions);
  }
  if (questionsRange) questionsRange.value = String(questions);
  if (questionsDisplay) questionsDisplay.textContent = `${questions} questions`;

  const btnQDec = document.getElementById('btn-questions-dec');
  const btnQInc = document.getElementById('btn-questions-inc');
  if (btnQDec) btnQDec.disabled = questions <= FLASH_LIMITS.QUESTIONS_MIN;
  if (btnQInc) btnQInc.disabled = questions >= FLASH_LIMITS.QUESTIONS_MAX;

  // 7. Sound toggle
  const soundToggle = document.getElementById('flash-sound-toggle');
  if (soundToggle) soundToggle.checked = soundEnabled;
  updatePlaySoundButtonUI();

  // 8. Summary bar
  const summaryTextEl = document.getElementById('setup-summary-text');
  const durationTextEl = document.getElementById('setup-duration-text');
  if (summaryTextEl) {
    summaryTextEl.textContent = formatFlashSettingsSummary(currentSettings);
  }
  if (durationTextEl) {
    const perQuestionSec = ((count * speed_ms) / 1000).toFixed(1);
    const totalFlashSec = Math.round((questions * count * speed_ms) / 1000);
    durationTextEl.textContent = `${perQuestionSec}s / question (~${totalFlashSec}s total flash)`;
  }
}

function updatePlaySoundButtonUI() {
  const btn = document.getElementById('btn-play-sound-toggle');
  if (!btn) return;
  btn.textContent = soundEnabled ? '🔊 Sound On' : '🔇 Sound Off';
}

/**
 * Switch visible screen ('setup' | 'play' | 'results')
 */
function showScreen(screenName) {
  const setupEl = document.getElementById('flash-setup-screen');
  const playEl = document.getElementById('flash-play-screen');
  const resultsEl = document.getElementById('flash-results-screen');
  const historyEl = document.getElementById('flash-history-section');

  if (setupEl) setupEl.style.display = screenName === 'setup' ? 'block' : 'none';
  if (playEl) playEl.style.display = screenName === 'play' ? 'block' : 'none';
  if (resultsEl) resultsEl.style.display = screenName === 'results' ? 'block' : 'none';
  // Hide distraction below the trainer while actively playing a set
  if (historyEl) historyEl.style.display = screenName === 'play' ? 'none' : 'block';
}

/**
 * Calls RPC flash_start(p_settings) and begins the set
 */
async function startFlashSession() {
  showErrorBanner(null);

  const check = validateFlashSettings(currentSettings);
  if (!check.valid || !check.settings) {
    showErrorBanner(check.errors.join(' '));
    return;
  }

  currentSettings = check.settings;
  savePreferences();

  if (soundEnabled) {
    ensureAudioContext();
  }

  const startBtn = document.getElementById('btn-start-flash');
  const playAgainBtn = document.getElementById('btn-play-again');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Starting Set...';
  }
  if (playAgainBtn) {
    playAgainBtn.disabled = true;
    playAgainBtn.textContent = 'Starting Set...';
  }

  try {
    let rpcData = null;

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('flash_start', {
        p_settings: currentSettings,
      });
      if (error) {
        throw error;
      }
      rpcData = Array.isArray(data) ? data[0] : data;
    } else if (isDemoMode()) {
      rpcData = DemoDB.mockFlashStart(currentSettings, currentProfile?.id);
    } else {
      throw new Error('Database connection is not configured.');
    }

    if (
      !rpcData ||
      !rpcData.session_id ||
      !Array.isArray(rpcData.questions) ||
      rpcData.questions.length === 0
    ) {
      throw new Error('Server returned an unexpected session format.');
    }

    clearActiveTimers();
    activeSession = {
      session_id: rpcData.session_id,
      questions: rpcData.questions,
      settings: rpcData.settings || { ...currentSettings },
      startedAtMs: performance.now(),
      currentIndex: 0,
      answers: [],
      cancelled: false,
    };

    showScreen('play');
    await runQuestionFlow(0);
  } catch (err) {
    const friendly = friendlyFlashError(err, 'start');
    showErrorBanner(friendly);
    showToast('error', friendly);
  } finally {
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = '⚡ Start Flash Set';
    }
    if (playAgainBtn) {
      playAgainBtn.disabled = false;
      playAgainBtn.textContent = '⚡ Play Again (Same Settings)';
    }
  }
}

/**
 * Runs the countdown and number-flashing sequence for question index qIdx,
 * then switches to the answer input box.
 */
async function runQuestionFlow(qIdx) {
  if (!activeSession || activeSession.cancelled) return;

  const totalQuestions = activeSession.questions.length;
  const numbers = activeSession.questions[qIdx] || [];
  const settings = activeSession.settings || currentSettings;
  const speedMs = Number(settings.speed_ms) || 1000;

  activeSession.currentIndex = qIdx;

  // Update play header
  const qCurrentEl = document.getElementById('play-q-current');
  const qTotalEl = document.getElementById('play-q-total');
  const settingsBadgeEl = document.getElementById('play-settings-badge');
  const progressBarEl = document.getElementById('play-progress-bar');

  if (qCurrentEl) qCurrentEl.textContent = String(qIdx + 1);
  if (qTotalEl) qTotalEl.textContent = String(totalQuestions);
  if (settingsBadgeEl) {
    settingsBadgeEl.textContent = formatFlashSettingsSummary(settings);
  }
  if (progressBarEl) {
    const pct = Math.round(((qIdx + 1) / totalQuestions) * 100);
    progressBarEl.style.width = `${pct}%`;
  }

  const stageDisplay = document.getElementById('flash-stage-display');
  const stageAnswer = document.getElementById('flash-stage-answer');
  const stepLabelEl = document.getElementById('flash-step-label');
  const stepIndexEl = document.getElementById('flash-step-index');
  const numberBoxEl = document.getElementById('flash-number-box');
  const subtextEl = document.getElementById('flash-stage-subtext');

  if (stageDisplay) stageDisplay.style.display = 'flex';
  if (stageAnswer) stageAnswer.style.display = 'none';

  // Brief countdown before flashing numbers: Ready (400ms) -> Set (350ms)
  if (stepLabelEl) stepLabelEl.textContent = `Question ${qIdx + 1} of ${totalQuestions}`;
  if (stepIndexEl) stepIndexEl.textContent = `${numbers.length} numbers`;
  if (numberBoxEl) {
    numberBoxEl.className = 'flash-number-display';
    numberBoxEl.textContent = 'Ready...';
  }
  if (subtextEl) subtextEl.textContent = 'Keep your eyes focused in the center';

  await waitMs(450);
  if (!activeSession || activeSession.cancelled) return;

  if (numberBoxEl) {
    numberBoxEl.textContent = 'Go!';
  }
  await waitMs(300);
  if (!activeSession || activeSession.cancelled) return;

  // Monotonic clock anchor for this question's numbers so total time >= numbers.length * speedMs
  const questionFlashStartMs = performance.now();
  // Brief blank gap between consecutive numbers so identical adjacent numbers visibly flash
  const blankGapMs = Math.min(85, Math.max(25, Math.floor(speedMs * 0.15)));
  const visibleDurationMs = Math.max(100, speedMs - blankGapMs);

  for (let i = 0; i < numbers.length; i++) {
    if (!activeSession || activeSession.cancelled) return;

    const num = Number(numbers[i]);
    const isNeg = num < 0;
    const formattedNum = isNeg ? `−${Math.abs(num)}` : String(num);

    if (stepLabelEl) stepLabelEl.textContent = `Question ${qIdx + 1}`;
    if (stepIndexEl) stepIndexEl.textContent = `Number ${i + 1} of ${numbers.length}`;
    if (subtextEl) {
      subtextEl.textContent = isNeg ? 'Subtract (−)' : 'Add (+)';
    }
    if (numberBoxEl) {
      numberBoxEl.className = `flash-number-display ${isNeg ? 'negative' : 'positive'}`;
      numberBoxEl.textContent = formattedNum;
    }

    playFlashBeep(isNeg);

    const slotTargetEndMs = questionFlashStartMs + (i + 1) * speedMs;
    const slotBlankStartMs = slotTargetEndMs - blankGapMs;

    const nowBeforeVisibleWait = performance.now();
    await waitMs(Math.max(20, slotBlankStartMs - nowBeforeVisibleWait));
    if (!activeSession || activeSession.cancelled) return;

    // Blank between numbers so repeat numbers flash distinctly
    if (numberBoxEl) {
      numberBoxEl.textContent = '';
    }

    const nowBeforeGapWait = performance.now();
    await waitMs(Math.max(5, slotTargetEndMs - nowBeforeGapWait));
  }

  if (!activeSession || activeSession.cancelled) return;

  // Ensure total elapsed time for this question's flash phase is at least numbers.length * speedMs
  const totalExpectedMs = numbers.length * speedMs;
  const elapsedMs = performance.now() - questionFlashStartMs;
  if (elapsedMs < totalExpectedMs) {
    await waitMs(Math.ceil(totalExpectedMs - elapsedMs));
  }
  if (!activeSession || activeSession.cancelled) return;

  // Switch to Answer Stage for Question qIdx
  showAnswerStageForQuestion(qIdx, totalQuestions);
}

function showAnswerStageForQuestion(qIdx, totalQuestions) {
  const stageDisplay = document.getElementById('flash-stage-display');
  const stageAnswer = document.getElementById('flash-stage-answer');
  const answerQNum = document.getElementById('answer-q-num');
  const answerInput = document.getElementById('flash-answer-input');
  const answerError = document.getElementById('flash-answer-error');
  const submitBtn = document.getElementById('btn-submit-answer');

  if (stageDisplay) stageDisplay.style.display = 'none';
  if (stageAnswer) stageAnswer.style.display = 'block';
  if (answerQNum) answerQNum.textContent = String(qIdx + 1);
  if (answerError) {
    answerError.style.display = 'none';
    answerError.textContent = '';
  }

  const isLast = qIdx + 1 >= totalQuestions;
  if (submitBtn) {
    submitBtn.innerHTML = isLast ? '✓ Submit Set' : 'Next Question &rarr;';
  }

  if (answerInput) {
    answerInput.value = '';
    setTimeout(() => {
      answerInput.focus();
    }, 20);
  }
}

/**
 * Records the student's answer (integer or null for skip) for the current question,
 * then either advances to the next question or submits the set via flash_submit.
 */
async function recordAnswerAndAdvance(answerValue) {
  if (!activeSession || activeSession.cancelled || isSubmitting) return;

  activeSession.answers.push(answerValue);

  const nextIdx = activeSession.currentIndex + 1;
  if (nextIdx < activeSession.questions.length) {
    await runQuestionFlow(nextIdx);
  } else {
    await submitFlashSession();
  }
}

/**
 * Calls RPC flash_submit(p_session, p_answers) and renders the server results
 */
async function submitFlashSession() {
  if (!activeSession || activeSession.cancelled || isSubmitting) return;
  isSubmitting = true;

  const submitBtn = document.getElementById('btn-submit-answer');
  const skipBtn = document.getElementById('btn-skip-question');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting Set...';
  }
  if (skipBtn) {
    skipBtn.disabled = true;
  }

  try {
    // Guarantee minimum total flash time has elapsed so server never rejects due to sub-millisecond clock skew
    const totalNumbers = activeSession.questions.reduce(
      (sum, q) => sum + (Array.isArray(q) ? q.length : 0),
      0
    );
    const speedMs = Number(activeSession.settings?.speed_ms) || 1000;
    const minRequiredMs = totalNumbers * speedMs + 50;
    const elapsedSinceStartMs = performance.now() - activeSession.startedAtMs;
    if (elapsedSinceStartMs < minRequiredMs) {
      await waitMs(Math.ceil(minRequiredMs - elapsedSinceStartMs));
    }

    let resultData = null;

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('flash_submit', {
        p_session: activeSession.session_id,
        p_answers: activeSession.answers,
      });
      if (error) {
        throw error;
      }
      resultData = Array.isArray(data) ? data[0] : data;
    } else if (isDemoMode()) {
      resultData = DemoDB.mockFlashSubmit(
        activeSession.session_id,
        activeSession.answers,
        currentProfile?.id
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    const completedSettings = activeSession.settings || currentSettings;
    activeSession = null;

    renderFlashResultsScreen(resultData, completedSettings);
    showScreen('results');
    showToast('success', 'Flash Anzan set completed and saved!');

    // Refresh recent history from activity_results
    await loadFlashHistory();
  } catch (err) {
    const friendly = friendlyFlashError(err, 'submit');
    showErrorBanner(friendly);
    showToast('error', friendly);
    activeSession = null;
    showScreen('setup');
  } finally {
    isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
    }
    if (skipBtn) {
      skipBtn.disabled = false;
    }
  }
}

/**
 * Renders the server-returned results and question-by-question breakdown.
 * Never computes correctness or sums in JS; strictly renders server fields.
 */
function renderFlashResultsScreen(resultData, settingsUsed) {
  const correct = Number(resultData?.correct ?? 0);
  const total = Number(resultData?.total ?? 0);
  const accuracy =
    resultData?.accuracy !== undefined && resultData?.accuracy !== null
      ? Number(resultData.accuracy)
      : 0;
  const seconds =
    resultData?.seconds !== undefined && resultData?.seconds !== null
      ? Number(resultData.seconds)
      : null;
  const details = Array.isArray(resultData?.detail) ? resultData.detail : [];

  const summaryEl = document.getElementById('results-settings-summary');
  const scoreEl = document.getElementById('res-metric-score');
  const accEl = document.getElementById('res-metric-accuracy');
  const timeEl = document.getElementById('res-metric-time');
  const tbody = document.getElementById('results-detail-tbody');

  if (summaryEl) {
    summaryEl.textContent = formatFlashSettingsSummary(settingsUsed);
  }
  if (scoreEl) {
    scoreEl.textContent = `${correct} / ${total}`;
  }
  if (accEl) {
    const feedback = getScoreFeedback(correct, total);
    accEl.textContent = `${accuracy}%`;
    accEl.style.color = feedback.colorVar;
  }
  if (timeEl) {
    timeEl.textContent = seconds !== null ? formatSecondsToTime(seconds) : '—';
  }

  if (tbody) {
    if (details.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="empty-state" style="padding: var(--space-4); text-align: center;">
            No question details returned.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = details
        .map((row, idx) => {
          const isCorrect = Boolean(row.correct);
          const isSkipped = row.given === null || row.given === undefined;
          const seqText = formatNumberSequence(row.numbers);
          const expectedText =
            row.expected !== null && row.expected !== undefined ? String(row.expected) : '—';
          const givenText = isSkipped ? 'Skipped' : String(row.given);

          const statusBadge = isCorrect
            ? `<span class="badge badge-success">✓ Correct</span>`
            : isSkipped
              ? `<span class="badge badge-neutral">Skipped</span>`
              : `<span class="badge badge-danger" style="background: var(--color-danger-subtle); color: var(--color-danger-text);">✗ Wrong</span>`;

          return `
            <tr>
              <td class="num" style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
              <td class="num" style="font-family: var(--font-mono); font-size: var(--text-xs);">${escapeHtml(seqText)}</td>
              <td class="num" style="text-align: right; font-weight: 700;">${escapeHtml(expectedText)}</td>
              <td class="num" style="text-align: right; font-weight: 700; color: ${
                isCorrect
                  ? 'var(--color-score-perfect)'
                  : isSkipped
                    ? 'var(--text-dim)'
                    : 'var(--color-danger)'
              };">${escapeHtml(givenText)}</td>
              <td style="text-align: center;">${statusBadge}</td>
            </tr>
          `;
        })
        .join('');
    }
  }
}

/**
 * Loads the student's read-only Flash Anzan history from activity_results
 */
async function loadFlashHistory() {
  const container = document.getElementById('flash-history-container');
  const todayBadge = document.getElementById('flash-today-count-badge');
  if (!container || !currentProfile) return;

  try {
    let rows = [];
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('activity_results')
        .select('id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
        .eq('student_id', currentProfile.id)
        .eq('activity_type', 'flash_anzan')
        .order('created_at', { ascending: false })
        .limit(20);

      if (!error && Array.isArray(data)) {
        rows = data;
      }
    } else if (isDemoMode()) {
      rows = DemoDB.getActivityResults(currentProfile.id, 'flash_anzan');
    }

    const todayIst = getISTDateString(new Date());
    const todayCount = rows.filter((r) => {
      if (!r.created_at) return false;
      return getISTDateString(new Date(r.created_at)) === todayIst;
    }).length;

    if (todayBadge) {
      todayBadge.textContent = `(${todayCount} today)`;
    }

    if (rows.length === 0) {
      container.innerHTML = `
        <div class="card">
          <div class="card-body">
            <div class="empty-state" style="padding: var(--space-4);">
              No Flash Anzan sets completed yet. Choose a preset above and click <strong>Start Flash Set</strong>!
            </div>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="card" style="padding: 0; overflow: hidden;">
        <div class="table-responsive">
          <table class="data-table" aria-label="Recent Flash Anzan Sets">
            <thead>
              <tr>
                <th>Date &amp; Time</th>
                <th>Settings</th>
                <th style="text-align: right;">Score</th>
                <th style="text-align: right;">Accuracy</th>
                <th style="text-align: right;">Time</th>
              </tr>
            </thead>
            <tbody>
              ${rows
                .map((row) => {
                  const dt = row.created_at ? new Date(row.created_at) : null;
                  const dateLabel =
                    dt && !Number.isNaN(dt.getTime())
                      ? dt.toLocaleString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—';
                  const sSummary =
                    row.settings && typeof row.settings === 'object'
                      ? formatFlashSettingsSummary(row.settings)
                      : row.activity_name || 'Flash Anzan';
                  const c = Number(row.correct) || 0;
                  const t = Number(row.total) || 0;
                  const pct = t > 0 ? Math.round((c / t) * 1000) / 10 : 0;
                  const feedback = getScoreFeedback(c, t);
                  const timeStr =
                    row.time_seconds !== null && row.time_seconds !== undefined
                      ? formatSecondsToTime(row.time_seconds)
                      : '—';

                  return `
                    <tr>
                      <td class="num" style="font-size: var(--text-xs); color: var(--text-muted);">${escapeHtml(dateLabel)}</td>
                      <td style="font-size: var(--text-xs); font-weight: 600;">${escapeHtml(sSummary)}</td>
                      <td class="num" style="text-align: right; font-weight: 700;">${c} / ${t}</td>
                      <td class="num" style="text-align: right; font-weight: 700; color: ${feedback.colorVar};">${pct}%</td>
                      <td class="num" style="text-align: right; color: var(--text-muted);">${escapeHtml(timeStr)}</td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    console.warn('Could not load Flash Anzan history:', err);
  }
}

/**
 * Attaches all Setup, Play, Keypad, and Results event listeners
 */
function setupEventListeners() {
  // 1. Preset buttons
  document.querySelectorAll('.flash-preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const presetKey = btn.getAttribute('data-preset');
      const preset = FLASH_PRESETS[presetKey];
      if (preset && preset.settings) {
        currentSettings = { ...preset.settings };
        syncSetupControlsUI(false);
        savePreferences();
      } else {
        syncSetupControlsUI(true);
      }
    });
  });

  // 2. Digits buttons (1 to 5)
  document.querySelectorAll('[data-digits]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = Number(btn.getAttribute('data-digits'));
      if (val >= FLASH_LIMITS.DIGITS_MIN && val <= FLASH_LIMITS.DIGITS_MAX) {
        currentSettings.digits = val;
        syncSetupControlsUI();
        savePreferences();
      }
    });
  });

  // 3. Mode buttons ('add' | 'add_sub')
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-mode');
      if (FLASH_LIMITS.MODES.includes(val)) {
        currentSettings.mode = val;
        syncSetupControlsUI();
        savePreferences();
      }
    });
  });

  // 4. Numbers per question (count: 3 to 30)
  const updateCount = (val) => {
    const clamped = Math.max(
      FLASH_LIMITS.COUNT_MIN,
      Math.min(FLASH_LIMITS.COUNT_MAX, Math.round(Number(val) || 5))
    );
    currentSettings.count = clamped;
    syncSetupControlsUI();
    savePreferences();
  };

  document.getElementById('btn-count-dec')?.addEventListener('click', () => {
    updateCount(currentSettings.count - 1);
  });
  document.getElementById('btn-count-inc')?.addEventListener('click', () => {
    updateCount(currentSettings.count + 1);
  });
  document.getElementById('flash-count-range')?.addEventListener('input', (e) => {
    updateCount(e.target.value);
  });
  document.getElementById('flash-count')?.addEventListener('change', (e) => {
    updateCount(e.target.value);
  });

  // 5. Speed per number (200ms to 5000ms in steps of 100ms / 0.2s to 5.0s in steps of 0.1s)
  const updateSpeedMs = (msVal) => {
    const rounded = Math.round(Number(msVal) / 100) * 100;
    const clamped = Math.max(
      FLASH_LIMITS.SPEED_MS_MIN,
      Math.min(FLASH_LIMITS.SPEED_MS_MAX, rounded || 1500)
    );
    currentSettings.speed_ms = clamped;
    syncSetupControlsUI();
    savePreferences();
  };

  document.getElementById('btn-speed-dec')?.addEventListener('click', () => {
    updateSpeedMs(currentSettings.speed_ms - 100);
  });
  document.getElementById('btn-speed-inc')?.addEventListener('click', () => {
    updateSpeedMs(currentSettings.speed_ms + 100);
  });
  document.getElementById('flash-speed-range')?.addEventListener('input', (e) => {
    updateSpeedMs(e.target.value);
  });
  document.getElementById('flash-speed-seconds')?.addEventListener('change', (e) => {
    const ms = secondsToSpeedMs(e.target.value);
    if (Number.isFinite(ms)) {
      updateSpeedMs(ms);
    } else {
      syncSetupControlsUI();
    }
  });

  // 6. Questions per set (3 to 30)
  const updateQuestions = (val) => {
    const clamped = Math.max(
      FLASH_LIMITS.QUESTIONS_MIN,
      Math.min(FLASH_LIMITS.QUESTIONS_MAX, Math.round(Number(val) || 10))
    );
    currentSettings.questions = clamped;
    syncSetupControlsUI();
    savePreferences();
  };

  document.getElementById('btn-questions-dec')?.addEventListener('click', () => {
    updateQuestions(currentSettings.questions - 1);
  });
  document.getElementById('btn-questions-inc')?.addEventListener('click', () => {
    updateQuestions(currentSettings.questions + 1);
  });
  document.getElementById('flash-questions-range')?.addEventListener('input', (e) => {
    updateQuestions(e.target.value);
  });
  document.getElementById('flash-questions')?.addEventListener('change', (e) => {
    updateQuestions(e.target.value);
  });

  // 7. Sound toggle (Setup & Play screens)
  document.getElementById('flash-sound-toggle')?.addEventListener('change', (e) => {
    soundEnabled = Boolean(e.target.checked);
    updatePlaySoundButtonUI();
    savePreferences();
    if (soundEnabled) {
      playFlashBeep(false);
    }
  });

  document.getElementById('btn-play-sound-toggle')?.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    const setupToggle = document.getElementById('flash-sound-toggle');
    if (setupToggle) setupToggle.checked = soundEnabled;
    updatePlaySoundButtonUI();
    savePreferences();
    if (soundEnabled) {
      playFlashBeep(false);
    }
  });

  // 8. Start Set Form Submit
  document.getElementById('flash-setup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await startFlashSession();
  });

  // 9. Abandon / Stop Set button
  document.getElementById('btn-abandon-set')?.addEventListener('click', () => {
    if (activeSession) {
      activeSession.cancelled = true;
      activeSession = null;
    }
    clearActiveTimers();
    showScreen('setup');
  });

  // 10. Answer Form Submit & Skip Question
  document.getElementById('flash-answer-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputEl = document.getElementById('flash-answer-input');
    const errorEl = document.getElementById('flash-answer-error');
    const raw = inputEl ? inputEl.value : '';

    if (!raw || raw.trim() === '') {
      if (errorEl) {
        errorEl.textContent = 'Enter a whole number or click "Skip Question".';
        errorEl.style.display = 'block';
      }
      return;
    }

    const parsed = parseFlashAnswerInput(raw);
    if (!parsed.ok) {
      if (errorEl) {
        errorEl.textContent = parsed.error || 'Please enter a valid whole number.';
        errorEl.style.display = 'block';
      }
      return;
    }

    await recordAnswerAndAdvance(parsed.value);
  });

  document.getElementById('btn-skip-question')?.addEventListener('click', async () => {
    await recordAnswerAndAdvance(null);
  });

  // 11. Toggle +/- sign & On-screen numeric keypad
  document.getElementById('btn-toggle-sign')?.addEventListener('click', () => {
    const inputEl = document.getElementById('flash-answer-input');
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (val.startsWith('-')) {
      inputEl.value = val.slice(1);
    } else if (val.startsWith('+')) {
      inputEl.value = '-' + val.slice(1);
    } else {
      inputEl.value = '-' + val;
    }
    inputEl.focus();
  });

  document.querySelectorAll('.flash-key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      const inputEl = document.getElementById('flash-answer-input');
      const errorEl = document.getElementById('flash-answer-error');
      if (!inputEl) return;

      if (errorEl) errorEl.style.display = 'none';

      if (key === 'clear') {
        inputEl.value = '';
      } else if (key === 'backspace') {
        inputEl.value = inputEl.value.slice(0, -1);
      } else if (/^\d$/.test(key || '')) {
        if (inputEl.value.length < 12) {
          inputEl.value += key;
        }
      }
    });
  });

  // 12. Results Screen Actions: Play Again & Change Settings
  document.getElementById('btn-play-again')?.addEventListener('click', async () => {
    await startFlashSession();
  });

  document.getElementById('btn-change-settings')?.addEventListener('click', () => {
    showErrorBanner(null);
    syncSetupControlsUI();
    showScreen('setup');
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

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Flash Anzan sessions are simulated locally for preview testing.
      </div>
    </div>
  `;
}

async function initFlashPage() {
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;

  currentProfile = profile;
  renderHeaderUser(profile);

  if (isDemoMode()) {
    renderDemoBanner();
  }

  loadSavedPreferences();
  syncSetupControlsUI();
  setupEventListeners();
  await loadFlashHistory();
}

document.addEventListener('DOMContentLoaded', initFlashPage);
