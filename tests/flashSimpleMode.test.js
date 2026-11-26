import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canAddDirect,
  canSubDirect,
  directDigits,
  generateSimpleQuestion,
  isSimpleSequence,
} from '../js/flashSimple.js';
import {
  FLASH_LIMITS,
  clampFlashSettings,
  flashModeHasMinus,
  flashModeLabel,
  formatFlashCompactSummary,
  normalizeFlashMode,
  settingsKey,
} from '../js/flashStats.js';
import { FLASH_MODES } from '../js/weeklySections.js';
import { flashSummary, normalizeTaskInput, taskLink } from '../js/todoForm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

describe('direct (no formula) abacus moves', () => {
  it('matches the rules for one rod', () => {
    assert.deepEqual(directDigits(0, 1), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(directDigits(4, 1), [5]); // 4 + 5 = 9
    assert.deepEqual(directDigits(8, 1), [1]);
    assert.deepEqual(directDigits(9, 1), []);
    assert.deepEqual(directDigits(3, 1), [1, 5, 6]);
    assert.deepEqual(directDigits(0, -1), []);
    assert.deepEqual(directDigits(5, -1), [5]);
    assert.deepEqual(directDigits(7, -1), [1, 2, 5, 6, 7]);
    assert.equal(canAddDirect(3, 2), false, '3 + 2 needs a formula');
    assert.equal(canAddDirect(6, 5), false, '6 + 5 needs a formula');
    assert.equal(canSubDirect(6, 3), false, '6 - 3 needs a formula');
    assert.equal(canSubDirect(9, 4), true);
  });

  it('checks whole questions', () => {
    assert.equal(isSimpleSequence([3, -1, 2, 5, -3], 1), true);
    assert.equal(isSimpleSequence([3, 2], 1), false);
    assert.equal(isSimpleSequence([-3, 2], 1), false);
    assert.equal(isSimpleSequence([21, -10], 2), false, 'no zero digits');
    assert.equal(isSimpleSequence([21, -11, 15], 2), true);
    assert.equal(isSimpleSequence([21, 18], 2), true, '1 + 8 on the units rod is direct');
    assert.equal(isSimpleSequence([24, 13], 2), false, '4 + 3 on the units rod needs a formula');
  });
});

describe('generateSimpleQuestion', () => {
  it('only builds questions that need no formula, for 1 to 5 digits', () => {
    for (let digits = 1; digits <= 5; digits += 1) {
      for (let seed = 1; seed <= 60; seed += 1) {
        const nums = generateSimpleQuestion(digits, 40, { random: seeded(seed * 31 + digits) });
        assert.equal(nums.length, 40);
        assert.ok(isSimpleSequence(nums, digits), `${digits}d seed ${seed}: ${nums.join(',')}`);
        assert.ok(nums.reduce((a, n) => a + n, 0) >= 0);
        // The same number twice in a row is avoided unless it is the only direct move.
        let repeats = 0;
        for (let i = 1; i < nums.length; i += 1) {
          if (Math.abs(nums[i]) === Math.abs(nums[i - 1])) repeats += 1;
        }
        assert.ok(repeats <= (digits === 1 ? 12 : 6), `${digits}d seed ${seed}: ${repeats} repeats`);
      }
    }
  });

  it('mixes plus and minus at random', () => {
    const nums = generateSimpleQuestion(2, 1000, { random: seeded(7) });
    const minus = nums.filter((n) => n < 0).length;
    assert.ok(minus > 300 && minus < 700, `minus count ${minus}`);
    const pattern = nums.slice(1, 31).map((n) => (n < 0 ? '-' : '+')).join('');
    assert.notEqual(pattern, '+-+'.repeat(10));
  });
});

describe('questions from the staging database follow the same rules', () => {
  // Produced by public.flash_generate_question(d, 30, 'simple') on staging.
  const samples = [
    [1, [3, -1, 2, 5, -3, 1, -5, 2, 5, -9, 2, 7, -6, 5, 1, -8, 7, 1, -3, 1, -5, -1, 2, 1, -3, -1, 9, -6, -3, 2]],
    [1, [5, -5, 4, -2, -1, 3, 5, -4, 1, 2, -8, 3, 5, 1, -4, -5, 1, 5, 3, -5, 5, -8, 1, 2, -1, 5, 1, -3, -5, -1]],
    [2, [39, -21, -12, 11, 22, -18, 56, 21, -41, 12, -18, 16, 21, -23, -15, 43, -61, -11, 25, -21, 14, -37, 32, 65, -84, -15, 92, -21, 27, -88]],
    [2, [92, -82, 25, -35, 51, 22, 15, -32, 23, -58, 11, 55, 11, -81, 12, -23, 61, -11, -56, 35, 61, -46, 15, -65, 81, -21, 35, -95, 28, -26]],
    [3, [679, -151, -523, 281, -151, -135, 168, -166, 631, -622, 655, 121, -721, 132, -195, 751, 145, -719, 213, -131, 236, -166, -211, 768, -874, 411, -315, 578, -533, -156]],
    [4, [9899, -9648, 5143, -5261, 6561, -1144, 3334, 1115, -9226, 5125, -5245, 7111, 1135, -8567, 6551, 2116, -2868, 1666, -2211, -5585, 5282, 2511, -7192, 9295, -9772, 3252, 6111, -3433, 2434, -7224]],
    [5, [14251, -11151, 65263, 11536, -61831, 11611, -18553, 33521, 55252, -21126, -11262, 21151, -62651, 23333, -26211, -11111, 22215, -31115, 15166, -13217, 62125, -15175, 11657, 15321, -22456, 43156, -33179, 11115, 22162, -46611]],
  ];
  for (const [digits, nums] of samples) {
    it(`${digits} digit sample`, () => assert.ok(isSimpleSequence(nums, digits)));
  }
});

describe('Simple is a third Flash mode everywhere', () => {
  it('settings, labels and keys', () => {
    assert.deepEqual(FLASH_LIMITS.MODES, ['add', 'add_sub', 'simple']);
    assert.deepEqual(FLASH_MODES, ['add', 'add_sub', 'simple']);
    assert.equal(clampFlashSettings({ digits: 2, count: 10, speed_ms: 1000, mode: 'simple' }).mode, 'simple');
    assert.equal(clampFlashSettings({ mode: 'other' }).mode, 'add');
    assert.equal(normalizeFlashMode(' SIMPLE '), 'simple');
    assert.equal(flashModeHasMinus('simple'), true);
    assert.equal(flashModeHasMinus('add'), false);
    assert.equal(flashModeLabel('simple', 'short'), 'Simple');
    assert.match(formatFlashCompactSummary({ digits: 1, count: 10, speed_ms: 1000, mode: 'simple' }), /Simple/);
    assert.match(settingsKey({ digits: 1, count: 10, speed_ms: 1000, mode: 'simple' }), /simple/);
  });

  it('daily tasks accept Simple', () => {
    const res = normalizeTaskInput({
      title: 'Flash simple',
      section: 'flash',
      flash_mode: 'simple',
      flash_digits: 1,
      flash_count: 10,
      flash_speed_seconds: '1.0',
    });
    assert.equal(res.errors, undefined, JSON.stringify(res.errors));
    assert.equal(res.value?.flash_mode, 'simple');
    assert.match(flashSummary({ flash_mode: 'simple' }), /simple/);
    assert.match(taskLink({ section: 'flash', id: 't1', flash_mode: 'simple' }), /mode=simple/);
  });

  it('every setup screen offers Simple', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(read('pages/flash.html'), /data-mode="simple"/);
    assert.match(read('pages/todos.html'), /<option value="simple">/);
    assert.match(read('pages/homework.html'), /id="hw-flash-mode"[\s\S]*<option value="simple">/);
    assert.match(read('js/practiceRecordsCard.js'), /data-mode="simple"/);
  });

  it('the migration adds the generator and accepts simple in every check', () => {
    const sql = read('supabase/staging_flash_simple_mode.sql');
    assert.match(sql, /IF p_mode = 'simple' THEN/);
    for (const fn of ['flash_start', 'save_weekly_test_sections_atomic', 'practice_highest_records']) {
      assert.ok(sql.includes(`public.${fn}`), fn);
    }
    assert.match(sql, /daily_tasks_flash_ranges[\s\S]*'simple'::text/);
    assert.match(sql, /wt_sections_shape_check[\s\S]*'simple'::text/);
    function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
  });
});
