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
  flashSummary,
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

  it('normalizes Flash Anzan fields: empty, each field alone, all four, 0.2 and 5.0 s, 1.1 s (1100 ms), 2 and 1000 numbers, out-of-range values (including 1 number), and non-flash section clearing them', () => {
    // 1. All empty or "any" -> null
    const emptyFlash = normalizeTaskInput(
      {
        title: 'Any Flash',
        flash_digits: '',
        flash_count: 'any',
        flash_speed_ms: 'Any',
        flash_mode: '   ',
      },
      'flash'
    );
    assert.ok(emptyFlash.value);
    assert.equal(emptyFlash.value.flash_digits, null);
    assert.equal(emptyFlash.value.flash_count, null);
    assert.equal(emptyFlash.value.flash_speed_ms, null);
    assert.equal(emptyFlash.value.flash_mode, null);

    // 2. Each field alone
    const digitsOnly = normalizeTaskInput({ title: 'D1', flash_digits: '1' }, 'flash');
    assert.equal(digitsOnly.value.flash_digits, 1);
    assert.equal(digitsOnly.value.flash_count, null);
    assert.equal(digitsOnly.value.flash_speed_ms, null);
    assert.equal(digitsOnly.value.flash_mode, null);

    const countOnly = normalizeTaskInput({ title: 'C50', flash_count: 50 }, 'flash');
    assert.equal(countOnly.value.flash_digits, null);
    assert.equal(countOnly.value.flash_count, 50);
    assert.equal(countOnly.value.flash_speed_ms, null);
    assert.equal(countOnly.value.flash_mode, null);

    const speedOnly = normalizeTaskInput({ title: 'S05', flash_speed_ms: '0.5' }, 'flash');
    assert.equal(speedOnly.value.flash_digits, null);
    assert.equal(speedOnly.value.flash_count, null);
    assert.equal(speedOnly.value.flash_speed_ms, 500);
    assert.equal(speedOnly.value.flash_mode, null);

    const modeOnly = normalizeTaskInput({ title: 'MAddSub', flash_mode: 'add_sub' }, 'flash');
    assert.equal(modeOnly.value.flash_digits, null);
    assert.equal(modeOnly.value.flash_count, null);
    assert.equal(modeOnly.value.flash_speed_ms, null);
    assert.equal(modeOnly.value.flash_mode, 'add_sub');

    // 3. All four fields together + floating-point check (0.5 -> 500, 1.1 -> 1100)
    const allFour = normalizeTaskInput(
      {
        title: 'Flash: 1 digit, 50 numbers, 0.5 s, add only',
        flash_digits: 1,
        flash_count: 50,
        flash_speed_ms: 0.5,
        flash_mode: 'add',
      },
      'flash'
    );
    assert.ok(allFour.value);
    assert.equal(allFour.value.flash_digits, 1);
    assert.equal(allFour.value.flash_count, 50);
    assert.equal(allFour.value.flash_speed_ms, 500);
    assert.equal(allFour.value.flash_mode, 'add');

    const speed11 = normalizeTaskInput({ title: 'Speed 1.1', flash_speed_ms: 1.1 }, 'flash');
    assert.ok(speed11.value);
    assert.equal(speed11.value.flash_speed_ms, 1100);

    // 4. Boundary speeds: 0.2 s (200 ms) and 5.0 s (5000 ms)
    const speed02 = normalizeTaskInput({ title: 'Speed 0.2', flash_speed_ms: '0.2' }, 'flash');
    assert.equal(speed02.value.flash_speed_ms, 200);

    const speed50 = normalizeTaskInput({ title: 'Speed 5.0', flash_speed_ms: '5.0' }, 'flash');
    assert.equal(speed50.value.flash_speed_ms, 5000);

    // 5. Boundary counts: 2 and 1000 accepted; 1 rejected
    const count2 = normalizeTaskInput({ title: 'Count 2', flash_count: 2 }, 'flash');
    assert.equal(count2.value.flash_count, 2);

    const count1000 = normalizeTaskInput({ title: 'Count 1000', flash_count: '1000' }, 'flash');
    assert.equal(count1000.value.flash_count, 1000);

    const count1 = normalizeTaskInput({ title: 'Count 1', flash_count: 1 }, 'flash');
    assert.ok(count1.errors?.flash_count);
    assert.equal(count1.value, undefined);

    // 6. Out-of-range values
    assert.ok(normalizeTaskInput({ title: 'T', flash_digits: 0 }, 'flash').errors?.flash_digits);
    assert.ok(normalizeTaskInput({ title: 'T', flash_digits: 6 }, 'flash').errors?.flash_digits);
    assert.ok(normalizeTaskInput({ title: 'T', flash_digits: 2.5 }, 'flash').errors?.flash_digits);
    assert.ok(normalizeTaskInput({ title: 'T', flash_count: 1001 }, 'flash').errors?.flash_count);
    assert.ok(normalizeTaskInput({ title: 'T', flash_count: 10.5 }, 'flash').errors?.flash_count);
    assert.ok(normalizeTaskInput({ title: 'T', flash_speed_ms: 0.1 }, 'flash').errors?.flash_speed_ms);
    assert.ok(normalizeTaskInput({ title: 'T', flash_speed_ms: 5.1 }, 'flash').errors?.flash_speed_ms);
    assert.ok(normalizeTaskInput({ title: 'T', flash_speed_ms: 0.25 }, 'flash').errors?.flash_speed_ms);
    assert.ok(normalizeTaskInput({ title: 'T', flash_mode: 'mult' }, 'flash').errors?.flash_mode);

    // 7. Non-flash section clears all flash_* fields to null
    for (const nonFlashSec of ['basics', 'round', 'elements', 'memoriad']) {
      const cleared = normalizeTaskInput(
        {
          title: 'Non-flash task',
          flash_digits: 2,
          flash_count: 50,
          flash_speed_ms: 0.5,
          flash_mode: 'add',
        },
        nonFlashSec
      );
      assert.ok(cleared.value);
      assert.equal(cleared.value.flash_digits, null);
      assert.equal(cleared.value.flash_count, null);
      assert.equal(cleared.value.flash_speed_ms, null);
      assert.equal(cleared.value.flash_mode, null);
    }
  });
});

describe('flashSummary', () => {
  it('formats empty, each field alone, all four fields, 0.2 s, 5.0 s, and 2..1000 numbers', () => {
    // Empty
    assert.equal(flashSummary({}), 'Any flash anzan try');
    assert.equal(
      flashSummary({
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
      }),
      'Any flash anzan try'
    );

    // Each field alone
    assert.equal(flashSummary({ flash_digits: 1 }), '1 digit');
    assert.equal(flashSummary({ flash_digits: 3 }), '3 digits');
    assert.equal(flashSummary({ flash_count: 50 }), '50 numbers');
    assert.equal(flashSummary({ flash_count: 2 }), '2 numbers');
    assert.equal(flashSummary({ flash_count: 1000 }), '1000 numbers');
    assert.equal(flashSummary({ flash_speed_ms: 200 }), '0.2 s');
    assert.equal(flashSummary({ flash_speed_ms: 500 }), '0.5 s');
    assert.equal(flashSummary({ flash_speed_ms: 5000 }), '5.0 s');
    assert.equal(flashSummary({ flash_mode: 'add' }), 'add only');
    assert.equal(flashSummary({ flash_mode: 'add_sub' }), 'add and subtract');

    // All four together
    assert.equal(
      flashSummary({
        flash_digits: 1,
        flash_count: 50,
        flash_speed_ms: 500,
        flash_mode: 'add',
      }),
      '1 digit, 50 numbers, 0.5 s, add only'
    );
    assert.equal(
      flashSummary({
        flash_digits: 2,
        flash_count: 1000,
        flash_speed_ms: 200,
        flash_mode: 'add_sub',
      }),
      '2 digits, 1000 numbers, 0.2 s, add and subtract'
    );

    // Ignores out-of-range values
    assert.equal(flashSummary({ flash_count: 1 }), 'Any flash anzan try');
    assert.equal(flashSummary({ flash_digits: 9, flash_speed_ms: 100 }), 'Any flash anzan try');
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

    // flash (Phase 14a: builds /pages/flash.html?task=1 plus any set parameters)
    assert.equal(
      taskLink({ task_section: 'flash', task_category_id: null, task_activity_key: null }),
      '/pages/flash.html?task=1'
    );
    assert.equal(
      taskLink({
        section: 'flash',
        flash_digits: 1,
        flash_count: 50,
        flash_speed_ms: 500,
        flash_mode: 'add',
      }),
      '/pages/flash.html?task=1&digits=1&count=50&speed=500&mode=add'
    );
    assert.equal(
      taskLink({
        task_section: 'flash',
        flash_digits: 2,
        flash_count: null,
        flash_speed_ms: 1100,
        flash_mode: null,
      }),
      '/pages/flash.html?task=1&digits=2&speed=1100'
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
      { text: 'Any flash anzan try', isAny: true }
    );
    assert.deepEqual(
      formatTaskTarget(
        {
          section: 'flash',
          flash_digits: 1,
          flash_count: 50,
          flash_speed_ms: 500,
          flash_mode: 'add',
        },
        SAMPLE_CATEGORIES
      ),
      { text: '1 digit, 50 numbers, 0.5 s, add only', isAny: false }
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
