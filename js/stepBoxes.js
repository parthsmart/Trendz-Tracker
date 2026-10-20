/**
 * Trendz Tracker — Pure Step-Box State Machines for Multiplications & Square Roots (js/stepBoxes.js)
 *
 * Pure, DOM-free state helpers for the column marker boxes above the active question:
 *
 * 1. Mental Multiplications (`n = 8`, cyclic `s in 0 .. 2n - 1`):
 *    - Pressing `'*'` (or clicking the next box in sequence) advances `s = (s + 1) mod (2n)`.
 *    - For `s` from `0` to `n`, the RIGHTMOST `s` boxes are checked (`[n - s .. n - 1]`).
 *    - For `s` from `n + 1` to `2n - 1`, the LEFTMOST `2n - s` boxes are checked (`[0 .. 2n - s - 1]`).
 *    - Pressing `'/'` does nothing in this format.
 *    - Clicking a box acts as a `'*'` press ONLY when it is the next box in the sequence:
 *      the rightmost unchecked box while growing (`0 <= s < n`, index `n - 1 - s`), or
 *      the rightmost checked box while shrinking (`n <= s < 2n`, index `2n - 1 - s`).
 *
 * 2. Mental Square Roots (`n = 6`, bounded `c in 0 .. n`):
 *    - State `c` (`0 .. n`) is the count of checked boxes from the LEFT (`[0 .. c - 1]`).
 *    - Pressing `'*'` (or clicking the leftmost unchecked box, index `c`) checks the next box (`min(n, c + 1)`).
 *    - Pressing `'/'` (or clicking the rightmost checked box, index `c - 1`) unchecks it (`max(0, c - 1)`).
 *    - No wrap-around at `0` or `n`.
 */

/**
 * Normalises a multiplication step state `s` into `0 .. 2n - 1`.
 * @param {number} s
 * @param {number} [n=8]
 * @returns {number}
 */
export function normalizeMultStepState(s, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const mod = 2 * count;
  const raw = Math.floor(Number(s) || 0);
  return ((raw % mod) + mod) % mod;
}

/**
 * Advances the multiplication step state by one `'*'` press: `s = (s + 1) mod (2n)`.
 * @param {number} s
 * @param {number} [n=8]
 * @returns {number}
 */
export function advanceMultStep(s, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const current = normalizeMultStepState(s, count);
  return (current + 1) % (2 * count);
}

/**
 * Handles a keyboard step action (`'*'` / `'step'` or `'/'` / `'unstep'`) for Multiplications.
 * `'/'` does nothing in this format.
 * @param {number} s
 * @param {string} keyOrAction
 * @param {number} [n=8]
 * @returns {number}
 */
export function pressMultStepKey(s, keyOrAction, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const current = normalizeMultStepState(s, count);
  if (keyOrAction === '*' || keyOrAction === 'step') {
    return advanceMultStep(current, count);
  }
  // '/' or 'unstep' does nothing in Multiplications stacked format
  return current;
}

/**
 * Returns an array of length `n` of booleans (`true` = checked, `false` = unchecked)
 * for multiplication step state `s` (`0 .. 2n - 1`).
 * - For `0 <= s <= n`: the rightmost `s` boxes are checked.
 * - For `n + 1 <= s <= 2n - 1`: the leftmost `2n - s` boxes are checked.
 *
 * @param {number} s
 * @param {number} [n=8]
 * @returns {boolean[]}
 */
export function getMultCheckedBoxes(s, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const state = normalizeMultStepState(s, count);
  const boxes = new Array(count).fill(false);

  if (state === 0) {
    return boxes;
  }
  if (state <= count) {
    // Rightmost `state` boxes checked: indices [count - state .. count - 1]
    for (let i = count - state; i < count; i++) {
      boxes[i] = true;
    }
    return boxes;
  }
  // state in [count + 1 .. 2 * count - 1]: leftmost (2 * count - state) boxes checked
  const leftCheckedCount = 2 * count - state;
  for (let i = 0; i < leftCheckedCount; i++) {
    boxes[i] = true;
  }
  return boxes;
}

/**
 * Returns the 0-indexed column indices (`0 .. n - 1`, left to right) that are currently checked.
 * @param {number} s
 * @param {number} [n=8]
 * @returns {number[]}
 */
export function getMultCheckedIndices(s, n = 8) {
  const boxes = getMultCheckedBoxes(s, n);
  const indices = [];
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i]) indices.push(i);
  }
  return indices;
}

/**
 * Returns the 0-indexed box (`0 .. n - 1`) that is the next valid click target in the sequence:
 * - While growing (`0 <= s < n`): the rightmost unchecked box (`n - 1 - s`).
 * - While shrinking (`n <= s < 2n`): the rightmost checked box (`2n - 1 - s`).
 *
 * @param {number} s
 * @param {number} [n=8]
 * @returns {number}
 */
export function getMultNextClickBoxIndex(s, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const state = normalizeMultStepState(s, count);
  if (state < count) {
    return count - 1 - state;
  }
  return 2 * count - 1 - state;
}

/**
 * Handles clicking box `boxIndex` (`0 .. n - 1`) in Multiplications:
 * acts as a `'*'` press ONLY when `boxIndex` is the next box in the sequence;
 * other clicks do nothing.
 *
 * @param {number} s
 * @param {number} boxIndex
 * @param {number} [n=8]
 * @returns {number}
 */
export function clickMultStepBox(s, boxIndex, n = 8) {
  const count = Math.max(1, Math.floor(Number(n) || 8));
  const current = normalizeMultStepState(s, count);
  const expectedIndex = getMultNextClickBoxIndex(current, count);
  if (Number(boxIndex) === expectedIndex) {
    return advanceMultStep(current, count);
  }
  return current;
}

/* ============================================================================
 * SQUARE ROOTS STEP BOXES (Bounded 0 .. n from Left to Right, default n = 6)
 * ========================================================================== */

/**
 * Normalises a square-root step count `c` into `0 .. n`.
 * @param {number} c
 * @param {number} [n=6]
 * @returns {number}
 */
export function normalizeRootStepState(c, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 6));
  const raw = Math.floor(Number(c) || 0);
  return Math.max(0, Math.min(count, raw));
}

/**
 * Handles a keyboard step action (`'*'` / `'step'` or `'/'` / `'unstep'`) for Square Roots:
 * - `'*'` / `'step'` checks the next box from the left (`min(n, c + 1)`).
 * - `'/'` / `'unstep'` unchecks the rightmost checked box (`max(0, c - 1)`).
 *
 * @param {number} c
 * @param {string} keyOrAction
 * @param {number} [n=6]
 * @returns {number}
 */
export function pressRootStepKey(c, keyOrAction, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 6));
  const current = normalizeRootStepState(c, count);
  if (keyOrAction === '*' || keyOrAction === 'step') {
    return Math.min(count, current + 1);
  }
  if (keyOrAction === '/' || keyOrAction === 'unstep') {
    return Math.max(0, current - 1);
  }
  return current;
}

/**
 * Returns an array of length `n` of booleans (`true` = checked, `false` = unchecked)
 * for square-root step state `c` (`0 .. n`): leftmost `c` boxes are checked.
 *
 * @param {number} c
 * @param {number} [n=6]
 * @returns {boolean[]}
 */
export function getRootCheckedBoxes(c, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 6));
  const checkedCount = normalizeRootStepState(c, count);
  return Array.from({ length: count }, (_, idx) => idx < checkedCount);
}

/**
 * Returns the 0-indexed column indices (`0 .. c - 1`) that are checked in Square Roots.
 * @param {number} c
 * @param {number} [n=6]
 * @returns {number[]}
 */
export function getRootCheckedIndices(c, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 6));
  const checkedCount = normalizeRootStepState(c, count);
  return Array.from({ length: checkedCount }, (_, idx) => idx);
}

/**
 * Handles clicking box `boxIndex` (`0 .. n - 1`) in Square Roots:
 * - Clicking the leftmost unchecked box (`boxIndex === c`) checks it (`c + 1`).
 * - Clicking the rightmost checked box (`boxIndex === c - 1`) unchecks it (`c - 1`).
 * - Any other click does nothing.
 *
 * @param {number} c
 * @param {number} boxIndex
 * @param {number} [n=6]
 * @returns {number}
 */
export function clickRootStepBox(c, boxIndex, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 6));
  const current = normalizeRootStepState(c, count);
  const idx = Number(boxIndex);
  if (idx === current && current < count) {
    return current + 1;
  }
  if (idx === current - 1 && current > 0) {
    return current - 1;
  }
  return current;
}
