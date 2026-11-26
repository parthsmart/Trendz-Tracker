import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClass,
  canJoin,
  groupClasses,
  countdownLabel,
  dayLabel,
  timeLabel,
  buildIcs,
} from '../js/studentLiveClassesView.js';

// 2026-11-26 10:00 IST
const NOW = Date.parse('2026-11-26T04:30:00Z');
const MIN = 60 * 1000;
const at = (offsetMin) => new Date(NOW + offsetMin * MIN).toISOString();
const cls = (id, offsetMin, extra = {}) => ({
  id, title: `Class ${id}`, teacher_name: 'Asha', scheduled_start_time: at(offsetMin),
  duration_minutes: 60, status: 'scheduled', provider_status: 'scheduled', ...extra,
});

test('classifyClass covers every state', () => {
  assert.equal(classifyClass(cls('a', -5, { status: 'live' }), NOW), 'live');
  assert.equal(classifyClass(cls('b', -5), NOW), 'starting');
  assert.equal(classifyClass(cls('c', 10), NOW), 'soon');
  assert.equal(classifyClass(cls('d', 120), NOW), 'upcoming');
  assert.equal(classifyClass(cls('e', -30, { status: 'ended' }), NOW), 'past');
  assert.equal(classifyClass(cls('f', -30, { provider_status: 'completed' }), NOW), 'past');
  // Never went live and its window is over.
  assert.equal(classifyClass(cls('g', -90), NOW), 'past');
});

test('join is offered only for live, starting and soon classes', () => {
  assert.deepEqual(['live', 'starting', 'soon', 'upcoming', 'past'].map(canJoin), [true, true, true, false, false]);
});

test('groupClasses splits live, upcoming by IST day and past', () => {
  const groups = groupClasses([
    cls('later-today', 180),
    cls('tomorrow', 24 * 60),
    cls('live', -10, { status: 'live' }),
    cls('starting', -2),
    cls('old', -3 * 24 * 60, { status: 'ended' }),
    cls('older', -5 * 24 * 60, { status: 'ended' }),
    cls('gone', 60, { status: 'cancelled' }),
  ], NOW);
  assert.deepEqual(groups.live.map((c) => c.id), ['live', 'starting']);
  assert.deepEqual(groups.upcoming.map((d) => d.label), ['Today', 'Tomorrow']);
  assert.equal(groups.next.id, 'later-today');
  assert.deepEqual(groups.past.map((c) => c.id), ['old', 'older']);
});

test('labels use IST', () => {
  assert.equal(timeLabel(Date.parse('2026-11-26T12:00:00Z')), '5:30 PM');
  assert.equal(dayLabel(Date.parse('2026-11-26T19:00:00Z'), NOW), 'Tomorrow'); // 00:30 IST on the 27th
  assert.equal(dayLabel(Date.parse('2026-11-29T06:00:00Z'), NOW), 'Sun, 29 Nov');
  assert.equal(countdownLabel(NOW + 45 * MIN, NOW), 'in 45 min');
  assert.equal(countdownLabel(NOW + 125 * MIN, NOW), 'in 2 h 5 min');
  assert.equal(countdownLabel(NOW + 3 * 24 * 60 * MIN, NOW), 'in 3 days');
  assert.equal(countdownLabel(NOW - MIN, NOW), '');
});

test('buildIcs makes a calendar event with escaped text and a reminder', () => {
  const ics = buildIcs(cls('x1', 60, { title: 'Level 2, speed; drills' }), 'https://example.test/r?classId=x1', NOW);
  assert.match(ics, /DTSTART:20261126T053000Z/);
  assert.match(ics, /DTEND:20261126T063000Z/);
  assert.match(ics, /SUMMARY:Level 2\\, speed\\; drills/);
  assert.match(ics, /TRIGGER:-PT10M/);
  assert.equal(buildIcs({ id: 'n', scheduled_start_time: null }, 'u', NOW), '');
});
