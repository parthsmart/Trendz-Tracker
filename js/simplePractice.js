/**
 * Trendz Tracker — Simple practice (js/simplePractice.js)
 *
 * The Simple page (Practice > Simple) has three groups of activities:
 * - Simple sums: 1D 4R, 2D 2R and 3D 2R questions that can be worked on the
 *   abacus without any formula (same rules as the Flash Anzan "Simple" mode,
 *   see js/flashSimple.js).
 * - Tables dodging: the table of 2 to 9, asked with random multipliers
 *   (2 × 3, then 2 × 7, ...).
 * - Advanced: mixed tables, 2 to 5 and 2 to 9.
 *
 * Every activity can be practised online (questions on screen, checked straight
 * away) or logged offline (the student types the score from paper).
 *
 * Practice access key (student access editor):
 *   settings.simple_practice = { allowed: true|false, activities: [keys] }
 * A missing key means full access, like the other access keys.
 *
 * The database function public.simple_practice_log uses the same activity keys
 * and limits (supabase/staging_simple_practice.sql).
 */

import { generateSimpleQuestion } from './flashSimple.js';

export const SIMPLE_GROUPS = Object.freeze([
  Object.freeze({ key: 'sums', label: 'Simple sums', hint: 'No formula needed on the abacus.' }),
  Object.freeze({ key: 'tables', label: 'Tables dodging', hint: 'One table, random order.' }),
  Object.freeze({ key: 'advanced', label: 'Advanced', hint: 'Mixed tables, random order.' }),
]);

function sum(key, label, digits, rows) {
  return Object.freeze({ key, label, group: 'sums', kind: 'sum', digits, rows });
}
function table(n) {
  return Object.freeze({ key: `table_${n}`, label: `Table of ${n}`, group: 'tables', kind: 'table', from: n, to: n });
}
function mix(from, to) {
  return Object.freeze({
    key: `mix_${from}_${to}`,
    label: `${from}–${to} mix dodging`,
    group: 'advanced',
    kind: 'table',
    from,
    to,
  });
}

export const SIMPLE_ACTIVITIES = Object.freeze([
  sum('simple_1d4r', '1D 4R', 1, 4),
  sum('simple_2d2r', '2D 2R', 2, 2),
  sum('simple_3d2r', '3D 2R', 3, 2),
  ...[2, 3, 4, 5, 6, 7, 8, 9].map(table),
  mix(2, 5),
  mix(2, 9),
]);

export const SIMPLE_ACTIVITY_KEYS = Object.freeze(SIMPLE_ACTIVITIES.map((a) => a.key));

/** Multipliers asked in tables dodging: n × 1 up to n × 10. */
export const TABLE_MULTIPLIER_MIN = 1;
export const TABLE_MULTIPLIER_MAX = 10;

/**
 * Online round lengths, the same choices as Basics practice. A round asks
 * questions without limit until the time runs out; 'unlimited' is a stopwatch
 * that runs until the student presses Finish (or the 4-hour limit).
 */
export const SIMPLE_TIME_MODES = Object.freeze([
  Object.freeze({ key: '30', seconds: 30, label: '30 seconds' }),
  Object.freeze({ key: '60', seconds: 60, label: '1 minute' }),
  Object.freeze({ key: '120', seconds: 120, label: '2 minutes' }),
  Object.freeze({ key: '300', seconds: 300, label: '5 minutes' }),
  Object.freeze({ key: 'unlimited', seconds: null, label: 'Unlimited (stopwatch)' }),
]);
export const SIMPLE_DEFAULT_TIME_KEY = '60';

/** Limits shared with public.simple_practice_log. */
export const SIMPLE_LIMITS = Object.freeze({
  maxTotal: 1000,
  maxSeconds: 14400,
  backdateDays: 7,
});

export const SIMPLE_SOURCES = Object.freeze(['online', 'offline']);

export function getSimpleActivity(key) {
  const k = String(key || '').trim().toLowerCase();
  return SIMPLE_ACTIVITIES.find((a) => a.key === k) || null;
}

export function simpleActivityLabel(key) {
  const a = getSimpleActivity(key);
  if (!a) return String(key || '');
  if (a.group === 'sums') return `Simple ${a.label}`;
  return a.label;
}

/* ------------------------------------------------------------ access rule */

export function normalizeSimplePracticeRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return { allowed: true, activities: [...SIMPLE_ACTIVITY_KEYS] };
  }
  const allowed = rule.allowed !== false;
  const list = Array.isArray(rule.activities)
    ? rule.activities.map((x) => String(x).trim().toLowerCase())
    : null;
  const activities = list ? SIMPLE_ACTIVITY_KEYS.filter((k) => list.includes(k)) : [...SIMPLE_ACTIVITY_KEYS];
  return { allowed, activities };
}

/** True when the student may open the Simple page and has at least one activity. */
export function isSimplePracticeAllowed(rule) {
  const r = normalizeSimplePracticeRule(rule);
  return r.allowed && r.activities.length > 0;
}

export function isSimpleActivityAllowed(key, rule) {
  const r = normalizeSimplePracticeRule(rule);
  return r.allowed && r.activities.includes(String(key || '').trim().toLowerCase());
}

/** Activities the student may use, in catalog order. */
export function allowedSimpleActivities(rule) {
  const r = normalizeSimplePracticeRule(rule);
  if (!r.allowed) return [];
  return SIMPLE_ACTIVITIES.filter((a) => r.activities.includes(a.key));
}

/* -------------------------------------------------------------- questions */

/**
 * Builds one question for an activity.
 * Sums: `{ kind: 'sum', numbers: [3, -1, 5, ...], answer }`.
 * Tables: `{ kind: 'table', a: 7, b: 4, answer: 28 }`.
 * @param {string|object} activityOrKey
 * @param {{ random?: () => number, previous?: object|null }} [options]
 */
export function generateSimplePracticeQuestion(activityOrKey, { random = Math.random, previous = null } = {}) {
  const activity = typeof activityOrKey === 'object' && activityOrKey ? activityOrKey : getSimpleActivity(activityOrKey);
  if (!activity) throw new Error(`Unknown Simple activity: ${activityOrKey}`);

  if (activity.kind === 'sum') {
    let numbers = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      numbers = generateSimpleQuestion(activity.digits, activity.rows, { random });
      if (!previous || previous.kind !== 'sum' || previous.numbers.join(',') !== numbers.join(',')) break;
    }
    return { kind: 'sum', numbers, answer: numbers.reduce((acc, n) => acc + n, 0) };
  }

  const span = TABLE_MULTIPLIER_MAX - TABLE_MULTIPLIER_MIN + 1;
  let a = activity.from;
  let b = TABLE_MULTIPLIER_MIN;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    a = activity.from + Math.floor(random() * (activity.to - activity.from + 1));
    b = TABLE_MULTIPLIER_MIN + Math.floor(random() * span);
    // dodge: never the same question twice in a row
    if (!previous || previous.kind !== 'table' || previous.a !== a || previous.b !== b) break;
  }
  return { kind: 'table', a, b, answer: a * b };
}

/** Text of a question for review lists, e.g. "7 × 4" or "3 − 1 + 5 + 2". */
export function formatSimpleQuestion(q) {
  if (!q) return '';
  if (q.kind === 'table') return `${q.a} × ${q.b}`;
  return q.numbers
    .map((n, i) => (i === 0 ? String(n) : `${n < 0 ? '−' : '+'} ${Math.abs(n)}`))
    .join(' ');
}

/** Parses a typed answer; returns an integer or null. */
export function parseSimpleAnswer(raw) {
  const s = String(raw ?? '').trim().replace(/[\s,]/g, '').replace(/^−/, '-');
  if (!/^-?\d{1,9}$/.test(s)) return null;
  return Number(s);
}

export function checkSimpleAnswer(q, raw) {
  const value = parseSimpleAnswer(raw);
  return value !== null && q && value === q.answer;
}

/* --------------------------------------------------------- score entries */

/** The time mode for a key; unknown keys fall back to 1 minute. */
export function getSimpleTimeMode(key) {
  return (
    SIMPLE_TIME_MODES.find((m) => m.key === String(key)) ||
    SIMPLE_TIME_MODES.find((m) => m.key === SIMPLE_DEFAULT_TIME_KEY)
  );
}

/**
 * Marks the answers of an online round at the end (nothing is checked while
 * the round runs). Each attempt is { question, given } where given is the raw
 * text, or null when the question was skipped.
 */
export function markSimpleRound(attempts) {
  let correct = 0;
  const wrong = [];
  for (const a of attempts || []) {
    if (a.given !== null && a.given !== undefined && checkSimpleAnswer(a.question, a.given)) {
      correct += 1;
    } else {
      wrong.push({
        question: a.question,
        given: a.given === null || a.given === undefined ? 'skipped' : String(a.given).trim(),
      });
    }
  }
  return { correct, total: (attempts || []).length, wrong };
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Validates a score before it is saved (online result or offline log).
 * @param {{ activity_key, source, correct, total, time_seconds?, practiced_on? }} input
 * @param {{ todayIST?: string, rule?: object }} [options]
 * @returns {{ value?: object, errors?: string[] }}
 */
export function validateSimpleEntry(input, { todayIST = null, rule = null } = {}) {
  const errors = [];
  const activity = getSimpleActivity(input?.activity_key);
  if (!activity) errors.push('Choose what you practised.');
  else if (rule && !isSimpleActivityAllowed(activity.key, rule)) errors.push('This activity is not turned on for you.');

  const source = SIMPLE_SOURCES.includes(input?.source) ? input.source : null;
  if (!source) errors.push('Unknown entry type.');

  const total = Number(input?.total);
  const correct = Number(input?.correct);
  if (!Number.isInteger(total) || total < 1 || total > SIMPLE_LIMITS.maxTotal) {
    errors.push(`Questions must be a whole number from 1 to ${SIMPLE_LIMITS.maxTotal}.`);
  }
  if (!Number.isInteger(correct) || correct < 0) {
    errors.push('Correct must be a whole number, 0 or more.');
  } else if (Number.isInteger(total) && correct > total) {
    errors.push('Correct cannot be more than the number of questions.');
  }

  let time = null;
  if (input?.time_seconds !== null && input?.time_seconds !== undefined && input?.time_seconds !== '') {
    time = Number(input.time_seconds);
    if (!Number.isInteger(time) || time < 0 || time > SIMPLE_LIMITS.maxSeconds) {
      errors.push('Time must be between 0 seconds and 4 hours.');
    }
  }

  let practicedOn = input?.practiced_on ? String(input.practiced_on) : todayIST;
  if (practicedOn && !/^\d{4}-\d{2}-\d{2}$/.test(practicedOn)) {
    errors.push('Choose a valid date.');
  } else if (practicedOn && todayIST) {
    if (practicedOn > todayIST) errors.push('The date cannot be in the future.');
    else if (practicedOn < addDays(todayIST, -SIMPLE_LIMITS.backdateDays)) {
      errors.push(`You can log practice from the last ${SIMPLE_LIMITS.backdateDays} days only.`);
    }
  }

  if (errors.length) return { errors };
  return {
    value: {
      activity_key: activity.key,
      source,
      correct,
      total,
      time_seconds: time,
      practiced_on: practicedOn || null,
    },
  };
}

/**
 * Best entry per activity: highest accuracy, then more questions, then less time.
 * @returns {Map<string, object>}
 */
export function bestSimpleByActivity(rows) {
  const best = new Map();
  for (const row of rows || []) {
    if (!row || !(Number(row.total) > 0)) continue;
    const cur = best.get(row.activity_key);
    if (!cur || compareSimpleEntries(row, cur) < 0) best.set(row.activity_key, row);
  }
  return best;
}

/** Negative when `a` is better than `b`. */
export function compareSimpleEntries(a, b) {
  const accA = Number(a.correct) / Number(a.total);
  const accB = Number(b.correct) / Number(b.total);
  if (accA !== accB) return accB - accA;
  if (Number(a.total) !== Number(b.total)) return Number(b.total) - Number(a.total);
  const tA = a.time_seconds === null || a.time_seconds === undefined ? Infinity : Number(a.time_seconds);
  const tB = b.time_seconds === null || b.time_seconds === undefined ? Infinity : Number(b.time_seconds);
  return tA - tB;
}
