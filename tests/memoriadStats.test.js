/**
 * Unit tests for js/memoriadStats.js (Phase 9b-1)
 * Run with: node --test tests/memoriadStats.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeMemoriadModule,
  summarizeAllMemoriad,
} from '../js/memoriadStats.js';

describe('js/memoriadStats.js — Best score ranking, Calendar date grouping & IST weekly tries', () => {
  const sampleRows = [
    {
      id: 'm1',
      activity_type: 'memoriad',
      activity_name: 'Mental Additions',
      correct: 8,
      total: 10,
      time_seconds: 120,
      settings: { module: 'additions', questions: 10, attempted: 10, correct: 8, score: 8, used_seconds: 120.5 },
      created_at: '2026-10-19T10:00:00.000Z',
    },
    {
      id: 'm2',
      activity_type: 'memoriad',
      activity_name: 'Mental Additions',
      correct: 8,
      total: 9, // higher accuracy (8/9 > 8/10) with same correct=8
      time_seconds: 130,
      settings: { module: 'additions', questions: 10, attempted: 9, correct: 8, score: 8, used_seconds: 130.0 },
      created_at: '2026-10-20T08:00:00.000Z',
    },
    {
      id: 'm3',
      activity_type: 'memoriad',
      activity_name: 'Mental Additions',
      correct: 8,
      total: 9, // tied correct & accuracy, faster time (115.2 < 130.0)
      time_seconds: 115,
      settings: { module: 'additions', questions: 10, attempted: 9, correct: 8, score: 8, used_seconds: 115.2 },
      created_at: '2026-10-10T08:00:00.000Z', // older than 7 days
    },
    {
      id: 'c1',
      activity_type: 'memoriad',
      activity_name: 'Mental Calendar Dates',
      correct: 24,
      total: 25,
      time_seconds: 32,
      settings: { module: 'calendar', dates: 25, questions: 25, attempted: 25, correct: 24, score: 24, used_seconds: 32.1 },
      created_at: '2026-10-20T09:00:00.000Z',
    },
    {
      id: 'c2',
      activity_type: 'memoriad',
      activity_name: 'Mental Calendar Dates',
      correct: 110,
      total: 125,
      time_seconds: 58,
      settings: { module: 'calendar', dates: 125, questions: 125, attempted: 125, correct: 110, score: 110, used_seconds: 58.4 },
      created_at: '2026-10-18T09:00:00.000Z',
    },
  ];

  it('picks best attempt by highest correct, then higher accuracy, then shorter time', () => {
    const addSummary = summarizeMemoriadModule(sampleRows, 'additions', '2026-10-20');
    assert.equal(addSummary.best.id, 'm3');
    assert.equal(addSummary.totalTries, 3);
    // m1 (Oct 19) and m2 (Oct 20) are within 7 days of 2026-10-20; m3 (Oct 10) is outside
    assert.equal(addSummary.triesThisWeek, 2);
    assert.equal(addSummary.lastFive.length, 3);
    assert.equal(addSummary.lastFive[0].id, 'm2'); // newest first
  });

  it('groups Calendar best scores by number of dates and ranks by official score first', () => {
    const rowsWithTwoMistakeFreeze = [
      ...sampleRows,
      {
        id: 'c3-early-second-mistake',
        activity_type: 'memoriad',
        activity_name: 'Mental Calendar Dates',
        correct: 24,
        total: 26,
        time_seconds: 25,
        // Higher raw correct (24 vs 24), faster time (25s vs 32.1s), but second wrong happened after 10 -> score = 10
        settings: {
          module: 'calendar',
          dates: 25,
          questions: 25,
          attempted: 25,
          correct: 24,
          wrong: 2,
          score: 10,
          used_seconds: 25.0,
        },
        created_at: '2026-10-20T09:30:00.000Z',
      },
    ];
    const calSummary = summarizeMemoriadModule(rowsWithTwoMistakeFreeze, 'calendar', '2026-10-20');
    assert.equal(calSummary.best.id, 'c2'); // score 110 > score 24 > score 10
    assert.equal(calSummary.bestByDates[25].id, 'c1'); // score 24 beats score 10 even though c3 was faster
    assert.equal(calSummary.bestByDates[125].id, 'c2');
    assert.equal(calSummary.bestByDates[50], null);
  });

  it('ranks Square Roots by highest score then shorter time, and Multiplications by highest correct then shorter time', () => {
    const phase9b2Rows = [
      {
        id: 'sr-slow-high',
        activity_type: 'memoriad',
        activity_name: 'Mental Square Roots',
        correct: 6,
        total: 10,
        time_seconds: 500,
        settings: { module: 'square_roots', attempted: 10, correct: 6, score: 280, digits_total: 64, used_seconds: 500.0 },
        created_at: '2026-10-19T10:00:00.000Z',
      },
      {
        id: 'sr-fast-tied-score',
        activity_type: 'memoriad',
        activity_name: 'Mental Square Roots',
        correct: 5,
        total: 10,
        time_seconds: 410,
        settings: { module: 'square_roots', attempted: 10, correct: 5, score: 280, digits_total: 65, used_seconds: 410.5 },
        created_at: '2026-10-20T10:00:00.000Z',
      },
      {
        id: 'mul-1',
        activity_type: 'memoriad',
        activity_name: 'Mental Multiplications',
        correct: 8,
        total: 10,
        time_seconds: 320,
        settings: { module: 'multiplications', attempted: 10, correct: 8, score: 8, used_seconds: 320.0 },
        created_at: '2026-10-19T11:00:00.000Z',
      },
      {
        id: 'mul-2-faster',
        activity_type: 'memoriad',
        activity_name: 'Mental Multiplications',
        correct: 8,
        total: 10,
        time_seconds: 275,
        settings: { module: 'multiplications', attempted: 10, correct: 8, score: 8, used_seconds: 275.4 },
        created_at: '2026-10-20T11:00:00.000Z',
      },
    ];

    const srSummary = summarizeMemoriadModule(phase9b2Rows, 'square_roots', '2026-10-20');
    assert.equal(srSummary.best.id, 'sr-fast-tied-score');
    assert.equal(srSummary.best.digits_total, 65);

    const mulSummary = summarizeMemoriadModule(phase9b2Rows, 'multiplications', '2026-10-20');
    assert.equal(mulSummary.best.id, 'mul-2-faster');
  });

  it('handles empty data cleanly', () => {
    const all = summarizeAllMemoriad([], '2026-10-20');
    assert.equal(all.triesThisWeek, 0);
    assert.equal(all.totalTries, 0);
    assert.equal(all.modules.calendar.best, null);
    assert.deepEqual(all.modules.calendar.lastFive, []);
    assert.equal(all.modules.additions.best, null);
    assert.equal(all.modules.multiplications.best, null);
    assert.equal(all.modules.square_roots.best, null);
  });
});
