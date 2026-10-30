import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWeeklyTestShareMessage,
  shortenNotes,
  formatWeekdayDayMonthIST,
  formatReminderStartPreview,
} from '../js/reportMessage.js';

describe('reportMessage pure helpers (Phase 13b)', () => {
  describe('formatWeekdayDayMonthIST', () => {
    it('formats YYYY-MM-DD into "<weekday, day month>" in India time', () => {
      // 2025-11-02 is Sunday
      assert.equal(formatWeekdayDayMonthIST('2025-11-02'), 'Sun, 2 Nov');
      // 2026-10-31 is Saturday
      assert.equal(formatWeekdayDayMonthIST('2026-10-31'), 'Sat, 31 Oct');
    });
  });

  describe('shortenNotes', () => {
    it('collapses whitespace and truncates notes longer than 120 characters to 120 characters', () => {
      assert.equal(shortenNotes('   Bring   abacus\nand pencil  '), 'Bring abacus and pencil');

      const longNotes = 'A'.repeat(150);
      const shortened = shortenNotes(longNotes);
      assert.equal(shortened.length, 120);
      assert.equal(shortened, 'A'.repeat(120));
    });
  });

  describe('buildWeeklyTestShareMessage', () => {
    it('builds exact share text for an online weekly test with notes', () => {
      const msg = buildWeeklyTestShareMessage({
        title: 'Sunday Speed Sprint #12',
        test_date: '2025-11-02',
        test_type: 'online',
        notes: 'Complete all 3 sections before 8 PM IST.',
      });

      assert.equal(
        msg,
        'Weekly test: Sunday Speed Sprint #12 on Sun, 2 Nov. Online on the Trendz Tracker website. Complete all 3 sections before 8 PM IST.'
      );
    });

    it('builds exact share text for an offline weekly test and shortens notes to 120 chars', () => {
      const notes135 =
        'Please arrive 10 minutes early with two sharpened pencils, your abacus, and your practice notebook for round verification with trainer.';
      assert.ok(notes135.length > 120);

      const msg = buildWeeklyTestShareMessage({
        title: 'Junior 2 Paper Mock',
        test_date: '2026-10-31',
        test_type: 'offline',
        notes: notes135,
      });

      const expectedNotes = notes135.slice(0, 120).trimEnd();
      assert.equal(
        msg,
        `Weekly test: Junior 2 Paper Mock on Sat, 31 Oct. With your trainer. ${expectedNotes}`
      );
    });

    it('omits trailing notes cleanly when notes are empty', () => {
      const msg = buildWeeklyTestShareMessage({
        title: 'Level 1 Assessment',
        test_date: '2025-11-02',
        test_type: 'offline',
        notes: '   ',
      });

      assert.equal(
        msg,
        'Weekly test: Level 1 Assessment on Sun, 2 Nov. With your trainer.'
      );
    });
  });

  describe('formatReminderStartPreview', () => {
    it('computes the reminder start date N days before the test date', () => {
      assert.equal(
        formatReminderStartPreview('2026-11-08', 7),
        'Students will see a reminder from 1 Nov until the test day.'
      );
      assert.equal(
        formatReminderStartPreview('2026-11-02', 4),
        'Students will see a reminder from 29 Oct until the test day.'
      );
      assert.equal(
        formatReminderStartPreview('2026-11-02', 0),
        'Students will see a reminder from 2 Nov until the test day.'
      );
    });
  });
});
