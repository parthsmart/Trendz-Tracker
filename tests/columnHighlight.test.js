/**
 * Unit tests for js/columnHighlight.js (Phase 9b-1 & Phase 9b-1b)
 * Run with: node --test tests/columnHighlight.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highlightedColumns } from '../js/columnHighlight.js';

describe('js/columnHighlight.js — Column highlight progression (g = 1 to 4)', () => {
  it('highlights g = 1 column at a time in right-to-left (rtl) mode and clamps at column [0]', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 1, typedCount: 0 }),
      [9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 1, typedCount: 1 }),
      [8]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 1, typedCount: 9 }),
      [0]
    );
    // After the last block, keeps leftmost block [0] highlighted
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 1, typedCount: 11 }),
      [0]
    );
  });

  it('highlights g = 2 columns at a time in right-to-left (rtl) mode and clamps at [0, 1]', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 0 }),
      [8, 9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 1 }),
      [8, 9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 2 }),
      [6, 7]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 8 }),
      [0, 1]
    );
    // After the last block, keeps [0, 1] highlighted
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 10 }),
      [0, 1]
    );
  });

  it('highlights g = 3 columns at a time in rtl mode including shorter leftmost block [0] and after last block', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 3, typedCount: 0 }),
      [7, 8, 9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 3, typedCount: 3 }),
      [4, 5, 6]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 3, typedCount: 6 }),
      [1, 2, 3]
    );
    // Step 3 (typedCount = 9): leftmost partial block has 10 mod 3 = 1 column ([0])
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 3, typedCount: 9 }),
      [0]
    );
    // After the last block (typedCount = 11), keeps [0] highlighted
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 3, typedCount: 11 }),
      [0]
    );
  });

  it('highlights g = 4 columns at a time in rtl mode including shorter leftmost block [0, 1] and after last block', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 4, typedCount: 0 }),
      [6, 7, 8, 9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 4, typedCount: 4 }),
      [2, 3, 4, 5]
    );
    // Step 2 (typedCount = 8): leftmost partial block has 10 mod 4 = 2 columns ([0, 1])
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 4, typedCount: 8 }),
      [0, 1]
    );
    // After the last block (typedCount = 11), keeps [0, 1] highlighted
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 4, typedCount: 11 }),
      [0, 1]
    );
  });

  it('highlights g = 1..4 columns in left-to-right (ltr) mode and clamps at rightmost block', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 1, typedCount: 0 }),
      [0]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 1, typedCount: 11 }),
      [9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 2, typedCount: 2 }),
      [2, 3]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 3, typedCount: 0 }),
      [0, 1, 2]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 3, typedCount: 9 }),
      [9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 4, typedCount: 4 }),
      [4, 5, 6, 7]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 4, typedCount: 8 }),
      [8, 9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 4, typedCount: 11 }),
      [8, 9]
    );
  });

  it('applies manualStepOffset (* step and / unstep)', () => {
    assert.deepEqual(
      highlightedColumns({
        totalColumns: 10,
        direction: 'rtl',
        columnsPerStep: 1,
        typedCount: 0,
        manualStepOffset: 2,
      }),
      [7]
    );
    assert.deepEqual(
      highlightedColumns({
        totalColumns: 10,
        direction: 'rtl',
        columnsPerStep: 1,
        typedCount: 3,
        manualStepOffset: -1,
      }),
      [7]
    );
  });
});
