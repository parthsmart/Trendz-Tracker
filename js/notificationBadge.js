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

const CACHE_KEY = 'tt_student_notifications_cache_v1';
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

const PRACTICE_DROPDOWN_PATHS = [
  { href: '/pages/basics.html', label: 'Basics' },
  { href: '/pages/flash.html', label: 'Flash Anzan' },
  { href: '/pages/elements.html', label: 'Elements' },
  { href: '/pages/memoriad.html', label: 'Memoriad' },
];

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
 * Organizes the student navigation bar so that:
 * - Basics, Flash Anzan, Elements, and Memoriad are grouped into a clean "Practice ▾" dropdown.
 * - Round Scores stays outside the dropdown as a top-level link.
 * - Weekly Test is ensured in the top bar.
 */
function setupStudentNavStructure(navZone) {
  if (!navZone || navZone.id === 'admin-nav-zone') return;

  const pathname = window.location.pathname || '';

  // Ensure Weekly Test link exists after Round Scores (or Home) if a page had an older nav list
  if (!navZone.querySelector('a[href="/pages/weekly-test.html"]')) {
    const wtLink = document.createElement('a');
    wtLink.href = '/pages/weekly-test.html';
    wtLink.className = 'nav-link';
    wtLink.textContent = 'Weekly Test';
    if (pathname.endsWith('/weekly-test.html')) {
      wtLink.classList.add('active');
      wtLink.setAttribute('aria-current', 'page');
    }
    const roundScoresLink = navZone.querySelector('a[href="/pages/round-scores.html"]');
    if (roundScoresLink && roundScoresLink.nextSibling) {
      navZone.insertBefore(wtLink, roundScoresLink.nextSibling);
    } else {
      navZone.appendChild(wtLink);
    }
  }

  // Build or wire the "Practice ▾" dropdown (strictly for Basics, Flash Anzan, Elements, Memoriad — NOT Round Scores)
  let practiceDropdown = navZone.querySelector('#nav-practice-dropdown');
  if (!practiceDropdown) {
    // Remove loose top-level links for the 4 online practice modes so we can group them cleanly
    PRACTICE_DROPDOWN_PATHS.forEach(({ href }) => {
      const existing = navZone.querySelector(`:scope > a[href="${href}"]`);
      if (existing) existing.remove();
    });

    practiceDropdown = document.createElement('div');
    practiceDropdown.className = 'nav-dropdown';
    practiceDropdown.id = 'nav-practice-dropdown';

    const isPracticePageActive = PRACTICE_DROPDOWN_PATHS.some(({ href }) =>
      pathname.endsWith(href.replace('/pages', ''))
    );

    const itemsHtml = PRACTICE_DROPDOWN_PATHS.map(({ href, label }) => {
      const isItemActive = pathname.endsWith(href.replace('/pages', ''));
      return `<a href="${href}" class="dropdown-item${isItemActive ? ' active' : ''}" role="menuitem"${isItemActive ? ' aria-current="page"' : ''}>${label}</a>`;
    }).join('');

    practiceDropdown.innerHTML = `
      <button type="button" class="nav-link nav-dropdown-toggle${isPracticePageActive ? ' active' : ''}" id="btn-practice-dropdown" aria-expanded="false" aria-haspopup="true">
        Practice <span style="font-size: 10px; margin-left: 2px;">▾</span>
      </button>
      <div class="nav-dropdown-menu" id="practice-dropdown-menu" role="menu">
        ${itemsHtml}
      </div>
    `;

    const homeLink = navZone.querySelector('a[href="/pages/student.html"]');
    const roundScoresLink = navZone.querySelector('a[href="/pages/round-scores.html"]');

    // Ensure Round Scores sits right after Home
    if (homeLink && roundScoresLink && homeLink.nextElementSibling !== roundScoresLink) {
      if (homeLink.nextSibling) {
        navZone.insertBefore(roundScoresLink, homeLink.nextSibling);
      } else {
        navZone.appendChild(roundScoresLink);
      }
    }

    // Place Practice dropdown right after Round Scores (or after Home if Round Scores is not present)
    const anchorAfter = roundScoresLink || homeLink;
    if (anchorAfter && anchorAfter.nextSibling) {
      navZone.insertBefore(practiceDropdown, anchorAfter.nextSibling);
    } else if (anchorAfter) {
      navZone.appendChild(practiceDropdown);
    } else {
      navZone.insertBefore(practiceDropdown, navZone.firstChild);
    }
  } else {
    // Even if Practice dropdown already exists in static HTML, ensure Round Scores comes before it
    const roundScoresLink = navZone.querySelector('a[href="/pages/round-scores.html"]');
    if (roundScoresLink && practiceDropdown.nextElementSibling === roundScoresLink) {
      navZone.insertBefore(roundScoresLink, practiceDropdown);
    }
  }

  // Wire dropdown interactive toggle (idempotent)
  const toggleBtn = practiceDropdown.querySelector('#btn-practice-dropdown');
  const menuEl = practiceDropdown.querySelector('#practice-dropdown-menu');
  if (toggleBtn && menuEl && !practiceDropdown.dataset.wired) {
    practiceDropdown.dataset.wired = 'true';

    // Highlight parent toggle if any child is active
    if (practiceDropdown.querySelector('.dropdown-item.active')) {
      toggleBtn.classList.add('active');
      practiceDropdown.classList.add('active');
    }

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = practiceDropdown.classList.toggle('open');
      menuEl.classList.toggle('open', isOpen);
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    document.addEventListener('click', (e) => {
      if (!practiceDropdown.contains(e.target)) {
        practiceDropdown.classList.remove('open');
        menuEl.classList.remove('open');
        toggleBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        practiceDropdown.classList.remove('open');
        menuEl.classList.remove('open');
        toggleBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

/**
 * Ensures the student navigation has the clean Practice dropdown, Notifications bell link, and badge,
 * then loads the count (using the 60s sessionStorage cache).
 *
 * @param {{ id?: string, role?: string } | null} profile
 */
export async function initStudentNotificationBell(profile) {
  if (!profile || profile.role !== 'student') return;

  const navZone = document.querySelector('.nav-zone');
  if (navZone && navZone.id !== 'admin-nav-zone') {
    setupStudentNavStructure(navZone);

    let notifLink = document.querySelector('a[href="/pages/notifications.html"]');
    if (!notifLink) {
      notifLink = document.createElement('a');
      notifLink.href = '/pages/notifications.html';
      notifLink.className = 'nav-link nav-bell-link';
      notifLink.title = 'Notifications';
      notifLink.setAttribute('aria-label', 'Notifications');
      if (window.location.pathname.endsWith('/notifications.html')) {
        notifLink.classList.add('active');
        notifLink.setAttribute('aria-current', 'page');
      }
      notifLink.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span class="nav-bell-text">Alerts</span>
        <span id="nav-notifications-badge" class="nav-notifications-badge num" style="display: none; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #DC2626; color: #FFFFFF; font-size: 11px; font-weight: 700; line-height: 1;" aria-hidden="true"></span>
      `;
      navZone.appendChild(notifLink);
    } else {
      notifLink.classList.add('nav-bell-link');
      if (!notifLink.querySelector('.nav-notifications-badge, #nav-notifications-badge')) {
        const badgeSpan = document.createElement('span');
        badgeSpan.id = 'nav-notifications-badge';
        badgeSpan.className = 'nav-notifications-badge num';
        badgeSpan.style.cssText =
          'display: none; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #DC2626; color: #FFFFFF; font-size: 11px; font-weight: 700; line-height: 1;';
        badgeSpan.setAttribute('aria-hidden', 'true');
        notifLink.appendChild(badgeSpan);
      }
    }
  }

  try {
    await fetchMyNotificationsCached({ studentId: profile.id, forceRefresh: false });
  } catch (err) {
    console.warn('Could not load notification badge count:', err);
  }
}
