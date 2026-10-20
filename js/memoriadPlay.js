/**
 * Trendz Tracker — Memoriad Competition Stage Controller (js/memoriadPlay.js)
 *
 * Implements the 4-phase single-page competition flow on `/pages/memoriad-play.html?module=<key>`:
 * 1. Settings (persisted per module in `localStorage` inside `try/catch`)
 * 2. Concentration (fetches session via `POST /api/memoriad` `{ action: 'start' }`,
 *    keeps questions in JS memory only, displays large countdown from `concentration_seconds` to `0`)
 * 3. Stage (1280x800 no-scroll competition layout for `calendar` or `additions`,
 *    hide site navigation, Fullscreen button, Exit confirmation, upward-counting timer,
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
import { highlightedColumns } from './columnHighlight.js';
import { getScoreFeedback } from './scoreColors.js';

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
    highlight_columns: 1, // 1 | 2
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
    return { ...defaults, ...parsed };
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

// Active Session State (held in JS memory; never rendered until Stage begins)
let sessionData = null; // { session_id, module, title, questions, settings }
let activeQuestionIndex = 0;
let calendarAnswers = []; // Array<number|null> (0..6 or null)
let additionsSlots = []; // Array<SlotState>
let additionsManualStepOffsets = []; // Array<number>
let stageStartPerfMs = 0;
let timerIntervalId = null;
let concentrationRafId = null;
let lastSubmissionResult = null;
let lastSubmissionError = null;
let isSubmitting = false;

async function initMemoriadPlay() {
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;
  currentProfile = profile;

  renderHeaderUser(profile);
  if (isDemoMode()) {
    renderDemoBanner();
  }

  const params = new URLSearchParams(window.location.search);
  const requestedModule = (params.get('module') || 'calendar').trim().toLowerCase();

  if (!MODULE_META[requestedModule]) {
    renderUnsupportedModule(requestedModule);
    return;
  }

  activeModuleKey = requestedModule;
  currentSettings = loadModuleSettings(activeModuleKey);

  window.addEventListener('keydown', handleGlobalStageKeydown);
  renderSettingsView();
}

function renderUnsupportedModule(moduleKey) {
  const root = document.getElementById('memoriad-view-root');
  if (!root) return;
  root.innerHTML = `
    <div class="card" style="max-width: 580px; margin: var(--space-6) auto; padding: var(--space-6); text-align: center;">
      <h1 style="font-size: 1.35rem; margin-bottom: var(--space-2);">Module Not Available</h1>
      <p style="font-size: var(--text-sm); color: var(--text-muted); margin-bottom: var(--space-4);">
        The module <code>${escapeHtml(moduleKey)}</code> is coming in a later step.
      </p>
      <a href="/pages/memoriad.html" class="btn btn-primary" style="text-decoration: none;">
        &larr; Back to Memoriad
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

function renderSettingsView() {
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
    moduleSpecificFieldsHtml = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4);">
        <div class="form-group">
          <label for="setting-dates" class="form-label">Number of dates</label>
          <select id="setting-dates" class="form-control">
            ${[25, 50, 75, 100, 125]
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
            <option value="DD-MM-YYYY" ${s.date_format === 'DD-MM-YYYY' ? 'selected' : ''}>DD-MM-YYYY (e.g. 24-11-1873)</option>
            <option value="MM-DD-YYYY" ${s.date_format === 'MM-DD-YYYY' ? 'selected' : ''}>MM-DD-YYYY (e.g. 11-24-1873)</option>
            <option value="YYYY-MM-DD" ${s.date_format === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD (e.g. 1873-11-24)</option>
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
  } else {
    const s = currentSettings;
    moduleSpecificFieldsHtml = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4);">
        <div class="form-group">
          <label for="setting-typing-direction" class="form-label">Typing direction</label>
          <select id="setting-typing-direction" class="form-control">
            <option value="rtl" ${s.typing_direction !== 'ltr' ? 'selected' : ''}>Right to left (ones column first — default)</option>
            <option value="ltr" ${s.typing_direction === 'ltr' ? 'selected' : ''}>Left to right ( leftmost column first)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="setting-highlight-columns" class="form-label">Number of columns to highlight</label>
          <select id="setting-highlight-columns" class="form-control">
            <option value="1" ${Number(s.highlight_columns) !== 2 ? 'selected' : ''}>1 column at a time (default)</option>
            <option value="2" ${Number(s.highlight_columns) === 2 ? 'selected' : ''}>2 columns at a time</option>
          </select>
        </div>
      </div>
    `;
  }

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

        <form id="memoriad-settings-form">
          ${moduleSpecificFieldsHtml}

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--border-hairline);">
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
  } else {
    currentSettings = {
      typing_direction:
        document.getElementById('setting-typing-direction')?.value === 'ltr' ? 'ltr' : 'rtl',
      highlight_columns:
        Number(document.getElementById('setting-highlight-columns')?.value) === 2 ? 2 : 1,
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
    const apiSettings = {
      concentration_seconds: currentSettings.concentration_seconds,
      ...(activeModuleKey === 'calendar' ? { dates: currentSettings.dates } : {}),
    };

    const started = await callMemoriadApi({
      action: 'start',
      module: activeModuleKey,
      settings: apiSettings,
    });

    // Store questions in JS memory only; do not render them until Concentration finishes
    sessionData = started;
    activeQuestionIndex = 0;
    lastSubmissionResult = null;
    lastSubmissionError = null;

    if (activeModuleKey === 'calendar') {
      calendarAnswers = new Array(started.questions.length).fill(null);
    } else {
      additionsSlots = started.questions.map(() =>
        createAnswerSlots(11, currentSettings.typing_direction)
      );
      additionsManualStepOffsets = new Array(started.questions.length).fill(0);
    }

    if (currentSettings.concentration_seconds > 0) {
      enterConcentrationPhase(currentSettings.concentration_seconds);
    } else {
      enterStagePhase();
    }
  } catch (err) {
    if (errBox) {
      errBox.textContent = err?.message || 'Could not start the session. Please try again.';
      errBox.style.display = 'block';
    }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start Competition Stage →';
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

function enterStagePhase() {
  stopAllTimers();
  phase = 'stage';
  document.body.classList.add('memoriad-stage-mode');

  const normalContainer = document.getElementById('memoriad-normal-container');
  const stageRoot = document.getElementById('memoriad-stage-root');
  if (normalContainer) normalContainer.style.display = 'none';
  if (!stageRoot) return;
  stageRoot.style.display = 'block';

  stageStartPerfMs = performance.now();

  if (activeModuleKey === 'calendar') {
    renderCalendarStageShell(stageRoot);
    updateCalendarStageDOM();
  } else {
    renderAdditionsStageShell(stageRoot);
    updateAdditionsStageDOM();
  }

  bindStageChromeButtons();

  // Upward-counting timer (updated every 250ms via performance.now())
  timerIntervalId = window.setInterval(() => {
    if (phase !== 'stage') return;
    const elapsedSec = (performance.now() - stageStartPerfMs) / 1000;
    const timerEl = document.getElementById('comp-stage-timer');
    if (timerEl && currentSettings.timer_shown !== false) {
      timerEl.textContent = formatTimerMMSS(elapsedSec);
    }
  }, 250);
}

function renderCalendarStageShell(stageRoot) {
  const timerStyle = currentSettings.timer_shown === false ? 'display: none;' : '';
  stageRoot.innerHTML = `
    <div class="comp-stage-shell">
      <div class="comp-stage-topbar">
        <div style="display: flex; align-items: center; gap: var(--space-3);">
          <div id="comp-stage-timer" class="comp-timer-display" style="${timerStyle}">00:00</div>
          <div>
            <div style="font-size: var(--text-sm); font-weight: 800; color: var(--text-main);">
              Mental Calendar Dates
            </div>
            <div style="font-size: 11px; color: var(--text-muted);">
              Keys <code>0–7</code> select day &amp; jump to next unanswered &middot; <code>Enter</code> skip &middot; <code>+</code> / <code>-</code> or arrows move
            </div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span id="calendar-progress-pill" class="badge badge-role num">0 / ${sessionData.questions.length} answered</span>
          <button type="button" id="btn-stage-fullscreen" class="btn btn-outline btn-sm">
            Full Screen
          </button>
          <button type="button" id="btn-stage-exit" class="btn btn-outline btn-sm">
            Exit
          </button>
          <button type="button" id="btn-stage-finish" class="btn btn-primary btn-sm">
            FINISH
          </button>
        </div>
      </div>

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
  if (phase !== 'stage' || activeModuleKey !== 'calendar' || !sessionData) return;
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
  if (!sessionData) return;
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

function renderAdditionsStageShell(stageRoot) {
  const timerStyle = currentSettings.timer_shown === false ? 'display: none;' : '';
  stageRoot.innerHTML = `
    <div class="comp-stage-shell">
      <div class="comp-stage-topbar">
        <div style="display: flex; align-items: center; gap: var(--space-3);">
          <div id="comp-stage-timer" class="comp-timer-display" style="${timerStyle}">00:00</div>
          <div>
            <div style="font-size: var(--text-sm); font-weight: 800; color: var(--text-main);">
              Mental Additions (10 &times; 10-Digit Numbers)
            </div>
            <div style="font-size: 11px; color: var(--text-muted);">
              Digits <code>0–9</code> type &middot; <code>*</code> step col &middot; <code>/</code> unstep col &middot; <code>+</code> next &middot; <code>-</code> prev &middot; <code>Enter</code> compact &amp; next
            </div>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span id="additions-progress-pill" class="badge badge-role num">0 / 10 answered</span>
          <button type="button" id="btn-stage-fullscreen" class="btn btn-outline btn-sm">
            Full Screen
          </button>
          <button type="button" id="btn-stage-exit" class="btn btn-outline btn-sm">
            Exit
          </button>
          <button type="button" id="btn-stage-finish" class="btn btn-primary btn-sm">
            FINISH
          </button>
        </div>
      </div>

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
                <button type="button" id="btn-add-prev" class="btn btn-outline btn-sm" title="Previous question (-)">
                  &larr; Prev (<code>-</code>)
                </button>
                <button type="button" id="btn-add-unstep" class="btn btn-outline btn-sm" title="Move column highlight back (/)">
                  Col Back (<code>/</code>)
                </button>
                <button type="button" id="btn-add-step" class="btn btn-outline btn-sm" title="Advance column highlight (*)">
                  Col Step (<code>*</code>)
                </button>
                <button type="button" id="btn-add-next" class="btn btn-secondary btn-sm" title="Next question (+)">
                  Next (<code>+</code>) &rarr;
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
        const ansStr = toAnswerString(additionsSlots[idx]);
        const rowsHtml = tenNumbers.map((numStr) => `<div>${escapeHtml(numStr)}</div>`).join('');
        return `
          <div
            class="additions-mini-card ${isActive ? 'is-active' : ''}"
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
  if (!sessionData) return;
  const total = sessionData.questions.length;
  const next = Math.max(0, Math.min(total - 1, activeQuestionIndex + delta));
  if (next !== activeQuestionIndex) {
    activeQuestionIndex = next;
    updateAdditionsStageDOM();
  }
}

/* ============================================================================
 * KEYBOARD SHORTCUT HANDLER DURING STAGE
 * ========================================================================== */

function handleGlobalStageKeydown(e) {
  if (phase !== 'stage' || !sessionData || isSubmitting) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

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
      title: 'Discard This Practice Try?',
      message: 'Exiting now will discard your current answers without saving a score.',
      confirmLabel: 'Discard & Exit',
      onConfirm: () => {
        try {
          if (document.fullscreenElement) document.exitFullscreen?.();
        } catch {
          // Ignore
        }
        renderSettingsView();
      },
    });
  });

  finishBtn?.addEventListener('click', () => {
    submitCurrentSession();
  });
}

function promptFinishConfirmation() {
  openStageModal({
    title: 'Finish?',
    message: 'All 10 addition questions have answers. Submit your competition stage now?',
    confirmLabel: 'Finish & Submit',
    onConfirm: () => {
      submitCurrentSession();
    },
  });
}

function openStageModal({ title, message, confirmLabel, onConfirm }) {
  const existing = document.getElementById('comp-stage-inline-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'comp-stage-inline-modal';
  overlay.className = 'modal-backdrop active';
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
  return additionsSlots.map((st) => {
    const compacted = compact(st);
    const str = toAnswerString(compacted);
    return str.length > 0 ? str : null;
  });
}

async function submitCurrentSession() {
  if (!sessionData || isSubmitting) return;
  isSubmitting = true;
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
    const response = await callMemoriadApi({
      action: 'submit',
      session_id: sessionData.session_id,
      answers,
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
        <button type="button" id="btn-error-try-again" class="btn btn-secondary">
          Try again
        </button>
        <a href="/pages/memoriad.html" class="btn btn-outline" style="text-decoration: none;">
          Back to Memoriad
        </a>
      </div>
    </div>
  `;

  document.getElementById('btn-retry-submit')?.addEventListener('click', () => {
    submitCurrentSession();
  });
  document.getElementById('btn-error-try-again')?.addEventListener('click', () => {
    renderSettingsView();
  });
}

function renderResultsView() {
  const viewRoot = document.getElementById('memoriad-view-root');
  if (!viewRoot || !lastSubmissionResult) return;

  const res = lastSubmissionResult;
  const feedback = getScoreFeedback(res.correct, res.attempted);
  const usedSecondsFormatted = Number(res.used_seconds || 0).toFixed(2);
  const saveBannerText =
    res.attempted === 0 || res.saved === false
      ? 'No questions were attempted, so no score was saved.'
      : 'Saved to your scores.';
  const saveBannerClass =
    res.attempted === 0 || res.saved === false ? 'banner-demo' : 'banner-success';

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

  viewRoot.innerHTML = `
    <div style="max-width: 900px; margin: 0 auto;">
      <div class="banner ${saveBannerClass}" style="margin-bottom: var(--space-4);">
        <span class="banner-icon" aria-hidden="true">${res.saved ? '✅' : 'ℹ️'}</span>
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
            <button type="button" id="btn-results-try-again" class="btn btn-primary">
              Try again
            </button>
            <a href="/pages/memoriad.html" class="btn btn-outline" style="text-decoration: none;">
              Back to Memoriad
            </a>
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
              Correct
            </div>
            <div class="num" style="font-size: 1.65rem; font-weight: 800; color: ${feedback.colorVar}; margin-top: 8px;">
              ${res.correct}
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
              <tr>
                <th style="width: 60px;">#</th>
                <th>Question</th>
                <th>Correct Answer</th>
                <th>Your Answer</th>
                <th style="text-align: right;">Result</th>
              </tr>
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
    renderSettingsView();
  });
}

/* ============================================================================
 * API CLIENT & DEMO MODE FALLBACK
 * ========================================================================== */

async function callMemoriadApi(payload) {
  if (isDemoMode() || !isSupabaseConfigured()) {
    if (payload.action === 'start') {
      return DemoDB.mockMemoriadStart(payload.module, payload.settings);
    }
    return DemoDB.mockMemoriadSubmit(
      payload.session_id,
      activeModuleKey,
      payload.answers,
      currentProfile?.id,
      currentSettings
    );
  }

  const supabase = await getSupabase();
  const { data: sessionDataAuth } = await supabase.auth.getSession();
  const token = sessionDataAuth?.session?.access_token;

  let res;
  try {
    res = await fetch('/api/memoriad', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    const netErr = new Error(
      'Network error while contacting the server. Your answers are still safe on this screen — click "Try sending again".'
    );
    netErr.isNetworkError = true;
    throw netErr;
  }

  let data = null;
  try {
    const rawText = await res.text();
    data = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    const parseErr = new Error('Received an invalid response from the server.');
    parseErr.isNetworkError = res.status >= 500;
    throw parseErr;
  }

  if (!res.ok) {
    const serverErr = new Error(data?.error || `Request could not be completed (HTTP ${res.status}).`);
    serverErr.isNetworkError = res.status >= 500;
    throw serverErr;
  }

  if (!data || typeof data !== 'object') {
    const emptyErr = new Error('Received an invalid response from the server.');
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

document.addEventListener('DOMContentLoaded', initMemoriadPlay);
