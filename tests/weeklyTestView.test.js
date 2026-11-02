import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sectionStatusLabel,
  isSectionStartable,
  isSectionResumable,
  isSectionComingSoon,
  nextSection,
  windowText,
  groupTests,
} from '../js/weeklyTestView.js';

describe('weeklyTestView pure helpers (Phase 13a, 16a & 16b)', () => {
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

    it('returns "In progress: n of m tries" when an open flash section is started with tries left', () => {
      assert.equal(
        sectionStatusLabel(
          {
            kind: 'flash',
            attempt: 'started',
            tries_started: 2,
            question_count: 5,
            correct: 1,
            total: 5,
          },
          'open'
        ),
        'In progress: 2 of 5 tries'
      );
    });

    it('returns "Missed" when attempt is started without a score, and "Done: <c> of <t>" when a partial Flash score is recorded and closed', () => {
      assert.equal(
        sectionStatusLabel({ kind: 'basics', attempt: 'started', correct: null, total: null }, 'open'),
        'Missed'
      );
      assert.equal(
        sectionStatusLabel({ kind: 'basics', attempt: 'started', correct: null, total: null }, 'closed'),
        'Missed'
      );
      assert.equal(
        sectionStatusLabel(
          {
            kind: 'flash',
            attempt: 'started',
            tries_started: 2,
            question_count: 5,
            correct: 1,
            total: 5,
          },
          'closed'
        ),
        'Done: 1 of 5'
      );
    });

    it('returns "Missed" when attempt is null and testState is closed', () => {
      assert.equal(
        sectionStatusLabel({ attempt: null, correct: null, total: null }, 'closed'),
        'Missed'
      );
    });
  });

  describe('isSectionStartable, isSectionResumable and isSectionComingSoon', () => {
    it('returns true when testState is open, attempt is null, and kind is basics, elements, flash, or memoriad', () => {
      assert.equal(isSectionStartable({ kind: 'basics', attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ kind: 'flash', attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ kind: 'elements', attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ kind: 'memoriad', attempt: null }, 'open'), true);
      assert.equal(isSectionStartable({ kind: 'round', attempt: null }, 'open'), false);
      assert.equal(isSectionStartable({ attempt: 'started' }, 'open'), false);
      assert.equal(isSectionStartable({ attempt: 'submitted' }, 'open'), false);
      assert.equal(isSectionStartable({ attempt: null }, 'upcoming'), false);
      assert.equal(isSectionStartable({ attempt: null }, 'closed'), false);
    });

    it('marks started flash sections with tries remaining as resumable when test is open', () => {
      assert.equal(
        isSectionResumable(
          { kind: 'flash', attempt: 'started', tries_started: 1, question_count: 3 },
          'open'
        ),
        true
      );
      assert.equal(
        isSectionResumable(
          { kind: 'flash', attempt: 'started', tries_started: 3, question_count: 3 },
          'open'
        ),
        false
      );
      assert.equal(
        isSectionResumable(
          { kind: 'basics', attempt: 'started', tries_started: 0, question_count: 3 },
          'open'
        ),
        false
      );
      assert.equal(
        isSectionResumable(
          { kind: 'flash', attempt: 'started', tries_started: 1, question_count: 3 },
          'closed'
        ),
        false
      );
    });

    it('returns false for isSectionComingSoon now that all online section kinds are playable', () => {
      assert.equal(isSectionComingSoon({ kind: 'flash', attempt: null }, 'open'), false);
      assert.equal(isSectionComingSoon({ kind: 'elements', attempt: null }, 'open'), false);
      assert.equal(isSectionComingSoon({ kind: 'memoriad', attempt: null }, 'open'), false);
      assert.equal(isSectionComingSoon({ kind: 'basics', attempt: null }, 'open'), false);
    });
  });

  describe('nextSection', () => {
    it('returns the first startable or resumable section in position order', () => {
      const sections = [
        { section_id: 's-1', kind: 'basics', category_id: 'cat-1', name: '1d4r', position: 1, attempt: 'submitted' },
        { section_id: 's-flash', kind: 'flash', position: 2, attempt: 'started', tries_started: 1, question_count: 3 },
        { section_id: 's-2', kind: 'basics', category_id: 'cat-2', name: '2d2r', position: 3, attempt: null },
      ];
      const next = nextSection(sections);
      assert.ok(next);
      assert.equal(next.section_id, 's-flash');
    });

    it('skips non-resumable started and submitted sections and returns null when none remain', () => {
      const sections = [
        { category_id: 'cat-1', name: '1d4r', position: 1, attempt: 'submitted' },
        { category_id: 'cat-2', name: '2d2r', position: 2, attempt: 'started' },
        { kind: 'flash', position: 3, attempt: 'started', tries_started: 3, question_count: 3 },
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
