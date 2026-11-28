/**
 * Trendz Tracker - Student comfort settings at runtime (js/prefs.js)
 *
 * - Keeps one settings object (see shared/studentPrefs.js) in localStorage.
 * - Applies it to <html>: data-theme, data-large-numbers (data-motion is set by motion.js).
 * - For signed-in students, loads the database copy once per page and saves changes
 *   back (debounced), so settings follow the student across devices.
 *   The device copy is the fallback whenever the database cannot be reached.
 *
 * public/theme-boot.js applies theme and large numbers before the page paints.
 */

import {
  PREFS_STORAGE_KEY,
  normalizePrefs,
  parseStoredPrefs,
  serializePrefs,
  resolveTheme,
  mergePrefs,
  prefsEqual,
  diffFromDefaults,
} from '../shared/studentPrefs.js';
import { getMotionPreference, setMotionPreference } from './motion.js';

const SAVE_DELAY_MS = 800;
const listeners = new Set();

const state = {
  prefs: null,
  updatedAt: 0,
  synced: false,
  syncing: null,
  saveTimer: null,
  userId: null,
};

function readLocal() {
  try {
    return parseStoredPrefs(globalThis.localStorage?.getItem(PREFS_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeLocal(prefs, updatedAt) {
  try {
    globalThis.localStorage?.setItem(PREFS_STORAGE_KEY, serializePrefs(prefs, updatedAt));
  } catch {
    /* private mode: keep the in-memory copy */
  }
}

function systemDark() {
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches);
  } catch {
    return false;
  }
}

function load() {
  if (state.prefs) return state.prefs;
  const stored = readLocal();
  if (stored) {
    state.prefs = stored.prefs;
    state.updatedAt = stored.updatedAt;
  } else {
    // First run: carry over the older device-only animation choice.
    state.prefs = normalizePrefs({ motion: getMotionPreference() });
    state.updatedAt = 0;
  }
  return state.prefs;
}

export function getPrefs() {
  return { ...load() };
}

/** Applies the settings to the page. Safe to call often. */
export function applyPrefs(prefs = load(), doc = globalThis.document) {
  const root = doc?.documentElement;
  if (!root) return;
  const theme = resolveTheme(prefs.theme, systemDark());
  root.dataset.theme = theme;
  root.dataset.themeChoice = prefs.theme;
  root.style.colorScheme = theme;
  if (prefs.largeNumbers) root.dataset.largeNumbers = 'on';
  else delete root.dataset.largeNumbers;
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0F172A' : '#2563EB');
  if (getMotionPreference() !== prefs.motion) setMotionPreference(prefs.motion);
}

function emit() {
  const snapshot = getPrefs();
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch {
      /* one bad listener should not stop the rest */
    }
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent('tt:prefs', { detail: snapshot }));
  } catch {
    /* old browsers */
  }
}

/** Calls fn(prefs) whenever settings change. Returns an unsubscribe function. */
export function onPrefsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Changes one or more settings, applies them now, and saves them (device + database). */
export function setPrefs(patch = {}) {
  const next = normalizePrefs({ ...load(), ...patch });
  if (prefsEqual(next, state.prefs)) return getPrefs();
  state.prefs = next;
  state.updatedAt = Date.now();
  writeLocal(next, state.updatedAt);
  applyPrefs(next);
  emit();
  scheduleRemoteSave();
  return getPrefs();
}

/* ------------------------------------------------------------------ Database sync */

async function getClient() {
  try {
    const { getSupabase } = await import('./supabaseClient.js');
    return await getSupabase();
  } catch {
    return null;
  }
}

function scheduleRemoteSave() {
  if (!state.userId) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveRemote, SAVE_DELAY_MS);
}

async function saveRemote() {
  const supabase = state.userId ? await getClient() : null;
  if (!supabase) return false;
  try {
    const { error } = await supabase.rpc('save_my_preferences', { p_prefs: diffFromDefaults(state.prefs) });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Loads the student's saved settings from the database and keeps whichever copy
 * is newer. Called once per page by guard.js after sign-in. Never throws.
 * @param {{ id?: string, role?: string } | null} profile
 */
export function syncPrefsForProfile(profile) {
  if (!profile?.id) return Promise.resolve(false);
  if (state.userId === profile.id && (state.synced || state.syncing)) return state.syncing || Promise.resolve(true);
  state.userId = profile.id;
  state.syncing = (async () => {
    const supabase = await getClient();
    if (!supabase) return false;
    try {
      const { data, error } = await supabase.rpc('my_preferences');
      if (error) return false;
      const row = Array.isArray(data) ? data[0] : data;
      load();
      const remote = row && row.prefs ? { prefs: row.prefs, updatedAt: row.updated_at } : null;
      const winner = mergePrefs({ prefs: state.prefs, updatedAt: state.updatedAt }, remote);
      if (winner.source === 'remote' && !prefsEqual(winner.prefs, state.prefs)) {
        state.prefs = winner.prefs;
        state.updatedAt = winner.updatedAt || Date.now();
        writeLocal(state.prefs, state.updatedAt);
        applyPrefs(state.prefs);
        emit();
      } else if (winner.source === 'local' && state.updatedAt > 0) {
        await saveRemote();
      }
      state.synced = true;
      return true;
    } catch {
      return false;
    } finally {
      state.syncing = null;
    }
  })();
  return state.syncing;
}

/** Wires system theme changes and other tabs. Called once by guard.js. */
let started = false;
export function initPrefs() {
  if (started || typeof document === 'undefined') return getPrefs();
  started = true;
  applyPrefs(load());
  try {
    globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', () => applyPrefs(load()));
  } catch {
    /* old Safari */
  }
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key !== PREFS_STORAGE_KEY) return;
    const stored = readLocal();
    if (!stored) return;
    state.prefs = stored.prefs;
    state.updatedAt = stored.updatedAt;
    applyPrefs(state.prefs);
    emit();
  });
  return getPrefs();
}
