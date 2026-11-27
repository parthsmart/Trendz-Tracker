/**
 * Trendz Tracker - Adaptive motion (js/motion.js)
 *
 * Small game-style animations across the whole site (button presses and ripples,
 * cards that slide in, numbers that count up, bars that fill, confetti for wins),
 * scaled to what the device can handle:
 *
 *   full - everything, including the confetti canvas, count-ups and scroll reveals
 *   lite - cheap CSS-only touches (press, fades, bars) and a tiny emoji burst for wins
 *   off  - no extra motion at all
 *
 * "Auto" (the default) picks the level from the device: reduced-motion setting ->
 * off; Data Saver, 2G, <= 2 GB memory or <= 2 CPU cores -> lite; otherwise full.
 * While the page runs it also watches real frame rate, long main-thread tasks and
 * JS memory use, and steps down a level when the device struggles. A step down is
 * remembered for the rest of the browser session so the next page starts lower.
 * Students can override the choice on the Account page (saved on the device).
 *
 * Timed practice screens are left alone: no ripples or reveals while a full-screen
 * practice stage is active, so animations never compete with a drill.
 */

export const MOTION_LEVELS = Object.freeze(['off', 'lite', 'full']);
export const MOTION_PREFS = Object.freeze(['auto', 'full', 'lite', 'off']);
export const MOTION_PREF_KEY = 'tt_motion';
export const MOTION_CAP_KEY = 'tt_motion_cap';

const STYLE_ID = 'tt-motion-styles';
const INTRO_WINDOW_MS = 2500;
const MAX_RIPPLES = 4;
const MAX_PARTICLES = 160;
const CONFETTI_MAX_MS = 3000;
export const THROTTLED_FRAME_MS = 200;
const REVEAL_SELECTOR = [
  '.card', '.gm-card', '.xp-card', '.ar-duel', '.ar-shop > li', '.ar-board > li:not(.ar-group)',
  '.ar-cvc > li', '.pf-badge', '.lb-col', '.ac-row', '.stat-card', '.dash-card',
].join(',');
const COUNT_SELECTOR = ['.xp-gain', '.xp-stat b', '.ar-wallet b', '.gm-val', '.lb-val', '.pf-stat b', '[data-count-up]'].join(',');
const RIPPLE_SELECTOR = '.btn, .ar-tab, .ar-chip, .header-nav-link, .nav-link';

/* ------------------------------------------------------------------ Pure helpers */

function levelIndex(level) {
  const i = MOTION_LEVELS.indexOf(level);
  return i < 0 ? MOTION_LEVELS.length - 1 : i;
}

/** The lower of two levels; a null/unknown cap means "no cap". */
export function minLevel(a, b) {
  if (!MOTION_LEVELS.includes(b)) return MOTION_LEVELS.includes(a) ? a : 'full';
  if (!MOTION_LEVELS.includes(a)) return b;
  return levelIndex(a) <= levelIndex(b) ? a : b;
}

/** One level down ('full' -> 'lite' -> 'off'). */
export function lowerLevel(level) {
  return MOTION_LEVELS[Math.max(0, levelIndex(level) - 1)];
}

export function normalizeMotionPref(pref) {
  return MOTION_PREFS.includes(pref) ? pref : 'auto';
}

/** Reads what the browser tells us about the device. Every field is optional. */
export function readMotionEnv(win = globalThis) {
  const nav = win?.navigator || {};
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
  let reduced = false;
  try {
    reduced = Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  } catch {
    reduced = false;
  }
  return {
    reduced,
    saveData: Boolean(conn?.saveData),
    net: typeof conn?.effectiveType === 'string' ? conn.effectiveType : '',
    memory: Number(nav.deviceMemory) || 0,
    cores: Number(nav.hardwareConcurrency) || 0,
  };
}

/**
 * Chooses the motion level.
 * @param {ReturnType<typeof readMotionEnv>} env
 * @param {{ pref?: string, cap?: string|null }} [opts] pref = user's choice, cap = auto step-down
 */
export function pickMotionLevel(env = {}, { pref = 'auto', cap = null } = {}) {
  const choice = normalizeMotionPref(pref);
  if (choice !== 'auto') return choice; // the student's own choice always wins
  if (env.reduced) return 'off';
  let level = 'full';
  const slowNet = env.net === 'slow-2g' || env.net === '2g';
  if (env.saveData || slowNet) level = 'lite';
  if (env.memory > 0 && env.memory <= 2) level = 'lite';
  if (env.cores > 0 && env.cores <= 2) level = 'lite';
  return minLevel(level, cap);
}

/**
 * Judges a run of frame intervals (ms). The first few frames are skipped because
 * they include start-up work.
 * @returns {{ fps: number, jank: number, verdict: 'ok'|'slow'|'struggling'|'unknown' }}
 */
export function judgeFrames(intervals = []) {
  const usable = intervals.slice(5).filter((v) => Number.isFinite(v) && v > 0 && v < 1000);
  if (usable.length < 20) return { fps: 0, jank: 0, verdict: 'unknown' };
  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // A covered or minimised window is throttled to a few frames a second: that says
  // nothing about the device, so do not judge it.
  if (median > THROTTLED_FRAME_MS) return { fps: Math.round(1000 / median), jank: 0, verdict: 'unknown' };
  const fps = Math.round(1000 / median);
  const jank = usable.filter((v) => v > 50).length / usable.length;
  let verdict = 'ok';
  if (fps < 20 || jank > 0.3) verdict = 'struggling';
  else if (fps < 42 || jank > 0.12) verdict = 'slow';
  return { fps, jank: Math.round(jank * 100) / 100, verdict };
}

/** Level to use after a frame-rate check. 'struggling' on lite turns motion off. */
export function levelAfterCheck(level, verdict) {
  if (verdict === 'struggling') return level === 'full' ? 'lite' : 'off';
  if (verdict === 'slow' && level === 'full') return 'lite';
  return level;
}

/** Confetti pieces for a celebration; 0 means "use the light emoji burst instead". */
export function confettiBudget(level, kind = 'small', viewportWidth = 1024) {
  if (level !== 'full') return 0;
  const base = { big: 110, pb: 80, small: 36 }[kind] ?? 36;
  const scaled = viewportWidth < 520 ? base * 0.6 : base;
  return Math.min(MAX_PARTICLES, Math.round(scaled));
}

/** Emoji pieces for the light celebration. */
export function burstBudget(level, kind = 'small') {
  if (level === 'off') return 0;
  return kind === 'big' ? 6 : kind === 'pb' ? 5 : 3;
}

/**
 * Splits "+1,250 XP" into parts for counting up. Returns null for text that is not
 * a single whole number (or is too small to be worth animating).
 */
export function parseCountText(text) {
  const m = /^(\D*?)(\d{1,3}(?:,\d{2,3})+|\d+)(\D*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(value) || value < 3 || value > 10_000_000) return null;
  return { prefix: m[1], value, suffix: m[3], grouped: m[2].includes(',') };
}

export function formatCount(value, grouped) {
  const v = Math.round(value);
  return grouped ? v.toLocaleString('en-IN') : String(v);
}

/* ------------------------------------------------------------------ Runtime state */

const state = {
  inited: false,
  level: 'full',
  pref: 'auto',
  isQuiet: () => false,
  startedAt: 0,
  ripples: 0,
  mo: null,
  io: null,
  pending: new Set(),
  flushQueued: false,
  confetti: null,
};

function safeGet(storage, key) {
  try {
    return globalThis[storage]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    if (value === null) globalThis[storage]?.removeItem(key);
    else globalThis[storage]?.setItem(key, value);
  } catch {
    /* private mode or blocked storage: keep the in-memory value */
  }
}

export function getMotionLevel() {
  return state.level;
}

export function getMotionPreference() {
  return normalizeMotionPref(safeGet('localStorage', MOTION_PREF_KEY));
}

/** Returns the level "auto" would pick on this device right now (for the settings row). */
export function getAutoMotionLevel() {
  return pickMotionLevel(readMotionEnv(globalThis), { pref: 'auto', cap: safeGet('sessionStorage', MOTION_CAP_KEY) });
}

function applyLevel(level) {
  state.level = MOTION_LEVELS.includes(level) ? level : 'full';
  const root = globalThis.document?.documentElement;
  if (root) root.dataset.motion = state.level;
  if (state.level === 'full') startWatchingDom();
  else stopWatchingDom();
  try {
    globalThis.dispatchEvent?.(new CustomEvent('tt:motion', { detail: { level: state.level } }));
  } catch {
    /* old browsers */
  }
}

function recompute() {
  const level = pickMotionLevel(readMotionEnv(globalThis), {
    pref: state.pref,
    cap: safeGet('sessionStorage', MOTION_CAP_KEY),
  });
  if (level !== state.level || !globalThis.document?.documentElement?.dataset.motion) applyLevel(level);
}

/** Saves the student's choice ('auto' | 'full' | 'lite' | 'off') and applies it now. */
export function setMotionPreference(pref) {
  state.pref = normalizeMotionPref(pref);
  safeSet('localStorage', MOTION_PREF_KEY, state.pref === 'auto' ? null : state.pref);
  if (state.pref !== 'auto') safeSet('sessionStorage', MOTION_CAP_KEY, null);
  recompute();
  return state.level;
}

/** Auto mode only: remember a step down for this browser session and apply it. */
function stepDown(to) {
  if (state.pref !== 'auto') return;
  const next = minLevel(to, state.level);
  if (next === state.level) return;
  safeSet('sessionStorage', MOTION_CAP_KEY, next);
  applyLevel(next);
}

/* ------------------------------------------------------------------ Watchdog */

function sampleFrames(count = 70) {
  return new Promise((resolve) => {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return resolve([]);
    const out = [];
    let last = 0;
    const tick = (t) => {
      if (globalThis.document?.hidden) return resolve([]); // background tabs are throttled
      if (last) out.push(t - last);
      last = t;
      if (out.length >= count) resolve(out);
      else raf(tick);
    };
    raf(tick);
  });
}

function heapUnderPressure() {
  const m = globalThis.performance?.memory;
  if (!m || !m.jsHeapSizeLimit) return false;
  return m.usedJSHeapSize / m.jsHeapSizeLimit > 0.8;
}

async function runFrameCheck() {
  if (state.pref !== 'auto' || state.level === 'off' || globalThis.document?.hidden) return;
  if (heapUnderPressure()) stepDown('lite');
  const { verdict } = judgeFrames(await sampleFrames());
  if (verdict !== 'unknown') stepDown(levelAfterCheck(state.level, verdict));
}

function startWatchdog() {
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const later = (ms) => setTimeout(() => idle(() => runFrameCheck(), { timeout: 2000 }), ms);
  const begin = () => {
    later(1200);
    later(20000);
  };
  if (globalThis.document?.readyState === 'complete') begin();
  else globalThis.addEventListener?.('load', begin, { once: true });

  // Many long main-thread tasks soon after load: this device is busy, go lighter.
  try {
    let longTasks = 0;
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 120) longTasks += 1;
      if (longTasks >= 4 && state.level === 'full') {
        stepDown('lite');
        obs.disconnect();
      }
    });
    obs.observe({ type: 'longtask', buffered: true });
    setTimeout(() => obs.disconnect(), 15000);
  } catch {
    /* longtask is Chromium-only */
  }
}

/* ------------------------------------------------------------------ Styles */

const CSS = `
html[data-motion="full"], html[data-motion="lite"] { --mo-spring: cubic-bezier(.2, 1.35, .45, 1); --mo-out: cubic-bezier(.2, .8, .2, 1); }
@keyframes mo-rise { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes mo-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mo-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes mo-pop { 0% { transform: scale(1); } 40% { transform: scale(1.18); } 100% { transform: scale(1); } }
@keyframes mo-ripple { from { transform: translate(-50%, -50%) scale(0); opacity: .35; } to { transform: translate(-50%, -50%) scale(1); opacity: 0; } }
@keyframes mo-wiggle { 0%, 100% { transform: rotate(0); } 25% { transform: rotate(-12deg) scale(1.08); } 75% { transform: rotate(10deg) scale(1.08); } }
@keyframes mo-shine { from { background-position: -160% 0; } to { background-position: 260% 0; } }
@keyframes mo-glow { 0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); } 50% { box-shadow: 0 0 0 4px rgba(37, 99, 235, .18); } }
@keyframes mo-burst { 0% { transform: translate(-50%, -50%) scale(.4); opacity: 0; } 15% { opacity: 1; } 100% { transform: translate(calc(-50% + var(--mo-dx)), calc(-50% + var(--mo-dy))) scale(1.15) rotate(var(--mo-rot)); opacity: 0; } }
@keyframes mo-toast { 0% { opacity: 0; transform: translateY(14px) scale(.96); } 100% { opacity: 1; transform: none; } }

/* Both levels: cheap, compositor-only touches */
html[data-motion="full"] .btn, html[data-motion="lite"] .btn,
html[data-motion="full"] .ar-tab, html[data-motion="lite"] .ar-tab,
html[data-motion="full"] .ar-chip, html[data-motion="lite"] .ar-chip { transition: transform .12s var(--mo-out), box-shadow .2s, background-color .2s, border-color .2s, color .2s; }
html[data-motion="full"] .btn:active:not(:disabled), html[data-motion="lite"] .btn:active:not(:disabled),
html[data-motion="full"] .ar-tab:active, html[data-motion="lite"] .ar-tab:active,
html[data-motion="full"] .ar-chip:active, html[data-motion="lite"] .ar-chip:active { transform: scale(.96); }
html[data-motion="full"] .xp-bar > span, html[data-motion="lite"] .xp-bar > span,
html[data-motion="full"] .ar-cvc-bar > i, html[data-motion="lite"] .ar-cvc-bar > i { transform-origin: left center; animation: mo-grow .9s var(--mo-out) both; }
html[data-motion="full"] .ar-panel:not([hidden]), html[data-motion="lite"] .ar-panel:not([hidden]) { animation: mo-fade .22s ease-out; }
html[data-motion="full"] .toast { animation: mo-toast .34s var(--mo-spring); }

/* Full only */
html[data-motion="full"] main { animation: mo-fade .28s ease-out; }
html[data-motion="full"] .mo-in { animation: mo-rise .46s var(--mo-out) both; animation-delay: var(--mo-delay, 0ms); }
html[data-motion="full"] .mo-wait { opacity: 0; }
html[data-motion="full"] .mo-pop { animation: mo-pop .42s var(--mo-spring); display: inline-block; }
html[data-motion="full"] .xp-badge { background-image: linear-gradient(110deg, transparent 35%, rgba(255,255,255,.75) 50%, transparent 65%); background-size: 220% 100%; background-repeat: no-repeat; animation: xp-pop .5s ease-out, mo-shine 1.4s .4s ease-in-out 2; }
html[data-motion="full"] .xp-pb, html[data-motion="full"] .ar-duel.is-won, html[data-motion="full"] .ar-last { animation: mo-rise .5s var(--mo-spring) both; }
html[data-motion="full"] .ar-ladder li.is-current { animation: mo-glow 2.4s ease-in-out 3; }
html[data-motion="full"] .lb-col { animation: mo-rise .55s var(--mo-spring) both; }
html[data-motion="full"] .lb-col:nth-child(2) { animation-delay: .08s; }
html[data-motion="full"] .lb-col:nth-child(3) { animation-delay: .16s; }
@media (hover: hover) {
  html[data-motion="full"] .ar-chip:hover, html[data-motion="full"] .ar-shop > li:hover,
  html[data-motion="full"] .pf-badge:hover, html[data-motion="full"] .ar-duel:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(15, 23, 42, .08); }
  html[data-motion="full"] .ar-shop > li, html[data-motion="full"] .pf-badge, html[data-motion="full"] .ar-duel { transition: transform .18s var(--mo-out), box-shadow .18s; }
  html[data-motion="full"] .ar-shop > li:hover .ar-shop-ic, html[data-motion="full"] .pf-badge:hover .pf-badge-ic,
  html[data-motion="full"] .ar-league-head:hover .ar-league-ic { display: inline-block; animation: mo-wiggle .5s ease-in-out; }
  html[data-motion="full"] .btn:hover:not(:disabled) { box-shadow: 0 4px 12px rgba(37, 99, 235, .16); }
}
.mo-ripple-wrap { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; }
.mo-ripple { position: absolute; width: var(--mo-size); height: var(--mo-size); left: var(--mo-x); top: var(--mo-y); border-radius: 50%; background: currentColor; animation: mo-ripple .55s ease-out forwards; }
.mo-burst { position: fixed; z-index: 2147483000; pointer-events: none; font-size: 22px; line-height: 1; animation: mo-burst .9s var(--mo-out, ease-out) forwards; }
.mo-confetti { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: 2147483000; pointer-events: none; }
html[data-motion="off"] .mo-in, html[data-motion="off"] .mo-wait, html[data-motion="lite"] .mo-in, html[data-motion="lite"] .mo-wait { animation: none !important; opacity: 1 !important; }
@media print { .mo-wait { opacity: 1 !important; } .mo-in { animation: none !important; } .mo-confetti, .mo-burst { display: none !important; } }
`;

function ensureMotionStyles(doc = globalThis.document) {
  if (!doc?.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/* ------------------------------------------------------------------ Ripples */

function onPointerDown(e) {
  if (state.level !== 'full' || state.ripples >= MAX_RIPPLES || e.button > 0) return;
  const target = e.target?.closest?.(RIPPLE_SELECTOR);
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
  if (state.isQuiet()) return;
  const rect = target.getBoundingClientRect();
  if (!rect.width || rect.width > 600) return;
  const cs = getComputedStyle(target);
  const madeRelative = cs.position === 'static';
  if (madeRelative) target.style.position = 'relative';
  const wrap = document.createElement('span');
  wrap.className = 'mo-ripple-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('span');
  dot.className = 'mo-ripple';
  dot.style.setProperty('--mo-x', `${e.clientX - rect.left}px`);
  dot.style.setProperty('--mo-y', `${e.clientY - rect.top}px`);
  dot.style.setProperty('--mo-size', `${Math.ceil(Math.hypot(rect.width, rect.height) * 2)}px`);
  wrap.appendChild(dot);
  target.appendChild(wrap);
  state.ripples += 1;
  const done = () => {
    state.ripples = Math.max(0, state.ripples - 1);
    wrap.remove();
    if (madeRelative && !target.querySelector('.mo-ripple-wrap')) target.style.position = '';
  };
  dot.addEventListener('animationend', done, { once: true });
  setTimeout(() => wrap.isConnected && done(), 900);
}

/* ------------------------------------------------------------------ Reveal + count-up */

function animateCount(el) {
  if (el.dataset.moCounted || el.childElementCount > 0 || !el.offsetParent) return;
  const parts = parseCountText(el.textContent);
  if (!parts) return;
  el.dataset.moCounted = '1';
  const finalText = el.textContent;
  const duration = Math.min(1100, 450 + Math.log10(parts.value) * 140);
  const start = performance.now();
  const step = (t) => {
    if (state.level !== 'full' || !el.isConnected) {
      el.textContent = finalText;
      return;
    }
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = p >= 1 ? finalText : `${parts.prefix}${formatCount(parts.value * eased, parts.grouped)}${parts.suffix}`;
    if (p < 1) requestAnimationFrame(step);
    else {
      el.classList.add('mo-pop');
      el.addEventListener('animationend', () => el.classList.remove('mo-pop'), { once: true });
    }
  };
  requestAnimationFrame(step);
}

/** Animates count-ups inside `root` now (full level only). */
export function countUpWithin(root) {
  if (state.level !== 'full' || !root?.querySelectorAll) return;
  const list = root.matches?.(COUNT_SELECTOR) ? [root] : [...root.querySelectorAll(COUNT_SELECTOR)];
  list.slice(0, 12).forEach(animateCount);
}

function markIn(el, index) {
  el.classList.remove('mo-wait');
  el.style.setProperty('--mo-delay', `${Math.min(index, 8) * 45}ms`);
  el.classList.add('mo-in');
  el.addEventListener('animationend', () => {
    el.classList.remove('mo-in');
    el.style.removeProperty('--mo-delay');
  }, { once: true });
}

function ensureIo() {
  if (state.io || typeof IntersectionObserver === 'undefined') return state.io;
  state.io = new IntersectionObserver((entries) => {
    let i = 0;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      state.io.unobserve(entry.target);
      markIn(entry.target, i++);
      countUpWithin(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  return state.io;
}

function processNodes(nodes) {
  if (state.level !== 'full' || state.isQuiet()) return;
  const inIntro = performance.now() - state.startedAt < INTRO_WINDOW_MS;
  const vh = globalThis.innerHeight || 800;
  let staggered = 0;
  let budget = 60;
  for (const node of nodes) {
    if (!node.isConnected || budget <= 0) continue;
    const els = node.matches?.(REVEAL_SELECTOR) ? [node] : [];
    if (node.querySelectorAll) els.push(...node.querySelectorAll(REVEAL_SELECTOR));
    for (const el of els) {
      if (budget-- <= 0) break;
      if (el.dataset.moSeen) continue;
      el.dataset.moSeen = '1';
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.top > vh) {
        el.classList.add('mo-wait');
        ensureIo()?.observe(el);
      } else if (inIntro) {
        markIn(el, staggered++);
      }
    }
    countUpVisible(node, vh);
  }
}

function countUpVisible(node, vh) {
  if (!node.querySelectorAll) return;
  const list = node.matches?.(COUNT_SELECTOR) ? [node] : [...node.querySelectorAll(COUNT_SELECTOR)];
  for (const el of list.slice(0, 12)) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < vh && r.bottom > 0) animateCount(el);
  }
}

function queueNodes(nodes) {
  for (const n of nodes) if (n.nodeType === 1) state.pending.add(n);
  if (state.flushQueued) return;
  state.flushQueued = true;
  requestAnimationFrame(() => {
    state.flushQueued = false;
    const batch = [...state.pending];
    state.pending.clear();
    processNodes(batch);
  });
}

function startWatchingDom() {
  if (state.mo || typeof MutationObserver === 'undefined' || !globalThis.document) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => state.level === 'full' && startWatchingDom(), { once: true });
    return;
  }
  state.mo = new MutationObserver((records) => {
    const added = [];
    for (const r of records) for (const n of r.addedNodes) added.push(n);
    if (added.length) queueNodes(added);
  });
  state.mo.observe(document.body, { childList: true, subtree: true });
  queueNodes([document.body]);
}

function stopWatchingDom() {
  state.mo?.disconnect();
  state.mo = null;
  state.io?.disconnect();
  state.io = null;
  state.pending.clear();
  globalThis.document?.querySelectorAll?.('.mo-wait').forEach((el) => el.classList.remove('mo-wait'));
}

/* ------------------------------------------------------------------ Celebrations */

const CONFETTI_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#f97316'];
const BURST_EMOJI = { big: ['🎉', '✨', '⭐', '🏆', '🎊', '💫'], pb: ['🎉', '⭐', '✨', '🔥', '💫'], small: ['✨', '⭐', '🎉'] };

function originOf(anchor) {
  const w = globalThis.innerWidth || 800;
  const h = globalThis.innerHeight || 600;
  const r = anchor?.getBoundingClientRect?.();
  if (r && r.width && r.bottom > 0 && r.top < h) return { x: r.left + r.width / 2, y: Math.max(40, r.top + Math.min(r.height, 60) / 2) };
  return { x: w / 2, y: h * 0.28 };
}

function emojiBurst(kind, anchor) {
  const count = burstBudget(state.level, kind);
  if (!count || !document.body) return;
  const { x, y } = originOf(anchor);
  const set = BURST_EMOJI[kind] || BURST_EMOJI.small;
  for (let i = 0; i < count; i += 1) {
    const s = document.createElement('span');
    s.className = 'mo-burst';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = set[i % set.length];
    const angle = (Math.PI * 2 * i) / count - Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const dist = 60 + Math.random() * 50;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.setProperty('--mo-dx', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--mo-dy', `${Math.sin(angle) * dist}px`);
    s.style.setProperty('--mo-rot', `${Math.round((Math.random() - 0.5) * 60)}deg`);
    s.addEventListener('animationend', () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 1400);
    document.body.appendChild(s);
  }
}

function confetti(count, anchor) {
  const { x, y } = originOf(anchor);
  let c = state.confetti;
  if (!c) {
    const canvas = document.createElement('canvas');
    canvas.className = 'mo-confetti';
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 1.5); // caps GPU memory on big screens
    canvas.width = Math.round(globalThis.innerWidth * dpr);
    canvas.height = Math.round(globalThis.innerHeight * dpr);
    ctx.scale(dpr, dpr);
    document.body.appendChild(canvas);
    c = state.confetti = { canvas, ctx, parts: [], last: 0, frames: [], startedAt: performance.now() };
    c.timer = setTimeout(endConfetti, CONFETTI_MAX_MS + 200); // never linger, even if frames stall
    requestAnimationFrame(confettiFrame);
  }
  const room = MAX_PARTICLES - c.parts.length;
  for (let i = 0; i < Math.min(count, room); i += 1) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 5 + Math.random() * 7;
    c.parts.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 5 + Math.random() * 5,
      h: 7 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      life: 0,
      max: 1500 + Math.random() * 800, // ms
    });
  }
}

function confettiFrame(t) {
  const c = state.confetti;
  if (!c) return;
  const dt = c.last ? t - c.last : 16.7;
  if (c.last) c.frames.push(dt);
  c.last = t;
  const k = Math.min(dt, 50) / 16.7; // physics in real time, capped so a stall does not teleport pieces
  // The device is dropping frames while drawing: cut the show short and go lighter.
  if (c.frames.length === 30) {
    const { verdict } = judgeFrames([0, 0, 0, 0, 0, ...c.frames]);
    if (verdict === 'struggling' || verdict === 'slow') {
      c.parts.length = 0;
      stepDown('lite');
    }
  }
  const { ctx, canvas } = c;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const h = globalThis.innerHeight;
  c.parts = c.parts.filter((p) => p.life < p.max && p.y < h + 30);
  if (t - c.startedAt > CONFETTI_MAX_MS) c.parts.length = 0;
  for (const p of c.parts) {
    p.life += dt;
    p.vy += 0.22 * k;
    p.vx *= 0.985 ** k;
    p.x += p.vx * k;
    p.y += p.vy * k;
    p.rot += p.vr * k;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 2)) + 1);
    ctx.restore();
  }
  if (c.parts.length && !document.hidden) requestAnimationFrame(confettiFrame);
  else endConfetti();
}

function endConfetti() {
  const c = state.confetti;
  if (!c) return;
  clearTimeout(c.timer);
  c.canvas.remove();
  state.confetti = null;
}

/**
 * A celebration sized to the device: confetti on 'full', a few emoji on 'lite',
 * nothing on 'off'.
 * @param {'big'|'pb'|'small'} [kind]
 * @param {Element|null} [anchor] element to burst from (defaults to the top of the screen)
 */
export function celebrate(kind = 'small', anchor = null) {
  if (typeof document === 'undefined' || document.hidden || state.level === 'off') return;
  const pieces = confettiBudget(state.level, kind, globalThis.innerWidth || 1024);
  if (pieces > 0) confetti(pieces, anchor);
  else emojiBurst(kind, anchor);
}

/** Celebrates once per key per browser session (e.g. a weekly league promotion). */
export function celebrateOnce(key, kind = 'big', anchor = null) {
  const k = `tt_mo_once_${key}`;
  if (safeGet('sessionStorage', k)) return false;
  safeSet('sessionStorage', k, '1');
  celebrate(kind, anchor);
  return true;
}

/* ------------------------------------------------------------------ Init */

/**
 * Starts motion for the page. Safe to call more than once.
 * @param {{ isQuiet?: () => boolean }} [opts] isQuiet: true while a timed practice stage runs
 */
export function initMotion({ isQuiet } = {}) {
  if (typeof document === 'undefined') return 'off';
  if (typeof isQuiet === 'function') state.isQuiet = isQuiet;
  if (state.inited) return state.level;
  state.inited = true;
  state.startedAt = performance.now();
  state.pref = getMotionPreference();
  ensureMotionStyles(document);
  recompute();

  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  try {
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change', recompute);
  } catch {
    /* old Safari */
  }
  globalThis.navigator?.connection?.addEventListener?.('change', recompute);
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key === MOTION_PREF_KEY) {
      state.pref = getMotionPreference();
      recompute();
    }
  });
  startWatchdog();
  return state.level;
}
