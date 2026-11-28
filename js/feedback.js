/**
 * Trendz Tracker - Sound effects, background music and phone buzz (js/feedback.js)
 *
 * Every sound is synthesised in the browser with the Web Audio API: there are no
 * audio files to download, licence or cache. The sounds and the music loop are
 * original to this project (see docs/SOUNDS.md for the list and licence).
 *
 *   cue('correct' | 'wrong' | 'start' | 'tick' | 'finish' | 'pb' | 'levelup' | 'win' | 'chest')
 *     plays the sound and buzzes the phone, each only if the student has it on.
 *   practiceStarted(context) / practiceEnded()
 *     a round began / ended: start cue + optional background music, finish cue + music stop.
 *     context 'test' = weekly tests and Memoriad competition rounds (music only if
 *     the student also turned on "music in tests").
 *
 * Other code can also fire `document.dispatchEvent(new CustomEvent('tt:cue', { detail: 'chest' }))`
 * without importing this module.
 */

import { getPrefs, onPrefsChange } from './prefs.js';
import { musicAllowed } from '../shared/studentPrefs.js';

export const CUES = Object.freeze(['correct', 'wrong', 'start', 'tick', 'finish', 'pb', 'levelup', 'win', 'chest']);

/** Vibration patterns (ms). Kept short: a buzz confirms, it should never nag. */
export const BUZZ = Object.freeze({
  correct: [12],
  wrong: [30, 40, 30],
  start: [20],
  tick: [8],
  finish: [25],
  pb: [20, 40, 20, 40, 60],
  levelup: [30, 50, 30, 50, 90],
  win: [40, 60, 40, 60, 120],
  chest: [15, 30, 15, 30, 15, 30, 60],
});

/* Note frequencies (Hz) */
const N = {
  C4: 261.63, E4: 329.63, G4: 392.0, A4: 440.0,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98,
};

/**
 * Each sound is a list of notes: [startSec, freq, durSec, wave, gain, slideTo?].
 * Exported so tests can check every cue is short.
 */
export const SOUND_SPECS = Object.freeze({
  correct: [[0, N.E5, 0.09, 'triangle', 0.5], [0.07, N.A5, 0.16, 'triangle', 0.5]],
  wrong: [[0, 220, 0.2, 'triangle', 0.45, 165], [0.05, 196, 0.18, 'sine', 0.25, 147]],
  start: [[0, N.C5, 0.09, 'triangle', 0.4], [0.08, N.E5, 0.09, 'triangle', 0.4], [0.16, N.G5, 0.22, 'triangle', 0.45]],
  tick: [[0, N.A5, 0.05, 'sine', 0.3]],
  finish: [[0, N.G5, 0.12, 'triangle', 0.45], [0.1, N.C6, 0.32, 'sine', 0.5], [0.1, N.E5, 0.32, 'sine', 0.2]],
  pb: [
    [0, N.C5, 0.1, 'triangle', 0.4], [0.08, N.E5, 0.1, 'triangle', 0.4], [0.16, N.G5, 0.1, 'triangle', 0.4],
    [0.24, N.C6, 0.35, 'sine', 0.5], [0.3, N.E6, 0.12, 'sine', 0.18], [0.38, N.G6, 0.16, 'sine', 0.14],
  ],
  levelup: [
    [0, N.G4, 0.1, 'square', 0.16], [0.09, N.C5, 0.1, 'square', 0.16], [0.18, N.E5, 0.1, 'square', 0.16],
    [0.27, N.G5, 0.12, 'square', 0.16], [0.4, N.C6, 0.5, 'triangle', 0.45], [0.4, N.E5, 0.5, 'sine', 0.25],
    [0.4, N.G5, 0.5, 'sine', 0.2],
  ],
  win: [
    [0, N.C5, 0.12, 'triangle', 0.45], [0.12, N.C5, 0.08, 'triangle', 0.4], [0.22, N.G5, 0.14, 'triangle', 0.45],
    [0.38, N.E5, 0.1, 'triangle', 0.4], [0.5, N.C6, 0.55, 'triangle', 0.5], [0.5, N.G5, 0.55, 'sine', 0.25],
    [0.5, N.E5, 0.55, 'sine', 0.2],
  ],
  chest: [
    [0, 140, 0.25, 'noise', 0.22], [0.18, N.D6, 0.08, 'sine', 0.25], [0.24, N.G6, 0.08, 'sine', 0.22],
    [0.3, N.E6, 0.08, 'sine', 0.22], [0.36, N.C6, 0.4, 'triangle', 0.4], [0.36, N.G5, 0.4, 'sine', 0.2],
  ],
});

/** Longest sound in seconds (used by tests: every cue stays under a second). */
export function soundLength(name) {
  const spec = SOUND_SPECS[name];
  if (!spec) return 0;
  return spec.reduce((m, [t, , d]) => Math.max(m, t + d), 0);
}

/** Whether a cue should make sound / buzz for these settings. */
export function cuePlan(name, prefs, env = {}) {
  const known = CUES.includes(name);
  return {
    sound: known && Boolean(prefs?.sound) && !env.hidden,
    buzz: known && Boolean(prefs?.vibrate) && Boolean(env.canVibrate) && !env.hidden,
  };
}

/* ------------------------------------------------------------------ Audio runtime */

let ctx = null;
let master = null;
let noiseBuffer = null;

function audio() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = getPrefs().volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

function getNoise(ac) {
  if (noiseBuffer) return noiseBuffer;
  const len = Math.floor(ac.sampleRate * 0.4);
  noiseBuffer = ac.createBuffer(1, len, ac.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  return noiseBuffer;
}

function playNote(ac, out, at, [t, freq, dur, wave, gain, slideTo]) {
  const start = at + t;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * 0.35), start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  g.connect(out);
  if (wave === 'noise') {
    const src = ac.createBufferSource();
    src.buffer = getNoise(ac);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq * 4, start);
    bp.frequency.exponentialRampToValueAtTime(freq * 24, start + dur);
    src.connect(bp);
    bp.connect(g);
    src.start(start);
    src.stop(start + dur + 0.02);
    return;
  }
  const osc = ac.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  osc.connect(g);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function playSound(name) {
  const spec = SOUND_SPECS[name];
  if (!spec) return false;
  const ac = audio();
  if (!ac) return false;
  try {
    const at = ac.currentTime + 0.01;
    for (const note of spec) playNote(ac, master, at, note);
    return true;
  } catch {
    return false;
  }
}

export function buzz(name) {
  const pattern = BUZZ[name];
  if (!pattern || typeof globalThis.navigator?.vibrate !== 'function') return false;
  try {
    return globalThis.navigator.vibrate(pattern);
  } catch {
    return false;
  }
}

export function canVibrate() {
  return typeof globalThis.navigator?.vibrate === 'function';
}

/** Plays a cue's sound and buzz, each only if the student has it switched on. */
export function cue(name) {
  const plan = cuePlan(name, getPrefs(), { hidden: globalThis.document?.hidden, canVibrate: canVibrate() });
  if (plan.sound) playSound(name);
  if (plan.buzz) buzz(name);
  return plan;
}

/* ------------------------------------------------------------------ Background music */

/**
 * A calm, original loop: a soft pad chord under a slow pentatonic pattern, built
 * from the same oscillators. Two bars of 4 beats at 72 bpm, chords I-vi-IV-V in C.
 */
export const MUSIC_BPM = 72;
const CHORDS = [
  [N.C4, N.E4, N.G4],
  [220.0, N.C4, N.E4], // A3 C4 E4
  [174.61, 220.0, N.C4], // F3 A3 C4
  [196.0, 246.94, 293.66], // G3 B3 D4
];
const MELODY = [
  [N.E5, N.G5, N.C6, N.G5], [N.E5, N.A5, N.C6, N.A5],
  [N.C5, N.A5, N.C6, N.A5], [N.D5, N.G5, N.D6, N.G5],
];

const music = { on: false, context: 'practice', bus: null, timer: null, nextAt: 0, bar: 0 };

function scheduleBar(ac, at, bar) {
  const beat = 60 / MUSIC_BPM;
  const chord = CHORDS[bar % CHORDS.length];
  const line = MELODY[bar % MELODY.length];
  for (const f of chord) playNote(ac, music.bus, at, [0, f, beat * 4, 'sine', 0.22]);
  line.forEach((f, i) => playNote(ac, music.bus, at, [i * beat, f, beat * 0.9, 'triangle', 0.16]));
}

function musicTick() {
  if (!music.on || !ctx) return;
  const beat = 60 / MUSIC_BPM;
  while (music.nextAt < ctx.currentTime + 1.2) {
    scheduleBar(ctx, music.nextAt, music.bar);
    music.nextAt += beat * 4;
    music.bar += 1;
  }
}

function startMusic() {
  if (music.on) return;
  const ac = audio();
  if (!ac) return;
  music.on = true;
  music.bus = ac.createGain();
  music.bus.gain.setValueAtTime(0.0001, ac.currentTime);
  music.bus.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 1.5);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1800;
  music.bus.connect(lp);
  lp.connect(master);
  music.nextAt = ac.currentTime + 0.1;
  music.bar = 0;
  musicTick();
  music.timer = setInterval(musicTick, 400);
}

export function stopMusic() {
  if (!music.on) return;
  music.on = false;
  clearInterval(music.timer);
  const bus = music.bus;
  music.bus = null;
  if (bus && ctx) {
    try {
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      setTimeout(() => bus.disconnect(), 800);
    } catch {
      /* already gone */
    }
  }
}

export function isMusicPlaying() {
  return music.on;
}

let roundActive = false;

function syncMusic() {
  const want = roundActive && !globalThis.document?.hidden && musicAllowed(getPrefs(), music.context);
  if (want) startMusic();
  else stopMusic();
}

/**
 * A practice round or test section has begun (call it from the click that starts it,
 * so browsers allow audio).
 * @param {'practice'|'test'} [context]
 * @param {{ cue?: boolean }} [opts] cue:false skips the start sound (e.g. a countdown already played it)
 */
export function practiceStarted(context = 'practice', { cue: withCue = true } = {}) {
  music.context = context === 'test' ? 'test' : 'practice';
  roundActive = true;
  if (withCue) cue('start');
  syncMusic();
}

/** The round is over: stops the music and plays the finish sound (unless cue:false). */
export function practiceEnded({ cue: withCue = true } = {}) {
  const was = roundActive;
  roundActive = false;
  stopMusic();
  if (withCue && was) cue('finish');
}

/** A short preview for the settings panel. */
export function previewMusic(ms = 6000) {
  const keep = roundActive;
  roundActive = true;
  music.context = 'practice';
  startMusic();
  setTimeout(() => {
    roundActive = keep;
    if (!keep) stopMusic();
  }, ms);
}

/* ------------------------------------------------------------------ Wiring */

let wired = false;
export function initFeedback() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  onPrefsChange((p) => {
    if (master && ctx) master.gain.setValueAtTime(p.volume, ctx.currentTime);
    syncMusic();
  });
  document.addEventListener('visibilitychange', syncMusic);
  globalThis.addEventListener?.('pagehide', stopMusic);
  document.addEventListener('tt:cue', (e) => {
    const name = typeof e.detail === 'string' ? e.detail : e.detail?.name;
    if (CUES.includes(name)) cue(name);
  });
}
