/**
 * Trendz Tracker — Online Basics Practice Pure Statistics & Category Spec Module (js/practiceStats.js)
 *
 * Pure, side-effect-free functions for Phase 9a online Basics practice:
 * - `parseBasicsCategorySpec(name)` & `isBasicsOnlineAvailable(categoryOrName)`:
 *   determines whether a basics category supports online practice (`<N>d<R>r`,
 *   `<A>dx<B>d`, `<A>d/<B>d`).
 * - `bestResult(rows, categoryId, questionCount)`: best result per basics category
 *   and question count (ranked by highest accuracy `correct / total`, then shorter `time_seconds`).
 * - `bestByCategoryAndCount(rows)`: map of best results keyed by `"${category_id}|${total}"`.
 * - `setsThisWeek(rows, referenceDate)`: basics sets completed during the current
 *   Monday–Sunday calendar week in India time (`Asia/Kolkata`).
 */

import { getISTDateString } from './stats.js';

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

/**
 * Parses a Basics category name to check if it supports online practice.
 * - Case-insensitive, spaces ignored.
 * - "<N>d<R>r": N in 1..4, R in 2..10.
 * - "<A>dx<B>d": multiplication sign x, X, ×, or *; A, B in 1..4.
 * - "<A>d/<B>d" or "<A>dby<B>d": division sign /, ÷, or "by"; A, B in 1..4 with valid quotients (A >= B).
 *
 * @param {unknown} rawName
 * @returns {{ type: 'add_sub'|'mul'|'div', digits?: number, rows?: number, digitsA?: number, digitsB?: number } | null}
 */
export function parseBasicsCategorySpec(rawName) {
  if (typeof rawName !== 'string') return null;
  const cleaned = rawName.replace(/\s+/g, '').toLowerCase();
  if (!cleaned) return null;

  const addSubMatch = cleaned.match(/^(\d+)d(\d+)r$/);
  if (addSubMatch) {
    const digits = Number(addSubMatch[1]);
    const rows = Number(addSubMatch[2]);
    if (
      digits >= BASICS_MIN_DIGITS &&
      digits <= BASICS_MAX_DIGITS &&
      rows >= BASICS_MIN_ROWS &&
      rows <= BASICS_MAX_ROWS
    ) {
      return { type: 'add_sub', digits, rows };
    }
    return null;
  }

  const mulMatch = cleaned.match(/^(\d+)d(?:x|\*|\u00d7|\u2715|\u2716)(\d+)d$/);
  if (mulMatch) {
    const digitsA = Number(mulMatch[1]);
    const digitsB = Number(mulMatch[2]);
    if (
      digitsA >= BASICS_MIN_DIGITS &&
      digitsA <= BASICS_MAX_DIGITS &&
      digitsB >= BASICS_MIN_DIGITS &&
      digitsB <= BASICS_MAX_DIGITS
    ) {
      return { type: 'mul', digitsA, digitsB };
    }
    return null;
  }

  const divMatch = cleaned.match(/^(\d+)d(?:\/|\u00f7|\u2215|by)(\d+)d$/);
  if (divMatch) {
    const digitsA = Number(divMatch[1]);
    const digitsB = Number(divMatch[2]);
    if (
      digitsA >= BASICS_MIN_DIGITS &&
      digitsA <= BASICS_MAX_DIGITS &&
      digitsB >= BASICS_MIN_DIGITS &&
      digitsB <= BASICS_MAX_DIGITS &&
      digitsA >= digitsB
    ) {
      return { type: 'div', digitsA, digitsB };
    }
    return null;
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
  const spec = parseBasicsCategorySpec(rawName);
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
 * Returns true if the given category object or name is active and available for online practice.
 *
 * @param {string | { name?: string, active?: boolean, section?: string }} categoryOrName
 * @returns {boolean}
 */
export function isBasicsOnlineAvailable(categoryOrName) {
  if (!categoryOrName) return false;
  if (typeof categoryOrName === 'object') {
    if (categoryOrName.active === false) return false;
    if (categoryOrName.section && categoryOrName.section !== 'basics') return false;
    return parseBasicsCategorySpec(categoryOrName.name) !== null;
  }
  return parseBasicsCategorySpec(categoryOrName) !== null;
}

/**
 * Checks whether a `results` row represents a valid Basics drill entry
 * (`student_round_id` is null/empty and `total > 0`).
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isBasicsResultRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.student_round_id !== null && row.student_round_id !== undefined && row.student_round_id !== '') {
    return false;
  }
  const total = Number(row.total);
  const correct = Number(row.correct);
  return Number.isFinite(total) && total > 0 && Number.isFinite(correct) && correct >= 0;
}

/**
 * Compares two Basics practice rows:
 * 1. Higher accuracy (`correct / total`) is better.
 * 2. Shorter `time_seconds` is better (a finite positive time beats missing/null time).
 *
 * Returns a negative number if `a` is better than `b`, positive if `b` is better than `a`,
 * and `0` on an exact tie.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function comparePracticeResults(a, b) {
  const totalA = Number(a?.total) || 0;
  const totalB = Number(b?.total) || 0;
  const correctA = Number(a?.correct) || 0;
  const correctB = Number(b?.correct) || 0;

  const accA = totalA > 0 ? correctA / totalA : 0;
  const accB = totalB > 0 ? correctB / totalB : 0;

  if (Math.abs(accA - accB) > 1e-9) {
    return accB - accA; // Higher accuracy wins
  }

  const rawTimeA =
    a?.time_seconds !== null && a?.time_seconds !== undefined && a?.time_seconds !== ''
      ? Number(a.time_seconds)
      : Number(a?.seconds ?? Infinity);
  const rawTimeB =
    b?.time_seconds !== null && b?.time_seconds !== undefined && b?.time_seconds !== ''
      ? Number(b.time_seconds)
      : Number(b?.seconds ?? Infinity);

  const safeTimeA = Number.isFinite(rawTimeA) && rawTimeA > 0 ? rawTimeA : Infinity;
  const safeTimeB = Number.isFinite(rawTimeB) && rawTimeB > 0 ? rawTimeB : Infinity;

  if (safeTimeA !== safeTimeB) {
    return safeTimeA - safeTimeB; // Shorter time wins
  }

  return 0;
}

/**
 * Normalizes a winning row with computed `accuracy` (rounded to 1 decimal place)
 * and numeric `correct`, `total`, `time_seconds`.
 *
 * @param {object} row
 */
function formatBestRow(row) {
  const correct = Number(row.correct) || 0;
  const total = Number(row.total) || 0;
  const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
  const rawTime =
    row.time_seconds !== null && row.time_seconds !== undefined && row.time_seconds !== ''
      ? Number(row.time_seconds)
      : row.seconds !== null && row.seconds !== undefined
        ? Number(row.seconds)
        : null;

  return {
    ...row,
    correct,
    total,
    attempted: total,
    accuracy,
    time_seconds: Number.isFinite(rawTime) ? rawTime : null,
    ...computePerMinuteRates(correct, total, Number.isFinite(rawTime) ? rawTime : 0),
  };
}

/**
 * Phase 10g — Selectable time modes for online Basics practice.
 */
export const BASICS_TIME_MODES = [
  { key: '30', mode: 'timed', seconds: 30, pool: 50, label: '30 seconds' },
  { key: '60', mode: 'timed', seconds: 60, pool: 100, label: '1 minute' },
  { key: '120', mode: 'timed', seconds: 120, pool: 200, label: '2 minutes' },
  { key: '300', mode: 'timed', seconds: 300, pool: 500, label: '5 minutes' },
  {
    key: 'unlimited',
    mode: 'unlimited',
    seconds: null,
    pool: 1000,
    label: 'Unlimited (stopwatch)',
  },
];

/**
 * Computes accuracy, correct_per_minute, and attempted_per_minute (rounded to 1 decimal place).
 *
 * @param {number} correct
 * @param {number} attempted
 * @param {number} timeSeconds
 * @returns {{
 *   correct: number,
 *   attempted: number,
 *   accuracy: number,
 *   used_seconds: number,
 *   correct_per_minute: number,
 *   attempted_per_minute: number
 * }}
 */
export function computePerMinuteRates(correct, attempted, timeSeconds) {
  const c = Math.max(0, Number(correct) || 0);
  const a = Math.max(0, Number(attempted) || 0);
  const sec = Math.max(0, Number(timeSeconds) || 0);
  const accuracy = a > 0 ? Math.round((c / a) * 1000) / 10 : 0;
  const minutes = sec / 60;
  const correctPerMinute = minutes > 0 ? Math.round((c / minutes) * 10) / 10 : 0;
  const attemptedPerMinute = minutes > 0 ? Math.round((a / minutes) * 10) / 10 : 0;

  return {
    correct: c,
    attempted: a,
    accuracy,
    used_seconds: sec,
    correct_per_minute: correctPerMinute,
    attempted_per_minute: attemptedPerMinute,
  };
}

/**
 * Formats a student's Basics target into human-readable text for the Setup screen:
 * e.g. "Target: at least 90% accuracy and 40 questions per minute"
 * or only the parts that exist.
 *
 * @param {{ min_accuracy?: number|null, min_questions_per_minute?: number|null } | null | undefined} target
 * @returns {string}
 */
export function formatBasicsTargetText(target) {
  if (!target || typeof target !== 'object') return '';
  const parts = [];
  if (
    target.min_accuracy !== null &&
    target.min_accuracy !== undefined &&
    Number.isFinite(Number(target.min_accuracy))
  ) {
    parts.push(`${Number(target.min_accuracy)}% accuracy`);
  }
  if (
    target.min_questions_per_minute !== null &&
    target.min_questions_per_minute !== undefined &&
    Number.isFinite(Number(target.min_questions_per_minute)) &&
    Number(target.min_questions_per_minute) > 0
  ) {
    parts.push(`${Number(target.min_questions_per_minute)} questions per minute`);
  }
  if (parts.length === 0) return '';
  return `Target: at least ${parts.join(' and ')}`;
}

/**
 * Compares two Basics practice rows for a specific `mode` ('timed' or 'unlimited'):
 * - 'timed':
 *   1. Most `correct` answers wins.
 *   2. Tie-breaker: higher accuracy (`correct / total`) wins.
 *   3. Tie-breaker: more attempted (`total`) wins.
 * - 'unlimited':
 *   1. Highest `correct_per_minute` (`correct / (time_seconds / 60)`) wins.
 *   2. Tie-breaker: higher accuracy (`correct / total`) wins.
 *   3. Tie-breaker: more `correct` answers wins.
 *
 * Returns a negative number if `a` is better than `b`, positive if `b` is better than `a`,
 * and `0` on an exact tie.
 *
 * @param {object} a
 * @param {object} b
 * @param {'timed'|'unlimited'} mode
 * @returns {number}
 */
export function compareModeResults(a, b, mode = 'timed') {
  const totalA = Number(a?.total ?? a?.attempted) || 0;
  const totalB = Number(b?.total ?? b?.attempted) || 0;
  const correctA = Number(a?.correct) || 0;
  const correctB = Number(b?.correct) || 0;
  const accA = totalA > 0 ? correctA / totalA : 0;
  const accB = totalB > 0 ? correctB / totalB : 0;

  if (mode === 'unlimited') {
    const timeA = Number(a?.time_seconds ?? a?.used_seconds ?? a?.seconds) || 0;
    const timeB = Number(b?.time_seconds ?? b?.used_seconds ?? b?.seconds) || 0;
    const cpmA = timeA > 0 ? correctA / (timeA / 60) : 0;
    const cpmB = timeB > 0 ? correctB / (timeB / 60) : 0;

    if (Math.abs(cpmA - cpmB) > 1e-9) {
      return cpmB - cpmA; // Higher correct per minute wins
    }
    if (Math.abs(accA - accB) > 1e-9) {
      return accB - accA; // Higher accuracy wins
    }
    if (correctA !== correctB) {
      return correctB - correctA; // More correct answers wins
    }
    return 0;
  }

  // Default: 'timed'
  if (correctA !== correctB) {
    return correctB - correctA; // Most correct answers wins
  }
  if (Math.abs(accA - accB) > 1e-9) {
    return accB - accA; // Higher accuracy wins
  }
  if (totalA !== totalB) {
    return totalB - totalA; // More attempted wins
  }
  return 0;
}

/**
 * Returns the student's personal best result for a specific `categoryId` and `mode`
 * ('timed' or 'unlimited').
 *
 * @param {Array<object>} rows
 * @param {string} categoryId
 * @param {'timed'|'unlimited'} mode
 * @returns {object|null}
 */
export function bestForMode(rows = [], categoryId, mode = 'timed') {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const normalizedMode = String(mode || '').trim().toLowerCase();
  if (normalizedMode !== 'timed' && normalizedMode !== 'unlimited') return null;

  const candidates = rows.filter((row) => {
    if (!isBasicsResultRow(row)) return false;
    if (categoryId !== undefined && categoryId !== null && String(categoryId).trim() !== '') {
      if (String(row.category_id) !== String(categoryId)) return false;
    }
    const rowMode = String(row.practice_mode || row.mode || '').trim().toLowerCase();
    return rowMode === normalizedMode;
  });

  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (compareModeResults(candidates[i], best, normalizedMode) < 0) {
      best = candidates[i];
    }
  }

  return formatBestRow(best);
}

/**
 * Returns a dictionary of personal best results keyed by `"${category_id}|${practice_mode}"`
 * across all timed/unlimited Basics rows in `rows`.
 *
 * @param {Array<object>} rows
 * @returns {Record<string, object>}
 */
export function bestByCategoryAndMode(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const out = {};
  for (const row of rows) {
    if (!isBasicsResultRow(row) || !row.category_id) continue;
    const rowMode = String(row.practice_mode || row.mode || '').trim().toLowerCase();
    if (rowMode !== 'timed' && rowMode !== 'unlimited') continue;
    const key = `${row.category_id}|${rowMode}`;
    if (!out[key] || compareModeResults(row, out[key], rowMode) < 0) {
      out[key] = formatBestRow(row);
    }
  }
  return out;
}

/**
 * Returns the student's best result for a specific Basics `categoryId` and either:
 * - a `mode` ('timed' | 'unlimited'), delegating to `bestForMode`, or
 * - a legacy `questionCount` number.
 *
 * @param {Array<object>} rows
 * @param {string} categoryId
 * @param {number|'timed'|'unlimited'} [modeOrQuestionCount]
 * @returns {object|null}
 */
export function bestResult(rows = [], categoryId, modeOrQuestionCount) {
  if (modeOrQuestionCount === 'timed' || modeOrQuestionCount === 'unlimited') {
    return bestForMode(rows, categoryId, modeOrQuestionCount);
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidates = rows.filter((row) => {
    if (!isBasicsResultRow(row)) return false;
    if (categoryId !== undefined && categoryId !== null && String(categoryId).trim() !== '') {
      if (String(row.category_id) !== String(categoryId)) return false;
    }
    if (modeOrQuestionCount !== undefined && modeOrQuestionCount !== null) {
      if (Number(row.total) !== Number(modeOrQuestionCount)) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (comparePracticeResults(candidates[i], best) < 0) {
      best = candidates[i];
    }
  }

  return formatBestRow(best);
}

export const bestResultForCategory = bestResult;

/**
 * Returns a dictionary of best results keyed by `"${category_id}|${total}"` across all
 * Basics rows in `rows`.
 *
 * @param {Array<object>} rows
 * @returns {Record<string, object>}
 */
export function bestByCategoryAndCount(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return {};

  const out = {};
  for (const row of rows) {
    if (!isBasicsResultRow(row) || !row.category_id) continue;
    const key = `${row.category_id}|${Number(row.total)}`;
    if (!out[key] || comparePracticeResults(row, out[key]) < 0) {
      out[key] = formatBestRow(row);
    }
  }
  return out;
}

/**
 * Computes the Monday..Sunday date bounds (`YYYY-MM-DD`) in Indian Standard Time
 * (`Asia/Kolkata`) for the week containing `referenceDate`.
 *
 * @param {string|Date} [referenceDate]
 * @returns {{ mondayIST: string, sundayIST: string, todayIST: string }}
 */
export function getISTWeekBounds(referenceDate = new Date()) {
  let todayIST = getISTDateString(referenceDate);
  if (!todayIST || !/^\d{4}-\d{2}-\d{2}$/.test(todayIST)) {
    todayIST = getISTDateString(new Date());
  }

  const [y, m, d] = todayIST.split('-').map(Number);
  const todayUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dayFromMonday = (todayUtc.getUTCDay() + 6) % 7;
  const mondayUtc = new Date(todayUtc.getTime() - dayFromMonday * 86400000);
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
    todayIST,
  };
}

/**
 * Filters and returns the student's Basics practice tries completed during the
 * current Monday–Sunday week in India time (`Asia/Kolkata`), sorted newest first.
 *
 * @param {Array<object>} rows
 * @param {string|Date} [referenceDate]
 * @returns {Array<object>}
 */
export function setsThisWeek(rows = [], referenceDate = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const { mondayIST, sundayIST } = getISTWeekBounds(referenceDate);
  const valid = rows.filter((r) => isBasicsResultRow(r));

  const matching = valid.filter((row) => {
    const rawDate = row.entry_date || row.created_at;
    if (!rawDate) return false;
    const istDate = getISTDateString(rawDate);
    return istDate >= mondayIST && istDate <= sundayIST;
  });

  return matching.sort((a, b) => {
    const tA = new Date(a.created_at || a.entry_date || 0).getTime();
    const tB = new Date(b.created_at || b.entry_date || 0).getTime();
    return tB - tA;
  });
}

export const triesThisWeek = setsThisWeek;
