/**
 * Trendz Tracker — Online Basics Practice Stats Unit Tests (tests/practiceStats.test.js)
 *
 * Tests `js/practiceStats.js`:
 * - Best result per basics category and question count (highest accuracy first, then shorter time).
 * - `setsThisWeek` in India time (`Asia/Kolkata`).
 * - Empty data handling.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestByCategoryAndCount,
  bestResult,
  getBasicsQuestionCounts,
  isBasicsOnlineAvailable,
  setsThisWeek,
  computePerMinuteRates,
  bestForMode,
  bestByCategoryAndMode,
  triesThisWeek,
  formatBasicsTargetText,
} from '../js/practiceStats.js';

describe('Phase 9a — js/practiceStats.js (Personal Bests & Weekly Sets in IST)', () => {
  const sampleRows = [
    {
      id: 'r1',
      category_id: 'cat-1d4r',
      student_round_id: null,
      correct: 8,
      total: 10,
      time_seconds: 25,
      entry_date: '2026-10-19',
      created_at: '2026-10-19T08:00:00.000Z',
      source: 'site',
    },
    {
      id: 'r2',
      category_id: 'cat-1d4r',
      student_round_id: null,
      correct: 9,
      total: 10,
      time_seconds: 40,
      entry_date: '2026-10-19',
      created_at: '2026-10-19T09:00:00.000Z',
      source: 'site',
    },
    {
      id: 'r3',
      category_id: 'cat-1d4r',
      student_round_id: null,
      correct: 9,
      total: 10,
      time_seconds: 31, // Same 90% accuracy as r2, but faster time -> wins
      entry_date: '2026-10-20',
      created_at: '2026-10-20T06:00:00.000Z',
      source: 'site',
    },
    {
      id: 'r4',
      category_id: 'cat-1d4r',
      student_round_id: null,
      correct: 20,
      total: 20,
      time_seconds: 55,
      entry_date: '2026-10-20',
      created_at: '2026-10-20T07:00:00.000Z',
      source: 'typed',
    },
    {
      // Competition round row (student_round_id not null) — must be ignored by basics stats
      id: 'r-round',
      category_id: 'cat-1d4r',
      student_round_id: 'sr-100',
      correct: 10,
      total: 10,
      time_seconds: 10,
      entry_date: '2026-10-20',
      created_at: '2026-10-20T07:30:00.000Z',
    },
  ];

  it('selects best result per category and question count by highest accuracy, then shorter time', () => {
    const best10 = bestResult(sampleRows, 'cat-1d4r', 10);
    assert.ok(best10);
    assert.equal(best10.id, 'r3');
    assert.equal(best10.correct, 9);
    assert.equal(best10.total, 10);
    assert.equal(best10.accuracy, 90);
    assert.equal(best10.time_seconds, 31);

    const best20 = bestResult(sampleRows, 'cat-1d4r', 20);
    assert.ok(best20);
    assert.equal(best20.id, 'r4');
    assert.equal(best20.accuracy, 100);

    const best5 = bestResult(sampleRows, 'cat-1d4r', 5);
    assert.equal(best5, null);

    const grouped = bestByCategoryAndCount(sampleRows);
    assert.equal(grouped['cat-1d4r|10'].id, 'r3');
    assert.equal(grouped['cat-1d4r|20'].id, 'r4');
  });

  it('computes setsThisWeek in India time (Monday to Sunday in Asia/Kolkata)', () => {
    const rowsAcrossWeeks = [
      // Sunday 2026-10-18 23:00 IST (17:30 UTC) -> previous week
      {
        id: 'prev-sun',
        category_id: 'cat-1d4r',
        student_round_id: null,
        correct: 9,
        total: 10,
        time_seconds: 30,
        entry_date: '2026-10-18',
        created_at: '2026-10-18T17:30:00.000Z',
      },
      // Monday 2026-10-19 00:15 IST (Sunday 2026-10-18 18:45 UTC) -> current week in IST!
      {
        id: 'mon-early-ist',
        category_id: 'cat-1d4r',
        student_round_id: null,
        correct: 10,
        total: 10,
        time_seconds: 28,
        created_at: '2026-10-18T18:45:00.000Z',
      },
      // Tuesday 2026-10-20 in IST
      {
        id: 'tue-ist',
        category_id: 'cat-1d4r',
        student_round_id: null,
        correct: 8,
        total: 10,
        time_seconds: 35,
        entry_date: '2026-10-20',
        created_at: '2026-10-20T05:00:00.000Z',
      },
    ];

    const weekSets = setsThisWeek(rowsAcrossWeeks, '2026-10-20');
    assert.equal(weekSets.length, 2);
    assert.deepEqual(
      weekSets.map((r) => r.id),
      ['tue-ist', 'mon-early-ist']
    );
  });

  it('handles empty or null data gracefully and returns per-category question slabs', () => {
    assert.equal(bestResult([], 'cat-1d4r', 10), null);
    assert.equal(bestResult(null, 'cat-1d4r', 10), null);
    assert.deepEqual(bestByCategoryAndCount([]), {});
    assert.deepEqual(bestByCategoryAndCount(null), {});
    assert.deepEqual(setsThisWeek([], '2026-10-20'), []);
    assert.deepEqual(setsThisWeek(null, '2026-10-20'), []);
    assert.equal(isBasicsOnlineAvailable(null), false);
    assert.equal(isBasicsOnlineAvailable('2dby1d'), true);

    assert.deepEqual(getBasicsQuestionCounts('1d4r'), [20, 50, 100, 200]);
    assert.deepEqual(getBasicsQuestionCounts('2d2r'), [20, 50, 100, 200]);
    assert.deepEqual(getBasicsQuestionCounts('1dx1d'), [20, 50, 100, 200]);
    assert.deepEqual(getBasicsQuestionCounts('2dx1d'), [20, 50, 100, 200]);
    assert.deepEqual(getBasicsQuestionCounts('2dby1d'), [20, 50, 100, 200]);
    assert.deepEqual(getBasicsQuestionCounts('2d4r'), [10, 20, 30, 50]);
    assert.deepEqual(getBasicsQuestionCounts('3d/1d'), [10, 50, 100]);
  });
});

describe('Phase 10g — Practice Stats: Per-Minute Maths, Best per Mode (Timed vs Unlimited) & Tie-Breaking', () => {
  it('computes correct_per_minute and attempted_per_minute to 1 decimal place', () => {
    const rates1 = computePerMinuteRates(22, 25, 30);
    // 22 in 0.5 min = 44.0/min; 25 in 0.5 min = 50.0/min; accuracy = 88%
    assert.equal(rates1.correct_per_minute, 44);
    assert.equal(rates1.attempted_per_minute, 50);
    assert.equal(rates1.accuracy, 88);

    const rates2 = computePerMinuteRates(37, 41, 60);
    assert.equal(rates2.correct_per_minute, 37);
    assert.equal(rates2.attempted_per_minute, 41);
    assert.equal(rates2.accuracy, 90.2);

    const ratesZero = computePerMinuteRates(10, 10, 0);
    assert.equal(ratesZero.correct_per_minute, 0);
    assert.equal(ratesZero.attempted_per_minute, 0);
  });

  it('tracks personal best separately for timed (most correct -> accuracy -> attempted) and unlimited (highest correct_per_minute -> accuracy -> correct)', () => {
    const modeRows = [
      // Timed row 1: 20/25 in 30s -> 20 correct, 80% accuracy
      {
        id: 't1',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'timed',
        correct: 20,
        total: 25,
        time_seconds: 30,
      },
      // Timed row 2: 22/25 in 30s -> 22 correct, 88% accuracy (more correct than t1)
      {
        id: 't2',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'timed',
        correct: 22,
        total: 25,
        time_seconds: 30,
      },
      // Timed row 3: 22/22 in 30s -> 22 correct, 100% accuracy (tie on correct=22 with t2, higher accuracy -> wins!)
      {
        id: 't3',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'timed',
        correct: 22,
        total: 22,
        time_seconds: 30,
      },
      // Unlimited row 1: 22/25 in 30s -> 44.0 correct/min, 88% accuracy
      {
        id: 'u1',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'unlimited',
        correct: 22,
        total: 25,
        time_seconds: 30,
      },
      // Unlimited row 2: 44/50 in 60s -> 44.0 correct/min, 88% accuracy, 44 correct (tie on cpm & accuracy, more correct -> beats u1)
      {
        id: 'u2',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'unlimited',
        correct: 44,
        total: 50,
        time_seconds: 60,
      },
      // Unlimited row 3: 22/22 in 30s -> 44.0 correct/min, 100% accuracy (tie on cpm, higher accuracy -> beats u2)
      {
        id: 'u3',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: 'unlimited',
        correct: 22,
        total: 22,
        time_seconds: 30,
      },
      // Old fixed/typed row with practice_mode = null (must be ignored by bestForMode)
      {
        id: 'old-fixed',
        category_id: 'cat-1d4r',
        student_round_id: null,
        practice_mode: null,
        correct: 100,
        total: 100,
        time_seconds: 30,
      },
    ];

    // Timed best is t3 (22 correct, 100% accuracy > t2's 88%)
    const bestTimed = bestForMode(modeRows, 'cat-1d4r', 'timed');
    assert.ok(bestTimed);
    assert.equal(bestTimed.id, 't3');
    assert.equal(bestTimed.correct, 22);
    assert.equal(bestTimed.accuracy, 100);

    // Unlimited best is u3 (44/min, 100% accuracy)
    const bestUnlimited = bestForMode(modeRows, 'cat-1d4r', 'unlimited');
    assert.ok(bestUnlimited);
    assert.equal(bestUnlimited.id, 'u3');
    assert.equal(bestUnlimited.correct_per_minute, 44);
    assert.equal(bestUnlimited.accuracy, 100);

    // Without u3, u2 beats u1 on more correct answers (44 > 22)
    const bestUnlimWithoutU3 = bestForMode(
      modeRows.filter((r) => r.id !== 'u3'),
      'cat-1d4r',
      'unlimited'
    );
    assert.equal(bestUnlimWithoutU3.id, 'u2');
    assert.equal(bestUnlimWithoutU3.correct, 44);

    const grouped = bestByCategoryAndMode(modeRows);
    assert.equal(grouped['cat-1d4r|timed'].id, 't3');
    assert.equal(grouped['cat-1d4r|unlimited'].id, 'u3');

    // Target text formatting
    assert.equal(
      formatBasicsTargetText({ min_accuracy: 90, min_questions_per_minute: 40 }),
      'Target: at least 90% accuracy and 40 questions per minute'
    );
    assert.equal(
      formatBasicsTargetText({ min_accuracy: 95, min_questions_per_minute: null }),
      'Target: at least 95% accuracy'
    );
    assert.equal(formatBasicsTargetText(null), '');
    assert.equal(triesThisWeek([], '2026-10-27').length, 0);
  });
});

