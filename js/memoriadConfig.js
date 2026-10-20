/**
 * Trendz Tracker — Shared Memoriad Competition Time Limits (js/memoriadConfig.js)
 *
 * Mirrors `MEMORIAD_TIME_LIMITS` and `MEMORIAD_EXPIRY_GRACE_SECONDS` from `api/_memoriad.js`.
 * Verified for exact parity in `tests/memoriadServer.test.js`.
 */

export const MEMORIAD_TIME_LIMITS = Object.freeze({
  calendar: 60,
  additions: 600,
  multiplications: 900,
  square_roots: 900,
});

export const MEMORIAD_EXPIRY_GRACE_SECONDS = 30;

/**
 * Returns the round time limit in seconds for `moduleKey`.
 * @param {string} moduleKey
 * @returns {number}
 */
export function getMemoriadTimeLimit(moduleKey) {
  const key = typeof moduleKey === 'string' ? moduleKey.trim().toLowerCase() : '';
  return MEMORIAD_TIME_LIMITS[key] ?? 60;
}
