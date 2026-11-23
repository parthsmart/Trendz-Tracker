/**
 * Trendz Tracker — Dedicated Live Class Room Controller (js/liveRoom.js)
 *
 * Implements the live room experience:
 * - Server-side authorization resolution (never exposes Webinar.gg ID or token in navigation URL)
 * - Embeds Webinar.gg room inside full-viewport iframe after user chooses to join
 * - Memory-only join token handling (strictly out of localStorage, sessionStorage, caches)
 * - Safe iframe permissions: camera; microphone; autoplay; display-capture; fullscreen
 * - Secure postMessage origin verification (strictly checks event.origin === 'https://webinar.gg')
 * - Bounded session recovery: transparent 1-time refresh on 401 INVALID_TOKEN
 * - Actionable error states for unenrolled, host mismatch, waiting for host, ended, and network drops
 * - Secure "Open in Browser" fallback (ephemeral window.open with no URL logging or storage)
 */

import { getSupabase } from './supabaseClient.js';
import { TrendzMediaPlayer } from './mediaPlayer.js';

let currentClassId = null;
let currentClassMeta = null;
let activeIframe = null;
let isJoining = false;
let userRole = 'student';

function showSection(sectionId) {
  const sections = ['prejoin-lobby', 'room-loading', 'room-error', 'room-ended', 'embed-frame-wrapper'];
  sections.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === sectionId ? (id === 'embed-frame-wrapper' ? 'block' : 'flex') : 'none';
  });
}

function getNavigationBackDefaults() {
  if (userRole === 'admin') {
    return { url: '/pages/admin.html', label: 'Back to Dashboard' };
  }
  if (userRole === 'teacher') {
    return { url: '/pages/teacher.html', label: 'Back to Workspace' };
  }
  return { url: '/pages/student.html', label: 'Back to Today' };
}

function updateStatusBadge(status, isHost, isInvitedParticipant) {
  const badge = document.getElementById('room-status-badge');
  if (!badge) return;

  if (status === 'ended') {
    badge.className = 'badge badge-neutral';
    badge.textContent = 'Ended';
    return;
  }
  if (status === 'cancelled') {
    badge.className = 'badge badge-danger';
    badge.textContent = 'Cancelled';
    return;
  }

  if (isHost) {
    badge.className = 'badge badge-primary';
    badge.innerHTML = 'Host Studio';
    return;
  }

  if (isInvitedParticipant) {
    badge.className = 'badge badge-info';
    badge.innerHTML = 'Participant';
    return;
  }

  switch (status) {
    case 'live':
      badge.className = 'badge badge-success';
      badge.innerHTML = '<span class="pulse-dot"></span> Live Now';
      break;
    case 'waiting':
      badge.className = 'badge badge-warning';
      badge.textContent = 'Waiting for Teacher';
      break;
    case 'scheduled':
    default:
      badge.className = 'badge badge-info';
      badge.textContent = 'Scheduled';
      break;
  }
}

/**
 * Executes a server request to /api/live-class with automatic 1-shot session recovery
 * on 401 INVALID_TOKEN or UNAUTHENTICATED.
 */
async function requestLiveClassWithRecovery(action, payload = {}, retryCount = 0) {
  const maxRetries = 1;
  const supabase = await getSupabase();
  let { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
    if (refreshErr || !refreshed?.session?.access_token) {
      return { ok: false, code: 'SESSION_EXPIRED', error: 'Your session has expired. Please sign in again.' };
    }
    session = refreshed.session;
  }

  try {
    const res = await fetch('/api/live-class', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });

    const data = await res.json().catch(() => null);

    // If 401 INVALID_TOKEN or UNAUTHENTICATED: attempt single session refresh & retry
    if (res.status === 401 || data?.code === 'INVALID_TOKEN' || data?.code === 'UNAUTHENTICATED') {
      if (retryCount < maxRetries) {
        console.warn('[LiveRoom] Authentication token expired or invalid. Attempting single session refresh...');
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr && refreshed?.session?.access_token) {
          return requestLiveClassWithRecovery(action, payload, retryCount + 1);
        }
      }
      return {
        ok: false,
        code: 'SESSION_EXPIRED',
        error: 'Your session has expired. Please sign in again to rejoin this live class.',
      };
    }

    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        status: res.status,
        code: data?.code || 'REQUEST_FAILED',
        error: data?.error || `Request failed with status ${res.status}`,
        meta: data,
        class: data?.class,
      };
    }

    return data;
  } catch (netErr) {
    console.warn('[LiveRoom] Network request exception:', netErr);
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error: 'Network connection issue. Please check your internet connection and try again.',
    };
  }
}

/**
 * Shows actionable error dialog with tailored buttons and clear messaging
 */
function showError(message, code, meta = {}) {
  const titleEl = document.getElementById('room-error-title');
  const msgEl = document.getElementById('room-error-message');
  const actionsEl = document.getElementById('room-error-actions');
  const { url: backUrl, label: backLabel } = getNavigationBackDefaults();

  const currentPathWithQuery = encodeURIComponent(window.location.pathname + window.location.search);
  const signInUrl = `/index.html?returnTo=${currentPathWithQuery}`;

  let heading = 'Connection Notice';
  let bodyText = message || 'Could not connect to the live room.';
  let buttonsHtml = '';

  switch (code) {
    case 'SESSION_EXPIRED':
    case 'INVALID_TOKEN':
    case 'UNAUTHENTICATED':
      heading = 'Session Expired';
      bodyText = 'Your session has expired. Please sign in again to return to this live class.';
      buttonsHtml = `
        <a href="${signInUrl}" class="btn btn-primary btn-sm" style="text-decoration: none;">Sign In Again</a>
        <a href="${backUrl}" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">${backLabel}</a>
      `;
      break;

    case 'NOT_ENROLLED':
      heading = 'Not Enrolled in This Class';
      bodyText = 'Your student account is not enrolled in this live class. Please check your schedule or contact your teacher.';
      buttonsHtml = `
        <a href="/pages/student.html" class="btn btn-primary btn-sm" style="text-decoration: none;">Back to Today</a>
      `;
      break;

    case 'HOST_IDENTITY_MISMATCH':
      heading = 'Host Identity Mismatch';
      bodyText = meta.error || `You are signed in as an administrator, but this class requires host account (${meta.requiredHostEmail || 'configured host'}). Please sign in with the host credentials.`;
      buttonsHtml = `
        <a href="${signInUrl}" class="btn btn-primary btn-sm" style="text-decoration: none;">Sign In with Host Account</a>
        <a href="/pages/admin.html" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">Back to Dashboard</a>
      `;
      break;

    case 'TEACHER_HOSTING_DISABLED':
      heading = 'Host Setup Required';
      bodyText = 'Teacher hosting is currently disabled. Hosting requires an individual Webinar.gg host account or configured co-host delegation without impersonation.';
      buttonsHtml = `
        <a href="/pages/teacher.html" class="btn btn-primary btn-sm" style="text-decoration: none;">Back to Workspace</a>
      `;
      break;

    case 'NOT_INVITED':
      heading = 'Participant Access Not Authorized';
      bodyText = 'You are signed in as a teacher, but you have not been invited as a participant to this live class.';
      buttonsHtml = `
        <a href="/pages/teacher.html" class="btn btn-primary btn-sm" style="text-decoration: none;">Back to Workspace</a>
      `;
      break;

    case 'CLASS_ENDED':
      showSection('room-ended');
      return;

    case 'CLASS_CANCELLED':
      heading = 'Class Cancelled';
      bodyText = 'This live class has been cancelled by the teacher or institute.';
      buttonsHtml = `
        <a href="${backUrl}" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">${backLabel}</a>
      `;
      break;

    case 'WAITING_FOR_HOST':
      heading = 'Waiting for Host';
      bodyText = 'The class is scheduled, but the host has not started broadcasting yet. You can check again or wait for the host to go live.';
      buttonsHtml = `
        <button type="button" id="btn-action-recheck" class="btn btn-primary btn-sm">Check Again</button>
        <a href="${backUrl}" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">${backLabel}</a>
      `;
      break;

    case 'NETWORK_ERROR':
      heading = 'Connection Issue';
      bodyText = 'Could not reach the server. Please check your internet connection.';
      buttonsHtml = `
        <button type="button" id="btn-action-retry-net" class="btn btn-primary btn-sm">Try Again</button>
        <a href="${backUrl}" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">${backLabel}</a>
      `;
      break;

    default:
      heading = 'Live Room Notice';
      bodyText = message || 'Could not connect to the live room.';
      buttonsHtml = `
        <button type="button" id="btn-action-rejoin" class="btn btn-primary btn-sm">Rejoin</button>
        <button type="button" id="btn-action-browser" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569;">Open in Browser</button>
        <a href="${backUrl}" class="btn btn-outline btn-sm" style="color: #f8fafc; border-color: #475569; text-decoration: none;">${backLabel}</a>
      `;
      break;
  }

  if (titleEl) titleEl.textContent = heading;
  if (msgEl) msgEl.textContent = bodyText;
  if (actionsEl) {
    actionsEl.innerHTML = buttonsHtml;

    // Attach dynamic handlers
    const retryBtn = document.getElementById('btn-action-retry-net');
    if (retryBtn) retryBtn.addEventListener('click', () => loadClassMetadata(currentClassId));

    const recheckBtn = document.getElementById('btn-action-recheck');
    if (recheckBtn) recheckBtn.addEventListener('click', () => loadClassMetadata(currentClassId));

    const rejoinBtn = document.getElementById('btn-action-rejoin');
    if (rejoinBtn) rejoinBtn.addEventListener('click', joinRoom);

    const browserBtn = document.getElementById('btn-action-browser');
    if (browserBtn) browserBtn.addEventListener('click', openInBrowserFallback);
  }

  showSection('room-error');
}

/**
 * Loads metadata for the class (without minting join token yet)
 */
async function loadClassMetadata(classId) {
  showSection('room-loading');

  // Determine user role for navigation defaults
  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user?.id) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .maybeSingle();
    if (profile?.role) {
      userRole = profile.role;
    }
  }

  const { url: backUrl, label: backLabel } = getNavigationBackDefaults();
  const backNav = document.getElementById('btn-back-nav');
  const backNavLabel = document.getElementById('label-back-nav');
  const endedBack = document.getElementById('btn-ended-back');
  const errorBack = document.getElementById('btn-error-back');

  if (backNav) backNav.href = backUrl;
  if (backNavLabel) backNavLabel.textContent = backLabel;
  if (endedBack) endedBack.href = backUrl;
  if (errorBack) errorBack.href = backUrl;

  const data = await requestLiveClassWithRecovery('get_class_details', { classId });
  if (!data || !data.ok) {
    showError(data?.error || 'Could not load class details.', data?.code, data?.meta);
    return;
  }

  currentClassMeta = data.class;

  // Update header and lobby text
  const titleEl = document.getElementById('room-class-title');
  const teacherEl = document.getElementById('room-teacher-name');
  const lobbyTitle = document.getElementById('lobby-title');
  const lobbyTeacher = document.getElementById('lobby-teacher');
  const confirmJoinBtn = document.getElementById('btn-confirm-join');

  if (titleEl) titleEl.textContent = currentClassMeta.title;
  if (teacherEl) teacherEl.textContent = `with ${currentClassMeta.teacherName}`;
  if (lobbyTitle) lobbyTitle.textContent = currentClassMeta.title;
  if (lobbyTeacher) lobbyTeacher.textContent = `with ${currentClassMeta.teacherName}`;

  if (confirmJoinBtn) {
    if (currentClassMeta.isHost) {
      confirmJoinBtn.textContent = 'Enter Host Studio →';
    } else if (currentClassMeta.isInvitedParticipant) {
      confirmJoinBtn.textContent = 'Join Live Class as Participant →';
    } else {
      confirmJoinBtn.textContent = 'Enter Live Room →';
    }
  }

  updateStatusBadge(currentClassMeta.status, currentClassMeta.isHost, currentClassMeta.isInvitedParticipant);

  const recNoticeEl = document.getElementById('lobby-recording-notice');
  if (recNoticeEl) {
    if (currentClassMeta.recordingNotice) {
      recNoticeEl.style.display = 'flex';
      recNoticeEl.innerHTML = `<span style="font-size: 14px;">●</span> <span>${currentClassMeta.recordingNotice}</span>`;
    } else {
      recNoticeEl.style.display = 'none';
    }
  }

  // Status checks
  if (currentClassMeta.status === 'cancelled') {
    showError('This live class has been cancelled by the teacher or institute.', 'CLASS_CANCELLED');
    return;
  }
  if (
    currentClassMeta.status === 'ended' ||
    currentClassMeta.providerStatus === 'completed' ||
    currentClassMeta.providerStatus === 'ended'
  ) {
    showSection('room-ended');
    return;
  }
  if (currentClassMeta.hostingDisabled) {
    showError(
      'Teacher hosting is currently disabled. Hosting requires an individual Webinar.gg host account or configured co-host delegation without impersonation.',
      'TEACHER_HOSTING_DISABLED'
    );
    return;
  }

  showSection('prejoin-lobby');
}

/**
 * Requests join token from server and mounts Webinar.gg embedded iframe
 */
async function joinRoom() {
  if (isJoining) return;
  isJoining = true;

  const joinBtn = document.getElementById('btn-confirm-join');
  if (joinBtn) {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting...';
  }

  showSection('room-loading');

  try {
    const data = await requestLiveClassWithRecovery('join', { classId: currentClassId });
    if (!data || !data.ok) {
      showError(data?.error || 'Failed to authorize live room access.', data?.code, data?.meta);
      return;
    }

    if (data.classType === 'prerecorded') {
      const wrapper = document.getElementById('embed-frame-wrapper');
      if (wrapper) {
        wrapper.innerHTML = '';
        new TrendzMediaPlayer(wrapper, {
          userId: currentClassMeta?.userId || 'student',
          mediaId: currentClassId,
          mediaType: 'drive_embed',
          mediaUrl: data.assetUrl,
          title: data.classTitle || currentClassMeta?.title,
          category: 'Scheduled Video',
        });
        showSection('embed-frame-wrapper');
      }
      return;
    }

    // Embed URL is held strictly in local function memory closure
    mountEmbeddedPlayer(data.embedUrl);

    // Show rejoin button in header for easy reconnection
    const rejoinBtn = document.getElementById('btn-rejoin-room');
    if (rejoinBtn) rejoinBtn.style.display = 'inline-block';

  } catch (err) {
    showError(err.message || 'Connection failed.', 'ERROR');
  } finally {
    isJoining = false;
    if (joinBtn) {
      joinBtn.disabled = false;
      if (currentClassMeta?.isHost) {
        joinBtn.textContent = 'Enter Host Studio →';
      } else if (currentClassMeta?.isInvitedParticipant) {
        joinBtn.textContent = 'Join Live Class as Participant →';
      } else {
        joinBtn.textContent = 'Enter Live Room →';
      }
    }
  }
}

/**
 * Authorized "Open in browser" fallback.
 * Strictly uses server authorization and keeps ephemeral join URL out of browser storage and logs.
 */
async function openInBrowserFallback() {
  const browserBtn = document.getElementById('btn-action-browser');
  if (browserBtn) {
    browserBtn.disabled = true;
    browserBtn.textContent = 'Authorizing...';
  }

  try {
    const data = await requestLiveClassWithRecovery('join', { classId: currentClassId });
    if (!data || !data.ok) {
      showError(data?.error || 'Failed to authorize live room access.', data?.code, data?.meta);
      return;
    }

    // Open ephemeral authorized URL in new tab without storing in storage or logs
    window.open(data.embedUrl, '_blank', 'noopener,noreferrer');
  } finally {
    if (browserBtn) {
      browserBtn.disabled = false;
      browserBtn.textContent = 'Open in Browser';
    }
  }
}

/**
 * Creates and mounts iframe securely
 */
function mountEmbeddedPlayer(embedUrl) {
  const wrapper = document.getElementById('embed-frame-wrapper');
  if (!wrapper) return;

  // Clear any existing frame
  wrapper.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.id = 'room-iframe';
  iframe.src = embedUrl;
  // Grant only required browser permissions
  iframe.allow = 'camera; microphone; autoplay; display-capture; fullscreen';
  iframe.allowFullscreen = true;

  activeIframe = iframe;
  wrapper.appendChild(iframe);
  showSection('embed-frame-wrapper');
}

/**
 * Sets up postMessage communication with Webinar.gg room
 */
function setupPostMessageBridge() {
  window.addEventListener('message', (event) => {
    // 1. Strict origin verification
    if (event.origin !== 'https://webinar.gg') return;

    // 2. Strict frame source verification
    if (activeIframe && event.source !== activeIframe.contentWindow) return;

    const payload = event.data;
    if (!payload || typeof payload !== 'object') return;

    switch (payload.type) {
      case 'webinar-ended':
        showSection('room-ended');
        break;
      case 'webinar-user-left':
      case 'webinar-user-kicked':
        showSection('prejoin-lobby');
        break;
      case 'fullscreen':
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        break;
      case 'fullscreen_exit':
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
        break;
      default:
        break;
    }
  });
}

/**
 * Sets up Fullscreen toggle
 */
function setupFullscreenToggle() {
  const btn = document.getElementById('btn-toggle-fullscreen');
  if (!btn) return;

  btn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
}

/**
 * Initializes the Live Room page
 */
export async function initLiveRoomPage() {
  const params = new URLSearchParams(window.location.search);
  currentClassId = params.get('classId');

  if (!currentClassId) {
    showError('No live class specified. Please return to your dashboard.');
    return;
  }

  setupPostMessageBridge();
  setupFullscreenToggle();

  const joinBtn = document.getElementById('btn-confirm-join');
  if (joinBtn) joinBtn.addEventListener('click', joinRoom);

  const retryBtn = document.getElementById('btn-retry-load');
  if (retryBtn) retryBtn.addEventListener('click', () => loadClassMetadata(currentClassId));

  const rejoinHeaderBtn = document.getElementById('btn-rejoin-room');
  if (rejoinHeaderBtn) rejoinHeaderBtn.addEventListener('click', joinRoom);

  await loadClassMetadata(currentClassId);
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    initLiveRoomPage();
  });
}
