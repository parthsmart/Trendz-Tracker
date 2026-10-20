/**
 * Trendz Tracker — Pure Answer Slot State Machine (js/answerSlots.js)
 *
 * Pure, DOM-free state machine for multi-slot digit entry in Mental Additions.
 * Manages an array of `slotCount` (default 11) digit slots (`''` or `'0'..'9'`)
 * and a `cursor` index (`0 .. slotCount - 1`) supporting both:
 * - `'rtl'` (right-to-left, default: cursor starts at rightmost slot `slotCount - 1` and moves left)
 * - `'ltr'` (left-to-right: cursor starts at leftmost slot `0` and moves right)
 *
 * All functions are pure and return a new state object without mutating the input state.
 */

export const DEFAULT_SLOT_COUNT = 11;

/**
 * Creates a fresh answer-slots state.
 * @param {number} [slotCount=11]
 * @param {'rtl' | 'ltr'} [direction='rtl']
 * @param {string} [initialValue='']
 * @returns {{
 *   slots: string[],
 *   cursor: number,
 *   direction: 'rtl' | 'ltr',
 *   typedCount: number
 * }}
 */
export function createAnswerSlots(slotCount = DEFAULT_SLOT_COUNT, direction = 'rtl', initialValue = '') {
  const count = Math.max(1, Number(slotCount) || DEFAULT_SLOT_COUNT);
  const dir = direction === 'ltr' ? 'ltr' : 'rtl';
  const slots = new Array(count).fill('');
  const cleanDigits = String(initialValue || '').replace(/\D/g, '').slice(0, count);

  if (cleanDigits.length > 0) {
    if (dir === 'rtl') {
      const startIdx = count - cleanDigits.length;
      for (let i = 0; i < cleanDigits.length; i++) {
        slots[startIdx + i] = cleanDigits[i];
      }
    } else {
      for (let i = 0; i < cleanDigits.length; i++) {
        slots[i] = cleanDigits[i];
      }
    }
  }

  let cursor = dir === 'rtl' ? count - 1 : 0;
  if (cleanDigits.length > 0) {
    if (dir === 'rtl') {
      cursor = Math.max(0, count - 1 - cleanDigits.length);
    } else {
      cursor = Math.min(count - 1, cleanDigits.length);
    }
  }

  return {
    slots,
    cursor,
    direction: dir,
    typedCount: cleanDigits.length,
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
 * Writes a single digit ('0'..'9') at the current cursor slot and advances the cursor
 * in the active typing direction (left for 'rtl', right for 'ltr').
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
  const nextSlots = state.slots.slice();
  const idx = Math.max(0, Math.min(count - 1, state.cursor));
  nextSlots[idx] = str;

  const nextCursor =
    state.direction === 'ltr'
      ? Math.min(count - 1, idx + 1)
      : Math.max(0, idx - 1);

  return {
    ...state,
    slots: nextSlots,
    cursor: nextCursor,
    typedCount: countFilledSlots(nextSlots),
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
 * Clears the previous slot relative to typing direction and moves the cursor there:
 * - In 'rtl' mode: typing moves cursor left, so the previously typed digit is at `cursor + 1`
 *   (unless the current slot `cursor` itself is filled at index 0, or `cursor` is filled and `cursor + 1` is empty).
 * - In 'ltr' mode: typing moves cursor right, so the previously typed digit is at `cursor - 1`
 *   (unless the current slot `cursor` itself is filled at the rightmost slot).
 *
 * @param {object} state
 */
export function backspace(state) {
  const count = state.slots.length;
  const nextSlots = state.slots.slice();
  const idx = Math.max(0, Math.min(count - 1, state.cursor));

  if (state.direction === 'ltr') {
    if (nextSlots[idx] !== '' && idx === count - 1) {
      nextSlots[idx] = '';
      return {
        ...state,
        slots: nextSlots,
        cursor: idx,
        typedCount: countFilledSlots(nextSlots),
      };
    }
    const prevIdx = Math.max(0, idx - 1);
    nextSlots[prevIdx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: prevIdx,
      typedCount: countFilledSlots(nextSlots),
    };
  }

  // 'rtl' direction: previous typed slot is to the right (idx + 1),
  // unless we are at slot 0 and slot 0 itself has a digit.
  if (nextSlots[idx] !== '' && idx === 0) {
    nextSlots[idx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: idx,
      typedCount: countFilledSlots(nextSlots),
    };
  }

  const prevIdx = Math.min(count - 1, idx + 1);
  if (nextSlots[prevIdx] !== '') {
    nextSlots[prevIdx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: prevIdx,
      typedCount: countFilledSlots(nextSlots),
    };
  }

  // If idx + 1 was already empty but current slot has a digit, clear current slot
  if (nextSlots[idx] !== '') {
    nextSlots[idx] = '';
    return {
      ...state,
      slots: nextSlots,
      cursor: idx,
      typedCount: countFilledSlots(nextSlots),
    };
  }

  return {
    ...state,
    cursor: prevIdx,
  };
}

/**
 * Closes any blank gaps between typed digits (called on Enter before advancing):
 * - In 'rtl' mode: packs all non-empty digits flush to the right (`..slotCount - 1`).
 * - In 'ltr' mode: packs all non-empty digits flush to the left (`0..`).
 *
 * @param {object} state
 */
export function compact(state) {
  const count = state.slots.length;
  const digits = state.slots.filter((ch) => ch !== '');
  const nextSlots = new Array(count).fill('');

  if (digits.length === 0) {
    return {
      ...state,
      slots: nextSlots,
      cursor: state.direction === 'ltr' ? 0 : count - 1,
      typedCount: 0,
    };
  }

  if (state.direction === 'ltr') {
    for (let i = 0; i < digits.length; i++) {
      nextSlots[i] = digits[i];
    }
    return {
      ...state,
      slots: nextSlots,
      cursor: Math.min(count - 1, digits.length),
      typedCount: digits.length,
    };
  }

  const startIdx = count - digits.length;
  for (let i = 0; i < digits.length; i++) {
    nextSlots[startIdx + i] = digits[i];
  }
  return {
    ...state,
    slots: nextSlots,
    cursor: Math.max(0, startIdx - 1),
    typedCount: digits.length,
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
