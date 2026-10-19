/**
 * Trendz Tracker — Phase 7 Flash Anzan Unit Tests (tests/flash.test.js)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLASH_LIMITS,
  FLASH_PRESETS,
  FLASH_PRESET_LIST,
  detectFlashPreset,
  secondsToSpeedMs,
  speedMsToSeconds,
  formatSpeedDisplay,
  validateFlashSettings,
  formatFlashSettingsSummary,
  formatNumberSequence,
  parseFlashAnswerInput,
  friendlyFlashError,
} from '../js/flashPresets.js';

describe('Phase 7 — 1. Flash Anzan Presets & Detection (js/flashPresets.js)', () => {
  it('defines Beginner, Intermediate, Advanced, and Custom presets with exact specifications', () => {
    assert.equal(FLASH_PRESET_LIST.length, 4);

    assert.deepEqual(FLASH_PRESETS.beginner.settings, {
      digits: 1,
      count: 5,
      speed_ms: 2000,
      mode: 'add',
      questions: 10,
    });

    assert.deepEqual(FLASH_PRESETS.intermediate.settings, {
      digits: 2,
      count: 7,
      speed_ms: 1500,
      mode: 'add',
      questions: 10,
    });

    assert.deepEqual(FLASH_PRESETS.advanced.settings, {
      digits: 3,
      count: 10,
      speed_ms: 1000,
      mode: 'add_sub',
      questions: 10,
    });

    assert.equal(FLASH_PRESETS.custom.settings, null);
  });

  it('detects matching preset or falls back to custom', () => {
    assert.equal(detectFlashPreset(FLASH_PRESETS.beginner.settings), 'beginner');
    assert.equal(detectFlashPreset(FLASH_PRESETS.intermediate.settings), 'intermediate');
    assert.equal(detectFlashPreset(FLASH_PRESETS.advanced.settings), 'advanced');
    assert.equal(
      detectFlashPreset({ digits: 4, count: 12, speed_ms: 800, mode: 'add_sub', questions: 15 }),
      'custom'
    );
    assert.equal(detectFlashPreset(null), 'custom');
  });
});

describe('Phase 7 — 2. Settings Validation & Speed Formatting (js/flashPresets.js)', () => {
  it('validates all allowed boundary values (digits 1..5, count 3..30, speed_ms 200..5000, questions 3..30, mode add|add_sub)', () => {
    const minValid = validateFlashSettings({
      digits: FLASH_LIMITS.DIGITS_MIN,
      count: FLASH_LIMITS.COUNT_MIN,
      speed_ms: FLASH_LIMITS.SPEED_MS_MIN,
      questions: FLASH_LIMITS.QUESTIONS_MIN,
      mode: 'add',
    });
    assert.equal(minValid.valid, true);
    assert.deepEqual(minValid.errors, []);

    const maxValid = validateFlashSettings({
      digits: FLASH_LIMITS.DIGITS_MAX,
      count: FLASH_LIMITS.COUNT_MAX,
      speed_ms: FLASH_LIMITS.SPEED_MS_MAX,
      questions: FLASH_LIMITS.QUESTIONS_MAX,
      mode: 'add_sub',
    });
    assert.equal(maxValid.valid, true);
    assert.deepEqual(maxValid.errors, []);
  });

  it('rejects out-of-range settings with descriptive messages', () => {
    const bad = validateFlashSettings({
      digits: 6,
      count: 2,
      speed_ms: 100,
      questions: 35,
      mode: 'multiply',
    });
    assert.equal(bad.valid, false);
    assert.equal(bad.errors.length, 5);
  });

  it('converts between seconds and speed_ms and formats both seconds and numbers/sec', () => {
    assert.equal(secondsToSpeedMs(2.0), 2000);
    assert.equal(secondsToSpeedMs(1.5), 1500);
    assert.equal(secondsToSpeedMs(0.2), 200);
    assert.equal(speedMsToSeconds(1500), 1.5);

    const s2000 = formatSpeedDisplay(2000);
    assert.equal(s2000.secondsText, '2.0 s');
    assert.equal(s2000.perSecondText, '0.5 numbers/sec');

    const s1500 = formatSpeedDisplay(1500);
    assert.equal(s1500.secondsText, '1.5 s');
    assert.equal(s1500.perSecondText, '0.67 numbers/sec');

    const s500 = formatSpeedDisplay(500);
    assert.equal(s500.secondsText, '0.5 s');
    assert.equal(s500.perSecondText, '2.0 numbers/sec');
  });

  it('formats settings summary and signed number sequences cleanly', () => {
    assert.equal(
      formatFlashSettingsSummary(FLASH_PRESETS.beginner.settings),
      '1 digit · 5 numbers · 2.0s/num · Add only · 10 questions'
    );
    assert.equal(
      formatFlashSettingsSummary(FLASH_PRESETS.advanced.settings),
      '3 digits · 10 numbers · 1.0s/num · Add & subtract · 10 questions'
    );
    assert.equal(formatNumberSequence([14, -6, 9, -3]), '14 − 6 + 9 − 3');
  });
});

describe('Phase 7 — 3. Answer Input Parsing & Friendly RPC Error Mapping', () => {
  it('parses integer answers, unicode minus signs, and skipped questions', () => {
    assert.deepEqual(parseFlashAnswerInput('42'), { ok: true, value: 42 });
    assert.deepEqual(parseFlashAnswerInput('-18'), { ok: true, value: -18 });
    assert.deepEqual(parseFlashAnswerInput('−18'), { ok: true, value: -18 });
    assert.deepEqual(parseFlashAnswerInput(''), { ok: true, value: null });
    assert.deepEqual(parseFlashAnswerInput('   '), { ok: true, value: null });
    assert.deepEqual(parseFlashAnswerInput(null), { ok: true, value: null });

    const invalid = parseFlashAnswerInput('12.5');
    assert.equal(invalid.ok, false);
  });

  it('maps flash_start and flash_submit RPC errors to friendly student messages', () => {
    const rateMsg = friendlyFlashError({ message: 'More than 60 sets per hour' }, 'start');
    assert.ok(rateMsg.includes('60 Flash Anzan sets'));

    const fastMsg = friendlyFlashError(
      { message: 'Set finished faster than the numbers were shown' },
      'submit'
    );
    assert.ok(fastMsg.includes('faster than the numbers'));

    const dupMsg = friendlyFlashError({ message: 'Set already submitted' }, 'submit');
    assert.ok(dupMsg.includes('already been submitted'));

    const expMsg = friendlyFlashError(
      { message: 'Session expired (30 minutes after minimum time)' },
      'submit'
    );
    assert.ok(expMsg.includes('expired'));
  });
});
