import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionStatusLabel,
  isSectionStartable,
  nextSection,
  windowText,
  groupTests,
} from '../js/weeklyTestView.js';

describe('weeklyTestView pure helpers (Phase 13a)', () => {
  describe('sectionStatusLabel', () => {
    it('returns "To do" when attempt is null and test is open or upcoming', () => {
      assert.equal(sectionStatusLabel({ attempt: null, correct: null, total: null }, 'open'), 'To do');
      assert.equal(sectionStatusLabel({ attempt: null, correct: null, total: null }, 'upcoming'), 'To do');
    });

    it('returns "Done: <correct> of <total>" when attempt is submitted', () => {
      assert.equal(
        sectionStatusLabel({ attempt: 'submitted', correct: 18, total: 20 }, 'open'),
        'Done: 18 of 20'
      );
      assert.equal(
        sectionStatusLabel({ attempt: 'submitted', correct: 0, total: 0 }, 'closed'),
        'Done: 0 of 0'
      );
    });

    it('returns "Missed" when attempt is started without a score (abandoned or closed)', () => {
      assert.equal(
        sectionStatusLabel({ attempt: 'started', correct: null, total: null }, 'open'),
        'Missed'
      );
      assert.equal(
        sectionStatusLabel({ attempt: 'started', correct: null, total: null }, 'closed'),
        'Missed'
      );
    });

    it('returns "Missed" when attempt is null and testState is closed', () => {
      assert.equal(
        sectionStatusLabel({ attempt: null, correct: null, total: null }, 'closed'),
        'Missed'
      );
    });
  });

  describe('isSectionStartable', () => {
    it('returns true only when testState is open and attempt is null', () => {
      assert.equal(isSectionStartable({ attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ attempt: 'started' }, 'open'), false);
      assert.equal(isSectionStartable({ attempt: 'submitted' }, 'open'), false);
      assert.equal(isSectionStartable({ attempt: null }, 'upcoming'), false);
      assert.equal(isSectionStartable({ attempt: null }, 'closed'), false);
    });
  });

  describe('nextSection', () => {
    it('returns the first section in position order with attempt === null', () => {
      const sections = [
        { category_id: 'cat-2', name: '2d2r', position: 2, attempt: null },
        { category_id: 'cat-1', name: '1d4r', position: 1, attempt: 'submitted' },
        { category_id: 'cat-3', name: '1dx1d', position: 3, attempt: null },
      ];
      const next = nextSection(sections);
      assert.ok(next);
      assert.equal(next.category_id, 'cat-2');
    });

    it('skips both started and submitted sections and returns null when none remain', () => {
      const sections = [
        { category_id: 'cat-1', name: '1d4r', position: 1, attempt: 'submitted' },
        { category_id: 'cat-2', name: '2d2r', position: 2, attempt: 'started' },
      ];
      assert.equal(nextSection(sections), null);
      assert.equal(nextSection([]), null);
    });
  });

  describe('windowText', () => {
    it('returns "All day (India time)" when both opens_at and closes_at are empty', () => {
      assert.equal(windowText(null, null), 'All day (India time)');
      assert.equal(windowText('', undefined), 'All day (India time)');
    });

    it('formats same-day IST opening and closing times cleanly', () => {
      // 2026-10-18T04:30:00Z = 10:00 AM IST; 2026-10-18T12:30:00Z = 6:00 PM IST
      const text = windowText('2026-10-18T04:30:00.000Z', '2026-10-18T12:30:00.000Z');
      assert.equal(text, '10:00 AM to 6:00 PM IST');
    });

    it('includes IST dates when opening and closing span multiple days', () => {
      const text = windowText('2026-10-18T04:30:00.000Z', '2026-10-19T12:30:00.000Z');
      assert.ok(text.includes('10:00 AM'));
      assert.ok(text.includes('6:00 PM IST'));
      assert.ok(text.includes('Oct'));
    });
  });

  describe('groupTests', () => {
    it('partitions tests into availableNow, upcoming, and past in expected date order', () => {
      const sample = [
        { id: 't-past-1', title: 'Old Offline', type: 'offline', state: 'past', test_date: '2026-10-04' },
        { id: 't-open-1', title: 'Open Online', type: 'online', state: 'open', test_date: '2026-10-18' },
        { id: 't-up-2', title: 'Later Upcoming', type: 'online', state: 'upcoming', test_date: '2026-11-01' },
        { id: 't-up-1', title: 'Sooner Upcoming', type: 'offline', state: 'upcoming', test_date: '2026-10-25' },
        { id: 't-closed-1', title: 'Closed Online', type: 'online', state: 'closed', test_date: '2026-10-11' },
        { id: 't-today-1', title: 'Today Offline', type: 'offline', state: 'today', test_date: '2026-10-18' },
      ];

      const grouped = groupTests(sample);
      assert.equal(grouped.availableNow.length, 2);
      assert.deepEqual(
        grouped.availableNow.map((t) => t.id),
        ['t-open-1', 't-today-1']
      );

      assert.equal(grouped.upcoming.length, 2);
      assert.deepEqual(
        grouped.upcoming.map((t) => t.id),
        ['t-up-1', 't-up-2']
      );

      assert.equal(grouped.past.length, 2);
      assert.deepEqual(
        grouped.past.map((t) => t.id),
        ['t-closed-1', 't-past-1']
      );
    });
  });
});
