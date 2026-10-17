/**
 * Trendz Tracker - Score Colors & Feedback Evaluation
 * 
 * Rules:
 * - all correct (and total > 0) = Green (--color-score-perfect)
 * - 1 to 10 wrong = Orange (--color-score-warning)
 * - more than 10 wrong = Cyan (--color-score-alert)
 * - no data / empty = Neutral (gray)
 * 
 * Always provides explicit human-readable text (e.g. "3 wrong", "0 wrong")
 * so color is never the only signal.
 */

/**
 * Evaluates score feedback for a given correct and total count.
 * @param {number|null|undefined} correct
 * @param {number|null|undefined} total
 * @returns {{
 *   status: 'perfect' | 'warning' | 'alert' | 'neutral' | 'invalid',
 *   wrongCount: number | null,
 *   wrongText: string,
 *   badgeClass: string,
 *   colorVar: string,
 *   bgVar: string,
 * }}
 */
export function getScoreFeedback(correct, total) {
  // Empty or invalid input
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
      wrongCount: null,
      wrongText: 'Invalid (> total)',
      badgeClass: 'score-tag-invalid',
      colorVar: 'var(--color-danger)',
      bgVar: 'var(--color-danger-subtle)',
    };
  }

  const wrong = numTotal - numCorrect;

  if (wrong === 0) {
    return {
      status: 'perfect',
      wrongCount: 0,
      wrongText: '0 wrong',
      badgeClass: 'score-tag-perfect',
      colorVar: 'var(--color-score-perfect)',
      bgVar: 'var(--color-score-perfect-subtle)',
    };
  }

  if (wrong >= 1 && wrong <= 10) {
    return {
      status: 'warning',
      wrongCount: wrong,
      wrongText: `${wrong} wrong`,
      badgeClass: 'score-tag-warning',
      colorVar: 'var(--color-score-warning)',
      bgVar: 'var(--color-score-warning-subtle)',
    };
  }

  // More than 10 wrong
  return {
    status: 'alert',
    wrongCount: wrong,
    wrongText: `${wrong} wrong`,
    badgeClass: 'score-tag-alert',
    colorVar: 'var(--color-score-alert)',
    bgVar: 'var(--color-score-alert-subtle)',
  };
}
