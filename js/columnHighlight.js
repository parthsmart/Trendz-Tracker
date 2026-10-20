/**
 * Trendz Tracker — Pure Column Highlight Calculator for Mental Additions (js/columnHighlight.js)
 *
 * Computes which 0-indexed digit column(s) (`0..totalColumns - 1`, left to right)
 * should be highlighted in the 10×10-digit addition grid:
 * - In `'rtl'` (right-to-left, default) mode:
 *   Starts at the rightmost column(s) (`[9]` for 1 column, `[8, 9]` for 2 columns)
 *   and shifts left by `columnsPerStep` (`1` or `2`) each time `typedCount` crosses a step
 *   boundary (or when nudged via `manualStepOffset` with `*` / `/`).
 *   Clamps at the leftmost column(s) (`[0]` or `[0, 1]`).
 * - In `'ltr'` (left-to-right) mode:
 *   Starts at the leftmost column(s) (`[0]` for 1 column, `[0, 1]` for 2 columns)
 *   and shifts right by `columnsPerStep` (`1` or `2`) per step.
 *   Clamps at the rightmost column(s) (`[9]` or `[8, 9]`).
 */

export const DEFAULT_TOTAL_COLUMNS = 10;

/**
 * Returns the sorted array of 0-indexed column indices to highlight (`0 .. totalColumns - 1`).
 *
 * @param {{
 *   totalColumns?: number,
 *   direction?: 'rtl' | 'ltr',
 *   columnsPerStep?: 1 | 2 | number,
 *   typedCount?: number,
 *   manualStepOffset?: number
 * }} [options={}]
 * @returns {number[]}
 */
export function highlightedColumns(options = {}) {
  const totalColumns = Math.max(1, Number(options.totalColumns) || DEFAULT_TOTAL_COLUMNS);
  const direction = options.direction === 'ltr' ? 'ltr' : 'rtl';
  const width = Number(options.columnsPerStep) === 2 ? Math.min(2, totalColumns) : 1;
  const typedCount = Math.max(0, Number(options.typedCount) || 0);
  const manualStepOffset = Number(options.manualStepOffset) || 0;

  // Each step advances by `width` columns
  const autoSteps = Math.floor(typedCount / width);
  const stepIndex = Math.max(0, autoSteps + manualStepOffset);

  if (direction === 'ltr') {
    const startCol = Math.min(totalColumns - width, stepIndex * width);
    const cols = [];
    for (let i = 0; i < width; i++) {
      cols.push(startCol + i);
    }
    return cols;
  }

  // 'rtl': rightmost window starts at [totalColumns - width .. totalColumns - 1]
  // and shifts left by stepIndex * width, clamping at 0.
  const endColInclusive = Math.max(width - 1, totalColumns - 1 - stepIndex * width);
  const startCol = Math.max(0, endColInclusive - width + 1);
  const cols = [];
  for (let i = startCol; i <= endColInclusive; i++) {
    cols.push(i);
  }
  return cols;
}
