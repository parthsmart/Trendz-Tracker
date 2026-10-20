/**
 * Unit tests for api/_memoriad.js (Phase 9b-1)
 * Run with: node --test tests/memoriadServer.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES,
  isLeapYear,
  daysInMonth,
  isValidGregorianDate,
  weekdayIndex,
  validateMemoriadSettings,
  generateMemoriadSet,
  buildMemoriadStartResponse,
  checkMemoriadPlausibility,
  evaluateMemoriadSubmission,
} from '../api/_memoriad.js';

function createSeededRng(seed = 42) {
  let state = seed >>> 0;
  return function rng(min, max) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const span = max - min + 1;
    return min + (state % span);
  };
}

describe('api/_memoriad.js — Gregorian calendar helpers & weekdayIndex', () => {
  it('correctly identifies Gregorian leap years including century rules', () => {
    assert.equal(isLeapYear(1600), true);
    assert.equal(isLeapYear(2000), true);
    assert.equal(isLeapYear(2024), true);
    assert.equal(isLeapYear(1700), false);
    assert.equal(isLeapYear(1800), false);
    assert.equal(isLeapYear(1900), false);
    assert.equal(isLeapYear(2025), false);
  });

  it('validates Gregorian dates in 1600..2099 and rejects invalid dates', () => {
    assert.equal(isValidGregorianDate(1600, 2, 29), true);
    assert.equal(isValidGregorianDate(1700, 2, 29), false);
    assert.equal(isValidGregorianDate(2000, 2, 29), true);
    assert.equal(isValidGregorianDate(2099, 12, 31), true);
    assert.equal(isValidGregorianDate(1599, 12, 31), false);
    assert.equal(isValidGregorianDate(2100, 1, 1), false);
    assert.equal(isValidGregorianDate(2026, 4, 31), false);
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2023, 2), 28);
  });

  it('computes exact weekday indices (0 = Monday .. 6 = Sunday) for known historical dates', () => {
    // 2000-01-01 was Saturday (5)
    assert.equal(weekdayIndex(2000, 1, 1), 5);
    // 1969-07-20 (Apollo 11 moon landing) was Sunday (6)
    assert.equal(weekdayIndex(1969, 7, 20), 6);
    // 1600-01-01 was Saturday (5)
    assert.equal(weekdayIndex(1600, 1, 1), 5);
    // 2026-10-19 was Monday (0)
    assert.equal(weekdayIndex(2026, 10, 19), 0);
    // 2026-10-20 is Tuesday (1)
    assert.equal(weekdayIndex(2026, 10, 20), 1);
  });
});

describe('api/_memoriad.js — Calendar Dates generator & evaluator', () => {
  it('generates the requested number of distinct valid dates in 1600..2099 across all tiers', () => {
    const rng = createSeededRng(101);
    for (const dateCount of [25, 50, 75, 100, 125]) {
      const set = generateMemoriadSet('calendar', { dates: dateCount, concentration_seconds: 5 }, rng);
      assert.equal(set.questions.length, dateCount);
      assert.equal(set.expected.length, dateCount);

      const seen = new Set();
      for (let i = 0; i < dateCount; i++) {
        const [y, m, d] = set.questions[i];
        assert.equal(isValidGregorianDate(y, m, d), true);
        const key = `${y}-${m}-${d}`;
        assert.equal(seen.has(key), false, `Duplicate date generated: ${key}`);
        seen.add(key);
        assert.equal(set.expected[i], weekdayIndex(y, m, d));
      }
    }
  });

  it('strips expected answers from start response payload', () => {
    const rng = createSeededRng(202);
    const set = generateMemoriadSet('calendar', { dates: 25, concentration_seconds: 5 }, rng);
    const response = buildMemoriadStartResponse({
      session_id: 'sess-cal-1',
      ...set,
    });
    assert.equal(response.session_id, 'sess-cal-1');
    assert.equal(response.module, 'calendar');
    assert.equal(response.questions.length, 25);
    assert.equal('expected' in response, false);
  });

  it('evaluates calendar answers (correct, wrong, and null/blank)', () => {
    const session = {
      module: 'calendar',
      questions: [
        [2000, 1, 1], // 5 (Saturday)
        [1969, 7, 20], // 6 (Sunday)
        [1600, 1, 1], // 5 (Saturday)
      ],
      expected: [5, 6, 5],
    };

    const evalRes = MODULES.calendar.evaluate(session, [5, 2, null]);
    assert.equal(evalRes.questions_total, 3);
    assert.equal(evalRes.attempted, 2);
    assert.equal(evalRes.correct, 1);
    assert.equal(evalRes.score, 1);
    assert.equal(evalRes.detail[0].correct, true);
    assert.equal(evalRes.detail[1].correct, false);
    assert.equal(evalRes.detail[2].attempted, false);
  });
});

describe('api/_memoriad.js — Mental Additions generator & evaluator', () => {
  it('generates 10 questions of ten 10-digit numbers with no leading zero and exact BigInt sum', () => {
    const rng = createSeededRng(303);
    const set = generateMemoriadSet('additions', { concentration_seconds: 10 }, rng);
    assert.equal(set.questions.length, 10);
    assert.equal(set.expected.length, 10);

    for (let q = 0; q < 10; q++) {
      const nums = set.questions[q];
      assert.equal(nums.length, 10);
      let expectedSum = 0n;
      for (const numStr of nums) {
        assert.equal(typeof numStr, 'string');
        assert.equal(numStr.length, 10);
        assert.match(numStr, /^[1-9][0-9]{9}$/);
        expectedSum += BigInt(numStr);
      }
      assert.equal(set.expected[q], expectedSum.toString());
    }
  });

  it('evaluates additions answers including leading zeros, wrong answers, and blank answers', () => {
    const rng = createSeededRng(404);
    const set = generateMemoriadSet('additions', { concentration_seconds: 5 }, rng);
    const answers = new Array(10).fill(null);
    // Question 0: exact match
    answers[0] = set.expected[0];
    // Question 1: match with leading zeros
    answers[1] = `000${set.expected[1]}`;
    // Question 2: wrong digit string
    answers[2] = '12345678901';
    // Question 3: empty string (treated as not attempted)
    answers[3] = '   ';

    const evalRes = MODULES.additions.evaluate(set, answers);
    assert.equal(evalRes.questions_total, 10);
    assert.equal(evalRes.attempted, 3);
    assert.equal(evalRes.correct, 2);
    assert.equal(evalRes.score, 2);
    assert.equal(evalRes.detail[0].correct, true);
    assert.equal(evalRes.detail[1].correct, true);
    assert.equal(evalRes.detail[2].correct, false);
    assert.equal(evalRes.detail[3].attempted, false);
  });
});

describe('api/_memoriad.js — Settings validation & plausibility rules', () => {
  it('validates settings and rejects invalid dates or concentration_seconds', () => {
    assert.equal(validateMemoriadSettings('calendar', { dates: 50, concentration_seconds: 10 }).ok, true);
    assert.equal(validateMemoriadSettings('calendar', { dates: 40 }).ok, false);
    assert.equal(validateMemoriadSettings('additions', { concentration_seconds: -1 }).ok, false);
    assert.equal(validateMemoriadSettings('additions', { concentration_seconds: 121 }).ok, false);
    assert.equal(validateMemoriadSettings('multiplications', {}).ok, false);
  });

  it('rejects implausibly fast submissions (< 0.25s/attempt for calendar, < 3s/attempt for additions)', () => {
    assert.equal(checkMemoriadPlausibility('calendar', 10, 2.49).ok, false);
    assert.equal(checkMemoriadPlausibility('calendar', 10, 2.5).ok, true);
    assert.equal(checkMemoriadPlausibility('additions', 4, 11.99).ok, false);
    assert.equal(checkMemoriadPlausibility('additions', 4, 12.0).ok, true);
    // 0 attempted is always allowed (saved: false)
    assert.equal(checkMemoriadPlausibility('additions', 0, 0.1).ok, true);

    const rng = createSeededRng(505);
    const set = generateMemoriadSet('additions', {}, rng);
    const answers = [set.expected[0], null, null, null, null, null, null, null, null, null];
    const fastCheck = evaluateMemoriadSubmission(set, answers, 1.5);
    assert.equal(fastCheck.ok, false);
    const validCheck = evaluateMemoriadSubmission(set, answers, 4.2);
    assert.equal(validCheck.ok, true);
    assert.equal(validCheck.evaluation.correct, 1);
  });
});
