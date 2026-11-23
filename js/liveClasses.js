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
import { openModal, closeModal } from './modal.js';
import { TrendzMediaPlayer, formatDuration } from './mediaPlayer.js';

let currentUser = null;
let currentProfile = null;
let currentClasses = [];
let currentRecordings = [];
let activeRecordingPlayer = null;

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

        const typeBadge = cls.class_type === 'prerecorded'
          ? '<span class="badge badge-info" style="font-size: var(--text-xs);">Prerecorded</span>'
          : cls.class_type === 'stream'
            ? '<span class="badge badge-warning" style="font-size: var(--text-xs);">Stream</span>'
            : `<span class="badge badge-neutral" style="font-size: var(--text-xs);">Live ${cls.recording_enabled !== false ? '• REC' : ''}</span>`;

        return `
          <tr style="border-bottom: 1px solid var(--border-hairline);">
            <td style="padding: var(--space-3) var(--space-4);">
              <strong style="color: var(--text-main);">${cls.title}</strong>
              <div style="font-size: var(--text-xs); color: var(--text-muted); font-family: monospace;">Webinar ID: ${cls.webinar_id}</div>
            </td>
            <td style="padding: var(--space-3) var(--space-4);">
              ${typeBadge}
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
  const invitedSelect = document.getElementById('select-invited-teachers');
  if (!select && !invitedSelect) return;

  try {
    const supabase = await getSupabase();
    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name, student_code')
      .eq('role', 'teacher')
      .eq('active', true)
      .order('full_name');

    if (!teachers || teachers.length === 0) {
      if (select) select.innerHTML = '<option value="">No active teachers found</option>';
      if (invitedSelect) invitedSelect.innerHTML = '<option value="" disabled>No active teachers found</option>';
      return;
    }

    const optionsHtml = teachers
      .map((t) => `<option value="${t.id}">${t.full_name} (${t.student_code})</option>`)
      .join('');

    if (select) select.innerHTML = optionsHtml;
    if (invitedSelect) invitedSelect.innerHTML = optionsHtml;
  } catch (err) {
    if (select) select.innerHTML = '<option value="">Error loading teachers</option>';
    if (invitedSelect) invitedSelect.innerHTML = '<option value="" disabled>Error loading teachers</option>';
  }
}

/**
 * Loads private recording library for administrators
 */
export async function loadRecordings() {
  const loadingEl = document.getElementById('recordings-loading');
  const emptyEl = document.getElementById('recordings-empty');
  const tableWrapper = document.getElementById('recordings-table-wrapper');
  const tbody = document.getElementById('recordings-table-body');
  const countBadge = document.getElementById('recordings-count-badge');
  const searchInput = document.getElementById('search-recordings');
  const statusFilter = document.getElementById('filter-recording-status');

  if (loadingEl) loadingEl.style.display = 'block';
  if (emptyEl) emptyEl.style.display = 'none';
  if (tableWrapper) tableWrapper.style.display = 'none';

  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return;

    const res = await fetch('/api/live-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        action: 'list_recordings',
        search: searchInput?.value?.trim() || undefined,
        status: statusFilter?.value || undefined,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to load recordings library.');
    }

    currentRecordings = data.recordings || [];
    if (countBadge) {
      countBadge.textContent = `${currentRecordings.length} ${currentRecordings.length === 1 ? 'recording' : 'recordings'}`;
    }

    if (loadingEl) loadingEl.style.display = 'none';

    if (currentRecordings.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block';
      return;
    }

    if (tbody) {
      tbody.innerHTML = currentRecordings.map((rec) => {
        const isReady = rec.status === 'ready';
        const statusBadge = isReady
          ? '<span class="badge badge-success">Ready</span>'
          : rec.status === 'processing'
            ? '<span class="badge badge-warning">Processing</span>'
            : '<span class="badge badge-danger">Unavailable</span>';

        return `
          <tr style="border-bottom: 1px solid var(--border-hairline);">
            <td style="padding: var(--space-3) var(--space-4);">
              <strong style="color: var(--text-main);">${rec.title || rec.classTitle}</strong>
              <div style="font-size: var(--text-xs); color: var(--text-muted); font-family: monospace;">Webinar ID: ${rec.webinarId}</div>
            </td>
            <td style="padding: var(--space-3) var(--space-4); color: var(--text-main);">
              ${rec.teacherName} ${rec.teacherCode ? `<span style="font-size: var(--text-xs); color: var(--text-muted);">(${rec.teacherCode})</span>` : ''}
            </td>
            <td style="padding: var(--space-3) var(--space-4); white-space: nowrap;">
              ${formatTimeIST(rec.recordedAt || rec.createdAt)}
            </td>
            <td style="padding: var(--space-3) var(--space-4); font-family: monospace;">
              ${rec.durationSeconds ? formatDuration(rec.durationSeconds) : '—'}
            </td>
            <td style="padding: var(--space-3) var(--space-4);">
              ${statusBadge}
            </td>
            <td style="padding: var(--space-3) var(--space-4); text-align: right; white-space: nowrap;">
              <button
                type="button"
                class="btn btn-primary btn-sm btn-play-recording"
                data-id="${rec.id}"
                data-title="${rec.title || rec.classTitle}"
                ${!isReady ? 'disabled title="Recording is still processing"' : ''}
                style="margin-right: 4px;"
              >
                Play Replay
              </button>
              <button
                type="button"
                class="btn btn-outline btn-sm btn-delete-recording"
                data-id="${rec.id}"
                data-title="${rec.title || rec.classTitle}"
                style="color: #dc2626;"
                title="Remove recording from Trendz"
              >
                Remove
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    if (tableWrapper) tableWrapper.style.display = 'block';

    // Wire up Play buttons
    document.querySelectorAll('.btn-play-recording').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        await playRecording(id);
      });
    });

    // Wire up Delete buttons
    document.querySelectorAll('.btn-delete-recording').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const id = e.currentTarget.getAttribute('data-id');
        const title = e.currentTarget.getAttribute('data-title');
        openDeleteRecordingModal(id, title);
      });
    });

  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    showToast(err.message || 'Error loading recordings', 'error');
  }
}

async function playRecording(recordingId) {
  try {
    const supabase = await getSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/live-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'get_recording_playback', recordingId }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to retrieve recording replay.');
    }

    const { recording } = data;
    const titleEl = document.getElementById('modal-player-title');
    if (titleEl) titleEl.textContent = `${recording.title || recording.classTitle} (Replay)`;

    const mountEl = document.getElementById('player-recording-mount');
    if (!mountEl) return;

    if (activeRecordingPlayer) {
      activeRecordingPlayer.destroy();
      activeRecordingPlayer = null;
    }

    activeRecordingPlayer = new TrendzMediaPlayer(mountEl, {
      userId: currentUser?.id || 'admin',
      mediaId: recording.id,
      mediaType: 'video_mp4',
      mediaUrl: recording.playbackUrl,
      title: recording.title || recording.classTitle,
      category: 'Webinar Recording',
    });

    openModal('modal-play-recording');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openDeleteRecordingModal(id, title) {
  const targetTitle = document.getElementById('delete-recording-title-target');
  const targetId = document.getElementById('input-delete-recording-id');
  const reasonInput = document.getElementById('input-delete-reason');

  if (targetTitle) targetTitle.textContent = title ? `"${title}"` : 'this recording';
  if (targetId) targetId.value = id;
  if (reasonInput) reasonInput.value = '';

  openModal('modal-delete-recording');
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

  // Setup tab navigation
  const tabClasses = document.getElementById('tab-btn-classes');
  const tabRecordings = document.getElementById('tab-btn-recordings');
  const viewClasses = document.getElementById('view-classes-tab');
  const viewRecordings = document.getElementById('view-recordings-tab');

  if (tabClasses && tabRecordings) {
    tabClasses.addEventListener('click', () => {
      tabClasses.classList.add('btn-primary', 'tab-active');
      tabClasses.classList.remove('btn-outline');
      tabRecordings.classList.remove('btn-primary', 'tab-active');
      tabRecordings.classList.add('btn-outline');
      if (viewClasses) viewClasses.style.display = 'block';
      if (viewRecordings) viewRecordings.style.display = 'none';
    });

    tabRecordings.addEventListener('click', async () => {
      tabRecordings.classList.add('btn-primary', 'tab-active');
      tabRecordings.classList.remove('btn-outline');
      tabClasses.classList.remove('btn-primary', 'tab-active');
      tabClasses.classList.add('btn-outline');
      if (viewClasses) viewClasses.style.display = 'none';
      if (viewRecordings) viewRecordings.style.display = 'block';
      await loadRecordings();
    });
  }

  // Setup Recordings filter listeners
  document.getElementById('search-recordings')?.addEventListener('input', () => {
    loadRecordings();
  });
  document.getElementById('filter-recording-status')?.addEventListener('change', () => {
    loadRecordings();
  });
  document.getElementById('btn-refresh-recordings')?.addEventListener('click', () => {
    loadRecordings();
  });

  // Setup Player Modal Close Listener
  const closePlayerModal = () => {
    closeModal('modal-play-recording');
    if (activeRecordingPlayer) {
      activeRecordingPlayer.destroy();
      activeRecordingPlayer = null;
    }
  };
  document.getElementById('btn-close-player-modal')?.addEventListener('click', closePlayerModal);
  document.getElementById('modal-play-recording')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-play-recording') closePlayerModal();
  });

  // Setup Delete Recording Confirmation
  const confirmDeleteBtn = document.getElementById('btn-confirm-delete-recording');
  if (confirmDeleteBtn) {
    confirmDeleteBtn.addEventListener('click', async () => {
      const recordingId = document.getElementById('input-delete-recording-id')?.value;
      const reason = document.getElementById('input-delete-reason')?.value || '';
      if (!recordingId) return;

      try {
        const { data: { session: curSession } } = await supabase.auth.getSession();
        const res = await fetch('/api/live-class', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${curSession.access_token}`,
          },
          body: JSON.stringify({
            action: 'delete_recording',
            recordingId,
            reason,
          }),
        });
        const resData = await res.json();
        if (!res.ok || !resData.ok) {
          throw new Error(resData.error || 'Failed to remove recording.');
        }

        closeModal('modal-delete-recording');
        showToast(resData.message || 'Recording removed from Trendz.', 'success');
        if (resData.providerNotice) {
          setTimeout(() => showToast(resData.providerNotice, 'info'), 1500);
        }
        await loadRecordings();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  // Setup Class Type delivery toggle in Create Modal
  const selectClassType = document.getElementById('select-class-type');
  const rowPrerecorded = document.getElementById('row-prerecorded-url');
  const inputWebinarId = document.getElementById('input-webinar-id');
  const helpWebinarId = document.getElementById('help-webinar-id');

  if (selectClassType) {
    selectClassType.addEventListener('change', () => {
      const isPrerecorded = selectClassType.value === 'prerecorded';
      if (rowPrerecorded) rowPrerecorded.style.display = isPrerecorded ? 'block' : 'none';
      if (inputWebinarId) {
        if (isPrerecorded) {
          inputWebinarId.removeAttribute('required');
          if (helpWebinarId) helpWebinarId.textContent = 'Optional for prerecorded videos (auto-assigned if left blank).';
        } else {
          inputWebinarId.setAttribute('required', 'required');
          if (helpWebinarId) helpWebinarId.innerHTML = 'Copy the Webinar ID from your Webinar.gg dashboard (e.g. pilot webinar: <code style="font-family: monospace;">cmvl53hcc0bycs60yjljyys4z</code>).';
        }
      }
    });
  }

  // Setup modal wiring immediately after admin/teacher access is confirmed
  // so slow or failing class/teacher list network requests cannot delay the button
  const modal = document.getElementById('modal-create-class');
  const btnOpen = document.getElementById('btn-open-create-modal');
  const btnClose = document.getElementById('btn-close-modal');
  const btnCancel = document.getElementById('btn-cancel-create');
  const form = document.getElementById('form-create-class');
  const modalError = document.getElementById('modal-error');

  const prefillStartTime = () => {
    const startTimeInput = document.getElementById('input-start-time');
    if (startTimeInput) {
      const now = new Date(Date.now() + 30 * 60 * 1000);
      const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      startTimeInput.value = localIso;
    }
  };

  const handleOpenCreateModal = () => {
    prefillStartTime();
    if (modalError) {
      modalError.style.display = 'none';
      modalError.textContent = '';
    }
    openModal('modal-create-class');
  };

  const handleCloseCreateModal = () => {
    closeModal('modal-create-class');
    if (form) form.reset();
    if (rowPrerecorded) rowPrerecorded.style.display = 'none';
    if (modalError) {
      modalError.style.display = 'none';
      modalError.textContent = '';
    }
  };

  if (btnOpen) btnOpen.addEventListener('click', handleOpenCreateModal);
  if (btnClose) btnClose.addEventListener('click', handleCloseCreateModal);
  if (btnCancel) btnCancel.addEventListener('click', handleCloseCreateModal);

  // Close on backdrop click
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        handleCloseCreateModal();
      }
    });
  }

  // Handle Escape key to reset form on close
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Escape' || e.key === 'Esc') && modal && (modal.classList.contains('open') || modal.classList.contains('is-open'))) {
      handleCloseCreateModal();
    }
    if ((e.key === 'Escape' || e.key === 'Esc') && document.getElementById('modal-play-recording')?.classList.contains('is-open')) {
      closePlayerModal();
    }
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (modalError) {
        modalError.style.display = 'none';
        modalError.textContent = '';
      }

      const title = document.getElementById('input-title')?.value?.trim();
      const class_type = selectClassType?.value || 'live';
      let webinar_id = document.getElementById('input-webinar-id')?.value?.trim();
      const prerecorded_asset_url = document.getElementById('input-prerecorded-url')?.value?.trim() || null;
      const recording_enabled = document.getElementById('check-enable-recording')
        ? document.getElementById('check-enable-recording').checked
        : true;

      const teacher_id = document.getElementById('select-teacher')?.value;
      const invitedSelect = document.getElementById('select-invited-teachers');
      const invited_teacher_ids = invitedSelect
        ? Array.from(invitedSelect.selectedOptions).map((o) => o.value)
        : [];
      const target_level = document.getElementById('select-level')?.value || null;
      const startTimeVal = document.getElementById('input-start-time')?.value;
      const duration_minutes = Number(document.getElementById('input-duration')?.value) || 60;
      const host_email = document.getElementById('input-host-email')?.value?.trim() || null;
      const notes = document.getElementById('input-notes')?.value || '';

      if (class_type === 'prerecorded' && !webinar_id) {
        webinar_id = `prerecorded-${Date.now()}`;
      }

      if (!title || !webinar_id || !teacher_id || !startTimeVal) {
        if (modalError) {
          modalError.textContent = 'Please fill out all required fields.';
          modalError.style.display = 'block';
        }
        return;
      }

      if (class_type === 'prerecorded' && !prerecorded_asset_url) {
        if (modalError) {
          modalError.textContent = 'Please provide a valid video asset or embed URL for the scheduled prerecorded class.';
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
            class_type,
            webinar_id,
            prerecorded_asset_url,
            recording_enabled,
            teacher_id,
            invited_teacher_ids,
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

        handleCloseCreateModal();
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

  // Load initial classes and teachers asynchronously in the background so slow responses don't delay modal
  loadLiveClasses().catch((err) => console.error('Failed to load live classes:', err));
  loadTeachersSelect().catch((err) => console.error('Failed to load teachers:', err));
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initLiveClassesPage();
  });
}
