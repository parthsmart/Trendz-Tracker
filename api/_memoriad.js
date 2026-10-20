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

export const MIN_CONCENTRATION_SECONDS = 0;
export const MAX_CONCENTRATION_SECONDS = 120;
export const DEFAULT_CONCENTRATION_SECONDS = 5;

export const MEMORIAD_SESSION_EXPIRY_SECONDS = 3 * 3600; // 3 hours
export const MEMORIAD_MAX_ANSWER_LENGTH = 20;

export const PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT = {
  calendar: 0.25,
  additions: 3,
};

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

export const MODULES = {
  calendar: {
    key: 'calendar',
    title: 'Mental Calendar Dates',
    defaultQuestions: CALENDAR_DEFAULT_DATES,
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
     * Evaluates a calendar session against student answers (each entry 0..6 or null).
     * @param {{ questions: Array<[number, number, number]>, expected: number[] }} session
     * @param {Array<number|string|null>} answers
     */
    evaluate(session, answers) {
      const questions = Array.isArray(session?.questions) ? session.questions : [];
      const expected = Array.isArray(session?.expected) ? session.expected : [];
      const rawAnswers = Array.isArray(answers) ? answers : [];

      let attempted = 0;
      let correct = 0;
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

        if (isAttempted) attempted += 1;
        if (isCorrect) correct += 1;

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
        correct,
        score: correct,
        detail,
      };
    },
  },

  additions: {
    key: 'additions',
    title: 'Mental Additions',
    defaultQuestions: ADDITIONS_QUESTION_COUNT,
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
        score: correct,
        detail,
      };
    },
  },

  multiplications: {
    key: 'multiplications',
    title: 'Mental Multiplications',
    defaultQuestions: 10,
    minSecondsPerAttempt: 2,
    comingSoon: true,
  },

  square_roots: {
    key: 'square_roots',
    title: 'Mental Square Roots',
    defaultQuestions: 10,
    minSecondsPerAttempt: 2,
    comingSoon: true,
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
  return {
    session_id: session.session_id || session.id,
    module: session.module,
    title: session.title || MODULES[session.module]?.title || 'Memoriad Practice',
    questions: Array.isArray(session.questions) ? session.questions : [],
    settings: session.settings || {},
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
