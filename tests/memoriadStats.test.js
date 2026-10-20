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

  it('groups Calendar best scores by number of dates (25, 50, 75, 100, 125)', () => {
    const calSummary = summarizeMemoriadModule(sampleRows, 'calendar', '2026-10-20');
    assert.equal(calSummary.best.id, 'c2'); // 110 correct > 24 correct overall
    assert.equal(calSummary.bestByDates[25].id, 'c1');
    assert.equal(calSummary.bestByDates[125].id, 'c2');
    assert.equal(calSummary.bestByDates[50], null);
  });

  it('handles empty data cleanly', () => {
    const all = summarizeAllMemoriad([], '2026-10-20');
    assert.equal(all.triesThisWeek, 0);
    assert.equal(all.totalTries, 0);
    assert.equal(all.modules.calendar.best, null);
    assert.deepEqual(all.modules.calendar.lastFive, []);
    assert.equal(all.modules.additions.best, null);
  });
});
