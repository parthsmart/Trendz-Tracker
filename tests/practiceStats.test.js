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
  isBasicsOnlineAvailable,
  setsThisWeek,
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

  it('handles empty or null data gracefully', () => {
    assert.equal(bestResult([], 'cat-1d4r', 10), null);
    assert.equal(bestResult(null, 'cat-1d4r', 10), null);
    assert.deepEqual(bestByCategoryAndCount([]), {});
    assert.deepEqual(bestByCategoryAndCount(null), {});
    assert.deepEqual(setsThisWeek([], '2026-10-20'), []);
    assert.deepEqual(setsThisWeek(null, '2026-10-20'), []);
    assert.equal(isBasicsOnlineAvailable(null), false);
  });
});
