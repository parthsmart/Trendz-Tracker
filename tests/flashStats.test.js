/**
 * Trendz Tracker — Phase 7b Flash Anzan Statistics & Settings Unit Tests (tests/flashStats.test.js)
 *
 * Covers `js/flashStats.js`:
 * - `settingsKey`: canonical key `(digits, count, speed_ms, mode)` ignoring `questions` and `session_id`
 * - `statsByKey`: grouping that ignores `questions` and `session_id`, old multi-question rows and new single-question rows together (`sum(correct) / sum(total)`), and empty data
 * - `recentTries`: last 20 tries, "Correct"/"Wrong" for single tries and "n of m correct" for legacy rows
 * - `triesThisWeek`: Monday–Sunday week boundaries in India time (`Asia/Kolkata`) and empty data
 * - `clampFlashSettings`, `validateFlashSettings`, `getExpectedDurationInfo`, `parseFlashAnswerInput`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFlashCardSummary,
  clampFlashSettings,
  formatFlashSettingsSummary,
  getExpectedDurationInfo,
  getStatsForSettings,
  parseFlashAnswerInput,
  recentTries,
  settingsKey,
  statsByKey,
  triesThisWeek,
  validateFlashSettings,
} from '../js/flashStats.js';

describe('Phase 7b — flashStats.js: settingsKey & statsByKey', () => {
  it('settingsKey ignores "questions", "session_id", and extra keys', () => {
    const k1 = settingsKey({
      digits: 2,
      count: 50,
      speed_ms: 1000,
      mode: 'add',
    });
    const k2 = settingsKey({
      digits: 2,
      count: 50,
      speed_ms: 1000,
      mode: 'add',
      questions: 10,
      session_id: 'sess-abc-123',
      extra: 'ignored',
    });

    assert.equal(k1, '2|50|1000|add');
    assert.equal(k1, k2);
    assert.equal(settingsKey(null), null);
    assert.equal(settingsKey({ digits: 2 }), null);
  });

  it('statsByKey handles empty data and combines old multi-question rows with new 1-question rows', () => {
    assert.deepEqual(statsByKey([]), []);
    assert.deepEqual(statsByKey(null), []);

    const rows = [
      // Legacy row: 10 questions at 2 digits, 10 numbers, 1000 ms, add (8 of 10 correct)
      {
        id: 'old-set-1',
        activity_type: 'flash_anzan',
        correct: 8,
        total: 10,
        time_seconds: 120,
        settings: {
          digits: 2,
          count: 10,
          speed_ms: 1000,
          questions: 10,
          session_id: 'legacy-1',
          mode: 'add',
        },
        created_at: '2026-10-15T10:00:00.000Z',
      },
      // New try 1: 1 question at same settings (correct = 1, total = 1)
      {
        id: 'new-try-1',
        activity_type: 'flash_anzan',
        correct: 1,
        total: 1,
        time_seconds: 11,
        settings: {
          digits: 2,
          count: 10,
          speed_ms: 1000,
          session_id: 'new-1',
          mode: 'add',
        },
        created_at: '2026-10-19T09:00:00.000Z',
      },
      // New try 2: 1 question at same settings (correct = 0, total = 1)
      {
        id: 'new-try-2',
        activity_type: 'flash_anzan',
        correct: 0,
        total: 1,
        time_seconds: 12,
        settings: {
          digits: 2,
          count: 10,
          speed_ms: 1000,
          mode: 'add',
        },
        created_at: '2026-10-19T09:05:00.000Z',
      },
      // Another settings combination: 3 digits, 25 numbers, 800 ms, add_sub (2 tries, 2 correct)
      {
        id: 'other-1',
        activity_type: 'flash_anzan',
        correct: 1,
        total: 1,
        time_seconds: 22,
        settings: { digits: 3, count: 25, speed_ms: 800, mode: 'add_sub' },
        created_at: '2026-10-19T10:00:00.000Z',
      },
      {
        id: 'other-2',
        activity_type: 'flash_anzan',
        correct: 1,
        total: 1,
        time_seconds: 21,
        settings: { digits: 3, count: 25, speed_ms: 800, mode: 'add_sub' },
        created_at: '2026-10-19T10:02:00.000Z',
      },
    ];

    const grouped = statsByKey(rows);
    assert.equal(grouped.length, 2);

    // Most practised first: 2|10|1000|add has 10 + 1 + 1 = 12 tries, 8 + 1 + 0 = 9 correct -> 75%
    assert.equal(grouped[0].key, '2|10|1000|add');
    assert.equal(grouped[0].tries, 12);
    assert.equal(grouped[0].correct, 9);
    assert.equal(grouped[0].successRate, 75);
    assert.equal(grouped[0].summary, '2 digits - 10 numbers - 1.0 s - add');

    // Second group: 3|25|800|add_sub has 2 tries, 2 correct -> 100%
    assert.equal(grouped[1].key, '3|25|800|add_sub');
    assert.equal(grouped[1].tries, 2);
    assert.equal(grouped[1].correct, 2);
    assert.equal(grouped[1].successRate, 100);
    assert.equal(
      grouped[1].summary,
      '3 digits - 25 numbers - 0.8 s - add & subtract'
    );

    // Lookup for unpractised settings returns 0 tries
    const unpractised = getStatsForSettings(rows, {
      digits: 5,
      count: 100,
      speed_ms: 500,
      mode: 'add',
    });
    assert.equal(unpractised.tries, 0);
    assert.equal(unpractised.correct, 0);
    assert.equal(unpractised.successRate, null);
  });
});

describe('Phase 7b — flashStats.js: recentTries & triesThisWeek (India time)', () => {
  it('recentTries formats single tries as "Correct"/"Wrong" and old sets as "n of m correct", capped at 20', () => {
    assert.deepEqual(recentTries([]), []);

    const rows = [];
    for (let i = 1; i <= 25; i++) {
      rows.push({
        id: `try-${i}`,
        activity_type: 'flash_anzan',
        correct: i % 2 === 0 ? 1 : 0,
        total: 1,
        time_seconds: 10 + i,
        settings: { digits: 2, count: 20, speed_ms: 1000, mode: 'add' },
        created_at: new Date(Date.UTC(2026, 9, 19, 0, i, 0)).toISOString(),
      });
    }
    // Add one older multi-question set at the latest timestamp
    rows.push({
      id: 'legacy-set',
      activity_type: 'flash_anzan',
      correct: 7,
      total: 10,
      time_seconds: 95,
      settings: {
        digits: 1,
        count: 5,
        speed_ms: 2000,
        questions: 10,
        mode: 'add',
      },
      created_at: new Date(Date.UTC(2026, 9, 19, 2, 0, 0)).toISOString(),
    });

    const recent = recentTries(rows, 20);
    assert.equal(recent.length, 20);
    assert.equal(recent[0].id, 'legacy-set');
    assert.equal(recent[0].outcomeText, '7 of 10 correct');
    assert.equal(recent[1].id, 'try-25');
    assert.equal(recent[1].outcomeText, 'Wrong');
    assert.equal(recent[2].id, 'try-24');
    assert.equal(recent[2].outcomeText, 'Correct');
  });

  it('triesThisWeek filters by Monday–Sunday week in Asia/Kolkata (UTC+5:30)', () => {
    assert.deepEqual(triesThisWeek([], '2026-10-19'), []);

    const rows = [
      {
        id: 'mon-early-ist',
        activity_type: 'flash_anzan',
        correct: 1,
        total: 1,
        time_seconds: 10,
        settings: { digits: 2, count: 10, speed_ms: 1000, mode: 'add' },
        // 2026-10-18 20:00 UTC = 2026-10-19 01:30 IST (Monday) -> IN this week
        created_at: '2026-10-18T20:00:00.000Z',
      },
      {
        id: 'sun-late-ist-prev-week',
        activity_type: 'flash_anzan',
        correct: 1,
        total: 1,
        time_seconds: 10,
        settings: { digits: 2, count: 10, speed_ms: 1000, mode: 'add' },
        // 2026-10-18 17:00 UTC = 2026-10-18 22:30 IST (Sunday of previous week) -> NOT in this week
        created_at: '2026-10-18T17:00:00.000Z',
      },
    ];

    const week = triesThisWeek(rows, '2026-10-19');
    assert.equal(week.length, 1);
    assert.equal(week[0].id, 'mon-early-ist');

    const cardSummary = buildFlashCardSummary(rows, '2026-10-19');
    assert.equal(cardSummary.triesThisWeek, 1);
    assert.equal(cardSummary.correctThisWeek, 1);
    assert.equal(cardSummary.mostPractised.tries, 2);
    assert.equal(cardSummary.mostPractised.successRate, 100);
  });
});

describe('Phase 7b — flashStats.js: Clamping, Validation, Duration & Digits-Only Answer Parsing', () => {
  it('clamps count silently to 2..1000 and validates 1..5 digits, 2..1000 count, 200..5000 speed_ms', () => {
    const clampedLow = clampFlashSettings({
      digits: 0,
      count: 1,
      speed_ms: 50,
      mode: 'invalid',
    });
    assert.deepEqual(clampedLow, {
      digits: 1,
      count: 2,
      speed_ms: 200,
      mode: 'add',
    });

    const clampedHigh = clampFlashSettings({
      digits: 9,
      count: 2500,
      speed_ms: 9000,
      mode: 'add_sub',
    });
    assert.deepEqual(clampedHigh, {
      digits: 5,
      count: 1000,
      speed_ms: 5000,
      mode: 'add_sub',
    });

    const validRes = validateFlashSettings({
      digits: 2,
      count: 1000,
      speed_ms: 500,
      mode: 'add',
    });
    assert.equal(validRes.valid, true);
    assert.equal('questions' in validRes.settings, false);

    assert.equal(
      formatFlashSettingsSummary({
        digits: 2,
        count: 50,
        speed_ms: 1000,
        mode: 'add',
      }),
      '2 digits - 50 numbers - 1.0 s - add'
    );
  });

  it('requires confirmation when expected duration exceeds 5 minutes (300 seconds)', () => {
    const shortInfo = getExpectedDurationInfo({ count: 50, speed_ms: 1000 });
    assert.equal(shortInfo.durationSeconds, 50);
    assert.equal(shortInfo.requiresConfirmation, false);

    const longInfo = getExpectedDurationInfo({ count: 720, speed_ms: 1000 });
    assert.equal(longInfo.durationSeconds, 720);
    assert.equal(longInfo.requiresConfirmation, true);
    assert.equal(longInfo.confirmMessage, 'This will take about 12 minutes. Start?');
  });

  it('parses digits-only answer up to 10 digits and rejects minus signs or >10 digits', () => {
    assert.deepEqual(parseFlashAnswerInput('482'), { ok: true, value: 482 });
    assert.deepEqual(parseFlashAnswerInput('1234567890'), {
      ok: true,
      value: 1234567890,
    });
    assert.deepEqual(parseFlashAnswerInput(null), { ok: true, value: null });
    assert.equal(parseFlashAnswerInput('-45').ok, false);
    assert.equal(parseFlashAnswerInput('12345678901').ok, false);
    assert.equal(parseFlashAnswerInput('').ok, false);
  });
});
