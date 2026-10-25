/**
 * Trendz Tracker — Pure Memoriad Date & Weekday Formatting Helpers (js/memoriadFormat.js)
 *
 * Pure formatting functions for Mental Calendar Dates:
 * - Date display formats:
 *   - `'DD-MM-YYYY'`  (e.g. `24-11-1873`, default)
 *   - `'MM-DD-YYYY'`  (e.g. `11-24-1873`)
 *   - `'YYYY-MM-DD'`  (e.g. `1873-11-24`)
 *   - `'DD Mon YYYY'` (e.g. `24 Nov 1873`)
 *   - `'DD-Mon-YYYY'` (e.g. `24-Nov-1873`)
 * - Day label styles:
 *   - `'upper3'`: `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`
 *   - `'short2'`: `Mo`, `Tu`, `We`, `Th`, `Fr`, `Sa`, `Su`
 *   - `'full'`  : `Monday`, `Tuesday`, `Wednesday`, `Thursday`, `Friday`, `Saturday`, `Sunday`
 * - Ordered weekday button list starting from `leftmostDayIndex` (default `0 = Monday`).
 */

export const DAY_LABELS = {
  upper3: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
  short2: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  full: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
};

export const MONTH_NAMES_SHORT = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

export const DATE_FORMATS = [
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'YYYY-MM-DD',
  'DD Mon YYYY',
  'DD-Mon-YYYY',
];

/**
 * Formats a `[year, month, day]` triple according to `format`.
 * Single-digit days are always zero-padded to 2 digits (`01`..`09`).
 *
 * @param {[number, number, number] | number[]} dateTriple
 * @param {'DD-MM-YYYY' | 'MM-DD-YYYY' | 'YYYY-MM-DD' | 'DD Mon YYYY' | 'DD-Mon-YYYY' | string} [format='DD-MM-YYYY']
 * @returns {string}
 */
export function formatCalendarDate(dateTriple, format = 'DD-MM-YYYY') {
  if (!Array.isArray(dateTriple) || dateTriple.length < 3) {
    return '';
  }
  const yyyy = String(dateTriple[0]).padStart(4, '0');
  const monthNum = Number(dateTriple[1]);
  const mm = String(dateTriple[1]).padStart(2, '0');
  const dd = String(dateTriple[2]).padStart(2, '0');
  const mon =
    Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12
      ? MONTH_NAMES_SHORT[monthNum - 1]
      : mm;

  switch (format) {
    case 'MM-DD-YYYY':
      return `${mm}-${dd}-${yyyy}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    case 'DD Mon YYYY':
      return `${dd} ${mon} ${yyyy}`;
    case 'DD-Mon-YYYY':
      return `${dd}-${mon}-${yyyy}`;
    case 'DD-MM-YYYY':
    default:
      return `${dd}-${mm}-${yyyy}`;
  }
}

/**
 * Formats a weekday index (`0 = Monday .. 6 = Sunday`) using the requested abbreviation style.
 *
 * @param {number | null | undefined} dayIndex 0..6
 * @param {'upper3' | 'short2' | 'full' | string} [style='upper3']
 * @returns {string}
 */
export function formatDayLabel(dayIndex, style = 'upper3') {
  if (dayIndex === null || dayIndex === undefined || dayIndex === '') {
    return '';
  }
  const idx = Number(dayIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > 6) {
    return '';
  }
  const table = DAY_LABELS[style] || DAY_LABELS.upper3;
  return table[idx] || '';
}

/**
 * Returns the 7 weekday indices (`0..6`) rotated so `leftmostDayIndex` is first.
 *
 * @param {number} [leftmostDayIndex=0] 0 = Monday .. 6 = Sunday
 * @returns {number[]}
 */
export function getOrderedWeekdays(leftmostDayIndex = 0) {
  const start =
    Number.isInteger(leftmostDayIndex) && leftmostDayIndex >= 0 && leftmostDayIndex <= 6
      ? leftmostDayIndex
      : 0;
  const order = [];
  for (let i = 0; i < 7; i++) {
    order.push((start + i) % 7);
  }
  return order;
}
