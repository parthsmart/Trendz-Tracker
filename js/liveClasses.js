/**
 * Trendz Tracker — Staff Live Classes Management (js/liveClasses.js)
 *
 * Handles staff setup flow for Webinar.gg live classes:
 * - List active, scheduled, and past classes
 * - Schedule a room, assign a teacher, and select the student audience
 * - Real-time provider sync button
 * - Quick "Open host room" navigation
 */

import { getSupabase } from './supabaseClient.js';
import { setupHeaderNavigation } from './headerNav.js';
import { openModal, closeModal } from './modal.js';
import { setupModalListeners } from './modal.js';
import { TrendzMediaPlayer, formatDuration } from './mediaPlayer.js';

let currentUser = null;
let currentProfile = null;
let currentClasses = [];
let currentRecordings = [];
let activeRecordingPlayer = null;

/**
 * Sets currentProfile for testing dropdown population and self-assignment
 */
export function setCurrentProfileForTesting(profile) {
  currentProfile = profile;
}

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

        const recBadge = (cls.recording_confirmed || cls.recordingConfirmed) ? ' • REC' : '';
        const typeBadge = cls.class_type === 'prerecorded'
          ? '<span class="badge badge-info" style="font-size: var(--text-xs);">Prerecorded</span>'
          : cls.class_type === 'stream'
            ? '<span class="badge badge-warning" style="font-size: var(--text-xs);">Stream</span>'
            : `<span class="badge badge-neutral" style="font-size: var(--text-xs);">Live${recBadge}</span>`;

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
 * Loads teachers into select dropdown and adds admin self-assignment option
 */
export async function loadTeachersSelect(supabaseClient = null) {
  const select = document.getElementById('select-teacher');
  const invitedSelect = document.getElementById('select-invited-teachers');
  if (!select && !invitedSelect) return;

  try {
    const supabase = supabaseClient || (await getSupabase());
    const { data: teachers } = await supabase
      .from('profiles')
      .select('id, full_name, student_code')
      .eq('role', 'teacher')
      .eq('active', true)
      .order('full_name');

    const adminName = currentProfile?.full_name || 'Admin';
    const selfOptionHtml = (currentProfile && currentProfile.role === 'admin')
      ? `<option value="${currentProfile.id}">Assign to me — ${adminName}</option>`
      : '';

    const activeTeachers = teachers || [];

    if (activeTeachers.length === 0) {
      if (select) {
        if (selfOptionHtml) {
          select.innerHTML = `<option value="${currentProfile.id}" selected>Assign to me — ${adminName}</option>`;
          select.value = currentProfile.id;
        } else {
          select.innerHTML = '<option value="">No active teachers found</option>';
        }
      }
      if (invitedSelect) invitedSelect.innerHTML = '<option value="" disabled>No active teachers found</option>';
      return;
    }

    const teacherOptionsHtml = activeTeachers
      .filter((t) => t.id !== currentProfile?.id)
      .map((t) => `<option value="${t.id}">${t.full_name} (${t.student_code})</option>`)
      .join('');

    if (select) {
      if (selfOptionHtml) {
        select.innerHTML = `${selfOptionHtml}${teacherOptionsHtml}`;
      } else {
        select.innerHTML = teacherOptionsHtml;
      }
    }

    if (invitedSelect) {
      invitedSelect.innerHTML = activeTeachers
        .filter((t) => t.id !== currentProfile?.id)
        .map((t) => `<option value="${t.id}">${t.full_name} (${t.student_code})</option>`)
        .join('');
    }
  } catch (err) {
    if (select) {
      const adminName = currentProfile?.full_name || 'Admin';
      if (currentProfile && currentProfile.role === 'admin') {
        select.innerHTML = `<option value="${currentProfile.id}" selected>Assign to me — ${adminName}</option>`;
        select.value = currentProfile.id;
      } else {
        select.innerHTML = '<option value="">Error loading teachers</option>';
      }
    }
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
  setupModalListeners();

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

  // Setup Attach Recording Modal (Webinar.gg Dashboard Workflow)
  const btnOpenAttach = document.getElementById('btn-open-attach-recording');
  const formAttach = document.getElementById('form-attach-recording');
  const selectAttachClass = document.getElementById('attach-rec-class');
  const inputAttachTitle = document.getElementById('attach-rec-title');
  const inputAttachUrl = document.getElementById('attach-rec-url');
  const inputAttachDuration = document.getElementById('attach-rec-duration');
  const inputAttachWebinarId = document.getElementById('attach-rec-webinar-id');
  const attachError = document.getElementById('attach-recording-error');

  function populateAttachClassSelect() {
    if (!selectAttachClass) return;
    selectAttachClass.innerHTML = '<option value="">Choose a live class...</option>';
    currentClasses.forEach((cls) => {
      const opt = document.createElement('option');
      opt.value = cls.id;
      opt.textContent = `${cls.title} (Status: ${cls.status}, Webinar: ${cls.webinarId || 'N/A'})`;
      opt.dataset.title = cls.title;
      opt.dataset.webinarId = cls.webinarId || '';
      selectAttachClass.appendChild(opt);
    });
  }

  if (selectAttachClass) {
    selectAttachClass.addEventListener('change', () => {
      const selected = selectAttachClass.options[selectAttachClass.selectedIndex];
      if (selected && selected.value) {
        if (inputAttachTitle && (!inputAttachTitle.value || inputAttachTitle.value.endsWith('(Replay)'))) {
          inputAttachTitle.value = `${selected.dataset.title} (Replay)`;
        }
        if (inputAttachWebinarId) {
          inputAttachWebinarId.value = selected.dataset.webinarId || '';
        }
      }
    });
  }

  if (btnOpenAttach) {
    btnOpenAttach.addEventListener('click', () => {
      populateAttachClassSelect();
      if (attachError) {
        attachError.style.display = 'none';
        attachError.textContent = '';
      }
      openModal('modal-attach-recording');
    });
  }

  if (formAttach) {
    formAttach.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('btn-submit-attach-recording');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Attaching...';
      }
      if (attachError) {
        attachError.style.display = 'none';
        attachError.textContent = '';
      }

      try {
        const classId = selectAttachClass?.value;
        const title = inputAttachTitle?.value?.trim();
        const recordingUrl = inputAttachUrl?.value?.trim();
        const durationMinutes = inputAttachDuration?.value ? Number(inputAttachDuration.value) : undefined;
        const webinarId = inputAttachWebinarId?.value?.trim() || undefined;

        if (!classId) throw new Error('Please select an associated live class.');
        if (!title) throw new Error('Recording title is required.');
        if (!recordingUrl) throw new Error('A private recording reference is required.');

        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('Your session has expired. Please sign in again.');

        const res = await fetch('/api/live-class', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            action: 'attach_recording',
            classId,
            title,
            recordingUrl,
            durationMinutes,
            webinarId,
          }),
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to attach webinar recording.');
        }

        closeModal('modal-attach-recording');
        formAttach.reset();
        showToast('Webinar recording successfully attached to library!', 'success');
        await loadRecordings();
      } catch (err) {
        if (attachError) {
          attachError.style.display = 'block';
          attachError.textContent = err.message || 'Error attaching recording.';
        }
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Attach to Library';
        }
      }
    });
  }

  // Setup Class Type delivery toggle in Create Modal
  const selectClassType = document.getElementById('select-class-type');
  const rowPrerecorded = document.getElementById('row-prerecorded-url');
  const helpWebinarId = document.getElementById('help-webinar-id');

  if (selectClassType) {
    selectClassType.addEventListener('change', () => {
      const isPrerecorded = selectClassType.value === 'prerecorded';
      if (rowPrerecorded) rowPrerecorded.style.display = isPrerecorded ? 'block' : 'none';
      helpWebinarId.textContent = {
        live: 'Leave blank to create a room automatically.',
        prerecorded: 'Optional for prerecorded videos.',
        stream: 'Choose an existing Webinar.gg room for a provider stream.',
      }[selectClassType.value];
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
  const submitButton = document.getElementById('btn-submit-create');
  const audience = document.getElementById('select-audience');
  const levelSelect = document.getElementById('select-level');
  const studentSearch = document.getElementById('input-student-search');
  const studentOptions = document.getElementById('class-student-options');
  const audienceCount = document.getElementById('class-audience-count');
  const selectedStudents = new Set();
  let students = [];
  let rosterPromise;

  const updateAudience = () => {
    document.getElementById('row-class-level').hidden = audience.value !== 'level';
    document.getElementById('row-class-students').hidden = audience.value !== 'students';
    const count = {
      all: students.length,
      level: students.filter((student) => student.level === levelSelect.value).length,
      students: selectedStudents.size,
    }[audience.value];
    audienceCount.textContent = count == null ? '' : `${count} ${count === 1 ? 'student' : 'students'}`;
  };

  const renderStudentOptions = () => {
    const search = studentSearch.value.trim().toLowerCase();
    const matches = students.filter((student) =>
      `${student.full_name} ${student.student_code || ''}`.toLowerCase().includes(search)
    );
    studentOptions.replaceChildren();
    if (!matches.length) studentOptions.textContent = 'No students found.';
    for (const student of matches) {
      const label = document.createElement('label');
      label.style.display = 'block';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedStudents.has(student.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedStudents.add(student.id);
        else selectedStudents.delete(student.id);
        updateAudience();
      });
      label.append(checkbox, ` ${student.full_name}${student.student_code ? ` (${student.student_code})` : ''}`);
      studentOptions.append(label);
    }
  };

  const loadClassRoster = async () => {
    const roster = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.from('profiles')
        .select('id, full_name, student_code, level')
        .eq('role', 'student').eq('active', true)
        .order('full_name').order('id').range(offset, offset + pageSize - 1);
      if (error) throw error;
      roster.push(...data);
      if (data.length < pageSize) break;
    }
    students = roster;
    const levels = [...new Set(students.map((student) => student.level).filter(Boolean))].sort();
    levelSelect.replaceChildren(new Option('Choose a class level', ''));
    for (const level of levels) levelSelect.add(new Option(level, level));
    renderStudentOptions();
    updateAudience();
  };

  audience.addEventListener('change', updateAudience);
  levelSelect.addEventListener('change', updateAudience);
  studentSearch.addEventListener('input', renderStudentOptions);

  const prefillStartTime = () => {
    const startTimeInput = document.getElementById('input-start-time');
    if (startTimeInput) {
      const now = new Date(Date.now() + 30 * 60 * 1000);
      startTimeInput.value = new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 16);
    }
  };

  const handleOpenCreateModal = () => {
    prefillStartTime();
    if (modalError) {
      modalError.style.display = 'none';
      modalError.textContent = '';
    }
    openModal('modal-create-class');
    if (!rosterPromise) {
      audience.disabled = true;
      submitButton.disabled = true;
      rosterPromise = loadClassRoster()
        .then(() => {
          audience.disabled = false;
          submitButton.disabled = false;
        })
        .catch(() => {
          modalError.textContent = 'Could not load students. Close this form and open it again to retry.';
          modalError.style.display = 'block';
          rosterPromise = null;
        });
    }
  };

  const handleCloseCreateModal = () => {
    closeModal('modal-create-class');
    if (form) form.reset();
    selectedStudents.clear();
    renderStudentOptions();
    updateAudience();
    selectClassType.dispatchEvent(new Event('change'));
    if (rowPrerecorded) rowPrerecorded.style.display = 'none';
    if (modalError) {
      modalError.style.display = 'none';
      modalError.textContent = '';
    }
  };

  if (btnOpen) {
    btnOpen.hidden = profile.role !== 'admin';
    if (profile.role === 'admin') {
      btnOpen.addEventListener('click', handleOpenCreateModal);
      btnOpen.disabled = false;
    }
  }
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
      if (submitButton.disabled) return;
      if (modalError) {
        modalError.style.display = 'none';
        modalError.textContent = '';
      }

      const title = document.getElementById('input-title')?.value?.trim();
      const class_type = selectClassType?.value || 'live';
      const webinar_id = document.getElementById('input-webinar-id')?.value?.trim();
      const prerecorded_asset_url = document.getElementById('input-prerecorded-url')?.value?.trim() || null;
      const recording_enabled = document.getElementById('check-enable-recording')?.checked === true;

      const teacher_id = document.getElementById('select-teacher')?.value;
      const invitedSelect = document.getElementById('select-invited-teachers');
      const invited_teacher_ids = invitedSelect
        ? Array.from(invitedSelect.selectedOptions).map((o) => o.value)
        : [];
      const target_level = audience.value === 'level' ? levelSelect.value : null;
      const target_student_ids = audience.value === 'students' ? [...selectedStudents] : null;
      const startTimeVal = document.getElementById('input-start-time')?.value;
      const duration_minutes = Number(document.getElementById('input-duration')?.value) || 60;
      const host_email = document.getElementById('input-host-email')?.value?.trim() || null;
      const notes = document.getElementById('input-notes')?.value || '';

      if (!title || !teacher_id || !startTimeVal || !audience.value) {
        if (modalError) {
          modalError.textContent = 'Please fill out all required fields.';
          modalError.style.display = 'block';
        }
        return;
      }

      if ((audience.value === 'level' && !target_level) ||
          (audience.value === 'students' && !target_student_ids.length)) {
        modalError.textContent = 'Choose a class level or select at least one student.';
        modalError.style.display = 'block';
        return;
      }
      if (class_type === 'stream' && !webinar_id) {
        modalError.textContent = 'Choose an existing Webinar.gg room for the stream.';
        modalError.style.display = 'block';
        return;
      }

      if (class_type === 'prerecorded' && !prerecorded_asset_url) {
        if (modalError) {
          modalError.textContent = 'Please provide a valid video asset or embed URL for the scheduled prerecorded class.';
          modalError.style.display = 'block';
        }
        return;
      }

      const scheduled_start_time = new Date(`${startTimeVal}+05:30`).toISOString();

      submitButton.disabled = true;
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
            target_student_ids,
            audience: audience.value,
            scheduled_start_time,
            duration_minutes,
            host_email,
            notes,
          }),
        });

        const resData = await res.json();
        if (!res.ok || !resData.ok) {
          if (resData.existingRoomId) {
            document.getElementById('input-webinar-id').value = resData.existingRoomId;
            document.getElementById('input-host-email').value = resData.existingHostEmail || '';
          }
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
      } finally {
        submitButton.disabled = false;
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
