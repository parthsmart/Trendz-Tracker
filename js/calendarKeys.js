/**
 * Trendz Tracker — Pure Calendar Keyboard Mapping (js/calendarKeys.js)
 *
 * Maps keys `'0'` through `'7'` to canonical weekday indices (`0 = Monday .. 6 = Sunday`)
 * based on the student's chosen `keyZeroDayIndex` (default `5 = Saturday`).
 *
 * Mapping formula:
 * - Key `0` -> `keyZeroDayIndex`
 * - Key `k` (`0..7`) -> `(keyZeroDayIndex + k) % 7`
 * - Key `7` always resolves to the same weekday as Key `0` (`(keyZeroDayIndex + 7) % 7 === keyZeroDayIndex`).
 * - Any other key returns `null`.
 */

export const DEFAULT_KEY_ZERO_DAY = 5; // Saturday (0 = Monday .. 5 = Saturday, 6 = Sunday)

/**
 * Returns the canonical weekday index (`0 = Monday .. 6 = Sunday`) for key `'0'..'7'`,
 * or `null` if `keyInput` is not a digit in `0..7`.
 *
 * @param {string | number | null | undefined} keyInput
 * @param {number} [keyZeroDayIndex=5] Weekday index (0=Mon .. 6=Sun) that key 0 stands for (default 5 = Saturday)
 * @returns {number | null}
 */
export function dayForKey(keyInput, keyZeroDayIndex = DEFAULT_KEY_ZERO_DAY) {
  if (keyInput === null || keyInput === undefined) return null;
  const str = String(keyInput);
  if (!/^[0-7]$/.test(str)) {
    return null;
  }

  const keyNum = Number(str);
  const baseDay =
    Number.isInteger(keyZeroDayIndex) && keyZeroDayIndex >= 0 && keyZeroDayIndex <= 6
      ? keyZeroDayIndex
      : DEFAULT_KEY_ZERO_DAY;

  return (baseDay + keyNum) % 7;
}

/**
 * Returns the primary shortcut digit (`0..6`) that triggers `targetDayIndex`
 * given `keyZeroDayIndex`.
 *
 * @param {number} targetDayIndex 0..6
 * @param {number} [keyZeroDayIndex=5] 0..6
 * @returns {number} 0..6
 */
export function primaryKeyForDay(targetDayIndex, keyZeroDayIndex = DEFAULT_KEY_ZERO_DAY) {
  const baseDay =
    Number.isInteger(keyZeroDayIndex) && keyZeroDayIndex >= 0 && keyZeroDayIndex <= 6
      ? keyZeroDayIndex
      : DEFAULT_KEY_ZERO_DAY;
  return (targetDayIndex - baseDay + 7) % 7;
}
