import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory localStorage & localhost window polyfill for Node.js tests exercising DemoDB
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: {
      hostname: 'localhost',
      search: '?demo=1',
    },
  };
}
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem(k) {
      return store.has(k) ? store.get(k) : null;
    },
    setItem(k, v) {
      store.set(String(k), String(v));
    },
    removeItem(k) {
      store.delete(String(k));
    },
    clear() {
      store.clear();
    },
  };
}

import {
  isWeeklyTestSession,
  computeFlashMinSeconds,
  computeFlashExpirySeconds,
  getMemoriadTestFixedSettings,
  applyFlashTry,
  finalScore,
} from '../api/_weeklyTest.js';
import {
  START_SECTION_CONFIRM_TEXT,
  RUNNER_EXIT_CONFIRM_TEXT,
  runnerLink,
  flashProgressText,
  parseTestRunnerQuery,
} from '../js/weeklyTestRunner.js';
import { DemoDB } from '../js/demoDb.js';

describe('Phase 16b — Online Weekly Test Sections (Elements, Flash Anzan & Memoriad)', () => {
  describe('applyFlashTry(attempt, section, isCorrect, seconds)', () => {
    it('increments tries_started up to question_count and updates tries_correct only when correct', () => {
      const section = { question_count: 3 };
      const initial = {
        tries_started: 1,
        tries_correct: 0,
        seconds_used: 0,
        status: 'started',
      };

      // Try 1: correct answer in 12s
      const after1 = applyFlashTry(initial, section, true, 12);
      assert.equal(after1.tries_started, 1);
      assert.equal(after1.tries_correct, 1);
      assert.equal(after1.seconds_used, 12);
      assert.equal(after1.done, false);
      assert.equal(after1.status, 'started');
      assert.deepEqual(after1.score_row, {
        correct: 1,
        total: 3,
        time_seconds: 12,
      });

      // Simulate start of try 2 (tries_started incremented to 2 on start)
      const before2 = {
        ...after1,
        tries_started: 2,
      };
      // Try 2: wrong answer in 10s
      const after2 = applyFlashTry(before2, section, false, 10);
      assert.equal(after2.tries_started, 2);
      assert.equal(after2.tries_correct, 1);
      assert.equal(after2.seconds_used, 22);
      assert.equal(after2.done, false);
      assert.equal(after2.status, 'started');
      assert.deepEqual(after2.score_row, {
        correct: 1,
        total: 3,
        time_seconds: 22,
      });

      // Simulate start of try 3 (tries_started incremented to 3 on start)
      const before3 = {
        ...after2,
        tries_started: 3,
      };
      // Try 3: correct answer in 14s -> marks done = true and status = 'submitted'
      const after3 = applyFlashTry(before3, section, true, 14);
      assert.equal(after3.tries_started, 3);
      assert.equal(after3.tries_correct, 2);
      assert.equal(after3.seconds_used, 36);
      assert.equal(after3.done, true);
      assert.equal(after3.status, 'submitted');
      assert.deepEqual(after3.score_row, {
        correct: 2,
        total: 3,
        time_seconds: 36,
      });
    });

    it('keeps total = question_count even when a student leaves partway through', () => {
      const partial = applyFlashTry(
        {
          tries_started: 1,
          tries_correct: 1,
          seconds_used: 0,
          status: 'started',
        },
        { question_count: 5 },
        false,
        9
      );
      assert.equal(partial.done, false);
      assert.equal(partial.score_row.correct, 1);
      assert.equal(partial.score_row.total, 5);
      assert.equal(partial.score_row.time_seconds, 9);
    });

    it('clamps tries_started at question_count and marks done when tries_started reaches question_count', () => {
      const capped = applyFlashTry(
        {
          tries_started: 4,
          tries_correct: 2,
          seconds_used: 30,
          status: 'started',
        },
        { question_count: 3 },
        true,
        10
      );
      assert.equal(capped.tries_started, 3);
      assert.equal(capped.tries_correct, 3);
      assert.equal(capped.done, true);
      assert.equal(capped.status, 'submitted');
    });
  });

  describe('finalScore(kind, evaluation)', () => {
    it('converts basics, elements, memoriad, and flash results into {correct, total, time_seconds, shouldSave}', () => {
      // Basics
      assert.deepEqual(
        finalScore('basics', { correct: 34, attempted: 36, time_seconds: 60 }),
        { correct: 34, total: 36, time_seconds: 60, shouldSave: true }
      );

      // Elements
      assert.deepEqual(
        finalScore('elements', { correct: 19, attempted: 20, time_seconds: 48 }),
        { correct: 19, total: 20, time_seconds: 48, shouldSave: true }
      );

      // Memoriad: total is questions_total (the full module count, e.g. 10 or 125)
      assert.deepEqual(
        finalScore('memoriad', {
          correct: 8,
          attempted: 9,
          questions_total: 10,
          time_seconds: 145,
        }),
        { correct: 8, total: 10, time_seconds: 145, shouldSave: true }
      );

      // Flash
      assert.deepEqual(
        finalScore('flash', { tries_correct: 4, question_count: 5, seconds_used: 55 }),
        { correct: 4, total: 5, time_seconds: 55, shouldSave: true }
      );
    });
  });

  describe('runnerLink and flashProgressText (js/weeklyTestRunner.js)', () => {
    it('builds the expected runner URL for basics, elements, flash, and memoriad', () => {
      assert.equal(
        runnerLink({ section_id: 'sec-b1', kind: 'basics' }, 'wt-101'),
        '/pages/basics-practice.html?test=wt-101&section=sec-b1'
      );
      assert.equal(
        runnerLink({ section_id: 'sec-e1', kind: 'elements' }, 'wt-101'),
        '/pages/element-drill.html?test=wt-101&section=sec-e1'
      );
      assert.equal(
        runnerLink({ section_id: 'sec-f1', kind: 'flash' }, 'wt-101'),
        '/pages/flash.html?test=wt-101&section=sec-f1'
      );
      assert.equal(
        runnerLink({ section_id: 'sec-m1', kind: 'memoriad' }, 'wt-101'),
        '/pages/memoriad-play.html?test=wt-101&section=sec-m1'
      );
    });

    it('formats flashProgressText as "Try <tryNo> of <questionCount>"', () => {
      assert.equal(flashProgressText(1, 5), 'Try 1 of 5');
      assert.equal(flashProgressText(3, 3), 'Try 3 of 3');
    });

    it('parses ?test=<id>&section=<id> via parseTestRunnerQuery', () => {
      assert.deepEqual(
        parseTestRunnerQuery('?test=wt-online-open-1&section=wts-2'),
        { isTestMode: true, testId: 'wt-online-open-1', sectionId: 'wts-2' }
      );
      assert.deepEqual(
        parseTestRunnerQuery('?drill=day_codes'),
        { isTestMode: false, testId: null, sectionId: null }
      );
    });

    it('exports exact confirmation strings for starting and leaving a weekly test section', () => {
      assert.equal(
        START_SECTION_CONFIRM_TEXT,
        'You can take this section only once. If you leave the page, the section ends.'
      );
      assert.equal(
        RUNNER_EXIT_CONFIRM_TEXT,
        'This section can be taken only once. Leaving now ends it.'
      );
    });
  });

  describe('isWeeklyTestSession and timing helpers (api/_weeklyTest.js)', () => {
    it('identifies weekly_test drill_sessions and separates them from practice sessions', () => {
      assert.equal(
        isWeeklyTestSession({ settings: { kind: 'weekly_test', test_id: 't1', section_id: 's1' } }),
        true
      );
      assert.equal(
        isWeeklyTestSession({ settings: { kind: 'basics', category_id: 'c1' } }),
        false
      );
      assert.equal(isWeeklyTestSession(null), false);
    });

    it('computes flash minimum stream time and 600s expiry buffer', () => {
      // 10 numbers * 500ms = 5s stream -> minSeconds = max(1, floor(5 * 0.8)) = 4s
      assert.equal(computeFlashMinSeconds(10, 500), 4);
      // 5s stream + 600s = 605s
      assert.equal(computeFlashExpirySeconds(10, 500), 605);
    });

    it('returns fixed competition defaults for Memoriad weekly test sections', () => {
      const cal = getMemoriadTestFixedSettings('calendar');
      assert.equal(cal.dates, 125);
      assert.equal(cal.concentration_seconds, 5);
      assert.equal(cal.timer_shown, true);

      const add = getMemoriadTestFixedSettings('additions');
      assert.equal(add.highlight_columns, 1);
      assert.equal(add.typing_direction, 'rtl');
    });
  });

  describe('Isolation: Weekly Test sections write ONLY to weekly_test_scores / weekly_test_attempts', () => {
    beforeEach(() => {
      globalThis.localStorage.clear();
    });

    it('never writes to activity_results or results when running elements, flash, or memoriad weekly test sections', () => {
      const resultsBefore = DemoDB.getResults().length;
      const activityBefore = DemoDB.getActivityResults('usr-101').length;

      // 1. Start & submit an Elements weekly test section (wsec-4 on wkt-online-1)
      const elemStart = DemoDB.mockStartWeeklyTestSection(
        'usr-101',
        'wkt-online-1',
        null,
        'wsec-4'
      );
      assert.equal(elemStart.kind, 'elements');
      const elemSub = DemoDB.mockSubmitWeeklyTestSection(
        'usr-101',
        elemStart.session_id,
        elemStart.questions.map(() => '0')
      );
      assert.equal(elemSub.kind, 'elements');
      assert.equal(typeof elemSub.correct, 'number');

      // 2. Start & submit all tries of a Flash weekly test section (wsec-3 on wkt-online-1, 5 tries)
      for (let t = 1; t <= 5; t++) {
        const flashStart = DemoDB.mockStartWeeklyTestSection(
          'usr-101',
          'wkt-online-1',
          null,
          'wsec-3'
        );
        assert.equal(flashStart.kind, 'flash');
        assert.equal(flashStart.try_no, t);
        const flashSub = DemoDB.mockSubmitWeeklyTestSection(
          'usr-101',
          flashStart.session_id,
          '999'
        );
        assert.equal(flashSub.kind, 'flash');
        assert.equal(flashSub.done, t === 5);
      }

      // 3. Start & submit a Memoriad weekly test section (wsec-5 on wkt-online-1)
      const memStart = DemoDB.mockStartWeeklyTestSection(
        'usr-101',
        'wkt-online-1',
        null,
        'wsec-5'
      );
      assert.equal(memStart.kind, 'memoriad');
      const memSub = DemoDB.mockSubmitWeeklyTestSection(
        'usr-101',
        memStart.session_id,
        memStart.questions.map(() => '0')
      );
      assert.equal(memSub.kind, 'memoriad');

      // Verify neither results nor activity_results changed
      assert.equal(DemoDB.getResults().length, resultsBefore);
      assert.equal(DemoDB.getActivityResults('usr-101').length, activityBefore);

      // Reset sections for clean state
      DemoDB.resetWeeklyTestSectionAttempt('wkt-online-1', 'usr-101', null, 'wsec-4');
      DemoDB.resetWeeklyTestSectionAttempt('wkt-online-1', 'usr-101', null, 'wsec-3');
      DemoDB.resetWeeklyTestSectionAttempt('wkt-online-1', 'usr-101', null, 'wsec-5');
    });
  });
});
