/**
 * Adaptive motion: the device decides how much animation runs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  burstBudget,
  confettiBudget,
  formatCount,
  judgeFrames,
  levelAfterCheck,
  lowerLevel,
  minLevel,
  normalizeMotionPref,
  parseCountText,
  pickMotionLevel,
  readMotionEnv,
} from '../js/motion.js';

const strong = { reduced: false, saveData: false, net: '4g', memory: 8, cores: 8 };
const frames = (ms, n = 70) => Array.from({ length: n }, () => ms);

describe('picking a motion level', () => {
  it('gives strong devices everything', () => {
    assert.equal(pickMotionLevel(strong), 'full');
    assert.equal(pickMotionLevel({}), 'full', 'unknown devices start full and the watchdog steps down');
  });

  it('tones down weak or data-saving devices', () => {
    assert.equal(pickMotionLevel({ ...strong, memory: 2 }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, memory: 1 }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, cores: 2 }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, saveData: true }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, net: '2g' }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, net: 'slow-2g' }), 'lite');
    assert.equal(pickMotionLevel({ ...strong, net: '3g', memory: 4, cores: 4 }), 'full');
  });

  it('turns motion off for reduced-motion users', () => {
    assert.equal(pickMotionLevel({ ...strong, reduced: true }), 'off');
  });

  it('respects a step-down remembered for the session', () => {
    assert.equal(pickMotionLevel(strong, { cap: 'lite' }), 'lite');
    assert.equal(pickMotionLevel(strong, { cap: 'off' }), 'off');
    assert.equal(pickMotionLevel({ ...strong, memory: 2 }, { cap: 'full' }), 'lite', 'a cap never raises the level');
    assert.equal(pickMotionLevel(strong, { cap: 'bogus' }), 'full');
  });

  it("lets the student's own choice win", () => {
    assert.equal(pickMotionLevel({ ...strong, reduced: true }, { pref: 'full' }), 'full');
    assert.equal(pickMotionLevel(strong, { pref: 'off' }), 'off');
    assert.equal(pickMotionLevel({ ...strong, memory: 1 }, { pref: 'full', cap: 'lite' }), 'full');
    assert.equal(normalizeMotionPref('weird'), 'auto');
  });

  it('reads the device safely when the browser exposes nothing', () => {
    assert.deepEqual(readMotionEnv({}), { reduced: false, saveData: false, net: '', memory: 0, cores: 0 });
    const env = readMotionEnv({
      matchMedia: () => ({ matches: true }),
      navigator: { deviceMemory: 4, hardwareConcurrency: 6, connection: { saveData: true, effectiveType: '3g' } },
    });
    assert.deepEqual(env, { reduced: true, saveData: true, net: '3g', memory: 4, cores: 6 });
    assert.deepEqual(readMotionEnv({ matchMedia: () => { throw new Error('nope'); } }).reduced, false);
  });

  it('orders levels', () => {
    assert.equal(minLevel('full', 'lite'), 'lite');
    assert.equal(minLevel('off', 'full'), 'off');
    assert.equal(minLevel('lite', null), 'lite');
    assert.equal(lowerLevel('full'), 'lite');
    assert.equal(lowerLevel('lite'), 'off');
    assert.equal(lowerLevel('off'), 'off');
  });
});

describe('watching real frame rate', () => {
  it('judges smooth, slow and struggling devices', () => {
    assert.equal(judgeFrames(frames(16.7)).verdict, 'ok');
    assert.equal(judgeFrames(frames(16.7)).fps, 60);
    assert.equal(judgeFrames(frames(30)).verdict, 'slow');
    assert.equal(judgeFrames(frames(70)).verdict, 'struggling');
    assert.equal(judgeFrames(frames(16.7, 10)).verdict, 'unknown', 'too few frames to judge');
  });

  it('treats frequent long frames as jank even when the median is fine', () => {
    const mixed = [...frames(16.7, 50), ...frames(80, 20)];
    assert.equal(judgeFrames(mixed).verdict, 'struggling');
    const someJank = [...frames(16.7, 60), ...frames(80, 10)];
    assert.equal(judgeFrames(someJank).verdict, 'slow');
  });

  it('does not mistake a covered or minimised window for a slow device', () => {
    assert.equal(judgeFrames(frames(500)).verdict, 'unknown');
    assert.equal(levelAfterCheck('full', judgeFrames(frames(500)).verdict), 'full');
  });

  it('ignores start-up frames and junk values', () => {
    const v = judgeFrames([500, 500, 500, 500, 500, ...frames(16.7, 40), NaN, -1, 5000]);
    assert.equal(v.verdict, 'ok');
  });

  it('steps down one level at a time', () => {
    assert.equal(levelAfterCheck('full', 'ok'), 'full');
    assert.equal(levelAfterCheck('full', 'slow'), 'lite');
    assert.equal(levelAfterCheck('lite', 'slow'), 'lite', 'lite is already cheap');
    assert.equal(levelAfterCheck('full', 'struggling'), 'lite');
    assert.equal(levelAfterCheck('lite', 'struggling'), 'off');
    assert.equal(levelAfterCheck('full', 'unknown'), 'full');
  });
});

describe('celebration budgets', () => {
  it('uses confetti only on full and fewer pieces on phones', () => {
    assert.equal(confettiBudget('full', 'big', 1280), 110);
    assert.equal(confettiBudget('full', 'big', 390), 66);
    assert.ok(confettiBudget('full', 'small', 1280) < confettiBudget('full', 'pb', 1280));
    assert.equal(confettiBudget('lite', 'big'), 0);
    assert.equal(confettiBudget('off', 'big'), 0);
  });

  it('uses a few emoji on lite and nothing on off', () => {
    assert.equal(burstBudget('lite', 'big'), 6);
    assert.equal(burstBudget('lite', 'small'), 3);
    assert.equal(burstBudget('off', 'big'), 0);
  });
});

describe('count-up numbers', () => {
  it('parses XP-style numbers and keeps the surrounding text', () => {
    assert.deepEqual(parseCountText('+1,250 XP'), { prefix: '+', value: 1250, suffix: ' XP', grouped: true });
    assert.deepEqual(parseCountText('12,34,567'), { prefix: '', value: 1234567, suffix: '', grouped: true });
    assert.deepEqual(parseCountText(' 420 '), { prefix: '', value: 420, suffix: '', grouped: false });
  });

  it('skips text that is not one whole number', () => {
    assert.equal(parseCountText('2 of 5'), null);
    assert.equal(parseCountText('1.5'), null);
    assert.equal(parseCountText('Level 2'), null);
    assert.equal(parseCountText('0'), null, 'tiny numbers are not worth animating');
    assert.equal(parseCountText(''), null);
    assert.equal(parseCountText(null), null);
  });

  it('formats like the XP numbers on the page', () => {
    assert.equal(formatCount(1234567.4, true), '12,34,567');
    assert.equal(formatCount(99.6, false), '100');
  });
});

describe('wiring', () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  it('starts motion on every signed-in page and the sign-in page', () => {
    const guard = read('js/guard.js');
    assert.match(guard, /initMotion\(\{ isQuiet: isFullScreenStageActive \}\)/);
    assert.match(guard, /requireNoAuth\(\) \{\n {2}markPerf\('tt:guard-start'\);\n {2}initMotion\(\);/);
  });

  it('celebrates wins and offers the setting on the account page', () => {
    assert.match(read('js/xpRewards.js'), /celebrate\(hasBadge \? 'big'/);
    assert.match(read('js/basicsPractice.js'), /celebrate\('big', box\)/);
    assert.match(read('js/arena.js'), /celebrateOnce\(`league_/);
    assert.match(read('pages/account.html'), /id="pref-motion"/);
  });

  it('never animates in print and backs off for timed play', () => {
    const src = read('js/motion.js');
    assert.match(src, /@media print/);
    assert.match(src, /if \(state\.isQuiet\(\)\) return;/);
  });
});
