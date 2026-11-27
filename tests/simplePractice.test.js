import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIMPLE_ACTIVITIES,
  SIMPLE_ACTIVITY_KEYS,
  SIMPLE_DEFAULT_TIME_KEY,
  SIMPLE_TIME_MODES,
  allowedSimpleActivities,
  bestSimpleByActivity,
  checkSimpleAnswer,
  formatSimpleQuestion,
  generateSimplePracticeQuestion,
  getSimpleTimeMode,
  isSimpleActivityAllowed,
  isSimplePracticeAllowed,
  markSimpleRound,
  normalizeSimplePracticeRule,
  parseSimpleAnswer,
  simpleActivityLabel,
  validateSimpleEntry,
} from '../js/simplePractice.js';
import { isSimpleSequence } from '../js/flashSimple.js';
import { allowedFlashModes, isFlashModeAllowed } from '../js/flashStats.js';
import { PRESET_FULL_ACCESS, PRESET_LEVEL_1 } from '../js/studentAccess.js';
import { getRoleNavItems } from '../js/navConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function seeded(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

describe('Simple activities', () => {
  it('has the sums, every table from 2 to 9 and the two mixes', () => {
    assert.deepEqual(SIMPLE_ACTIVITY_KEYS, [
      'simple_1d4r', 'simple_2d2r', 'simple_3d2r',
      'table_2', 'table_3', 'table_4', 'table_5', 'table_6', 'table_7', 'table_8', 'table_9',
      'mix_2_5', 'mix_2_9',
    ]);
    assert.equal(simpleActivityLabel('simple_2d2r'), 'Simple 2D 2R');
    assert.equal(simpleActivityLabel('table_7'), 'Table of 7');
    assert.equal(simpleActivityLabel('mix_2_5'), '2–5 mix dodging');
  });

  it('the migration accepts exactly the same keys', () => {
    const sql = read('supabase/staging_simple_practice.sql');
    for (const key of SIMPLE_ACTIVITY_KEYS) assert.ok(sql.includes(`'${key}'`), key);
  });
});

describe('questions', () => {
  it('Simple sums need no formula and have the right rows and digits', () => {
    for (const a of SIMPLE_ACTIVITIES.filter((x) => x.kind === 'sum')) {
      const random = seeded(a.digits * 97);
      for (let i = 0; i < 300; i += 1) {
        const q = generateSimplePracticeQuestion(a, { random });
        assert.equal(q.numbers.length, a.rows);
        assert.ok(isSimpleSequence(q.numbers, a.digits), `${a.key}: ${q.numbers.join(',')}`);
        assert.equal(q.answer, q.numbers.reduce((s, n) => s + n, 0));
        assert.ok(q.answer >= 0);
      }
    }
  });

  it('tables dodging asks one table with random multipliers 1 to 10, never the same twice in a row', () => {
    const random = seeded(5);
    let prev = null;
    const seen = new Set();
    for (let i = 0; i < 400; i += 1) {
      const q = generateSimplePracticeQuestion('table_2', { random, previous: prev });
      assert.equal(q.a, 2);
      assert.ok(q.b >= 1 && q.b <= 10);
      assert.equal(q.answer, 2 * q.b);
      if (prev) assert.ok(!(prev.a === q.a && prev.b === q.b));
      seen.add(q.b);
      prev = q;
    }
    assert.equal(seen.size, 10);
  });

  it('mixes ask from every table in their range', () => {
    for (const [key, lo, hi] of [['mix_2_5', 2, 5], ['mix_2_9', 2, 9]]) {
      const random = seeded(hi);
      const tables = new Set();
      for (let i = 0; i < 500; i += 1) {
        const q = generateSimplePracticeQuestion(key, { random });
        assert.ok(q.a >= lo && q.a <= hi);
        tables.add(q.a);
      }
      assert.equal(tables.size, hi - lo + 1, key);
    }
  });

  it('formats and checks answers', () => {
    assert.equal(formatSimpleQuestion({ kind: 'table', a: 7, b: 4 }), '7 × 4');
    assert.equal(formatSimpleQuestion({ kind: 'sum', numbers: [3, -1, 5] }), '3 − 1 + 5');
    assert.equal(parseSimpleAnswer(' 28 '), 28);
    assert.equal(parseSimpleAnswer('abc'), null);
    assert.equal(checkSimpleAnswer({ answer: 28 }, '28'), true);
    assert.equal(checkSimpleAnswer({ answer: 28 }, '27'), false);
  });
});

describe('score entries', () => {
  const today = '2026-11-26';
  it('accepts a valid offline log', () => {
    const r = validateSimpleEntry(
      { activity_key: 'table_7', source: 'offline', correct: 18, total: 20, time_seconds: 95, practiced_on: '2026-11-20' },
      { todayIST: today }
    );
    assert.equal(r.errors, undefined);
    assert.equal(r.value.activity_key, 'table_7');
  });

  it('rejects bad numbers, dates and activities', () => {
    const base = { activity_key: 'table_7', source: 'offline', correct: 5, total: 10 };
    assert.ok(validateSimpleEntry({ ...base, correct: 11 }, { todayIST: today }).errors);
    assert.ok(validateSimpleEntry({ ...base, total: 0 }, { todayIST: today }).errors);
    assert.ok(validateSimpleEntry({ ...base, practiced_on: '2026-11-27' }, { todayIST: today }).errors);
    assert.ok(validateSimpleEntry({ ...base, practiced_on: '2026-11-18' }, { todayIST: today }).errors);
    assert.equal(validateSimpleEntry({ ...base, practiced_on: '2026-11-19' }, { todayIST: today }).errors, undefined);
    assert.ok(validateSimpleEntry({ ...base, activity_key: 'table_10' }, { todayIST: today }).errors);
    assert.ok(
      validateSimpleEntry(base, { todayIST: today, rule: { allowed: true, activities: ['table_2'] } }).errors
    );
  });

  it('best score per activity: accuracy, then more questions, then less time', () => {
    const best = bestSimpleByActivity([
      { activity_key: 'table_2', correct: 9, total: 10, time_seconds: 30 },
      { activity_key: 'table_2', correct: 20, total: 20, time_seconds: 80 },
      { activity_key: 'table_2', correct: 20, total: 20, time_seconds: 60 },
      { activity_key: 'mix_2_9', correct: 5, total: 10, time_seconds: null },
    ]);
    assert.equal(best.get('table_2').time_seconds, 60);
    assert.equal(best.get('mix_2_9').correct, 5);
  });
});

describe('practice access', () => {
  it('a missing Simple rule means full access', () => {
    assert.deepEqual(normalizeSimplePracticeRule(null).activities, SIMPLE_ACTIVITY_KEYS);
    assert.equal(isSimplePracticeAllowed(undefined), true);
  });

  it('limits Simple to the chosen activities', () => {
    const rule = { allowed: true, activities: ['table_2', 'mix_2_5'] };
    assert.deepEqual(allowedSimpleActivities(rule).map((a) => a.key), ['table_2', 'mix_2_5']);
    assert.equal(isSimpleActivityAllowed('table_3', rule), false);
    assert.equal(isSimplePracticeAllowed({ allowed: false, activities: ['table_2'] }), false);
    assert.equal(isSimplePracticeAllowed({ allowed: true, activities: [] }), false);
  });

  it('Flash Anzan modes follow settings.flash.modes', () => {
    assert.deepEqual(allowedFlashModes(null), ['add', 'add_sub', 'simple']);
    assert.deepEqual(allowedFlashModes({ allowed: true }), ['add', 'add_sub', 'simple']);
    assert.deepEqual(allowedFlashModes({ allowed: true, modes: ['simple', 'add'] }), ['add', 'simple']);
    assert.deepEqual(allowedFlashModes({ allowed: false, modes: ['add'] }), []);
    assert.equal(isFlashModeAllowed('add_sub', { allowed: true, modes: ['add'] }), false);
  });

  it('presets include the new keys', () => {
    assert.deepEqual(PRESET_FULL_ACCESS.flash.modes, ['add', 'add_sub', 'simple']);
    assert.deepEqual(PRESET_FULL_ACCESS.simple_practice.activities, SIMPLE_ACTIVITY_KEYS);
    assert.equal(PRESET_LEVEL_1.simple_practice.allowed, true);
  });

  it('the Simple link hides when Simple is turned off', () => {
    const shown = getRoleNavItems('student', null, { simple_practice: { allowed: true } }).map((i) => i.id);
    assert.ok(shown.includes('student-simple'));
    const hidden = getRoleNavItems('student', null, { simple_practice: { allowed: false } }).map((i) => i.id);
    assert.ok(!hidden.includes('student-simple'));
  });

  it('the access editor has the Simple section and Flash modes', () => {
    const src = read('js/studentAccess.js');
    assert.match(src, /access_simple_activity/);
    assert.match(src, /access_flash_mode/);
    const sql = read('supabase/staging_simple_practice.sql');
    assert.match(sql, /This Flash Anzan mode is not turned on for you/);
    assert.match(sql, /This activity is not turned on for you/);
  });
});

describe('timed rounds', () => {
  it('offers the same round times as Basics', () => {
    assert.deepEqual(
      SIMPLE_TIME_MODES.map((m) => m.seconds),
      [30, 60, 120, 300, null]
    );
    assert.equal(SIMPLE_DEFAULT_TIME_KEY, '60');
    assert.equal(getSimpleTimeMode('300').seconds, 300);
    assert.equal(getSimpleTimeMode('unlimited').seconds, null);
    assert.equal(getSimpleTimeMode('nope').key, '60');
  });

  it('marks the whole round at the end', () => {
    const q = (answer) => ({ kind: 'table', a: 2, b: answer / 2, answer });
    const marked = markSimpleRound([
      { question: q(6), given: '6' },
      { question: q(8), given: ' 8 ' },
      { question: q(10), given: '12' },
      { question: q(14), given: null },
    ]);
    assert.equal(marked.correct, 2);
    assert.equal(marked.total, 4);
    assert.deepEqual(
      marked.wrong.map((w) => w.given),
      ['12', 'skipped']
    );
    assert.deepEqual(markSimpleRound([]), { correct: 0, total: 0, wrong: [] });
  });
});

describe('Simple page', () => {
  it('is built and linked', () => {
    assert.match(read('vite.config.ts'), /pages\/simple\.html/);
    const html = read('pages/simple.html');
    assert.match(html, /Practice online/);
    assert.match(html, /Log offline score/);
    assert.match(html, /simplePracticePage\.js/);
    assert.match(html, /id="simple-time-choices"/);
    assert.doesNotMatch(html, /simple-count-choices/);
  });
});
