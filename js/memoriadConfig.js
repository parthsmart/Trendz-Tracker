/**
 * Trendz Tracker — Shared Memoriad Competition Time Limits (js/memoriadConfig.js)
 *
 * Mirrors `MEMORIAD_TIME_LIMITS` and `MEMORIAD_EXPIRY_GRACE_SECONDS` from `api/_memoriad.js`.
 * Verified for exact parity in `tests/memoriadServer.test.js`.
 * Digit-level times (5d x 5d, 10-digit roots, 10d / 5d ...) come from `js/memoriadGenerators.js`.
 */

import { getMemoriadLevelTimeLimit } from './memoriadGenerators.js';

export const MEMORIAD_TIME_LIMITS = Object.freeze({
  calendar: 60,
  additions: 600,
  multiplications: 720,
  square_roots: 900,
  division: 360,
});

export const MEMORIAD_EXPIRY_GRACE_SECONDS = 30;

/**
 * Returns the round time limit in seconds for `moduleKey` (level-aware when `settings` is given).
 * @param {string} moduleKey
 * @param {object} [settings]
 * @returns {number}
 */
export function getMemoriadTimeLimit(moduleKey, settings) {
  const key = typeof moduleKey === 'string' ? moduleKey.trim().toLowerCase() : '';
  if (settings && typeof settings === 'object') {
    const levelLimit = getMemoriadLevelTimeLimit(key, settings);
    if (levelLimit) return levelLimit;
  }
  return MEMORIAD_TIME_LIMITS[key] ?? 60;
}
