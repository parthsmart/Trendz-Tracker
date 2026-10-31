/**
 * Unit tests for js/periods.js (India time, Monday to Sunday weeks, Last 7 days,
 * and Phase 14c leaderboard period parsing, validation, and range labels)
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
  isValidCalendarYMD,
  validatePeriodDate,
  periodValue,
  parsePeriod,
  periodLabel,
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
  const sameMonth = getLast7DaysBoundsIST('2026-10-28');
  assert.equal(sameMonth.startYmd, '2026-10-22');
  assert.equal(sameMonth.endYmd, '2026-10-28');
  assert.equal(sameMonth.shortRange, '22 to 28 Oct');
  assert.equal(sameMonth.label, 'Last 7 days: 22 to 28 Oct');
  assert.equal(formatLast7DaysPeriodIST('2026-10-28'), 'Last 7 days: 22 to 28 Oct');

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

test('validatePeriodDate: rejects future dates, dates before 2020-01-01, and bad formats; accepts leap day 29 Feb 2028', () => {
  const todayIST = '2028-03-01';

  // Valid regular date and boundary 2020-01-01
  assert.deepEqual(validatePeriodDate('2026-10-30', '2026-10-31'), {
    valid: true,
    dateText: '2026-10-30',
    error: null,
  });
  assert.deepEqual(validatePeriodDate('2020-01-01', todayIST), {
    valid: true,
    dateText: '2020-01-01',
    error: null,
  });

  // Leap day 29 Feb 2028 accepted when todayIST is on or after 2028-02-29
  assert.deepEqual(validatePeriodDate('2028-02-29', todayIST), {
    valid: true,
    dateText: '2028-02-29',
    error: null,
  });
  assert.equal(isValidCalendarYMD('2028-02-29'), true);

  // Non-leap 29 Feb 2026 rejected
  assert.equal(isValidCalendarYMD('2026-02-29'), false);
  const nonLeap = validatePeriodDate('2026-02-29', todayIST);
  assert.equal(nonLeap.valid, false);

  // Future date rejected
  const future = validatePeriodDate('2026-11-01', '2026-10-31');
  assert.equal(future.valid, false);
  assert.equal(future.error, 'The date cannot be in the future.');

  // Date before 2020-01-01 rejected
  const before2020 = validatePeriodDate('2019-12-31', '2026-10-31');
  assert.equal(before2020.valid, false);
  assert.equal(before2020.error, 'The date cannot be before 2020-01-01.');

  // Bad format rejected
  assert.equal(validatePeriodDate('31-10-2026', '2026-10-31').valid, false);
  assert.equal(validatePeriodDate('2026/10/30', '2026-10-31').valid, false);
  assert.equal(validatePeriodDate('2026-4-5', '2026-10-31').valid, false);
  assert.equal(validatePeriodDate('', '2026-10-31').valid, false);
});

test('periodValue builds RPC period strings and returns null for invalid choices or dates', () => {
  const todayIST = '2026-10-31';

  assert.equal(periodValue('today', '', todayIST), 'today');
  assert.equal(periodValue('yesterday', '', todayIST), 'yesterday');
  assert.equal(periodValue('week', '', todayIST), 'week');
  assert.equal(periodValue('month', '', todayIST), 'month');
  assert.equal(periodValue('year', '', todayIST), 'year');
  assert.equal(periodValue('all', '', todayIST), 'all');
  assert.equal(periodValue('date', '2026-10-29', todayIST), 'date:2026-10-29');
  assert.equal(periodValue('date', '2028-02-29', '2028-03-01'), 'date:2028-02-29');

  // Rejects invalid / future / pre-2020 dates
  assert.equal(periodValue('date', '2026-11-01', todayIST), null);
  assert.equal(periodValue('date', '2019-12-31', todayIST), null);
  assert.equal(periodValue('date', 'not-a-date', todayIST), null);
  assert.equal(periodValue('unknown', '', todayIST), null);
});

test('parsePeriod validates simple periods and date:YYYY-MM-DD values', () => {
  const todayIST = '2026-10-31';

  assert.deepEqual(parsePeriod('today', todayIST), {
    choice: 'today',
    dateText: '',
    value: 'today',
  });
  assert.deepEqual(parsePeriod('yesterday', todayIST), {
    choice: 'yesterday',
    dateText: '',
    value: 'yesterday',
  });
  assert.deepEqual(parsePeriod('week', todayIST), {
    choice: 'week',
    dateText: '',
    value: 'week',
  });
  assert.deepEqual(parsePeriod('month', todayIST), {
    choice: 'month',
    dateText: '',
    value: 'month',
  });
  assert.deepEqual(parsePeriod('year', todayIST), {
    choice: 'year',
    dateText: '',
    value: 'year',
  });
  assert.deepEqual(parsePeriod('all', todayIST), {
    choice: 'all',
    dateText: '',
    value: 'all',
  });
  assert.deepEqual(parsePeriod('date:2026-10-29', todayIST), {
    choice: 'date',
    dateText: '2026-10-29',
    value: 'date:2026-10-29',
  });
  assert.deepEqual(parsePeriod('date:2028-02-29', '2028-02-29'), {
    choice: 'date',
    dateText: '2028-02-29',
    value: 'date:2028-02-29',
  });

  // Invalid values return null
  assert.equal(parsePeriod('date:2026-11-05', todayIST), null);
  assert.equal(parsePeriod('date:2019-05-10', todayIST), null);
  assert.equal(parsePeriod('date:2026-02-29', todayIST), null);
  assert.equal(parsePeriod('date:bad', todayIST), null);
  assert.equal(parsePeriod('forever', todayIST), null);
  assert.equal(parsePeriod('', todayIST), null);
  assert.equal(parsePeriod(null, todayIST), null);
});

test('periodLabel formats India-time ranges for today, yesterday, week, month, year, all, and date:YYYY-MM-DD', () => {
  const todayIST = '2026-10-31'; // Saturday 31 Oct 2026

  assert.equal(periodLabel('today', todayIST), 'Today, Sat 31 Oct');
  assert.equal(periodLabel('yesterday', todayIST), 'Yesterday, Fri 30 Oct');
  assert.equal(periodLabel('week', todayIST), '26 Oct to 1 Nov');
  assert.equal(periodLabel('month', todayIST), 'Oct 2026');
  assert.equal(periodLabel('year', todayIST), '2026');
  assert.equal(periodLabel('all', todayIST), 'All time');
  assert.equal(periodLabel('date:2026-10-29', todayIST), 'Thu 29 Oct 2026');
  assert.equal(periodLabel('date:2028-02-29', '2028-03-01'), 'Tue 29 Feb 2028');
});
