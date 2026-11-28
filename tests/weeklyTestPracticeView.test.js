import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runnerLink,
  parseTestRunnerQuery,
  parsePracticeRunId,
  testSectionStartBody,
  testSavedText,
  weeklyTestBackHref,
  PRACTICE_LABEL,
} from '../js/weeklyTestRunner.js';
import {
  canOfferPractice,
  practiceSectionRows,
  standingHeadline,
} from '../js/weeklyTestPracticeView.js';

describe('weekly test practice: runner helpers', () => {
  it('adds the practice run id to runner links only when given', () => {
    assert.equal(
      runnerLink({ section_id: 's1', kind: 'flash' }, 't1', 'run-9'),
      '/pages/flash.html?test=t1&section=s1&practice=run-9'
    );
    assert.equal(runnerLink({ section_id: 's1', kind: 'flash' }, 't1'), '/pages/flash.html?test=t1&section=s1');
  });

  it('reads the run id without changing the official runner query', () => {
    const q = '?test=t1&section=s1&practice=run-9';
    assert.equal(parsePracticeRunId(q), 'run-9');
    assert.equal(parsePracticeRunId('?test=t1&section=s1'), null);
    assert.deepEqual(parseTestRunnerQuery(q), { isTestMode: true, testId: 't1', sectionId: 's1' });
  });

  it('builds official and practice start bodies', () => {
    assert.deepEqual(testSectionStartBody('t1', 's1'), { action: 'start', test_id: 't1', section_id: 's1' });
    assert.deepEqual(testSectionStartBody('t1', 's1', 'run-9'), {
      action: 'practice_start',
      test_id: 't1',
      section_id: 's1',
      run_id: 'run-9',
    });
  });

  it('labels saved text and back links for practice', () => {
    assert.equal(testSavedText('Week 4'), 'Saved as part of Week 4');
    assert.match(testSavedText('Week 4', 'run-9'), /^Practice saved for Week 4\. Not official/);
    assert.equal(weeklyTestBackHref('t1'), '/pages/weekly-test.html');
    assert.equal(weeklyTestBackHref('t1', 'run-9'), '/pages/weekly-test.html?practice_test=t1');
    assert.equal(PRACTICE_LABEL, 'Practice — not official');
  });
});

describe('weekly test practice: view helpers', () => {
  it('offers practice only on closed online tests', () => {
    assert.equal(canOfferPractice({ type: 'online', state: 'closed' }), true);
    assert.equal(canOfferPractice({ type: 'online', state: 'open' }), false);
    assert.equal(canOfferPractice({ type: 'online', state: 'upcoming' }), false);
    assert.equal(canOfferPractice({ type: 'offline', state: 'past' }), false);
    assert.equal(canOfferPractice(null), false);
  });

  it('merges sections with run progress', () => {
    const sections = [
      { section_id: 'b', kind: 'flash', position: 2, question_count: 3 },
      { section_id: 'a', kind: 'basics', position: 1 },
      { section_id: 'c', kind: 'elements', position: 3 },
    ];
    const run = {
      run_id: 'r1',
      sections: [
        { section_id: 'a', status: 'submitted', correct: 8, total: 10, time_seconds: 60 },
        { section_id: 'b', status: 'started', tries_started: 1, correct: 1, total: 3, time_seconds: 4 },
      ],
    };
    const rows = practiceSectionRows(sections, run);
    assert.deepEqual(rows.map((r) => r.section_id), ['a', 'b', 'c']);
    assert.equal(rows[0].action, null);
    assert.equal(rows[0].done, true);
    assert.equal(rows[0].correct, 8);
    assert.equal(rows[1].action, 'continue');
    assert.equal(rows[2].action, 'start');
    assert.ok(practiceSectionRows(sections, null).every((r) => r.action === null));
  });

  it('writes the standing headline', () => {
    const missed = standingHeadline({
      practice: { rank: 2, out_of: 14, sections_done: 3, sections_total: 3 },
      official: { took_test: false },
    });
    assert.equal(missed.headline, 'You would have been #2 of 14.');
    assert.match(missed.detail, /no official rank/);

    const retake = standingHeadline({
      practice: { rank: 1, out_of: 5, sections_done: 1, sections_total: 2 },
      official: { took_test: true, rank: 3, points: 12 },
    });
    assert.match(retake.detail, /official result stays #3 \(12 points\)/);
    assert.match(retake.detail, /Based on 1 of 2 sections/);

    assert.match(standingHeadline(null).headline, /Finish a section/);
  });
});
