/**
 * Unit tests for js/columnHighlight.js (Phase 9b-1)
 * Run with: node --test tests/columnHighlight.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highlightedColumns } from '../js/columnHighlight.js';

describe('js/columnHighlight.js — Column highlight progression', () => {
  it('highlights 1 column at a time in right-to-left (rtl) mode and clamps at column 0', () => {
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
    // Clamps at leftmost column 0 when 10 or 11 digits are typed
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 1, typedCount: 11 }),
      [0]
    );
  });

  it('highlights 2 columns at a time in right-to-left (rtl) mode and clamps at [0, 1]', () => {
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
      highlightedColumns({ totalColumns: 10, direction: 'rtl', columnsPerStep: 2, typedCount: 10 }),
      [0, 1]
    );
  });

  it('highlights 1 or 2 columns in left-to-right (ltr) mode and clamps at rightmost columns', () => {
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 1, typedCount: 0 }),
      [0]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 1, typedCount: 3 }),
      [3]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 1, typedCount: 11 }),
      [9]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 2, typedCount: 0 }),
      [0, 1]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 2, typedCount: 2 }),
      [2, 3]
    );
    assert.deepEqual(
      highlightedColumns({ totalColumns: 10, direction: 'ltr', columnsPerStep: 2, typedCount: 10 }),
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
