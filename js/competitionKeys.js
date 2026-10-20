/**
 * Trendz Tracker — Shared Competition & Worksheet Keyboard Shortcuts (js/competitionKeys.js)
 *
 * Pure, DOM-free helper that translates a KeyboardEvent-like object into a
 * semantic navigation/control action for timed worksheets and competition drills.
 *
 * Why this lives in a shared module:
 * - Both the Elements timed worksheet (Phase 8c) and the upcoming Memoriad
 *   competition mode use the numpad for rapid one-handed calculation entry.
 * - Centralising key normalisation (`key` and physical `code`, including
 *   numpad keys and Unicode minus `−`) keeps behaviour identical across pages
 *   while allowing each page to choose which actions it handles (for example,
 *   the Elements worksheet handles `'next'` and `'previous'` but ignores
 *   `'step'` so `*` can still be typed in the Prime Factor drill).
 */

const MINUS_SIGN = '\u2212'; // Unicode minus sign '−'

/**
 * Maps a keyboard event-like object to a competition/worksheet action.
 *
 * @param {object} eventLike - Object with `{ key, code, ctrlKey, altKey, metaKey }`
 * @returns {'next' | 'previous' | 'step' | 'unstep' | null}
 */
export function keyAction(eventLike) {
  if (!eventLike || typeof eventLike !== 'object') {
    return null;
  }

  // Never intercept shortcuts when any system/browser modifier key is held
  if (eventLike.ctrlKey || eventLike.altKey || eventLike.metaKey) {
    return null;
  }

  const key = typeof eventLike.key === 'string' ? eventLike.key : '';
  const code = typeof eventLike.code === 'string' ? eventLike.code : '';

  if (key === '+' || code === 'NumpadAdd') {
    return 'next';
  }

  if (key === '-' || key === MINUS_SIGN || code === 'NumpadSubtract') {
    return 'previous';
  }

  if (key === '*' || code === 'NumpadMultiply') {
    return 'step';
  }

  if (key === '/' || code === 'NumpadDivide') {
    return 'unstep';
  }

  return null;
}
