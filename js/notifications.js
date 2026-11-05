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
import { markStudentMessageRead } from './studentMessages.js';
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

  if (currentProfile?.role === 'admin') {
    setupAdminNav(currentProfile);
  }

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

  const { tests, announcements, messages = [] } = groupNotifications(allItems);

  if (tests.length === 0 && announcements.length === 0 && messages.length === 0) {
    if (groupsWrapper) groupsWrapper.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (groupsWrapper) groupsWrapper.style.display = 'flex';

  // 0. Trainer notes group
  const msgCountEl = document.getElementById('group-messages-count');
  const msgListEl = document.getElementById('group-messages-list');
  const msgCard = document.getElementById('group-messages-card');
  if (msgCountEl) msgCountEl.textContent = String(messages.length);
  if (msgCard) {
    msgCard.style.display = messages.length > 0 ? 'block' : 'none';
  }
  if (msgListEl && messages.length > 0) {
    msgListEl.innerHTML = messages.map((item) => renderNotificationCardHtml(item)).join('');
  }

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

  // Bind Open button handlers (marks message as read)
  document.querySelectorAll('.btn-open-notification').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msgId = btn.getAttribute('data-msg-id');
      if (msgId) {
        handleMarkMessageRead(msgId);
      }
    });
  });

  // Bind Dismiss button handlers
  document.querySelectorAll('.btn-dismiss-notification').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ref = btn.getAttribute('data-ref');
      if (ref) handleDismissWithUndo(ref);
    });
  });
}

/**
 * Marks a student message as read, updates the local item, refreshes sessionStorage cache,
 * syncs the nav bell badge DOM, and removes the visible Unread indicator.
 *
 * @param {string} msgId
 */
export async function handleMarkMessageRead(msgId) {
  if (!msgId) return;
  try {
    const success = await markStudentMessageRead(msgId);
    if (success) {
      // 1. Update in-memory item
      const item = allItems.find(
        (i) => i && (i.id === msgId || (i.ref && i.ref === `msg:${msgId}`))
      );
      if (item) {
        item.read_at = new Date().toISOString();
      }

      // 2. Update 60s sessionStorage cache and badge DOM
      writeNotificationsCache(currentProfile?.id, allItems);

      // 3. Update visible unread indicator in DOM
      const card = document.querySelector(`article[data-ref="msg:${msgId}"]`);
      if (card) {
        const unreadBadge = card.querySelector('.badge-unread');
        if (unreadBadge) {
          unreadBadge.remove();
        }
      }
    }
  } catch (err) {
    console.warn('Could not mark message as read:', err);
  }
}

function renderNotificationCardHtml(item) {
  const ref = String(item.ref || '');
  const title = escapeHtml(item.title || 'Notification');
  const body = escapeHtml(item.body || '');
  const dateChip = formatEventDateChipIST(item.event_date || item.created_at);
  const stageText = stageLabel(item.days_left);
  const isMessage = item.kind === 'private_message';
  const needsAttention = Boolean(item.needs_attention);
  const isUnread = isMessage && !item.read_at;
  const msgId = item.id || (ref.startsWith('msg:') ? ref.slice(4) : '');

  const defaultLink = isMessage
    ? (item.link || '/pages/student.html')
    : (item.kind === 'announcement' ? '/pages/student.html' : '/pages/weekly-test.html');
  const safeLink = sanitizeNotificationLink(item.link, defaultLink);

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
            needsAttention
              ? `<span class="badge" style="background: #FEF2F2; color: #B91C1C; border: 1px solid #FECACA; font-weight: 700;">⚠️ Needs attention</span>`
              : ''
          }
          ${
            isUnread
              ? `<span class="badge badge-unread" style="background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; font-weight: 700;">Unread</span>`
              : ''
          }
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
        ${
          item.attention_reason
            ? `<div style="font-size: 11px; color: #B91C1C; margin-top: 6px; font-weight: 600;">⚠️ Teacher note: ${escapeHtml(item.attention_reason)}</div>`
            : ''
        }
      </div>

      <div style="display: inline-flex; align-items: center; gap: var(--space-2); flex-shrink: 0;">
        <a href="${escapeHtml(safeLink)}" class="btn btn-primary btn-sm btn-open-notification" data-msg-id="${escapeHtml(msgId)}" style="text-decoration: none;">
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
      if (ref.startsWith('msg:')) {
        const msgId = ref.slice(4);
        const { error } = await supabase
          .from('student_messages')
          .update({ dismissed_at: new Date().toISOString() })
          .eq('id', msgId);
        if (error) {
          await supabase.rpc('dismiss_notification', { p_ref: ref });
        }
      } else {
        const { error } = await supabase.rpc('dismiss_notification', { p_ref: ref });
        if (error) throw error;
      }
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
