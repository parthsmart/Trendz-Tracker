/**
 * Trendz Tracker — Pure Answer Slot State Machine (js/answerSlots.js)
 *
 * Pure, DOM-free state machine for multi-slot digit entry in Mental Additions.
 * Manages an array of `slotCount` (default 11) digit slots (`''` or `'0'..'9'`),
 * a `cursor` index (`0 .. slotCount - 1`), a `groupSize` (`1 .. 4`), and a `history`
 * stack of typed slot indices supporting both:
 * - `'rtl'` (right-to-left, default):
 *   - With `groupSize = 1`: cursor starts at rightmost slot (`slotCount - 1`) and moves left one slot per digit.
 *   - With `groupSize = g` (`2 .. 4`): slots are partitioned from the right into groups of `g`
 *     (plus a leftmost partial group of `slotCount mod g` slots). The cursor starts at the
 *     leftmost slot of the rightmost group (`slotCount - g`), moves LEFT-TO-RIGHT inside each
 *     group, and after the rightmost slot of a group jumps to the leftmost slot of the next
 *     group to the left.
 * - `'ltr'` (left-to-right): cursor starts at leftmost slot `0` and moves right one slot per digit.
 *
 * All functions are pure and return a new state object without mutating the input state.
 */

export const DEFAULT_SLOT_COUNT = 11;
export const ALLOWED_GROUP_SIZES = Object.freeze([1, 2, 3, 4]);

/**
 * Normalises `groupSize` to an integer in `1..4` (default `1`).
 * @param {unknown} rawGroupSize
 * @returns {1 | 2 | 3 | 4}
 */
export function normalizeGroupSize(rawGroupSize) {
  const n = Number(rawGroupSize);
  if (n === 2 || n === 3 || n === 4) return n;
  return 1;
}

/**
 * Returns the `[groupStart, groupEnd]` (inclusive 0-based slot indices) for the right-aligned
 * group of size `groupSize` that contains `slotIndex` within `slotCount` slots.
 *
 * Example for `slotCount = 11`:
 * - `g = 2`: `[9,10], [7,8], [5,6], [3,4], [1,2], [0,0]`
 * - `g = 3`: `[8,10], [5,7], [2,4], [0,1]`
 * - `g = 4`: `[7,10], [3,6], [0,2]`
 *
 * @param {number} slotCount
 * @param {number} groupSize
 * @param {number} slotIndex
 * @returns {[number, number]}
 */
export function getRtlGroupBounds(slotCount, groupSize, slotIndex) {
  const count = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);
  const g = Math.min(count, normalizeGroupSize(groupSize));
  const idx = Math.max(0, Math.min(count - 1, Number(slotIndex) || 0));

  const distFromRight = count - 1 - idx;
  const groupIdxFromRight = Math.floor(distFromRight / g);
  const groupEnd = count - 1 - groupIdxFromRight * g;
  const groupStart = Math.max(0, groupEnd - g + 1);
  return [groupStart, groupEnd];
}

/**
 * Computes the next cursor index after typing a digit at `currentIndex`.
 * @param {number} slotCount
 * @param {'rtl' | 'ltr'} direction
 * @param {number} groupSize
 * @param {number} currentIndex
 * @returns {number}
 */
function computeNextCursorAfterType(slotCount, direction, groupSize, currentIndex) {
  const count = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);
  const idx = Math.max(0, Math.min(count - 1, Number(currentIndex) || 0));

  if (direction === 'ltr') {
    return Math.min(count - 1, idx + 1);
  }

  const g = Math.min(count, normalizeGroupSize(groupSize));
  if (g === 1) {
    return Math.max(0, idx - 1);
  }

  const [groupStart, groupEnd] = getRtlGroupBounds(count, g, idx);
  if (idx < groupEnd) {
    // Move left-to-right inside the current group
    return idx + 1;
  }

  // Reached the right edge of the current group: jump to the leftmost slot of the next group to the left
  if (groupStart === 0) {
    // Already finished the leftmost group
    return 0;
  }
  const nextGroupEnd = groupStart - 1;
  const nextGroupStart = Math.max(0, nextGroupEnd - g + 1);
  return nextGroupStart;
}

/**
 * Computes the initial cursor position for a fresh answer-slots state.
 * @param {number} slotCount
 * @param {'rtl' | 'ltr'} direction
 * @param {number} groupSize
 * @returns {number}
 */
function computeInitialCursor(slotCount, direction, groupSize) {
  const count = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);
  if (direction === 'ltr') return 0;
  const g = Math.min(count, normalizeGroupSize(groupSize));
  return Math.max(0, count - g);
}

/**
 * Creates a fresh answer-slots state.
 * @param {number} [slotCount=11]
 * @param {'rtl' | 'ltr'} [direction='rtl']
 * @param {string} [initialValue='']
 * @param {number} [groupSize=1]
 * @returns {{
 *   slots: string[],
 *   cursor: number,
 *   direction: 'rtl' | 'ltr',
 *   groupSize: 1 | 2 | 3 | 4,
 *   typedCount: number,
 *   history: number[]
 * }}
 */
export function createAnswerSlots(
  slotCount = DEFAULT_SLOT_COUNT,
  direction = 'rtl',
  initialValue = '',
  groupSize = 1
) {
  const count = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);
  const dir = direction === 'ltr' ? 'ltr' : 'rtl';
  const g = normalizeGroupSize(groupSize);
  const slots = new Array(count).fill('');
  const history = [];
  const cleanDigits = String(initialValue || '').replace(/\D/g, '').slice(0, count);

  let cursor = computeInitialCursor(count, dir, g);

  if (cleanDigits.length > 0) {
    if (dir === 'rtl') {
      const startIdx = count - cleanDigits.length;
      for (let i = 0; i < cleanDigits.length; i++) {
        slots[startIdx + i] = cleanDigits[i];
      }
      // Build history from right to left in group typing order
      for (let i = count - 1; i >= startIdx; i--) {
        history.push(i);
      }
      cursor = Math.max(0, startIdx - 1);
    } else {
      for (let i = 0; i < cleanDigits.length; i++) {
        slots[i] = cleanDigits[i];
        history.push(i);
      }
      cursor = Math.min(count - 1, cleanDigits.length);
    }
  }

  return {
    slots,
    cursor,
    direction: dir,
    groupSize: g,
    typedCount: cleanDigits.length,
    history,
  };
}

/**
 * Counts how many non-empty digit slots exist in `slots`.
 * @param {string[]} slots
 * @returns {number}
 */
export function countFilledSlots(slots) {
  if (!Array.isArray(slots)) return 0;
  let n = 0;
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== '') n += 1;
  }
  return n;
}

/**
 * Writes a single digit ('0'..'9') at the current cursor slot, records the slot in `history`,
 * and advances the cursor according to `direction` and `groupSize`.
 * Non-digit inputs return the state unchanged.
 *
 * @param {object} state
 * @param {string|number} digit
 */
export function typeDigit(state, digit) {
  const str = String(digit ?? '');
  if (!/^[0-9]$/.test(str)) {
    return state;
  }

  const count = state.slots.length;
  const g = normalizeGroupSize(state.groupSize);
  const nextSlots = state.slots.slice();
  const idx = Math.max(0, Math.min(count - 1, state.cursor));
  nextSlots[idx] = str;

  const prevHistory = Array.isArray(state.history) ? state.history : [];
  const nextHistory = prevHistory.filter((hIdx) => hIdx !== idx);
  nextHistory.push(idx);

  const nextCursor = computeNextCursorAfterType(count, state.direction, g, idx);

  return {
    ...state,
    groupSize: g,
    slots: nextSlots,
    cursor: nextCursor,
    typedCount: countFilledSlots(nextSlots),
    history: nextHistory,
  };
}

/**
 * Moves the cursor one slot to the left (clamped at 0).
 * @param {object} state
 */
export function moveCursorLeft(state) {
  return {
    ...state,
    cursor: Math.max(0, state.cursor - 1),
  };
}

/**
 * Moves the cursor one slot to the right (clamped at slotCount - 1).
 * @param {object} state
 */
export function moveCursorRight(state) {
  return {
    ...state,
    cursor: Math.min(state.slots.length - 1, state.cursor + 1),
  };
}

/**
 * Sets the cursor directly to `index` (clamped to valid range).
 * @param {object} state
 * @param {number} index
 */
export function setCursor(state, index) {
  const idx = Math.max(0, Math.min(state.slots.length - 1, Number(index) || 0));
  return {
    ...state,
    cursor: idx,
  };
}

/**
 * Removes the most recently typed digit (using `state.history`) and moves the cursor
 * back to its slot. If `history` is empty, falls back to clearing the adjacent/current slot.
 *
 * @param {object} state
 */
export function backspace(state) {
  const count = state.slots.length;
  const nextSlots = state.slots.slice();
  const nextHistory = Array.isArray(state.history) ? state.history.slice() : [];

  while (nextHistory.length > 0) {
    const lastIdx = nextHistory.pop();
    if (
      Number.isInteger(lastIdx) &&
      lastIdx >= 0 &&
      lastIdx < count &&
      nextSlots[lastIdx] !== ''
    ) {
      nextSlots[lastIdx] = '';
      return {
        ...state,
        slots: nextSlots,
        cursor: lastIdx,
        typedCount: countFilledSlots(nextSlots),
        history: nextHistory,
      };
    }
  }

  // Fallback when history is empty
  const idx = Math.max(0, Math.min(count - 1, state.cursor));
  if (state.direction === 'ltr') {
    if (nextSlots[idx] !== '' && idx === count - 1) {
      nextSlots[idx] = '';
      return {
        ...state,
        slots: nextSlots,
        cursor: idx,
        typedCount: countFilledSlots(nextSlots),
        history: [],
      };
    }
    const prevIdx = Math.max(0, idx - 1);
    nextSlots[prevIdx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: prevIdx,
      typedCount: countFilledSlots(nextSlots),
      history: [],
    };
  }

  if (nextSlots[idx] !== '') {
    nextSlots[idx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: idx,
      typedCount: countFilledSlots(nextSlots),
      history: [],
    };
  }

  const prevIdx = Math.min(count - 1, idx + 1);
  if (nextSlots[prevIdx] !== '') {
    nextSlots[prevIdx] = '';
  }
  return {
    ...state,
    slots: nextSlots,
    cursor: prevIdx,
    typedCount: countFilledSlots(nextSlots),
    history: [],
  };
}

/**
 * Closes any blank gaps between typed digits (called on Enter before advancing):
 * - In 'rtl' mode: packs all non-empty digits flush to the right (`..slotCount - 1`).
 * - In 'ltr' mode: packs all non-empty digits flush to the left (`0..`).
 * Preserves typing history mapped to the compacted slot positions.
 *
 * @param {object} state
 */
export function compact(state) {
  const count = state.slots.length;
  const g = normalizeGroupSize(state.groupSize);
  const filledEntries = [];
  for (let i = 0; i < count; i++) {
    if (state.slots[i] !== '') {
      filledEntries.push({ oldIdx: i, ch: state.slots[i] });
    }
  }

  const nextSlots = new Array(count).fill('');
  if (filledEntries.length === 0) {
    return {
      ...state,
      groupSize: g,
      slots: nextSlots,
      cursor: computeInitialCursor(count, state.direction, g),
      typedCount: 0,
      history: [],
    };
  }

  const oldToNewMap = new Map();

  if (state.direction === 'ltr') {
    for (let i = 0; i < filledEntries.length; i++) {
      nextSlots[i] = filledEntries[i].ch;
      oldToNewMap.set(filledEntries[i].oldIdx, i);
    }
    const prevHistory = Array.isArray(state.history) ? state.history : [];
    const nextHistory = prevHistory
      .map((oldIdx) => oldToNewMap.get(oldIdx))
      .filter((newIdx) => newIdx !== undefined);

    return {
      ...state,
      groupSize: g,
      slots: nextSlots,
      cursor: Math.min(count - 1, filledEntries.length),
      typedCount: filledEntries.length,
      history: nextHistory,
    };
  }

  const startIdx = count - filledEntries.length;
  for (let i = 0; i < filledEntries.length; i++) {
    const newIdx = startIdx + i;
    nextSlots[newIdx] = filledEntries[i].ch;
    oldToNewMap.set(filledEntries[i].oldIdx, newIdx);
  }

  const prevHistory = Array.isArray(state.history) ? state.history : [];
  const nextHistory = prevHistory
    .map((oldIdx) => oldToNewMap.get(oldIdx))
    .filter((newIdx) => newIdx !== undefined);

  return {
    ...state,
    groupSize: g,
    slots: nextSlots,
    cursor: Math.max(0, startIdx - 1),
    typedCount: filledEntries.length,
    history: nextHistory,
  };
}

/**
 * Joins all non-empty slots in left-to-right visual order into a digit string.
 * Returns `''` when no digits have been entered.
 * @param {object} state
 * @returns {string}
 */
export function toAnswerString(state) {
  if (!state || !Array.isArray(state.slots)) return '';
  return state.slots.filter((ch) => ch !== '').join('');
}
