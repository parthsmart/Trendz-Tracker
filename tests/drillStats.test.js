/**
 * Trendz Tracker — Phase 8 Drill Statistics Unit Tests (tests/drillStats.test.js)
 *
 * Covers `js/drillStats.js`:
 * - `bestForDrill`: empty data, highest correct, then fewer wrong answers, then shorter time, and ties
 * - `isNewPersonalBest`
 * - `recentSets`: empty data, ordering by created_at descending, limit, and ties
 * - `setsThisWeek`: Monday–Sunday week boundaries in India time (`Asia/Kolkata`)
 * - `summaryByDrill`: per-drill counts, best, and last across all 18 drills
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestForDrill,
  isNewPersonalBest,
  recentSets,
  setsThisWeek,
  summaryByDrill,
  formatDrillHistoryName,
  isArchivedDrillRow,
  isCatalogDrillRow,
} from '../js/drillStats.js';

describe('Phase 8 — drillStats.js: bestForDrill & isNewPersonalBest', () => {
  it('returns null for empty or non-matching data', () => {
    assert.equal(bestForDrill([]), null);
    assert.equal(bestForDrill(null), null);
    assert.equal(
      bestForDrill(
        [
          {
            id: 'f1',
            activity_type: 'flash_anzan',
            activity_name: 'Flash Anzan',
            correct: 10,
            total: 10,
            time_seconds: 30,
          },
        ],
        'day_codes'
      ),
      null
    );
  });

  it('ranks by highest correct first, then fewer wrong answers, then shorter time, and handles ties deterministically', () => {
    const rows = [
      {
        id: 'r1',
        activity_type: 'element',
        activity_name: 'Day Codes',
        settings: { drill: 'day_codes' },
        correct: 50,
        total: 56, // 6 wrong
        time_seconds: 40,
      },
      {
        id: 'r2',
        activity_type: 'element',
        activity_name: 'Day Codes',
        settings: { drill: 'day_codes' },
        correct: 52,
        total: 56, // 4 wrong
        time_seconds: 55,
      },
      {
        id: 'r3',
        activity_type: 'element',
        activity_name: 'Day Codes',
        settings: { drill: 'day_codes' },
        correct: 52,
        total: 53, // 1 wrong (fewer wrong than r2!)
        time_seconds: 58,
      },
      {
        id: 'r4',
        activity_type: 'element',
        activity_name: 'Day Codes',
        settings: { drill: 'day_codes' },
        correct: 52,
        total: 53, // 1 wrong, shorter time than r3!
        time_seconds: 45,
      },
      {
        id: 'r5-tie',
        activity_type: 'element',
        activity_name: 'Day Codes',
        settings: { drill: 'day_codes' },
        correct: 52,
        total: 53, // exact tie with r4
        time_seconds: 45,
      },
    ];

    const best = bestForDrill(rows, 'day_codes');
    assert.ok(best);
    assert.equal(best.id, 'r4');
    assert.equal(best.correct, 52);
    assert.equal(best.wrong, 1);
    assert.equal(best.time_seconds, 45);

    // New personal best checks
    assert.equal(isNewPersonalBest({ correct: 53, attempted: 56, seconds: 59 }, best), true);
    assert.equal(isNewPersonalBest({ correct: 52, attempted: 52, seconds: 59 }, best), true);
    assert.equal(isNewPersonalBest({ correct: 52, attempted: 53, seconds: 44 }, best), true);
    assert.equal(isNewPersonalBest({ correct: 52, attempted: 53, seconds: 45 }, best), false);
    assert.equal(isNewPersonalBest({ correct: 51, attempted: 51, seconds: 30 }, best), false);
  });
});

describe('Phase 8 — drillStats.js: recentSets & setsThisWeek (India time)', () => {
  it('recentSets handles empty data, sorts newest first, and preserves order on timestamp ties', () => {
    assert.deepEqual(recentSets([]), []);
    assert.deepEqual(recentSets(null), []);

    const rows = [
      {
        id: 'old',
        activity_type: 'element',
        activity_name: 'Ratio',
        correct: 15,
        total: 20,
        time_seconds: 180,
        created_at: '2026-10-10T10:00:00.000Z',
      },
      {
        id: 'tie-1',
        activity_type: 'element',
        activity_name: 'Day Codes',
        correct: 55,
        total: 56,
        time_seconds: 48,
        created_at: '2026-10-19T08:00:00.000Z',
      },
      {
        id: 'tie-2',
        activity_type: 'element',
        activity_name: 'Month Codes',
        correct: 54,
        total: 56,
        time_seconds: 50,
        created_at: '2026-10-19T08:00:00.000Z',
      },
    ];

    const top2 = recentSets(rows, 2);
    assert.equal(top2.length, 2);
    assert.equal(top2[0].id, 'tie-1');
    assert.equal(top2[1].id, 'tie-2');
  });

  it('setsThisWeek filters by Monday–Sunday week in Asia/Kolkata (UTC+5:30)', () => {
    assert.deepEqual(setsThisWeek([], '2026-10-19'), []);

    // Monday 19 Oct 2026 in IST starts at 2026-10-18T18:30:00.000Z
    const rows = [
      {
        id: 'sun-night-utc-but-mon-ist',
        activity_type: 'element',
        activity_name: 'Day Codes',
        correct: 50,
        total: 56,
        time_seconds: 52,
        // 2026-10-18 20:00 UTC = 2026-10-19 01:30 IST (Monday) -> IN this week!
        created_at: '2026-10-18T20:00:00.000Z',
      },
      {
        id: 'prev-week-sun-ist',
        activity_type: 'element',
        activity_name: 'Day Codes',
        correct: 48,
        total: 56,
        time_seconds: 55,
        // 2026-10-18 17:00 UTC = 2026-10-18 22:30 IST (Sunday of previous week) -> NOT in this week!
        created_at: '2026-10-18T17:00:00.000Z',
      },
    ];

    const weekSets = setsThisWeek(rows, '2026-10-19');
    assert.equal(weekSets.length, 1);
    assert.equal(weekSets[0].id, 'sun-night-utc-but-mon-ist');
  });
});

describe('Phase 8 & 10f — drillStats.js: summaryByDrill & Archived Old Drill Keys', () => {
  it('returns summaries for all 24 catalog drills with accurate count, best, and last', () => {
    const emptySummary = summaryByDrill([]);
    assert.equal(Object.keys(emptySummary).length, 24);
    assert.equal(emptySummary.day_codes.count, 0);
    assert.equal(emptySummary.day_codes.best, null);
    assert.equal(emptySummary.day_codes.last, null);

    const rows = [
      {
        id: 's1',
        activity_type: 'element',
        activity_name: 'Square - Stage 1 (1-25)',
        settings: { drill: 'squares_stage_1' },
        correct: 24,
        total: 25,
        time_seconds: 48,
        created_at: '2026-10-17T10:00:00.000Z',
      },
      {
        id: 's2',
        activity_type: 'element',
        activity_name: 'Square - Stage 1 (1-25)',
        settings: { drill: 'squares_stage_1' },
        correct: 22,
        total: 25,
        time_seconds: 40,
        created_at: '2026-10-19T10:00:00.000Z',
      },
    ];

    const summary = summaryByDrill(rows);
    assert.equal(summary.squares_stage_1.count, 2);
    assert.equal(summary.squares_stage_1.best.id, 's1');
    assert.equal(summary.squares_stage_1.last.id, 's2');
  });

  it('treats old removed keys (squares_11_50, squares_51_100, cubes_11_50, cubes_51_100) as archived: keeps stored activity_name, displays "<name> (old drill)", and excludes from bestForDrill', () => {
    const archivedRows = [
      {
        id: 'old-sq-1',
        activity_type: 'element',
        activity_name: 'Square (11-50)',
        settings: { drill: 'squares_11_50' },
        correct: 50,
        total: 50,
        time_seconds: 75,
        created_at: '2026-10-20T10:00:00.000Z',
      },
      {
        id: 'old-cb-1',
        activity_type: 'element',
        activity_name: 'Cube (51-100)',
        settings: { drill: 'cubes_51_100' },
        correct: 50,
        total: 50,
        time_seconds: 120,
        created_at: '2026-10-19T10:00:00.000Z',
      },
      {
        id: 'active-st-1',
        activity_type: 'element',
        activity_name: 'Square - Stage 1 (1-25)',
        settings: { drill: 'squares_stage_1' },
        correct: 23,
        total: 25,
        time_seconds: 50,
        created_at: '2026-10-18T10:00:00.000Z',
      },
    ];

    // Archived vs catalog classification
    assert.equal(isArchivedDrillRow(archivedRows[0]), true);
    assert.equal(isCatalogDrillRow(archivedRows[0]), false);
    assert.equal(isArchivedDrillRow(archivedRows[2]), false);
    assert.equal(isCatalogDrillRow(archivedRows[2]), true);

    // Display formatting for history list
    assert.equal(formatDrillHistoryName(archivedRows[0]), 'Square (11-50) (old drill)');
    assert.equal(formatDrillHistoryName(archivedRows[1]), 'Cube (51-100) (old drill)');
    assert.equal(formatDrillHistoryName(archivedRows[2]), 'Square - Stage 1 (1-25)');

    // Stored activity_name on recentSets rows is never mutated, while display_name has "(old drill)"
    const history = recentSets(archivedRows, 10);
    assert.equal(history.length, 3);
    assert.equal(history[0].activity_name, 'Square (11-50)');
    assert.equal(history[0].display_name, 'Square (11-50) (old drill)');
    assert.equal(history[0].is_old_drill, true);
    assert.equal(history[2].activity_name, 'Square - Stage 1 (1-25)');
    assert.equal(history[2].display_name, 'Square - Stage 1 (1-25)');
    assert.equal(history[2].is_old_drill, false);

    // Old results are NOT counted in any drill's best
    assert.equal(bestForDrill(archivedRows, 'squares_11_50'), null);
    assert.equal(bestForDrill(archivedRows, 'cubes_51_100'), null);
    assert.equal(bestForDrill(archivedRows, 'squares_stage_1')?.id, 'active-st-1');

    // Even when drillKey is omitted, archived rows are ignored by bestForDrill
    assert.equal(bestForDrill([archivedRows[0], archivedRows[1]]), null);
    assert.equal(bestForDrill(archivedRows)?.id, 'active-st-1');
  });
});
