/**
 * Unit Tests for Phase 14a — Flash Anzan Task Matching & URL Query Helpers
 * (js/flashTaskMatch.js)
 *
 * Run with: node --test tests/flashTaskMatch.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchesTask,
  parseFlashTaskQuery,
  applyTaskToSettings,
} from '../js/flashTaskMatch.js';

describe('matchesTask', () => {
  const sampleSettings = {
    digits: 1,
    count: 50,
    speed_ms: 500,
    mode: 'add',
  };

  it('returns true when all task fields are null / empty ("Any flash anzan try")', () => {
    assert.equal(
      matchesTask(sampleSettings, {
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
      }),
      true
    );
    assert.equal(matchesTask(sampleSettings, {}), true);
  });

  it('matches each field alone and rejects when that single field differs', () => {
    // Digits alone
    assert.equal(matchesTask(sampleSettings, { flash_digits: 1 }), true);
    assert.equal(matchesTask(sampleSettings, { flash_digits: 2 }), false);

    // Count alone
    assert.equal(matchesTask(sampleSettings, { flash_count: 50 }), true);
    assert.equal(matchesTask(sampleSettings, { flash_count: 25 }), false);

    // Speed alone
    assert.equal(matchesTask(sampleSettings, { flash_speed_ms: 500 }), true);
    assert.equal(matchesTask(sampleSettings, { flash_speed_ms: 600 }), false);

    // Mode alone
    assert.equal(matchesTask(sampleSettings, { flash_mode: 'add' }), true);
    assert.equal(matchesTask(sampleSettings, { flash_mode: 'add_sub' }), false);
  });

  it('returns true only when every fixed setting on the task matches', () => {
    const fullTask = {
      flash_digits: 1,
      flash_count: 50,
      flash_speed_ms: 500,
      flash_mode: 'add',
    };
    assert.equal(matchesTask(sampleSettings, fullTask), true);

    assert.equal(matchesTask({ ...sampleSettings, digits: 2 }, fullTask), false);
    assert.equal(matchesTask({ ...sampleSettings, count: 51 }, fullTask), false);
    assert.equal(matchesTask({ ...sampleSettings, speed_ms: 400 }, fullTask), false);
    assert.equal(matchesTask({ ...sampleSettings, mode: 'add_sub' }, fullTask), false);
  });

  it('returns false when settings is null or not an object', () => {
    assert.equal(matchesTask(null, { flash_digits: 1 }), false);
    assert.equal(matchesTask(undefined, { flash_digits: 1 }), false);
  });
});

describe('parseFlashTaskQuery & applyTaskToSettings', () => {
  it('parses valid query parameters and ignores out-of-range or invalid ones', () => {
    const valid = parseFlashTaskQuery('?task=1&digits=2&count=150&speed=800&mode=add_sub');
    assert.equal(valid.isTask, true);
    assert.equal(valid.hasAnyParam, true);
    assert.deepEqual(valid.task, {
      flash_digits: 2,
      flash_count: 150,
      flash_speed_ms: 800,
      flash_mode: 'add_sub',
    });

    // Out-of-range parameters are ignored -> null
    const invalid = parseFlashTaskQuery(
      '?task=1&digits=9&count=1&speed=150&mode=multiply'
    );
    assert.equal(invalid.isTask, true);
    assert.equal(invalid.hasAnyParam, false);
    assert.deepEqual(invalid.task, {
      flash_digits: null,
      flash_count: null,
      flash_speed_ms: null,
      flash_mode: null,
    });

    // Boundary values: 0.2 s (200 ms), 5.0 s (5000 ms), 2 numbers, 1000 numbers
    const boundsMin = parseFlashTaskQuery('?task=1&digits=1&count=2&speed=200&mode=add');
    assert.deepEqual(boundsMin.task, {
      flash_digits: 1,
      flash_count: 2,
      flash_speed_ms: 200,
      flash_mode: 'add',
    });

    const boundsMax = parseFlashTaskQuery('?task=1&digits=5&count=1000&speed=5000&mode=add_sub');
    assert.deepEqual(boundsMax.task, {
      flash_digits: 5,
      flash_count: 1000,
      flash_speed_ms: 5000,
      flash_mode: 'add_sub',
    });
  });

  it('applyTaskToSettings overrides only the fixed task parameters while preserving last-used values for Any fields', () => {
    const lastUsed = {
      digits: 3,
      count: 20,
      speed_ms: 1200,
      mode: 'add_sub',
    };
    const partialTask = {
      flash_digits: 1,
      flash_count: null,
      flash_speed_ms: 500,
      flash_mode: null,
    };
    const merged = applyTaskToSettings(lastUsed, partialTask);
    assert.deepEqual(merged, {
      digits: 1,
      count: 20,
      speed_ms: 500,
      mode: 'add_sub',
    });
  });
});
