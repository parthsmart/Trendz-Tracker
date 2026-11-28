/**
 * Trendz Tracker - Student comfort settings (pure model, no DOM).
 *
 * One small object holds every "how the app feels" choice a student makes:
 * sound, music, vibration, theme, large numbers and animations. It is saved
 * on the device (localStorage) and, for signed-in students, in the database
 * (public.student_preferences via my_preferences / save_my_preferences) so
 * it follows them to any phone or computer.
 *
 * Mirrored in SQL by public.student_prefs_clean() - keep the keys and allowed
 * values in step.
 */

export const PREFS_STORAGE_KEY = 'tt_prefs';
export const PREFS_VERSION = 1;

export const THEME_CHOICES = Object.freeze(['system', 'light', 'dark']);
/** Same values as js/motion.js MOTION_PREFS ('off' = reduced motion). */
export const MOTION_CHOICES = Object.freeze(['auto', 'full', 'lite', 'off']);
export const VOLUME_STEPS = Object.freeze([0.25, 0.5, 0.75, 1]);

export const DEFAULT_PREFS = Object.freeze({
  sound: true, // short effects: correct, wrong, start, finish, best, level-up, win, chest
  volume: 0.75,
  music: false, // background music during practice; off until the student turns it on
  musicInTests: false, // also play in weekly tests and Memoriad competition rounds
  vibrate: true, // phone buzz where the browser supports it
  theme: 'system',
  largeNumbers: false,
  motion: 'auto',
});

const BOOL_KEYS = ['sound', 'music', 'musicInTests', 'vibrate', 'largeNumbers'];

function nearestVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_PREFS.volume;
  return VOLUME_STEPS.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), VOLUME_STEPS[0]);
}

/** Returns a full, valid settings object. Unknown keys are dropped, bad values fall back to defaults. */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULT_PREFS };
  for (const k of BOOL_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (THEME_CHOICES.includes(src.theme)) out.theme = src.theme;
  if (MOTION_CHOICES.includes(src.motion)) out.motion = src.motion;
  if (src.volume !== undefined) out.volume = nearestVolume(src.volume);
  return out;
}

/** Only the values that differ from the defaults (what gets stored). */
export function diffFromDefaults(prefs) {
  const p = normalizePrefs(prefs);
  const out = {};
  for (const [k, v] of Object.entries(p)) if (DEFAULT_PREFS[k] !== v) out[k] = v;
  return out;
}

export function prefsEqual(a, b) {
  const x = normalizePrefs(a);
  const y = normalizePrefs(b);
  return Object.keys(DEFAULT_PREFS).every((k) => x[k] === y[k]);
}

/** 'light' | 'dark' for a theme choice and the system setting. */
export function resolveTheme(choice, systemDark = false) {
  if (choice === 'dark') return 'dark';
  if (choice === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

/**
 * Picks which copy wins when the device copy and the database copy disagree.
 * Each side is { prefs, updatedAt } (ISO time or ms). Newer wins; a missing
 * time loses to a present one; ties keep the server copy.
 */
export function mergePrefs(local, remote) {
  const t = (x) => {
    const v = x?.updatedAt;
    const n = typeof v === 'number' ? v : Date.parse(v || '');
    return Number.isFinite(n) ? n : 0;
  };
  if (!remote || !remote.prefs) return { prefs: normalizePrefs(local?.prefs), updatedAt: t(local), source: 'local' };
  if (!local || !local.prefs) return { prefs: normalizePrefs(remote.prefs), updatedAt: t(remote), source: 'remote' };
  return t(local) > t(remote)
    ? { prefs: normalizePrefs(local.prefs), updatedAt: t(local), source: 'local' }
    : { prefs: normalizePrefs(remote.prefs), updatedAt: t(remote), source: 'remote' };
}

/**
 * Practice contexts for background music. Weekly tests and Memoriad
 * competition rounds are 'test': music only plays there if musicInTests is on.
 */
export function musicAllowed(prefs, context = 'practice') {
  const p = normalizePrefs(prefs);
  if (!p.music) return false;
  if (context === 'test') return p.musicInTests;
  return context === 'practice';
}

/** Reads the stored device copy: { prefs, updatedAt } or null. Tolerates junk. */
export function parseStoredPrefs(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') return null;
    return { prefs: normalizePrefs(v.p ?? v.prefs ?? v), updatedAt: Number(v.t) || 0 };
  } catch {
    return null;
  }
}

export function serializePrefs(prefs, updatedAt = Date.now()) {
  return JSON.stringify({ v: PREFS_VERSION, p: diffFromDefaults(prefs), t: updatedAt });
}
