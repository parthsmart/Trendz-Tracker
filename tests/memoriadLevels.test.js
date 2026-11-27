/**
 * Memoriad practice levels: multiplication 3d–10d, division 4d÷2d–10d÷5d,
 * square roots 4–10 digits, official digit scoring, time limits and points.
 * Run with: node --test tests/memoriadLevels.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MULTIPLICATION_TIME_BY_DIGITS,
  SQUARE_ROOT_TIME_BY_DIGITS,
  DIVISION_TIME_BY_DIVIDEND,
  normalizeMultiplicationDigits,
  normalizeSquareRootDigits,
  isValidDivisionLevel,
  normalizeDivisionLevel,
  normalizeLayout,
  squareRootIntegerDigits,
  getMemoriadLevelTimeLimit,
  generateMultiplicationSet,
  generateDivisionSet,
  generateSquareRootSet,
  formatSquareRoot,
  evaluateSquareRootAnswerOfficial,
  triangularPoints,
  computeOfficialPoints,
} from '../js/memoriadGenerators.js';
import { generateMemoriadSet, evaluateMemoriadSubmission, getMemoriadTimeLimit } from '../api/_memoriad.js';

function createSeededRng(seed = 7) {
  let state = seed >>> 0;
  return function rng(min, max) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    const span = max - min + 1;
    return min + (state % span);
  };
}

describe('level normalisation', () => {
  it('keeps multiplication at 3–10 digits and square roots at 4–10 digits (out of range → default)', () => {
    assert.equal(normalizeMultiplicationDigits(2), 8);
    assert.equal(normalizeMultiplicationDigits(3), 3);
    assert.equal(normalizeMultiplicationDigits(10), 10);
    assert.equal(normalizeMultiplicationDigits(11), 8);
    assert.equal(normalizeMultiplicationDigits('abc'), 8);
    assert.equal(normalizeSquareRootDigits(3), 6);
    assert.equal(normalizeSquareRootDigits(4), 4);
    assert.equal(normalizeSquareRootDigits(10), 10);
    assert.equal(normalizeSquareRootDigits(undefined), 6);
  });

  it('accepts division levels from 4d÷2d to 10d÷5d with the divisor at least 2 digits shorter', () => {
    assert.equal(isValidDivisionLevel(4, 2), true);
    assert.equal(isValidDivisionLevel(10, 5), true);
    assert.equal(isValidDivisionLevel(7, 5), true);
    assert.equal(isValidDivisionLevel(4, 3), false);
    assert.equal(isValidDivisionLevel(3, 1), false);
    assert.equal(isValidDivisionLevel(10, 6), false);
    assert.equal(isValidDivisionLevel(6, 5), false);
    assert.deepEqual(normalizeDivisionLevel(5, 4), { dividend_digits: 10, divisor_digits: 5 });
  });

  it('normalises layout to vertical or horizontal', () => {
    assert.equal(normalizeLayout('horizontal'), 'horizontal');
    assert.equal(normalizeLayout('side_by_side'), 'horizontal');
    assert.equal(normalizeLayout('stacked'), 'vertical');
    assert.equal(normalizeLayout(null), 'vertical');
  });
});

describe('official time limits', () => {
  it('uses the published Memoriad times for the official levels', () => {
    assert.equal(getMemoriadLevelTimeLimit('multiplications', { digits: 5 }), 5 * 60);
    assert.equal(getMemoriadLevelTimeLimit('multiplications', { digits: 8 }), 12 * 60);
    assert.equal(getMemoriadLevelTimeLimit('division', { dividend_digits: 10, divisor_digits: 5 }), 6 * 60);
    assert.equal(getMemoriadLevelTimeLimit('square_roots', { digits: 6 }), 15 * 60);
    assert.equal(getMemoriadLevelTimeLimit('square_roots', { digits: 8 }), 18 * 60);
    assert.equal(getMemoriadLevelTimeLimit('square_roots', { digits: 10 }), 22 * 60);
    assert.equal(getMemoriadLevelTimeLimit('calendar', {}), null);
  });

  it('has a limit for every selectable level and grows with difficulty', () => {
    for (let d = 3; d <= 10; d++) assert.ok(MULTIPLICATION_TIME_BY_DIGITS[d] > 0, `mult ${d}`);
    for (let d = 4; d <= 10; d++) assert.ok(SQUARE_ROOT_TIME_BY_DIGITS[d] > 0, `sqrt ${d}`);
    for (let d = 4; d <= 10; d++) assert.ok(DIVISION_TIME_BY_DIVIDEND[d] > 0, `div ${d}`);
    for (let d = 4; d <= 10; d++) {
      assert.ok(MULTIPLICATION_TIME_BY_DIGITS[d] > MULTIPLICATION_TIME_BY_DIGITS[d - 1]);
    }
  });

  it('server time limit follows the chosen level', () => {
    assert.equal(getMemoriadTimeLimit('multiplications', { digits: 10 }), MULTIPLICATION_TIME_BY_DIGITS[10]);
    assert.equal(getMemoriadTimeLimit('division', { dividend_digits: 6, divisor_digits: 3 }), DIVISION_TIME_BY_DIVIDEND[6]);
    assert.equal(getMemoriadTimeLimit('square_roots', { digits: 4 }), SQUARE_ROOT_TIME_BY_DIGITS[4]);
  });
});

describe('generators', () => {
  it('multiplication factors have exactly the chosen digit count and exact BigInt products', () => {
    const rng = createSeededRng(11);
    for (let d = 3; d <= 10; d++) {
      const { questions, expected } = generateMultiplicationSet(rng, d);
      assert.equal(questions.length, 10);
      questions.forEach(([a, b], i) => {
        assert.equal(a.length, d);
        assert.equal(b.length, d);
        assert.equal(expected[i], (BigInt(a) * BigInt(b)).toString());
      });
    }
  });

  it('division questions divide exactly at every valid level', () => {
    const rng = createSeededRng(23);
    for (let D = 4; D <= 10; D++) {
      for (let d = 2; d <= Math.min(5, D - 2); d++) {
        const { questions, expected } = generateDivisionSet(rng, D, d);
        assert.equal(questions.length, 10, `${D}/${d}`);
        assert.equal(new Set(questions.map((q) => q.join('/'))).size, 10);
        questions.forEach(([dividend, divisor], i) => {
          assert.equal(dividend.length, D);
          assert.equal(divisor.length, d);
          assert.notEqual(Number(divisor) % 10, 0);
          assert.equal(BigInt(dividend) % BigInt(divisor), 0n);
          assert.equal(expected[i], (BigInt(dividend) / BigInt(divisor)).toString());
          assert.ok(expected[i].length >= 2);
        });
      }
    }
  });

  it('square-root radicands have the chosen digit count, are never perfect squares, and answers have 5 decimals', () => {
    const rng = createSeededRng(31);
    for (let D = 4; D <= 10; D++) {
      const I = squareRootIntegerDigits(D);
      const { questions, expected } = generateSquareRootSet(rng, D);
      assert.equal(questions.length, 10);
      questions.forEach((n, i) => {
        assert.equal(String(n).length, D);
        const r = Math.floor(Math.sqrt(n));
        assert.notEqual(r * r, n);
        assert.match(expected[i], new RegExp(`^\\d{${I}}\\.\\d{5}$`));
        assert.ok(Math.abs(Number(expected[i]) - Math.sqrt(n)) <= 0.000005 + 1e-9);
      });
    }
  });

  it('formats square roots with half-up rounding at 5 decimals', () => {
    assert.equal(formatSquareRoot(2000000, 4), '1414.21356');
    assert.equal(formatSquareRoot(1234, 2), '35.12834');
  });
});

describe('official square-root scoring', () => {
  it('counts all digits for an exact answer and uses triangular points', () => {
    const res = evaluateSquareRootAnswerOfficial('1414.21356', '1414.21356');
    assert.equal(res.correct, true);
    assert.equal(res.correct_digits, 9);
    assert.equal(res.max_digits, 9);
    assert.equal(res.points, triangularPoints(9));
  });

  it('a last-digit slip on a 10-digit radicand keeps 9 of 10 digits', () => {
    const res = evaluateSquareRootAnswerOfficial('31622.77660', '31622.77661');
    assert.equal(res.correct, false);
    assert.equal(res.correct_digits, 9);
    assert.equal(res.points, 45);
  });

  it('answers within the tolerance of a digit still count it (official ± rule)', () => {
    // 766.32043 vs 766.32047: |A-B| = 0.00004 <= 0.00005 → 7 digits, not 8.
    const res = evaluateSquareRootAnswerOfficial('766.32043', '766.32047');
    assert.equal(res.correct_digits, 7);
  });

  it('applies the nines exception near a power of ten', () => {
    // Correct 999.70000, answer 999.6xxxx starts with three nines → at least 3 digits.
    const res = evaluateSquareRootAnswerOfficial('999.70000', '999.60000');
    assert.ok(res.correct_digits >= 3);
  });

  it('unattempted answers score nothing', () => {
    const res = evaluateSquareRootAnswerOfficial('35.12834', '');
    assert.equal(res.attempted, false);
    assert.equal(res.points, 0);
  });
});

describe('official points', () => {
  it('rewards finishing every task early with score × T ÷ t', () => {
    assert.equal(computeOfficialPoints(9, 360, 180, true), 18);
  });

  it('uses the full time when tasks remain or time ran out', () => {
    assert.equal(computeOfficialPoints(9, 360, 180, false), 9);
    assert.equal(computeOfficialPoints(9, 360, 400, true), 9);
    assert.equal(computeOfficialPoints(0, 360, 100, true), 0);
  });
});

describe('server sessions for the new levels', () => {
  it('generates and grades a 10d ÷ 5d division round', () => {
    const set = generateMemoriadSet('division', { dividend_digits: 10, divisor_digits: 5 }, createSeededRng(41));
    assert.equal(set.questions.length, 10);
    const answers = set.expected.slice();
    answers[3] = '1';
    const check = evaluateMemoriadSubmission(set, answers, 200);
    assert.equal(check.ok, true);
    assert.equal(check.evaluation.correct, 9);
  });

  it('generates a 10d × 10d multiplication round and a 10-digit square-root round', () => {
    const mult = generateMemoriadSet('multiplications', { digits: 10 }, createSeededRng(43));
    assert.ok(mult.questions.every(([a, b]) => a.length === 10 && b.length === 10));
    const roots = generateMemoriadSet('square_roots', { digits: 10 }, createSeededRng(47));
    assert.ok(roots.questions.every((n) => String(n).length === 10));
  });
});

describe('practice page keeps the daily-task hooks', () => {
  const src = readFileSync(new URL('../js/memoriadPlay.js', import.meta.url), 'utf8');
  it('still renders the locked daily-task badge, settings view and back links', () => {
    assert.ok(src.includes('Daily Task (${limitSeconds}s locked)'));
    assert.ok(src.includes('renderSettingsView();'));
    assert.ok(src.includes('Back to Daily Tasks'));
    assert.ok(src.includes('Back to Memoriad'));
  });
});
