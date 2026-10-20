/**
 * Unit tests for js/stepBoxes.js (Phase 9b-2)
 * Run with: node --test tests/stepBoxes.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pressMultStepKey,
  getMultCheckedBoxes,
  getMultCheckedIndices,
  getMultNextClickBoxIndex,
  clickMultStepBox,
  pressRootStepKey,
  getRootCheckedBoxes,
  getRootCheckedIndices,
  clickRootStepBox,
} from '../js/stepBoxes.js';

describe('js/stepBoxes.js — Multiplications 16-step cyclic step boxes (n = 8)', () => {
  it('presses 1 to 16: 1..8 check 1..8 boxes from the right, 9..15 leave 7..1 boxes on the left, 16 gives none, and repeats', () => {
    let s = 0;
    assert.deepEqual(getMultCheckedIndices(s, 8), []);

    // Presses 1 to 8: check 1 to 8 boxes from the right
    for (let press = 1; press <= 8; press++) {
      s = pressMultStepKey(s, '*', 8);
      assert.equal(s, press);
      const expectedIndices = [];
      for (let i = 8 - press; i < 8; i++) expectedIndices.push(i);
      assert.deepEqual(getMultCheckedIndices(s, 8), expectedIndices);
    }

    // Presses 9 to 15: leave 7 down to 1 boxes on the left (removing check marks from right to left)
    for (let press = 9; press <= 15; press++) {
      s = pressMultStepKey(s, '*', 8);
      assert.equal(s, press);
      const leftRemaining = 16 - press; // 7 down to 1
      const expectedIndices = [];
      for (let i = 0; i < leftRemaining; i++) expectedIndices.push(i);
      assert.deepEqual(getMultCheckedIndices(s, 8), expectedIndices);
    }

    // Press 16: returns to 0 (none checked)
    s = pressMultStepKey(s, '*', 8);
    assert.equal(s, 0);
    assert.deepEqual(getMultCheckedIndices(s, 8), []);
    assert.deepEqual(getMultCheckedBoxes(s, 8), new Array(8).fill(false));

    // Cycle repeats on press 17
    s = pressMultStepKey(s, '*', 8);
    assert.equal(s, 1);
    assert.deepEqual(getMultCheckedIndices(s, 8), [7]);
  });

  it('ignores "/" key in Multiplications stacked format', () => {
    for (let s = 0; s < 16; s++) {
      assert.equal(pressMultStepKey(s, '/', 8), s);
      assert.equal(pressMultStepKey(s, 'unstep', 8), s);
    }
  });

  it('clicking a box acts as "*" only when it is the next box in sequence; other clicks do nothing', () => {
    let s = 0;
    // While growing (s = 0..7), next box is rightmost unchecked (7 down to 0)
    for (let step = 0; step < 8; step++) {
      const targetIdx = 7 - step;
      assert.equal(getMultNextClickBoxIndex(s, 8), targetIdx);

      // Clicking any other box does nothing
      for (let other = 0; other < 8; other++) {
        if (other !== targetIdx) {
          assert.equal(clickMultStepBox(s, other, 8), s);
        }
      }
      // Clicking the target box advances s
      s = clickMultStepBox(s, targetIdx, 8);
      assert.equal(s, step + 1);
    }

    // While shrinking (s = 8..15), next box is rightmost checked (7 down to 0)
    for (let step = 8; step < 16; step++) {
      const targetIdx = 15 - step;
      assert.equal(getMultNextClickBoxIndex(s, 8), targetIdx);

      for (let other = 0; other < 8; other++) {
        if (other !== targetIdx) {
          assert.equal(clickMultStepBox(s, other, 8), s);
        }
      }
      s = clickMultStepBox(s, targetIdx, 8);
      assert.equal(s, (step + 1) % 16);
    }
  });
});

describe('js/stepBoxes.js — Square Roots 6-step bounded step boxes (n = 6)', () => {
  it('checks left-to-right with "*" up to 6 and unchecks right-to-left with "/" down to 0 without wrap-around', () => {
    let c = 0;
    assert.deepEqual(getRootCheckedIndices(c, 6), []);

    for (let i = 1; i <= 6; i++) {
      c = pressRootStepKey(c, '*', 6);
      assert.equal(c, i);
      assert.deepEqual(
        getRootCheckedIndices(c, 6),
        Array.from({ length: i }, (_, idx) => idx)
      );
    }

    // Extra '*' at 6 does not wrap around
    assert.equal(pressRootStepKey(c, '*', 6), 6);

    for (let i = 5; i >= 0; i--) {
      c = pressRootStepKey(c, '/', 6);
      assert.equal(c, i);
      assert.deepEqual(
        getRootCheckedIndices(c, 6),
        Array.from({ length: i }, (_, idx) => idx)
      );
    }

    // Extra '/' at 0 does not wrap around
    assert.equal(pressRootStepKey(c, '/', 6), 0);
    assert.deepEqual(getRootCheckedBoxes(c, 6), new Array(6).fill(false));
  });

  it('clicks leftmost unchecked box to check and rightmost checked box to uncheck; ignores other clicks', () => {
    let c = 0;
    // At c = 0, only box 0 can be clicked to check
    assert.equal(clickRootStepBox(c, 2, 6), 0);
    c = clickRootStepBox(c, 0, 6);
    assert.equal(c, 1);

    // At c = 1, box 1 checks (to 2), box 0 unchecks (to 0), boxes 2..5 do nothing
    assert.equal(clickRootStepBox(c, 3, 6), 1);
    c = clickRootStepBox(c, 1, 6);
    assert.equal(c, 2);

    // Clicking box 1 (rightmost checked) unchecks back to 1
    c = clickRootStepBox(c, 1, 6);
    assert.equal(c, 1);
  });
});
