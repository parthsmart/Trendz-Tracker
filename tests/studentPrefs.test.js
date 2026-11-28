import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PREFS,
  normalizePrefs,
  diffFromDefaults,
  prefsEqual,
  resolveTheme,
  mergePrefs,
  musicAllowed,
  parseStoredPrefs,
  serializePrefs,
} from '../shared/studentPrefs.js';
import { CUES, BUZZ, SOUND_SPECS, soundLength, cuePlan } from '../js/feedback.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('prefs: defaults are quiet-friendly (music off, theme follows system)', () => {
  assert.equal(DEFAULT_PREFS.music, false);
  assert.equal(DEFAULT_PREFS.musicInTests, false);
  assert.equal(DEFAULT_PREFS.theme, 'system');
  assert.equal(DEFAULT_PREFS.motion, 'auto');
  assert.deepEqual(normalizePrefs(undefined), { ...DEFAULT_PREFS });
});

test('prefs: normalize drops unknown keys and bad values', () => {
  const p = normalizePrefs({ sound: 'yes', theme: 'neon', motion: 'off', largeNumbers: true, volume: 0.3, evil: '<x>' });
  assert.equal(p.sound, DEFAULT_PREFS.sound);
  assert.equal(p.theme, 'system');
  assert.equal(p.motion, 'off');
  assert.equal(p.largeNumbers, true);
  assert.equal(p.volume, 0.25);
  assert.equal('evil' in p, false);
  assert.deepEqual(normalizePrefs([1, 2]), { ...DEFAULT_PREFS });
});

test('prefs: only differences from defaults are stored', () => {
  assert.deepEqual(diffFromDefaults(DEFAULT_PREFS), {});
  assert.deepEqual(diffFromDefaults({ theme: 'dark', music: true }), { theme: 'dark', music: true });
  assert.ok(prefsEqual({}, DEFAULT_PREFS));
  assert.ok(!prefsEqual({ theme: 'dark' }, {}));
});

test('prefs: theme resolves against the system setting', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('prefs: newer copy wins when device and database disagree', () => {
  const local = { prefs: { theme: 'dark' }, updatedAt: 2000 };
  const remote = { prefs: { theme: 'light' }, updatedAt: new Date(1000).toISOString() };
  assert.equal(mergePrefs(local, remote).prefs.theme, 'dark');
  assert.equal(mergePrefs({ ...local, updatedAt: 500 }, remote).prefs.theme, 'light');
  assert.equal(mergePrefs(local, null).source, 'local');
  assert.equal(mergePrefs(null, remote).source, 'remote');
  // Never-saved device copy loses to the account copy.
  assert.equal(mergePrefs({ prefs: { theme: 'dark' }, updatedAt: 0 }, remote).source, 'remote');
});

test('prefs: music stays out of tests and Memoriad competitions unless allowed', () => {
  assert.equal(musicAllowed({}, 'practice'), false);
  assert.equal(musicAllowed({ music: true }, 'practice'), true);
  assert.equal(musicAllowed({ music: true }, 'test'), false);
  assert.equal(musicAllowed({ music: true, musicInTests: true }, 'test'), true);
  assert.equal(musicAllowed({ music: false, musicInTests: true }, 'test'), false);
});

test('prefs: device copy round-trips and tolerates junk', () => {
  const text = serializePrefs({ theme: 'dark', largeNumbers: true }, 1234);
  const back = parseStoredPrefs(text);
  assert.equal(back.updatedAt, 1234);
  assert.equal(back.prefs.theme, 'dark');
  assert.equal(back.prefs.largeNumbers, true);
  assert.equal(parseStoredPrefs('{not json'), null);
  assert.equal(parseStoredPrefs(''), null);
});

test('prefs: theme-boot.js reads the same storage key and format', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'theme-boot.js'), 'utf8');
  assert.match(boot, /localStorage\.getItem\('tt_prefs'\)/);
  assert.match(boot, /raw\.p/);
});

test('prefs: every app page loads theme-boot.js in <head>', () => {
  const pages = fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html')).map((f) => path.join('pages', f));
  for (const rel of [...pages, 'index.html']) {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.includes('<script src="/theme-boot.js"></script>'), `${rel} is missing theme-boot.js`);
  }
});

test('prefs: SQL cleaner allows the same keys as the model', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('_student_preferences.sql'));
  assert.ok(file, 'student_preferences migration exists');
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const key of Object.keys(DEFAULT_PREFS)) assert.ok(sql.includes(`'${key}'`), `SQL knows ${key}`);
  assert.match(sql, /REVOKE ALL ON public\.student_preferences FROM anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.save_my_preferences\(jsonb\) FROM PUBLIC, anon/);
  assert.match(sql, /auth\.uid\(\)/);
});

test('feedback: every cue has a short sound and a short buzz', () => {
  for (const name of CUES) {
    assert.ok(SOUND_SPECS[name], `${name} has a sound`);
    const len = soundLength(name);
    assert.ok(len > 0 && len <= 1.1, `${name} lasts ${len}s`);
    const buzzMs = BUZZ[name].reduce((a, b) => a + b, 0);
    assert.ok(buzzMs <= 400, `${name} buzz ${buzzMs}ms`);
  }
});

test('feedback: cues respect sound and vibration settings', () => {
  assert.deepEqual(cuePlan('correct', { sound: true, vibrate: true }, { canVibrate: true }), { sound: true, buzz: true });
  assert.deepEqual(cuePlan('correct', { sound: false, vibrate: true }, { canVibrate: false }), { sound: false, buzz: false });
  assert.deepEqual(cuePlan('wrong', { sound: true, vibrate: true }, { canVibrate: true, hidden: true }), { sound: false, buzz: false });
  assert.deepEqual(cuePlan('nope', { sound: true, vibrate: true }, { canVibrate: true }), { sound: false, buzz: false });
});

test('feedback: sound list and licence are documented', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'SOUNDS.md'), 'utf8');
  for (const name of CUES) assert.ok(doc.includes(`\`${name}\``), `docs/SOUNDS.md lists ${name}`);
  assert.match(doc, /CC0/);
});
