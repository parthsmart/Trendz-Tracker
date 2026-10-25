/**
 * Unit Tests for Phase 10b — Daily To-Do Form, Section Options & Student Link Logic
 * (js/todoForm.js)
 *
 * Run with: node --test tests/todoForm.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTaskInput,
  optionsForSection,
  taskLink,
  formatTaskTarget,
  MEMORIAD_MODULES,
} from '../js/todoForm.js';
import { DRILL_CATALOG } from '../js/drillCatalog.js';

const SAMPLE_CATEGORIES = [
  { id: 'uuid-bas-1', name: '1d4r', section: 'basics', active: true },
  { id: 'uuid-bas-2', name: '2d2r', section: 'basics', active: true },
  { id: 'uuid-bas-inactive', name: 'Old Basics', section: 'basics', active: false },
  { id: 'uuid-rnd-1', name: 'ADD', section: 'round', active: true },
  { id: 'uuid-rnd-2', name: 'MULT', section: 'round', active: true },
  { id: 'uuid-rnd-inactive', name: 'Legacy Round', section: 'round', active: false },
];

describe('normalizeTaskInput', () => {
  it('turns empty strings "" and whitespace-only strings into null for category_id, activity_key, and level', () => {
    const resBasics = normalizeTaskInput(
      {
        title: '  Practice 1d4r  ',
        category_id: '   ',
        activity_key: '',
        level: '   ',
        active: true,
      },
      'basics'
    );
    assert.ok(resBasics.value);
    assert.equal(resBasics.value.title, 'Practice 1d4r');
    assert.equal(resBasics.value.section, 'basics');
    assert.equal(resBasics.value.category_id, null);
    assert.equal(resBasics.value.activity_key, null);
    assert.equal(resBasics.value.level, null);
    assert.equal(resBasics.value.active, true);
  });

  it('never sets both category_id and activity_key across any section', () => {
    // 1. basics: sets category_id only, clears activity_key
    const bas = normalizeTaskInput(
      {
        title: 'Speed Basics',
        category_id: 'uuid-bas-1',
        activity_key: 'day_codes',
        level: 'Level 2',
      },
      'basics'
    );
    assert.equal(bas.value.category_id, 'uuid-bas-1');
    assert.equal(bas.value.activity_key, null);
    assert.equal(bas.value.level, 'Level 2');

    // 2. round: sets category_id only, clears activity_key
    const rnd = normalizeTaskInput(
      {
        title: 'Round ADD',
        category_id: 'uuid-rnd-1',
        activity_key: 'calendar',
        level: '',
      },
      'round'
    );
    assert.equal(rnd.value.category_id, 'uuid-rnd-1');
    assert.equal(rnd.value.activity_key, null);
    assert.equal(rnd.value.level, null);

    // 3. elements: sets activity_key only, clears category_id
    const elem = normalizeTaskInput(
      {
        title: 'Day Codes Sprint',
        category_id: 'uuid-bas-1',
        activity_key: 'day_codes',
      },
      'elements'
    );
    assert.equal(elem.value.category_id, null);
    assert.equal(elem.value.activity_key, 'day_codes');

    // 4. memoriad: sets activity_key only, clears category_id
    const mem = normalizeTaskInput(
      {
        title: 'Calendar Dates',
        category_id: 'uuid-rnd-1',
        activity_key: 'calendar',
      },
      'memoriad'
    );
    assert.equal(mem.value.category_id, null);
    assert.equal(mem.value.activity_key, 'calendar');

    // 5. flash: sets neither category_id nor activity_key
    const fl = normalizeTaskInput(
      {
        title: 'Daily Flash Anzan',
        category_id: 'uuid-bas-1',
        activity_key: 'day_codes',
      },
      'flash'
    );
    assert.equal(fl.value.category_id, null);
    assert.equal(fl.value.activity_key, null);
  });

  it('rejects empty title and title of 81 characters (allows 80 characters)', () => {
    const emptyRes = normalizeTaskInput({ title: '   ' }, 'basics');
    assert.ok(emptyRes.errors?.title);

    const exact80 = 'A'.repeat(80);
    const ok80 = normalizeTaskInput({ title: exact80 }, 'basics');
    assert.ok(ok80.value);
    assert.equal(ok80.value.title.length, 80);

    const tooLong81 = 'A'.repeat(81);
    const err81 = normalizeTaskInput({ title: tooLong81 }, 'basics');
    assert.ok(err81.errors?.title);
    assert.equal(err81.value, undefined);
  });

  it('rejects level of 31 characters (allows 30 characters and empty -> null)', () => {
    const exact30 = 'L'.repeat(30);
    const ok30 = normalizeTaskInput({ title: 'Valid Task', level: exact30 }, 'round');
    assert.ok(ok30.value);
    assert.equal(ok30.value.level, exact30);

    const tooLong31 = 'L'.repeat(31);
    const err31 = normalizeTaskInput({ title: 'Valid Task', level: tooLong31 }, 'round');
    assert.ok(err31.errors?.level);
    assert.equal(err31.value, undefined);
  });

  it('rejects unknown sections', () => {
    const badSec = normalizeTaskInput({ title: 'Task' }, 'unknown_sec');
    assert.ok(badSec.errors?.section);
  });
});

describe('optionsForSection', () => {
  it('returns only active basics categories for "basics" and only active round categories for "round" (never mixed)', () => {
    const basicsOpts = optionsForSection('basics', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.deepEqual(basicsOpts, [
      { value: 'uuid-bas-1', label: '1d4r' },
      { value: 'uuid-bas-2', label: '2d2r' },
    ]);

    const roundOpts = optionsForSection('round', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.deepEqual(roundOpts, [
      { value: 'uuid-rnd-1', label: 'ADD' },
      { value: 'uuid-rnd-2', label: 'MULT' },
    ]);
  });

  it('returns only enabled drills from DRILL_CATALOG for "elements" (excludes disabled modulo)', () => {
    const elemOpts = optionsForSection('elements', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.ok(elemOpts.length >= 17);
    assert.ok(elemOpts.some((o) => o.value === 'day_codes' && o.label === 'Day Codes'));
    assert.ok(elemOpts.some((o) => o.value === 'squares_11_50' && o.label === 'Square (11-50)'));
    // modulo is disabled (enabled: false) in DRILL_CATALOG
    assert.equal(elemOpts.some((o) => o.value === 'modulo'), false);
  });

  it('returns the four Memoriad modules for "memoriad"', () => {
    const memOpts = optionsForSection('memoriad', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.deepEqual(memOpts, [
      { value: 'calendar', label: 'Mental Calendar Dates' },
      { value: 'additions', label: 'Mental Additions' },
      { value: 'multiplications', label: 'Mental Multiplications' },
      { value: 'square_roots', label: 'Mental Square Roots' },
    ]);
  });

  it('returns no options for "flash"', () => {
    const flashOpts = optionsForSection('flash', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.deepEqual(flashOpts, []);
  });
});

describe('taskLink', () => {
  it('computes the exact student-side link for every section with and without a target', () => {
    // basics with category
    assert.equal(
      taskLink({ task_section: 'basics', task_category_id: 'uuid-bas-1' }),
      '/pages/basics.html?cat=uuid-bas-1'
    );
    assert.equal(
      taskLink({ section: 'basics', category_id: 'uuid-bas-1' }),
      '/pages/basics.html?cat=uuid-bas-1'
    );

    // basics without category
    assert.equal(
      taskLink({ task_section: 'basics', task_category_id: null }),
      '/pages/basics.html'
    );
    assert.equal(
      taskLink({ section: 'basics', category_id: '' }),
      '/pages/basics.html'
    );

    // round (with or without category -> Round scores screen)
    assert.equal(
      taskLink({ task_section: 'round', task_category_id: 'uuid-rnd-1' }),
      '/pages/round-scores.html'
    );
    assert.equal(
      taskLink({ task_section: 'round', task_category_id: null }),
      '/pages/round-scores.html'
    );

    // elements with activity_key
    assert.equal(
      taskLink({ task_section: 'elements', task_activity_key: 'day_codes' }),
      '/pages/element-drill.html?drill=day_codes'
    );
    assert.equal(
      taskLink({ section: 'elements', activity_key: 'squares_11_50' }),
      '/pages/element-drill.html?drill=squares_11_50'
    );

    // elements without activity_key
    assert.equal(
      taskLink({ task_section: 'elements', task_activity_key: null }),
      '/pages/elements.html'
    );

    // memoriad with activity_key
    assert.equal(
      taskLink({ task_section: 'memoriad', task_activity_key: 'calendar' }),
      '/pages/memoriad-play.html?module=calendar'
    );
    assert.equal(
      taskLink({ section: 'memoriad', activity_key: 'square_roots' }),
      '/pages/memoriad-play.html?module=square_roots'
    );

    // memoriad without activity_key
    assert.equal(
      taskLink({ task_section: 'memoriad', task_activity_key: null }),
      '/pages/memoriad.html'
    );

    // flash
    assert.equal(
      taskLink({ task_section: 'flash', task_category_id: null, task_activity_key: null }),
      '/pages/flash.html'
    );
  });
});

describe('formatTaskTarget', () => {
  it('never returns "Unknown Category" when a task has no specific category or activity', () => {
    assert.deepEqual(
      formatTaskTarget({ section: 'basics', category_id: null }, SAMPLE_CATEGORIES),
      { text: 'Any activity in Basics', isAny: true }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'round', category_id: null }, SAMPLE_CATEGORIES),
      { text: 'Any activity in Round', isAny: true }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'elements', activity_key: null }, SAMPLE_CATEGORIES),
      { text: 'Any activity in Elements', isAny: true }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'memoriad', activity_key: null }, SAMPLE_CATEGORIES),
      { text: 'Any activity in Memoriad', isAny: true }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'flash', category_id: null, activity_key: null }, SAMPLE_CATEGORIES),
      { text: 'Any activity in Flash Anzan', isAny: true }
    );
  });

  it('resolves specific category, drill, and Memoriad module titles', () => {
    assert.deepEqual(
      formatTaskTarget({ section: 'basics', category_id: 'uuid-bas-1' }, SAMPLE_CATEGORIES),
      { text: '1d4r', isAny: false }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'elements', activity_key: 'day_codes' }, SAMPLE_CATEGORIES),
      { text: 'Day Codes', isAny: false }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'memoriad', activity_key: 'multiplications' }, SAMPLE_CATEGORIES),
      { text: 'Mental Multiplications', isAny: false }
    );
  });
});
