/**
 * Unit Tests for Phase 12a — To-Do Progress Display Helpers (js/todoProgress.js)
 *
 * Run with: node --test tests/todoProgress.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { progressText, percent, summary } from '../js/todoProgress.js';

describe('progressText', () => {
  it('shows "d of r" and caps the displayed done count at required_count ("4 of 4" even when 5 were done)', () => {
    assert.equal(progressText(0, 4), '0 of 4');
    assert.equal(progressText(2, 4), '2 of 4');
    assert.equal(progressText(4, 4), '4 of 4');
    assert.equal(progressText(5, 4), '4 of 4');
    assert.equal(progressText(12, 4), '4 of 4');
    assert.equal(progressText(1, 1), '1 of 1');
  });

  it('supports passing a task object { done_count, required_count } directly', () => {
    assert.equal(progressText({ done_count: 2, required_count: 4 }), '2 of 4');
    assert.equal(progressText({ done_count: 5, required_count: 4 }), '4 of 4');
    assert.equal(progressText({ done_count: 0, required_count: 1 }), '0 of 1');
  });
});

describe('percent', () => {
  it('computes integer percentage capped at 100', () => {
    assert.equal(percent(0, 4), 0);
    assert.equal(percent(1, 4), 25);
    assert.equal(percent(2, 4), 50);
    assert.equal(percent(3, 4), 75);
    assert.equal(percent(4, 4), 100);
    assert.equal(percent(5, 4), 100);
    assert.equal(percent(10, 4), 100);
  });

  it('supports passing a task object { done_count, required_count } directly', () => {
    assert.equal(percent({ done_count: 2, required_count: 4 }), 50);
    assert.equal(percent({ done_count: 7, required_count: 4 }), 100);
  });
});

describe('summary', () => {
  it('returns "n of m tasks done today" strictly from task.done without recomputing done in JS', () => {
    const emptyRes = summary([]);
    assert.equal(emptyRes.done, 0);
    assert.equal(emptyRes.total, 0);
    assert.equal(emptyRes.text, '0 of 0 tasks done today');
    assert.equal(String(emptyRes), '0 of 0 tasks done today');

    const tasks = [
      { task_id: 't1', done_count: 4, required_count: 4, done: true },
      { task_id: 't2', done_count: 2, required_count: 4, done: false },
      { task_id: 't3', done_count: 1, required_count: 1, done: true },
    ];
    const res = summary(tasks);
    assert.equal(res.done, 2);
    assert.equal(res.total, 3);
    assert.equal(res.text, '2 of 3 tasks done today');

    // Verify JS never recomputes done from done_count >= required_count if database returned done: false
    const dbAuthoritativeCheck = summary([
      { task_id: 't4', done_count: 5, required_count: 4, done: false },
    ]);
    assert.equal(dbAuthoritativeCheck.done, 0);
    assert.equal(dbAuthoritativeCheck.total, 1);
    assert.equal(dbAuthoritativeCheck.text, '0 of 1 tasks done today');
  });
});
