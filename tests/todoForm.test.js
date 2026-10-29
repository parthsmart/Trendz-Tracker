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
  isTaskActivityAvailable,
  requiredCountLabelForSection,
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
    assert.equal(resBasics.value.required_count, 1);
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

  it('validates required_count: rejects 0, 51, 2.5, "abc", defaults empty to 1, and accepts 4', () => {
    // 0 -> rejected
    const err0 = normalizeTaskInput({ title: 'Task', required_count: 0 }, 'basics');
    assert.ok(err0.errors?.required_count);
    assert.equal(err0.value, undefined);

    const err0Str = normalizeTaskInput({ title: 'Task', required_count: '0' }, 'basics');
    assert.ok(err0Str.errors?.required_count);

    // 51 -> rejected
    const err51 = normalizeTaskInput({ title: 'Task', required_count: 51 }, 'basics');
    assert.ok(err51.errors?.required_count);
    assert.equal(err51.value, undefined);

    const err51Str = normalizeTaskInput({ title: 'Task', required_count: '51' }, 'basics');
    assert.ok(err51Str.errors?.required_count);

    // 2.5 -> rejected
    const errFloat = normalizeTaskInput({ title: 'Task', required_count: 2.5 }, 'basics');
    assert.ok(errFloat.errors?.required_count);
    assert.equal(errFloat.value, undefined);

    const errFloatStr = normalizeTaskInput({ title: 'Task', required_count: '2.5' }, 'basics');
    assert.ok(errFloatStr.errors?.required_count);

    // "abc" -> rejected
    const errAbc = normalizeTaskInput({ title: 'Task', required_count: 'abc' }, 'basics');
    assert.ok(errAbc.errors?.required_count);
    assert.equal(errAbc.value, undefined);

    // empty ("", "   ", null, undefined) -> becomes 1
    for (const emptyVal of ['', '   ', null, undefined]) {
      const okEmpty = normalizeTaskInput({ title: 'Task', required_count: emptyVal }, 'basics');
      assert.ok(okEmpty.value);
      assert.equal(okEmpty.value.required_count, 1);
    }

    // 4 (number and string) -> accepted as 4
    const ok4Num = normalizeTaskInput({ title: 'Task', required_count: 4 }, 'basics');
    assert.ok(ok4Num.value);
    assert.equal(ok4Num.value.required_count, 4);

    const ok4Str = normalizeTaskInput({ title: 'Task', required_count: ' 4 ' }, 'basics');
    assert.ok(ok4Str.value);
    assert.equal(ok4Str.value.required_count, 4);

    // Boundary 50 -> accepted as 50
    const ok50 = normalizeTaskInput({ title: 'Task', required_count: 50 }, 'elements');
    assert.ok(ok50.value);
    assert.equal(ok50.value.required_count, 50);
  });

  it('returns section-specific labels from requiredCountLabelForSection', () => {
    assert.equal(requiredCountLabelForSection('basics'), 'Rounds per day');
    assert.equal(requiredCountLabelForSection('round'), 'Rounds per day');
    assert.equal(requiredCountLabelForSection('elements'), 'Sets per day');
    assert.equal(requiredCountLabelForSection('flash'), 'Tries per day');
    assert.equal(requiredCountLabelForSection('memoriad'), 'Rounds per day');
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

  it('returns only enabled drills from DRILL_CATALOG for "elements" (includes all 10 staged drills, excludes the 4 old drills and disabled modulo)', () => {
    const elemOpts = optionsForSection('elements', SAMPLE_CATEGORIES, DRILL_CATALOG, MEMORIAD_MODULES);
    assert.equal(elemOpts.length, 23); // 24 total drills minus 1 disabled (modulo)
    assert.ok(elemOpts.some((o) => o.value === 'day_codes' && o.label === 'Day Codes'));

    const tenNewDrills = [
      { value: 'squares_stage_1', label: 'Square - Stage 1 (1-25)' },
      { value: 'squares_stage_2', label: 'Square - Stage 2 (26-50)' },
      { value: 'squares_stage_3', label: 'Square - Stage 3 (51-75)' },
      { value: 'squares_stage_4', label: 'Square - Stage 4 (76-100)' },
      { value: 'squares_combined', label: 'Square - Combined (1-100)' },
      { value: 'cubes_stage_1', label: 'Cube - Stage 1 (1-25)' },
      { value: 'cubes_stage_2', label: 'Cube - Stage 2 (26-50)' },
      { value: 'cubes_stage_3', label: 'Cube - Stage 3 (51-75)' },
      { value: 'cubes_stage_4', label: 'Cube - Stage 4 (76-100)' },
      { value: 'cubes_combined', label: 'Cube - Combined (1-100)' },
    ];
    for (const expected of tenNewDrills) {
      assert.ok(
        elemOpts.some((o) => o.value === expected.value && o.label === expected.label),
        `Expected ${expected.value} (${expected.label}) in optionsForSection('elements')`
      );
    }

    for (const removedKey of ['squares_11_50', 'squares_51_100', 'cubes_11_50', 'cubes_51_100']) {
      assert.equal(
        elemOpts.some((o) => o.value === removedKey),
        false,
        `Old drill ${removedKey} must not appear in optionsForSection('elements')`
      );
    }

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
      taskLink({ section: 'elements', activity_key: 'squares_stage_1' }),
      '/pages/element-drill.html?drill=squares_stage_1'
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

describe('formatTaskTarget & isTaskActivityAvailable', () => {
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
      formatTaskTarget({ section: 'elements', activity_key: 'squares_stage_1' }, SAMPLE_CATEGORIES),
      { text: 'Square - Stage 1 (1-25)', isAny: false }
    );
    assert.deepEqual(
      formatTaskTarget({ section: 'memoriad', activity_key: 'multiplications' }, SAMPLE_CATEGORIES),
      { text: 'Mental Multiplications', isAny: false }
    );
    assert.equal(
      isTaskActivityAvailable({ task_section: 'elements', task_activity_key: 'squares_stage_1' }, SAMPLE_CATEGORIES),
      true
    );
  });

  it('shows "Activity no longer available" when an old to-do task points to a removed drill key', () => {
    for (const oldKey of ['squares_11_50', 'squares_51_100', 'cubes_11_50', 'cubes_51_100']) {
      assert.deepEqual(
        formatTaskTarget({ section: 'elements', activity_key: oldKey }, SAMPLE_CATEGORIES),
        { text: 'Activity no longer available', isAny: false, unavailable: true }
      );
      assert.deepEqual(
        formatTaskTarget({ task_section: 'elements', task_activity_key: oldKey }, SAMPLE_CATEGORIES),
        { text: 'Activity no longer available', isAny: false, unavailable: true }
      );
      assert.equal(
        isTaskActivityAvailable({ task_section: 'elements', task_activity_key: oldKey }, SAMPLE_CATEGORIES),
        false
      );
    }
  });
});
