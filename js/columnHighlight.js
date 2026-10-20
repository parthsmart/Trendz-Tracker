/**
 * Trendz Tracker — Pure Column Highlight Calculator for Mental Additions (js/columnHighlight.js)
 *
 * Computes which 0-indexed digit column(s) (`0..totalColumns - 1`, left to right)
 * should be highlighted in the 10×10-digit addition grid:
 * - Supports `columnsPerStep` (`g`) in `1, 2, 3, 4` (default `1`).
 * - `step = Math.floor(typedCount / g) + manualStepOffset`, clamped to `[0 .. maxStep]`
 *   where `maxStep = Math.ceil(totalColumns / g) - 1`.
 * - In `'rtl'` (right-to-left, default) mode:
 *   The highlighted block is the `g` columns at `step` counted from the right
 *   (the leftmost block may be shorter when `totalColumns % g !== 0`, e.g., `[0]` for `g = 3`
 *   and `[0, 1]` for `g = 4` on `10` columns). After the last block, the leftmost block stays highlighted.
 * - In `'ltr'` (left-to-right) mode:
 *   Blocks of `g` columns are counted from the left (`[0 .. g - 1]`, etc.), and after the last block
 *   the rightmost block stays highlighted.
 */

export const DEFAULT_TOTAL_COLUMNS = 10;

/**
 * Normalises `columnsPerStep` to an integer in `1..4` (default `1`).
 * @param {unknown} rawColumnsPerStep
 * @returns {1 | 2 | 3 | 4}
 */
export function normalizeColumnsPerStep(rawColumnsPerStep) {
  const n = Number(rawColumnsPerStep);
  if (n === 2 || n === 3 || n === 4) return n;
  return 1;
}

/**
 * Returns the sorted array of 0-indexed column indices to highlight (`0 .. totalColumns - 1`).
 *
 * @param {{
 *   totalColumns?: number,
 *   direction?: 'rtl' | 'ltr',
 *   columnsPerStep?: 1 | 2 | 3 | 4 | number,
 *   typedCount?: number,
 *   manualStepOffset?: number
 * }} [options={}]
 * @returns {number[]}
 */
export function highlightedColumns(options = {}) {
  const totalColumns = Math.max(1, Number(options.totalColumns) || DEFAULT_TOTAL_COLUMNS);
  const direction = options.direction === 'ltr' ? 'ltr' : 'rtl';
  const g = Math.min(totalColumns, normalizeColumnsPerStep(options.columnsPerStep));
  const typedCount = Math.max(0, Number(options.typedCount) || 0);
  const manualStepOffset = Number(options.manualStepOffset) || 0;

  const maxStep = Math.max(0, Math.ceil(totalColumns / g) - 1);
  const autoSteps = Math.floor(typedCount / g);
  const stepIndex = Math.min(maxStep, Math.max(0, autoSteps + manualStepOffset));

  if (direction === 'ltr') {
    const startCol = stepIndex * g;
    const endColInclusive = Math.min(totalColumns - 1, startCol + g - 1);
    const cols = [];
    for (let i = startCol; i <= endColInclusive; i++) {
      cols.push(i);
    }
    return cols;
  }

  // 'rtl': blocks of size `g` counted from the right; leftmost block may be shorter (`totalColumns % g`)
  const endColInclusive = totalColumns - 1 - stepIndex * g;
  const startCol = Math.max(0, endColInclusive - g + 1);
  const cols = [];
  for (let i = startCol; i <= endColInclusive; i++) {
    cols.push(i);
  }
  return cols;
}
