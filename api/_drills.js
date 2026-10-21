/**
 * Trendz Tracker — Elements Drills Server Engine (api/_drills.js)
 *
 * Pure server-side module (no network calls) defining the 18 timed worksheet
 * drills ("Elements"), their deterministic/injectable question generators,
 * exact integer / BigInt arithmetic helpers, answer parsers, comparators,
 * and response builders.
 *
 * SECURITY INVARIANT:
 * - Questions and expected answers are generated on the server.
 * - Expected answers are stored only in `drill_sessions.expected` and are
 *   NEVER included in the `/api/drill` start response sent to the browser.
 */

import crypto from 'node:crypto';

/**
 * Single switch constant for the Modulo Calculation drill.
 * Disabled until a teacher confirms the 3-digit n2 formula.
 */
export const MODULO_ENABLED = false;

/**
 * Phase 9a — Online Basics Practice Constants
 */
export const BASICS_QUESTION_COUNTS = [20, 50, 100, 200];
export const BASICS_DEFAULT_QUESTIONS = 20;
export const BASICS_CATEGORY_QUESTION_SLABS = {
  '1d4r': [20, 50, 100, 200],
  '2d2r': [20, 50, 100, 200],
  '1dx1d': [20, 50, 100, 200],
  '2dx1d': [20, 50, 100, 200],
  '2d/1d': [20, 50, 100, 200],
  '2dby1d': [20, 50, 100, 200],
  '2d4r': [10, 20, 30, 50],
  '3d/1d': [10, 50, 100],
  '3dby1d': [10, 50, 100],
};
export const BASICS_MIN_DIGITS = 1;
export const BASICS_MAX_DIGITS = 4;
export const BASICS_MIN_ROWS = 2;
export const BASICS_MAX_ROWS = 10;
export const BASICS_SUB_PROBABILITY = 0.4;
export const BASICS_ROW_RETRY_LIMIT = 20;
export const BASICS_SESSION_EXPIRY_MINUTES = 30;
export const BASICS_SESSION_EXPIRY_SECONDS = 30 * 60;
export const BASICS_MIN_SECONDS_PER_QUESTION = 0.6;
export const BASICS_MAX_ANSWER_LENGTH = 20;
export const BASICS_MAX_TIME_SECONDS = 14400;

/**
 * Default random integer generator using Node's built-in crypto.randomInt.
 * Returns an integer in [min, max] inclusive.
 *
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function defaultRng(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (lo === hi) return lo;
  return crypto.randomInt(lo, hi + 1);
}

/**
 * Creates a deterministic seeded RNG function for unit testing (Mulberry32).
 * Can be called either as `rng(min, max)` (returning an integer in [min, max])
 * or `rng()` (returning a float in [0, 1)).
 *
 * @param {number} seed
 * @returns {(min?: number, max?: number) => number}
 */
export function createSeededRng(seed = 123456789) {
  let state = seed >>> 0;
  return function seededRng(min, max) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const floatVal = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    if (typeof min === 'number' && typeof max === 'number') {
      const lo = Math.ceil(Math.min(min, max));
      const hi = Math.floor(Math.max(min, max));
      return lo + Math.floor(floatVal * (hi - lo + 1));
    }
    return floatVal;
  };
}

/**
 * Normalizes any injected `rng` function to return an integer in [min, max] inclusive.
 * Supports both `rng(min, max)` returning an integer and `rng()` returning a float in [0, 1).
 *
 * @param {Function|undefined} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(rng, min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (lo === hi) return lo;

  const fn = typeof rng === 'function' ? rng : defaultRng;
  const val = fn(lo, hi);

  if (typeof val === 'number' && !Number.isNaN(val)) {
    // Float in [0, 1)
    if (val >= 0 && val < 1 && (!Number.isInteger(val) || fn.length === 0)) {
      return lo + Math.floor(val * (hi - lo + 1));
    }
    if (Number.isInteger(val)) {
      if (val >= lo && val <= hi) return val;
      const span = hi - lo + 1;
      return lo + (((val % span) + span) % span);
    }
  }
  return defaultRng(lo, hi);
}

/**
 * Picks a random element from a non-empty array using `rng`.
 *
 * @template T
 * @param {Function} rng
 * @param {readonly T[]} arr
 * @returns {T}
 */
function pickRandom(rng, arr) {
  const idx = randInt(rng, 0, arr.length - 1);
  return arr[idx];
}

/**
 * Shuffles an array in-place using Fisher-Yates and `rng`.
 *
 * @template T
 * @param {Function} rng
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffleInPlace(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Exact greatest common divisor using BigInt Euclidean algorithm.
 *
 * @param {number|bigint} a
 * @param {number|bigint} b
 * @returns {bigint}
 */
export function gcdBigInt(a, b) {
  let x = BigInt(a);
  let y = BigInt(b);
  if (x < 0n) x = -x;
  if (y < 0n) y = -y;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * Exact integer ceiling square root and perfect-square check using BigInt binary search.
 * Never uses floating-point Math.sqrt.
 *
 * For n > 0:
 * - Returns `{ rootFloor, rootCeil, smallestSquareGreater, isPerfectSquare }`.
 * - For non-squares, `rootCeil` and `smallestSquareGreater` are identical:
 *   the smallest whole number whose square is strictly greater than `n`.
 *
 * @param {number|bigint} n
 */
export function exactSqrtInfo(n) {
  const target = BigInt(n);
  if (target <= 0n) {
    return {
      rootFloor: 0,
      rootCeil: 0,
      smallestSquareGreater: 1,
      isPerfectSquare: target === 0n,
    };
  }

  let lo = 1n;
  let hi = target;
  let floorVal = 1n;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1n;
    const sq = mid * mid;
    if (sq === target) {
      return {
        rootFloor: Number(mid),
        rootCeil: Number(mid),
        smallestSquareGreater: Number(mid + 1n),
        isPerfectSquare: true,
      };
    }
    if (sq < target) {
      floorVal = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }

  const ceilVal = floorVal + 1n;
  return {
    rootFloor: Number(floorVal),
    rootCeil: Number(ceilVal),
    smallestSquareGreater: Number(ceilVal),
    isPerfectSquare: false,
  };
}

// ============================================================================
// ANSWER PARSERS, COMPARATORS, AND FORMATTERS
// ============================================================================

/**
 * Parses an integer answer:
 * - Removes all spaces and commas.
 * - Accepts leading zeros ("03" -> 3, "0086400" -> 86400, "86,400" -> 86400).
 * - Anything else (letters, decimals, signs, empty) returns null (never throws).
 *
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseIntegerAnswer(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[\s,]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  try {
    const big = BigInt(cleaned);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(big);
  } catch {
    return null;
  }
}

export function equalIntegerAnswer(parsed, expected) {
  if (parsed === null || parsed === undefined) return false;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed === expected;
}

export function formatIntegerAnswer(expected) {
  return String(expected);
}

/**
 * Parses prime factor pair answers:
 * - Two integers separated by x, X, × (multiplication sign), *, comma, or space.
 * - Returns a sorted pair `[min, max]` of numbers, or null if invalid.
 *
 * @param {unknown} input
 * @returns {[number, number]|null}
 */
export function parsePrimeFactorsAnswer(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  const match = str.match(/^(\d+)\s*(?:[xX*×,]\s*|\s+)(\d+)$/);
  if (!match) return null;
  try {
    const aBig = BigInt(match[1]);
    const bBig = BigInt(match[2]);
    if (aBig > BigInt(Number.MAX_SAFE_INTEGER) || bBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const a = Number(aBig);
    const b = Number(bBig);
    return a <= b ? [a, b] : [b, a];
  } catch {
    return null;
  }
}

export function equalPrimeFactorsAnswer(parsed, expected) {
  if (!Array.isArray(parsed) || !Array.isArray(expected)) return false;
  if (parsed.length !== 2 || expected.length !== 2) return false;
  const p0 = Math.min(parsed[0], parsed[1]);
  const p1 = Math.max(parsed[0], parsed[1]);
  const e0 = Math.min(expected[0], expected[1]);
  const e1 = Math.max(expected[0], expected[1]);
  return p0 === e0 && p1 === e1;
}

export function formatPrimeFactorsAnswer(expected) {
  if (!Array.isArray(expected) || expected.length !== 2) return String(expected ?? '');
  return `${expected[0]} x ${expected[1]}`;
}

/**
 * Parses a ratio answer "a/b" with optional spaces:
 * - Does NOT reduce a/b so that non-lowest-terms answers like "8/14" for "4/7" are marked wrong.
 * - Normalizes leading zeros on each integer component ("04 / 07" -> "4/7").
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function parseRatioAnswer(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  const match = str.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return null;
  try {
    const aBig = BigInt(match[1]);
    const bBig = BigInt(match[2]);
    if (bBig === 0n) return null;
    if (aBig > BigInt(Number.MAX_SAFE_INTEGER) || bBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return `${aBig.toString()}/${bBig.toString()}`;
  } catch {
    return null;
  }
}

export function equalRatioAnswer(parsed, expected) {
  if (parsed === null || parsed === undefined || expected === null || expected === undefined) {
    return false;
  }
  const normExpected = Array.isArray(expected)
    ? `${expected[0]}/${expected[1]}`
    : String(expected).trim();
  return parsed === normExpected;
}

export function formatRatioAnswer(expected) {
  if (Array.isArray(expected) && expected.length === 2) {
    return `${expected[0]}/${expected[1]}`;
  }
  return String(expected ?? '');
}

/**
 * Parses a modulo answer: two integers separated by a comma or space (quotient, remainder).
 *
 * @param {unknown} input
 * @returns {[number, number]|null}
 */
export function parseModuloAnswer(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim();
  const match = str.match(/^(\d+)\s*(?:,\s*|\s+)(\d+)$/);
  if (!match) return null;
  try {
    const qBig = BigInt(match[1]);
    const rBig = BigInt(match[2]);
    if (qBig > BigInt(Number.MAX_SAFE_INTEGER) || rBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return [Number(qBig), Number(rBig)];
  } catch {
    return null;
  }
}

export function equalModuloAnswer(parsed, expected) {
  if (!Array.isArray(parsed) || !Array.isArray(expected)) return false;
  if (parsed.length !== 2 || expected.length !== 2) return false;
  return parsed[0] === expected[0] && parsed[1] === expected[1];
}

export function formatModuloAnswer(expected) {
  if (!Array.isArray(expected) || expected.length !== 2) return String(expected ?? '');
  return `${expected[0]}, ${expected[1]}`;
}

// ============================================================================
// DRILL CONSTANTS & LOOKUP TABLES
// ============================================================================

export const DAY_CODES_TABLE = [
  { name: 'Sunday', code: 1 },
  { name: 'Monday', code: 2 },
  { name: 'Tuesday', code: 3 },
  { name: 'Wednesday', code: 4 },
  { name: 'Thursday', code: 5 },
  { name: 'Friday', code: 6 },
  { name: 'Saturday', code: 0 },
];

/**
 * Fixed typos from the original Python app (e.g. "September{09)" -> "September (09)").
 */
export const MONTH_CODES_TABLE = [
  { text: 'January (01)', code: 1 },
  { text: 'February (02)', code: 4 },
  { text: 'March (03)', code: 4 },
  { text: 'April (04)', code: 0 },
  { text: 'May (05)', code: 2 },
  { text: 'June (06)', code: 5 },
  { text: 'July (07)', code: 0 },
  { text: 'August (08)', code: 3 },
  { text: 'September (09)', code: 6 },
  { text: 'October (10)', code: 1 },
  { text: 'November (11)', code: 4 },
  { text: 'December (12)', code: 6 },
];

export const CENTURY_MOD4_TO_CODE = {
  0: 6,
  1: 4,
  2: 2,
  3: 0,
};

export const TIME_CONVERSION_UNITS = [
  { unit: 'Day', seconds: 86400 },
  { unit: 'Week', seconds: 604800 },
  { unit: 'Hour', seconds: 3600 },
  { unit: 'Minute', seconds: 60 },
  { unit: 'Month', seconds: 2592000 },
];

export const YEAR_SECONDS = 31536000;

export const PRIME_POOL = [
  13, 17, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
];

export const DAYS_TO_SECONDS_MONTHS = [
  { name: 'Jan.', days: 31 },
  { name: 'Feb.', days: 28 },
  { name: 'March', days: 31 },
  { name: 'April', days: 30 },
  { name: 'May', days: 31 },
  { name: 'June', days: 30 },
  { name: 'July', days: 31 },
  { name: 'Aug.', days: 31 },
  { name: 'Sep.', days: 30 },
  { name: 'Oct.', days: 31 },
  { name: 'Nov.', days: 30 },
  { name: 'Dec.', days: 31 },
];

// ============================================================================
// DETERMINISTIC QUESTION SOLVERS (USED BY GENERATORS & KNOWN-EXAMPLE TESTS)
// ============================================================================

/**
 * Computes the expected canonical answer for a given drill key and question text.
 * Uses exact integer / BigInt arithmetic.
 *
 * @param {string} drillKey
 * @param {string|number} questionText
 * @returns {number | string | [number, number]}
 */
export function solveDrillQuestion(drillKey, questionText) {
  const text = String(questionText).trim();

  switch (drillKey) {
    case 'day_codes': {
      const found = DAY_CODES_TABLE.find((d) => d.name.toLowerCase() === text.toLowerCase());
      if (!found) throw new Error(`Unknown weekday: ${text}`);
      return found.code;
    }

    case 'month_codes': {
      const found = MONTH_CODES_TABLE.find((m) => m.text.toLowerCase() === text.toLowerCase());
      if (!found) throw new Error(`Unknown month display: ${text}`);
      return found.code;
    }

    case 'century_codes': {
      const yr = text.replace(/\s+/g, '');
      const a = Number(yr.slice(0, 2));
      return CENTURY_MOD4_TO_CODE[a % 4];
    }

    case 'time_conversion': {
      if (text === '1 Year') return YEAR_SECONDS;
      const m = text.match(/^(\d+)\s+([A-Za-z]+)$/);
      if (!m) throw new Error(`Invalid time_conversion question: ${text}`);
      const n = Number(m[1]);
      const unitObj = TIME_CONVERSION_UNITS.find((u) => u.unit === m[2]);
      if (!unitObj) throw new Error(`Unknown unit: ${m[2]}`);
      return Number(BigInt(n) * BigInt(unitObj.seconds));
    }

    case 'squares_11_50':
    case 'squares_51_100':
    case 'squares_3d_4d': {
      const n = BigInt(text);
      return Number(n * n);
    }

    case 'cubes_11_50':
    case 'cubes_51_100': {
      const n = BigInt(text);
      return Number(n * n * n);
    }

    case 'divide_by_4': {
      const m = text.match(/^(\d+)\s*\/\s*4$/);
      const n = m ? Number(m[1]) : Number(text);
      return Math.trunc(n / 4);
    }

    case 'divide_by_7': {
      const m = text.match(/^(\d+)\s*\/\s*7$/);
      const n = m ? Number(m[1]) : Number(text);
      return n % 7;
    }

    case 'prime_factors': {
      const prod = Number(text);
      for (let i = 0; i < PRIME_POOL.length; i++) {
        const p1 = PRIME_POOL[i];
        if (prod % p1 === 0) {
          const p2 = prod / p1;
          if (PRIME_POOL.includes(p2)) {
            return p1 <= p2 ? [p1, p2] : [p2, p1];
          }
        }
      }
      throw new Error(`Product ${prod} cannot be factored over PRIME_POOL`);
    }

    case 'modulo': {
      // Format: "<n3>    <n1>.<n2>"
      const m = text.match(/^(\d+)\s+(\d+)\.(\d+)$/);
      if (!m) throw new Error(`Invalid modulo question: ${text}`);
      const n3 = Number(m[1]);
      const n1 = Number(m[2]);
      const n2Str = m[3];
      const divisor = n1 * 2;
      let t;
      if (n2Str.length === 2) {
        const d1 = Number(n2Str[0]);
        const d2 = Number(n2Str[1]);
        t = n3 - d1 * d2 * 2;
      } else if (n2Str.length === 3) {
        const d1 = Number(n2Str[0]);
        const d2 = Number(n2Str[1]);
        const d3 = Number(n2Str[2]);
        // Generator's intent formula:
        t = n3 - (d1 * d3 * 2 + d2 * d2);
        // Note: The original desktop program computed:
        //   const tLegacyMistake = n3 - d1 * d3 * 2 + d2 * d2;
        // which omitted parentheses around (d1 * d3 * 2 + d2 * d2) despite
        // generating the lower bound as a = d1 * d3 * 2 + d2 * d2 + 10.
      } else {
        throw new Error(`Invalid n2 length in modulo question: ${text}`);
      }
      const quotient = Math.trunc(t / divisor);
      const remainder = t % divisor;
      return [quotient, remainder];
    }

    case 'ratio': {
      const m = text.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) throw new Error(`Invalid ratio question: ${text}`);
      const A = BigInt(m[1]);
      const B = BigInt(m[2]);
      const g = gcdBigInt(A, B);
      return `${(A / g).toString()}/${(B / g).toString()}`;
    }

    case 'days_to_seconds': {
      // Format: "Mon d1, y1 - Mon2 d2, y2"
      const m = text.match(/^([A-Za-z.]+)\s+(\d+),\s*(\d+)\s*-\s*([A-Za-z.]+)\s+(\d+),\s*(\d+)$/);
      if (!m) throw new Error(`Invalid days_to_seconds question: ${text}`);
      const mon1Name = m[1];
      const d1 = Number(m[2]);
      const mon2Name = m[4];
      const d2 = Number(m[5]);

      const idx1 = DAYS_TO_SECONDS_MONTHS.findIndex((x) => x.name === mon1Name);
      const idx2 = DAYS_TO_SECONDS_MONTHS.findIndex((x) => x.name === mon2Name);
      if (idx1 === -1 || idx2 === -1 || idx2 <= idx1) {
        throw new Error(`Invalid month pair in days_to_seconds: ${text}`);
      }

      const daysLeftFirst = DAYS_TO_SECONDS_MONTHS[idx1].days - d1;
      let daysBetween = 0;
      for (let k = idx1 + 1; k < idx2; k++) {
        daysBetween += DAYS_TO_SECONDS_MONTHS[k].days;
      }
      const totalDays = daysLeftFirst + daysBetween + d2;
      return Number(BigInt(totalDays) * 86400n);
    }

    case 'hours_to_seconds': {
      const m = text.match(/^(\d+):00:00\s*-\s*(\d+):00:00$/);
      if (!m) throw new Error(`Invalid hours_to_seconds question: ${text}`);
      const h1 = Number(m[1]);
      const h2 = Number(m[2]);
      return (h2 - h1) * 3600;
    }

    case 'minutes_to_seconds': {
      const m = text.match(/^(\d+):(\d+)\s*-\s*(\d+):(\d+)$/);
      if (!m) throw new Error(`Invalid minutes_to_seconds question: ${text}`);
      const m1 = Number(m[1]);
      const s1 = Number(m[2]);
      const m2 = Number(m[3]);
      const s2 = Number(m[4]);
      return m2 * 60 + s2 - (m1 * 60 + s1);
    }

    case 'number_to_be_squared': {
      const n = BigInt(text);
      const info = exactSqrtInfo(n);
      return info.smallestSquareGreater;
    }

    default:
      throw new Error(`Unknown drill key: ${drillKey}`);
  }
}

// ============================================================================
// THE 18 DRILLS DEFINITION
// ============================================================================

export const DRILLS = {
  day_codes: {
    key: 'day_codes',
    title: 'Day Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the day code (Sunday=1, Monday=2, Tuesday=3, Wednesday=4, Thursday=5, Friday=6, Saturday=0).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 56; i++) {
        const item = pickRandom(rng, DAY_CODES_TABLE);
        out.push({ text: item.name, expected: item.code });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  month_codes: {
    key: 'month_codes',
    title: 'Month Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the month code (Jan=1, Feb=4, Mar=4, Apr=0, May=2, Jun=5, Jul=0, Aug=3, Sep=6, Oct=1, Nov=4, Dec=6).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 56; i++) {
        const item = pickRandom(rng, MONTH_CODES_TABLE);
        out.push({ text: item.text, expected: item.code });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  century_codes: {
    key: 'century_codes',
    title: 'Century Codes',
    group: 'Codes',
    questions: 56,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the century code from the first two digits mod 4 (0→6, 1→4, 2→2, 3→0).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 56; i++) {
        const a = randInt(rng, 11, 30);
        const b = randInt(rng, 11, 99);
        const text = `${a}${b}`;
        const expected = CENTURY_MOD4_TO_CODE[a % 4];
        out.push({ text, expected });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  time_conversion: {
    key: 'time_conversion',
    title: 'Conversion in Seconds',
    group: 'Time',
    questions: 25,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Convert the given time into total seconds (commas optional).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 24; i++) {
        const n = randInt(rng, 1, 6);
        const unitObj = pickRandom(rng, TIME_CONVERSION_UNITS);
        const text = `${n} ${unitObj.unit}`;
        const expected = Number(BigInt(n) * BigInt(unitObj.seconds));
        out.push({ text, expected });
      }
      // The 25th question is always "1 Year"
      out.push({ text: '1 Year', expected: YEAR_SECONDS });
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  squares_11_50: {
    key: 'squares_11_50',
    title: 'Square (11-50)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each number.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 11, 50);
        out.push({ text: String(n), expected: n * n });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  squares_51_100: {
    key: 'squares_51_100',
    title: 'Square (51-100)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each number.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 51, 100);
        out.push({ text: String(n), expected: n * n });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  cubes_11_50: {
    key: 'cubes_11_50',
    title: 'Cube (11-50)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 180,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact cube of each number.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 11, 50);
        out.push({ text: String(n), expected: n * n * n });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  cubes_51_100: {
    key: 'cubes_51_100',
    title: 'Cube (51-100)',
    group: 'Squares and cubes',
    questions: 50,
    time_limit_seconds: 240,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact cube of each number.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 51, 100);
        out.push({ text: String(n), expected: n * n * n });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  divide_by_4: {
    key: 'divide_by_4',
    title: 'Division by 4',
    group: 'Division',
    questions: 50,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the whole-number quotient (n div 4), ignoring any remainder.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 11, 99);
        out.push({ text: `${n} / 4`, expected: Math.trunc(n / 4) });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  divide_by_7: {
    key: 'divide_by_7',
    title: 'Division by 7',
    group: 'Division',
    questions: 50,
    time_limit_seconds: 60,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type only the remainder when divided by 7 (n mod 7).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 50; i++) {
        const n = randInt(rng, 11, 99);
        out.push({ text: `${n} / 7`, expected: n % 7 });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  prime_factors: {
    key: 'prime_factors',
    title: 'Prime Factor',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'text',
    hint: 'Type the two prime factors separated by x, *, comma, or space (e.g. 13 x 97).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 20; i++) {
        const p1 = pickRandom(rng, PRIME_POOL);
        const p2 = pickRandom(rng, PRIME_POOL);
        const product = p1 * p2;
        const expected = p1 <= p2 ? [p1, p2] : [p2, p1];
        out.push({ text: String(product), expected });
      }
      return out;
    },
    parse: parsePrimeFactorsAnswer,
    equal: equalPrimeFactorsAnswer,
    format: formatPrimeFactorsAnswer,
  },

  modulo: {
    key: 'modulo',
    title: 'Modulo Calculation',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 240,
    enabled: MODULO_ENABLED,
    inputmode: 'text',
    hint: 'Type quotient and remainder separated by a comma or space (e.g. 12, 5).',
    generate(rng = defaultRng) {
      const out = [];
      // First 15 questions: n1 (11-99) and two-digit n2 (11-99, digits d1 d2)
      for (let i = 0; i < 15; i++) {
        let n1 = 11;
        let n2 = 11;
        let d1 = 1;
        let d2 = 1;
        let a = 12;
        let b = 220;
        for (let attempt = 0; attempt < 100; attempt++) {
          n1 = randInt(rng, 11, 99);
          n2 = randInt(rng, 11, 99);
          d1 = Math.trunc(n2 / 10);
          d2 = n2 % 10;
          a = d1 * d2 * 2 + 10;
          b = n1 * 20;
          if (a <= b) break;
        }
        const n3 = randInt(rng, a, b);
        const text = `${n3}    ${n1}.${n2}`;
        const t = n3 - d1 * d2 * 2;
        const divisor = n1 * 2;
        const expected = [Math.trunc(t / divisor), t % divisor];
        out.push({ text, expected });
      }

      // Next 5 questions: n1 (11-99) and three-digit n2 (111-999, digits d1 d2 d3)
      for (let i = 0; i < 5; i++) {
        let n1 = 20;
        let n2 = 111;
        let d1 = 1;
        let d2 = 1;
        let d3 = 1;
        let a = 13;
        let b = 400;
        for (let attempt = 0; attempt < 100; attempt++) {
          n1 = randInt(rng, 11, 99);
          n2 = randInt(rng, 111, 999);
          d1 = Math.trunc(n2 / 100);
          d2 = Math.trunc((n2 % 100) / 10);
          d3 = n2 % 10;
          a = d1 * d3 * 2 + d2 * d2 + 10;
          b = n1 * 20;
          if (a <= b) break;
        }
        if (a > b) {
          // Guaranteed valid fallback if a quirky custom rng produces a > b
          n1 = 20;
          b = n1 * 20;
        }
        const n3 = randInt(rng, a, b);
        const text = `${n3}    ${n1}.${n2}`;
        // Generator's intent formula:
        const t = n3 - (d1 * d3 * 2 + d2 * d2);
        // Note: The original Python desktop program computed:
        //   const tLegacyMistake = n3 - d1 * d3 * 2 + d2 * d2;
        // which looks like a mistake (missing parentheses after minus).
        // Both formulas are kept here as documented in DECISIONS.md.
        const divisor = n1 * 2;
        const expected = [Math.trunc(t / divisor), t % divisor];
        out.push({ text, expected });
      }

      return out;
    },
    parse: parseModuloAnswer,
    equal: equalModuloAnswer,
    format: formatModuloAnswer,
  },

  ratio: {
    key: 'ratio',
    title: 'Ratio',
    group: 'Other',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'text',
    hint: 'Type the simplified ratio in lowest terms as a/b (e.g. 4/7).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 20; i++) {
        const k = randInt(rng, 111, 999);
        const p = randInt(rng, 8, 14);
        let q = randInt(rng, 14, 19);
        if (p === q) {
          // p and q can only collide at 14; pick from 15..19 if p === 14
          q = randInt(rng, 15, 19);
        }
        const A = k * p;
        const B = k * q;
        const g = Number(gcdBigInt(p, q));
        const expected = `${p / g}/${q / g}`;
        out.push({ text: `${A} / ${B}`, expected });
      }
      return out;
    },
    parse: parseRatioAnswer,
    equal: equalRatioAnswer,
    format: formatRatioAnswer,
  },

  days_to_seconds: {
    key: 'days_to_seconds',
    title: 'Days --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Convert the days between the two dates into seconds (years ignored, Feb = 28 days).',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 10; i++) {
        const m1Idx = randInt(rng, 0, 7); // Jan. (0) to Aug. (7)
        const offset = randInt(rng, 1, 4); // 1 to 4 months later
        const m2Idx = m1Idx + offset;

        const m1 = DAYS_TO_SECONDS_MONTHS[m1Idx];
        const m2 = DAYS_TO_SECONDS_MONTHS[m2Idx];

        const maxD1 = Math.min(30, m1.days);
        const maxD2 = Math.min(30, m2.days);

        const d1 = randInt(rng, 1, maxD1);
        const d2 = randInt(rng, 1, maxD2);

        const y1 = randInt(rng, 1600, 2000);
        const y2 = randInt(rng, 1600, 2000);

        const text = `${m1.name} ${d1}, ${y1} - ${m2.name} ${d2}, ${y2}`;

        const daysLeftFirst = m1.days - d1;
        let daysBetween = 0;
        for (let k = m1Idx + 1; k < m2Idx; k++) {
          daysBetween += DAYS_TO_SECONDS_MONTHS[k].days;
        }
        const totalDays = daysLeftFirst + daysBetween + d2;
        const expected = Number(BigInt(totalDays) * 86400n);

        out.push({ text, expected });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  hours_to_seconds: {
    key: 'hours_to_seconds',
    title: 'Hours --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the number of seconds between the two times.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 10; i++) {
        const h1 = randInt(rng, 5, 15);
        const h2 = randInt(rng, 15, 24);
        const text = `${h1}:00:00 - ${h2}:00:00`;
        const expected = (h2 - h1) * 3600;
        out.push({ text, expected });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  minutes_to_seconds: {
    key: 'minutes_to_seconds',
    title: 'Minutes --> Seconds',
    group: 'Time',
    questions: 10,
    time_limit_seconds: 120,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the number of seconds between the two mm:ss times.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 10; i++) {
        let m1 = 11;
        let s1 = 11;
        let m2 = 24;
        let s2 = 11;
        let diff = 1;
        for (let attempt = 0; attempt < 100; attempt++) {
          m1 = randInt(rng, 11, 23);
          s1 = randInt(rng, 11, 59);
          m2 = randInt(rng, 23, 59);
          s2 = randInt(rng, 11, 59);
          diff = m2 * 60 + s2 - (m1 * 60 + s1);
          if (diff >= 0) break;
        }
        if (diff < 0) {
          // Guaranteed non-negative fallback if a custom rng persistently picks m1=23, m2=23, s1 > s2
          m2 = 24;
          diff = m2 * 60 + s2 - (m1 * 60 + s1);
        }
        const text = `${m1}:${s1} - ${m2}:${s2}`;
        out.push({ text, expected: diff });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  number_to_be_squared: {
    key: 'number_to_be_squared',
    title: 'Number To Be Squared',
    group: 'Squares and cubes',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the smallest whole number whose square is greater than the number shown.',
    generate(rng = defaultRng) {
      const out = [];
      for (let i = 0; i < 20; i++) {
        let n = randInt(rng, 11111, 5555555);
        let info = exactSqrtInfo(n);
        while (info.isPerfectSquare) {
          n = n < 5555555 ? n + 1 : n - 1;
          info = exactSqrtInfo(n);
        }
        out.push({ text: String(n), expected: info.smallestSquareGreater });
      }
      return out;
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },

  squares_3d_4d: {
    key: 'squares_3d_4d',
    title: '3D - 4D Square',
    group: 'Squares and cubes',
    questions: 20,
    time_limit_seconds: 300,
    enabled: true,
    inputmode: 'numeric',
    hint: 'Type the exact square of each 3-digit or 4-digit number.',
    generate(rng = defaultRng) {
      const threeDigitSet = new Set();
      while (threeDigitSet.size < 10) {
        const candidate = randInt(rng, 111, 999);
        if (threeDigitSet.has(candidate)) {
          // Deterministic linear probe if custom RNG repeats values
          for (let step = 1; step <= 889; step++) {
            const next = 111 + ((candidate - 111 + step) % 889);
            if (!threeDigitSet.has(next)) {
              threeDigitSet.add(next);
              break;
            }
          }
        } else {
          threeDigitSet.add(candidate);
        }
      }

      const fourDigitSet = new Set();
      while (fourDigitSet.size < 10) {
        const candidate = randInt(rng, 1111, 9999);
        if (fourDigitSet.has(candidate)) {
          for (let step = 1; step <= 8889; step++) {
            const next = 1111 + ((candidate - 1111 + step) % 8889);
            if (!fourDigitSet.has(next)) {
              fourDigitSet.add(next);
              break;
            }
          }
        } else {
          fourDigitSet.add(candidate);
        }
      }

      const numbers = [...threeDigitSet, ...fourDigitSet];
      shuffleInPlace(rng, numbers);

      return numbers.map((n) => ({
        text: String(n),
        expected: Number(BigInt(n) * BigInt(n)),
      }));
    },
    parse: parseIntegerAnswer,
    equal: equalIntegerAnswer,
    format: formatIntegerAnswer,
  },
};

export const DRILL_KEYS = Object.keys(DRILLS);

/**
 * Builds the safe client-facing response payload for `POST /api/drill { action: 'start' }`.
 * Strips all expected answers so only question prompt strings are returned.
 *
 * @param {{
 *   sessionId: string,
 *   drillKey: string,
 *   drill: object,
 *   generated: Array<{ text: string, expected: any }>
 * }} params
 */
export function buildDrillStartResponse({ sessionId, drillKey, drill, generated }) {
  const questionTexts = (generated || []).map((q) =>
    typeof q === 'string' ? q : String(q.text)
  );

  return {
    session_id: sessionId,
    drill: drillKey,
    title: drill.title,
    questions: questionTexts,
    time_limit_seconds: drill.time_limit_seconds,
    hint: drill.hint,
  };
}

/**
 * Grades a student's submitted answers against a drill's questions and expected canonical answers.
 *
 * @param {{
 *   drillKey: string,
 *   questions: string[],
 *   expected: any[],
 *   answers: Array<string|null>,
 *   elapsedSeconds: number,
 *   timeLimitSeconds: number
 * }} params
 */
export function gradeDrillSubmission({
  drillKey,
  questions,
  expected,
  answers,
  elapsedSeconds,
  timeLimitSeconds,
}) {
  const drill = DRILLS[drillKey];
  if (!drill) {
    throw new Error('Unknown drill.');
  }

  let attempted = 0;
  let correct = 0;
  const detail = [];

  for (let i = 0; i < questions.length; i++) {
    const qText = String(questions[i]);
    const expVal = expected[i];
    const rawAns = answers[i];
    const trimmed = rawAns === null || rawAns === undefined ? '' : String(rawAns).trim();
    const isBlank = trimmed === '';

    let isCorrect = false;
    if (!isBlank) {
      attempted += 1;
      const parsed = drill.parse(trimmed);
      isCorrect = parsed !== null && drill.equal(parsed, expVal);
      if (isCorrect) {
        correct += 1;
      }
    }

    detail.push({
      question: qText,
      expected_display: drill.format(expVal),
      given: isBlank ? null : trimmed,
      correct: isCorrect,
    });
  }

  const questionsTotal = questions.length;
  const accuracy =
    attempted > 0 ? Math.round((correct / attempted) * 1000) / 10 : 0;
  const clampedSeconds = Math.max(
    0,
    Math.min(Math.round(elapsedSeconds), Number(timeLimitSeconds) || 0)
  );

  return {
    correct,
    attempted,
    questions_total: questionsTotal,
    accuracy,
    seconds: clampedSeconds,
    detail,
  };
}

// ============================================================================
// PHASE 9A: ONLINE BASICS QUESTION GENERATORS & SUBMISSION CHECKER
// ============================================================================

/**
 * Computes the inclusive [min, max] range for an N-digit number in Basics drills.
 * - When `avoidOne` is true and digits === 1, returns [2, 9] (used for 1-digit
 *   multiplication factors and 1-digit divisors).
 * - Otherwise, returns [1, 9] for 1-digit and [10^(N-1), 10^N - 1] for N >= 2.
 *
 * @param {number} digits
 * @param {boolean} [avoidOne=false]
 * @returns {[number, number]}
 */
export function getDigitRange(digits, avoidOne = false) {
  if (digits === 1) {
    return [avoidOne ? 2 : 1, 9];
  }
  const min = 10 ** (digits - 1);
  const max = 10 ** digits - 1;
  return [min, max];
}

/**
 * Parses a Basics category name to determine if it is supported for online practice.
 * Rules:
 * - Case-insensitive, spaces ignored.
 * - "<N>d<R>r" (e.g. 1d4r, 2d2r, 2d4r): N in 1..4, R in 2..10.
 * - "<A>dx<B>d" (e.g. 1dx1d, 2dx1d): multiplication sign may be x, X, ×, or *; A, B in 1..4.
 * - "<A>d/<B>d" (e.g. 2d/1d, 3d/1d): division sign may be / or ÷; A, B in 1..4,
 *   and at least one valid divisor in the B-digit range must produce a valid positive
 *   integer quotient whose product has exactly A digits (requires A >= B).
 * - Any other name returns null ("not available online").
 *
 * @param {unknown} rawName
 * @returns {{
 *   type: 'add_sub' | 'mul' | 'div',
 *   digits?: number,
 *   rows?: number,
 *   digitsA?: number,
 *   digitsB?: number,
 *   validDivisors?: Array<{ divisor: number, minQ: number, maxQ: number }>
 * } | null}
 */
export function parseBasicsCategoryName(rawName) {
  if (typeof rawName !== 'string') return null;
  const cleaned = rawName.replace(/\s+/g, '').toLowerCase();
  if (!cleaned) return null;

  // 1. Add/Subtract rows: "<N>d<R>r"
  const addSubMatch = cleaned.match(/^(\d+)d(\d+)r$/);
  if (addSubMatch) {
    const digits = Number(addSubMatch[1]);
    const rows = Number(addSubMatch[2]);
    if (
      !Number.isInteger(digits) ||
      digits < BASICS_MIN_DIGITS ||
      digits > BASICS_MAX_DIGITS ||
      !Number.isInteger(rows) ||
      rows < BASICS_MIN_ROWS ||
      rows > BASICS_MAX_ROWS
    ) {
      return null;
    }
    return { type: 'add_sub', digits, rows };
  }

  // 2. Multiplication: "<A>dx<B>d" (x, X, ×, ✕, ✖, *)
  const mulMatch = cleaned.match(/^(\d+)d(?:x|\*|\u00d7|\u2715|\u2716)(\d+)d$/);
  if (mulMatch) {
    const digitsA = Number(mulMatch[1]);
    const digitsB = Number(mulMatch[2]);
    if (
      !Number.isInteger(digitsA) ||
      digitsA < BASICS_MIN_DIGITS ||
      digitsA > BASICS_MAX_DIGITS ||
      !Number.isInteger(digitsB) ||
      digitsB < BASICS_MIN_DIGITS ||
      digitsB > BASICS_MAX_DIGITS
    ) {
      return null;
    }
    return { type: 'mul', digitsA, digitsB };
  }

  // 3. Exact Division: "<A>d/<B>d" or "<A>dby<B>d" (/, ÷, ∕, by)
  const divMatch = cleaned.match(/^(\d+)d(?:\/|\u00f7|\u2215|by)(\d+)d$/);
  if (divMatch) {
    const digitsA = Number(divMatch[1]);
    const digitsB = Number(divMatch[2]);
    if (
      !Number.isInteger(digitsA) ||
      digitsA < BASICS_MIN_DIGITS ||
      digitsA > BASICS_MAX_DIGITS ||
      !Number.isInteger(digitsB) ||
      digitsB < BASICS_MIN_DIGITS ||
      digitsB > BASICS_MAX_DIGITS
    ) {
      return null;
    }

    const [minDividend, maxDividend] = getDigitRange(digitsA, false);
    const [minDivisor, maxDivisor] = getDigitRange(digitsB, true);

    // Check if valid quotients exist such that divisor * quotient has A digits
    // (When digitsA === 1 and digitsB === 1, require quotient >= 2 so dividend !== divisor, or >= 1)
    const validDivisors = [];
    for (let d = minDivisor; d <= maxDivisor; d++) {
      const minQ = Math.max(1, Math.ceil(minDividend / d));
      const maxQ = Math.floor(maxDividend / d);
      if (minQ <= maxQ) {
        validDivisors.push({ divisor: d, minQ, maxQ });
      }
    }

    if (validDivisors.length === 0) {
      return null;
    }

    return { type: 'div', digitsA, digitsB, validDivisors };
  }

  return null;
}

/**
 * Returns the allowed question count slabs for a given Basics category:
 * - 1d4r, 2d2r, 1dx1d, 2dx1d, 2dby1d (2d/1d): [20, 50, 100, 200]
 * - 2d4r: [10, 20, 30, 50]
 * - 3d/1d (3dby1d): [10, 50, 100]
 *
 * @param {string | { name?: string }} categoryOrName
 * @returns {number[]}
 */
export function getBasicsQuestionCounts(categoryOrName) {
  const rawName =
    typeof categoryOrName === 'object' && categoryOrName !== null
      ? categoryOrName.name
      : categoryOrName;
  const spec = parseBasicsCategoryName(rawName);
  if (!spec) return [...BASICS_QUESTION_COUNTS];

  let canonicalKey = '';
  if (spec.type === 'add_sub') {
    canonicalKey = `${spec.digits}d${spec.rows}r`;
  } else if (spec.type === 'mul') {
    canonicalKey = `${spec.digitsA}dx${spec.digitsB}d`;
  } else if (spec.type === 'div') {
    canonicalKey = `${spec.digitsA}d/${spec.digitsB}d`;
  }

  if (BASICS_CATEGORY_QUESTION_SLABS[canonicalKey]) {
    return [...BASICS_CATEGORY_QUESTION_SLABS[canonicalKey]];
  }
  return [...BASICS_QUESTION_COUNTS];
}

/**
 * Returns the default question count for a given Basics category (the first slab).
 *
 * @param {string | { name?: string }} categoryOrName
 * @returns {number}
 */
export function getBasicsDefaultQuestions(categoryOrName) {
  const slabs = getBasicsQuestionCounts(categoryOrName);
  return slabs[0] || BASICS_DEFAULT_QUESTIONS;
}

/**
 * Returns true if the given category name or category object is supported for online Basics practice.
 * An inactive category (`active === false`) is never available online.
 *
 * @param {string | { name?: string, active?: boolean, section?: string }} categoryOrName
 * @returns {boolean}
 */
export function isBasicsCategorySupported(categoryOrName) {
  if (!categoryOrName) return false;
  if (typeof categoryOrName === 'object') {
    if (categoryOrName.active === false) return false;
    if (categoryOrName.section && categoryOrName.section !== 'basics') return false;
    return parseBasicsCategoryName(categoryOrName.name) !== null;
  }
  return parseBasicsCategoryName(categoryOrName) !== null;
}

/**
 * Generates a single Basics question from a parsed spec or category name.
 *
 * @param {string | ReturnType<typeof parseBasicsCategoryName>} specOrName
 * @param {Function} [rng=defaultRng]
 * @returns {{
 *   type: 'add_sub' | 'mul' | 'div',
 *   rows?: number[],
 *   a?: number,
 *   b?: number,
 *   dividend?: number,
 *   divisor?: number,
 *   text: string,
 *   expected: number
 * }}
 */
export function generateBasicsQuestion(specOrName, rng = defaultRng) {
  const spec =
    typeof specOrName === 'string' ? parseBasicsCategoryName(specOrName) : specOrName;
  if (!spec) {
    throw new Error('Category is not available for online practice.');
  }

  if (spec.type === 'add_sub') {
    const { digits, rows: rowCount } = spec;
    const [minMag, maxMag] = getDigitRange(digits, false);
    const rows = [];

    // First row is always positive
    const firstVal = randInt(rng, minMag, maxMag);
    rows.push(firstVal);
    let runningTotal = firstVal;
    let prevMag = firstVal;

    // Subsequent rows: subtracted with probability 40%, runningTotal >= 0, no equal neighbours
    for (let r = 1; r < rowCount; r++) {
      let chosenSigned = null;

      for (let attempt = 0; attempt < BASICS_ROW_RETRY_LIMIT; attempt++) {
        // Draw subtraction decision with 40% probability (1..100 <= 40)
        const wantSub = randInt(rng, 1, 100) <= Math.round(BASICS_SUB_PROBABILITY * 100);
        const canSub =
          runningTotal >= minMag &&
          !(Math.min(maxMag, runningTotal) === minMag && minMag === prevMag);

        if (wantSub && canSub) {
          const maxSub = Math.min(maxMag, runningTotal);
          const mag = randInt(rng, minMag, maxSub);
          if (mag !== prevMag && runningTotal - mag >= 0) {
            chosenSigned = -mag;
            break;
          }
        } else {
          const mag = randInt(rng, minMag, maxMag);
          if (mag !== prevMag) {
            chosenSigned = mag;
            break;
          }
        }
      }

      // Deterministic fallback if all 20 retries collided with prevMag
      if (chosenSigned === null) {
        const fallbackMag = prevMag === minMag ? minMag + 1 : minMag;
        chosenSigned = fallbackMag;
      }

      rows.push(chosenSigned);
      runningTotal += chosenSigned;
      prevMag = Math.abs(chosenSigned);
    }

    const text = rows.map((n) => (n >= 0 ? `+${n}` : `${n}`)).join(' ');
    return {
      type: 'add_sub',
      rows,
      text,
      expected: runningTotal,
    };
  }

  if (spec.type === 'mul') {
    const [minA, maxA] = getDigitRange(spec.digitsA, true);
    const [minB, maxB] = getDigitRange(spec.digitsB, true);
    const a = randInt(rng, minA, maxA);
    const b = randInt(rng, minB, maxB);
    return {
      type: 'mul',
      a,
      b,
      text: `${a} x ${b}`,
      expected: a * b,
    };
  }

  if (spec.type === 'div') {
    const validList = spec.validDivisors;
    const picked = pickRandom(rng, validList);
    const divisor = picked.divisor;
    const quotient = randInt(rng, picked.minQ, picked.maxQ);
    const dividend = divisor * quotient;
    return {
      type: 'div',
      dividend,
      divisor,
      text: `${dividend} / ${divisor}`,
      expected: quotient,
    };
  }

  throw new Error('Unsupported basics category specification.');
}

/**
 * Generates a full set of Basics questions (5, 10, or 20, default 10).
 *
 * @param {string} categoryName
 * @param {number} [count=BASICS_DEFAULT_QUESTIONS]
 * @param {Function} [rng=defaultRng]
 */
export function generateBasicsSet(
  categoryName,
  count = BASICS_DEFAULT_QUESTIONS,
  rng = defaultRng
) {
  const spec = parseBasicsCategoryName(categoryName);
  if (!spec) {
    throw new Error('Category is not available for online practice.');
  }
  const n = BASICS_QUESTION_COUNTS.includes(Number(count))
    ? Number(count)
    : BASICS_DEFAULT_QUESTIONS;

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(generateBasicsQuestion(spec, rng));
  }
  return out;
}

export const generateBasicsQuestions = generateBasicsSet;

/**
 * Strips `expected` from generated Basics questions before storing in `drill_sessions.questions`
 * or returning to the browser on `start`.
 *
 * @param {Array<ReturnType<typeof generateBasicsQuestion>>} generated
 */
export function stripBasicsExpected(generated = []) {
  return generated.map((q) => {
    const copy = { type: q.type, text: q.text };
    if (Array.isArray(q.rows)) copy.rows = [...q.rows];
    if (typeof q.a === 'number') copy.a = q.a;
    if (typeof q.b === 'number') copy.b = q.b;
    if (typeof q.dividend === 'number') copy.dividend = q.dividend;
    if (typeof q.divisor === 'number') copy.divisor = q.divisor;
    return copy;
  });
}

/**
 * Pure submission validator and grader for online Basics practice (`checkSubmission(session, answers, now)`).
 * Rules:
 * - Session must be 'open' and not expired (`now <= expires_at`).
 * - `answers` must be an array of the exact question length; each element is a string of up to 20 chars or `null`.
 * - Rejects if `elapsed < questions * 0.6` seconds (`finished faster than possible, not saved`).
 * - Skipped (`null`) or blank (`""`) answers count as wrong.
 * - `total` is always the number of questions in the set.
 * - `time_seconds = min(round(elapsed), 14400)`.
 *
 * @param {object} session
 * @param {Array<string|null>} answers
 * @param {number|string|Date} [now=Date.now()]
 * @returns {{
 *   ok: boolean,
 *   statusCode?: number,
 *   error?: string,
 *   correct?: number,
 *   total?: number,
 *   accuracy?: number,
 *   seconds?: number,
 *   detail?: Array<{ question: string, question_data: object|null, expected_display: string, given: string|null, correct: boolean }>
 * }}
 */
export function checkSubmission(session, answers, now = Date.now()) {
  if (!session || typeof session !== 'object') {
    return {
      ok: false,
      statusCode: 404,
      error: 'Practice session not found. Please start a new set.',
    };
  }

  if (session.status && session.status !== 'open') {
    return {
      ok: false,
      statusCode: 400,
      error: 'already submitted',
    };
  }

  const expected = Array.isArray(session.expected) ? session.expected : [];
  const questions =
    Array.isArray(session.questions) && session.questions.length > 0
      ? session.questions
      : expected;
  const questionCount = expected.length || questions.length;

  if (!Array.isArray(answers)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Answers must be provided as a list.',
    };
  }

  if (answers.length !== questionCount) {
    return {
      ok: false,
      statusCode: 400,
      error: `Expected ${questionCount} answers, but received ${answers.length}.`,
    };
  }

  for (let i = 0; i < answers.length; i++) {
    const item = answers[i];
    if (item === null) continue;
    if (typeof item !== 'string') {
      return {
        ok: false,
        statusCode: 400,
        error: `Answer for question ${i + 1} must be text or null.`,
      };
    }
    if (item.length > BASICS_MAX_ANSWER_LENGTH) {
      return {
        ok: false,
        statusCode: 400,
        error: `Answer for question ${i + 1} is too long (maximum ${BASICS_MAX_ANSWER_LENGTH} characters).`,
      };
    }
  }

  const nowMs =
    typeof now === 'number' ? now : now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (session.expires_at !== undefined && session.expires_at !== null) {
    const expiresMs =
      typeof session.expires_at === 'number'
        ? session.expires_at
        : new Date(session.expires_at).getTime();
    if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Time is up, please start a new set',
      };
    }
  }

  const startedMs =
    typeof session.started_at === 'number'
      ? session.started_at
      : new Date(session.started_at).getTime();

  const elapsedSeconds = Number.isFinite(startedMs) ? (nowMs - startedMs) / 1000 : 0;

  if (elapsedSeconds < questionCount * BASICS_MIN_SECONDS_PER_QUESTION) {
    return {
      ok: false,
      statusCode: 400,
      error: 'finished faster than possible, not saved',
    };
  }

  let correct = 0;
  const detail = [];

  for (let i = 0; i < questionCount; i++) {
    const qItem = questions[i];
    const qText =
      typeof qItem === 'object' && qItem !== null ? String(qItem.text || '') : String(qItem ?? '');
    const expVal = Number(expected[i]);
    const rawAns = answers[i];
    const trimmed = rawAns === null || rawAns === undefined ? '' : String(rawAns).trim();
    const isBlank = trimmed === '';

    let isCorrect = false;
    if (!isBlank) {
      const parsed = parseIntegerAnswer(trimmed);
      isCorrect = parsed !== null && equalIntegerAnswer(parsed, expVal);
      if (isCorrect) {
        correct += 1;
      }
    }

    detail.push({
      question: qText,
      question_data: typeof qItem === 'object' && qItem !== null ? qItem : null,
      expected_display: formatIntegerAnswer(expVal),
      given: isBlank ? null : trimmed,
      correct: isCorrect,
    });
  }

  const total = questionCount;
  const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
  const seconds = Math.min(Math.max(0, Math.round(elapsedSeconds)), BASICS_MAX_TIME_SECONDS);

  return {
    ok: true,
    correct,
    total,
    accuracy,
    seconds,
    detail,
  };
}

