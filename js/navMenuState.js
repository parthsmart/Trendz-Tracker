/**
 * Trendz Tracker - Pure Navigation Menu State & Keyboard Rules (js/navMenuState.js)
 *
 * Phase 14d:
 * Pure state functions for opening, closing, arrow-key focus wrap-around,
 * Tab focus-trap boundary calculation, and full-screen stage detection.
 */

export const DEDICATED_STAGE_PATHS = Object.freeze([
  '/pages/basics-practice.html',
  '/pages/element-drill.html',
  '/pages/memoriad-play.html',
]);

/**
 * Creates the initial closed menu state.
 * @param {number} [itemCount=0]
 */
export function createMenuState(itemCount = 0) {
  const safeCount = Math.max(0, Math.trunc(Number(itemCount) || 0));
  return Object.freeze({
    isOpen: false,
    focusedIndex: -1,
    itemCount: safeCount,
    returnFocusToButton: false,
  });
}

/**
 * Transitions the menu to the open state and moves focus to the first item (index 0).
 * @param {{ isOpen?: boolean, focusedIndex?: number, itemCount?: number }} state
 * @param {number} [itemCount]
 */
export function openMenuState(state, itemCount = state?.itemCount ?? 0) {
  const safeCount = Math.max(0, Math.trunc(Number(itemCount) || 0));
  return Object.freeze({
    isOpen: true,
    focusedIndex: safeCount > 0 ? 0 : -1,
    itemCount: safeCount,
    returnFocusToButton: false,
  });
}

/**
 * Transitions the menu to the closed state and flags whether focus should return to the menu button.
 * @param {{ isOpen?: boolean, focusedIndex?: number, itemCount?: number }} state
 * @param {{ returnFocus?: boolean }} [options]
 */
export function closeMenuState(state, { returnFocus = true } = {}) {
  const wasOpen = Boolean(state?.isOpen);
  const safeCount = Math.max(0, Math.trunc(Number(state?.itemCount) || 0));
  return Object.freeze({
    isOpen: false,
    focusedIndex: -1,
    itemCount: safeCount,
    returnFocusToButton: Boolean(wasOpen && returnFocus),
  });
}

/**
 * Toggles the menu between open and closed states.
 * @param {{ isOpen?: boolean, focusedIndex?: number, itemCount?: number }} state
 * @param {number} [itemCount]
 */
export function toggleMenuState(state, itemCount = state?.itemCount ?? 0) {
  if (state?.isOpen) {
    return closeMenuState(state, { returnFocus: true });
  }
  return openMenuState(state, itemCount);
}

/**
 * Computes the next focused item index for ArrowDown, ArrowUp, Home, and End with wrap-around.
 * @param {number} currentIndex
 * @param {number} itemCount
 * @param {string} key
 * @returns {number}
 */
export function moveFocusIndex(currentIndex, itemCount, key) {
  const count = Math.max(0, Math.trunc(Number(itemCount) || 0));
  if (count <= 0) return -1;

  const idx = Number.isInteger(currentIndex) ? currentIndex : -1;

  if (key === 'ArrowDown') {
    if (idx < 0 || idx >= count - 1) return 0;
    return idx + 1;
  }

  if (key === 'ArrowUp') {
    if (idx <= 0 || idx >= count) return count - 1;
    return idx - 1;
  }

  if (key === 'Home') {
    return 0;
  }

  if (key === 'End') {
    return count - 1;
  }

  return idx >= 0 && idx < count ? idx : 0;
}

/**
 * Computes focus-trap index transitions when pressing Tab or Shift+Tab inside an open menu/drawer.
 * @param {number} currentIndex
 * @param {number} itemCount
 * @param {boolean} [shiftKey=false]
 * @returns {{ trapped: boolean, nextIndex: number }}
 */
export function trapTabFocusIndex(currentIndex, itemCount, shiftKey = false) {
  const count = Math.max(0, Math.trunc(Number(itemCount) || 0));
  if (count <= 0) {
    return { trapped: false, nextIndex: -1 };
  }

  const idx = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < count
    ? currentIndex
    : 0;

  if (shiftKey) {
    if (idx <= 0) {
      return { trapped: true, nextIndex: count - 1 };
    }
    return { trapped: false, nextIndex: idx - 1 };
  }

  if (idx >= count - 1) {
    return { trapped: true, nextIndex: 0 };
  }
  return { trapped: false, nextIndex: idx + 1 };
}

/**
 * Applies a keyboard event key to the current menu state.
 * @param {{ isOpen: boolean, focusedIndex: number, itemCount: number, returnFocusToButton: boolean }} state
 * @param {string} key
 * @param {{ shiftKey?: boolean }} [options]
 */
export function applyMenuKeyAction(state, key, { shiftKey = false } = {}) {
  if (!state?.isOpen) {
    return state;
  }

  if (key === 'Escape' || key === 'Esc') {
    return closeMenuState(state, { returnFocus: true });
  }

  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
    const nextIndex = moveFocusIndex(state.focusedIndex, state.itemCount, key);
    return Object.freeze({
      ...state,
      focusedIndex: nextIndex,
      returnFocusToButton: false,
    });
  }

  if (key === 'Tab') {
    const { nextIndex } = trapTabFocusIndex(state.focusedIndex, state.itemCount, shiftKey);
    return Object.freeze({
      ...state,
      focusedIndex: nextIndex,
      returnFocusToButton: false,
    });
  }

  return state;
}

/**
 * Returns true if the pathname is a dedicated full-screen practice/drill stage
 * where the global header and navigation menu must not be shown.
 * @param {string} pathname
 * @returns {boolean}
 */
export function isDedicatedStagePathname(pathname) {
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  return DEDICATED_STAGE_PATHS.some((stagePath) => clean === stagePath || clean.endsWith(stagePath));
}
