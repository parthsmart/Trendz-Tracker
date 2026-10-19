/**
 * Trendz Tracker - Flash Anzan Presets & Validation Helpers (js/flashPresets.js)
 *
 * Pure constants and functions for:
 * - Preset definitions (Beginner, Intermediate, Advanced, Custom)
 * - Settings validation and normalization mirroring flash_start(p_settings) limits
 * - Speed formatting (seconds per number and numbers per second)
 * - Number sequence formatting and answer input parsing
 * - Friendly error message mapping for flash_start and flash_submit RPCs
 */

export const FLASH_LIMITS = Object.freeze({
  DIGITS_MIN: 1,
  DIGITS_MAX: 5,
  COUNT_MIN: 3,
  COUNT_MAX: 30,
  SPEED_MS_MIN: 200,
  SPEED_MS_MAX: 5000,
  SPEED_MS_STEP: 100,
  QUESTIONS_MIN: 3,
  QUESTIONS_MAX: 30,
  MODES: Object.freeze(['add', 'add_sub']),
});

export const FLASH_PRESETS = Object.freeze({
  beginner: Object.freeze({
    id: 'beginner',
    label: 'Beginner',
    description: '1 digit · 5 numbers · 2.0 s · Add only · 10 questions',
    settings: Object.freeze({
      digits: 1,
      count: 5,
      speed_ms: 2000,
      mode: 'add',
      questions: 10,
    }),
  }),
  intermediate: Object.freeze({
    id: 'intermediate',
    label: 'Intermediate',
    description: '2 digits · 7 numbers · 1.5 s · Add only · 10 questions',
    settings: Object.freeze({
      digits: 2,
      count: 7,
      speed_ms: 1500,
      mode: 'add',
      questions: 10,
    }),
  }),
  advanced: Object.freeze({
    id: 'advanced',
    label: 'Advanced',
    description: '3 digits · 10 numbers · 1.0 s · Add & subtract · 10 questions',
    settings: Object.freeze({
      digits: 3,
      count: 10,
      speed_ms: 1000,
      mode: 'add_sub',
      questions: 10,
    }),
  }),
  custom: Object.freeze({
    id: 'custom',
    label: 'Custom',
    description: 'Choose your own digits, count, speed, mode, and questions',
    settings: null,
  }),
});

export const FLASH_PRESET_LIST = Object.freeze([
  FLASH_PRESETS.beginner,
  FLASH_PRESETS.intermediate,
  FLASH_PRESETS.advanced,
  FLASH_PRESETS.custom,
]);

/**
 * Detects which preset ('beginner' | 'intermediate' | 'advanced' | 'custom')
 * matches the given settings object.
 */
export function detectFlashPreset(settings) {
  if (!settings || typeof settings !== 'object') return 'custom';
  const d = Number(settings.digits);
  const c = Number(settings.count);
  const s = Number(settings.speed_ms);
  const m = String(settings.mode || '');
  const q = Number(settings.questions);

  for (const key of ['beginner', 'intermediate', 'advanced']) {
    const p = FLASH_PRESETS[key].settings;
    if (
      p.digits === d &&
      p.count === c &&
      p.speed_ms === s &&
      p.mode === m &&
      p.questions === q
    ) {
      return key;
    }
  }
  return 'custom';
}

/**
 * Converts seconds (e.g. 1.5) to integer milliseconds rounded to nearest 100ms step (e.g. 1500).
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
 * Formats speed_ms as seconds per number and numbers per second.
 * Example: 1500 -> { secondsText: '1.5 s', perSecondText: '0.67 numbers/sec', combinedText: '1.5 s (0.67 numbers/sec)' }
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
  // Format cleanly: if integer or 1 decimal exact (like 1.0, 2.0, 2.5, 5.0), show 1 or 2 decimals cleanly
  const perSecondValue = Number.isInteger(perSec * 10)
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
 * Validates Flash Anzan settings against database RPC limits:
 * - digits: integer 1 to 5
 * - count: integer 3 to 30
 * - speed_ms: integer 200 to 5000
 * - questions: integer 3 to 30
 * - mode: 'add' or 'add_sub'
 *
 * Returns { valid: boolean, errors: string[], settings: object | null }
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
  const questions = Number(raw.questions);
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
      `Numbers per question must be a whole number from ${FLASH_LIMITS.COUNT_MIN} to ${FLASH_LIMITS.COUNT_MAX}.`
    );
  }

  if (
    !Number.isInteger(speed_ms) ||
    speed_ms < FLASH_LIMITS.SPEED_MS_MIN ||
    speed_ms > FLASH_LIMITS.SPEED_MS_MAX
  ) {
    errors.push('Speed per number must be between 0.2 seconds and 5.0 seconds.');
  }

  if (
    !Number.isInteger(questions) ||
    questions < FLASH_LIMITS.QUESTIONS_MIN ||
    questions > FLASH_LIMITS.QUESTIONS_MAX
  ) {
    errors.push(
      `Questions per set must be a whole number from ${FLASH_LIMITS.QUESTIONS_MIN} to ${FLASH_LIMITS.QUESTIONS_MAX}.`
    );
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
      questions,
      mode,
    },
  };
}

/**
 * Formats a concise human-readable summary of a Flash Anzan settings object.
 */
export function formatFlashSettingsSummary(settings = {}) {
  const digits = Number(settings.digits) || 1;
  const count = Number(settings.count) || 5;
  const speedMs = Number(settings.speed_ms) || 2000;
  const questions = Number(settings.questions);
  const mode = settings.mode === 'add_sub' ? 'Add & subtract' : 'Add only';
  const speedSec = (speedMs / 1000).toFixed(1);

  const parts = [
    `${digits} ${digits === 1 ? 'digit' : 'digits'}`,
    `${count} numbers`,
    `${speedSec}s/num`,
    mode,
  ];
  if (Number.isFinite(questions) && questions > 0) {
    parts.push(`${questions} questions`);
  }
  return parts.join(' · ');
}

/**
 * Formats an array of signed integers for the results breakdown table.
 * Example: [12, -5, 8] -> "12 − 5 + 8"
 */
export function formatNumberSequence(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return '—';
  return numbers
    .map((n, idx) => {
      const val = Number(n);
      if (!Number.isFinite(val)) return String(n);
      if (idx === 0) {
        return val < 0 ? `−${Math.abs(val)}` : `${val}`;
      }
      return val < 0 ? ` − ${Math.abs(val)}` : ` + ${val}`;
    })
    .join('');
}

/**
 * Parses a student's raw answer input into an integer or null (if blank/skipped).
 * Returns { ok: boolean, value: number | null, error?: string }
 */
export function parseFlashAnswerInput(rawInput) {
  if (rawInput === null || rawInput === undefined) {
    return { ok: true, value: null };
  }
  const normalized = String(rawInput)
    .trim()
    .replace(/[\u2212\u2013\u2014]/g, '-');

  if (normalized === '') {
    return { ok: true, value: null };
  }

  if (!/^[+-]?\d+$/.test(normalized)) {
    return {
      ok: false,
      value: null,
      error: 'Please enter a whole number (or click Skip Question).',
    };
  }

  const parsed = Number.parseInt(normalized, 10);
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
 * Maps raw database RPC errors from flash_start / flash_submit to friendly student messages.
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
      ? 'Could not submit your answers right now. Please check your connection and try again.'
      : 'Could not start the Flash Anzan set right now. Please try again.';
  }

  // Rate limit (> 60 sets per hour)
  if (
    lower.includes('60') ||
    lower.includes('per hour') ||
    lower.includes('rate limit') ||
    lower.includes('too many')
  ) {
    return 'You have already started 60 Flash Anzan sets in the last hour. Great dedication! Please take a short break and try again in a few minutes.';
  }

  // Expired set (30 minutes after minimum time)
  if (lower.includes('expired') || lower.includes('30 minute') || lower.includes('timed out')) {
    return 'This Flash Anzan session expired (sets must be finished within 30 minutes). Please start a fresh set.';
  }

  // Already submitted
  if (
    lower.includes('already submitted') ||
    lower.includes('already completed') ||
    lower.includes('already used')
  ) {
    return 'This Flash Anzan set has already been submitted. Start a new set to continue practicing.';
  }

  // Finished faster than numbers were shown
  if (
    lower.includes('faster') ||
    lower.includes('too fast') ||
    lower.includes('minimum time') ||
    lower.includes('before the numbers')
  ) {
    return 'This set was submitted faster than the numbers could be shown. Please let every question finish flashing before submitting.';
  }

  // Invalid settings
  if (
    lower.includes('invalid') &&
    (lower.includes('setting') ||
      lower.includes('digit') ||
      lower.includes('count') ||
      lower.includes('speed') ||
      lower.includes('question') ||
      lower.includes('mode'))
  ) {
    return 'Some settings are outside the allowed limits (1–5 digits, 3–30 numbers, 0.2–5.0s speed, 3–30 questions). Please check your settings and try again.';
  }

  return msg;
}
