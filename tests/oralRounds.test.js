import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORAL_OPERATION_KEYS,
  ORAL_DIGIT_SIZES,
  normalizeOralRoundsRule,
  isOralRoundsAllowed,
  getOralRoundOptions,
  clampOralDelay,
  defaultOralSettings,
  validateOralSettings,
  randomWithDigits,
  computeOralAnswer,
  generateOralQuestion,
  buildOralSpeech,
  formatOralSettingsTitle,
  parseOralAnswer,
  checkOralAnswer,
  createOralScore,
  recordOralAttempt,
  formatOralScore,
} from '../js/oralRounds.js';
import { getRoleNavItems } from '../js/navConfig.js';
import {
  PRESET_FULL_ACCESS,
  PRESET_LEVEL_1,
  renderAccessEditorHtml,
} from '../js/studentAccess.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Deterministic RNG cycling through the given values. */
function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('Oral Rounds access rule', () => {
  it('treats a missing rule as full access', () => {
    assert.deepEqual(normalizeOralRoundsRule(undefined), {
      allowed: true,
      operations: [...ORAL_OPERATION_KEYS],
      digits: [...ORAL_DIGIT_SIZES],
    });
    assert.equal(isOralRoundsAllowed(null), true);
  });

  it('hides when allowed is false or nothing is selected', () => {
    assert.equal(isOralRoundsAllowed({ allowed: false }), false);
    assert.equal(isOralRoundsAllowed({ allowed: true, operations: [], digits: [1] }), false);
    assert.equal(isOralRoundsAllowed({ allowed: true, operations: ['add'], digits: [] }), false);
    assert.deepEqual(getOralRoundOptions({ allowed: false }), { allowed: false, operations: [], digits: [] });
  });

  it('drops unknown values and keeps catalog order', () => {
    const r = normalizeOralRoundsRule({ allowed: true, operations: ['MUL', 'div', 'add'], digits: [9, '3', 1] });
    assert.deepEqual(r.operations, ['add', 'mul']);
    assert.deepEqual(r.digits, [1, 3]);
  });

  it('offers only the allowed options', () => {
    const o = getOralRoundOptions({ allowed: true, operations: ['mul'], digits: [2, 3] });
    assert.equal(o.allowed, true);
    assert.deepEqual(o.operations.map((x) => x.key), ['mul']);
    assert.deepEqual(o.digits, [2, 3]);
  });

  it('presets carry the oral_rounds key', () => {
    assert.equal(isOralRoundsAllowed(PRESET_FULL_ACCESS.oral_rounds), true);
    assert.deepEqual([...PRESET_LEVEL_1.oral_rounds.operations], ['add', 'sub']);
    assert.deepEqual([...PRESET_LEVEL_1.oral_rounds.digits], [1, 2]);
  });
});

describe('Oral Rounds settings', () => {
  const full = undefined;

  it('clamps and steps the delay', () => {
    assert.equal(clampOralDelay(-3), 0);
    assert.equal(clampOralDelay(99), 15);
    assert.equal(clampOralDelay(2.3), 2.5);
    assert.equal(clampOralDelay('abc'), 2);
  });

  it('defaults to the first operation and 2 digits when allowed', () => {
    assert.deepEqual(defaultOralSettings(full), { operation: 'add', digitsA: 2, digitsB: 2, delaySeconds: 2 });
    assert.deepEqual(defaultOralSettings({ operations: ['mul'], digits: [3, 4] }), {
      operation: 'mul', digitsA: 3, digitsB: 3, delaySeconds: 2,
    });
    assert.equal(defaultOralSettings({ allowed: false }), null);
  });

  it('accepts allowed settings and rejects others', () => {
    const ok = validateOralSettings({ operation: 'mul', digitsA: 2, digitsB: 2, delaySeconds: 3 }, full);
    assert.deepEqual(ok, { ok: true, settings: { operation: 'mul', digitsA: 2, digitsB: 2, delaySeconds: 3 } });

    const rule = { allowed: true, operations: ['add'], digits: [1, 2] };
    assert.equal(validateOralSettings({ operation: 'mul', digitsA: 1, digitsB: 1 }, rule).ok, false);
    assert.equal(validateOralSettings({ operation: 'add', digitsA: 3, digitsB: 1 }, rule).ok, false);
    assert.equal(validateOralSettings({ operation: 'add', digitsA: 2, digitsB: 1 }, { allowed: false }).ok, false);
  });

  it('requires the first number to be at least as long for subtraction', () => {
    assert.equal(validateOralSettings({ operation: 'sub', digitsA: 2, digitsB: 3 }, full).ok, false);
    assert.equal(validateOralSettings({ operation: 'sub', digitsA: 3, digitsB: 2 }, full).ok, true);
  });
});

describe('Oral Rounds question generation', () => {
  it('makes numbers with exactly the chosen digits', () => {
    assert.equal(randomWithDigits(1, () => 0), 1);
    assert.equal(randomWithDigits(1, () => 0.9999), 9);
    assert.equal(randomWithDigits(3, () => 0), 100);
    assert.equal(randomWithDigits(3, () => 0.9999), 999);
    for (let i = 0; i < 200; i += 1) {
      for (const d of ORAL_DIGIT_SIZES) {
        assert.equal(String(randomWithDigits(d)).length, d);
      }
    }
  });

  it('computes answers for each operation', () => {
    assert.equal(computeOralAnswer('add', 47, 83), 130);
    assert.equal(computeOralAnswer('sub', 83, 47), 36);
    assert.equal(computeOralAnswer('mul', 47, 83), 3901);
    assert.throws(() => computeOralAnswer('div', 1, 1));
  });

  it('never produces a negative subtraction', () => {
    for (let i = 0; i < 500; i += 1) {
      const q = generateOralQuestion({ operation: 'sub', digitsA: 2, digitsB: 2 });
      assert.ok(q.a >= q.b, `${q.a} - ${q.b}`);
      assert.ok(q.answer >= 0);
    }
  });

  it('respects digit sizes and answers in generated questions', () => {
    for (let i = 0; i < 200; i += 1) {
      const q = generateOralQuestion({ operation: 'mul', digitsA: 3, digitsB: 2 });
      assert.equal(String(q.a).length, 3);
      assert.equal(String(q.b).length, 2);
      assert.equal(q.answer, q.a * q.b);
    }
  });

  it('avoids repeating the previous pair', () => {
    const rng = seq(0, 0, 0, 0, 0.5, 0.5);
    const q = generateOralQuestion({ operation: 'add', digitsA: 1, digitsB: 1 }, rng, { a: 1, b: 1 });
    assert.notDeepEqual([q.a, q.b], [1, 1]);
  });

  it('builds the spoken parts', () => {
    const q = { operation: 'mul', digitsA: 2, digitsB: 2, a: 47, b: 83, answer: 3901 };
    assert.deepEqual(buildOralSpeech(q), { intro: '2 digit times 2 digit', first: '47', second: '83' });
    assert.equal(buildOralSpeech({ ...q, operation: 'add', digitsA: 3 }).intro, '3 digit plus 2 digit');
    assert.equal(buildOralSpeech({ ...q, operation: 'sub' }).intro, '2 digit minus 2 digit');
    assert.equal(formatOralSettingsTitle({ operation: 'mul', digitsA: 2, digitsB: 2 }), '2d × 2d');
  });
});

describe('Oral Rounds answers and score', () => {
  it('parses typed answers', () => {
    assert.equal(parseOralAnswer(' 3,901 '), 3901);
    assert.equal(parseOralAnswer('-12'), -12);
    assert.equal(parseOralAnswer('−12'), -12);
    assert.equal(parseOralAnswer(''), null);
    assert.equal(parseOralAnswer('12a'), null);
    assert.equal(parseOralAnswer('1.5'), null);
  });

  it('checks answers', () => {
    const q = { answer: 130 };
    assert.deepEqual(checkOralAnswer(q, '130'), { given: 130, correct: true, expected: 130 });
    assert.equal(checkOralAnswer(q, '131').correct, false);
    assert.equal(checkOralAnswer(q, '').correct, false);
  });

  it('keeps a session score with streaks', () => {
    let s = createOralScore();
    s = recordOralAttempt(s, true);
    s = recordOralAttempt(s, true);
    s = recordOralAttempt(s, false);
    s = recordOralAttempt(s, true);
    assert.deepEqual(s, { asked: 4, correct: 3, wrong: 1, streak: 1, bestStreak: 2 });
    assert.equal(formatOralScore(s), '3 / 4 (75%)');
    assert.equal(formatOralScore(createOralScore()), '0 / 0');
  });
});

describe('Oral Rounds gating and wiring', () => {
  const ids = (access) => getRoleNavItems('student', null, access).map((i) => i.id);

  it('shows the nav link by default and hides it when not allowed', () => {
    assert.ok(ids(null).includes('student-oral-rounds'));
    assert.ok(ids({ oral_rounds: { allowed: true, operations: ['add'], digits: [1] } }).includes('student-oral-rounds'));
    assert.ok(!ids({ oral_rounds: { allowed: false } }).includes('student-oral-rounds'));
    assert.ok(!ids({ oral_rounds: { allowed: true, operations: [], digits: [1] } }).includes('student-oral-rounds'));
    const both = ids({ flash: { allowed: false }, oral_rounds: { allowed: false } });
    assert.ok(!both.includes('student-flash') && !both.includes('student-oral-rounds'));
  });

  it('renders the permission controls with saved values', () => {
    const html = renderAccessEditorHtml({
      settings: { ...PRESET_FULL_ACCESS, oral_rounds: { allowed: false, operations: ['mul'], digits: [2] } },
    });
    assert.match(html, /id="switch-oral-allowed"(?![^>]*checked)/);
    assert.match(html, /name="access_oral_op" value="mul"\s+checked/);
    assert.match(html, /name="access_oral_op" value="add"\s+\/>/);
    assert.match(html, /name="access_oral_digit" value="2"\s+checked/);
    assert.match(html, /summary-oral-rounds-badge[^>]*>Hidden</);
  });

  it('registers the page in vite and never writes results', () => {
    const vite = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(vite, /pages\/oral-rounds\.html/);
    for (const f of ['js/oralRounds.js', 'js/oralRoundsPage.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /activity_results|\.insert\(|\.upsert\(|\.rpc\(|fetch\(/, `${f} must not write data`);
    }
  });
});
