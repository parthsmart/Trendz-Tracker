/**
 * Trendz Tracker — Flash Anzan Pure Statistics & Settings Module (js/flashStats.js)
 *
 * Pure, commented functions for Phase 7b (one question per try):
 * - `settingsKey(settings)`: canonical key `(digits, count, speed_ms, mode)` ignoring `questions` and `session_id`
 * - `statsByKey(rows)`: per-settings tries, correct, and success rate (`sum(correct) / sum(total)`) so legacy multi-question rows still count
 * - `recentTries(rows, limit = 20)`: last 20 tries with IST date, settings summary, "Correct" / "Wrong" (or "n of m correct" for old rows), and time
 * - `triesThisWeek(rows, nowOrTodayIST)`: Monday–Sunday week filter in India time (`Asia/Kolkata`)
 * - Settings validation, clamping, duration estimation, and friendly RPC error formatting
 *
 * Zero DOM or browser-only dependencies (`node --test` compatible).
 */

export const FLASH_LIMITS = Object.freeze({
  DIGITS_MIN: 1,
  DIGITS_MAX: 5,
  COUNT_MIN: 2,
  COUNT_MAX: 1000,
  SPEED_MS_MIN: 200,
  SPEED_MS_MAX: 5000,
  SPEED_MS_STEP: 100,
  MODES: Object.freeze(['add', 'add_sub']),
  CONFIRM_DURATION_SECONDS: 300, // 5 minutes
  MAX_SHOW_NUMBERS_COUNT: 100,
  MAX_ANSWER_DIGITS: 10,
});

export const DEFAULT_FLASH_SETTINGS = Object.freeze({
  digits: 1,
  count: 10,
  speed_ms: 1000,
  mode: 'add',
});

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * Converts seconds (e.g. 1.5) to integer milliseconds rounded to nearest 100 ms step (e.g. 1500).
 */
export function secondsToSpeedMs(seconds) {
  const num = Number(seconds);
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num * 10) * 100;
}

/**
 * Converts speed_ms (e.g. 1500) to seconds number (e.g. 1.5).
 */
export function speedMsToSeconds(speedMs) {
  const num = Number(speedMs);
  if (!Number.isFinite(num)) return NaN;
  return Math.round(num / 100) / 10;
}

/**
 * Silently clamps raw settings into valid Flash Anzan ranges:
 * - digits: 1..5
 * - count: 2..1000
 * - speed_ms: 200..5000 (step 100)
 * - mode: 'add' | 'add_sub'
 */
export function clampFlashSettings(raw = {}) {
  const dRaw = Number(raw?.digits);
  const digits = Number.isFinite(dRaw)
    ? Math.max(FLASH_LIMITS.DIGITS_MIN, Math.min(FLASH_LIMITS.DIGITS_MAX, Math.round(dRaw)))
    : DEFAULT_FLASH_SETTINGS.digits;

  const cRaw = Number(raw?.count);
  const count = Number.isFinite(cRaw)
    ? Math.max(FLASH_LIMITS.COUNT_MIN, Math.min(FLASH_LIMITS.COUNT_MAX, Math.round(cRaw)))
    : DEFAULT_FLASH_SETTINGS.count;

  const sRaw =
    raw?.speed_ms !== undefined && raw?.speed_ms !== null
      ? Number(raw.speed_ms)
      : secondsToSpeedMs(raw?.speed_seconds);
  const roundedSpeed = Number.isFinite(sRaw)
    ? Math.round(sRaw / 100) * 100
    : DEFAULT_FLASH_SETTINGS.speed_ms;
  const speed_ms = Math.max(
    FLASH_LIMITS.SPEED_MS_MIN,
    Math.min(FLASH_LIMITS.SPEED_MS_MAX, roundedSpeed)
  );

  const mode = raw?.mode === 'add_sub' ? 'add_sub' : 'add';

  return {
    digits,
    count,
    speed_ms,
    mode,
  };
}

/**
 * Validates Flash Anzan settings against `flash_start(p_settings)` limits:
 * - digits: 1 to 5
 * - count: 2 to 1000
 * - speed_ms: 200 to 5000
 * - mode: 'add' or 'add_sub'
 * (Strictly omits `questions`.)
 */
export function validateFlashSettings(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return {
      valid: false,
      errors: ['Settings are missing.'],
      settings: null,
    };
  }

  const digits = Number(raw.digits);
  const count = Number(raw.count);
  const speed_ms =
    raw.speed_ms !== undefined && raw.speed_ms !== null
      ? Math.round(Number(raw.speed_ms))
      : secondsToSpeedMs(raw.speed_seconds);
  const mode = typeof raw.mode === 'string' ? raw.mode.trim() : '';

  if (
    !Number.isInteger(digits) ||
    digits < FLASH_LIMITS.DIGITS_MIN ||
    digits > FLASH_LIMITS.DIGITS_MAX
  ) {
    errors.push(
      `Digits must be a whole number from ${FLASH_LIMITS.DIGITS_MIN} to ${FLASH_LIMITS.DIGITS_MAX}.`
    );
  }

  if (
    !Number.isInteger(count) ||
    count < FLASH_LIMITS.COUNT_MIN ||
    count > FLASH_LIMITS.COUNT_MAX
  ) {
    errors.push(
      `Numbers in the question must be a whole number from ${FLASH_LIMITS.COUNT_MIN} to ${FLASH_LIMITS.COUNT_MAX}.`
    );
  }

  if (
    !Number.isInteger(speed_ms) ||
    speed_ms < FLASH_LIMITS.SPEED_MS_MIN ||
    speed_ms > FLASH_LIMITS.SPEED_MS_MAX
  ) {
    errors.push('Speed per number must be between 0.2 seconds and 5.0 seconds.');
  }

  if (!FLASH_LIMITS.MODES.includes(mode)) {
    errors.push('Mode must be "Add only" or "Add and subtract".');
  }

  if (errors.length > 0) {
    return { valid: false, errors, settings: null };
  }

  return {
    valid: true,
    errors: [],
    settings: {
      digits,
      count,
      speed_ms,
      mode,
    },
  };
}

/**
 * Formats speed_ms as seconds per number and numbers per second.
 */
export function formatSpeedDisplay(speedMs) {
  const ms = Number(speedMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    return {
      secondsValue: '—',
      secondsText: '— s',
      perSecondValue: '—',
      perSecondText: '— numbers/sec',
      combinedText: '—',
    };
  }

  const sec = ms / 1000;
  const secondsValue = sec.toFixed(1);
  const secondsText = `${secondsValue} s`;

  const perSec = 1000 / ms;
  const perSecondValue = Number.isInteger(Math.round(perSec * 100) / 10)
    ? perSec.toFixed(1)
    : perSec.toFixed(2);
  const perSecondText = `${perSecondValue} numbers/sec`;

  return {
    secondsValue,
    secondsText,
    perSecondValue,
    perSecondText,
    combinedText: `${secondsText} (${perSecondText})`,
  };
}

/**
 * Formats the one-line settings summary required by the specification:
 * e.g. "2 digits - 50 numbers - 1.0 s - add" or "3 digits - 10 numbers - 1.0 s - add & subtract"
 */
export function formatFlashSettingsSummary(settings = {}) {
  if (!settings || typeof settings !== 'object') return 'Flash Anzan';
  const digits = Number(settings.digits) || 1;
  const count = Number(settings.count) || 2;
  const speedMs = Number(settings.speed_ms) || 1000;
  const modeLabel = settings.mode === 'add_sub' ? 'add & subtract' : 'add';
  const speedSec = (speedMs / 1000).toFixed(1);

  return `${digits} ${digits === 1 ? 'digit' : 'digits'} - ${count} numbers - ${speedSec} s - ${modeLabel}`;
}

/**
 * Computes the expected duration (`count * speed_ms`) and whether it exceeds 5 minutes.
 */
export function getExpectedDurationInfo(settings = {}) {
  const count = Math.max(0, Number(settings?.count) || 0);
  const speedMs = Math.max(0, Number(settings?.speed_ms) || 0);
  const durationMs = count * speedMs;
  const durationSeconds = Math.round(durationMs / 100) / 10;
  const requiresConfirmation = durationSeconds > FLASH_LIMITS.CONFIRM_DURATION_SECONDS;
  const approxMinutes = Math.max(1, Math.round(durationSeconds / 60));

  let displayText = '';
  if (durationSeconds < 60) {
    displayText = `${Number.isInteger(durationSeconds) ? durationSeconds : durationSeconds.toFixed(1)} seconds`;
  } else {
    const mins = Math.floor(durationSeconds / 60);
    const secs = Math.round(durationSeconds % 60);
    if (secs === 0) {
      displayText = `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
    } else {
      displayText = `${mins} min ${secs} s (about ${approxMinutes} ${approxMinutes === 1 ? 'minute' : 'minutes'})`;
    }
  }

  return {
    durationMs,
    durationSeconds,
    approxMinutes,
    requiresConfirmation,
    displayText,
    confirmMessage: `This will take about ${approxMinutes} minutes. Start?`,
  };
}

/**
 * Builds a canonical settings key from `(digits, count, speed_ms, mode)`,
 * strictly ignoring `"questions"`, `"session_id"`, and any other keys.
 *
 * @param {object} settings
 * @returns {string|null} Canonical key `"digits|count|speed_ms|mode"` or `null` if invalid
 */
export function settingsKey(settings) {
  if (!settings || typeof settings !== 'object') return null;

  const digits = Number(settings.digits);
  const count = Number(settings.count);
  const speed_ms = Number(settings.speed_ms);
  const mode =
    settings.mode === 'add_sub'
      ? 'add_sub'
      : settings.mode === 'add'
        ? 'add'
        : null;

  if (
    !Number.isInteger(digits) ||
    digits <= 0 ||
    !Number.isInteger(count) ||
    count <= 0 ||
    !Number.isInteger(speed_ms) ||
    speed_ms <= 0 ||
    !mode
  ) {
    return null;
  }

  return `${digits}|${count}|${speed_ms}|${mode}`;
}

/**
 * Checks whether an `activity_results` row belongs to Flash Anzan.
 */
function isFlashAnzanRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.activity_type) {
    return row.activity_type === 'flash_anzan';
  }
  return Boolean(row.settings && settingsKey(row.settings));
}

/**
 * Groups `activity_results` rows by exact settings combination `(digits, count, speed_ms, mode)`
 * ignoring `"questions"` and `"session_id"`.
 *
 * For each settings key, computes:
 * - `tries`: sum of `total` (so each new 1-question try adds 1, and old multi-question sets add `total`)
 * - `correct`: sum of `correct`
 * - `successRate`: `Math.round((sum(correct) / sum(total)) * 1000) / 10` (0 to 100%)
 * - `rowCount`: number of database rows matching this key
 *
 * Returns an array sorted by most-practised first (`tries` desc, then `correct` desc, then `key` asc).
 *
 * @param {Array<object>} rows
 * @returns {Array<{ key: string, settings: { digits: number, count: number, speed_ms: number, mode: string }, summary: string, tries: number, correct: number, successRate: number, rowCount: number }>}
 */
export function statsByKey(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const groups = new Map();

  for (const row of rows) {
    if (!isFlashAnzanRow(row)) continue;
    const key = settingsKey(row.settings);
    if (!key) continue;

    const totalVal = Number(row.total);
    const triesToAdd = Number.isFinite(totalVal) && totalVal > 0 ? totalVal : 1;
    const correctVal = Math.max(0, Number(row.correct) || 0);

    let entry = groups.get(key);
    if (!entry) {
      const cleanSettings = {
        digits: Number(row.settings.digits),
        count: Number(row.settings.count),
        speed_ms: Number(row.settings.speed_ms),
        mode: row.settings.mode === 'add_sub' ? 'add_sub' : 'add',
      };
      entry = {
        key,
        settings: cleanSettings,
        summary: formatFlashSettingsSummary(cleanSettings),
        tries: 0,
        correct: 0,
        successRate: 0,
        rowCount: 0,
      };
      groups.set(key, entry);
    }

    entry.tries += triesToAdd;
    entry.correct += correctVal;
    entry.rowCount += 1;
  }

  const list = Array.from(groups.values()).map((item) => ({
    ...item,
    successRate:
      item.tries > 0 ? Math.round((item.correct / item.tries) * 1000) / 10 : 0,
  }));

  list.sort((a, b) => {
    if (b.tries !== a.tries) return b.tries - a.tries;
    if (b.rowCount !== a.rowCount) return b.rowCount - a.rowCount;
    if (b.correct !== a.correct) return b.correct - a.correct;
    return a.key.localeCompare(b.key);
  });

  return list;
}

/**
 * Helper to look up stats for a specific settings object from `statsByKey(rows)`.
 */
export function getStatsForSettings(rows = [], targetSettings = {}) {
  const key = settingsKey(targetSettings);
  const allStats = statsByKey(rows);
  const found = key ? allStats.find((s) => s.key === key) : null;
  if (found) return found;

  const clean = clampFlashSettings(targetSettings);
  return {
    key: key || settingsKey(clean),
    settings: clean,
    summary: formatFlashSettingsSummary(clean),
    tries: 0,
    correct: 0,
    successRate: null,
    rowCount: 0,
  };
}

/**
 * Converts a Date or ISO timestamp into an IST (`Asia/Kolkata`) `YYYY-MM-DD` string.
 */
export function toISTDateString(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return '';
  const istTime = new Date(d.getTime() + IST_OFFSET_MS);
  const yyyy = istTime.getUTCFullYear();
  const mm = String(istTime.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istTime.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Formats an ISO timestamp or `YYYY-MM-DD` into a readable IST date (e.g. "19 Oct 2026").
 */
export function formatISTDateDisplay(dateInput) {
  const ymd =
    typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())
      ? dateInput.trim()
      : toISTDateString(dateInput);
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d} ${months[(m || 1) - 1]} ${y}`;
}

/**
 * Returns the most recent `limit` (default 20) Flash Anzan tries ordered newest first.
 * Old multi-question sets (`total > 1`) have `outcomeText = "n of m correct"`;
 * single-question tries (`total === 1`) have `outcomeText = "Correct"` or `"Wrong"`.
 *
 * @param {Array<object>} rows
 * @param {number} [limit=20]
 */
export function recentTries(rows = [], limit = 20) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const maxItems = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 20;

  const indexed = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isFlashAnzanRow(r)) continue;
    const ms = r.created_at ? Date.parse(r.created_at) : 0;
    indexed.push({
      row: r,
      idx: i,
      timeMs: Number.isFinite(ms) ? ms : 0,
    });
  }

  indexed.sort((a, b) => {
    if (b.timeMs !== a.timeMs) return b.timeMs - a.timeMs;
    return a.idx - b.idx;
  });

  return indexed.slice(0, maxItems).map(({ row }) => {
    const correct = Math.max(0, Number(row.correct) || 0);
    const total = Math.max(1, Number(row.total) || 1);
    const isMultiQuestion =
      total > 1 || (row.settings && Number(row.settings.questions) > 1);
    const outcomeText = isMultiQuestion
      ? `${correct} of ${total} correct`
      : correct >= 1
        ? 'Correct'
        : 'Wrong';

    return {
      ...row,
      correct,
      total,
      isMultiQuestion,
      outcomeText,
      isCorrect: !isMultiQuestion && correct >= 1,
      summary:
        row.settings && typeof row.settings === 'object'
          ? formatFlashSettingsSummary(row.settings)
          : row.activity_name || 'Flash Anzan',
      dateIST: row.created_at ? formatISTDateDisplay(row.created_at) : '—',
      time_seconds: Math.max(0, Number(row.time_seconds) || 0),
    };
  });
}

/**
 * Computes Monday `YYYY-MM-DD` and Sunday `YYYY-MM-DD` of the week containing `nowOrTodayIST`
 * in Indian Standard Time (`Asia/Kolkata`).
 */
export function getISTWeekBounds(nowOrTodayIST = new Date()) {
  let todayStr = '';
  if (
    typeof nowOrTodayIST === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(nowOrTodayIST.trim())
  ) {
    todayStr = nowOrTodayIST.trim();
  } else {
    todayStr = toISTDateString(nowOrTodayIST);
  }

  if (!todayStr) {
    todayStr = toISTDateString(new Date());
  }

  const [y, m, d] = todayStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = utcDate.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const mondayUtc = new Date(utcDate.getTime() - diffToMonday * 86400000);
  const sundayUtc = new Date(mondayUtc.getTime() + 6 * 86400000);

  const fmt = (dt) => {
    const yr = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const da = String(dt.getUTCDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  };

  return {
    mondayIST: fmt(mondayUtc),
    sundayIST: fmt(sundayUtc),
  };
}

/**
 * Filters `activity_results` rows for Flash Anzan completed in the current week
 * (Monday through Sunday in India time, `Asia/Kolkata`), ordered newest first.
 *
 * @param {Array<object>} rows
 * @param {Date|string|number} [nowOrTodayIST]
 * @returns {Array<object>}
 */
export function triesThisWeek(rows = [], nowOrTodayIST = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const { mondayIST, sundayIST } = getISTWeekBounds(nowOrTodayIST);

  const allSorted = recentTries(rows, rows.length);
  return allSorted.filter((row) => {
    if (!row.created_at) return false;
    const rowDateIST = toISTDateString(row.created_at);
    if (!rowDateIST) return false;
    return rowDateIST >= mondayIST && rowDateIST <= sundayIST;
  });
}

/**
 * Computes the summary metrics for the shared Flash Anzan dashboard card:
 * - `triesThisWeek`: total tries (`sum(total)`) completed this week in IST
 * - `correctThisWeek`: total correct (`sum(correct)`) this week in IST
 * - `mostPractised`: the top entry from `statsByKey(rows)` (or `null` if no history)
 */
export function buildFlashCardSummary(rows = [], nowOrTodayIST = new Date()) {
  const weekRows = triesThisWeek(rows, nowOrTodayIST);
  let triesCount = 0;
  let correctCount = 0;

  for (const r of weekRows) {
    const t = Number(r.total);
    triesCount += Number.isFinite(t) && t > 0 ? t : 1;
    correctCount += Math.max(0, Number(r.correct) || 0);
  }

  const byKey = statsByKey(rows);
  const mostPractised = byKey.length > 0 ? byKey[0] : null;

  return {
    triesThisWeek: triesCount,
    correctThisWeek: correctCount,
    weekRowsCount: weekRows.length,
    mostPractised,
  };
}

/**
 * Parses the digits-only answer box (up to 10 digits, no minus sign).
 * Returns `{ ok: boolean, value: number | null, error?: string }`.
 */
export function parseFlashAnswerInput(rawInput) {
  if (rawInput === null || rawInput === undefined) {
    return { ok: true, value: null };
  }
  const trimmed = String(rawInput).trim();
  if (trimmed === '') {
    return {
      ok: false,
      value: null,
      error: 'Please enter your answer in digits (or click "I don\'t know").',
    };
  }
  if (!/^\d{1,10}$/.test(trimmed)) {
    return {
      ok: false,
      value: null,
      error: 'Please enter up to 10 digits only (0–9, no minus sign).',
    };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return {
      ok: false,
      value: null,
      error: 'The number entered is out of range.',
    };
  }
  return { ok: true, value: parsed };
}

/**
 * Maps raw database RPC errors from `flash_start` / `flash_submit` to friendly student messages.
 */
export function friendlyFlashError(err, context = 'general') {
  const rawMsg =
    typeof err === 'string'
      ? err
      : err?.message || err?.error_description || err?.details || '';
  const msg = String(rawMsg).trim();
  const lower = msg.toLowerCase();

  if (!msg) {
    return context === 'submit'
      ? 'Could not submit your answer right now. Please check your connection and try again.'
      : 'Could not start the Flash Anzan try right now. Please try again.';
  }

  // Rate limit (> 300 tries per hour)
  if (
    lower.includes('300') ||
    lower.includes('per hour') ||
    lower.includes('rate limit') ||
    lower.includes('too many')
  ) {
    return 'You have already started 300 Flash Anzan tries in the last hour. Please take a short break and try again soon.';
  }

  // Expired try
  if (lower.includes('expired') || lower.includes('timed out')) {
    return 'This Flash Anzan try has expired. Please start a new try.';
  }

  // Already submitted
  if (
    lower.includes('already submitted') ||
    lower.includes('already completed') ||
    lower.includes('already used')
  ) {
    return 'This Flash Anzan try has already been submitted. Start a new try to continue practicing.';
  }

  // Answered faster than numbers were shown
  if (
    lower.includes('faster') ||
    lower.includes('too fast') ||
    lower.includes('minimum time') ||
    lower.includes('before the numbers')
  ) {
    return 'That answer was sent faster than the numbers were shown. Please watch all the numbers before answering.';
  }

  // Invalid settings
  if (
    lower.includes('invalid') &&
    (lower.includes('setting') ||
      lower.includes('digit') ||
      lower.includes('count') ||
      lower.includes('speed') ||
      lower.includes('mode'))
  ) {
    return 'Some settings are outside the allowed limits (1–5 digits, 2–1000 numbers, 0.2–5.0s speed). Please check your settings and try again.';
  }

  return msg;
}
