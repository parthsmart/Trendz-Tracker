/**
 * Trendz Tracker — Phase 7b Flash Anzan Timeline Unit Tests (tests/flashTimeline.test.js)
 *
 * Covers `js/flashTimeline.js`:
 * - `buildTimeline(settings, count)` for 2, 50, and 1000 numbers:
 *   verifies event array lengths (`2 * count + 1`), exact millisecond offsets,
 *   80 ms blank intervals (`FLASH_BLANK_MS`), and the final `done` event.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLASH_BLANK_MS, buildTimeline } from '../js/flashTimeline.js';

describe('Phase 7b — flashTimeline.js: buildTimeline for 2, 50, and 1000 numbers', () => {
  it('builds exact timeline for 2 numbers (lengths, offsets, last event)', () => {
    const speedMs = 1000;
    const events = buildTimeline({ speed_ms: speedMs, count: 2 }, 2);

    // 2 numbers -> 2 * 2 + 1 = 5 events (number 0, blank 0, number 1, blank 1, done)
    assert.equal(FLASH_BLANK_MS, 80);
    assert.equal(events.length, 5);

    assert.deepEqual(events[0], {
      type: 'number',
      index: 0,
      offsetMs: 0,
      durationMs: 1000,
    });
    assert.deepEqual(events[1], {
      type: 'blank',
      index: 0,
      offsetMs: 1000,
      durationMs: 80,
    });
    assert.deepEqual(events[2], {
      type: 'number',
      index: 1,
      offsetMs: 1080,
      durationMs: 1000,
    });
    assert.deepEqual(events[3], {
      type: 'blank',
      index: 1,
      offsetMs: 2080,
      durationMs: 80,
    });
    assert.deepEqual(events[4], {
      type: 'done',
      index: 2,
      offsetMs: 2160,
      durationMs: 0,
    });
  });

  it('builds exact timeline for 50 numbers (lengths, offsets, last event)', () => {
    const speedMs = 500;
    const stepMs = speedMs + FLASH_BLANK_MS; // 580 ms
    const events = buildTimeline({ speed_ms: speedMs }, 50);

    // 50 numbers -> 2 * 50 + 1 = 101 events
    assert.equal(events.length, 101);

    for (let i = 0; i < 50; i++) {
      const numEv = events[2 * i];
      const blankEv = events[2 * i + 1];

      assert.equal(numEv.type, 'number');
      assert.equal(numEv.index, i);
      assert.equal(numEv.offsetMs, i * stepMs);
      assert.equal(numEv.durationMs, speedMs);

      assert.equal(blankEv.type, 'blank');
      assert.equal(blankEv.index, i);
      assert.equal(blankEv.offsetMs, i * stepMs + speedMs);
      assert.equal(blankEv.durationMs, FLASH_BLANK_MS);
    }

    const lastEvent = events[events.length - 1];
    assert.deepEqual(lastEvent, {
      type: 'done',
      index: 50,
      offsetMs: 50 * stepMs, // 29,000 ms
      durationMs: 0,
    });
  });

  it('builds exact timeline for 1000 numbers (lengths, offsets, last event)', () => {
    const speedMs = 200;
    const stepMs = speedMs + FLASH_BLANK_MS; // 280 ms
    const events = buildTimeline({ speed_ms: speedMs, count: 1000 });

    // 1000 numbers -> 2 * 1000 + 1 = 2001 events
    assert.equal(events.length, 2001);

    assert.equal(events[0].type, 'number');
    assert.equal(events[0].offsetMs, 0);

    // Check 500th number (index 499)
    assert.deepEqual(events[998], {
      type: 'number',
      index: 499,
      offsetMs: 499 * stepMs,
      durationMs: 200,
    });
    assert.deepEqual(events[999], {
      type: 'blank',
      index: 499,
      offsetMs: 499 * stepMs + 200,
      durationMs: 80,
    });

    // Check 1000th number (index 999) and final done event
    assert.deepEqual(events[1998], {
      type: 'number',
      index: 999,
      offsetMs: 999 * stepMs,
      durationMs: 200,
    });
    assert.deepEqual(events[1999], {
      type: 'blank',
      index: 999,
      offsetMs: 999 * stepMs + 200,
      durationMs: 80,
    });

    const lastEvent = events[events.length - 1];
    assert.deepEqual(lastEvent, {
      type: 'done',
      index: 1000,
      offsetMs: 1000 * stepMs, // 280,000 ms
      durationMs: 0,
    });
  });
});
