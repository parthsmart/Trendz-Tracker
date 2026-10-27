/**
 * Trendz Tracker - Score Colors & Feedback Evaluation (js/scoreColors.js)
 *
 * Re-exports the shared pure score colour rule from `../shared/scoreColors.js`
 * so the website and serverless endpoints execute identical logic.
 */

export {
  SCORE_COLOR_HEX,
  SCORE_COLOR_RGB,
  getScoreColor,
  getScoreColorName,
  getScoreColorHex,
  getScoreFeedback,
} from '../shared/scoreColors.js';
