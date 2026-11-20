/**
 * Trendz Tracker — Shared Score Colour & Feedback Module (shared/scoreColors.js)
 *
 * Intent:
 * Single source of truth used by both the browser UI (via `js/scoreColors.js`)
 * and the serverless Google Sheets mirror (`api/_mirror.js`).
 *
 * Colour rule (matching Jr. MCWC score sheets):
 * - all correct and total > 0 (0 wrong) -> 'green' (#00E000)
 * - 1 to 10 wrong                       -> 'orange' (#FF9900)
 * - more than 10 wrong (>= 11 wrong)    -> 'cyan' (#00E5FF)
 * - no data / invalid / total <= 0      -> null
 */

export const SCORE_COLOR_HEX = Object.freeze({
  green: '#00E000',
  orange: '#FF9900',
  cyan: '#00E5FF',
});

export const SCORE_COLOR_RGB = Object.freeze({
  green: Object.freeze({ red: 0, green: 224 / 255, blue: 0 }),
  orange: Object.freeze({ red: 1, green: 153 / 255, blue: 0 }),
  cyan: Object.freeze({ red: 0, green: 229 / 255, blue: 1 }),
});

/**
 * Pure colour classifier for a score cell.
 *
 * @param {number|string|null|undefined} correct
 * @param {number|string|null|undefined} total
 * @returns {'green' | 'orange' | 'cyan' | null}
 */
export function getScoreColor(correct, total) {
  if (
    correct === null ||
    correct === undefined ||
    correct === '' ||
    total === null ||
    total === undefined ||
    total === ''
  ) {
    return null;
  }

  const numCorrect = Number(correct);
  const numTotal = Number(total);

  if (!Number.isFinite(numCorrect) || !Number.isFinite(numTotal) || numTotal <= 0) {
    return null;
  }

  if (numCorrect < 0 || numCorrect > numTotal) {
    return null;
  }

  const wrong = numTotal - numCorrect;

  if (wrong === 0) {
    return 'green';
  }
  if (wrong >= 1 && wrong <= 10) {
    return 'orange';
  }
  return 'cyan';
}

// Alias for callers expecting getScoreColorName
export const getScoreColorName = getScoreColor;

/**
 * Returns the hex colour string (`#00E000`, `#FF9900`, `#00E5FF`) or `null` for a score.
 *
 * @param {number|string|null|undefined} correct
 * @param {number|string|null|undefined} total
 * @returns {string|null}
 */
export function getScoreColorHex(correct, total) {
  const colorName = getScoreColor(correct, total);
  return colorName ? SCORE_COLOR_HEX[colorName] : null;
}

/**
 * Evaluates full UI score feedback for a given correct and total count.
 * Always provides explicit human-readable text (e.g. "3 wrong", "0 wrong")
 * so colour is never the only signal.
 *
 * @param {number|null|undefined} correct
 * @param {number|null|undefined} total
 * @param {object} [options]
 * @returns {{
 *   status: 'perfect' | 'warning' | 'alert' | 'neutral' | 'invalid',
 *   color: 'green' | 'orange' | 'cyan' | null,
 *   hex: string | null,
 *   wrongCount: number | null,
 *   wrongText: string,
 *   badgeClass: string,
 *   colorVar: string,
 *   bgVar: string,
 * }}
 */
export function getScoreFeedback(correct, total, options = {}) {
  if (options && options.isWeeklyTest) {
    return getWeeklyTestScoreFeedback(correct, total, options);
  }

  if (
    correct === null ||
    correct === undefined ||
    correct === '' ||
    total === null ||
    total === undefined ||
    total === ''
  ) {
    return {
      status: 'neutral',
      color: null,
      hex: null,
      wrongCount: null,
      wrongText: '—',
      badgeClass: 'score-tag-neutral',
      colorVar: 'var(--text-dim)',
      bgVar: 'transparent',
    };
  }

  const numCorrect = Number(correct);
  const numTotal = Number(total);

  if (isNaN(numCorrect) || isNaN(numTotal) || numTotal <= 0) {
    return {
      status: 'neutral',
      color: null,
      hex: null,
      wrongCount: null,
      wrongText: '—',
      badgeClass: 'score-tag-neutral',
      colorVar: 'var(--text-dim)',
      bgVar: 'transparent',
    };
  }

  if (numCorrect > numTotal || numCorrect < 0) {
    return {
      status: 'invalid',
      color: null,
      hex: null,
      wrongCount: null,
      wrongText: 'Invalid (> total)',
      badgeClass: 'score-tag-invalid',
      colorVar: 'var(--color-danger)',
      bgVar: 'var(--color-danger-subtle)',
    };
  }

  const wrong = numTotal - numCorrect;
  const color = getScoreColor(numCorrect, numTotal);
  const hex = color ? SCORE_COLOR_HEX[color] : null;

  if (color === 'green') {
    return {
      status: 'perfect',
      color,
      hex,
      wrongCount: 0,
      wrongText: '0 wrong',
      badgeClass: 'score-tag-perfect',
      colorVar: 'var(--color-score-perfect)',
      bgVar: 'var(--color-score-perfect-subtle)',
    };
  }

  if (color === 'orange') {
    return {
      status: 'warning',
      color,
      hex,
      wrongCount: wrong,
      wrongText: `${wrong} wrong`,
      badgeClass: 'score-tag-warning',
      colorVar: 'var(--color-score-warning)',
      bgVar: 'var(--color-score-warning-subtle)',
    };
  }

  return {
    status: 'alert',
    color: 'cyan',
    hex: SCORE_COLOR_HEX.cyan,
    wrongCount: wrong,
    wrongText: `${wrong} wrong`,
    badgeClass: 'score-tag-alert',
    colorVar: 'var(--color-score-alert)',
    bgVar: 'var(--color-score-alert-subtle)',
  };
}

/**
 * Evaluates weekly-test score feedback with authoritative wrong/unanswered distinction.
 *
 * Requirements:
 * - Where authoritative wrong and/or unanswered counts exist, display them separately:
 *   e.g. "0 wrong, 124 unanswered" or "2 wrong, 5 unanswered", or "2 wrong" when unanswered is 0.
 * - Where only correct/total are available, use neutral wording such as:
 *   "124 not correct (includes unanswered)" or "0 wrong" if fully correct.
 * - Do not invent attempted counts when not authoritatively provided.
 *
 * @param {number|object|null|undefined} correctOrItem
 * @param {number|object|null|undefined} [totalOrOptions]
 * @param {object} [maybeOptions]
 * @returns {{
 *   status: 'perfect' | 'warning' | 'alert' | 'neutral' | 'invalid',
 *   color: 'green' | 'orange' | 'cyan' | null,
 *   hex: string | null,
 *   wrongCount: number | null,
 *   unansweredCount: number | null,
 *   notCorrectCount: number | null,
 *   hasAuthoritativeCounts: boolean,
 *   wrongText: string,
 *   badgeClass: string,
 *   colorVar: string,
 *   bgVar: string,
 * }}
 */
export function getWeeklyTestScoreFeedback(correctOrItem, totalOrOptions, maybeOptions) {
  let correct = correctOrItem;
  let total = totalOrOptions;
  let options = maybeOptions;

  if (typeof correctOrItem === 'object' && correctOrItem !== null) {
    options = correctOrItem;
    correct = options.correct;
    total = options.total ?? options.question_count ?? options.questions_total;
  } else if (typeof totalOrOptions === 'object' && totalOrOptions !== null) {
    options = totalOrOptions;
    total = options.total ?? options.question_count ?? options.questions_total;
  }

  options = options || {};

  if (
    correct === null ||
    correct === undefined ||
    correct === '' ||
    total === null ||
    total === undefined ||
    total === ''
  ) {
    return {
      status: 'neutral',
      color: null,
      hex: null,
      wrongCount: null,
      unansweredCount: null,
      notCorrectCount: null,
      hasAuthoritativeCounts: false,
      wrongText: '—',
      badgeClass: 'score-tag-neutral',
      colorVar: 'var(--text-dim)',
      bgVar: 'transparent',
    };
  }

  const numCorrect = Number(correct);
  const numTotal = Number(total);

  if (!Number.isFinite(numCorrect) || !Number.isFinite(numTotal) || numTotal <= 0) {
    return {
      status: 'neutral',
      color: null,
      hex: null,
      wrongCount: null,
      unansweredCount: null,
      notCorrectCount: null,
      hasAuthoritativeCounts: false,
      wrongText: '—',
      badgeClass: 'score-tag-neutral',
      colorVar: 'var(--text-dim)',
      bgVar: 'transparent',
    };
  }

  if (numCorrect > numTotal || numCorrect < 0) {
    return {
      status: 'invalid',
      color: null,
      hex: null,
      wrongCount: null,
      unansweredCount: null,
      notCorrectCount: null,
      hasAuthoritativeCounts: false,
      wrongText: 'Invalid (> total)',
      badgeClass: 'score-tag-invalid',
      colorVar: 'var(--color-danger)',
      bgVar: 'var(--color-danger-subtle)',
    };
  }

  const notCorrect = numTotal - numCorrect;

  const rawWrong = options.wrong ?? options.wrongCount ?? options.wrong_count;
  const rawUnanswered = options.unanswered ?? options.unansweredCount ?? options.unanswered_count;
  const rawAttempted = options.attempted;

  const hasExplicitWrong =
    rawWrong !== null &&
    rawWrong !== undefined &&
    rawWrong !== '' &&
    Number.isFinite(Number(rawWrong));

  const hasExplicitUnanswered =
    rawUnanswered !== null &&
    rawUnanswered !== undefined &&
    rawUnanswered !== '' &&
    Number.isFinite(Number(rawUnanswered));

  const hasExplicitAttempted =
    rawAttempted !== null &&
    rawAttempted !== undefined &&
    rawAttempted !== '' &&
    Number.isFinite(Number(rawAttempted));

  let authoritativeWrong = null;
  let authoritativeUnanswered = null;
  let hasAuthoritativeCounts = false;

  if (hasExplicitWrong && hasExplicitUnanswered) {
    authoritativeWrong = Math.max(0, Math.round(Number(rawWrong)));
    authoritativeUnanswered = Math.max(0, Math.round(Number(rawUnanswered)));
    hasAuthoritativeCounts = true;
  } else if (hasExplicitAttempted) {
    const numAttempted = Math.max(0, Math.min(numTotal, Math.round(Number(rawAttempted))));
    authoritativeWrong = hasExplicitWrong
      ? Math.max(0, Math.round(Number(rawWrong)))
      : Math.max(0, numAttempted - numCorrect);
    authoritativeUnanswered = hasExplicitUnanswered
      ? Math.max(0, Math.round(Number(rawUnanswered)))
      : Math.max(0, numTotal - numAttempted);
    hasAuthoritativeCounts = true;
  } else if (hasExplicitWrong) {
    authoritativeWrong = Math.max(0, Math.round(Number(rawWrong)));
    authoritativeUnanswered = Math.max(0, numTotal - numCorrect - authoritativeWrong);
    hasAuthoritativeCounts = true;
  } else if (hasExplicitUnanswered) {
    authoritativeUnanswered = Math.max(0, Math.round(Number(rawUnanswered)));
    authoritativeWrong = Math.max(0, numTotal - numCorrect - authoritativeUnanswered);
    hasAuthoritativeCounts = true;
  }

  let wrongText;
  if (hasAuthoritativeCounts) {
    if (authoritativeUnanswered > 0) {
      wrongText = `${authoritativeWrong} wrong, ${authoritativeUnanswered} unanswered`;
    } else {
      wrongText = `${authoritativeWrong} wrong`;
    }
  } else {
    if (notCorrect === 0) {
      wrongText = '0 wrong';
    } else {
      wrongText = `${notCorrect} not correct (includes unanswered)`;
    }
  }

  const color = getScoreColor(numCorrect, numTotal);
  const hex = color ? SCORE_COLOR_HEX[color] : null;

  if (color === 'green') {
    return {
      status: 'perfect',
      color,
      hex,
      wrongCount: authoritativeWrong !== null ? authoritativeWrong : 0,
      unansweredCount: authoritativeUnanswered !== null ? authoritativeUnanswered : 0,
      notCorrectCount: notCorrect,
      hasAuthoritativeCounts,
      wrongText,
      badgeClass: 'score-tag-perfect',
      colorVar: 'var(--color-score-perfect)',
      bgVar: 'var(--color-score-perfect-subtle)',
    };
  }

  if (color === 'orange') {
    return {
      status: 'warning',
      color,
      hex,
      wrongCount: authoritativeWrong,
      unansweredCount: authoritativeUnanswered,
      notCorrectCount: notCorrect,
      hasAuthoritativeCounts,
      wrongText,
      badgeClass: 'score-tag-warning',
      colorVar: 'var(--color-score-warning)',
      bgVar: 'var(--color-score-warning-subtle)',
    };
  }

  return {
    status: 'alert',
    color: 'cyan',
    hex: SCORE_COLOR_HEX.cyan,
    wrongCount: authoritativeWrong,
    unansweredCount: authoritativeUnanswered,
    notCorrectCount: notCorrect,
    hasAuthoritativeCounts,
    wrongText,
    badgeClass: 'score-tag-alert',
    colorVar: 'var(--color-score-alert)',
    bgVar: 'var(--color-score-alert-subtle)',
  };
}
