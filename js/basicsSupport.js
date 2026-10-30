/**
 * Trendz Tracker - Basics Online Category Support Rules (js/basicsSupport.js)
 *
 * Pure ES module shared between Basics Practice and Online Weekly Tests.
 * Reuses the exact name rules from Basics Practice (Phase 10b / 10g):
 * - Addition / Subtraction rows: `<digits>d<rows>r` (e.g. `1d4r`, `2d2r`, `2d4r`, `3d5r`)
 * - Multiplication: `<d1>dx<d2>d` or `<d1>d*<d2>d` (e.g. `1dx1d`, `2dx1d`, `3dx2d`)
 * - Division: `<d1>dby<d2>d` or `<d1>d/<d2>d` (e.g. `2dby1d`, `3d/1d`, `4dby2d`)
 *   where dividend digits >= divisor digits.
 */

export const WEEKLY_TEST_SECTION_SECONDS = [30, 60, 120, 300];

export const WEEKLY_TEST_DURATION_OPTIONS = [
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 120, label: '2 minutes' },
  { seconds: 300, label: '5 minutes' },
];

/**
 * Parses a basics category name to determine whether it is supported by the
 * server-side online question generator (`api/_drills.js`).
 *
 * @param {string} categoryName
 * @returns {{ supported: boolean, kind?: 'add_sub'|'mult'|'div', d1?: number, d2?: number, rows?: number, label?: string }}
 */
export function parseBasicsCategorySpec(categoryName) {
  const raw = String(categoryName || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return { supported: false };

  // 1. Add/Sub rows: e.g., 1d4r, 2d2r, 2d4r, 3d5r
  const addSubMatch = raw.match(/^([1-5])d([2-9]|1[0-5])r$/);
  if (addSubMatch) {
    const d1 = Number(addSubMatch[1]);
    const rows = Number(addSubMatch[2]);
    return {
      supported: true,
      kind: 'add_sub',
      d1,
      rows,
      label: `${d1}-digit, ${rows} rows (Add / Sub)`,
    };
  }

  // 2. Multiplication: e.g., 1dx1d, 2dx1d, 2d*2d, 3dx2d
  const multMatch = raw.match(/^([1-5])d(?:x|\*)([1-5])d$/);
  if (multMatch) {
    const d1 = Number(multMatch[1]);
    const d2 = Number(multMatch[2]);
    return {
      supported: true,
      kind: 'mult',
      d1,
      d2,
      label: `${d1}-digit × ${d2}-digit Multiplication`,
    };
  }

  // 3. Division: e.g., 2dby1d, 3d/1d, 4dby2d
  const divMatch = raw.match(/^([1-6])d(?:by|\/)([1-4])d$/);
  if (divMatch) {
    const d1 = Number(divMatch[1]);
    const d2 = Number(divMatch[2]);
    if (d1 >= d2) {
      return {
        supported: true,
        kind: 'div',
        d1,
        d2,
        label: `${d1}-digit ÷ ${d2}-digit Exact Division`,
      };
    }
  }

  return { supported: false };
}

/**
 * Returns true if the basics category name can be practiced / tested online.
 *
 * @param {string} categoryName
 * @returns {boolean}
 */
export function isBasicsOnlineAvailable(categoryName) {
  return parseBasicsCategorySpec(categoryName).supported;
}

/**
 * Formats a section duration in seconds into a human-friendly label
 * (`30 seconds`, `1 minute`, `2 minutes`, `5 minutes`).
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatSectionDuration(seconds) {
  const sec = Number(seconds) || 0;
  if (sec === 60) return '1 minute';
  if (sec > 60 && sec % 60 === 0) return `${sec / 60} minutes`;
  return `${sec} seconds`;
}
