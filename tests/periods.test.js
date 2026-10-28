/**
 * Unit tests for js/periods.js (India time, Monday to Sunday weeks, Last 7 days)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getISTDateYMD,
  formatTodayHeadingIST,
  formatShortRangeIST,
  getWeekBoundsIST,
  formatWeekPeriodIST,
  getLast7DaysBoundsIST,
  formatLast7DaysPeriodIST,
} from '../js/periods.js';

test('getISTDateYMD converts UTC timestamps across midnight into India time (UTC+5:30)', () => {
  // 2026-10-27 20:00:00 UTC is 2026-10-28 01:30:00 IST
  assert.equal(getISTDateYMD(new Date('2026-10-27T20:00:00.000Z')), '2026-10-28');
  // 2026-10-28 18:29:59 UTC is 2026-10-28 23:59:59 IST
  assert.equal(getISTDateYMD(new Date('2026-10-28T18:29:59.000Z')), '2026-10-28');
  // 2026-10-28 18:30:00 UTC is 2026-10-29 00:00:00 IST
  assert.equal(getISTDateYMD(new Date('2026-10-28T18:30:00.000Z')), '2026-10-29');
});

test('getWeekBoundsIST and formatWeekPeriodIST compute Monday to Sunday week in India time', () => {
  // Wednesday 28 Oct 2026 -> Mon 26 Oct to Sun 1 Nov
  const wed = getWeekBoundsIST('2026-10-28');
  assert.equal(wed.startYmd, '2026-10-26');
  assert.equal(wed.endYmd, '2026-11-01');
  assert.equal(wed.rangeText, 'Mon 26 Oct to Sun 1 Nov');
  assert.equal(wed.label, 'This week: Mon 26 Oct to Sun 1 Nov');
  assert.equal(formatWeekPeriodIST('2026-10-28'), 'Mon 26 Oct to Sun 1 Nov');

  // Sunday 1 Nov 2026 belongs to the same Mon 26 Oct to Sun 1 Nov week
  const sun = getWeekBoundsIST('2026-11-01');
  assert.equal(sun.startYmd, '2026-10-26');
  assert.equal(sun.endYmd, '2026-11-01');
  assert.equal(sun.rangeText, 'Mon 26 Oct to Sun 1 Nov');

  // Monday 26 Oct 2026 is the first day of that week
  const mon = getWeekBoundsIST('2026-10-26');
  assert.equal(mon.startYmd, '2026-10-26');
  assert.equal(mon.endYmd, '2026-11-01');
});

test('getLast7DaysBoundsIST and formatLast7DaysPeriodIST compute inclusive 7-day window in India time', () => {
  // 28 Oct 2026 -> 22 to 28 Oct (7 days inclusive: 22,23,24,25,26,27,28)
  const sameMonth = getLast7DaysBoundsIST('2026-10-28');
  assert.equal(sameMonth.startYmd, '2026-10-22');
  assert.equal(sameMonth.endYmd, '2026-10-28');
  assert.equal(sameMonth.shortRange, '22 to 28 Oct');
  assert.equal(sameMonth.label, 'Last 7 days: 22 to 28 Oct');
  assert.equal(formatLast7DaysPeriodIST('2026-10-28'), 'Last 7 days: 22 to 28 Oct');

  // Crossing month boundary: 4 Oct 2026 -> 28 Sep to 4 Oct
  const crossMonth = getLast7DaysBoundsIST('2026-10-04');
  assert.equal(crossMonth.startYmd, '2026-09-28');
  assert.equal(crossMonth.endYmd, '2026-10-04');
  assert.equal(crossMonth.shortRange, '28 Sep to 4 Oct');
  assert.equal(crossMonth.label, 'Last 7 days: 28 Sep to 4 Oct');
});

test('formatShortRangeIST and formatTodayHeadingIST format dates cleanly', () => {
  assert.equal(formatShortRangeIST('2026-10-22', '2026-10-28'), '22 to 28 Oct');
  assert.equal(formatShortRangeIST('2026-09-28', '2026-10-04'), '28 Sep to 4 Oct');
  assert.equal(formatShortRangeIST('2026-12-28', '2027-01-03'), '28 Dec 2026 to 3 Jan 2027');
  assert.equal(formatTodayHeadingIST('2026-10-28'), 'Wednesday, 28 Oct 2026');
});
