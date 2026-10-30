/**
 * Trendz Tracker - Student Notification Bell & 60s SessionStorage Cache (js/notificationBadge.js)
 *
 * Phase 13b:
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

/**
 * Clears the cached notification list in `sessionStorage`.
 */
export function clearNotificationsCache() {
  try {
    window.sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Fetches `my_notifications()` from Supabase (or DemoDB in Demo Mode), respecting the 60s `sessionStorage` cache
 * unless `forceRefresh` is true.
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
  }

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
}

/**
 * Updates the count badge element(s) in the navigation bar.
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
}

/**
 * Ensures the student navigation has the Notifications bell link and badge,
 * then loads the count (using the 60s sessionStorage cache).
 *
 * @param {{ id?: string, role?: string } | null} profile
 */
export async function initStudentNotificationBell(profile) {
  if (!profile || profile.role !== 'student') return;

  const navZone = document.querySelector('.nav-zone');
  if (navZone && navZone.id !== 'admin-nav-zone') {
    let notifLink = navZone.querySelector('a[href="/pages/notifications.html"]');
    if (!notifLink) {
      notifLink = document.createElement('a');
      notifLink.href = '/pages/notifications.html';
      notifLink.className = 'nav-link';
      if (window.location.pathname.endsWith('/notifications.html')) {
        notifLink.classList.add('active');
        notifLink.setAttribute('aria-current', 'page');
      }
      notifLink.style.display = 'inline-flex';
      notifLink.style.alignItems = 'center';
      notifLink.style.gap = '5px';
      notifLink.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span>Notifications</span>
        <span id="nav-notifications-badge" class="nav-notifications-badge num" style="display: none; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #DC2626; color: #FFFFFF; font-size: 11px; font-weight: 700; line-height: 1;" aria-hidden="true"></span>
      `;
      navZone.appendChild(notifLink);
    } else if (!notifLink.querySelector('.nav-notifications-badge, #nav-notifications-badge')) {
      const badgeSpan = document.createElement('span');
      badgeSpan.id = 'nav-notifications-badge';
      badgeSpan.className = 'nav-notifications-badge num';
      badgeSpan.style.cssText =
        'display: none; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #DC2626; color: #FFFFFF; font-size: 11px; font-weight: 700; line-height: 1;';
      badgeSpan.setAttribute('aria-hidden', 'true');
      notifLink.appendChild(badgeSpan);
    }
  }

  try {
    await fetchMyNotificationsCached({ studentId: profile.id, forceRefresh: false });
  } catch (err) {
    console.warn('Could not load notification badge count:', err);
  }
}
