/**
 * Unit tests for js/memoriadFormat.js (Phase 9b-1 & Phase 10c)
 * Run with: node --test tests/memoriadFormat.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCalendarDate,
  formatDayLabel,
  getOrderedWeekdays,
  MONTH_NAMES_SHORT,
  DATE_FORMATS,
} from '../js/memoriadFormat.js';

describe('js/memoriadFormat.js — Date and day label formatting', () => {
  it('formats [year, month, day] triples in DD-MM-YYYY, MM-DD-YYYY, and YYYY-MM-DD (and defaults to DD-MM-YYYY when missing)', () => {
    assert.equal(formatCalendarDate([1873, 11, 4], 'DD-MM-YYYY'), '04-11-1873');
    assert.equal(formatCalendarDate([1873, 11, 4], 'MM-DD-YYYY'), '11-04-1873');
    assert.equal(formatCalendarDate([1873, 11, 4], 'YYYY-MM-DD'), '1873-11-04');
    assert.equal(formatCalendarDate([1873, 11, 24]), '24-11-1873');
    assert.equal(formatCalendarDate([1873, 11, 24], undefined), '24-11-1873');
    assert.equal(formatCalendarDate([1873, 11, 24], ''), '24-11-1873');
  });

  it('formats 24 Nov 1873 in both "DD Mon YYYY" and "DD-Mon-YYYY" and zero-pads single-digit days', () => {
    assert.ok(DATE_FORMATS.includes('DD Mon YYYY'));
    assert.ok(DATE_FORMATS.includes('DD-Mon-YYYY'));

    assert.equal(formatCalendarDate([1873, 11, 24], 'DD Mon YYYY'), '24 Nov 1873');
    assert.equal(formatCalendarDate([1873, 11, 24], 'DD-Mon-YYYY'), '24-Nov-1873');

    // Single-digit days are zero-padded
    assert.equal(formatCalendarDate([1873, 11, 4], 'DD Mon YYYY'), '04 Nov 1873');
    assert.equal(formatCalendarDate([1873, 11, 4], 'DD-Mon-YYYY'), '04-Nov-1873');
  });

  it('formats all twelve English 3-letter month names (Jan..Dec) in both "DD Mon YYYY" and "DD-Mon-YYYY"', () => {
    const expectedMonths = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    assert.deepEqual(MONTH_NAMES_SHORT, expectedMonths);

    expectedMonths.forEach((mon, idx) => {
      const monthNum = idx + 1;
      assert.equal(
        formatCalendarDate([2026, monthNum, 9], 'DD Mon YYYY'),
        `09 ${mon} 2026`
      );
      assert.equal(
        formatCalendarDate([2026, monthNum, 9], 'DD-Mon-YYYY'),
        `09-${mon}-2026`
      );
    });
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
