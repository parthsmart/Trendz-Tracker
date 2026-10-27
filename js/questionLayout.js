/**
 * Trendz Tracker — Elements Question Layout Helper (js/questionLayout.js)
 *
 * Pure functions that classify Elements worksheet question prompts as
 * `'nowrap'` (18 characters or fewer) or `'wrap'` (more than 18 characters),
 * and prevent standalone operators from wrapping alone on a line.
 */

export const NOWRAP_MAX_LENGTH = 18;

/**
 * Returns `'nowrap'` when the trimmed question text is 18 characters or fewer,
 * or `'wrap'` when it is 19 characters or longer.
 *
 * @param {string} text
 * @returns {'nowrap' | 'wrap'}
 */
export function questionLayout(text) {
  const cleaned = String(text ?? '').trim();
  return cleaned.length <= NOWRAP_MAX_LENGTH ? 'nowrap' : 'wrap';
}

/**
 * Formats a question string for display inside the single inline `<span>`:
 * - Strips accidental leading/trailing whitespace.
 * - For `'wrap'` strings (> 18 characters, such as "Jan. 14, 1742 - May 22, 1891"),
 *   replaces the space before standalone operators (`-`, `/`, `+`, `*`, `×`, `=`)
 *   with a non-breaking space (`\u00A0`) so wrapping only happens at word spaces
 *   and never leaves an operator alone on a line.
 *
 * @param {string} text
 * @returns {string}
 */
export function formatQuestionText(text) {
  const cleaned = String(text ?? '').trim();
  if (questionLayout(cleaned) === 'nowrap') {
    return cleaned;
  }
  return cleaned.replace(/\s+([-+/*×=])\s+/g, '\u00A0$1 ');
}
