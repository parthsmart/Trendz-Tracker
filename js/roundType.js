/**
 * Trendz Tracker — Pure Round Type Helper (js/roundType.js)
 *
 * Determines whether a round type string represents a Flat Round
 * (where only total round time is recorded and per-category times are hidden).
 */

/**
 * Returns `true` when the trimmed, lower-cased `roundType` starts with `"flat"`
 * (so `"Flat Round"`, `"Flat round"`, and `"flat"` all match),
 * and `false` for `"Category wise"`, empty strings, or unknown values.
 *
 * @param {unknown} roundType
 * @returns {boolean}
 */
export function isFlatRound(roundType) {
  if (typeof roundType !== 'string') return false;
  return roundType.trim().toLowerCase().startsWith('flat');
}
