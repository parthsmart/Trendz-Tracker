/**
 * Trendz Tracker - Student Notifications Page Controller (js/notifications.js)
 *
 * Phase 13b:
 * - Protected by `requireAuth(['student', 'admin'])`.
 * - Loads notifications via `fetchMyNotificationsCached` (using 60s `sessionStorage` cache,
 *   or forcing refresh when clicking the Refresh button).
 * - Groups items via `groupNotifications(items)` into "Weekly tests" and "Announcements".
 * - Each item displays:
 *   - Title & body (plain text, escaped)
 *   - Date chip (e.g. "Sun 2 Nov")
 *   - Stage chip with TEXT ("In 4 days", "Tomorrow", "Today")
 *   - "Open" button linking to `item.link`
 *   - "Dismiss" button (`dismiss_notification(p_ref)`) with a 5-second undo toast
 * - Refreshes the 60s `sessionStorage` cache after dismissing.
 * - Shows friendly empty state "You are all caught up" when both groups are empty.
 */

import { requireAuth } from './guard.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { setupAdminNav } from './modal.js';
import { showToast, showActionToast } from './toast.js';
import {
  stageLabel,
  groupNotifications,
  formatEventDateChipIST,
  sanitizeNotificationLink,
} from './notificationsView.js';
import {
  fetchMyNotificationsCached,
  writeNotificationsCache,
} from './notificationBadge.js';

let currentProfile = null;
let allItems = [];
// Map of ref -> { item, timerId } for notifications currently in the 5-second Undo window
const pendingDismissals = new Map();

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function initNotificationsPage() {
  currentProfile = await requireAuth(['student', 'admin']);
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupAdminNav();

  const refreshBtn = document.getElementById('btn-refresh-notifications');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      flushAllPendingDismissals();
      loadNotifications({ forceRefresh: true });
    });
  }

  // Ensure any pending dismissals are committed if the user navigates away before 5s
  window.addEventListener('pagehide', () => {
    flushAllPendingDismissals();
  });

  await loadNotifications({ forceRefresh: false });
}

function showErrorBanner(msg) {
  const banner = document.getElementById('notifications-error-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
    return;
  }
  banner.textContent = msg;
  banner.style.display = 'block';
}

async function loadNotifications({ forceRefresh = false } = {}) {
  const loadingEl = document.getElementById('notifications-loading-state');
  const emptyEl = document.getElementById('notifications-empty-state');
  const groupsWrapper = document.getElementById('notifications-groups-wrapper');
  const refreshBtn = document.getElementById('btn-refresh-notifications');

  showErrorBanner('');
  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (groupsWrapper) groupsWrapper.style.display = 'none';
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const fetched = await fetchMyNotificationsCached({
      studentId: currentProfile?.id,
      forceRefresh,
    });
    // Exclude any items currently waiting in the 5-second undo window
    allItems = (Array.isArray(fetched) ? fetched : []).filter(
      (item) => item && item.ref && !pendingDismissals.has(item.ref)
    );
    renderNotifications();
  } catch (err) {
    console.error('Failed to load notifications:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    showErrorBanner(
      err?.message || 'Could not load notifications right now. Please try refreshing.'
    );
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function renderNotifications() {
  const loadingEl = document.getElementById('notifications-loading-state');
  const emptyEl = document.getElementById('notifications-empty-state');
  const groupsWrapper = document.getElementById('notifications-groups-wrapper');

  if (loadingEl) loadingEl.style.display = 'none';

  const { tests, announcements } = groupNotifications(allItems);

  if (tests.length === 0 && announcements.length === 0) {
    if (groupsWrapper) groupsWrapper.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (groupsWrapper) groupsWrapper.style.display = 'flex';

  // 1. Weekly tests group
  const testsCountEl = document.getElementById('group-weekly-tests-count');
  const testsListEl = document.getElementById('group-weekly-tests-list');
  if (testsCountEl) testsCountEl.textContent = String(tests.length);
  if (testsListEl) {
    if (tests.length === 0) {
      testsListEl.innerHTML = `
        <div style="font-size: var(--text-sm); color: var(--text-muted); padding: var(--space-2) 0;">
          No weekly test reminders right now.
        </div>
      `;
    } else {
      testsListEl.innerHTML = tests.map((item) => renderNotificationCardHtml(item)).join('');
    }
  }

  // 2. Announcements group
  const annCountEl = document.getElementById('group-announcements-count');
  const annListEl = document.getElementById('group-announcements-list');
  if (annCountEl) annCountEl.textContent = String(announcements.length);
  if (annListEl) {
    if (announcements.length === 0) {
      annListEl.innerHTML = `
        <div style="font-size: var(--text-sm); color: var(--text-muted); padding: var(--space-2) 0;">
          No announcements right now.
        </div>
      `;
    } else {
      annListEl.innerHTML = announcements.map((item) => renderNotificationCardHtml(item)).join('');
    }
  }

  // Bind Dismiss button handlers
  document.querySelectorAll('.btn-dismiss-notification').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ref = btn.getAttribute('data-ref');
      if (ref) handleDismissWithUndo(ref);
    });
  });
}

function renderNotificationCardHtml(item) {
  const ref = String(item.ref || '');
  const title = escapeHtml(item.title || 'Notification');
  const body = escapeHtml(item.body || '');
  const dateChip = formatEventDateChipIST(item.event_date || item.created_at);
  const stageText = stageLabel(item.days_left);
  const safeLink = sanitizeNotificationLink(
    item.link,
    item.kind === 'announcement' ? '/pages/student.html' : '/pages/weekly-test.html'
  );

  // Semantic stage styling
  let stageStyle = 'background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE;';
  if (stageText === 'Today') {
    stageStyle = 'background: #FEF2F2; color: #B91C1C; border: 1px solid #FECACA;';
  } else if (stageText === 'Tomorrow') {
    stageStyle = 'background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A;';
  }

  return `
    <article
      class="notification-item"
      data-ref="${escapeHtml(ref)}"
      style="padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface); display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-4); flex-wrap: wrap;"
    >
      <div style="flex: 1 1 320px; min-width: 0;">
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: 6px;">
          <h3 style="font-size: var(--text-base); font-weight: 700; margin: 0; color: var(--text-main);">
            ${title}
          </h3>
          ${
            dateChip
              ? `<span class="num" style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: var(--bg-surface-subtle); color: var(--text-muted); border: 1px solid var(--border-hairline);">${escapeHtml(dateChip)}</span>`
              : ''
          }
          ${
            stageText
              ? `<span class="num" style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; ${stageStyle}">${escapeHtml(stageText)}</span>`
              : ''
          }
        </div>
        ${
          body
            ? `<p style="font-size: var(--text-sm); color: var(--text-muted); margin: 0; line-height: 1.5; white-space: pre-line;">${body}</p>`
            : ''
        }
      </div>

      <div style="display: inline-flex; align-items: center; gap: var(--space-2); flex-shrink: 0;">
        <a href="${escapeHtml(safeLink)}" class="btn btn-primary btn-sm" style="text-decoration: none;">
          Open
        </a>
        <button
          type="button"
          class="btn btn-outline btn-sm btn-dismiss-notification"
          data-ref="${escapeHtml(ref)}"
        >
          Dismiss
        </button>
      </div>
    </article>
  `;
}

/**
 * Optimistically removes a notification and shows a 5-second Undo toast before committing
 * `dismiss_notification(p_ref)` to the database and refreshing the sessionStorage cache.
 *
 * @param {string} ref
 */
function handleDismissWithUndo(ref) {
  const idx = allItems.findIndex((item) => item && String(item.ref) === String(ref));
  if (idx === -1) return;

  const removedItem = allItems[idx];
  allItems.splice(idx, 1);

  // Immediately update the 60s sessionStorage cache and nav bell badge
  writeNotificationsCache(currentProfile?.id, allItems);
  renderNotifications();

  const timerId = setTimeout(() => {
    pendingDismissals.delete(ref);
    commitDismissNotification(ref);
  }, 5000);

  pendingDismissals.set(ref, {
    item: removedItem,
    index: idx,
    timerId,
  });

  showActionToast(
    'info',
    `Dismissed "${removedItem.title || 'notification'}"`,
    'Undo',
    () => {
      const pending = pendingDismissals.get(ref);
      if (!pending) return;
      clearTimeout(pending.timerId);
      pendingDismissals.delete(ref);

      const insertAt = Math.min(pending.index, allItems.length);
      allItems.splice(insertAt, 0, pending.item);
      writeNotificationsCache(currentProfile?.id, allItems);
      renderNotifications();
      showToast('info', 'Notification restored.', 2500);
    },
    5000
  );
}

/**
 * Commits `dismiss_notification(p_ref)` to Supabase (or DemoDB) and refreshes the 60s cache.
 *
 * @param {string} ref
 */
async function commitDismissNotification(ref) {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { error } = await supabase.rpc('dismiss_notification', { p_ref: ref });
      if (error) throw error;
    } else if (isDemoMode() && DemoDB && typeof DemoDB.mockDismissNotification === 'function') {
      DemoDB.mockDismissNotification(currentProfile?.id, ref);
    }

    // Refresh the 60s sessionStorage cache after dismissing
    const refreshed = await fetchMyNotificationsCached({
      studentId: currentProfile?.id,
      forceRefresh: true,
    });
    allItems = (Array.isArray(refreshed) ? refreshed : []).filter(
      (item) => item && item.ref && !pendingDismissals.has(item.ref)
    );
    renderNotifications();
  } catch (err) {
    console.error('Failed to dismiss notification:', err);
    showToast('error', err?.message || 'Could not dismiss notification.');
    await loadNotifications({ forceRefresh: true });
  }
}

function flushAllPendingDismissals() {
  for (const [ref, pending] of pendingDismissals.entries()) {
    clearTimeout(pending.timerId);
    pendingDismissals.delete(ref);
    commitDismissNotification(ref);
  }
}

document.addEventListener('DOMContentLoaded', initNotificationsPage);
