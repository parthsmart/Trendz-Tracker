/**
 * Trendz Tracker — Pure Memoriad Competition Generator, Grader & Plausibility Engine (api/_memoriad.js)
 *
 * Pure server-side module with injectable RNG (`defaultRng` uses Node `crypto.randomInt`).
 * Supports Phase 9b-1 competition modules:
 * - `calendar` (Mental Calendar Dates: 25, 50, 75, 100, or 125 distinct Gregorian dates in 1600..2099)
 * - `additions` (Mental Additions: 10 questions of 10 ten-digit numbers summed with BigInt)
 * Plus catalog stubs for `multiplications` and `square_roots` ("Coming soon").
 *
 * SECURITY CONTRACT:
 * - Canonical expected answers are generated and evaluated exclusively on the server.
 * - `buildMemoriadStartResponse` strips `expected` before sending to the browser.
 */

import crypto from 'node:crypto';

export const CALENDAR_ALLOWED_DATES = [25, 50, 75, 100, 125];
export const CALENDAR_DEFAULT_DATES = 125;
export const CALENDAR_YEAR_MIN = 1600;
export const CALENDAR_YEAR_MAX = 2099;

export const ADDITIONS_QUESTION_COUNT = 10;
export const ADDITIONS_NUMBERS_PER_QUESTION = 10;
export const ADDITIONS_DIGITS_PER_NUMBER = 10;

export const MULTIPLICATIONS_QUESTION_COUNT = 10;
export const MULTIPLICATIONS_DIGITS_PER_FACTOR = 8;

export const SQUARE_ROOTS_QUESTION_COUNT = 10;
export const SQUARE_ROOTS_MIN = 100000;
export const SQUARE_ROOTS_MAX = 999999;
export const SQUARE_ROOT_TOTAL_DIGITS = 8;

/**
 * Mental Square Roots scoring rules (inferred from published Memoriad championship results
 * and a competition simulator screenshot where 2 correct leading digits gave 3 points):
 * - `SQUARE_ROOT_STOP_AT_FIRST_MISTAKE`: count matching leading digits `k` from left to right
 *   (across all 8 digits: 3 integer + 5 decimal), stopping immediately at the first wrong or blank digit.
 * - `SQUARE_ROOT_POINTS_BY_CORRECT_DIGITS`: triangular points `k * (k + 1) / 2`
 *   (8 correct digits give 36, 6 give 21, 2 give 3; maximum 360 across 10 questions).
 */
export const SQUARE_ROOT_STOP_AT_FIRST_MISTAKE = true;
export const SQUARE_ROOT_POINTS_BY_CORRECT_DIGITS = Object.freeze([
  0, 1, 3, 6, 10, 15, 21, 28, 36,
]);

export const MIN_CONCENTRATION_SECONDS = 0;
export const MAX_CONCENTRATION_SECONDS = 120;
export const DEFAULT_CONCENTRATION_SECONDS = 5;

export const MEMORIAD_TIME_LIMITS = Object.freeze({
  calendar: 60,
  additions: 600,
  multiplications: 900,
  square_roots: 900,
});

export const MEMORIAD_EXPIRY_GRACE_SECONDS = 30;
export const MEMORIAD_ALLOWED_FINISHED_BY = Object.freeze(['finish', 'time_up']);
export const MEMORIAD_MAX_ANSWER_LENGTH = 20;

export const PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT = {
  calendar: 0.25,
  additions: 3,
  multiplications: 5,
  square_roots: 5,
};

/**
 * Returns the configured round time limit in seconds for `moduleKey`.
 * @param {string} moduleKey
 * @returns {number}
 */
export function getMemoriadTimeLimit(moduleKey) {
  const key = typeof moduleKey === 'string' ? moduleKey.trim().toLowerCase() : '';
  return MEMORIAD_TIME_LIMITS[key] ?? 60;
}

/**
 * Computes session expiry timestamp in ms:
 * expires_at = start + concentration_seconds + limit + 30 seconds.
 * @param {number} startedAtMs
 * @param {number} concentrationSeconds
 * @param {string} moduleKey
 * @returns {number}
 */
export function computeMemoriadExpiresAtMs(startedAtMs, concentrationSeconds, moduleKey) {
  const start = Number(startedAtMs) || 0;
  const conc = Math.max(0, Number(concentrationSeconds) || 0);
  const limit = getMemoriadTimeLimit(moduleKey);
  return start + (conc + limit + MEMORIAD_EXPIRY_GRACE_SECONDS) * 1000;
}

/**
 * Computes capped used_seconds:
 * used_seconds = min((now - started_at) - concentration_seconds, limit), never below 0.
 * Rounded to 2 decimal places.
 * @param {number} startedAtMs
 * @param {number} nowMs
 * @param {number} concentrationSeconds
 * @param {string} moduleKey
 * @returns {number}
 */
export function computeMemoriadUsedSeconds(startedAtMs, nowMs, concentrationSeconds, moduleKey) {
  const start = Number(startedAtMs);
  const now = Number(nowMs);
  const conc = Math.max(0, Number(concentrationSeconds) || 0);
  const limit = getMemoriadTimeLimit(moduleKey);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return 0;
  const rawElapsedSeconds = (now - start) / 1000 - conc;
  const clamped = Math.min(limit, Math.max(0, rawElapsedSeconds));
  return Math.round((clamped + Number.EPSILON) * 100) / 100;
}

/**
 * Validates `finished_by` (accepts 'finish' or 'time_up'; defaults to 'finish' if omitted).
 * @param {unknown} rawFinishedBy
 * @returns {{ ok: true, finishedBy: 'finish' | 'time_up' } | { ok: false, error: string }}
 */
export function validateFinishedBy(rawFinishedBy) {
  if (rawFinishedBy === undefined || rawFinishedBy === null || rawFinishedBy === '') {
    return { ok: true, finishedBy: 'finish' };
  }
  const val = typeof rawFinishedBy === 'string' ? rawFinishedBy.trim().toLowerCase() : '';
  if (val === 'finish' || val === 'time_up') {
    return { ok: true, finishedBy: val };
  }
  return {
    ok: false,
    error: 'Invalid finished_by value. Expected "finish" or "time_up".',
  };
}

export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/**
 * Default cryptographically strong uniform integer RNG in [minInclusive, maxInclusive].
 * @param {number} minInclusive
 * @param {number} maxInclusive
 * @returns {number}
 */
export function defaultRng(minInclusive, maxInclusive) {
  const min = Math.ceil(Number(minInclusive));
  const max = Math.floor(Number(maxInclusive));
  if (min > max) {
    throw new Error(`Invalid RNG bounds: ${min} > ${max}`);
  }
  if (min === max) return min;
  return crypto.randomInt(min, max + 1);
}

/**
 * Returns true if `year` is a Gregorian leap year.
 * @param {number} year
 * @returns {boolean}
 */
export function isLeapYear(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return false;
  if (y % 400 === 0) return true;
  if (y % 100 === 0) return false;
  return y % 4 === 0;
}

/**
 * Returns the number of days in `month` (1..12) for Gregorian `year`.
 * @param {number} year
 * @param {number} month 1..12
 * @returns {number}
 */
export function daysInMonth(year, month) {
  const m = Number(month);
  switch (m) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Checks whether (year, month, day) is a valid Gregorian date within 1600..2099.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean}
 */
export function isValidGregorianDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < CALENDAR_YEAR_MIN || year > CALENDAR_YEAR_MAX) {
    return false;
  }
  if (month < 1 || month > 12) {
    return false;
  }
  const maxDay = daysInMonth(year, month);
  return day >= 1 && day <= maxDay;
}

/**
 * Computes the canonical weekday index for a Gregorian date:
 * 0 = Monday, 1 = Tuesday, 2 = Wednesday, 3 = Thursday, 4 = Friday, 5 = Saturday, 6 = Sunday.
 * Uses Sakamoto's proleptic Gregorian algorithm.
 *
 * Known reference dates:
 * - 2000-01-01 -> 5 (Saturday)
 * - 1969-07-20 -> 6 (Sunday)
 * - 1600-01-01 -> 5 (Saturday)
 *
 * @param {number} year
 * @param {number} month 1..12
 * @param {number} day 1..31
 * @returns {number} 0..6 (Monday = 0 .. Sunday = 6)
 */
export function weekdayIndex(year, month, day) {
  if (!isValidGregorianDate(year, month, day)) {
    throw new Error(`Invalid Gregorian date: ${year}-${month}-${day}`);
  }
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let y = year;
  if (month < 3) {
    y -= 1;
  }
  // Sakamoto's formula gives 0 = Sunday .. 6 = Saturday
  const sunZero =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + offsets[month - 1] + day) %
    7;
  // Convert 0 = Sunday .. 6 = Saturday into 0 = Monday .. 6 = Sunday
  return (sunZero + 6) % 7;
}

/**
 * Validates and normalises start settings for a Memoriad module.
 * @param {string} moduleKey
 * @param {object} [rawSettings={}]
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
export function validateMemoriadSettings(moduleKey, rawSettings = {}) {
  const key = typeof moduleKey === 'string' ? moduleKey.trim().toLowerCase() : '';
  const mod = MODULES[key];
  if (!mod || mod.comingSoon) {
    return { ok: false, error: 'This competition module is not available yet.' };
  }

  const input = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  let concentrationSeconds = DEFAULT_CONCENTRATION_SECONDS;
  if (input.concentration_seconds !== undefined && input.concentration_seconds !== null && input.concentration_seconds !== '') {
    const parsedConc = Number(input.concentration_seconds);
    if (
      !Number.isInteger(parsedConc) ||
      parsedConc < MIN_CONCENTRATION_SECONDS ||
      parsedConc > MAX_CONCENTRATION_SECONDS
    ) {
      return {
        ok: false,
        error: `Concentration time must be a whole number from ${MIN_CONCENTRATION_SECONDS} to ${MAX_CONCENTRATION_SECONDS} seconds.`,
      };
    }
    concentrationSeconds = parsedConc;
  }

  if (key === 'calendar') {
    let dates = CALENDAR_DEFAULT_DATES;
    if (input.dates !== undefined && input.dates !== null && input.dates !== '') {
      const parsedDates = Number(input.dates);
      if (!CALENDAR_ALLOWED_DATES.includes(parsedDates)) {
        return {
          ok: false,
          error: `Number of dates must be one of ${CALENDAR_ALLOWED_DATES.join(', ')}.`,
        };
      }
      dates = parsedDates;
    }
    return {
      ok: true,
      settings: {
        dates,
        concentration_seconds: concentrationSeconds,
      },
    };
  }

  return {
    ok: true,
    settings: {
      concentration_seconds: concentrationSeconds,
    },
  };
}

/**
 * Normalises a non-negative integer string by stripping leading zeros (keeping '0' for all-zeros).
 * Returns null if the string is empty or contains non-digits.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeDigitAnswer(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const stripped = trimmed.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/**
 * Formats [year, month, day] as ISO YYYY-MM-DD for server summary strings.
 * @param {number[]} triple
 * @returns {string}
 */
function formatIsoDateTriple(triple) {
  if (!Array.isArray(triple) || triple.length < 3) return '';
  const [y, m, d] = triple;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Exact integer floor square root for a non-negative BigInt `m`: `floor(sqrt(m))`.
 * @param {bigint} m
 * @returns {bigint}
 */
export function bigIntSqrt(m) {
  const n = BigInt(m);
  if (n < 0n) {
    throw new Error('Cannot compute square root of negative BigInt');
  }
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

/**
 * Returns true if positive integer `n` is a perfect square.
 * @param {number} n
 * @returns {boolean}
 */
export function isPerfectSquare(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 0) return false;
  const r = Math.floor(Math.sqrt(num));
  return r * r === num;
}

/**
 * Computes the square root of a 6-digit integer `n` rounded half-up to 5 decimal places
 * using exact integer arithmetic:
 * - `m = BigInt(n) * 10^10`
 * - `r = isqrt(m)`
 * - Rounded value is `r + 1` when `m - r * r >= r + 1`, otherwise `r`
 * - Formatted as three integer digits, a point, and five decimals (`"DDD.DDDDD"`, always 8 digits).
 *
 * @param {number} n
 * @returns {string}
 */
export function computeSquareRootHalfUp5(n) {
  const m = BigInt(n) * 10000000000n;
  const r = bigIntSqrt(m);
  const rounded = m - r * r >= r + 1n ? r + 1n : r;
  const digits8 = rounded.toString().padStart(8, '0');
  return `${digits8.slice(0, 3)}.${digits8.slice(3, 8)}`;
}

/**
 * Parses and evaluates a single Square Roots answer against `expectedDisplay` (`"DDD.DDDDD"`).
 * - Accepts up to 8 typed digits (the decimal point is fixed after the 3rd digit),
 *   or a string with `.` (`"673.10995"`), or positional slot characters (`_` / space for blank slots).
 * - Counts leading matching digits `k` from left to right, stopping at the first wrong or blank digit.
 * - Awards `points = k * (k + 1) / 2` via `SQUARE_ROOT_POINTS_BY_CORRECT_DIGITS`.
 *
 * @param {string} expectedDisplay `"DDD.DDDDD"`
 * @param {unknown} rawAnswer
 */
export function evaluateSquareRootAnswer(expectedDisplay, rawAnswer) {
  const expStr = String(expectedDisplay ?? '').trim();
  const expDigits = expStr.replace('.', '');
  const slots = new Array(SQUARE_ROOT_TOTAL_DIGITS).fill('');

  if (rawAnswer !== null && rawAnswer !== undefined) {
    const rawStr = String(rawAnswer);
    if (rawStr.includes('.')) {
      const [intPart = '', decPart = ''] = rawStr.split('.');
      const cleanInt = intPart.trim();
      const cleanDec = decPart;
      for (let i = 0; i < 3 && i < cleanInt.length; i++) {
        const ch = cleanInt[i];
        if (/^[0-9]$/.test(ch)) slots[i] = ch;
      }
      for (let i = 0; i < 5 && i < cleanDec.length; i++) {
        const ch = cleanDec[i];
        if (/^[0-9]$/.test(ch)) slots[3 + i] = ch;
      }
    } else {
      for (let i = 0; i < SQUARE_ROOT_TOTAL_DIGITS && i < rawStr.length; i++) {
        const ch = rawStr[i];
        if (/^[0-9]$/.test(ch)) {
          slots[i] = ch;
        }
      }
    }
  }

  const isAttempted = slots.some((ch) => ch !== '');
  let k = 0;

  if (isAttempted && expDigits.length === SQUARE_ROOT_TOTAL_DIGITS) {
    for (let i = 0; i < SQUARE_ROOT_TOTAL_DIGITS; i++) {
      if (slots[i] !== '' && slots[i] === expDigits[i]) {
        k += 1;
      } else if (SQUARE_ROOT_STOP_AT_FIRST_MISTAKE) {
        break;
      }
    }
  }

  const points = SQUARE_ROOT_POINTS_BY_CORRECT_DIGITS[k] ?? (k * (k + 1)) / 2;
  const isFullyCorrect = k === SQUARE_ROOT_TOTAL_DIGITS;

  let givenDisplay = null;
  if (isAttempted) {
    const hasDecimalPart = slots.slice(3, 8).some((ch) => ch !== '');
    const intFormatted = slots
      .slice(0, 3)
      .map((ch) => ch || '_')
      .join('');
    if (hasDecimalPart) {
      const decFormatted = slots
        .slice(3, 8)
        .map((ch) => ch || '_')
        .join('')
        .replace(/_+$/, '');
      givenDisplay = `${intFormatted}.${decFormatted}`;
    } else {
      givenDisplay = intFormatted.replace(/_+$/, '');
    }
  }

  return {
    attempted: isAttempted,
    correct: isFullyCorrect,
    correct_digits: k,
    points,
    given_display: givenDisplay,
    slots,
  };
}

export const MODULES = {
  calendar: {
    key: 'calendar',
    title: 'Mental Calendar Dates',
    defaultQuestions: CALENDAR_DEFAULT_DATES,
    timeLimitSeconds: MEMORIAD_TIME_LIMITS.calendar,
    minSecondsPerAttempt: PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT.calendar,
    comingSoon: false,

    /**
     * Generates `dates` distinct valid Gregorian dates in 1600..2099:
     * picks year (1600..2099), then month (1..12), then valid day (1..daysInMonth).
     * @param {Function} [rng=defaultRng]
     * @param {object} [settings={}]
     * @returns {{ questions: Array<[number, number, number]>, expected: number[], settings: object }}
     */
    generate(rng = defaultRng, settings = {}) {
      const count = CALENDAR_ALLOWED_DATES.includes(Number(settings?.dates))
        ? Number(settings.dates)
        : CALENDAR_DEFAULT_DATES;
      const seen = new Set();
      const questions = [];
      const expected = [];

      while (questions.length < count) {
        const year = rng(CALENDAR_YEAR_MIN, CALENDAR_YEAR_MAX);
        const month = rng(1, 12);
        const maxDay = daysInMonth(year, month);
        const day = rng(1, maxDay);
        const key = `${year}-${month}-${day}`;
        if (seen.has(key)) continue;
        seen.add(key);

        questions.push([year, month, day]);
        expected.push(weekdayIndex(year, month, day));
      }

      return {
        questions,
        expected,
        settings: {
          dates: count,
          concentration_seconds:
            Number.isInteger(settings?.concentration_seconds)
              ? settings.concentration_seconds
              : DEFAULT_CONCENTRATION_SECONDS,
        },
      };
    },

    /**
     * Evaluates a calendar session against student answers (each entry 0..6 or null)
     * in QUESTION ORDER (1 to N) using the official Memoriad Calendar Dates rule:
     * - Skipped (not answered) questions are ignored: neither right nor wrong.
     * - For each answered question:
     *   - If correct: `correctCount` increases, and ONLY while `wrongCount < 2`, `score` increases.
     *   - If wrong: `wrongCount` increases.
     * @param {{ questions: Array<[number, number, number]>, expected: number[] }} session
     * @param {Array<number|string|null>} answers
     */
    evaluate(session, answers) {
      const questions = Array.isArray(session?.questions) ? session.questions : [];
      const expected = Array.isArray(session?.expected) ? session.expected : [];
      const rawAnswers = Array.isArray(answers) ? answers : [];

      let attempted = 0;
      let correctCount = 0;
      let wrongCount = 0;
      let score = 0;
      const detail = [];

      for (let i = 0; i < questions.length; i++) {
        const expIdx = Number(expected[i]);
        const raw = rawAnswers[i];
        let givenIdx = null;

        if (raw !== null && raw !== undefined && raw !== '') {
          const parsed = Number(raw);
          if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 6) {
            givenIdx = parsed;
          }
        }

        const isAttempted = givenIdx !== null;
        const isCorrect = isAttempted && givenIdx === expIdx;

        if (isAttempted) {
          attempted += 1;
          if (isCorrect) {
            correctCount += 1;
            if (wrongCount < 2) {
              score += 1;
            }
          } else {
            wrongCount += 1;
          }
        }

        detail.push({
          index: i + 1,
          question_summary: formatIsoDateTriple(questions[i]),
          expected: expIdx,
          expected_display: WEEKDAY_NAMES[expIdx] || String(expIdx),
          given: givenIdx,
          given_display: isAttempted ? WEEKDAY_NAMES[givenIdx] : null,
          attempted: isAttempted,
          correct: isCorrect,
        });
      }

      return {
        module: 'calendar',
        title: 'Mental Calendar Dates',
        questions_total: questions.length,
        attempted,
        correct: correctCount,
        wrong: wrongCount,
        score,
        detail,
      };
    },
  },

  additions: {
    key: 'additions',
    title: 'Mental Additions',
    defaultQuestions: ADDITIONS_QUESTION_COUNT,
    timeLimitSeconds: MEMORIAD_TIME_LIMITS.additions,
    minSecondsPerAttempt: PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT.additions,
    comingSoon: false,

    /**
     * Generates 10 questions; each has 10 numbers of 10 digits (first digit 1..9, remaining 0..9).
     * Expected answer is the exact sum computed with BigInt as a string.
     * @param {Function} [rng=defaultRng]
     * @param {object} [settings={}]
     * @returns {{ questions: string[][], expected: string[], settings: object }}
     */
    generate(rng = defaultRng, settings = {}) {
      const questions = [];
      const expected = [];

      for (let q = 0; q < ADDITIONS_QUESTION_COUNT; q++) {
        const numbers = [];
        let sum = 0n;

        for (let row = 0; row < ADDITIONS_NUMBERS_PER_QUESTION; row++) {
          let digits = String(rng(1, 9));
          for (let d = 1; d < ADDITIONS_DIGITS_PER_NUMBER; d++) {
            digits += String(rng(0, 9));
          }
          numbers.push(digits);
          sum += BigInt(digits);
        }

        questions.push(numbers);
        expected.push(sum.toString());
      }

      return {
        questions,
        expected,
        settings: {
          concentration_seconds:
            Number.isInteger(settings?.concentration_seconds)
              ? settings.concentration_seconds
              : DEFAULT_CONCENTRATION_SECONDS,
        },
      };
    },

    /**
     * Evaluates an additions session against student answers (each entry a digit string or null/blank).
     * Leading zeros are ignored ('000123' matches '123').
     * @param {{ questions: string[][], expected: string[] }} session
     * @param {Array<string|null>} answers
     */
    evaluate(session, answers) {
      const questions = Array.isArray(session?.questions) ? session.questions : [];
      const expected = Array.isArray(session?.expected) ? session.expected : [];
      const rawAnswers = Array.isArray(answers) ? answers : [];

      let attempted = 0;
      let correct = 0;
      const detail = [];

      for (let i = 0; i < questions.length; i++) {
        const expStr = String(expected[i] ?? '').trim();
        const raw = rawAnswers[i];
        const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
        const isAttempted = trimmed.length > 0;
        const normalizedGiven = normalizeDigitAnswer(trimmed);

        let isCorrect = false;
        if (isAttempted && normalizedGiven !== null && /^\d+$/.test(expStr)) {
          isCorrect = BigInt(normalizedGiven) === BigInt(expStr);
        }

        if (isAttempted) attempted += 1;
        if (isCorrect) correct += 1;

        const nums = Array.isArray(questions[i]) ? questions[i] : [];
        const summary =
          nums.length > 0
            ? `${nums[0]} + … + ${nums[nums.length - 1]} (${nums.length} × 10d)`
            : `Question ${i + 1}`;

        detail.push({
          index: i + 1,
          question_summary: summary,
          expected: expStr,
          expected_display: expStr,
          given: isAttempted ? trimmed : null,
          given_display: isAttempted ? trimmed : null,
          attempted: isAttempted,
          correct: isCorrect,
        });
      }

      return {
        module: 'additions',
        title: 'Mental Additions',
        questions_total: questions.length,
        attempted,
        correct,
        wrong: attempted - correct,
        score: correct,
        detail,
      };
    },
  },

  multiplications: {
    key: 'multiplications',
    title: 'Mental Multiplications',
    defaultQuestions: MULTIPLICATIONS_QUESTION_COUNT,
    timeLimitSeconds: MEMORIAD_TIME_LIMITS.multiplications,
    minSecondsPerAttempt: PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT.multiplications,
    comingSoon: false,

    /**
     * Generates 10 questions; each has two 8-digit numbers (first digit 1..9, remaining 0..9).
     * Expected answer is the exact product computed with BigInt as a string (15 or 16 digits).
     * @param {Function} [rng=defaultRng]
     * @param {object} [settings={}]
     * @returns {{ questions: Array<[string, string]>, expected: string[], settings: object }}
     */
    generate(rng = defaultRng, settings = {}) {
      const questions = [];
      const expected = [];

      for (let q = 0; q < MULTIPLICATIONS_QUESTION_COUNT; q++) {
        const pair = [];
        for (let f = 0; f < 2; f++) {
          let digits = String(rng(1, 9));
          for (let d = 1; d < MULTIPLICATIONS_DIGITS_PER_FACTOR; d++) {
            digits += String(rng(0, 9));
          }
          pair.push(digits);
        }
        const product = BigInt(pair[0]) * BigInt(pair[1]);
        questions.push(pair);
        expected.push(product.toString());
      }

      return {
        questions,
        expected,
        settings: {
          concentration_seconds:
            Number.isInteger(settings?.concentration_seconds)
              ? settings.concentration_seconds
              : DEFAULT_CONCENTRATION_SECONDS,
        },
      };
    },

    /**
     * Evaluates a multiplications session against student answers (numeric comparison after removing leading zeros).
     * @param {{ questions: Array<[string, string]>, expected: string[] }} session
     * @param {Array<string|null>} answers
     */
    evaluate(session, answers) {
      const questions = Array.isArray(session?.questions) ? session.questions : [];
      const expected = Array.isArray(session?.expected) ? session.expected : [];
      const rawAnswers = Array.isArray(answers) ? answers : [];

      let attempted = 0;
      let correct = 0;
      const detail = [];

      for (let i = 0; i < questions.length; i++) {
        const expStr = String(expected[i] ?? '').trim();
        const raw = rawAnswers[i];
        const trimmed = raw === null || raw === undefined ? '' : String(raw).trim();
        const isAttempted = trimmed.length > 0;
        const normalizedGiven = normalizeDigitAnswer(trimmed);

        let isCorrect = false;
        if (isAttempted && normalizedGiven !== null && /^\d+$/.test(expStr)) {
          isCorrect = BigInt(normalizedGiven) === BigInt(expStr);
        }

        if (isAttempted) attempted += 1;
        if (isCorrect) correct += 1;

        const pair = Array.isArray(questions[i]) ? questions[i] : [];
        const summary =
          pair.length >= 2 ? `${pair[0]} × ${pair[1]}` : `Question ${i + 1}`;

        detail.push({
          index: i + 1,
          question_summary: summary,
          expected: expStr,
          expected_display: expStr,
          given: isAttempted ? trimmed : null,
          given_display: isAttempted ? trimmed : null,
          attempted: isAttempted,
          correct: isCorrect,
        });
      }

      return {
        module: 'multiplications',
        title: 'Mental Multiplications',
        questions_total: questions.length,
        attempted,
        correct,
        wrong: attempted - correct,
        score: correct,
        detail,
      };
    },
  },

  square_roots: {
    key: 'square_roots',
    title: 'Mental Square Roots',
    defaultQuestions: SQUARE_ROOTS_QUESTION_COUNT,
    timeLimitSeconds: MEMORIAD_TIME_LIMITS.square_roots,
    minSecondsPerAttempt: PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT.square_roots,
    comingSoon: false,

    /**
     * Generates 10 questions; each is a distinct 6-digit integer in 100000..999999
     * that is NOT a perfect square.
     * Expected answer is the square root rounded half-up to 5 decimals ("DDD.DDDDD").
     * @param {Function} [rng=defaultRng]
     * @param {object} [settings={}]
     * @returns {{ questions: number[], expected: string[], settings: object }}
     */
    generate(rng = defaultRng, settings = {}) {
      const questions = [];
      const expected = [];
      const seen = new Set();

      while (questions.length < SQUARE_ROOTS_QUESTION_COUNT) {
        const candidate = rng(SQUARE_ROOTS_MIN, SQUARE_ROOTS_MAX);
        if (isPerfectSquare(candidate) || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        questions.push(candidate);
        expected.push(computeSquareRootHalfUp5(candidate));
      }

      return {
        questions,
        expected,
        settings: {
          concentration_seconds:
            Number.isInteger(settings?.concentration_seconds)
              ? settings.concentration_seconds
              : DEFAULT_CONCENTRATION_SECONDS,
        },
      };
    },

    /**
     * Evaluates a square_roots session using the triangular prefix-digit scoring rule:
     * - Correct digits `k` = leading matching digits from left to right (0..8), stopping at the first wrong or blank digit.
     * - `points = k * (k + 1) / 2` (max 36 per question, max 360 total).
     * - `correct` = number of fully correct roots (`k === 8`).
     * - `digits_total` = sum of `k` across all questions.
     * @param {{ questions: number[], expected: string[] }} session
     * @param {Array<string|null>} answers
     */
    evaluate(session, answers) {
      const questions = Array.isArray(session?.questions) ? session.questions : [];
      const expected = Array.isArray(session?.expected) ? session.expected : [];
      const rawAnswers = Array.isArray(answers) ? answers : [];

      let attempted = 0;
      let correct = 0;
      let score = 0;
      let digitsTotal = 0;
      const detail = [];

      for (let i = 0; i < questions.length; i++) {
        const expStr = String(expected[i] ?? '').trim();
        const radicand = questions[i];
        const itemEval = evaluateSquareRootAnswer(expStr, rawAnswers[i]);

        if (itemEval.attempted) attempted += 1;
        if (itemEval.correct) correct += 1;
        score += itemEval.points;
        digitsTotal += itemEval.correct_digits;

        detail.push({
          index: i + 1,
          question_summary: `√${radicand}`,
          expected: expStr,
          expected_display: expStr,
          given: itemEval.given_display,
          given_display: itemEval.given_display,
          attempted: itemEval.attempted,
          correct: itemEval.correct,
          correct_digits: itemEval.correct_digits,
          points: itemEval.points,
        });
      }

      return {
        module: 'square_roots',
        title: 'Mental Square Roots',
        questions_total: questions.length,
        attempted,
        correct,
        wrong: attempted - correct,
        score,
        digits_total: digitsTotal,
        detail,
      };
    },
  },
};

/**
 * Generates a Memoriad competition session for `moduleKey`.
 * @param {string} moduleKey
 * @param {object} [settings={}]
 * @param {Function} [rng=defaultRng]
 */
export function generateMemoriadSet(moduleKey, settings = {}, rng = defaultRng) {
  const validation = validateMemoriadSettings(moduleKey, settings);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const mod = MODULES[moduleKey];
  const generated = mod.generate(rng, validation.settings);
  return {
    module: mod.key,
    title: mod.title,
    questions: generated.questions,
    expected: generated.expected,
    settings: generated.settings,
  };
}

/**
 * Strips `expected` answers from a session object before returning it to the client on `start`.
 * @param {object} session
 */
export function buildMemoriadStartResponse(session) {
  const settings = session?.settings || {};
  const limit = Number(
    session?.time_limit_seconds ||
    session?.duration_seconds ||
    settings.time_limit_seconds ||
    settings.duration_seconds ||
    getMemoriadTimeLimit(session?.module)
  );
  const prepSeconds = Number(
    settings.concentration_seconds ??
    settings.prep_seconds ??
    DEFAULT_CONCENTRATION_SECONDS
  );
  return {
    session_id: session?.session_id || session?.id,
    module: session?.module,
    title: session?.title || MODULES[session?.module]?.title || 'Memoriad Practice',
    questions: Array.isArray(session?.questions) ? session.questions : [],
    time_limit_seconds: limit,
    duration_seconds: limit,
    prep_seconds: prepSeconds,
    concentration_seconds: prepSeconds,
    settings: {
      ...settings,
      time_limit_seconds: limit,
      duration_seconds: limit,
      concentration_seconds: prepSeconds,
      prep_seconds: prepSeconds,
    },
  };
}

/**
 * Checks plausibility of elapsed `usedSeconds` for `attempted` answers in `moduleKey`.
 * - Calendar: used_seconds >= attempted * 0.25
 * - Additions: used_seconds >= attempted * 3
 * @param {string} moduleKey
 * @param {number} attempted
 * @param {number} usedSeconds
 * @returns {{ ok: true } | { ok: false, error: string, minRequiredSeconds: number }}
 */
export function checkMemoriadPlausibility(moduleKey, attempted, usedSeconds) {
  const numAttempted = Number(attempted) || 0;
  if (numAttempted <= 0) {
    return { ok: true };
  }
  const minPerAttempt = PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT[moduleKey] ?? 0.25;
  const minRequiredSeconds = Number((numAttempted * minPerAttempt).toFixed(2));
  const elapsed = Number(usedSeconds);

  if (!Number.isFinite(elapsed) || elapsed < minRequiredSeconds) {
    return {
      ok: false,
      minRequiredSeconds,
      error: 'Submitted faster than plausible human calculation speed. Please solve the questions carefully.',
    };
  }
  return { ok: true };
}

/**
 * Evaluates a Memoriad session and validates the answers array shape and plausibility.
 * @param {object} session
 * @param {Array<unknown>} answers
 * @param {number} usedSeconds
 * @returns {{ ok: true, evaluation: object } | { ok: false, error: string }}
 */
export function evaluateMemoriadSubmission(session, answers, usedSeconds) {
  if (!session || typeof session !== 'object') {
    return { ok: false, error: 'Practice session not found.' };
  }
  const moduleKey = session.module || session.settings?.module;
  const mod = MODULES[moduleKey];
  if (!mod || mod.comingSoon) {
    return { ok: false, error: 'Unsupported competition module.' };
  }

  const questions = Array.isArray(session.questions) ? session.questions : [];
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return {
      ok: false,
      error: `Expected ${questions.length} answers, received ${Array.isArray(answers) ? answers.length : 0}.`,
    };
  }

  for (let i = 0; i < answers.length; i++) {
    const item = answers[i];
    if (item === null || item === undefined) continue;
    if (moduleKey === 'calendar') {
      if (typeof item === 'number') {
        if (!Number.isInteger(item) || item < 0 || item > 6) {
          return { ok: false, error: `Invalid weekday index at question ${i + 1}.` };
        }
      } else if (typeof item === 'string') {
        if (item.length > MEMORIAD_MAX_ANSWER_LENGTH) {
          return { ok: false, error: `Answer at question ${i + 1} is too long.` };
        }
        const trimmed = item.trim();
        if (trimmed !== '') {
          const parsed = Number(trimmed);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
            return { ok: false, error: `Invalid weekday index at question ${i + 1}.` };
          }
        }
      } else {
        return { ok: false, error: `Invalid answer format at question ${i + 1}.` };
      }
    } else {
      if (typeof item !== 'string' && typeof item !== 'number') {
        return { ok: false, error: `Invalid answer format at question ${i + 1}.` };
      }
      const str = String(item);
      if (str.length > MEMORIAD_MAX_ANSWER_LENGTH) {
        return {
          ok: false,
          error: `Answer at question ${i + 1} exceeds ${MEMORIAD_MAX_ANSWER_LENGTH} characters.`,
        };
      }
    }
  }

  const evaluation = mod.evaluate(session, answers);
  const plausibility = checkMemoriadPlausibility(moduleKey, evaluation.attempted, usedSeconds);
  if (!plausibility.ok) {
    return { ok: false, error: plausibility.error };
  }

  return {
    ok: true,
    evaluation,
  };
}
