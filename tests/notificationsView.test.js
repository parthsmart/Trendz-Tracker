import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  stageLabel,
  groupNotifications,
  badgeText,
  formatEventDateChipIST,
  sanitizeNotificationLink,
} from '../js/notificationsView.js';

describe('notificationsView pure helpers (Phase 13b)', () => {
  describe('stageLabel', () => {
    it('returns "Today" when days_left is 0 (or negative)', () => {
      assert.equal(stageLabel(0), 'Today');
      assert.equal(stageLabel('0'), 'Today');
      assert.equal(stageLabel(-1), 'Today');
    });

    it('returns "Tomorrow" when days_left is 1', () => {
      assert.equal(stageLabel(1), 'Tomorrow');
      assert.equal(stageLabel('1'), 'Tomorrow');
    });

    it('returns "In N days" when days_left is 2 or more', () => {
      assert.equal(stageLabel(2), 'In 2 days');
      assert.equal(stageLabel(4), 'In 4 days');
      assert.equal(stageLabel(14), 'In 14 days');
    });

    it('returns empty string when days_left is null, undefined, empty, or NaN', () => {
      assert.equal(stageLabel(null), '');
      assert.equal(stageLabel(undefined), '');
      assert.equal(stageLabel(''), '');
      assert.equal(stageLabel('abc'), '');
    });
  });

  describe('groupNotifications', () => {
    it('partitions items into Weekly tests and Announcements while preserving order', () => {
      const items = [
        {
          ref: 'test:wkt-1:today',
          kind: 'test_today',
          title: 'Sunday Speed Sprint',
          days_left: 0,
        },
        {
          ref: 'ann:ann-1',
          kind: 'announcement',
          title: 'Holiday Timings Update',
          days_left: null,
        },
        {
          ref: 'test:wkt-2:upcoming',
          kind: 'test_upcoming',
          title: 'November Mock Test',
          days_left: 4,
        },
        {
          ref: 'ann:ann-2',
          kind: 'announcement',
          title: 'Bring Practice Sheets',
          days_left: null,
        },
      ];

      const grouped = groupNotifications(items);
      assert.equal(grouped.tests.length, 2);
      assert.deepEqual(
        grouped.tests.map((i) => i.ref),
        ['test:wkt-1:today', 'test:wkt-2:upcoming']
      );
      assert.equal(grouped.announcements.length, 2);
      assert.deepEqual(
        grouped.announcements.map((i) => i.ref),
        ['ann:ann-1', 'ann:ann-2']
      );
      assert.deepEqual(grouped.weeklyTests, grouped.tests);
    });

    it('handles empty or non-array inputs safely', () => {
      assert.deepEqual(groupNotifications([]), {
        tests: [],
        weeklyTests: [],
        announcements: [],
      });
      assert.deepEqual(groupNotifications(null), {
        tests: [],
        weeklyTests: [],
        announcements: [],
      });
    });
  });

  describe('badgeText', () => {
    it('returns empty string at 0 or below so the badge is hidden', () => {
      assert.equal(badgeText(0), '');
      assert.equal(badgeText(-3), '');
      assert.equal(badgeText(null), '');
      assert.equal(badgeText(undefined), '');
      assert.equal(badgeText(''), '');
    });

    it('returns exact string for counts 1 through 9', () => {
      assert.equal(badgeText(1), '1');
      assert.equal(badgeText(5), '5');
      assert.equal(badgeText(9), '9');
    });

    it('returns "9+" when count is above 9', () => {
      assert.equal(badgeText(10), '9+');
      assert.equal(badgeText(15), '9+');
      assert.equal(badgeText(99), '9+');
    });
  });

  describe('formatEventDateChipIST & sanitizeNotificationLink', () => {
    it('formats YYYY-MM-DD into "Sun 2 Nov" style date chip', () => {
      // 2025-11-02 is a Sunday
      assert.equal(formatEventDateChipIST('2025-11-02'), 'Sun 2 Nov');
      // 2026-11-01 is a Sunday
      assert.equal(formatEventDateChipIST('2026-11-01'), 'Sun 1 Nov');
    });

    it('allows only internal relative paths for notification links', () => {
      assert.equal(
        sanitizeNotificationLink('/pages/weekly-test.html'),
        '/pages/weekly-test.html'
      );
      assert.equal(
        sanitizeNotificationLink('https://evil.example.com'),
        '/pages/student.html'
      );
      assert.equal(
        sanitizeNotificationLink('javascript:alert(1)'),
        '/pages/student.html'
      );
    });
  });
});
