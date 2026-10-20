/**
 * Unit tests for js/memoriadFormat.js (Phase 9b-1)
 * Run with: node --test tests/memoriadFormat.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCalendarDate,
  formatDayLabel,
  getOrderedWeekdays,
} from '../js/memoriadFormat.js';

describe('js/memoriadFormat.js — Date and day label formatting', () => {
  it('formats [year, month, day] triples in DD-MM-YYYY, MM-DD-YYYY, and YYYY-MM-DD', () => {
    assert.equal(formatCalendarDate([1873, 11, 4], 'DD-MM-YYYY'), '04-11-1873');
    assert.equal(formatCalendarDate([1873, 11, 4], 'MM-DD-YYYY'), '11-04-1873');
    assert.equal(formatCalendarDate([1873, 11, 4], 'YYYY-MM-DD'), '1873-11-04');
  });

  it('formats day labels in upper3, short2, and full styles', () => {
    assert.equal(formatDayLabel(0, 'upper3'), 'MON');
    assert.equal(formatDayLabel(5, 'upper3'), 'SAT');
    assert.equal(formatDayLabel(6, 'upper3'), 'SUN');

    assert.equal(formatDayLabel(0, 'short2'), 'Mo');
    assert.equal(formatDayLabel(3, 'short2'), 'Th');
    assert.equal(formatDayLabel(6, 'short2'), 'Su');

    assert.equal(formatDayLabel(0, 'full'), 'Monday');
    assert.equal(formatDayLabel(4, 'full'), 'Friday');
    assert.equal(formatDayLabel(null, 'upper3'), '');
  });

  it('orders the 7 weekday indices starting from leftmostDayIndex', () => {
    assert.deepEqual(getOrderedWeekdays(0), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(getOrderedWeekdays(6), [6, 0, 1, 2, 3, 4, 5]);
    assert.deepEqual(getOrderedWeekdays(2), [2, 3, 4, 5, 6, 0, 1]);
  });
});
