/**
 * Trendz Tracker - Student Notification Bell, 60s SessionStorage Cache & Clean Student Nav (js/notificationBadge.js)
 *
 * Phase 13b + UI Declutter Pass:
 * - Groups the 4 online website practice modes (Basics, Flash Anzan, Elements, Memoriad)
 *   into a clean "Practice ▾" dropdown in the student navigation bar while keeping
 *   "Round Scores" as a separate top-level link.
 * - Renders / updates the bell icon with a count badge in the student navigation
 *   (hides the badge at 0; shows "9+" above 9 via `badgeText(count)`).
 * - Fetches `my_notifications()` and caches the result in `sessionStorage` for 60 seconds
 *   to avoid repeated calls across page navigations.
 * - Refreshes the cache immediately after dismissing a notification.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { badgeText } from './notificationsView.js';
import { syncHeaderMenuNotificationBadge, setupHeaderNavigation } from './headerNav.js';

const CACHE_KEY = 'tt_student_notifications_cache_v1';
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Reads cached notifications from `sessionStorage` if within the 60-second TTL.
 *
 * @param {string|null|undefined} studentId
 * @returns {Array<Record<string, any>> | null}
 */
export function readNotificationsCache(studentId) {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (studentId && parsed.studentId && String(parsed.studentId) !== String(studentId)) {
      return null;
    }
    const ageMs = Date.now() - Number(parsed.ts || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CACHE_TTL_MS) {
      return null;
    }
    return Array.isArray(parsed.items) ? parsed.items : null;
  } catch {
    return null;
  }
}

/**
 * Writes the current notification list and count to `sessionStorage` and updates any bell badge in the DOM.
 *
 * @param {string|null|undefined} studentId
 * @param {Array<Record<string, any>>} items
 */
export function writeNotificationsCache(studentId, items) {
  const safeItems = Array.isArray(items) ? items : [];
  try {
    window.sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        studentId: studentId || null,
        ts: Date.now(),
        count: safeItems.length,
        items: safeItems,
      })
    );
  } catch {
    // Ignore sessionStorage quota / privacy errors
  }
  updateBellBadgeDOM(safeItems.length);
}

let inFlightNotificationsPromise = null;

/**
 * Clears the cached notification list in `sessionStorage`.
 */
export function clearNotificationsCache() {
  inFlightNotificationsPromise = null;
  try {
    window.sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Fetches `my_notifications()` from Supabase (or DemoDB in Demo Mode), respecting the 60s `sessionStorage` cache
 * and deduplicating concurrent in-flight calls unless `forceRefresh` is true.
 *
 * @param {{ studentId?: string|null, forceRefresh?: boolean }} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function fetchMyNotificationsCached({ studentId = null, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = readNotificationsCache(studentId);
    if (cached !== null) {
      updateBellBadgeDOM(cached.length);
      return cached;
    }
    if (inFlightNotificationsPromise) {
      return inFlightNotificationsPromise;
    }
  }

  inFlightNotificationsPromise = (async () => {
    try {
      let items = [];
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const { data, error } = await supabase.rpc('my_notifications');
        if (error) throw error;
        items = Array.isArray(data) ? data : [];
      } else if (isDemoMode() && DemoDB && typeof DemoDB.mockMyNotifications === 'function') {
        items = DemoDB.mockMyNotifications(studentId);
      }

      writeNotificationsCache(studentId, items);
      return items;
    } finally {
      inFlightNotificationsPromise = null;
    }
  })();

  return inFlightNotificationsPromise;
}

/**
 * Updates the count badge element(s) in the navigation menu and the unread dot on the three-dot menu button.
 * Hides the badge when count is 0; shows "9+" when count > 9.
 *
 * @param {number} count
 */
export function updateBellBadgeDOM(count) {
  const text = badgeText(count);
  const badges = document.querySelectorAll('#nav-notifications-badge, .nav-notifications-badge');
  badges.forEach((badge) => {
    if (!text) {
      badge.textContent = '';
      badge.style.display = 'none';
      badge.setAttribute('aria-hidden', 'true');
    } else {
      badge.textContent = text;
      badge.style.display = 'inline-flex';
      badge.removeAttribute('aria-hidden');
    }
  });
  syncHeaderMenuNotificationBadge(count, text);
}

/**
 * Legacy helper retained for compatibility; delegates to Phase 14d single-source header navigation.
 */
export function setupStudentNavStructure() {
  if (typeof document !== 'undefined' && !document.getElementById('btn-header-nav-menu')) {
    setupHeaderNavigation({ role: 'student' });
  }
}

/**
 * Ensures the student header menu is mounted and updates the unread notification dot and menu badge
 * from the 60s sessionStorage cache without extra requests.
 *
 * @param {{ id?: string, role?: string } | null} profile
 */
export async function initStudentNotificationBell(profile) {
  if (!profile || profile.role !== 'student') return;

  if (typeof document !== 'undefined' && !document.getElementById('btn-header-nav-menu')) {
    setupHeaderNavigation(profile);
  }

  // Immediately apply cached count if available before any async call
  const cached = readNotificationsCache(profile.id);
  if (cached !== null) {
    updateBellBadgeDOM(cached.length);
    return;
  }

  try {
    await fetchMyNotificationsCached({ studentId: profile.id, forceRefresh: false });
  } catch (err) {
    console.warn('Could not load notification badge count:', err);
  }
}
