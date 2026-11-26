/**
 * Trendz Tracker - Oral Rounds pure logic (js/oralRounds.js)
 *
 * Oral Rounds is a listening practice: the browser reads a question aloud
 * ("2 digit times 2 digit", first number, a pause, second number) and the
 * student types the answer.
 *
 * This module holds only pure, testable logic:
 * - the access rule shape stored under `settings.oral_rounds`
 *   ({ allowed, operations, digits }) and helpers that read it
 * - option lists the student page may offer
 * - settings validation, question generation, speech text and answer checking
 * - a small in-memory session score
 *
 * Oral Rounds never writes results anywhere (no activity_results, no
 * leaderboard, no streaks). The score lives only in the open page.
 */

export const ORAL_OPERATIONS = Object.freeze([
  Object.freeze({ key: 'add', label: 'Addition', symbol: '+', spoken: 'plus' }),
  Object.freeze({ key: 'sub', label: 'Subtraction', symbol: '−', spoken: 'minus' }),
  Object.freeze({ key: 'mul', label: 'Multiplication', symbol: '×', spoken: 'times' }),
]);

export const ORAL_OPERATION_KEYS = Object.freeze(ORAL_OPERATIONS.map((o) => o.key));

/** Operand sizes (number of digits) that can be offered. */
export const ORAL_DIGIT_SIZES = Object.freeze([1, 2, 3, 4, 5]);

/** Delay between the first and second number, in seconds. */
export const ORAL_DELAY_LIMITS = Object.freeze({ min: 0, max: 15, step: 0.5, default: 2 });

export const ORAL_ROUNDS_FULL_ACCESS = Object.freeze({
  allowed: true,
  operations: ORAL_OPERATION_KEYS,
  digits: ORAL_DIGIT_SIZES,
});

export function getOralOperation(key) {
  return ORAL_OPERATIONS.find((o) => o.key === key) || null;
}

export function getOperationSymbol(key) {
  return getOralOperation(key)?.symbol || '';
}

/**
 * Normalizes a stored `oral_rounds` rule. A missing rule means full access,
 * matching the other practice sections ("preserve access until staff save a rule").
 * Unknown operations and digit sizes are dropped; order follows the catalog.
 */
export function normalizeOralRoundsRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return { allowed: true, operations: [...ORAL_OPERATION_KEYS], digits: [...ORAL_DIGIT_SIZES] };
  }
  const allowed = rule.allowed !== false;
  const ops = Array.isArray(rule.operations)
    ? ORAL_OPERATION_KEYS.filter((k) => rule.operations.map((x) => String(x).trim().toLowerCase()).includes(k))
    : [...ORAL_OPERATION_KEYS];
  const digits = Array.isArray(rule.digits)
    ? ORAL_DIGIT_SIZES.filter((d) => rule.digits.map(Number).includes(d))
    : [...ORAL_DIGIT_SIZES];
  return { allowed, operations: ops, digits };
}

/** True when the student may open Oral Rounds and has at least one operation and digit size. */
export function isOralRoundsAllowed(rule) {
  const r = normalizeOralRoundsRule(rule);
  return r.allowed && r.operations.length > 0 && r.digits.length > 0;
}

/**
 * Options the student page may offer under a rule.
 * @returns {{ allowed: boolean, operations: Array<object>, digits: number[] }}
 */
export function getOralRoundOptions(rule) {
  const r = normalizeOralRoundsRule(rule);
  if (!isOralRoundsAllowed(r)) return { allowed: false, operations: [], digits: [] };
  return {
    allowed: true,
    operations: r.operations.map((k) => getOralOperation(k)),
    digits: [...r.digits],
  };
}

export function clampOralDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ORAL_DELAY_LIMITS.default;
  const stepped = Math.round(n / ORAL_DELAY_LIMITS.step) * ORAL_DELAY_LIMITS.step;
  return Math.min(ORAL_DELAY_LIMITS.max, Math.max(ORAL_DELAY_LIMITS.min, stepped));
}

/**
 * Default settings for a rule: first allowed operation, smallest allowed digit size.
 */
export function defaultOralSettings(rule) {
  const opts = getOralRoundOptions(rule);
  if (!opts.allowed) return null;
  const d = opts.digits.includes(2) ? 2 : opts.digits[0];
  return { operation: opts.operations[0].key, digitsA: d, digitsB: d, delaySeconds: ORAL_DELAY_LIMITS.default };
}

/**
 * Validates student-chosen settings against the access rule.
 * Subtraction needs the first number to have at least as many digits as the second,
 * so answers are never negative.
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
export function validateOralSettings(input, rule) {
  const opts = getOralRoundOptions(rule);
  if (!opts.allowed) return { ok: false, error: 'Oral Rounds is not available for your practice access.' };
  const operation = String(input?.operation || '').trim().toLowerCase();
  if (!opts.operations.some((o) => o.key === operation)) {
    return { ok: false, error: 'Choose an operation your teacher has allowed.' };
  }
  const digitsA = Number(input?.digitsA);
  const digitsB = Number(input?.digitsB);
  if (!opts.digits.includes(digitsA) || !opts.digits.includes(digitsB)) {
    return { ok: false, error: 'Choose digit sizes your teacher has allowed.' };
  }
  if (operation === 'sub' && digitsA < digitsB) {
    return { ok: false, error: 'For subtraction, the first number needs at least as many digits as the second.' };
  }
  return { ok: true, settings: { operation, digitsA, digitsB, delaySeconds: clampOralDelay(input?.delaySeconds) } };
}

/** Random integer with exactly `digits` digits (1 digit → 1..9, never 0). */
export function randomWithDigits(digits, rng = Math.random) {
  const d = Math.max(1, Math.floor(Number(digits) || 1));
  const min = d === 1 ? 1 : 10 ** (d - 1);
  const max = 10 ** d - 1;
  return min + Math.floor(rng() * (max - min + 1));
}

export function computeOralAnswer(operation, a, b) {
  if (operation === 'add') return a + b;
  if (operation === 'sub') return a - b;
  if (operation === 'mul') return a * b;
  throw new Error(`Unknown operation: ${operation}`);
}

/**
 * Generates one question from validated settings.
 * @param {{ operation: string, digitsA: number, digitsB: number }} settings
 * @param {() => number} [rng]
 * @param {{ a: number, b: number } | null} [previous] avoids repeating the same pair twice in a row
 */
export function generateOralQuestion(settings, rng = Math.random, previous = null) {
  const { operation, digitsA, digitsB } = settings;
  if (!getOralOperation(operation)) throw new Error(`Unknown operation: ${operation}`);
  let a;
  let b;
  for (let i = 0; i < 10; i += 1) {
    a = randomWithDigits(digitsA, rng);
    b = randomWithDigits(digitsB, rng);
    if (operation === 'sub' && a < b) [a, b] = [b, a];
    if (!previous || previous.a !== a || previous.b !== b) break;
  }
  return { operation, digitsA, digitsB, a, b, answer: computeOralAnswer(operation, a, b) };
}

export function digitLabel(digits) {
  return `${digits} digit`;
}

/** Short title, e.g. "2d × 2d". */
export function formatOralSettingsTitle(settings) {
  const op = getOralOperation(settings?.operation);
  if (!op) return '';
  return `${settings.digitsA}d ${op.symbol} ${settings.digitsB}d`;
}

/**
 * The three parts the page speaks: intro, first number, (delay), second number.
 * e.g. { intro: '2 digit times 2 digit', first: '47', second: '83' }
 */
export function buildOralSpeech(question) {
  const op = getOralOperation(question.operation);
  return {
    intro: `${digitLabel(question.digitsA)} ${op.spoken} ${digitLabel(question.digitsB)}`,
    first: String(question.a),
    second: String(question.b),
  };
}

/** Parses a typed answer. Allows spaces and commas; returns null when it is not a whole number. */
export function parseOralAnswer(text) {
  const clean = String(text ?? '').replace(/[\s,]/g, '').replace(/^−/, '-');
  if (!/^-?\d+$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isSafeInteger(n) ? n : null;
}

export function checkOralAnswer(question, text) {
  const given = parseOralAnswer(text);
  return { given, correct: given !== null && given === question.answer, expected: question.answer };
}

export function createOralScore() {
  return { asked: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0 };
}

/** Returns a new score after one answered question. */
export function recordOralAttempt(score, correct) {
  const s = { ...(score || createOralScore()) };
  s.asked += 1;
  if (correct) {
    s.correct += 1;
    s.streak += 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
  } else {
    s.wrong += 1;
    s.streak = 0;
  }
  return s;
}

export function formatOralScore(score) {
  const s = score || createOralScore();
  if (s.asked === 0) return '0 / 0';
  const pct = Math.round((s.correct / s.asked) * 100);
  return `${s.correct} / ${s.asked} (${pct}%)`;
}
