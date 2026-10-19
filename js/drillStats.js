/**
 * Trendz Tracker — Elements Drill Pure Statistics Module (js/drillStats.js)
 *
 * Pure, side-effect-free functions for computing student Elements drill
 * statistics from `activity_results` rows (where `activity_type === 'element'`):
 * - `bestForDrill(rows, drillKey)`: highest `correct`, then fewer wrong answers
 *   (`total - correct`), then shorter `time_seconds`.
 * - `recentSets(rows, limit)`: newest sets first by `created_at`.
 * - `setsThisWeek(rows, referenceDate)`: sets completed during the current
 *   Monday–Sunday calendar week in Indian Standard Time (`Asia/Kolkata`).
 * - `summaryByDrill(rows)`: per-drill summary (`count`, `best`, `last`) across
 *   all 18 catalog drills.
 */

import { DRILL_CATALOG, DRILL_CATALOG_LIST } from './drillCatalog.js';
import { getISTDateString } from './stats.js';

/**
 * Extracts the canonical drill key from an `activity_results` row if possible.
 * Matches `row.settings.drill`, `row.drill`, or maps `row.activity_name` back
 * to the catalog key.
 *
 * @param {object} row
 * @returns {string|null}
 */
export function resolveRowDrillKey(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.settings && typeof row.settings === 'object' && row.settings.drill) {
    return String(row.settings.drill).trim();
  }
  if (row.drill) {
    return String(row.drill).trim();
  }
  if (row.activity_name) {
    const name = String(row.activity_name).trim().toLowerCase();
    if (DRILL_CATALOG[name]) return name;
    const found = DRILL_CATALOG_LIST.find((d) => d.title.toLowerCase() === name);
    if (found) return found.key;
  }
  return null;
}

/**
 * Checks if an `activity_results` row is a valid Elements drill record
 * (and optionally matches a specific `drillKey`).
 *
 * @param {object} row
 * @param {string} [drillKey]
 * @returns {boolean}
 */
export function isElementDrillRow(row, drillKey) {
  if (!row || typeof row !== 'object') return false;
  if (row.activity_type && row.activity_type !== 'element') return false;

  const total = Number(row.total ?? row.attempted ?? 0);
  const correct = Number(row.correct ?? 0);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(correct) || correct < 0) {
    return false;
  }

  if (drillKey) {
    const target = String(drillKey).trim();
    const rowKey = resolveRowDrillKey(row);
    const catalogTitle = DRILL_CATALOG[target]?.title;
    if (rowKey === target) return true;
    if (
      catalogTitle &&
      typeof row.activity_name === 'string' &&
      row.activity_name.trim().toLowerCase() === catalogTitle.toLowerCase()
    ) {
      return true;
    }
    if (
      typeof row.activity_name === 'string' &&
      row.activity_name.trim().toLowerCase() === target.toLowerCase()
    ) {
      return true;
    }
    return false;
  }

  return true;
}

/**
 * Compares two drill result rows according to the Elements ranking rules:
 * 1. Higher `correct` is better.
 * 2. Fewer `wrong` answers (`total - correct`) is better.
 * 3. Shorter `time_seconds` is better.
 *
 * Returns a negative number if `a` is better than `b`, positive if `b` is better
 * than `a`, and `0` if they are tied on all three criteria.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareDrillResults(a, b) {
  const correctA = Number(a?.correct) || 0;
  const correctB = Number(b?.correct) || 0;
  if (correctA !== correctB) {
    return correctB - correctA; // Higher correct wins
  }

  const totalA = Number(a?.total ?? a?.attempted) || 0;
  const totalB = Number(b?.total ?? b?.attempted) || 0;
  const wrongA = Math.max(0, totalA - correctA);
  const wrongB = Math.max(0, totalB - correctB);
  if (wrongA !== wrongB) {
    return wrongA - wrongB; // Fewer wrong answers wins
  }

  const timeA =
    a?.time_seconds !== null && a?.time_seconds !== undefined && a?.time_seconds !== ''
      ? Number(a.time_seconds)
      : Number(a?.seconds ?? Infinity);
  const timeB =
    b?.time_seconds !== null && b?.time_seconds !== undefined && b?.time_seconds !== ''
      ? Number(b.time_seconds)
      : Number(b?.seconds ?? Infinity);

  const safeTimeA = Number.isFinite(timeA) && timeA >= 0 ? timeA : Infinity;
  const safeTimeB = Number.isFinite(timeB) && timeB >= 0 ? timeB : Infinity;

  if (safeTimeA !== safeTimeB) {
    return safeTimeA - safeTimeB; // Shorter time wins
  }

  return 0;
}

/**
 * Returns the student's best result for a specific drill (or across all provided
 * element rows if `drillKey` is omitted).
 *
 * Ranking:
 * 1. Highest `correct`
 * 2. Fewest wrong answers (`total - correct`)
 * 3. Shortest `time_seconds`
 * On an exact 3-way tie, preserves the first matching row encountered.
 *
 * @param {Array<object>} rows
 * @param {string} [drillKey]
 * @returns {object|null}
 */
export function bestForDrill(rows = [], drillKey) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const candidates = rows.filter((r) => isElementDrillRow(r, drillKey));
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (compareDrillResults(candidate, best) < 0) {
      best = candidate;
    }
  }

  const correct = Number(best.correct) || 0;
  const total = Number(best.total ?? best.attempted) || 0;
  const wrong = Math.max(0, total - correct);
  const timeSeconds =
    best.time_seconds !== null && best.time_seconds !== undefined
      ? Number(best.time_seconds)
      : Number(best.seconds ?? 0);

  return {
    ...best,
    correct,
    total,
    wrong,
    time_seconds: timeSeconds,
  };
}

/**
 * Checks whether a newly completed result is a personal best compared with
 * the student's prior best result for that drill (excluding the new row itself).
 *
 * @param {object} newResult - `{ correct, attempted/total, seconds/time_seconds }`
 * @param {object|null} previousBest - Output of `bestForDrill` prior to this set
 * @returns {boolean}
 */
export function isNewPersonalBest(newResult, previousBest) {
  if (!newResult) return false;
  const correct = Number(newResult.correct) || 0;
  const total = Number(newResult.total ?? newResult.attempted) || 0;
  if (total <= 0 || correct <= 0) return false;

  if (!previousBest) return true;
  return compareDrillResults(newResult, previousBest) < 0;
}

/**
 * Returns the most recent Elements drill sets sorted newest first (`created_at` DESC).
 *
 * @param {Array<object>} rows
 * @param {number} [limit=10]
 * @returns {Array<object>}
 */
export function recentSets(rows = [], limit = 10) {
  if (!Array.isArray(rows) || rows.length === 0 || limit <= 0) return [];

  const valid = rows.filter((r) => isElementDrillRow(r));
  const indexed = valid.map((item, idx) => ({ item, idx }));

  indexed.sort((a, b) => {
    const tA = a.item.created_at ? new Date(a.item.created_at).getTime() : NaN;
    const tB = b.item.created_at ? new Date(b.item.created_at).getTime() : NaN;
    const validA = Number.isFinite(tA);
    const validB = Number.isFinite(tB);

    if (validA && validB && tA !== tB) {
      return tB - tA; // Newest first
    }
    if (validA && !validB) return -1;
    if (!validA && validB) return 1;
    return a.idx - b.idx; // Stable tie-breaker
  });

  return indexed.slice(0, limit).map((x) => x.item);
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
  // Monday = 0 .. Sunday = 6
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
 * Filters and returns the student's Elements drill sets completed during the
 * current Monday–Sunday week in India time (`Asia/Kolkata`), sorted newest first.
 *
 * @param {Array<object>} rows
 * @param {string|Date} [referenceDate]
 * @returns {Array<object>}
 */
export function setsThisWeek(rows = [], referenceDate = new Date()) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const { mondayIST, sundayIST } = getISTWeekBounds(referenceDate);
  const sorted = recentSets(rows, rows.length);

  return sorted.filter((row) => {
    const rawDate = row.created_at || row.entry_date;
    if (!rawDate) return false;
    const istDate = getISTDateString(rawDate);
    return istDate >= mondayIST && istDate <= sundayIST;
  });
}

/**
 * Aggregates a dictionary keyed by drill key across all 18 catalog drills
 * (plus any additional drill keys present in `rows`), providing:
 * - `drill`: drill key
 * - `title`: drill title
 * - `count`: number of completed sets for this drill
 * - `best`: output of `bestForDrill(rows, key)` (or `null`)
 * - `last`: most recent set for this drill (or `null`)
 *
 * @param {Array<object>} rows
 * @returns {Record<string, { drill: string, title: string, count: number, best: object|null, last: object|null }>}
 */
export function summaryByDrill(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const result = {};

  for (const meta of DRILL_CATALOG_LIST) {
    const drillRows = safeRows.filter((r) => isElementDrillRow(r, meta.key));
    const sorted = recentSets(drillRows, drillRows.length);
    result[meta.key] = {
      drill: meta.key,
      title: meta.title,
      count: drillRows.length,
      best: bestForDrill(drillRows),
      last: sorted[0] || null,
    };
  }

  return result;
}
