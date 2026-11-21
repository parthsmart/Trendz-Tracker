import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCORE_COLOR_HEX,
  getScoreColor,
  getScoreFeedback,
  getWeeklyTestScoreFeedback,
} from '../shared/scoreColors.js';

import {
  getScoreFeedback as getScoreFeedbackReExport,
  getWeeklyTestScoreFeedback as getWeeklyTestScoreFeedbackReExport,
} from '../js/scoreColors.js';

describe('Weekly Test Score Feedback & Summary Wording', () => {
  describe('Re-export consistency', () => {
    it('re-exports getWeeklyTestScoreFeedback from js/scoreColors.js', () => {
      assert.equal(typeof getWeeklyTestScoreFeedbackReExport, 'function');
      assert.equal(getWeeklyTestScoreFeedbackReExport, getWeeklyTestScoreFeedback);
      assert.equal(getScoreFeedbackReExport, getScoreFeedback);
    });
  });

  describe('1. Partial Memoriad Submissions', () => {
    it('displays "0 wrong, 124 unanswered" when authoritative counts exist (1 correct, 0 wrong, 124 unanswered of 125)', () => {
      // Direct explicit counts
      const fb1 = getWeeklyTestScoreFeedback(1, 125, { wrong: 0, unanswered: 124 });
      assert.equal(fb1.wrongText, '0 wrong, 124 unanswered');
      assert.equal(fb1.wrongCount, 0);
      assert.equal(fb1.unansweredCount, 124);
      assert.equal(fb1.hasAuthoritativeCounts, true);
      assert.equal(fb1.status, 'alert');
      assert.equal(fb1.badgeClass, 'score-tag-alert');

      // Via attempted (1 attempted out of 125, 1 correct)
      const fb2 = getWeeklyTestScoreFeedback(1, 125, { attempted: 1 });
      assert.equal(fb2.wrongText, '0 wrong, 124 unanswered');
      assert.equal(fb2.wrongCount, 0);
      assert.equal(fb2.unansweredCount, 124);
      assert.equal(fb2.hasAuthoritativeCounts, true);
    });

    it('displays separate wrong and unanswered counts when partial attempt includes mistakes', () => {
      // 5 attempted of 125, 2 correct, 3 wrong, 120 unanswered
      const fb = getWeeklyTestScoreFeedback(2, 125, { wrong: 3, unanswered: 120 });
      assert.equal(fb.wrongText, '3 wrong, 120 unanswered');
      assert.equal(fb.wrongCount, 3);
      assert.equal(fb.unansweredCount, 120);
      assert.equal(fb.hasAuthoritativeCounts, true);

      // Same via attempted: 5 attempted out of 125, 2 correct -> 3 wrong, 120 unanswered
      const fbViaAttempted = getWeeklyTestScoreFeedback(2, 125, { attempted: 5 });
      assert.equal(fbViaAttempted.wrongText, '3 wrong, 120 unanswered');
      assert.equal(fbViaAttempted.wrongCount, 3);
      assert.equal(fbViaAttempted.unansweredCount, 120);
    });

    it('uses neutral wording "124 not correct (includes unanswered)" when only correct and total are known', () => {
      const fb = getWeeklyTestScoreFeedback(1, 125);
      assert.equal(fb.wrongText, '124 not correct (includes unanswered)');
      assert.equal(fb.wrongCount, null);
      assert.equal(fb.unansweredCount, null);
      assert.equal(fb.notCorrectCount, 124);
      assert.equal(fb.hasAuthoritativeCounts, false);
      assert.equal(fb.status, 'alert');
    });
  });

  describe('2. Genuinely Incorrect Answers', () => {
    it('displays "<n> wrong" without unanswered suffix when all questions are attempted', () => {
      // 20 questions, 18 correct, 20 attempted (2 wrong, 0 unanswered)
      const fb = getWeeklyTestScoreFeedback(18, 20, { attempted: 20 });
      assert.equal(fb.wrongText, '2 wrong');
      assert.equal(fb.wrongCount, 2);
      assert.equal(fb.unansweredCount, 0);
      assert.equal(fb.hasAuthoritativeCounts, true);
      assert.equal(fb.status, 'warning');
      assert.equal(fb.badgeClass, 'score-tag-warning');

      // 20 questions, 19 correct, wrong: 1, unanswered: 0
      const fb1 = getWeeklyTestScoreFeedback(19, 20, { wrong: 1, unanswered: 0 });
      assert.equal(fb1.wrongText, '1 wrong');
      assert.equal(fb1.wrongCount, 1);
      assert.equal(fb1.unansweredCount, 0);
    });

    it('displays both wrong and unanswered when questions were answered wrongly and some left unanswered', () => {
      // 10 questions, 5 correct, 2 wrong, 3 unanswered
      const fb = getWeeklyTestScoreFeedback(5, 10, { wrong: 2, unanswered: 3 });
      assert.equal(fb.wrongText, '2 wrong, 3 unanswered');
      assert.equal(fb.wrongCount, 2);
      assert.equal(fb.unansweredCount, 3);
      assert.equal(fb.hasAuthoritativeCounts, true);
    });
  });

  describe('3. Fully Correct Results', () => {
    it('displays "0 wrong" for 100% correct results even with only correct and total', () => {
      const fb1 = getWeeklyTestScoreFeedback(125, 125);
      assert.equal(fb1.wrongText, '0 wrong');
      assert.equal(fb1.wrongCount, 0);
      assert.equal(fb1.unansweredCount, 0);
      assert.equal(fb1.status, 'perfect');
      assert.equal(fb1.badgeClass, 'score-tag-perfect');
      assert.equal(fb1.color, 'green');

      const fb2 = getWeeklyTestScoreFeedback(20, 20);
      assert.equal(fb2.wrongText, '0 wrong');
      assert.equal(fb2.wrongCount, 0);
      assert.equal(fb2.unansweredCount, 0);
      assert.equal(fb2.color, 'green');
    });

    it('displays "0 wrong" for 100% correct with explicit zero wrong and zero unanswered', () => {
      const fb = getWeeklyTestScoreFeedback(20, 20, { wrong: 0, unanswered: 0 });
      assert.equal(fb.wrongText, '0 wrong');
      assert.equal(fb.wrongCount, 0);
      assert.equal(fb.unansweredCount, 0);
      assert.equal(fb.color, 'green');
    });
  });

  describe('4. Legacy Records (only correct and total available in DB)', () => {
    it('uses neutral phrasing "<n> not correct (includes unanswered)" without inventing attempted counts', () => {
      // 18 of 20 legacy
      const fb1 = getWeeklyTestScoreFeedback(18, 20);
      assert.equal(fb1.wrongText, '2 not correct (includes unanswered)');
      assert.equal(fb1.wrongCount, null);
      assert.equal(fb1.unansweredCount, null);
      assert.equal(fb1.notCorrectCount, 2);
      assert.equal(fb1.hasAuthoritativeCounts, false);
      assert.equal(fb1.status, 'warning');

      // 0 of 5 legacy
      const fb2 = getWeeklyTestScoreFeedback(0, 5);
      assert.equal(fb2.wrongText, '5 not correct (includes unanswered)');
      assert.equal(fb2.wrongCount, null);
      assert.equal(fb2.notCorrectCount, 5);
      assert.equal(fb2.status, 'warning');

      // 9 of 10 legacy
      const fb3 = getWeeklyTestScoreFeedback(9, 10);
      assert.equal(fb3.wrongText, '1 not correct (includes unanswered)');
      assert.equal(fb3.wrongCount, null);
      assert.equal(fb3.notCorrectCount, 1);
      assert.equal(fb3.status, 'warning');
    });

    it('handles legacy object signature without options', () => {
      const secRecord = {
        correct: 14,
        total: 20,
        section_id: 'sec-1',
      };
      const fb = getWeeklyTestScoreFeedback(secRecord);
      assert.equal(fb.wrongText, '6 not correct (includes unanswered)');
      assert.equal(fb.wrongCount, null);
      assert.equal(fb.hasAuthoritativeCounts, false);
    });
  });

  describe('5. Unrelated Practice Displays Remain Unchanged', () => {
    it('preserves classic getScoreFeedback(correct, total) without options', () => {
      // Standard practice: 1 correct of 125 total returns "124 wrong"
      const std1 = getScoreFeedback(1, 125);
      assert.equal(std1.wrongText, '124 wrong');
      assert.equal(std1.wrongCount, 124);

      // Standard practice: 18 correct of 20 total returns "2 wrong"
      const std2 = getScoreFeedback(18, 20);
      assert.equal(std2.wrongText, '2 wrong');
      assert.equal(std2.wrongCount, 2);

      // Standard practice: 20 correct of 20 total returns "0 wrong"
      const std3 = getScoreFeedback(20, 20);
      assert.equal(std3.wrongText, '0 wrong');
      assert.equal(std3.wrongCount, 0);

      // Null / empty total returns '—'
      const std4 = getScoreFeedback(null, 20);
      assert.equal(std4.wrongText, '—');
      assert.equal(std4.color, null);

      // Invalid score (> total) returns 'Invalid (> total)'
      const std5 = getScoreFeedback(25, 20);
      assert.equal(std5.wrongText, 'Invalid (> total)');
      assert.equal(std5.status, 'invalid');
    });

    it('routes to weekly-test formatting when isWeeklyTest flag is set in options', () => {
      const fb = getScoreFeedback(1, 125, { isWeeklyTest: true, attempted: 1 });
      assert.equal(fb.wrongText, '0 wrong, 124 unanswered');
      assert.equal(fb.wrongCount, 0);
      assert.equal(fb.unansweredCount, 124);
    });
  });

  describe('6. Edge Cases and Defensive Boundaries', () => {
    it('returns neutral feedback for missing, invalid, or zero totals', () => {
      assert.equal(getWeeklyTestScoreFeedback(null, null).wrongText, '—');
      assert.equal(getWeeklyTestScoreFeedback('', 10).wrongText, '—');
      assert.equal(getWeeklyTestScoreFeedback(5, 0).wrongText, '—');
      assert.equal(getWeeklyTestScoreFeedback(5, -1).wrongText, '—');
      assert.equal(getWeeklyTestScoreFeedback('abc', 10).wrongText, '—');
    });

    it('returns invalid feedback when correct > total or correct < 0', () => {
      assert.equal(getWeeklyTestScoreFeedback(11, 10).status, 'invalid');
      assert.equal(getWeeklyTestScoreFeedback(11, 10).wrongText, 'Invalid (> total)');
      assert.equal(getWeeklyTestScoreFeedback(-1, 10).status, 'invalid');
    });
  });
});
