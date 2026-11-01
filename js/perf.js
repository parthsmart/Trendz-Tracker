/**
 * Trendz Tracker - Opt-In Performance Timing & Link Prefetch Helper (js/perf.js)
 *
 * Phase 15a (Candidates G & I):
 * - Candidate I: When `?perf=1` is in the URL or `localStorage.tt_perf === '1'`, records
 *   `tt:guard-start`, `tt:guard-ready`, and `tt:page-ready` marks and logs TTFB, FCP,
 *   Guard Ready, and Page Ready in a console table. Zero overhead for normal users.
 * - Candidate G: Prefetches same-origin HTML navigation targets on hover (`pointerenter`)
 *   or touch (`touchstart`) with throttling and Data-Saver respect.
 */

const PREFETCHED_URLS = new Set();
let lastPrefetchAt = 0;
const PREFETCH_THROTTLE_MS = 120;

/**
 * Checks whether opt-in performance logging is enabled (`?perf=1` or `localStorage.tt_perf === '1'`).
 *
 * @returns {boolean}
 */
export function isPerfLoggingEnabled() {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('perf') === '1') return true;
    return window.localStorage?.getItem('tt_perf') === '1';
  } catch {
    return false;
  }
}

/**
 * Records a performance mark when `?perf=1` is active.
 *
 * @param {string} name
 */
export function markPerf(name) {
  if (!isPerfLoggingEnabled()) return;
  try {
    performance.mark(name);
  } catch {
    // Ignore unsupported performance API errors
  }
}

/**
 * Marks `tt:page-ready` and prints a summary console table of TTFB, FCP, Guard Ready, and Page Ready
 * when `?perf=1` is enabled.
 *
 * @param {string} [pageLabel]
 */
export function reportPagePerf(pageLabel = '') {
  if (!isPerfLoggingEnabled()) return;
  try {
    performance.mark('tt:page-ready');
    const navEntry = performance.getEntriesByType?.('navigation')?.[0];
    const paintEntries = performance.getEntriesByType?.('paint') || [];
    const fcpEntry = paintEntries.find((p) => p.name === 'first-contentful-paint');
    const guardMarks = performance.getEntriesByName?.('tt:guard-ready') || [];
    const pageMarks = performance.getEntriesByName?.('tt:page-ready') || [];

    const ttfbMs = navEntry ? Math.round(navEntry.responseStart) : null;
    const fcpMs = fcpEntry ? Math.round(fcpEntry.startTime) : null;
    const guardReadyMs =
      guardMarks.length > 0 ? Math.round(guardMarks[guardMarks.length - 1].startTime) : null;
    const pageReadyMs =
      pageMarks.length > 0 ? Math.round(pageMarks[pageMarks.length - 1].startTime) : null;

    // eslint-disable-next-line no-console
    console.table({
      Page: pageLabel || (typeof window !== 'undefined' ? window.location.pathname : ''),
      'TTFB (ms)': ttfbMs,
      'FCP (ms)': fcpMs,
      'Guard Ready (ms)': guardReadyMs,
      'Page Ready (ms)': pageReadyMs,
    });
  } catch {
    // Ignore console/performance errors
  }
}

/**
 * Pure helper to determine if an anchor href should be prefetched.
 *
 * @param {string} rawHref
 * @param {string} currentPathname
 * @param {{ saveData?: boolean, effectiveType?: string } | null} [connection]
 * @returns {boolean}
 */
export function shouldPrefetchHref(rawHref, currentPathname = '', connection = null) {
  if (!rawHref || typeof rawHref !== 'string') return false;
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('javascript:')) return false;

  if (connection) {
    if (connection.saveData) return false;
    const eff = String(connection.effectiveType || '').toLowerCase();
    if (eff === 'slow-2g' || eff === '2g') return false;
  }

  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/api/')) {
    return false;
  }

  const pathOnly = trimmed.split('?')[0].split('#')[0];
  if (!pathOnly.endsWith('.html') && pathOnly !== '/') {
    return false;
  }

  if (currentPathname && pathOnly === currentPathname) {
    return false;
  }

  return true;
}

/**
 * Prefetches a same-origin HTML page at most once per session.
 *
 * @param {string} href
 */
export function triggerDocumentPrefetch(href) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const currentPathname = window.location.pathname || '';
  const conn = navigator?.connection || null;

  if (!shouldPrefetchHref(href, currentPathname, conn)) return;

  const normalized = href.split('#')[0];
  if (PREFETCHED_URLS.has(normalized)) return;

  const now = Date.now();
  if (now - lastPrefetchAt < PREFETCH_THROTTLE_MS) return;
  lastPrefetchAt = now;
  PREFETCHED_URLS.add(normalized);

  try {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'document';
    link.href = normalized;
    document.head.appendChild(link);
  } catch {
    // Ignore DOM errors
  }
}

/**
 * Attaches delegated hover (`pointerenter`) and touch (`touchstart`) prefetch listeners
 * to a navigation container (such as `.app-header`).
 *
 * @param {Element | null} rootEl
 */
export function attachLinkPrefetchListeners(rootEl) {
  if (!rootEl || rootEl.dataset?.prefetchWired === 'true') return;
  rootEl.dataset.prefetchWired = 'true';

  const handleTrigger = (e) => {
    const target = e?.target;
    if (!target || typeof target.closest !== 'function') return;
    const anchor = target.closest('a[href]');
    if (!anchor) return;
    if (anchor.hasAttribute('data-nav-action')) return;
    const href = anchor.getAttribute('href');
    if (href) {
      triggerDocumentPrefetch(href);
    }
  };

  rootEl.addEventListener('pointerenter', handleTrigger, { capture: true, passive: true });
  rootEl.addEventListener('touchstart', handleTrigger, { capture: true, passive: true });
}
