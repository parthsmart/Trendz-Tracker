import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from '../js/formPattern.js';

test('shouldOpenMoreOptions returns false on create flows even if values exist', () => {
  assert.equal(shouldOpenMoreOptions(['Level 2', '500'], false), false);
  assert.equal(shouldOpenMoreOptions({ level: 'Level 2' }, false), false);
});

test('shouldOpenMoreOptions returns false when editing but all optional fields are empty or Any', () => {
  assert.equal(shouldOpenMoreOptions(['', null, undefined, 'any', 'ANY', false], true), false);
  assert.equal(shouldOpenMoreOptions({ level: '', flash_digits: null, active: false }, true), false);
});

test('shouldOpenMoreOptions returns true when editing and at least one optional value is set', () => {
  assert.equal(shouldOpenMoreOptions(['', 'Level 3'], true), true);
  assert.equal(shouldOpenMoreOptions({ level: '', flash_digits: 2 }, true), true);
  assert.equal(shouldOpenMoreOptions([null, '1:08:37'], true), true);
  assert.equal(shouldOpenMoreOptions([true], true), true);
});

test('buildModalLiveSummary builds calm single-line summaries for all 8 modal kinds', () => {
  assert.equal(
    buildModalLiveSummary('todo', {
      section: 'flash',
      targetSummary: '1 digit, 50 numbers, 0.5 s, add only',
      required_count: 1,
      level: '',
      active: true,
    }),
    'Flash: 1 digit, 50 numbers, 0.5 s, add only, 1 try per day, all levels'
  );

  assert.equal(
    buildModalLiveSummary('todo', {
      section: 'basics',
      targetSummary: '1d4r',
      required_count: 2,
      level: 'Level 2',
      active: false,
    }),
    'Basics: 1d4r, 2 rounds per day, Level 2, inactive'
  );

  assert.equal(
    buildModalLiveSummary('weeklyTest', {
      test_type: 'online',
      title: 'Sprint #12',
      test_date: '2026-10-31',
      sections_count: 3,
      audience_level: 'Level 3',
    }),
    'Online test: Sprint #12 on 2026-10-31, 3 sections, Level 3'
  );

  assert.equal(
    buildModalLiveSummary('profile', {
      full_name: 'Aarav Sharma',
      student_code: 'STU101',
      level: 'Level 3',
      active: true,
      leaderboard_visible: false,
    }),
    'Profile: Aarav Sharma (STU101), Level 3, active, hidden from leaderboards'
  );

  assert.equal(
    buildModalLiveSummary('target', {
      category_name: '1d4r',
      min_accuracy: '95',
      min_qpm: '18',
      max_time: '2:00',
      level: 'Level 2',
      active: true,
    }),
    'Target: 1d4r, 95% min accuracy, Level 2, 18 q/min, max 2:00'
  );

  assert.equal(
    buildModalLiveSummary('resource', {
      title: 'Championship Guide',
      topic: 'Rules',
      active: true,
    }),
    'Resource: Championship Guide, topic Rules, active'
  );

  assert.equal(
    buildModalLiveSummary('announcement', {
      title: 'Sunday Mock Schedule',
      audience_level: 'Level 4',
      ends_at: '2026-11-05',
    }),
    'Announcement: Sunday Mock Schedule, for Level 4, hides after 2026-11-05'
  );

  assert.equal(
    buildModalLiveSummary('attendance', {
      title: 'Workshop #14',
      session_type: 'workshop',
      session_date: '2026-10-31',
    }),
    'Attendance: Workshop #14 (workshop) on 2026-10-31'
  );

  assert.equal(
    buildModalLiveSummary('round', {
      series_name: 'New simulator',
      round_number: '12',
      round_type: 'Category wise',
      round_date: '2026-10-31',
      time_taken: '45:00',
    }),
    'New simulator, Round 12: Category wise on 2026-10-31, time 45:00'
  );
});

test('setMoreOptionsOpen toggles open attribute and property safely', () => {
  const attrs = new Set();
  const fakeDetails = {
    open: false,
    setAttribute(k) { attrs.add(k); },
    removeAttribute(k) { attrs.delete(k); },
  };

  setMoreOptionsOpen(fakeDetails, true);
  assert.equal(fakeDetails.open, true);
  assert.equal(attrs.has('open'), true);

  setMoreOptionsOpen(fakeDetails, false);
  assert.equal(fakeDetails.open, false);
  assert.equal(attrs.has('open'), false);
});
