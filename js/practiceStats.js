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

export const BASICS_QUESTION_COUNTS = [5, 10, 20];
export const BASICS_DEFAULT_QUESTIONS = 10;
export const BASICS_MIN_DIGITS = 1;
export const BASICS_MAX_DIGITS = 4;
export const BASICS_MIN_ROWS = 2;
export const BASICS_MAX_ROWS = 10;

/**
 * Parses a Basics category name to check if it supports online practice.
 * - Case-insensitive, spaces ignored.
 * - "<N>d<R>r": N in 1..4, R in 2..10.
 * - "<A>dx<B>d": multiplication sign x, X, ×, or *; A, B in 1..4.
 * - "<A>d/<B>d": division sign / or ÷; A, B in 1..4 with valid quotients (A >= B).
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

  const divMatch = cleaned.match(/^(\d+)d(?:\/|\u00f7|\u2215)(\d+)d$/);
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
    accuracy,
    time_seconds: Number.isFinite(rawTime) ? rawTime : null,
  };
}

/**
 * Returns the student's best result for a specific Basics `categoryId` and `questionCount`
 * (ranked by highest accuracy, then shorter time).
 * If `questionCount` is omitted, considers all question counts for that category.
 *
 * @param {Array<object>} rows
 * @param {string} categoryId
 * @param {number} [questionCount]
 * @returns {object|null}
 */
export function bestResult(rows = [], categoryId, questionCount) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidates = rows.filter((row) => {
    if (!isBasicsResultRow(row)) return false;
    if (categoryId !== undefined && categoryId !== null && String(categoryId).trim() !== '') {
      if (String(row.category_id) !== String(categoryId)) return false;
    }
    if (questionCount !== undefined && questionCount !== null) {
      if (Number(row.total) !== Number(questionCount)) return false;
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
 * Filters and returns the student's Basics practice sets completed during the
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
