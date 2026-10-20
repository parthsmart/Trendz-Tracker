/**
 * Unit tests for api/_memoriad.js & js/memoriadConfig.js (Phase 9b-1 & Phase 9b-1b)
 * Run with: node --test tests/memoriadServer.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULES,
  MEMORIAD_TIME_LIMITS,
  MEMORIAD_EXPIRY_GRACE_SECONDS,
  getMemoriadTimeLimit,
  computeMemoriadExpiresAtMs,
  computeMemoriadUsedSeconds,
  validateFinishedBy,
  isLeapYear,
  daysInMonth,
  isValidGregorianDate,
  weekdayIndex,
  isPerfectSquare,
  computeSquareRootHalfUp5,
  evaluateSquareRootAnswer,
  validateMemoriadSettings,
  generateMemoriadSet,
  buildMemoriadStartResponse,
  checkMemoriadPlausibility,
  evaluateMemoriadSubmission,
} from '../api/_memoriad.js';
import {
  MEMORIAD_TIME_LIMITS as CLIENT_TIME_LIMITS,
  MEMORIAD_EXPIRY_GRACE_SECONDS as CLIENT_EXPIRY_GRACE_SECONDS,
  getMemoriadTimeLimit as getClientTimeLimit,
} from '../js/memoriadConfig.js';

function createSeededRng(seed = 42) {
  let state = seed >>> 0;
  return function rng(min, max) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const span = max - min + 1;
    return min + (state % span);
  };
}

describe('api/_memoriad.js & js/memoriadConfig.js — Time limit config parity, expiry & cap', () => {
  it('matches time limits between api/_memoriad.js and js/memoriadConfig.js', () => {
    assert.deepEqual(CLIENT_TIME_LIMITS, MEMORIAD_TIME_LIMITS);
    assert.equal(CLIENT_EXPIRY_GRACE_SECONDS, MEMORIAD_EXPIRY_GRACE_SECONDS);
    assert.equal(MEMORIAD_TIME_LIMITS.calendar, 60);
    assert.equal(MEMORIAD_TIME_LIMITS.additions, 600);
    assert.equal(MEMORIAD_TIME_LIMITS.multiplications, 900);
    assert.equal(MEMORIAD_TIME_LIMITS.square_roots, 900);
    assert.equal(MEMORIAD_EXPIRY_GRACE_SECONDS, 30);

    for (const key of ['calendar', 'additions', 'multiplications', 'square_roots']) {
      assert.equal(getClientTimeLimit(key), getMemoriadTimeLimit(key));
    }
  });

  it('computes expires_at = start + concentration_seconds + limit + 30s and caps used_seconds at limit', () => {
    const startMs = 1_700_000_000_000;
    // Calendar: conc 5s + limit 60s + 30s grace = +95,000 ms
    assert.equal(computeMemoriadExpiresAtMs(startMs, 5, 'calendar'), startMs + 95_000);
    // Additions: conc 10s + limit 600s + 30s grace = +640,000 ms
    assert.equal(computeMemoriadExpiresAtMs(startMs, 10, 'additions'), startMs + 640_000);

    // used_seconds never below 0 (e.g. submitted during concentration)
    assert.equal(computeMemoriadUsedSeconds(startMs, startMs + 2_000, 5, 'calendar'), 0);
    // normal elapsed: (40.345s - 5s) = 35.35s
    assert.equal(computeMemoriadUsedSeconds(startMs, startMs + 40_345, 5, 'calendar'), 35.35);
    // capped at limit (60s for calendar, 600s for additions)
    assert.equal(computeMemoriadUsedSeconds(startMs, startMs + 75_000, 5, 'calendar'), 60);
    assert.equal(computeMemoriadUsedSeconds(startMs, startMs + 650_000, 5, 'additions'), 600);
  });

  it('validates finished_by accepting only "finish" or "time_up"', () => {
    assert.deepEqual(validateFinishedBy('finish'), { ok: true, finishedBy: 'finish' });
    assert.deepEqual(validateFinishedBy('time_up'), { ok: true, finishedBy: 'time_up' });
    assert.deepEqual(validateFinishedBy(undefined), { ok: true, finishedBy: 'finish' });
    assert.equal(validateFinishedBy('discard').ok, false);
    assert.equal(validateFinishedBy('other').ok, false);
  });
});

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

describe('api/_memoriad.js — Calendar Dates generator & official two-mistake scoring rule', () => {
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

  it('strips expected answers and includes time_limit_seconds in start response payload', () => {
    const rng = createSeededRng(202);
    const set = generateMemoriadSet('calendar', { dates: 25, concentration_seconds: 5 }, rng);
    const response = buildMemoriadStartResponse({
      session_id: 'sess-cal-1',
      ...set,
    });
    assert.equal(response.session_id, 'sess-cal-1');
    assert.equal(response.module, 'calendar');
    assert.equal(response.questions.length, 25);
    assert.equal(response.time_limit_seconds, 60);
    assert.equal('expected' in response, false);
  });

  it('evaluates Calendar answers in question order using the official two-mistake scoring rule', () => {
    function makeSession(count) {
      return {
        module: 'calendar',
        questions: Array.from({ length: count }, (_, i) => [2000, 1, (i % 28) + 1]),
        expected: new Array(count).fill(5), // 5 = correct, 0 = wrong
      };
    }

    // 1. [C, W, C, C] gives score 3 and correct 3 (1 wrong costs nothing)
    const r1 = MODULES.calendar.evaluate(makeSession(4), [5, 0, 5, 5]);
    assert.equal(r1.score, 3);
    assert.equal(r1.correct, 3);
    assert.equal(r1.wrong, 1);
    assert.equal(r1.attempted, 4);

    // 2. [C, W, C, W, C, C] gives score 2 and correct 4 (from 2nd wrong on, score stops growing)
    const r2 = MODULES.calendar.evaluate(makeSession(6), [5, 0, 5, 0, 5, 5]);
    assert.equal(r2.score, 2);
    assert.equal(r2.correct, 4);
    assert.equal(r2.wrong, 2);
    assert.equal(r2.attempted, 6);

    // 3. [W, W, C] gives score 0 and correct 1
    const r3 = MODULES.calendar.evaluate(makeSession(3), [0, 0, 5]);
    assert.equal(r3.score, 0);
    assert.equal(r3.correct, 1);
    assert.equal(r3.wrong, 2);
    assert.equal(r3.attempted, 3);

    // 4. Skipped questions (null or '') in between change nothing
    const r4 = MODULES.calendar.evaluate(
      makeSession(9),
      [5, null, 0, '', 5, 0, null, 5, 5]
    );
    assert.equal(r4.score, 2);
    assert.equal(r4.correct, 4);
    assert.equal(r4.wrong, 2);
    assert.equal(r4.attempted, 6);
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
    assert.equal(evalRes.wrong, 1);
    assert.equal(evalRes.score, 2);
    assert.equal(evalRes.detail[0].correct, true);
    assert.equal(evalRes.detail[1].correct, true);
    assert.equal(evalRes.detail[2].correct, false);
    assert.equal(evalRes.detail[3].attempted, false);
  });
});

describe('api/_memoriad.js — Mental Multiplications generator & evaluator (Phase 9b-2)', () => {
  it('generates 10 questions of two 8-digit numbers and computes exact BigInt products (including 39951857 * 81044514 = 3237878833962498)', () => {
    assert.equal((39951857n * 81044514n).toString(), '3237878833962498');

    const rng = createSeededRng(707);
    const set = generateMemoriadSet('multiplications', { concentration_seconds: 5 }, rng);
    assert.equal(set.questions.length, 10);
    assert.equal(set.expected.length, 10);

    for (let q = 0; q < 10; q++) {
      const pair = set.questions[q];
      assert.equal(pair.length, 2);
      for (const factor of pair) {
        assert.equal(typeof factor, 'string');
        assert.equal(factor.length, 8);
        assert.match(factor, /^[1-9][0-9]{7}$/);
      }
      const expectedProd = (BigInt(pair[0]) * BigInt(pair[1])).toString();
      assert.equal(set.expected[q], expectedProd);
      assert.ok(expectedProd.length === 15 || expectedProd.length === 16);
    }
  });

  it('evaluates multiplications with leading and trailing zero handling', () => {
    const session = {
      module: 'multiplications',
      questions: [
        ['39951857', '81044514'],
        ['10000000', '10000000'],
        ['25000000', '40000000'],
      ],
      expected: [
        '3237878833962498',
        '100000000000000',
        '1000000000000000',
      ],
    };

    // Q1: leading zero stripped -> correct
    // Q2: missing a trailing zero -> wrong
    // Q3: exact trailing zeros -> correct
    const evalRes = MODULES.multiplications.evaluate(session, [
      '03237878833962498',
      '10000000000000',
      '1000000000000000',
    ]);
    assert.equal(evalRes.attempted, 3);
    assert.equal(evalRes.correct, 2);
    assert.equal(evalRes.score, 2);
    assert.equal(evalRes.detail[0].correct, true);
    assert.equal(evalRes.detail[1].correct, false);
    assert.equal(evalRes.detail[2].correct, true);
  });
});

describe('api/_memoriad.js — Mental Square Roots generator, exact half-up rounding & triangular prefix scoring (Phase 9b-2)', () => {
  it('seeded generator never produces perfect squares and radicands stay 6-digit integers (100000..999999)', () => {
    // Also test a rigged RNG that first emits perfect squares (e.g. 100000000 is out of range, 102400 = 320^2, 250000 = 500^2)
    const squareCandidates = [102400, 250000, 360000, 490000, 640000, 810000];
    let idx = 0;
    const baseRng = createSeededRng(808);
    const customRng = (min, max) => {
      if (idx < squareCandidates.length) {
        return squareCandidates[idx++];
      }
      return baseRng(min, max);
    };

    const set = generateMemoriadSet('square_roots', { concentration_seconds: 5 }, customRng);
    assert.equal(set.questions.length, 10);
    assert.equal(set.expected.length, 10);

    const unique = new Set(set.questions);
    assert.equal(unique.size, 10);

    for (let i = 0; i < 10; i++) {
      const n = set.questions[i];
      assert.equal(Number.isInteger(n), true);
      assert.ok(n >= 100000 && n <= 999999, `Out of 6-digit bounds: ${n}`);
      assert.equal(isPerfectSquare(n), false, `Generated perfect square: ${n}`);
      assert.match(set.expected[i], /^[0-9]{3}\.[0-9]{5}$/);
    }
  });

  it('rounds square roots half-up to 5 decimals against known values', () => {
    assert.equal(computeSquareRootHalfUp5(258524), '508.45255');
    assert.equal(computeSquareRootHalfUp5(850772), '922.37303'); // rounded up, not cut off
    assert.equal(computeSquareRootHalfUp5(115456), '339.78817');
    assert.equal(computeSquareRootHalfUp5(457832), '676.63284');
    assert.equal(computeSquareRootHalfUp5(453077), '673.10995');
  });

  it('computes k leading matching digits and triangular points k*(k+1)/2, stopping at first mistake or blank', () => {
    // 1. Expected 673.10995 with answer 675 gives k = 2 and 3 points
    const e1 = evaluateSquareRootAnswer('673.10995', '675');
    assert.equal(e1.attempted, true);
    assert.equal(e1.correct, false);
    assert.equal(e1.correct_digits, 2);
    assert.equal(e1.points, 3);

    // 2. First 6 digits right and last two wrong gives k = 6 and 21 points
    const e2 = evaluateSquareRootAnswer('673.10995', '67310900');
    assert.equal(e2.correct_digits, 6);
    assert.equal(e2.points, 21);
    assert.equal(e2.correct, false);

    // 3. All eight right gives k = 8 and 36 points (fully correct)
    const e3 = evaluateSquareRootAnswer('673.10995', '67310995');
    assert.equal(e3.correct_digits, 8);
    assert.equal(e3.points, 36);
    assert.equal(e3.correct, true);

    // 4. Wrong third digit with later digits right still gives k = 2 and 3 points
    const e4 = evaluateSquareRootAnswer('673.10995', '675.10995');
    assert.equal(e4.correct_digits, 2);
    assert.equal(e4.points, 3);
    assert.equal(e4.correct, false);

    // 5. Blank gives 0
    const e5 = evaluateSquareRootAnswer('673.10995', '');
    assert.equal(e5.attempted, false);
    assert.equal(e5.correct_digits, 0);
    assert.equal(e5.points, 0);

    // 6. Leading and trailing zero handling in square roots
    const trailingZeroRoot = evaluateSquareRootAnswer('500.12340', '5001234_');
    assert.equal(trailingZeroRoot.correct_digits, 7);
    assert.equal(trailingZeroRoot.points, 28);
    const trailingZeroExact = evaluateSquareRootAnswer('500.12340', '50012340');
    assert.equal(trailingZeroExact.correct_digits, 8);
    assert.equal(trailingZeroExact.points, 36);
    const leadingZeroWrong = evaluateSquareRootAnswer('673.10995', '06731099');
    assert.equal(leadingZeroWrong.correct_digits, 0);
    assert.equal(leadingZeroWrong.points, 0);
  });

  it('aggregates score, correct (k === 8), attempted, and digits_total across 10 square root questions', () => {
    const session = {
      module: 'square_roots',
      questions: [258524, 850772, 115456, 457832, 453077],
      expected: ['508.45255', '922.37303', '339.78817', '676.63284', '673.10995'],
    };
    const answers = [
      '50845255', // k = 8 -> 36 pts (fully correct)
      '922373__', // k = 6 -> 21 pts
      '339_____', // k = 3 -> 6 pts
      null, // not attempted -> 0 pts
      '675_____', // k = 2 -> 3 pts
    ];
    const evalRes = MODULES.square_roots.evaluate(session, answers);
    assert.equal(evalRes.attempted, 4);
    assert.equal(evalRes.correct, 1); // only Q1 has k === 8
    assert.equal(evalRes.score, 36 + 21 + 6 + 3); // 66
    assert.equal(evalRes.digits_total, 8 + 6 + 3 + 2); // 19
    assert.equal(evalRes.detail[0].points, 36);
    assert.equal(evalRes.detail[1].correct_digits, 6);
    assert.equal(evalRes.detail[4].given_display, '675');
  });
});

describe('api/_memoriad.js — Settings validation & plausibility rules', () => {
  it('validates settings for all 4 modules and rejects invalid dates, concentration_seconds, or unknown modules', () => {
    assert.equal(validateMemoriadSettings('calendar', { dates: 50, concentration_seconds: 10 }).ok, true);
    assert.equal(validateMemoriadSettings('calendar', { dates: 40 }).ok, false);
    assert.equal(validateMemoriadSettings('additions', { concentration_seconds: -1 }).ok, false);
    assert.equal(validateMemoriadSettings('additions', { concentration_seconds: 121 }).ok, false);
    assert.equal(validateMemoriadSettings('multiplications', { concentration_seconds: 5 }).ok, true);
    assert.equal(validateMemoriadSettings('square_roots', { concentration_seconds: 5 }).ok, true);
    assert.equal(validateMemoriadSettings('unknown_module', {}).ok, false);
  });

  it('rejects implausibly fast submissions (< 0.25s/attempt calendar, < 3s/attempt additions, < 5s/attempt multiplications & square_roots)', () => {
    assert.equal(checkMemoriadPlausibility('calendar', 10, 2.49).ok, false);
    assert.equal(checkMemoriadPlausibility('calendar', 10, 2.5).ok, true);
    assert.equal(checkMemoriadPlausibility('additions', 4, 11.99).ok, false);
    assert.equal(checkMemoriadPlausibility('additions', 4, 12.0).ok, true);
    assert.equal(checkMemoriadPlausibility('multiplications', 4, 19.99).ok, false);
    assert.equal(checkMemoriadPlausibility('multiplications', 4, 20.0).ok, true);
    assert.equal(checkMemoriadPlausibility('square_roots', 6, 29.99).ok, false);
    assert.equal(checkMemoriadPlausibility('square_roots', 6, 30.0).ok, true);
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
