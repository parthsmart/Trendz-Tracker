/**
 * Trendz Tracker — Shared Memoriad generators & official scoring (js/memoriadGenerators.js)
 *
 * Pure module (no Node or DOM imports) shared by the server (`api/_memoriad.js`),
 * demo mode (`js/demoDb.js`) and the student stage. Every generator takes an injectable
 * `rng(minInclusive, maxInclusive)` so tests can be deterministic.
 *
 * Official rules (memoriad.com category "Rules" pages):
 * - Mental Multiplication: 5d x 5d = 10 tasks in 5 min, 8d x 8d = 10 tasks in 12 min.
 *   First digit is never 0. 1 point per fully correct product.
 * - Mental Division (10d / 5d): 10 tasks in 6 min, exact division with no remainder.
 * - Mental Square Roots: answers to 5 decimals rounded half-up. 6-digit = 15 min,
 *   8-digit = 18 min, 10-digit = 22 min. Digit N counts when |A - B| <= 5 * 10^(M - N)
 *   (M = integer digits - 1); points are triangular 1 + 2 + ... + k.
 * - Final points = score * T / t, where t = T unless every task was answered (all correct
 *   for multiplication/division/additions).
 * Levels between the official ones use interpolated times (marked "practice" in the UI).
 */

export const MEMORIAD_QUESTION_COUNT = 10;

export const MULTIPLICATION_DIGITS_MIN = 3;
export const MULTIPLICATION_DIGITS_MAX = 10;
export const MULTIPLICATION_DEFAULT_DIGITS = 8;
/** Seconds per round by factor length (5d and 8d are official). */
export const MULTIPLICATION_TIME_BY_DIGITS = Object.freeze({
  3: 120,
  4: 180,
  5: 300,
  6: 420,
  7: 540,
  8: 720,
  9: 900,
  10: 1080,
});

export const SQUARE_ROOT_DIGITS_MIN = 4;
export const SQUARE_ROOT_DIGITS_MAX = 10;
export const SQUARE_ROOT_DEFAULT_DIGITS = 6;
export const SQUARE_ROOT_DECIMALS = 5;
/** Seconds per round by radicand length (6, 8 and 10 digits are official). */
export const SQUARE_ROOT_TIME_BY_DIGITS = Object.freeze({
  4: 720,
  5: 840,
  6: 900,
  7: 1020,
  8: 1080,
  9: 1200,
  10: 1320,
});

export const DIVISION_DIVIDEND_MIN = 4;
export const DIVISION_DIVIDEND_MAX = 10;
export const DIVISION_DIVISOR_MIN = 2;
export const DIVISION_DIVISOR_MAX = 5;
export const DIVISION_DEFAULT_DIVIDEND = 10;
export const DIVISION_DEFAULT_DIVISOR = 5;
/** Seconds per round by dividend length (10d / 5d = 6 min is official). */
export const DIVISION_TIME_BY_DIVIDEND = Object.freeze({
  4: 120,
  5: 150,
  6: 180,
  7: 210,
  8: 240,
  9: 300,
  10: 360,
});

export const MEMORIAD_LAYOUTS = Object.freeze(['vertical', 'horizontal']);
export const MEMORIAD_DEFAULT_LAYOUT = 'vertical';

/** Official (non-interpolated) levels, for "Official" badges in the UI. */
export const OFFICIAL_MULTIPLICATION_DIGITS = Object.freeze([5, 8]);
export const OFFICIAL_SQUARE_ROOT_DIGITS = Object.freeze([6, 8, 10]);
export const OFFICIAL_DIVISION_LEVELS = Object.freeze(['10/5']);

/**
 * Non-cryptographic fallback RNG (demo mode / browser only).
 * @param {number} min
 * @param {number} max
 */
export function mathRandomRng(min, max) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  if (n < min || n > max) return fallback;
  return n;
}

export function normalizeMultiplicationDigits(raw) {
  return clampInt(raw, MULTIPLICATION_DIGITS_MIN, MULTIPLICATION_DIGITS_MAX, MULTIPLICATION_DEFAULT_DIGITS);
}

export function normalizeSquareRootDigits(raw) {
  return clampInt(raw, SQUARE_ROOT_DIGITS_MIN, SQUARE_ROOT_DIGITS_MAX, SQUARE_ROOT_DEFAULT_DIGITS);
}

/** Divisor must be at least 2 digits shorter than the dividend (4d/2d .. 10d/5d). */
export function isValidDivisionLevel(dividendDigits, divisorDigits) {
  const D = Number(dividendDigits);
  const d = Number(divisorDigits);
  return (
    Number.isInteger(D) &&
    Number.isInteger(d) &&
    D >= DIVISION_DIVIDEND_MIN &&
    D <= DIVISION_DIVIDEND_MAX &&
    d >= DIVISION_DIVISOR_MIN &&
    d <= DIVISION_DIVISOR_MAX &&
    d <= D - 2
  );
}

export function normalizeDivisionLevel(rawDividend, rawDivisor) {
  const D = Number(rawDividend);
  const d = Number(rawDivisor);
  if (isValidDivisionLevel(D, d)) return { dividend_digits: D, divisor_digits: d };
  return { dividend_digits: DIVISION_DEFAULT_DIVIDEND, divisor_digits: DIVISION_DEFAULT_DIVISOR };
}

export function normalizeLayout(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'horizontal' || v === 'side_by_side') return 'horizontal';
  return MEMORIAD_DEFAULT_LAYOUT;
}

/** Integer digits of the square root of a radicand with `radicandDigits` digits. */
export function squareRootIntegerDigits(radicandDigits) {
  return Math.ceil(Number(radicandDigits) / 2);
}

/**
 * Settings-aware round length in seconds. Returns null for modules without a
 * digit-dependent table (calendar/additions use the fixed limits).
 * @param {string} moduleKey
 * @param {object} [settings]
 * @returns {number|null}
 */
export function getMemoriadLevelTimeLimit(moduleKey, settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  if (moduleKey === 'multiplications') {
    return MULTIPLICATION_TIME_BY_DIGITS[normalizeMultiplicationDigits(s.digits)];
  }
  if (moduleKey === 'square_roots') {
    return SQUARE_ROOT_TIME_BY_DIGITS[normalizeSquareRootDigits(s.digits)];
  }
  if (moduleKey === 'division') {
    const lvl = normalizeDivisionLevel(s.dividend_digits, s.divisor_digits);
    return DIVISION_TIME_BY_DIVIDEND[lvl.dividend_digits];
  }
  return null;
}

/** Random number string with exactly `digits` digits (first digit never 0). */
export function randomDigitString(rng, digits) {
  let out = String(rng(1, 9));
  for (let i = 1; i < digits; i++) out += String(rng(0, 9));
  return out;
}

/**
 * Multiplication questions: `count` pairs of `digits`-digit factors.
 * @returns {{ questions: Array<[string,string]>, expected: string[] }}
 */
export function generateMultiplicationSet(rng, digits, count = MEMORIAD_QUESTION_COUNT) {
  const d = normalizeMultiplicationDigits(digits);
  const questions = [];
  const expected = [];
  for (let q = 0; q < count; q++) {
    const a = randomDigitString(rng, d);
    const b = randomDigitString(rng, d);
    questions.push([a, b]);
    expected.push((BigInt(a) * BigInt(b)).toString());
  }
  return { questions, expected };
}

/**
 * Exact division questions: dividend has exactly D digits, divisor exactly d digits,
 * no remainder, divisor never a multiple of 10 and quotient never 1-digit.
 * @returns {{ questions: Array<[string,string]>, expected: string[] }}
 */
export function generateDivisionSet(rng, dividendDigits, divisorDigits, count = MEMORIAD_QUESTION_COUNT) {
  const { dividend_digits: D, divisor_digits: d } = normalizeDivisionLevel(dividendDigits, divisorDigits);
  const questions = [];
  const expected = [];
  const seen = new Set();
  const dividendMin = 10 ** (D - 1);
  const dividendMax = 10 ** D - 1;
  let guard = 0;
  while (questions.length < count && guard < 10000) {
    guard += 1;
    const divisor = Number(randomDigitString(rng, d));
    if (divisor % 10 === 0) continue;
    const qMin = Math.max(10, Math.ceil(dividendMin / divisor));
    const qMax = Math.floor(dividendMax / divisor);
    if (qMin > qMax) continue;
    const quotient = rng(qMin, qMax);
    const dividend = BigInt(divisor) * BigInt(quotient);
    const dividendStr = dividend.toString();
    if (dividendStr.length !== D) continue;
    const key = `${dividendStr}/${divisor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push([dividendStr, String(divisor)]);
    expected.push(String(quotient));
  }
  return { questions, expected };
}

function bigIntSqrtFloor(n) {
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
 * Square root of integer `n` rounded half-up to 5 decimals, formatted with exactly
 * `intDigits` integer digits ("DDD.DDDDD"). Returns null if rounding overflows the width.
 */
export function formatSquareRoot(n, intDigits) {
  const m = BigInt(n) * 10n ** BigInt(SQUARE_ROOT_DECIMALS * 2);
  const r = bigIntSqrtFloor(m);
  const rounded = m - r * r >= r + 1n ? r + 1n : r;
  const width = intDigits + SQUARE_ROOT_DECIMALS;
  const str = rounded.toString().padStart(width, '0');
  if (str.length > width) return null;
  return `${str.slice(0, intDigits)}.${str.slice(intDigits)}`;
}

/**
 * Square-root questions: `count` distinct non-perfect-square radicands with `digits` digits.
 * @returns {{ questions: number[], expected: string[] }}
 */
export function generateSquareRootSet(rng, digits, count = MEMORIAD_QUESTION_COUNT) {
  const D = normalizeSquareRootDigits(digits);
  const I = squareRootIntegerDigits(D);
  const lo = 10 ** (D - 1);
  const hi = 10 ** D - 1;
  const questions = [];
  const expected = [];
  const seen = new Set();
  let guard = 0;
  while (questions.length < count && guard < 10000) {
    guard += 1;
    const n = rng(lo, hi);
    if (seen.has(n)) continue;
    const root = bigIntSqrtFloor(BigInt(n));
    if (root * root === BigInt(n)) continue;
    const display = formatSquareRoot(n, I);
    if (!display) continue;
    seen.add(n);
    questions.push(n);
    expected.push(display);
  }
  return { questions, expected };
}

/**
 * Parses a raw square-root answer into positional digit slots.
 * Accepts "766.32043", positional slots ("766_2043", blanks as `_` or space) or bare digits.
 */
export function parseSquareRootSlots(rawAnswer, intDigits) {
  const total = intDigits + SQUARE_ROOT_DECIMALS;
  const slots = new Array(total).fill('');
  if (rawAnswer === null || rawAnswer === undefined) return slots;
  const rawStr = String(rawAnswer);
  if (rawStr.includes('.')) {
    const [intPart = '', decPart = ''] = rawStr.split('.');
    const cleanInt = intPart.trim();
    // Right-align a short integer part ("66.5" for a 3-digit root keeps "_66").
    const offset = Math.max(0, intDigits - cleanInt.length);
    for (let i = 0; i < cleanInt.length && i + offset < intDigits; i++) {
      if (/^[0-9]$/.test(cleanInt[i])) slots[i + offset] = cleanInt[i];
    }
    for (let i = 0; i < SQUARE_ROOT_DECIMALS && i < decPart.length; i++) {
      if (/^[0-9]$/.test(decPart[i])) slots[intDigits + i] = decPart[i];
    }
  } else {
    for (let i = 0; i < total && i < rawStr.length; i++) {
      if (/^[0-9]$/.test(rawStr[i])) slots[i] = rawStr[i];
    }
  }
  return slots;
}

/**
 * Official Memoriad square-root digit count.
 * Digit N (1-based, left to right over integer + decimal digits) counts when
 * |A - B| <= 5 * 10^(M - N), M = intDigits - 1. Near a power of ten an answer that starts
 * with j nines keeps at least j digits when the correct answer is >= 10^I - 5 * 10^(I - 1 - j)
 * (the published 950 / 995 / 999.5 exceptions for 3-digit roots, generalised).
 *
 * Works in integer units of 10^-5 to avoid floating-point error.
 * @param {string} expectedDisplay "DDD.DDDDD"
 * @param {string[]} slots digit slots (blank = '')
 * @returns {number} k = counted digits (0..total)
 */
export function countSquareRootDigits(expectedDisplay, slots) {
  const [expInt = '', expDec = ''] = String(expectedDisplay).split('.');
  const I = expInt.length;
  const total = I + SQUARE_ROOT_DECIMALS;
  if (!slots.some((ch) => ch !== '')) return 0;
  const B = BigInt(expInt + expDec.padEnd(SQUARE_ROOT_DECIMALS, '0'));
  const A = BigInt(slots.map((ch) => ch || '0').join('') || '0');
  const diff = A > B ? A - B : B - A;

  let k = 0;
  for (let N = 1; N <= total; N++) {
    // tolerance 5 * 10^(I-1-N) in units of 10^-5  =>  5 * 10^(I-1-N+5)
    const exp = I - 1 - N + SQUARE_ROOT_DECIMALS;
    // Last digit: 5 * 10^-6 is below one unit, so it must match exactly.
    const tol = exp >= 0 ? 5n * 10n ** BigInt(exp) : 0n;
    if (diff <= tol) k = N;
    else break;
  }

  // Exceptions near 10^I: answer starts with j nines and correct >= 10^I - 5*10^(I-1-j).
  const scale = 10n ** BigInt(SQUARE_ROOT_DECIMALS);
  const top = 10n ** BigInt(I) * scale;
  for (let j = 1; j <= I; j++) {
    const prefix = slots.slice(0, j);
    if (!prefix.every((ch) => ch === '9')) break;
    const expPow = I - 1 - j + SQUARE_ROOT_DECIMALS;
    if (expPow < 0) break;
    const threshold = top - 5n * 10n ** BigInt(expPow);
    if (B >= threshold && k < j) k = j;
  }
  return Math.min(k, total);
}

export function triangularPoints(k) {
  return (k * (k + 1)) / 2;
}

/**
 * Evaluates one square-root answer with the official tolerance rule.
 * @param {string} expectedDisplay
 * @param {unknown} rawAnswer
 */
export function evaluateSquareRootAnswerOfficial(expectedDisplay, rawAnswer) {
  const expStr = String(expectedDisplay ?? '').trim();
  const I = (expStr.split('.')[0] || '').length || 3;
  const total = I + SQUARE_ROOT_DECIMALS;
  const slots = parseSquareRootSlots(rawAnswer, I);
  const attempted = slots.some((ch) => ch !== '');
  const k = attempted && /^\d+\.\d+$/.test(expStr) ? countSquareRootDigits(expStr, slots) : 0;

  let givenDisplay = null;
  if (attempted) {
    const intFormatted = slots.slice(0, I).map((ch) => ch || '_').join('');
    const decSlots = slots.slice(I);
    if (decSlots.some((ch) => ch !== '')) {
      givenDisplay = `${intFormatted}.${decSlots.map((ch) => ch || '_').join('').replace(/_+$/, '')}`;
    } else {
      givenDisplay = intFormatted.replace(/_+$/, '');
    }
  }

  return {
    attempted,
    correct: k === total,
    correct_digits: k,
    max_digits: total,
    points: triangularPoints(k),
    given_display: givenDisplay,
    slots,
  };
}

/**
 * Official final points: score * T / t, where t = T unless the round was finished early
 * with every task done (`allDone`). Rounded to 2 decimals.
 */
export function computeOfficialPoints(score, timeLimitSeconds, usedSeconds, allDone) {
  const s = Number(score) || 0;
  const T = Number(timeLimitSeconds) || 0;
  const used = Number(usedSeconds);
  if (s <= 0 || T <= 0) return 0;
  const t = allDone && Number.isFinite(used) && used > 0 && used < T ? used : T;
  return Math.round(((s * T) / t) * 100) / 100;
}
