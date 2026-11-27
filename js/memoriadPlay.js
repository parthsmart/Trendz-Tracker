/**
 * Trendz Tracker — Memoriad Competition Stage Controller (js/memoriadPlay.js)
 *
 * Implements the 4-phase single-page competition flow on `/pages/memoriad-play.html?module=<key>`:
 * 1. Settings (persisted per module in `localStorage` inside `try/catch`)
 * 2. Concentration (fetches session via `POST /api/memoriad` `{ action: 'start' }`,
 *    keeps questions in JS memory only, displays large countdown from `concentration_seconds` to `0`)
 * 3. Stage (1280x800 no-scroll Memoriad-style board for calendar, additions, multiplications,
 *    division and square roots: big countdown timer, 2x5 question cards with the active card
 *    highlighted, enlarged active problem with step boxes and answer digit boxes,
 *    hide site navigation, Fullscreen button, Exit confirmation,
 *    keyboard shortcuts via `js/competitionKeys.js`, `js/calendarKeys.js`, `js/answerSlots.js`,
 *    and `js/columnHighlight.js`)
 * 4. Results (submits answers to `POST /api/memoriad` `{ action: 'submit' }`,
 *    preserves answers with "Try sending again" on network failure, displays score,
 *    used time with 2 decimals, correct/attempted, full question breakdown table).
 */

import { requireAuth } from './guard.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { keyAction } from './competitionKeys.js';
import { dayForKey, primaryKeyForDay } from './calendarKeys.js';
import {
  formatCalendarDate,
  formatDayLabel,
  getOrderedWeekdays,
  DAY_LABELS,
  DATE_FORMATS,
} from './memoriadFormat.js';
import {
  createAnswerSlots,
  typeDigit,
  moveCursorLeft,
  moveCursorRight,
  setCursor,
  backspace,
  compact,
  toAnswerString,
} from './answerSlots.js';
import { highlightedColumns, normalizeColumnsPerStep } from './columnHighlight.js';
import { fetchStudentEffectiveAccess, isMemoriadAllowed } from './studentAccess.js';
import {
  pressMultStepKey,
  getMultCheckedBoxes,
  getMultNextClickBoxIndex,
  clickMultStepBox,
  pressRootStepKey,
  getRootCheckedBoxes,
  clickRootStepBox,
} from './stepBoxes.js';
import { getMemoriadTimeLimit } from './memoriadConfig.js';
import {
  MULTIPLICATION_DIGITS_MIN,
  MULTIPLICATION_DIGITS_MAX,
  SQUARE_ROOT_DIGITS_MIN,
  SQUARE_ROOT_DIGITS_MAX,
  SQUARE_ROOT_DECIMALS,
  DIVISION_DIVIDEND_MIN,
  DIVISION_DIVIDEND_MAX,
  DIVISION_DIVISOR_MIN,
  DIVISION_DIVISOR_MAX,
  OFFICIAL_MULTIPLICATION_DIGITS,
  OFFICIAL_SQUARE_ROOT_DIGITS,
  OFFICIAL_DIVISION_LEVELS,
  normalizeMultiplicationDigits,
  normalizeSquareRootDigits,
  normalizeDivisionLevel,
  isValidDivisionLevel,
  normalizeLayout,
  squareRootIntegerDigits,
  getMemoriadLevelTimeLimit,
} from './memoriadGenerators.js';
import { getScoreFeedback } from './scoreColors.js';
import {
  parseTestRunnerQuery,
  RUNNER_EXIT_CONFIRM_TEXT,
} from './weeklyTestRunner.js';
import { submitHomeworkCompletion } from './homeworkData.js';
import { showToast } from './toast.js';

const STORAGE_PREFIX = 'trendz_memoriad_settings_v1_';

const DEFAULT_SETTINGS = {
  calendar: {
    day_style: 'upper3', // 'upper3' | 'short2' | 'full'
    leftmost_day: 0, // 0 = Monday .. 6 = Sunday
    key_zero_day: 5, // 5 = Saturday
    highlight_active: true,
    date_format: 'DD-MM-YYYY', // 'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD'
    dates: 125, // 25 | 50 | 75 | 100 | 125
    timer_shown: true,
    concentration_seconds: 5, // 0..120
  },
  additions: {
    typing_direction: 'rtl', // 'rtl' | 'ltr'
    highlight_columns: 1, // 1 | 2 | 3 | 4
    timer_shown: true,
    concentration_seconds: 5, // 0..120
  },
  multiplications: {
    typing_direction: 'rtl', // 'rtl' | 'ltr'
    digits: 8, // 3..10 digits per factor (official: 5 and 8)
    layout: 'vertical', // 'vertical' (stacked) | 'horizontal' (side by side)
    timer_shown: true,
    concentration_seconds: 5, // 0..120
  },
  division: {
    typing_direction: 'ltr', // quotients are usually written left to right
    dividend_digits: 10, // 4..10
    divisor_digits: 5, // 2..5, at most dividend - 2
    layout: 'vertical', // 'vertical' (long division) | 'horizontal' (a ÷ b)
    timer_shown: true,
    concentration_seconds: 5, // 0..120
  },
  square_roots: {
    digits: 6, // 4..10 digit radicands (official: 6, 8 and 10)
    timer_shown: true,
    concentration_seconds: 5, // 0..120
  },
};

const MODULE_META = {
  calendar: {
    key: 'calendar',
    title: 'Mental Calendar Dates',
    subtitle: 'Determine the weekday for Gregorian dates from 1600 to 2099.',
  },
  additions: {
    key: 'additions',
    title: 'Mental Additions',
    subtitle: 'Add ten 10-digit numbers across 10 competition questions.',
  },
  multiplications: {
    key: 'multiplications',
    title: 'Mental Multiplications',
    subtitle: 'Multiply two numbers of the same length (3 to 10 digits) across 10 questions.',
  },
  division: {
    key: 'division',
    title: 'Mental Division',
    subtitle: 'Divide 4- to 10-digit numbers by 2- to 5-digit numbers; every answer is exact.',
  },
  square_roots: {
    key: 'square_roots',
    title: 'Mental Square Roots',
    subtitle: 'Find the square root of 10 numbers (4 to 10 digits) to 5 decimal places.',
  },
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadModuleSettings(moduleKey) {
  const defaults = { ...(DEFAULT_SETTINGS[moduleKey] || {}) };
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${moduleKey}`);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const merged = { ...defaults, ...parsed };
    if (moduleKey === 'calendar' && !DATE_FORMATS.includes(merged.date_format)) {
      merged.date_format = 'DD-MM-YYYY';
    }
    return merged;
  } catch {
    return defaults;
  }
}

function saveModuleSettings(moduleKey, settings) {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${moduleKey}`, JSON.stringify(settings));
  } catch {
    // Ignore storage quota or private mode restrictions
  }
}

function formatTimerMMSS(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Controller State
let currentProfile = null;
let activeModuleKey = 'calendar';
let currentSettings = {};
let phase = 'settings'; // 'settings' | 'concentration' | 'stage' | 'results'
let activeTodoTaskId = null;
let memoriadAccessSettings = null;

// Weekly Test runner state (?test=<id>&section=<id>)
let isTestMode = false;
let activeTestId = null;
let activeSectionId = null;
let activeTestTitle = 'Weekly Test';

// Active Session State (held in JS memory; never rendered until Stage begins)
let sessionData = null; // { session_id, module, title, questions, settings }
let activeQuestionIndex = 0;
let calendarAnswers = []; // Array<number|null> (0..6 or null)
let additionsSlots = []; // Array<SlotState>
let additionsManualStepOffsets = []; // Array<number>
let numberBoardSlots = []; // Array<SlotState> for multiplications / division / square roots
let numberBoardSteps = []; // Array<number> step-box state per question
let stageStartPerfMs = 0;
let timerIntervalId = null;
let concentrationRafId = null;
let lastSubmissionResult = null;
let lastSubmissionError = null;
let lastFinishedBy = 'finish';
let isSubmitting = false;
let stageInputsLocked = false;

async function initMemoriadPlay() {
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;
  currentProfile = profile;

  renderHeaderUser(profile);
  if (isDemoMode()) {
    renderDemoBanner();
  }

  const runnerQuery = parseTestRunnerQuery(window.location.search);
  isTestMode = runnerQuery.isTestMode;
  activeTestId = runnerQuery.testId;
  activeSectionId = runnerQuery.sectionId;

  const params = new URLSearchParams(window.location.search);
  const requestedModule = (params.get('module') || 'calendar').trim().toLowerCase();
  const rawTaskId = params.get('todo_task_id') || params.get('todo_task');
  activeTodoTaskId = rawTaskId && typeof rawTaskId === 'string' ? rawTaskId.trim() : null;

  if (isTestMode) {
    const appHeader = document.querySelector('.app-header');
    if (appHeader) appHeader.style.display = 'none';

    const narrowTitle = document.getElementById('memoriad-narrow-guard-title');
    const narrowBack = document.getElementById('memoriad-narrow-guard-back');
    if (narrowTitle) {
      narrowTitle.textContent =
        'Use a laptop or desktop with a keyboard for this test section';
    }
    if (narrowBack) {
      narrowBack.href = '/pages/weekly-test.html';
      narrowBack.textContent = '← Back to Weekly Test';
    }

    // Check screen width BEFORE calling start so a phone does not consume the single attempt!
    if (window.innerWidth < 1000) {
      return;
    }

    if (MODULE_META[requestedModule]) {
      activeModuleKey = requestedModule;
    }
    currentSettings = {
      ...loadModuleSettings(activeModuleKey),
      dates: 125,
      typing_direction: 'rtl',
      highlight_columns: 1,
      timer_shown: true,
      concentration_seconds: 5,
    };

    window.addEventListener('keydown', handleGlobalStageKeydown);
    window.addEventListener('beforeunload', (e) => {
      if (isTestMode && (phase === 'concentration' || phase === 'stage')) {
        e.preventDefault();
        e.returnValue = RUNNER_EXIT_CONFIRM_TEXT;
        return e.returnValue;
      }
    });

    await startTestMemoriadSection();
    return;
  }

  if (!MODULE_META[requestedModule]) {
    renderUnsupportedModule(requestedModule);
    return;
  }

  activeModuleKey = requestedModule;
  currentSettings = loadModuleSettings(activeModuleKey);

  const hasAssignmentException = Boolean(activeTodoTaskId) || Boolean(params.get('homework_id'));
  if (currentProfile?.role === 'student' && !isTestMode && !hasAssignmentException) {
    try {
      const isDemo = isDemoMode();
      const supabase = isSupabaseConfigured() ? await getSupabase() : null;
      const accessRes = await fetchStudentEffectiveAccess(currentProfile.id, { supabase, isDemo, DemoDB });
      if (accessRes?.ok) {
        memoriadAccessSettings = accessRes.settings?.memoriad || null;
      }
    } catch {
      // Non-blocking fallback
    }
  }

  window.addEventListener('keydown', handleGlobalStageKeydown);
  if (activeTodoTaskId) {
    startAssignedMemoriadPractice();
  } else {
    renderSettingsView();
  }
}

function renderUnsupportedModule(moduleKey) {
  const root = document.getElementById('memoriad-view-root');
  if (!root) return;
  const backHref = activeTodoTaskId ? '/pages/student.html' : '/pages/memoriad.html';
  const backLabel = activeTodoTaskId ? 'Back to Daily Tasks' : 'Back to Memoriad';
  root.innerHTML = `
    <div class="card" style="max-width: 580px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
      <h1 style="font-size: 1.35rem; margin-bottom: var(--space-2);">Module Not Available</h1>
      <p style="font-size: var(--text-sm); color: var(--text-muted); margin-bottom: var(--space-4);">
        The module <code>${escapeHtml(moduleKey)}</code> is coming in a later step.
      </p>
      <a href="${backHref}" class="btn btn-primary" style="text-decoration: none;">
        &larr; ${backLabel}
      </a>
    </div>
  `;
}

/* ============================================================================
 * 1. SETTINGS PHASE
 * ========================================================================== */

function buildKeyZeroNote(keyZeroDayIndex) {
  const parts = [];
  for (let k = 0; k <= 7; k++) {
    const dayIdx = dayForKey(k, keyZeroDayIndex);
    parts.push(`${k} → ${DAY_LABELS.full[dayIdx]}`);
  }
  return parts.join(', ');
}

async function startAssignedMemoriadPractice() {
  stopAllTimers();
  phase = 'settings';
  document.body.classList.remove('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  const viewRoot = document.getElementById('memoriad-view-root');
  if (normalContainer) normalContainer.style.display = 'block';
  if (stageRoot) {
    stageRoot.style.display = 'none';
    stageRoot.innerHTML = '';
  }

  const meta = MODULE_META[activeModuleKey] || { title: 'Competition Practice' };
  if (viewRoot) {
    viewRoot.innerHTML = `
      <div class="card" style="max-width: 580px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
        <div class="banner banner-info" style="margin-bottom: var(--space-4);">
          <span class="banner-icon" aria-hidden="true">⏱️</span>
          <div class="banner-body">
            <strong>Daily Task:</strong> Launching assigned ${escapeHtml(meta.title)} with locked settings...
          </div>
        </div>
        <div style="font-size: var(--text-sm); color: var(--text-muted); margin-top: var(--space-3);">
          Preparing questions and countdown...
        </div>
      </div>
    `;
  }

  try {
    const started = await callMemoriadApi({
      action: 'start',
      module: activeModuleKey,
      settings: {
        concentration_seconds: 5,
        ...(activeModuleKey === 'calendar' ? { dates: 125 } : {}),
      },
      todo_task_id: activeTodoTaskId,
    });

    sessionData = started;
    const authoritativeLimit = Number(
      started.duration_seconds ||
      started.time_limit_seconds ||
      started.settings?.duration_seconds ||
      started.settings?.time_limit_seconds
    );
    const concentrationSec = Number(
      started.concentration_seconds ??
      started.prep_seconds ??
      started.settings?.concentration_seconds ??
      5
    );

    currentSettings = {
      ...currentSettings,
      ...(started.settings || {}),
      time_limit_seconds: authoritativeLimit,
      duration_seconds: authoritativeLimit,
      concentration_seconds: concentrationSec,
    };

    activeQuestionIndex = 0;
    lastSubmissionResult = null;
    lastSubmissionError = null;
    lastFinishedBy = 'finish';
    stageInputsLocked = false;

    initStageAnswerState(started.questions);

    if (concentrationSec > 0) {
      enterConcentrationPhase(concentrationSec);
    } else {
      enterStagePhase();
    }
  } catch (err) {
    if (viewRoot) {
      viewRoot.innerHTML = `
        <div class="card" style="max-width: 580px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
          <div class="banner banner-error" style="margin-bottom: var(--space-4);">
            <span class="banner-icon" aria-hidden="true">⚠️</span>
            <div class="banner-body">
              <strong>Cannot Start Assigned Task:</strong> ${escapeHtml(err?.message || 'Could not start the practice round.')}
            </div>
          </div>
          <div style="display: flex; justify-content: center; gap: var(--space-3); margin-top: var(--space-4);">
            <button type="button" id="btn-assigned-retry" class="btn btn-primary">Try Again</button>
            <a href="/pages/student.html" class="btn btn-outline" style="text-decoration: none;">Back to Daily Tasks</a>
          </div>
        </div>
      `;
      document.getElementById('btn-assigned-retry')?.addEventListener('click', () => {
        startAssignedMemoriadPractice();
      });
    }
  }
}

function rangeList(min, max) {
  const out = [];
  for (let n = min; n <= max; n++) out.push(n);
  return out;
}

function buildDivisorOptions(dividendDigits, selectedDivisor) {
  const valid = rangeList(DIVISION_DIVISOR_MIN, DIVISION_DIVISOR_MAX).filter((d) =>
    isValidDivisionLevel(dividendDigits, d)
  );
  const selected = valid.includes(Number(selectedDivisor)) ? Number(selectedDivisor) : valid[valid.length - 1];
  return valid
    .map((d) => {
      const official = OFFICIAL_DIVISION_LEVELS.includes(`${dividendDigits}/${d}`) ? ' · official' : '';
      return `<option value="${d}" ${selected === d ? 'selected' : ''}>${d}-digit divisor (${dividendDigits}d ÷ ${d}d)${official}</option>`;
    })
    .join('');
}

function readDivisionLevelFromForm() {
  return {
    dividend_digits: Number(document.getElementById('setting-dividend-digits')?.value),
    divisor_digits: Number(document.getElementById('setting-divisor-digits')?.value),
  };
}

/** Level fields sent to `POST /api/memoriad` `{ action: 'start' }`. */
function pickLevelSettings(moduleKey, settings = {}) {
  if (moduleKey === 'multiplications') {
    return {
      digits: normalizeMultiplicationDigits(settings.digits),
      layout: normalizeLayout(settings.layout),
    };
  }
  if (moduleKey === 'division') {
    return {
      ...normalizeDivisionLevel(settings.dividend_digits, settings.divisor_digits),
      layout: normalizeLayout(settings.layout),
    };
  }
  if (moduleKey === 'square_roots') {
    return { digits: normalizeSquareRootDigits(settings.digits) };
  }
  return {};
}

function formatMinutesText(totalSeconds) {
  const sec = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (m === 0) return `${r} seconds`;
  const minText = `${m} minute${m === 1 ? '' : 's'}`;
  return r ? `${minText} ${r} seconds` : minText;
}

function describeTimeLimitText(moduleKey, settings = {}) {
  const limit = getMemoriadLevelTimeLimit(moduleKey, settings) ?? getMemoriadTimeLimit(moduleKey);
  return `Time limit: ${formatMinutesText(limit)}`;
}

function isOfficialLevel(moduleKey, settings = {}) {
  if (moduleKey === 'multiplications') {
    return OFFICIAL_MULTIPLICATION_DIGITS.includes(normalizeMultiplicationDigits(settings.digits));
  }
  if (moduleKey === 'square_roots') {
    return OFFICIAL_SQUARE_ROOT_DIGITS.includes(normalizeSquareRootDigits(settings.digits));
  }
  if (moduleKey === 'division') {
    const lv = normalizeDivisionLevel(settings.dividend_digits, settings.divisor_digits);
    return OFFICIAL_DIVISION_LEVELS.includes(`${lv.dividend_digits}/${lv.divisor_digits}`);
  }
  return true;
}

function describeTimeLimitHint(moduleKey, settings = {}) {
  if (moduleKey === 'calendar' || moduleKey === 'additions') {
    return 'Fixed official competition round duration.';
  }
  return isOfficialLevel(moduleKey, settings)
    ? 'Official Memoriad time for this level.'
    : 'Practice level: time scaled from the official levels.';
}

/** Keeps the divisor list and the time-limit text in step with the chosen level. */
function bindLevelSettingsListeners() {
  const readLevel = () => {
    if (activeModuleKey === 'multiplications') {
      return { digits: document.getElementById('setting-mult-digits')?.value };
    }
    if (activeModuleKey === 'division') return readDivisionLevelFromForm();
    if (activeModuleKey === 'square_roots') {
      return { digits: document.getElementById('setting-root-digits')?.value };
    }
    return {};
  };
  const refresh = () => {
    const level = readLevel();
    const textEl = document.getElementById('setting-time-limit-text');
    const hintEl = document.getElementById('setting-time-limit-hint');
    if (textEl) textEl.textContent = describeTimeLimitText(activeModuleKey, level);
    if (hintEl) hintEl.textContent = describeTimeLimitHint(activeModuleKey, level);
  };
  ['setting-mult-digits', 'setting-root-digits', 'setting-divisor-digits'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', refresh);
  });
  const dividendSelect = document.getElementById('setting-dividend-digits');
  dividendSelect?.addEventListener('change', () => {
    const divisorSelect = document.getElementById('setting-divisor-digits');
    if (divisorSelect) {
      divisorSelect.innerHTML = buildDivisorOptions(Number(dividendSelect.value), Number(divisorSelect.value));
    }
    refresh();
  });
}

function renderSettingsView() {
  if (activeTodoTaskId) {
    startAssignedMemoriadPractice();
    return;
  }
  stopAllTimers();
  phase = 'settings';
  document.body.classList.remove('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  const viewRoot = document.getElementById('memoriad-view-root');
  if (normalContainer) normalContainer.style.display = 'block';
  if (stageRoot) {
    stageRoot.style.display = 'none';
    stageRoot.innerHTML = '';
  }
  if (!viewRoot) return;

  const meta = MODULE_META[activeModuleKey];

  if (memoriadAccessSettings && !isMemoriadAllowed(activeModuleKey, null, memoriadAccessSettings)) {
    viewRoot.innerHTML = `
      <div style="max-width: 680px; margin: var(--space-6) auto; padding: 0 var(--space-4);">
        <div class="card" style="padding: var(--space-6); text-align: center;">
          <h1 style="font-size: 1.35rem; margin-bottom: var(--space-2);">${escapeHtml(meta.title)}</h1>
          <div class="banner banner-error" style="margin-bottom: var(--space-4);">
            This competition module is not permitted for your current practice access.
          </div>
          <a href="/pages/memoriad.html" class="btn btn-primary" style="text-decoration: none;">
            &larr; Back to Memoriad
          </a>
        </div>
      </div>
    `;
    return;
  }

  const dayOptionsHtml = (selectedIdx) =>
    DAY_LABELS.full
      .map(
        (name, idx) =>
          `<option value="${idx}" ${Number(selectedIdx) === idx ? 'selected' : ''}>${escapeHtml(name)}</option>`
      )
      .join('');

  let moduleSpecificFieldsHtml = '';

  if (activeModuleKey === 'calendar') {
    const s = currentSettings;
    const allowedDates = memoriadAccessSettings && memoriadAccessSettings.all === false && Array.isArray(memoriadAccessSettings.calendar_variants) && memoriadAccessSettings.calendar_variants.length > 0
      ? memoriadAccessSettings.calendar_variants
      : [25, 50, 75, 100, 125];
    if (!allowedDates.includes(Number(s.dates))) {
      s.dates = allowedDates[0];
    }
    moduleSpecificFieldsHtml = `
      <div class="memoriad-settings-grid">
        <div class="form-group">
          <label for="setting-dates" class="form-label">Number of dates</label>
          <select id="setting-dates" class="form-control">
            ${allowedDates
              .map(
                (n) =>
                  `<option value="${n}" ${Number(s.dates) === n ? 'selected' : ''}>${n} dates</option>`
              )
              .join('')}
          </select>
        </div>

        <div class="form-group">
          <label for="setting-date-format" class="form-label">Question date format</label>
          <select id="setting-date-format" class="form-control">
            <option value="DD-MM-YYYY" ${!s.date_format || s.date_format === 'DD-MM-YYYY' ? 'selected' : ''}>DD-MM-YYYY (e.g. 24-11-1873)</option>
            <option value="MM-DD-YYYY" ${s.date_format === 'MM-DD-YYYY' ? 'selected' : ''}>MM-DD-YYYY (e.g. 11-24-1873)</option>
            <option value="YYYY-MM-DD" ${s.date_format === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD (e.g. 1873-11-24)</option>
            <option value="DD Mon YYYY" ${s.date_format === 'DD Mon YYYY' ? 'selected' : ''}>DD Mon YYYY (e.g. 24 Nov 1873)</option>
            <option value="DD-Mon-YYYY" ${s.date_format === 'DD-Mon-YYYY' ? 'selected' : ''}>DD-Mon-YYYY (e.g. 24-Nov-1873)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-day-style" class="form-label">Day abbreviation style</label>
          <select id="setting-day-style" class="form-control">
            <option value="upper3" ${s.day_style === 'upper3' ? 'selected' : ''}>MON - TUE - WED - THU - FRI - SAT - SUN</option>
            <option value="short2" ${s.day_style === 'short2' ? 'selected' : ''}>Mo - Tu - We - Th - Fr - Sa - Su</option>
            <option value="full" ${s.day_style === 'full' ? 'selected' : ''}>Full names (Monday .. Sunday)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-leftmost-day" class="form-label">Leftmost day button</label>
          <select id="setting-leftmost-day" class="form-control">
            ${dayOptionsHtml(s.leftmost_day)}
          </select>
        </div>

        <div class="form-group" style="grid-column: 1 / -1;">
          <label for="setting-key-zero-day" class="form-label">Day that key <code>0</code> stands for</label>
          <select id="setting-key-zero-day" class="form-control" style="max-width: 320px;">
            ${dayOptionsHtml(s.key_zero_day)}
          </select>
          <div
            id="key-zero-mapping-preview"
            class="num"
            style="margin-top: 6px; padding: 8px 10px; background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm); font-size: var(--text-xs); color: var(--text-muted);"
          >
            ${escapeHtml(buildKeyZeroNote(Number(s.key_zero_day)))}
          </div>
        </div>

        <div class="form-group">
          <label for="setting-highlight-active" class="form-label">Highlight active question</label>
          <select id="setting-highlight-active" class="form-control">
            <option value="yes" ${s.highlight_active !== false ? 'selected' : ''}>Yes (Recommended)</option>
            <option value="no" ${s.highlight_active === false ? 'selected' : ''}>No</option>
          </select>
        </div>
      </div>
    `;
  } else if (activeModuleKey === 'additions') {
    const s = currentSettings;
    moduleSpecificFieldsHtml = `
      <div class="memoriad-settings-grid">
        <div class="form-group">
          <label for="setting-typing-direction" class="form-label">Typing direction</label>
          <select id="setting-typing-direction" class="form-control">
            <option value="rtl" ${s.typing_direction !== 'ltr' ? 'selected' : ''}>Right to left (ones column first — default)</option>
            <option value="ltr" ${s.typing_direction === 'ltr' ? 'selected' : ''}>Left to right (leftmost column first)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-highlight-columns" class="form-label">Number of columns to be highlighted</label>
          <select id="setting-highlight-columns" class="form-control">
            ${[1, 2, 3, 4]
              .map(
                (g) =>
                  `<option value="${g}" ${normalizeColumnsPerStep(s.highlight_columns) === g ? 'selected' : ''}>${g} ${g === 1 ? 'column (default)' : 'columns'}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
    `;
  } else if (activeModuleKey === 'multiplications') {
    const s = currentSettings;
    const multDigits = normalizeMultiplicationDigits(s.digits);
    const multDigitOptions = rangeList(MULTIPLICATION_DIGITS_MIN, MULTIPLICATION_DIGITS_MAX)
      .map((n) => {
        const official = OFFICIAL_MULTIPLICATION_DIGITS.includes(n) ? ' · official' : '';
        return `<option value="${n}" ${multDigits === n ? 'selected' : ''}>${n}d × ${n}d${official}</option>`;
      })
      .join('');
    moduleSpecificFieldsHtml = `
      <div class="memoriad-settings-grid">
        <div class="form-group">
          <label for="setting-mult-digits" class="form-label">Level (digits per number)</label>
          <select id="setting-mult-digits" class="form-control">
            ${multDigitOptions}
          </select>
          <span class="form-hint">Official Memoriad levels are 5d × 5d and 8d × 8d.</span>
        </div>

        <div class="form-group">
          <label for="setting-layout" class="form-label">Question layout</label>
          <select id="setting-layout" class="form-control">
            <option value="vertical" ${normalizeLayout(s.layout) === 'vertical' ? 'selected' : ''}>Vertical (numbers stacked)</option>
            <option value="horizontal" ${normalizeLayout(s.layout) === 'horizontal' ? 'selected' : ''}>Horizontal (side by side)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-typing-direction" class="form-label">Typing direction</label>
          <select id="setting-typing-direction" class="form-control">
            <option value="rtl" ${s.typing_direction !== 'ltr' ? 'selected' : ''}>Right to left (ones column first — default)</option>
            <option value="ltr" ${s.typing_direction === 'ltr' ? 'selected' : ''}>Left to right (leftmost column first)</option>
          </select>
        </div>
      </div>
    `;
  } else if (activeModuleKey === 'division') {
    const s = currentSettings;
    const level = normalizeDivisionLevel(s.dividend_digits, s.divisor_digits);
    s.dividend_digits = level.dividend_digits;
    s.divisor_digits = level.divisor_digits;
    const dividendOptions = rangeList(DIVISION_DIVIDEND_MIN, DIVISION_DIVIDEND_MAX)
      .map(
        (n) =>
          `<option value="${n}" ${level.dividend_digits === n ? 'selected' : ''}>${n}-digit dividend</option>`
      )
      .join('');
    moduleSpecificFieldsHtml = `
      <div class="memoriad-settings-grid">
        <div class="form-group">
          <label for="setting-dividend-digits" class="form-label">Dividend (number being divided)</label>
          <select id="setting-dividend-digits" class="form-control">
            ${dividendOptions}
          </select>
        </div>

        <div class="form-group">
          <label for="setting-divisor-digits" class="form-label">Divisor</label>
          <select id="setting-divisor-digits" class="form-control">
            ${buildDivisorOptions(level.dividend_digits, level.divisor_digits)}
          </select>
          <span class="form-hint">Official Memoriad level is 10d ÷ 5d. Every answer is a whole number.</span>
        </div>

        <div class="form-group">
          <label for="setting-layout" class="form-label">Question layout</label>
          <select id="setting-layout" class="form-control">
            <option value="vertical" ${normalizeLayout(s.layout) === 'vertical' ? 'selected' : ''}>Vertical (long division)</option>
            <option value="horizontal" ${normalizeLayout(s.layout) === 'horizontal' ? 'selected' : ''}>Horizontal (a ÷ b)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-typing-direction" class="form-label">Typing direction</label>
          <select id="setting-typing-direction" class="form-control">
            <option value="ltr" ${s.typing_direction !== 'rtl' ? 'selected' : ''}>Left to right (default for division)</option>
            <option value="rtl" ${s.typing_direction === 'rtl' ? 'selected' : ''}>Right to left</option>
          </select>
        </div>
      </div>
    `;
  } else {
    const s = currentSettings;
    const digits = normalizeSquareRootDigits(s.digits);
    const rootOptions = rangeList(SQUARE_ROOT_DIGITS_MIN, SQUARE_ROOT_DIGITS_MAX)
      .map((n) => {
        const official = OFFICIAL_SQUARE_ROOT_DIGITS.includes(n) ? ' · official' : '';
        return `<option value="${n}" ${digits === n ? 'selected' : ''}>${n}-digit numbers${official}</option>`;
      })
      .join('');
    moduleSpecificFieldsHtml = `
      <div class="memoriad-settings-grid">
        <div class="form-group">
          <label for="setting-root-digits" class="form-label">Level (digits under the root)</label>
          <select id="setting-root-digits" class="form-control">
            ${rootOptions}
          </select>
          <span class="form-hint">Answer to 5 decimal places. Official Memoriad levels are 6, 8 and 10 digits.</span>
        </div>
      </div>
    `;
  }

  const fixedTimeLimitText = describeTimeLimitText(activeModuleKey, currentSettings);

  viewRoot.innerHTML = `
    <div style="max-width: 780px; margin: 0 auto;">
      <div style="margin-bottom: var(--space-4);">
        <a href="/pages/memoriad.html" style="font-size: var(--text-xs); font-weight: 600; color: var(--color-primary); text-decoration: none;">
          &larr; Back to Memoriad Modules
        </a>
      </div>

      <section class="card" style="padding: var(--space-6);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-4); border-bottom: 1px solid var(--border-hairline); padding-bottom: var(--space-4);">
          <div>
            <span class="badge badge-role" style="margin-bottom: 6px;">Competition Setup</span>
            <h1 style="font-size: 1.5rem; margin: 0 0 4px 0;">${escapeHtml(meta.title)}</h1>
            <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
              ${escapeHtml(meta.subtitle)}
            </p>
          </div>
        </div>

        ${
          activeTodoTaskId
            ? `
          <div class="card" style="border-left: 4px solid var(--color-primary); background: rgba(59, 130, 246, 0.08); padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4);">
            <div style="font-weight: 600; color: var(--color-primary); display: flex; align-items: center; gap: var(--space-2);">
              <span>📋</span> Assigned Daily Task
            </div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 2px;">
              This try will count toward your assigned daily task for ${escapeHtml(meta.title)}.
            </div>
          </div>
        `
            : ''
        }

        <form id="memoriad-settings-form">
          ${moduleSpecificFieldsHtml}

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border-hairline);">
            <div class="form-group">
              <span class="form-label">Round time limit</span>
              <div
                id="setting-time-limit-text"
                class="num"
                style="padding: 9px 12px; background: var(--bg-surface-subtle); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font-weight: 800; color: var(--text-main);"
              >
                ${escapeHtml(fixedTimeLimitText)}
              </div>
              <span id="setting-time-limit-hint" class="form-hint">${escapeHtml(describeTimeLimitHint(activeModuleKey, currentSettings))}</span>
            </div>

            <div class="form-group">
              <label for="setting-timer-shown" class="form-label">Show timer during stage</label>
              <select id="setting-timer-shown" class="form-control">
                <option value="yes" ${currentSettings.timer_shown !== false ? 'selected' : ''}>Yes (default)</option>
                <option value="no" ${currentSettings.timer_shown === false ? 'selected' : ''}>No (hide stopwatch display)</option>
              </select>
            </div>

            <div class="form-group">
              <label for="setting-concentration" class="form-label">Concentration countdown (0 to 120 seconds)</label>
              <input
                type="number"
                id="setting-concentration"
                class="form-control num"
                min="0"
                max="120"
                step="1"
                value="${Number.isInteger(currentSettings.concentration_seconds) ? currentSettings.concentration_seconds : 5}"
                required
              />
              <span class="form-hint">Questions appear automatically when the concentration countdown finishes.</span>
            </div>
          </div>

          <div id="settings-error-box" style="display: none; margin-top: var(--space-3); padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-danger-subtle); color: var(--color-danger); font-size: var(--text-xs); font-weight: 600;"></div>

          <div style="margin-top: var(--space-5); display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
            <a href="/pages/memoriad.html" class="btn btn-outline" style="text-decoration: none;">
              Cancel
            </a>
            <button type="submit" id="btn-start-memoriad" class="btn btn-primary">
              Start Competition Stage &rarr;
            </button>
          </div>
        </form>
      </section>
    </div>
  `;

  bindLevelSettingsListeners();

  if (activeModuleKey === 'calendar') {
    const keyZeroSelect = document.getElementById('setting-key-zero-day');
    const previewEl = document.getElementById('key-zero-mapping-preview');
    keyZeroSelect?.addEventListener('change', () => {
      if (previewEl) {
        previewEl.textContent = buildKeyZeroNote(Number(keyZeroSelect.value));
      }
    });
  }

  const form = document.getElementById('memoriad-settings-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleStartFromSettings();
  });
}

async function handleStartFromSettings() {
  const errBox = document.getElementById('settings-error-box');
  const startBtn = document.getElementById('btn-start-memoriad');
  if (errBox) errBox.style.display = 'none';

  const concInput = document.getElementById('setting-concentration');
  const concVal = Number(concInput?.value);
  if (!Number.isInteger(concVal) || concVal < 0 || concVal > 120) {
    if (errBox) {
      errBox.textContent = 'Concentration time must be a whole number between 0 and 120 seconds.';
      errBox.style.display = 'block';
    }
    return;
  }

  const timerShown = document.getElementById('setting-timer-shown')?.value !== 'no';

  if (activeModuleKey === 'calendar') {
    currentSettings = {
      dates: Number(document.getElementById('setting-dates')?.value) || 125,
      date_format: document.getElementById('setting-date-format')?.value || 'DD-MM-YYYY',
      day_style: document.getElementById('setting-day-style')?.value || 'upper3',
      leftmost_day: Number(document.getElementById('setting-leftmost-day')?.value) || 0,
      key_zero_day: Number(document.getElementById('setting-key-zero-day')?.value ?? 5),
      highlight_active: document.getElementById('setting-highlight-active')?.value !== 'no',
      timer_shown: timerShown,
      concentration_seconds: concVal,
    };
  } else if (activeModuleKey === 'additions') {
    currentSettings = {
      typing_direction:
        document.getElementById('setting-typing-direction')?.value === 'ltr' ? 'ltr' : 'rtl',
      highlight_columns: normalizeColumnsPerStep(
        document.getElementById('setting-highlight-columns')?.value
      ),
      timer_shown: timerShown,
      concentration_seconds: concVal,
    };
  } else if (activeModuleKey === 'multiplications') {
    currentSettings = {
      typing_direction:
        document.getElementById('setting-typing-direction')?.value === 'ltr' ? 'ltr' : 'rtl',
      digits: normalizeMultiplicationDigits(document.getElementById('setting-mult-digits')?.value),
      layout: normalizeLayout(document.getElementById('setting-layout')?.value),
      timer_shown: timerShown,
      concentration_seconds: concVal,
    };
  } else if (activeModuleKey === 'division') {
    const level = readDivisionLevelFromForm();
    if (!isValidDivisionLevel(level.dividend_digits, level.divisor_digits)) {
      if (errBox) {
        errBox.textContent = 'Choose a divisor that is at least 2 digits shorter than the dividend.';
        errBox.style.display = 'block';
      }
      return;
    }
    currentSettings = {
      typing_direction:
        document.getElementById('setting-typing-direction')?.value === 'rtl' ? 'rtl' : 'ltr',
      dividend_digits: level.dividend_digits,
      divisor_digits: level.divisor_digits,
      layout: normalizeLayout(document.getElementById('setting-layout')?.value),
      timer_shown: timerShown,
      concentration_seconds: concVal,
    };
  } else {
    currentSettings = {
      digits: normalizeSquareRootDigits(document.getElementById('setting-root-digits')?.value),
      timer_shown: timerShown,
      concentration_seconds: concVal,
    };
  }

  saveModuleSettings(activeModuleKey, currentSettings);

  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = 'Preparing stage...';
  }

  try {
    const urlParams = new URLSearchParams(window.location.search);
    const hwIdFromUrl = urlParams.get('homework_id');
    const apiSettings = {
      concentration_seconds: currentSettings.concentration_seconds,
      ...(activeModuleKey === 'calendar' ? { dates: currentSettings.dates } : {}),
      ...pickLevelSettings(activeModuleKey, currentSettings),
      ...(hwIdFromUrl ? { homework_id: hwIdFromUrl } : {}),
    };

    const started = await callMemoriadApi({
      action: 'start',
      module: activeModuleKey,
      settings: apiSettings,
      todo_task_id: activeTodoTaskId || undefined,
      ...(hwIdFromUrl ? { homework_id: hwIdFromUrl } : {}),
    });

    // Store questions in JS memory only; do not render them until Concentration finishes
    sessionData = started;
    activeQuestionIndex = 0;
    lastSubmissionResult = null;
    lastSubmissionError = null;
    lastFinishedBy = 'finish';
    stageInputsLocked = false;

    initStageAnswerState(started.questions);

    if (currentSettings.concentration_seconds > 0) {
      enterConcentrationPhase(currentSettings.concentration_seconds);
    } else {
      enterStagePhase();
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err?.message || 'Could not start the practice round. Please try again.';
      errBox.style.display = 'block';
    }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start Competition Stage →';
    }
  }
}

async function startTestMemoriadSection() {
  const viewRoot = document.getElementById('memoriad-view-root');
  if (viewRoot) {
    viewRoot.innerHTML = `
      <div class="card" style="max-width: 560px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
        <div class="loading-state">Starting weekly test Memoriad section...</div>
      </div>
    `;
  }

  try {
    const started = await callMemoriadApi({
      action: 'start',
      test_id: activeTestId,
      section_id: activeSectionId,
    });

    if (started.module && MODULE_META[started.module]) {
      activeModuleKey = started.module;
    }
    activeTestTitle = started.title || activeTestTitle;
    currentSettings = {
      ...loadModuleSettings(activeModuleKey),
      dates: 125,
      typing_direction: 'rtl',
      highlight_columns: 1,
      timer_shown: true,
      concentration_seconds: 5,
    };

    sessionData = {
      ...started,
      title: started.module_title || MODULE_META[activeModuleKey]?.title || 'Memoriad',
    };
    activeQuestionIndex = 0;
    lastSubmissionResult = null;
    lastSubmissionError = null;
    lastFinishedBy = 'finish';
    stageInputsLocked = false;

    initStageAnswerState(started.questions, { typing_direction: 'rtl', highlight_columns: 1 });

    enterConcentrationPhase(5);
  } catch (err) {
    if (viewRoot) {
      viewRoot.innerHTML = `
        <div class="card" style="max-width: 620px; margin: var(--space-6) auto; padding: var(--space-6);">
          <h1 style="font-size: 1.35rem; margin-bottom: var(--space-2); color: var(--color-danger);">
            Cannot Start Section
          </h1>
          <p style="font-size: var(--text-sm); color: var(--text-main); margin-bottom: var(--space-4);">
            ${escapeHtml(err?.message || 'Could not start this weekly test section.')}
          </p>
          <a href="/pages/weekly-test.html" class="btn btn-primary" style="text-decoration: none;">
            &larr; Back to Weekly Test
          </a>
        </div>
      `;
    }
  }
}

/* ============================================================================
 * 2. CONCENTRATION PHASE
 * ========================================================================== */

function enterConcentrationPhase(seconds) {
  stopAllTimers();
  phase = 'concentration';
  document.body.classList.add('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  if (normalContainer) normalContainer.style.display = 'none';
  if (!stageRoot) return;
  stageRoot.style.display = 'block';

  const meta = MODULE_META[activeModuleKey];

  stageRoot.innerHTML = `
    <div class="comp-stage-shell">
      <div class="comp-stage-topbar">
        <div style="display: flex; align-items: center; gap: var(--space-3);">
          <span class="badge badge-role">Concentration</span>
          <strong style="font-size: var(--text-base); color: var(--text-main);">${escapeHtml(meta.title)}</strong>
          ${activeTodoTaskId ? `<span class="badge badge-info" style="font-weight: 700;">Daily Task &middot; ${getActiveStageLimitSeconds()}s (Locked)</span>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <button type="button" id="btn-stage-fullscreen" class="btn btn-outline btn-sm">
            Full Screen
          </button>
          <button type="button" id="btn-stage-exit" class="btn btn-outline btn-sm">
            Exit
          </button>
        </div>
      </div>

      <div class="comp-stage-body">
        <div class="comp-concentration-screen">
          <div style="font-size: var(--text-sm); font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted);">
            Concentration Time
          </div>
          <div id="concentration-countdown-num" class="comp-concentration-digits">
            ${seconds}
          </div>
          <p style="font-size: var(--text-base); color: var(--text-muted); max-width: 460px; margin: 0;">
            Get ready &mdash; questions will appear automatically when the countdown reaches 0.
          </p>
        </div>
      </div>
    </div>
  `;

  bindStageChromeButtons();

  const startMs = performance.now();
  const durationMs = seconds * 1000;
  const numEl = document.getElementById('concentration-countdown-num');

  function tick(nowMs) {
    if (phase !== 'concentration') return;
    const remainingMs = durationMs - (nowMs - startMs);
    if (remainingMs <= 0) {
      enterStagePhase();
      return;
    }
    const displaySec = Math.ceil(remainingMs / 1000);
    if (numEl) numEl.textContent = String(displaySec);
    concentrationRafId = window.requestAnimationFrame(tick);
  }

  concentrationRafId = window.requestAnimationFrame(tick);
}

/* ============================================================================
 * 3. STAGE PHASE (1280x800 Competition Stage)
 * ========================================================================== */

function getActiveStageLimitSeconds() {
  const fromSession = Number(sessionData?.time_limit_seconds);
  if (Number.isFinite(fromSession) && fromSession > 0) {
    return fromSession;
  }
  return getMemoriadTimeLimit(activeModuleKey, { ...(currentSettings || {}), ...(sessionData?.settings || {}) });
}

function enterStagePhase() {
  stopAllTimers();
  phase = 'stage';
  stageInputsLocked = false;
  document.body.classList.add('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  if (normalContainer) normalContainer.style.display = 'none';
  if (!stageRoot) return;
  stageRoot.style.display = 'block';

  stageStartPerfMs = performance.now();
  const limitSeconds = getActiveStageLimitSeconds();

  if (activeModuleKey === 'calendar') {
    renderCalendarStageShell(stageRoot, limitSeconds);
    updateCalendarStageDOM();
  } else if (activeModuleKey === 'additions') {
    renderAdditionsStageShell(stageRoot, limitSeconds);
    updateAdditionsStageDOM();
  } else {
    renderNumberBoardStageShell(stageRoot, limitSeconds);
    updateNumberBoardStageDOM();
  }

  bindStageChromeButtons();

  // Countdown timer & time-limit enforcement (checked every 100ms via performance.now())
  timerIntervalId = window.setInterval(() => {
    if (phase !== 'stage' || stageInputsLocked) return;
    const elapsedSec = (performance.now() - stageStartPerfMs) / 1000;
    const remainingSec = limitSeconds - elapsedSec;

    if (remainingSec <= 0) {
      // Time limit reached: stop immediately, lock inputs, keep every answer given so far, and submit with 'time_up'
      stageInputsLocked = true;
      stopAllTimers();
      const timerEl = document.getElementById('comp-stage-timer');
      if (timerEl && currentSettings.timer_shown !== false) {
        timerEl.textContent = formatTimerMMSS(0);
      }
      const existingModal = document.getElementById('comp-stage-inline-modal');
      if (existingModal) existingModal.remove();
      submitCurrentSession('time_up');
      return;
    }

    const timerEl = document.getElementById('comp-stage-timer');
    if (timerEl && currentSettings.timer_shown !== false) {
      timerEl.textContent = formatTimerMMSS(Math.ceil(remainingSec));
      timerEl.classList.toggle('is-ending', remainingSec <= 10);
    }

    // In the last 10 seconds show a clear countdown notice (text + visual cue, even when timer is hidden)
    const last10El = document.getElementById('comp-stage-last10');
    const last10SecEl = document.getElementById('comp-stage-last10-sec');
    if (last10El) {
      if (remainingSec <= 10) {
        const wholeLeft = Math.max(1, Math.ceil(remainingSec));
        if (last10SecEl) {
          last10SecEl.textContent = `${wholeLeft}s left`;
        }
        last10El.classList.add('is-visible');
      } else {
        last10El.classList.remove('is-visible');
      }
    }
  }, 100);
}

function renderCalendarStageShell(stageRoot, limitSeconds) {
  const total = sessionData.questions.length;
  stageRoot.innerHTML = `
    <div class="comp-stage-shell mb-board mb-board-calendar">
      ${renderStageTopbar({
        title: 'Mental Calendar Dates',
        levelLabel: `${total} dates`,
        limitSeconds,
        progressId: 'calendar-progress-pill',
        total,
      })}

      <div class="comp-stage-body">
        <div class="calendar-stage-layout">
          <!-- Left: 3-column list of all dates -->
          <div id="calendar-list-panel" class="calendar-list-panel" aria-label="All calendar dates"></div>

          <!-- Right/Centre: Active Question & 7 Day Buttons -->
          <div class="calendar-active-panel">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span id="calendar-active-qnum" class="badge badge-active num" style="font-size: var(--text-sm);">
                  Question 1 of ${sessionData.questions.length}
                </span>
                <span id="calendar-active-chosen" class="num" style="font-size: var(--text-sm); font-weight: 700; color: var(--color-primary);">
                  Not answered yet
                </span>
              </div>

              <div id="calendar-active-date" class="calendar-active-date">
                --
              </div>

              <div style="display: flex; justify-content: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                <button type="button" id="btn-calendar-back" class="btn btn-outline">
                  &larr; BACK
                </button>
                <button type="button" id="btn-calendar-skip" class="btn btn-secondary">
                  SKIP &rarr;
                </button>
              </div>
            </div>

            <div>
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: var(--space-2); text-align: center;">
                Choose Weekday (Click or Press Key 0–7)
              </div>
              <div id="calendar-day-buttons" class="calendar-day-buttons"></div>
            </div>
          </div>
        </div>
      </div>
      ${renderStageFooter({
        hint: 'Keys <code>0–7</code> choose the day and jump to the next unanswered date &middot; <code>Enter</code> skip &middot; <code>+</code> / <code>-</code> or arrows move',
      })}
    </div>
  `;

  document.getElementById('btn-calendar-back')?.addEventListener('click', () => {
    moveCalendarQuestion(-1);
  });
  document.getElementById('btn-calendar-skip')?.addEventListener('click', () => {
    moveCalendarQuestion(1);
  });
}

function updateCalendarStageDOM() {
  if (phase !== 'stage' || activeModuleKey !== 'calendar' || !sessionData) return;

  const questions = sessionData.questions;
  const total = questions.length;
  const answeredCount = calendarAnswers.filter((a) => a !== null).length;

  const progressPill = document.getElementById('calendar-progress-pill');
  if (progressPill) {
    progressPill.textContent = `${answeredCount} / ${total} answered`;
  }

  // Render 3-column list
  const listPanel = document.getElementById('calendar-list-panel');
  if (listPanel) {
    listPanel.innerHTML = questions
      .map((triple, idx) => {
        const isActive = idx === activeQuestionIndex;
        const ans = calendarAnswers[idx];
        const ansLabel =
          ans !== null ? formatDayLabel(ans, currentSettings.day_style) : '—';
        const highlightClass =
          isActive && currentSettings.highlight_active !== false
            ? 'is-active-highlight'
            : '';
        const answeredClass = ans !== null ? 'is-answered' : '';
        const dateStr = formatCalendarDate(triple, currentSettings.date_format);
        return `
          <div
            class="calendar-list-item ${answeredClass} ${highlightClass}"
            data-cal-idx="${idx}"
            role="button"
            tabindex="-1"
          >
            <span style="color: var(--text-muted); font-weight: 700;">${idx + 1}.</span>
            <span>${escapeHtml(dateStr)}</span>
            <strong style="color: var(--color-primary); min-width: 32px; text-align: right;">${escapeHtml(ansLabel)}</strong>
          </div>
        `;
      })
      .join('');

    listPanel.querySelectorAll('[data-cal-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.getAttribute('data-cal-idx'));
        if (Number.isInteger(idx) && idx >= 0 && idx < total) {
          activeQuestionIndex = idx;
          updateCalendarStageDOM();
        }
      });
    });

    const activeRowEl = listPanel.querySelector(`[data-cal-idx="${activeQuestionIndex}"]`);
    if (activeRowEl && typeof activeRowEl.scrollIntoView === 'function') {
      activeRowEl.scrollIntoView({ block: 'nearest' });
    }
  }

  // Update active panel
  const qNumEl = document.getElementById('calendar-active-qnum');
  const chosenEl = document.getElementById('calendar-active-chosen');
  const dateEl = document.getElementById('calendar-active-date');
  const backBtn = document.getElementById('btn-calendar-back');
  const skipBtn = document.getElementById('btn-calendar-skip');

  const activeTriple = questions[activeQuestionIndex];
  const currentAns = calendarAnswers[activeQuestionIndex];

  if (qNumEl) qNumEl.textContent = `Question ${activeQuestionIndex + 1} of ${total}`;
  if (chosenEl) {
    chosenEl.textContent =
      currentAns !== null
        ? `Selected: ${formatDayLabel(currentAns, 'full')}`
        : 'Not answered yet';
  }
  if (dateEl) {
    dateEl.textContent = formatCalendarDate(activeTriple, currentSettings.date_format);
  }
  if (backBtn) backBtn.disabled = activeQuestionIndex <= 0;
  if (skipBtn) skipBtn.disabled = activeQuestionIndex >= total - 1;

  // Render 7 day buttons in chosen order and style
  const dayBtnsContainer = document.getElementById('calendar-day-buttons');
  if (dayBtnsContainer) {
    const orderedDays = getOrderedWeekdays(currentSettings.leftmost_day);
    dayBtnsContainer.innerHTML = orderedDays
      .map((dayIdx) => {
        const label = formatDayLabel(dayIdx, currentSettings.day_style);
        const keyNum = primaryKeyForDay(dayIdx, currentSettings.key_zero_day);
        const keyHint = keyNum === 0 ? 'Key 0 / 7' : `Key ${keyNum}`;
        const selectedClass = currentAns === dayIdx ? 'is-selected' : '';
        return `
          <button
            type="button"
            class="calendar-day-btn ${selectedClass}"
            data-day-idx="${dayIdx}"
          >
            <span>${escapeHtml(label)}</span>
            <span class="calendar-day-btn-key">${escapeHtml(keyHint)}</span>
          </button>
        `;
      })
      .join('');

    dayBtnsContainer.querySelectorAll('[data-day-idx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dayIdx = Number(btn.getAttribute('data-day-idx'));
        chooseCalendarDayAndAdvance(dayIdx);
      });
    });
  }
}

function chooseCalendarDayAndAdvance(dayIdx) {
  if (phase !== 'stage' || stageInputsLocked || activeModuleKey !== 'calendar' || !sessionData) return;
  calendarAnswers[activeQuestionIndex] = dayIdx;

  // Jump to the next unanswered question (searching forward, then from 0)
  const total = sessionData.questions.length;
  let nextIdx = -1;
  for (let offset = 1; offset < total; offset++) {
    const candidate = (activeQuestionIndex + offset) % total;
    if (calendarAnswers[candidate] === null) {
      nextIdx = candidate;
      break;
    }
  }

  if (nextIdx !== -1) {
    activeQuestionIndex = nextIdx;
  } else if (activeQuestionIndex < total - 1) {
    activeQuestionIndex += 1;
  }

  updateCalendarStageDOM();
}

function moveCalendarQuestion(delta) {
  if (!sessionData || stageInputsLocked) return;
  const total = sessionData.questions.length;
  const next = Math.max(0, Math.min(total - 1, activeQuestionIndex + delta));
  if (next !== activeQuestionIndex) {
    activeQuestionIndex = next;
    updateCalendarStageDOM();
  }
}

/* ============================================================================
 * ADDITIONS STAGE RENDERING & INTERACTION
 * ========================================================================== */

function renderAdditionsStageShell(stageRoot, limitSeconds) {
  const total = sessionData.questions.length;
  stageRoot.innerHTML = `
    <div class="comp-stage-shell mb-board mb-board-additions">
      ${renderStageTopbar({
        title: 'Mental Additions',
        levelLabel: '10 × 10 digits',
        limitSeconds,
        progressId: 'additions-progress-pill',
        total,
      })}

      <div class="comp-stage-body">
        <div class="additions-stage-layout">
          <!-- Left: 5x2 grid of all 10 questions -->
          <div id="additions-overview-grid" class="additions-overview-grid" aria-label="All 10 addition questions"></div>

          <!-- Right: Active question workbench -->
          <div class="additions-workbench">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2);">
              <span id="additions-active-qnum" class="badge badge-active num" style="font-size: var(--text-sm);">
                Question 1 of 10
              </span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <button type="button" id="btn-add-unstep" class="btn btn-outline btn-sm" title="Move column highlight back (/)">
                  Col Back (<code>/</code>)
                </button>
                <button type="button" id="btn-add-step" class="btn btn-outline btn-sm" title="Advance column highlight (*)">
                  Col Step (<code>*</code>)
                </button>
              </div>
            </div>

            <div id="additions-active-matrix" class="additions-matrix"></div>

            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
                <span>11 Answer Slots (${currentSettings.typing_direction === 'ltr' ? 'Left to Right' : 'Right to Left'})</span>
                <span>Click any slot or use <code>&larr;</code> <code>&rarr;</code> / <code>Backspace</code></span>
              </div>
              <div id="additions-slots-row" class="additions-slots-row"></div>
            </div>
          </div>
        </div>
      </div>
      ${renderStageFooter({
        backId: 'btn-add-prev',
        nextId: 'btn-add-next',
        hint: 'Digits <code>0–9</code> type &middot; <code>*</code> / <code>/</code> move the column highlight &middot; <code>+</code> next &middot; <code>-</code> previous &middot; <code>Enter</code> next',
      })}
    </div>
  `;

  document.getElementById('btn-add-prev')?.addEventListener('click', () => {
    moveAdditionsQuestion(-1);
  });
  document.getElementById('btn-add-next')?.addEventListener('click', () => {
    moveAdditionsQuestion(1);
  });
  document.getElementById('btn-add-step')?.addEventListener('click', () => {
    additionsManualStepOffsets[activeQuestionIndex] =
      (additionsManualStepOffsets[activeQuestionIndex] || 0) + 1;
    updateAdditionsStageDOM();
  });
  document.getElementById('btn-add-unstep')?.addEventListener('click', () => {
    additionsManualStepOffsets[activeQuestionIndex] =
      (additionsManualStepOffsets[activeQuestionIndex] || 0) - 1;
    updateAdditionsStageDOM();
  });
}

function updateAdditionsStageDOM() {
  if (phase !== 'stage' || activeModuleKey !== 'additions' || !sessionData) return;

  const questions = sessionData.questions;
  const total = questions.length;
  const answeredCount = additionsSlots.filter((st) => toAnswerString(st).length > 0).length;

  const progressPill = document.getElementById('additions-progress-pill');
  if (progressPill) {
    progressPill.textContent = `${answeredCount} / ${total} answered`;
  }

  // Render 5x2 overview grid
  const gridEl = document.getElementById('additions-overview-grid');
  if (gridEl) {
    gridEl.innerHTML = questions
      .map((tenNumbers, idx) => {
        const isActive = idx === activeQuestionIndex;
        const isAnswered = toAnswerString(additionsSlots[idx]).length > 0;
        const ansStr = toAnswerString(additionsSlots[idx]);
        const rowsHtml = tenNumbers.map((numStr) => `<div>${escapeHtml(numStr)}</div>`).join('');
        return `
          <div
            class="additions-mini-card ${isActive ? 'is-active' : ''} ${isAnswered ? 'is-answered' : ''}"
            data-add-idx="${idx}"
            role="button"
            tabindex="-1"
          >
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
              <strong style="font-size: 11px; color: ${isActive ? 'var(--color-primary)' : 'var(--text-muted)'};">
                Q${idx + 1}${isActive ? ' ●' : ''}
              </strong>
              <span style="font-size: 10px; color: var(--text-dim);">${ansStr ? '✓' : ''}</span>
            </div>
            <div class="additions-mini-rows">${rowsHtml}</div>
            <div class="additions-mini-answer">${ansStr ? escapeHtml(ansStr) : '&nbsp;'}</div>
          </div>
        `;
      })
      .join('');

    gridEl.querySelectorAll('[data-add-idx]').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = Number(card.getAttribute('data-add-idx'));
        if (Number.isInteger(idx) && idx >= 0 && idx < total) {
          activeQuestionIndex = idx;
          updateAdditionsStageDOM();
        }
      });
    });
  }

  // Render active question matrix with highlighted column(s)
  const qNumEl = document.getElementById('additions-active-qnum');
  if (qNumEl) qNumEl.textContent = `Question ${activeQuestionIndex + 1} of ${total}`;
  const addBackBtn = document.getElementById('btn-add-prev');
  const addNextBtn = document.getElementById('btn-add-next');
  if (addBackBtn) addBackBtn.disabled = activeQuestionIndex <= 0;
  if (addNextBtn) addNextBtn.disabled = activeQuestionIndex >= total - 1;

  const slotState = additionsSlots[activeQuestionIndex];
  const activeCols = new Set(
    highlightedColumns({
      totalColumns: 10,
      direction: currentSettings.typing_direction,
      columnsPerStep: currentSettings.highlight_columns,
      typedCount: slotState.typedCount,
      manualStepOffset: additionsManualStepOffsets[activeQuestionIndex] || 0,
    })
  );

  const matrixEl = document.getElementById('additions-active-matrix');
  if (matrixEl) {
    const activeNums = questions[activeQuestionIndex] || [];
    matrixEl.innerHTML = activeNums
      .map((numStr, rowIdx) => {
        const digitCells = String(numStr)
          .split('')
          .map((ch, colIdx) => {
            const hlClass = activeCols.has(colIdx) ? 'is-col-highlighted' : '';
            return `<span class="additions-digit-cell ${hlClass}">${escapeHtml(ch)}</span>`;
          })
          .join('');
        return `
          <div class="additions-matrix-row">
            <span class="additions-row-idx">${rowIdx === activeNums.length - 1 ? '+' : `${rowIdx + 1}.`}</span>
            ${digitCells}
          </div>
        `;
      })
      .join('');
  }

  // Render 11 digit slots
  const slotsRowEl = document.getElementById('additions-slots-row');
  if (slotsRowEl) {
    slotsRowEl.innerHTML = slotState.slots
      .map((ch, slotIdx) => {
        const isCursor = slotIdx === slotState.cursor;
        return `
          <div
            class="additions-slot-box ${isCursor ? 'is-cursor' : ''}"
            data-slot-idx="${slotIdx}"
            role="button"
            tabindex="-1"
          >
            ${ch ? escapeHtml(ch) : ''}
          </div>
        `;
      })
      .join('');

    slotsRowEl.querySelectorAll('[data-slot-idx]').forEach((box) => {
      box.addEventListener('click', () => {
        const sIdx = Number(box.getAttribute('data-slot-idx'));
        additionsSlots[activeQuestionIndex] = setCursor(
          additionsSlots[activeQuestionIndex],
          sIdx
        );
        updateAdditionsStageDOM();
      });
    });
  }
}

function moveAdditionsQuestion(delta) {
  if (!sessionData || stageInputsLocked) return;
  const total = sessionData.questions.length;
  const next = Math.max(0, Math.min(total - 1, activeQuestionIndex + delta));
  if (next !== activeQuestionIndex) {
    activeQuestionIndex = next;
    updateAdditionsStageDOM();
  }
}

/* ============================================================================
 * SHARED STAGE CHROME (Memoriad-style header, countdown timer and footer)
 * ========================================================================== */

/**
 * Header used by every competition stage: "COMPETITION STAGE" label and module title on the
 * left, the big countdown timer in the centre, progress + Full Screen / Exit on the right.
 */
function renderStageTopbar({ title, levelLabel = '', limitSeconds, progressId, total }) {
  const timerStyle = currentSettings.timer_shown === false ? 'display: none;' : '';
  return `
      <div class="comp-stage-topbar mb-topbar">
        <div class="mb-topbar-left">
          <span class="mb-stage-label">Competition Stage</span>
          <div class="mb-stage-title">
            ${escapeHtml(title)}
            ${levelLabel ? `<span class="mb-level-chip num">${escapeHtml(levelLabel)}</span>` : ''}
          </div>
          ${activeTodoTaskId ? `<span class="badge badge-info" style="font-weight: 700;">Daily Task (${limitSeconds}s locked)</span>` : ''}
        </div>
        <div class="mb-topbar-center">
          <div
            id="comp-stage-timer"
            class="comp-timer-display mb-timer"
            style="${timerStyle}"
            role="timer"
            aria-label="Time remaining"
            title="Time limit ${escapeHtml(formatTimerMMSS(limitSeconds))}"
          >${escapeHtml(formatTimerMMSS(limitSeconds))}</div>
          <div id="comp-stage-last10" class="comp-last10-notice" role="status" aria-live="assertive">
            <span aria-hidden="true">&#9888;</span>
            <span>TIME ENDING: <strong id="comp-stage-last10-sec">10s left</strong></span>
          </div>
        </div>
        <div class="mb-topbar-right">
          <span id="${progressId}" class="mb-progress-pill num">0 / ${total} answered</span>
          <button type="button" id="btn-stage-fullscreen" class="btn btn-outline btn-sm">Full Screen</button>
          <button type="button" id="btn-stage-exit" class="btn btn-outline btn-sm">Exit</button>
        </div>
      </div>
  `;
}

/** Footer with key hints on the left and BACK / NEXT / FINISH on the right. */
function renderStageFooter({ backId = '', nextId = '', hint = '' }) {
  return `
      <div class="mb-footer">
        <div class="mb-keys-hint">${hint}</div>
        <div class="mb-footer-actions">
          ${backId ? `<button type="button" id="${backId}" class="btn mb-btn mb-btn-back" title="Previous question (-)">&larr; BACK</button>` : ''}
          ${nextId ? `<button type="button" id="${nextId}" class="btn mb-btn mb-btn-next" title="Next question (+)">NEXT &rarr;</button>` : ''}
          <button type="button" id="btn-stage-finish" class="btn mb-btn mb-btn-finish">FINISH</button>
        </div>
      </div>
  `;
}

/* ============================================================================
 * NUMBER BOARD STAGE (Multiplications, Division, Square Roots)
 * ========================================================================== */

const NUMBER_BOARD_MODULES = ['multiplications', 'division', 'square_roots'];

function isNumberBoardModule(moduleKey = activeModuleKey) {
  return NUMBER_BOARD_MODULES.includes(moduleKey);
}

/**
 * Level of the running session. Question shapes win over settings so that older sessions
 * (for example weekly tests generated before levels existed) still render correctly.
 */
function getStageLevel() {
  const s = { ...(currentSettings || {}), ...(sessionData?.settings || {}) };
  const questions = Array.isArray(sessionData?.questions) ? sessionData.questions : [];
  const first = questions[0];
  if (activeModuleKey === 'multiplications') {
    const fromQuestion = Array.isArray(first) ? String(first[0] ?? '').length : 0;
    const digits = fromQuestion || normalizeMultiplicationDigits(s.digits);
    return {
      digits,
      layout: normalizeLayout(s.layout || s.question_format),
      slotCount: digits * 2,
      stepCount: digits,
    };
  }
  if (activeModuleKey === 'division') {
    const fromDividend = Array.isArray(first) ? String(first[0] ?? '').length : 0;
    const fromDivisor = Array.isArray(first) ? String(first[1] ?? '').length : 0;
    const level =
      fromDividend && fromDivisor
        ? { dividend_digits: fromDividend, divisor_digits: fromDivisor }
        : normalizeDivisionLevel(s.dividend_digits, s.divisor_digits);
    return {
      ...level,
      layout: normalizeLayout(s.layout),
      slotCount: level.dividend_digits - level.divisor_digits + 1,
      stepCount: level.dividend_digits,
    };
  }
  if (activeModuleKey === 'square_roots') {
    const fromQuestion = first !== undefined && first !== null ? String(first).length : 0;
    const digits = fromQuestion || normalizeSquareRootDigits(s.digits);
    const intDigits = squareRootIntegerDigits(digits);
    return {
      digits,
      intDigits,
      slotCount: intDigits + SQUARE_ROOT_DECIMALS,
      stepCount: digits,
    };
  }
  return { slotCount: 11, stepCount: 0 };
}

function describeStageLevel(level) {
  if (activeModuleKey === 'multiplications') {
    return `${level.digits}d × ${level.digits}d${level.layout === 'horizontal' ? ' · side by side' : ''}`;
  }
  if (activeModuleKey === 'division') {
    return `${level.dividend_digits}d ÷ ${level.divisor_digits}d${level.layout === 'horizontal' ? ' · horizontal' : ''}`;
  }
  if (activeModuleKey === 'square_roots') {
    return `√ ${level.digits} digits · 5 decimals`;
  }
  return '';
}

/** Creates fresh answer state for the active module (slot counts follow the level). */
function initStageAnswerState(questions, opts = {}) {
  const count = Array.isArray(questions) ? questions.length : 0;
  activeQuestionIndex = 0;
  if (activeModuleKey === 'calendar') {
    calendarAnswers = new Array(count).fill(null);
    return;
  }
  if (activeModuleKey === 'additions') {
    additionsSlots = questions.map(() =>
      createAnswerSlots(
        11,
        opts.typing_direction ?? currentSettings.typing_direction,
        '',
        opts.highlight_columns ?? currentSettings.highlight_columns
      )
    );
    additionsManualStepOffsets = new Array(count).fill(0);
    return;
  }
  const level = getStageLevel();
  const requested =
    opts.typing_direction ??
    currentSettings.typing_direction ??
    (activeModuleKey === 'division' ? 'ltr' : 'rtl');
  const direction = activeModuleKey === 'square_roots' ? 'ltr' : requested === 'ltr' ? 'ltr' : 'rtl';
  numberBoardSlots = questions.map(() => createAnswerSlots(level.slotCount, direction, '', 1));
  numberBoardSteps = new Array(count).fill(0);
}

function hasSlotInput(slotState) {
  return Boolean(
    slotState && Array.isArray(slotState.slots) && slotState.slots.some((ch) => ch !== '')
  );
}

function formatRootSlotsPreview(slotState, intDigits = 3) {
  if (!hasSlotInput(slotState)) return '';
  const intPart = slotState.slots
    .slice(0, intDigits)
    .map((ch) => ch || '_')
    .join('');
  const decSlots = slotState.slots.slice(intDigits);
  if (!decSlots.some((ch) => ch !== '')) {
    return intPart.replace(/_+$/, '');
  }
  const decPart = decSlots
    .map((ch) => ch || '_')
    .join('')
    .replace(/_+$/, '');
  return `${intPart}.${decPart}`;
}

function numberBoardAnswerPreview(idx, level) {
  const st = numberBoardSlots[idx];
  if (activeModuleKey === 'square_roots') return formatRootSlotsPreview(st, level.intDigits);
  return toAnswerString(st);
}

function numberBoardCheckedBoxes(level, state) {
  return activeModuleKey === 'multiplications'
    ? getMultCheckedBoxes(state, level.stepCount)
    : getRootCheckedBoxes(state, level.stepCount);
}

function numberBoardNextTargets(level, state) {
  if (activeModuleKey === 'multiplications') {
    return new Set([getMultNextClickBoxIndex(state, level.stepCount)]);
  }
  return new Set([state, state - 1]);
}

function pressNumberBoardStep(key) {
  if (!sessionData || stageInputsLocked) return;
  const level = getStageLevel();
  const current = numberBoardSteps[activeQuestionIndex] || 0;
  if (activeModuleKey === 'multiplications') {
    // '/' does nothing in multiplication (cyclic step boxes advance with '*')
    if (key !== '*') return;
    numberBoardSteps[activeQuestionIndex] = pressMultStepKey(current, '*', level.stepCount);
  } else {
    numberBoardSteps[activeQuestionIndex] = pressRootStepKey(current, key, level.stepCount);
  }
  updateNumberBoardStageDOM();
}

function clickNumberBoardStepBox(boxIdx) {
  if (!sessionData || stageInputsLocked) return;
  const level = getStageLevel();
  const current = numberBoardSteps[activeQuestionIndex] || 0;
  const next =
    activeModuleKey === 'multiplications'
      ? clickMultStepBox(current, boxIdx, level.stepCount)
      : clickRootStepBox(current, boxIdx, level.stepCount);
  if (next !== current) {
    numberBoardSteps[activeQuestionIndex] = next;
    updateNumberBoardStageDOM();
  }
}

function renderNumberBoardStageShell(stageRoot, limitSeconds) {
  const level = getStageLevel();
  const total = sessionData.questions.length;
  const meta = MODULE_META[activeModuleKey] || { title: 'Competition Stage' };
  const isRoots = activeModuleKey === 'square_roots';
  const isMult = activeModuleKey === 'multiplications';
  const stepHint = isMult
    ? 'Step boxes: <code>*</code> marks the next column pair'
    : 'Step boxes: <code>*</code> check &middot; <code>/</code> uncheck';
  const keysHint = `Digits <code>0–9</code> type &middot; <code>&larr;</code> <code>&rarr;</code> move between digits &middot; <code>Backspace</code> delete &middot; <code>+</code> next &middot; <code>-</code> previous &middot; <code>Enter</code> next / finish`;

  stageRoot.innerHTML = `
    <div class="comp-stage-shell mb-board mb-board-${escapeHtml(activeModuleKey)}">
      ${renderStageTopbar({
        title: meta.title,
        levelLabel: describeStageLevel(level),
        limitSeconds,
        progressId: 'nb-progress-pill',
        total,
      })}
      <div class="comp-stage-body mb-body">
        <div
          id="nb-overview-grid"
          class="mb-card-grid ${isRoots ? 'mb-grid-roots' : ''}"
          aria-label="All ${total} questions"
        ></div>
        <div class="mb-workbench">
          <div class="mb-workbench-head">
            <span id="nb-active-qnum" class="mb-qnum num">Question 1 of ${total}</span>
            <span class="mb-workbench-hint">${stepHint}</span>
          </div>
          <div id="nb-active-problem" class="mb-active-problem"></div>
        </div>
      </div>
      ${renderStageFooter({ backId: 'btn-nb-prev', nextId: 'btn-nb-next', hint: keysHint })}
    </div>
  `;

  document.getElementById('btn-nb-prev')?.addEventListener('click', () => {
    moveNumberBoardQuestion(-1);
  });
  document.getElementById('btn-nb-next')?.addEventListener('click', () => {
    moveNumberBoardQuestion(1);
  });
}

function renderNumberBoardCardProblem(question, level) {
  if (activeModuleKey === 'square_roots') {
    return `<span class="mb-card-radical" aria-hidden="true">&radic;</span><span class="mb-card-radicand">${escapeHtml(String(question))}</span>`;
  }
  const [a = '', b = ''] = Array.isArray(question) ? question : [];
  if (activeModuleKey === 'multiplications') {
    return level.layout === 'horizontal'
      ? `<div class="mb-card-inline">${escapeHtml(a)} &times; ${escapeHtml(b)}</div>`
      : `<div class="mb-card-stack"><div>${escapeHtml(a)}</div><div><span class="mb-card-sign">&times;</span>${escapeHtml(b)}</div></div>`;
  }
  return level.layout === 'horizontal'
    ? `<div class="mb-card-inline">${escapeHtml(a)} &divide; ${escapeHtml(b)}</div>`
    : `<div class="mb-card-longdiv"><span class="mb-card-divisor">${escapeHtml(b)}</span><span class="mb-card-dividend">${escapeHtml(a)}</span></div>`;
}

function renderStepBoxCells(level, checked, targets) {
  return checked
    .map((isChecked, colIdx) => {
      const isTarget = targets.has(colIdx);
      return `
        <div
          class="comp-step-box mb-step-box ${isChecked ? 'is-checked' : ''} ${isTarget ? 'is-next-target' : ''}"
          data-nb-step-box="${colIdx}"
          role="button"
          tabindex="-1"
          aria-label="Column ${colIdx + 1} step box (${isChecked ? 'checked' : 'unchecked'})"
        >${isChecked ? '&#10003;' : ''}</div>
      `;
    })
    .join('');
}

function renderDigitCells(str, checked, extraClass = '') {
  return String(str)
    .split('')
    .map(
      (ch, colIdx) =>
        `<span class="mb-digit ${extraClass} ${checked && checked[colIdx] ? 'is-col-highlighted' : ''}">${escapeHtml(ch)}</span>`
    )
    .join('');
}

/** Enlarged active problem: step boxes in a row above the digits they mark. */
function renderNumberBoardActiveProblem(question, level, checked, targets) {
  const boxes = renderStepBoxCells(level, checked, targets);
  if (activeModuleKey === 'square_roots') {
    const radicand = String(question ?? '');
    return `
      <div class="mb-problem-grid" style="grid-template-columns: 48px repeat(${radicand.length}, var(--mb-cell));">
        <span></span>${boxes}
        <span class="mb-radical-sign" aria-hidden="true">&radic;</span>${renderDigitCells(radicand, checked, 'mb-digit-overline')}
      </div>
    `;
  }

  const [a = '', b = ''] = Array.isArray(question) ? question : [];
  if (activeModuleKey === 'multiplications') {
    const n = level.stepCount;
    const padA = String(a).padStart(n, '0');
    const padB = String(b).padStart(n, '0');
    if (level.layout === 'horizontal') {
      return `
        <div class="mb-problem-grid" style="grid-template-columns: repeat(${n}, var(--mb-cell)) 40px repeat(${n}, var(--mb-cell));">
          ${boxes}<span></span>${'<span></span>'.repeat(n)}
          ${renderDigitCells(padA, checked)}<span class="mb-op-sign">&times;</span>${renderDigitCells(padB, checked)}
        </div>
      `;
    }
    return `
      <div class="mb-problem-grid" style="grid-template-columns: 40px repeat(${n}, var(--mb-cell));">
        <span></span>${boxes}
        <span></span>${renderDigitCells(padA, checked)}
        <span class="mb-op-sign">&times;</span>${renderDigitCells(padB, checked, 'mb-digit-underline')}
      </div>
    `;
  }

  // Division
  const dividend = String(a);
  const divisor = String(b);
  if (level.layout === 'horizontal') {
    return `
      <div class="mb-problem-grid" style="grid-template-columns: repeat(${dividend.length}, var(--mb-cell)) 40px auto;">
        ${boxes}<span></span><span></span>
        ${renderDigitCells(dividend, checked)}<span class="mb-op-sign">&divide;</span><span class="mb-divisor-inline num">${escapeHtml(divisor)}</span>
      </div>
    `;
  }
  return `
    <div class="mb-problem-grid" style="grid-template-columns: auto repeat(${dividend.length}, var(--mb-cell));">
      <span></span>${boxes}
      <span class="mb-divisor-cell num">${escapeHtml(divisor)}</span>${renderDigitCells(dividend, checked, 'mb-digit-bracket')}
    </div>
  `;
}

function renderNumberBoardSlots(slotState, level) {
  if (!slotState) return '';
  const parts = [];
  slotState.slots.forEach((ch, slotIdx) => {
    if (activeModuleKey === 'square_roots' && slotIdx === level.intDigits) {
      parts.push('<span class="mb-decimal-dot" aria-hidden="true">.</span>');
    }
    const isCursor = slotIdx === slotState.cursor;
    parts.push(`
      <div
        class="additions-slot-box mb-slot ${isCursor ? 'is-cursor' : ''}"
        data-slot-idx="${slotIdx}"
        role="button"
        tabindex="-1"
        aria-label="Answer digit ${slotIdx + 1}"
      >${ch ? escapeHtml(ch) : ''}</div>
    `);
  });
  return parts.join('');
}

function updateNumberBoardStageDOM() {
  if (phase !== 'stage' || !isNumberBoardModule() || !sessionData) return;

  const level = getStageLevel();
  const questions = sessionData.questions;
  const total = questions.length;
  const answeredCount = numberBoardSlots.filter(hasSlotInput).length;

  const progressPill = document.getElementById('nb-progress-pill');
  if (progressPill) progressPill.textContent = `${answeredCount} / ${total} answered`;

  const gridEl = document.getElementById('nb-overview-grid');
  if (gridEl) {
    gridEl.innerHTML = questions
      .map((question, idx) => {
        const isActive = idx === activeQuestionIndex;
        const preview = numberBoardAnswerPreview(idx, level);
        return `
          <div
            class="mb-card ${isActive ? 'is-active' : ''} ${preview ? 'is-answered' : ''}"
            data-nb-idx="${idx}"
            role="button"
            tabindex="-1"
            aria-label="Question ${idx + 1}${preview ? ', answered' : ''}"
          >
            <span class="mb-card-num num">${idx + 1}</span>
            <div class="mb-card-problem num">${renderNumberBoardCardProblem(question, level)}</div>
            <div class="mb-card-answer num">${preview ? escapeHtml(preview) : '&nbsp;'}</div>
          </div>
        `;
      })
      .join('');

    gridEl.querySelectorAll('[data-nb-idx]').forEach((card) => {
      card.addEventListener('click', () => {
        const idx = Number(card.getAttribute('data-nb-idx'));
        if (!stageInputsLocked && Number.isInteger(idx) && idx >= 0 && idx < total) {
          activeQuestionIndex = idx;
          updateNumberBoardStageDOM();
        }
      });
    });
  }

  const qNumEl = document.getElementById('nb-active-qnum');
  if (qNumEl) qNumEl.textContent = `Question ${activeQuestionIndex + 1} of ${total}`;

  const backBtn = document.getElementById('btn-nb-prev');
  const nextBtn = document.getElementById('btn-nb-next');
  if (backBtn) backBtn.disabled = activeQuestionIndex <= 0;
  if (nextBtn) nextBtn.disabled = activeQuestionIndex >= total - 1;

  const problemEl = document.getElementById('nb-active-problem');
  if (problemEl) {
    const stepState = numberBoardSteps[activeQuestionIndex] || 0;
    const checked = numberBoardCheckedBoxes(level, stepState);
    const targets = numberBoardNextTargets(level, stepState);
    const answerLabel =
      activeModuleKey === 'division' ? 'Quotient' : activeModuleKey === 'square_roots' ? 'Root' : 'Product';
    const cellSize = level.slotCount + level.stepCount > 30 ? 34 : 40;
    problemEl.style.setProperty('--mb-cell', `${cellSize}px`);
    problemEl.innerHTML = `
      <div class="mb-problem-zone">
        ${renderNumberBoardActiveProblem(questions[activeQuestionIndex], level, checked, targets)}
      </div>
      <div class="mb-answer-zone">
        <span class="mb-answer-label">${answerLabel}</span>
        <div id="nb-slots-row" class="mb-slots-row">${renderNumberBoardSlots(numberBoardSlots[activeQuestionIndex], level)}</div>
      </div>
    `;

    problemEl.querySelectorAll('[data-nb-step-box]').forEach((boxEl) => {
      boxEl.addEventListener('click', () => {
        clickNumberBoardStepBox(Number(boxEl.getAttribute('data-nb-step-box')));
      });
    });
    problemEl.querySelectorAll('[data-slot-idx]').forEach((box) => {
      box.addEventListener('click', () => {
        if (stageInputsLocked) return;
        numberBoardSlots[activeQuestionIndex] = setCursor(
          numberBoardSlots[activeQuestionIndex],
          Number(box.getAttribute('data-slot-idx'))
        );
        updateNumberBoardStageDOM();
      });
    });
  }
}

function moveNumberBoardQuestion(delta) {
  if (!sessionData || stageInputsLocked) return;
  const total = sessionData.questions.length;
  const next = Math.max(0, Math.min(total - 1, activeQuestionIndex + delta));
  if (next !== activeQuestionIndex) {
    activeQuestionIndex = next;
    updateNumberBoardStageDOM();
  }
}

function handleNumberBoardKeydown(e, action) {
  if (action === 'next') {
    e.preventDefault();
    moveNumberBoardQuestion(1);
    return;
  }
  if (action === 'previous') {
    e.preventDefault();
    moveNumberBoardQuestion(-1);
    return;
  }
  if (action === 'step') {
    e.preventDefault();
    pressNumberBoardStep('*');
    return;
  }
  if (action === 'unstep') {
    e.preventDefault();
    pressNumberBoardStep('/');
    return;
  }
  const idx = activeQuestionIndex;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    numberBoardSlots[idx] = moveCursorLeft(numberBoardSlots[idx]);
    updateNumberBoardStageDOM();
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    numberBoardSlots[idx] = moveCursorRight(numberBoardSlots[idx]);
    updateNumberBoardStageDOM();
    return;
  }
  if (e.key === 'Backspace') {
    e.preventDefault();
    numberBoardSlots[idx] = backspace(numberBoardSlots[idx]);
    updateNumberBoardStageDOM();
    return;
  }
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    numberBoardSlots[idx] = typeDigit(numberBoardSlots[idx], e.key);
    updateNumberBoardStageDOM();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (activeModuleKey !== 'square_roots') {
      // Close any blank gaps between typed digits (square roots keep exact positions)
      numberBoardSlots[idx] = compact(numberBoardSlots[idx]);
    }
    const total = sessionData.questions.length;
    if (activeQuestionIndex < total - 1) {
      activeQuestionIndex += 1;
      updateNumberBoardStageDOM();
    } else {
      updateNumberBoardStageDOM();
      if (numberBoardSlots.every(hasSlotInput)) {
        promptFinishConfirmation();
      }
    }
  }
}

/* ============================================================================
 * KEYBOARD SHORTCUT HANDLER DURING STAGE
 * ========================================================================== */

function handleGlobalStageKeydown(e) {
  if (phase !== 'stage' || stageInputsLocked || !sessionData || isSubmitting) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  // If the confirmation modal is open, allow Escape to dismiss it and block stage shortcuts
  const openModalEl = document.getElementById('comp-stage-inline-modal');
  if (openModalEl) {
    if (e.key === 'Escape') {
      e.preventDefault();
      openModalEl.remove();
    }
    return;
  }

  const action = keyAction(e);

  if (activeModuleKey === 'calendar') {
    if (action === 'next' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      moveCalendarQuestion(1);
      return;
    }
    if (action === 'previous' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveCalendarQuestion(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      moveCalendarQuestion(1);
      return;
    }
    const mappedDay = dayForKey(e.key, currentSettings.key_zero_day);
    if (mappedDay !== null) {
      e.preventDefault();
      chooseCalendarDayAndAdvance(mappedDay);
    }
    return;
  }

  if (activeModuleKey === 'additions') {
    if (action === 'next') {
      e.preventDefault();
      moveAdditionsQuestion(1);
      return;
    }
    if (action === 'previous') {
      e.preventDefault();
      moveAdditionsQuestion(-1);
      return;
    }
    if (action === 'step') {
      e.preventDefault();
      additionsManualStepOffsets[activeQuestionIndex] =
        (additionsManualStepOffsets[activeQuestionIndex] || 0) + 1;
      updateAdditionsStageDOM();
      return;
    }
    if (action === 'unstep') {
      e.preventDefault();
      additionsManualStepOffsets[activeQuestionIndex] =
        (additionsManualStepOffsets[activeQuestionIndex] || 0) - 1;
      updateAdditionsStageDOM();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      additionsSlots[activeQuestionIndex] = moveCursorLeft(additionsSlots[activeQuestionIndex]);
      updateAdditionsStageDOM();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      additionsSlots[activeQuestionIndex] = moveCursorRight(additionsSlots[activeQuestionIndex]);
      updateAdditionsStageDOM();
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      additionsSlots[activeQuestionIndex] = backspace(additionsSlots[activeQuestionIndex]);
      updateAdditionsStageDOM();
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      additionsSlots[activeQuestionIndex] = typeDigit(
        additionsSlots[activeQuestionIndex],
        e.key
      );
      updateAdditionsStageDOM();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // Compact any blank gaps between typed digits
      additionsSlots[activeQuestionIndex] = compact(additionsSlots[activeQuestionIndex]);
      updateAdditionsStageDOM();

      const total = sessionData.questions.length;
      if (activeQuestionIndex < total - 1) {
        activeQuestionIndex += 1;
        updateAdditionsStageDOM();
      } else {
        // On the last question: if all questions have an answer, ask confirmation ("Finish?")
        const allAnswered = additionsSlots.every((st) => toAnswerString(st).length > 0);
        if (allAnswered) {
          promptFinishConfirmation();
        }
      }
    }
    return;
  }

  if (isNumberBoardModule()) {
    handleNumberBoardKeydown(e, action);
  }
}

/* ============================================================================
 * STAGE CHROME CONTROLS (Fullscreen, Exit, Finish)
 * ========================================================================== */

function bindStageChromeButtons() {
  const fsBtn = document.getElementById('btn-stage-fullscreen');
  const exitBtn = document.getElementById('btn-stage-exit');
  const finishBtn = document.getElementById('btn-stage-finish');

  fsBtn?.addEventListener('click', () => {
    try {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.();
      } else {
        document.exitFullscreen?.();
      }
    } catch {
      // Ignore Fullscreen API restrictions in embedded iframes
    }
  });

  exitBtn?.addEventListener('click', () => {
    openStageModal({
      title: isTestMode ? 'Leave Weekly Test Section?' : 'Discard This Practice Try?',
      message: isTestMode
        ? RUNNER_EXIT_CONFIRM_TEXT
        : 'Exiting now will discard your current answers without saving a score.',
      confirmLabel: isTestMode ? 'Leave Section' : 'Discard & Exit',
      onConfirm: () => {
        try {
          if (document.fullscreenElement) document.exitFullscreen?.();
        } catch {
          // Ignore
        }
        if (isTestMode) {
          phase = 'results';
          window.location.href = '/pages/weekly-test.html';
          return;
        }
        if (activeTodoTaskId) {
          window.location.href = '/pages/student.html';
          return;
        }
        renderSettingsView();
      },
    });
  });

  finishBtn?.addEventListener('click', () => {
    submitCurrentSession('finish');
  });
}

function promptFinishConfirmation() {
  openStageModal({
    title: 'Finish?',
    message: 'All 10 questions have answers. Submit your competition stage now?',
    confirmLabel: 'Finish & Submit',
    onConfirm: () => {
      submitCurrentSession('finish');
    },
  });
}

function openStageModal({ title, message, confirmLabel, onConfirm }) {
  const existing = document.getElementById('comp-stage-inline-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'comp-stage-inline-modal';
  overlay.className = 'modal-backdrop open active';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal-dialog" style="max-width: 440px;">
      <header class="modal-header">
        <h2 class="modal-title">${escapeHtml(title)}</h2>
      </header>
      <div class="modal-body">
        <p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0;">
          ${escapeHtml(message)}
        </p>
      </div>
      <footer class="modal-footer" style="display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-hairline);">
        <button type="button" id="comp-modal-cancel" class="btn btn-outline btn-sm">Keep Practising</button>
        <button type="button" id="comp-modal-confirm" class="btn btn-primary btn-sm">${escapeHtml(confirmLabel)}</button>
      </footer>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      overlay.remove();
    }
  });
  document.getElementById('comp-modal-cancel')?.addEventListener('click', () => overlay.remove());
  document.getElementById('comp-modal-confirm')?.addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });
}

/* ============================================================================
 * 4. SUBMISSION & RESULTS PHASE
 * ========================================================================== */

function collectCurrentAnswers() {
  if (activeModuleKey === 'calendar') {
    return calendarAnswers.slice();
  }
  if (activeModuleKey === 'multiplications' || activeModuleKey === 'division') {
    return numberBoardSlots.map((st) => {
      const compacted = compact(st);
      const str = toAnswerString(compacted);
      return str.length > 0 ? str : null;
    });
  }
  if (activeModuleKey === 'square_roots') {
    return numberBoardSlots.map((st) => {
      if (!hasSlotInput(st)) {
        return null;
      }
      // Preserve exact positional slots so blank leading/middle slots are not shifted
      return st.slots.map((ch) => ch || '_').join('');
    });
  }
  return additionsSlots.map((st) => {
    const compacted = compact(st);
    const str = toAnswerString(compacted);
    return str.length > 0 ? str : null;
  });
}

async function submitCurrentSession(finishedBy = lastFinishedBy || 'finish') {
  if (!sessionData || isSubmitting) return;
  isSubmitting = true;
  stageInputsLocked = true;
  lastFinishedBy = finishedBy === 'time_up' ? 'time_up' : 'finish';
  stopAllTimers();

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen?.();
    }
  } catch {
    // Ignore
  }

  const answers = collectCurrentAnswers();
  phase = 'results';
  document.body.classList.remove('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  if (normalContainer) normalContainer.style.display = 'block';
  if (stageRoot) {
    stageRoot.style.display = 'none';
    stageRoot.innerHTML = '';
  }

  renderSubmittingState();

  try {
    const limitSeconds = getActiveStageLimitSeconds();
    const measuredUsedSeconds = lastFinishedBy === 'time_up'
      ? limitSeconds
      : Math.max(0.1, Math.min(limitSeconds, (performance.now() - stageStartPerfMs) / 1000));

    const response = await callMemoriadApi({
      action: 'submit',
      session_id: sessionData.session_id,
      answers,
      finished_by: lastFinishedBy,
      duration_seconds: measuredUsedSeconds,
    });
    if (response?.saved && response?.activity_row) {
      try {
        const raw = window.sessionStorage.getItem('tt_preview_memoriad_results');
        const existing = raw ? JSON.parse(raw) : [];
        const list = Array.isArray(existing) ? existing : [];
        const filtered = list.filter((r) => r && r.id !== response.activity_row.id);
        filtered.unshift(response.activity_row);
        window.sessionStorage.setItem(
          'tt_preview_memoriad_results',
          JSON.stringify(filtered.slice(0, 100))
        );
      } catch {
        // Ignore sessionStorage errors
      }
    }
    lastSubmissionResult = response;
    lastSubmissionError = null;

    // Check for homework assignment linking
    const urlParams = new URLSearchParams(window.location.search);
    const homeworkId = urlParams.get('homework_id');
    if (homeworkId && activeSessionId) {
      try {
        const hwRes = await submitHomeworkCompletion(homeworkId, {
          sessionId: activeSessionId,
          activityResultId: response?.result_id || null,
        });
        if (hwRes?.success) {
          showToast('success', `Homework credited (${hwRes.progress_count || 1} of ${hwRes.required_count || 1} completed)`);
        }
      } catch (hwErr) {
        console.warn('Homework submission crediting failed:', hwErr);
      }
    }

    isSubmitting = false;
    renderResultsView();
  } catch (err) {
    isSubmitting = false;
    lastSubmissionError = {
      message: err?.message || 'Could not send your answers. Please check your connection and try again.',
      isNetworkError: Boolean(err?.isNetworkError),
    };
    renderSubmissionErrorView();
  }
}

function renderSubmittingState() {
  const viewRoot = document.getElementById('memoriad-view-root');
  if (!viewRoot) return;
  viewRoot.innerHTML = `
    <div class="card" style="max-width: 560px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
      <div class="loading-state">Checking your answers and recording your score...</div>
    </div>
  `;
}

function renderSubmissionErrorView() {
  const viewRoot = document.getElementById('memoriad-view-root');
  if (!viewRoot || !lastSubmissionError) return;

  const retryButtonHtml = lastSubmissionError.isNetworkError
    ? `
      <button type="button" id="btn-retry-submit" class="btn btn-primary">
        Try sending again
      </button>
    `
    : '';

  const tryAgainBtnHtml = isTestMode
    ? ''
    : `
      <button type="button" id="btn-error-try-again" class="btn btn-secondary">
        Try again
      </button>
    `;

  const backHref = isTestMode
    ? '/pages/weekly-test.html'
    : (activeTodoTaskId ? '/pages/student.html' : '/pages/memoriad.html');
  const backLabel = isTestMode
    ? 'Back to Weekly Test'
    : (activeTodoTaskId ? 'Back to Daily Tasks' : 'Back to Memoriad');

  viewRoot.innerHTML = `
    <div class="card" style="max-width: 620px; margin: var(--space-6) auto; padding: var(--space-6);">
      <h1 style="font-size: 1.35rem; margin-bottom: var(--space-2); color: var(--color-danger);">
        Could Not Complete Submission
      </h1>
      <p style="font-size: var(--text-sm); color: var(--text-main); margin-bottom: var(--space-4);">
        ${escapeHtml(lastSubmissionError.message)}
      </p>
      <div style="display: flex; gap: var(--space-3); flex-wrap: wrap;">
        ${retryButtonHtml}
        ${tryAgainBtnHtml}
        <a href="${backHref}" class="btn btn-outline" style="text-decoration: none;">
          ${backLabel}
        </a>
      </div>
    </div>
  `;

  document.getElementById('btn-retry-submit')?.addEventListener('click', () => {
    submitCurrentSession(lastFinishedBy);
  });
  document.getElementById('btn-error-try-again')?.addEventListener('click', () => {
    if (activeTodoTaskId) {
    startAssignedMemoriadPractice();
  } else {
    renderSettingsView();
  }
  });
}

export function deriveMemoriadSaveBanner(
  res,
  { isTestMode = false, activeTestTitle = 'Weekly Test' } = {}
) {
  if (!res) {
    return {
      text: 'No questions were attempted, so no score was saved.',
      bannerClass: 'banner-demo',
      saved: false,
      emptyExpiry: false,
    };
  }

  const isSaved = Boolean(res.saved);
  const attempted = Number(res.attempted ?? res.total) || 0;
  const isEmptyExpiry = Boolean(res.empty_expiry) || (isSaved && attempted === 0);

  if (isSaved && isEmptyExpiry) {
    const emptySavedMessage =
      res.message && typeof res.message === 'string' && res.message.trim()
        ? res.message
        : 'Attempt saved. No questions were answered, so this round earned no Daily To-do credit.';
    return {
      text: emptySavedMessage,
      bannerClass: 'banner-info',
      saved: true,
      emptyExpiry: true,
    };
  }

  if (isSaved) {
    const testTitle = res.test_title || activeTestTitle;
    return {
      text: isTestMode ? `Saved as part of ${testTitle}` : 'Saved to your scores.',
      bannerClass: 'banner-success',
      saved: true,
      emptyExpiry: false,
    };
  }

  // Actually unsaved attempt
  const unsavedMessage =
    res.message && typeof res.message === 'string' && res.message.trim()
      ? res.message
      : 'No questions were attempted, so no score was saved.';

  return {
    text: unsavedMessage,
    bannerClass: 'banner-demo',
    saved: false,
    emptyExpiry: false,
  };
}

function renderResultsView() {
  const viewRoot = document.getElementById('memoriad-view-root');
  if (!viewRoot || !lastSubmissionResult) return;

  const res = lastSubmissionResult;
  const feedback = getScoreFeedback(res.correct, res.attempted);
  const usedSecondsFormatted = Number(res.used_seconds || 0).toFixed(2);
  const bannerInfo = deriveMemoriadSaveBanner(res, { isTestMode, activeTestTitle });
  const saveBannerText = bannerInfo.text;
  const saveBannerClass = bannerInfo.bannerClass;

  const isSquareRoots = activeModuleKey === 'square_roots' || res.module === 'square_roots';
  const detailRows = Array.isArray(res.detail) ? res.detail : [];
  const tableRowsHtml = detailRows
    .map((row, idx) => {
      let questionDisplay = row.question_summary || `Question ${row.index || idx + 1}`;
      let expectedDisplay = row.expected_display ?? '';
      let givenDisplay = row.attempted ? (row.given_display ?? '') : 'Not answered';

      if (activeModuleKey === 'calendar' && sessionData?.questions?.[idx]) {
        questionDisplay = formatCalendarDate(
          sessionData.questions[idx],
          currentSettings.date_format
        );
        expectedDisplay = formatDayLabel(row.expected, currentSettings.day_style);
        givenDisplay = row.attempted
          ? formatDayLabel(row.given, currentSettings.day_style)
          : 'Not answered';
      }

      if (isSquareRoots) {
        const k = Number(row.correct_digits) || 0;
        const pts = Number(row.points) || 0;
        const maxDigits =
          Number(row.max_digits) ||
          String(row.expected_display ?? row.expected ?? '').replace(/\D/g, '').length ||
          8;
        const statusBadge = !row.attempted
          ? `<span class="score-tag score-tag-neutral">&mdash; Not answered</span>`
          : row.correct
            ? `<span class="score-tag score-tag-perfect">&#10003; All ${maxDigits} digits</span>`
            : k > 0
              ? `<span class="score-tag score-tag-good">&#10003; ${k}/${maxDigits} digits</span>`
              : `<span class="score-tag score-tag-invalid">&#10007; 0 digits</span>`;

        return `
          <tr>
            <td class="num" style="font-weight: 700;">${row.index || idx + 1}</td>
            <td class="num">${escapeHtml(questionDisplay)}</td>
            <td class="num" style="font-weight: 700;">${escapeHtml(expectedDisplay)}</td>
            <td class="num" style="color: ${row.attempted ? 'var(--text-main)' : 'var(--text-dim)'};">
              ${escapeHtml(givenDisplay)}
            </td>
            <td class="num" style="font-weight: 700;">${row.attempted ? `${k} / ${maxDigits}` : `0 / ${maxDigits}`}</td>
            <td class="num" style="font-weight: 800; color: var(--color-primary);">${pts}</td>
            <td style="text-align: right;">${statusBadge}</td>
          </tr>
        `;
      }

      const statusBadge = !row.attempted
        ? `<span class="score-tag score-tag-neutral">&mdash; Not answered</span>`
        : row.correct
          ? `<span class="score-tag score-tag-perfect">&#10003; Correct</span>`
          : `<span class="score-tag score-tag-invalid">&#10007; Wrong</span>`;

      return `
        <tr>
          <td class="num" style="font-weight: 700;">${row.index || idx + 1}</td>
          <td class="num">${escapeHtml(questionDisplay)}</td>
          <td class="num" style="font-weight: 700;">${escapeHtml(expectedDisplay)}</td>
          <td class="num" style="color: ${row.attempted ? 'var(--text-main)' : 'var(--text-dim)'};">
            ${escapeHtml(givenDisplay)}
          </td>
          <td style="text-align: right;">${statusBadge}</td>
        </tr>
      `;
    })
    .join('');

  const tableHeaderHtml = isSquareRoots
    ? `
      <tr>
        <th style="width: 52px;">#</th>
        <th>Question</th>
        <th>Correct Answer</th>
        <th>Your Answer</th>
        <th>Correct Digits</th>
        <th>Points</th>
        <th style="text-align: right;">Result</th>
      </tr>
    `
    : `
      <tr>
        <th style="width: 60px;">#</th>
        <th>Question</th>
        <th>Correct Answer</th>
        <th>Your Answer</th>
        <th style="text-align: right;">Result</th>
      </tr>
    `;

  viewRoot.innerHTML = `
    <div style="max-width: 900px; margin: 0 auto;">
      <div class="banner ${saveBannerClass}" style="margin-bottom: var(--space-4);">
        <span class="banner-icon" aria-hidden="true">${res.saved ? (bannerInfo.emptyExpiry ? 'ℹ️' : '✅') : 'ℹ️'}</span>
        <div class="banner-body">
          <strong>${escapeHtml(saveBannerText)}</strong>
        </div>
      </div>

      <section class="card" style="padding: var(--space-6); margin-bottom: var(--space-5);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-4); margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border-hairline);">
          <div>
            <span class="badge badge-role" style="margin-bottom: 6px;">Competition Results</span>
            <h1 style="font-size: 1.5rem; margin: 0;">${escapeHtml(res.title || MODULE_META[activeModuleKey].title)}</h1>
          </div>

          <div style="display: flex; gap: var(--space-2);">
            ${
              isTestMode
                ? `<a href="/pages/weekly-test.html" class="btn btn-primary" style="text-decoration: none;">Back to Weekly Test</a>`
                : activeTodoTaskId
                  ? `
                    <button type="button" id="btn-results-try-again" class="btn btn-primary">
                      Try assigned practice again
                    </button>
                    <a href="/pages/student.html" class="btn btn-outline" style="text-decoration: none;">
                      Back to Daily Tasks
                    </a>
                  `
                  : `
                    <button type="button" id="btn-results-try-again" class="btn btn-primary">
                      Try again
                    </button>
                    <a href="/pages/memoriad.html" class="btn btn-outline" style="text-decoration: none;">
                      Back to Memoriad
                    </a>
                  `
            }
          </div>
        </div>

        <!-- Summary Metrics -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-5);">
          <div style="background: var(--bg-surface-subtle); border: 2px solid var(--color-primary); border-radius: var(--radius-md); padding: var(--space-4); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted);">
              SCORE
            </div>
            <div class="num" style="font-size: 2.4rem; font-weight: 900; color: var(--color-primary); line-height: 1.1; margin-top: 4px;">
              ${res.score}
            </div>
            ${
              Number.isFinite(Number(res.official_points)) && res.official_points !== null
                ? `<div class="num" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;" title="Memoriad points = score × time limit ÷ time used (only when every answer is finished)">${escapeHtml(Number(res.official_points).toFixed(2))} Memoriad points</div>`
                : ''
            }
          </div>

          <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-4); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted);">
              # of Correct Answers
            </div>
            <div class="num" style="font-size: 1.65rem; font-weight: 800; color: ${feedback.colorVar}; margin-top: 8px;">
              ${res.correct}
            </div>
            ${
              isSquareRoots && res.digits_total !== undefined
                ? `<div class="num" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${res.digits_total} matching digits</div>`
                : ''
            }
          </div>

          <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-4); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted);">
              Used Time
            </div>
            <div class="num" style="font-size: 1.65rem; font-weight: 800; color: var(--text-main); margin-top: 8px;">
              ${escapeHtml(usedSecondsFormatted)}s
            </div>
          </div>

          <div style="background: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); padding: var(--space-4); text-align: center;">
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted);">
              Attempted
            </div>
            <div class="num" style="font-size: 1.65rem; font-weight: 800; color: var(--text-main); margin-top: 8px;">
              ${res.attempted} / ${res.questions_total}
            </div>
            <div style="margin-top: 4px;">
              <span class="score-tag ${feedback.badgeClass}" style="font-size: 11px;">${escapeHtml(feedback.wrongText)}</span>
            </div>
          </div>
        </div>

        <!-- Full Question Breakdown Table -->
        <h2 style="font-size: var(--text-base); font-weight: 700; margin-bottom: var(--space-3);">
          Question-by-Question Review
        </h2>
        <div class="table-responsive" style="border: 1px solid var(--border-hairline); border-radius: var(--radius-md);">
          <table class="data-table" style="margin: 0;">
            <thead>
              ${tableHeaderHtml}
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  document.getElementById('btn-results-try-again')?.addEventListener('click', () => {
    if (activeTodoTaskId) {
    startAssignedMemoriadPractice();
  } else {
    renderSettingsView();
  }
  });
}

/* ============================================================================
 * API CLIENT & DEMO MODE FALLBACK
 * ========================================================================== */

async function callMemoriadApi(payload) {
  if (isDemoMode() || !isSupabaseConfigured()) {
    if (isTestMode) {
      if (payload.action === 'start') {
        return DemoDB.mockStartWeeklyTestSection(
          currentProfile?.id,
          activeTestId,
          null,
          activeSectionId
        );
      }
      return DemoDB.mockSubmitWeeklyTestSection(
        currentProfile?.id,
        payload.session_id,
        payload.answers
      );
    }
    if (payload.action === 'start') {
      const st = { ...(payload.settings || {}) };
      if (payload.todo_task_id && DemoDB?.getTodo) {
        const t = DemoDB.getTodo(payload.todo_task_id);
        if (t && Number(t.duration_seconds) > 0) {
          st.duration_seconds = Number(t.duration_seconds);
          st.time_limit_seconds = Number(t.duration_seconds);
        }
      }
      return DemoDB.mockMemoriadStart(payload.module, st);
    }
    return DemoDB.mockMemoriadSubmit(
      payload.session_id,
      activeModuleKey,
      payload.answers,
      currentProfile?.id,
      {
        ...currentSettings,
        ...(activeTodoTaskId ? { todo_task_id: activeTodoTaskId } : {}),
        duration_seconds: payload.duration_seconds,
      },
      payload.finished_by
    );
  }

  const supabase = await getSupabase();
  const { data: sessionDataAuth } = await supabase.auth.getSession();
  const token = sessionDataAuth?.session?.access_token;
  const endpoint = isTestMode ? '/api/weekly-test' : '/api/memoriad';

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    const netErr = new Error(
      'Network problem while sending your answers. Your answers are still safe on this screen — click "Try sending again".'
    );
    netErr.isNetworkError = true;
    throw netErr;
  }

  let data = null;
  try {
    const rawText = await res.text();
    data = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    const parseErr = new Error('Received an unexpected response. Please try again.');
    parseErr.isNetworkError = res.status >= 500;
    throw parseErr;
  }

  if (!res.ok) {
    const serverErr = new Error(data?.error || `Request could not be completed (HTTP ${res.status}).`);
    serverErr.isNetworkError = res.status >= 500;
    throw serverErr;
  }

  if (!data || typeof data !== 'object') {
    const emptyErr = new Error('Received an unexpected response. Please try again.');
    emptyErr.isNetworkError = true;
    throw emptyErr;
  }

  return data;
}

function stopAllTimers() {
  if (timerIntervalId !== null) {
    window.clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
  if (concentrationRafId !== null) {
    window.cancelAnimationFrame(concentrationRafId);
    concentrationRafId = null;
  }
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
        Fixed pre-baked competition questions and evaluation are used for preview.
      </div>
    </div>
  `;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initMemoriadPlay);
}
