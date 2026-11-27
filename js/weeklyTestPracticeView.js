/**
 * Trendz Tracker - Weekly Test Practice view helpers (js/weeklyTestPracticeView.js)
 *
 * Pure ES module (no DOM, no network). Practice lets a student retake a closed
 * online weekly test with the same sections, time limits and scoring. Practice
 * is stored apart from official results (migration 37) and never changes the
 * official leaderboard, scores or reports.
 *
 * - `canOfferPractice(test)`: whether to show "Practise" on a test card.
 * - `practiceSectionRows(testSections, run)`: merges the test's sections with
 *   one practice run's progress.
 * - `standingHeadline(standing)`: the "where you'd have stood" sentence.
 */

import { PRACTICE_LABEL } from './weeklyTestRunner.js';

export { PRACTICE_LABEL };

export const PRACTICE_EXPLANATION =
  'Same sections, time limits and scoring as the real test. Practice is only for you: ' +
  'it does not change the official leaderboard, your score or your report.';

/**
 * Practice is offered on online tests whose window has closed.
 *
 * @param {{ type?: string, test_type?: string, state?: string }} test
 * @returns {boolean}
 */
export function canOfferPractice(test) {
  if (!test || typeof test !== 'object') return false;
  const type = String(test.type || test.test_type || 'offline').toLowerCase();
  const state = String(test.state || '').toLowerCase();
  return type === 'online' && state === 'closed';
}

/**
 * Merges the test's sections (position order) with a practice run's progress.
 * Each row says whether the student can start it in this run.
 *
 * @param {Array<object>} testSections  sections from my_weekly_tests()
 * @param {{ sections?: Array<object> }|null} run  one run from my_weekly_test_practice()
 * @returns {Array<object>}
 */
export function practiceSectionRows(testSections, run) {
  const list = Array.isArray(testSections)
    ? [...testSections].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
    : [];
  const progress = new Map(
    (Array.isArray(run?.sections) ? run.sections : []).map((s) => [String(s.section_id), s])
  );
  return list.map((sec) => {
    const sectionId = String(sec.section_id || sec.id || '');
    const kind = String(sec.kind || 'basics').toLowerCase();
    const p = progress.get(sectionId) || null;
    const status = p?.status || null;
    const triesStarted = Number(p?.tries_started) || 0;
    const questionCount = Math.max(1, Number(sec.question_count) || 1);
    const flashOpen = kind === 'flash' && status !== 'submitted' && triesStarted < questionCount;
    const hasScore = p && p.total !== null && p.total !== undefined && Number(p.total) > 0;
    let action = null;
    if (run) {
      if (!status) action = 'start';
      else if (flashOpen) action = 'continue';
    }
    return {
      section: sec,
      section_id: sectionId,
      kind,
      status,
      done: status === 'submitted',
      correct: hasScore ? Number(p.correct) || 0 : null,
      total: hasScore ? Number(p.total) || 0 : null,
      time_seconds: hasScore && p.time_seconds != null ? Number(p.time_seconds) : null,
      action,
    };
  });
}

/**
 * The headline for the hypothetical standing, e.g.
 * "You would have been #2 of 14." plus the official comparison.
 *
 * @param {object|null} standing  weekly_test_practice_standing() result
 * @returns {{ headline: string, detail: string }}
 */
export function standingHeadline(standing) {
  if (!standing || !standing.practice) {
    return { headline: 'Finish a section to see where you would have stood.', detail: '' };
  }
  const p = standing.practice;
  const off = standing.official || {};
  const headline = p.rank
    ? `You would have been #${p.rank} of ${p.out_of}.`
    : 'Your practice score is 0 points, so it would not have been ranked.';
  let detail;
  if (off.took_test) {
    detail = off.rank
      ? `Your official result stays #${off.rank} (${off.points} points).`
      : 'Your official result stays as it was.';
  } else {
    detail = 'You did not take this test, so you have no official rank.';
  }
  if (p.sections_total && p.sections_done < p.sections_total) {
    detail += ` Based on ${p.sections_done} of ${p.sections_total} sections.`;
  }
  return { headline, detail };
}
