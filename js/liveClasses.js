/**
 * Trendz Tracker — Staff Live Classes Management (js/liveClasses.js)
 *
 * Handles staff setup flow for Webinar.gg live classes:
 * - List active, scheduled, and past classes
 * - Modal to link an existing Webinar.gg webinar ID, assign teacher, audience & start time
 * - Real-time provider sync button
 * - Quick "Open host room" navigation
 */

import { getSupabase } from './supabaseClient.js';
import { setupHeaderNavigation } from './headerNav.js';

let currentUser = null;
let currentProfile = null;
let currentClasses = [];

/**
 * Formats ISO timestamp to clean IST string
 */
export function formatTimeIST(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d) + ' IST';
  } catch (_) {
    return isoString;
  }
}

/**
 * Returns HTML badge for class status
 */
export function renderStatusBadge(status, providerStatus) {
  switch (status) {
    case 'live':
      return `<span class="badge badge-success" style="font-weight: 700; animation: pulse 2s infinite;"><span style="color: #22c55e;">●</span> Live Now</span>`;
    case 'waiting':
      return `<span class="badge badge-warning" style="font-weight: 600;">Waiting for Teacher</span>`;
    case 'ended':
      return `<span class="badge badge-neutral" style="font-weight: 500;">Ended</span>`;
    case 'cancelled':
      return `<span class="badge badge-danger" style="font-weight: 500;">Cancelled</span>`;
    case 'scheduled':
    default:
      return `<span class="badge badge-info" style="font-weight: 500;">Scheduled</span>`;
  }
}

function showToast(message, kind = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toast.style.cssText = `
    padding: var(--space-3) var(--space-4);
    background: ${kind === 'error' ? '#ef4444' : kind === 'success' ? '#10b981' : '#2563eb'};
    color: white;
    border-radius: var(--radius-md);
    margin-top: var(--space-2);
    box-shadow: var(--shadow-md);
    font-size: var(--text-sm);
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/**
 * Fetches classes list from server API
 */
export async function loadLiveClasses() {
  const loadingEl = document.getElementById('classes-loading');
  const emptyEl = document.getElementById('classes-empty');
  const tableWrapper = document.getElementById('classes-table-wrapper');
  const tbody = document.getElementById('classes-table-body');
  const countBadge = document.getElementById('classes-count-badge');

  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (tableWrapper) tableWrapper.style.display = 'none';

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      window.location.href = '/index.html';
      return;
    }

    const res = await fetch('/api/live-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'list' }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load live classes.');
    }

    currentClasses = data.classes || [];
    if (countBadge) countBadge.textContent = `${currentClasses.length} ${currentClasses.length === 1 ? 'class' : 'classes'}`;

    if (loadingEl) loadingEl.style.display = 'none';

    if (currentClasses.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (tbody) {
      tbody.innerHTML = currentClasses.map((cls) => {
        const teacherName = cls.teacher?.full_name || 'Assigned Teacher';
        const audience = cls.target_student_ids?.length
          ? `${cls.target_student_ids.length} selected students`
          : cls.target_level || 'All Levels';

        return `
          <tr style="border-bottom: 1px solid var(--border-hairline);">
            <td style="padding: var(--space-3) var(--space-4);">
              <strong style="color: var(--text-main);">${cls.title}</strong>
              <div style="font-size: var(--text-xs); color: var(--text-muted); font-family: monospace;">Webinar ID: ${cls.webinar_id}</div>
            </td>
            <td style="padding: var(--space-3) var(--space-4); color: var(--text-main);">
              ${teacherName}
            </td>
            <td style="padding: var(--space-3) var(--space-4);">
              <span class="badge badge-neutral" style="font-size: var(--text-xs);">${audience}</span>
            </td>
            <td style="padding: var(--space-3) var(--space-4); white-space: nowrap;">
              ${formatTimeIST(cls.scheduled_start_time)}
            </td>
            <td style="padding: var(--space-3) var(--space-4);">
              ${renderStatusBadge(cls.status, cls.provider_status)}
            </td>
            <td style="padding: var(--space-3) var(--space-4); text-align: right; white-space: nowrap;">
              <a href="/pages/live-room.html?classId=${cls.id}" class="btn btn-primary btn-sm" style="text-decoration: none; margin-right: 4px;">
                Open host room &rarr;
              </a>
              <button type="button" class="btn btn-outline btn-sm btn-sync-status" data-id="${cls.id}" title="Sync status with Webinar.gg">
                Sync
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    if (tableWrapper) tableWrapper.style.display = 'block';

    // Wire up sync buttons
    document.querySelectorAll('.btn-sync-status').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const classId = e.currentTarget.getAttribute('data-id');
        await syncClassStatus(classId);
      });
    });

  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    showToast(err.message || 'Error loading live classes', 'error');
  }
}

/**
 * Syncs single class status from Webinar.gg provider
 */
async function syncClassStatus(classId) {
  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/live-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'sync_provider_status', classId }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Provider sync failed.');
    }
    showToast(`Status updated: ${data.status} (Provider: ${data.providerStatus || 'n/a'})`, 'success');
    await loadLiveClasses();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * Loads teachers into select dropdown
 */
async function loadTeachersSelect() {
  const select = document.getElementById('select-teacher');
  if (!select) return;

  try {
    const supabase = await getSupabase();
    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name, student_code')
      .eq('role', 'teacher')
      .eq('active', true)
      .order('full_name');

    if (!teachers || teachers.length === 0) {
      select.innerHTML = '<option value="">No active teachers found</option>';
      return;
    }

    select.innerHTML = teachers
      .map((t) => `<option value="${t.id}">${t.full_name} (${t.student_code})</option>`)
      .join('');
  } catch (err) {
    select.innerHTML = '<option value="">Error loading teachers</option>';
  }
}

/**
 * Initializes the page
 */
export async function initLiveClassesPage() {
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    window.location.href = '/index.html';
    return;
  }

  currentUser = session.user;
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, level, active')
    .eq('id', currentUser.id)
    .single();

  if (!profile || (profile.role !== 'admin' && profile.role !== 'teacher') || !profile.active) {
    window.location.href = '/index.html';
    return;
  }
  currentProfile = profile;

  setupHeaderNavigation(profile);

  // Load initial classes
  await loadLiveClasses();
  await loadTeachersSelect();

  // Setup modal wiring
  const modal = document.getElementById('modal-create-class');
  const btnOpen = document.getElementById('btn-open-create-modal');
  const btnClose = document.getElementById('btn-close-modal');
  const btnCancel = document.getElementById('btn-cancel-create');
  const form = document.getElementById('form-create-class');
  const modalError = document.getElementById('modal-error');

  // Pre-set start time to next 30-minute slot in local IST
  const startTimeInput = document.getElementById('input-start-time');
  if (startTimeInput) {
    const now = new Date(Date.now() + 30 * 60 * 1000);
    // Format to YYYY-MM-DDTHH:mm
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    startTimeInput.value = localIso;
  }

  const openModal = () => {
    if (modal) modal.style.display = 'flex';
    if (modalError) modalError.style.display = 'none';
  };

  const closeModal = () => {
    if (modal) modal.style.display = 'none';
    if (form) form.reset();
  };

  if (btnOpen) btnOpen.addEventListener('click', openModal);
  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (modalError) modalError.style.display = 'none';

      const title = document.getElementById('input-title')?.value;
      const webinar_id = document.getElementById('input-webinar-id')?.value;
      const teacher_id = document.getElementById('select-teacher')?.value;
      const target_level = document.getElementById('select-level')?.value || null;
      const startTimeVal = document.getElementById('input-start-time')?.value;
      const duration_minutes = Number(document.getElementById('input-duration')?.value) || 60;
      const host_email = document.getElementById('input-host-email')?.value || 'suniltrendzeducation@gmail.com';
      const notes = document.getElementById('input-notes')?.value || '';

      if (!title || !webinar_id || !teacher_id || !startTimeVal) {
        if (modalError) {
          modalError.textContent = 'Please fill out all required fields.';
          modalError.style.display = 'block';
        }
        return;
      }

      const scheduled_start_time = new Date(startTimeVal).toISOString();

      try {
        const { data: { session: currentSession } } = await supabase.auth.getSession();
        const res = await fetch('/api/live-class', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentSession.access_token}`,
          },
          body: JSON.stringify({
            action: 'create',
            title,
            webinar_id,
            teacher_id,
            target_level,
            scheduled_start_time,
            duration_minutes,
            host_email,
            notes,
          }),
        });

        const resData = await res.json();
        if (!res.ok || !resData.ok) {
          throw new Error(resData.error || 'Failed to create live class.');
        }

        closeModal();
        showToast('Live class successfully scheduled!', 'success');
        await loadLiveClasses();
      } catch (err) {
        if (modalError) {
          modalError.textContent = err.message;
          modalError.style.display = 'block';
        }
      }
    });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initLiveClassesPage();
  });
}
