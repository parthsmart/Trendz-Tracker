/**
 * Trendz Tracker — Dedicated Live Class Room Controller (js/liveRoom.js)
 *
 * Implements the live room experience:
 * - Server-side authorization resolution (never exposes Webinar.gg ID or token in navigation URL)
 * - Embeds Webinar.gg room inside full-viewport iframe after user chooses to join
 * - Memory-only join token handling (strictly out of localStorage, sessionStorage, caches)
 * - Safe iframe permissions: camera; microphone; autoplay; display-capture; fullscreen
 * - Secure postMessage origin verification (strictly checks event.origin === 'https://webinar.gg')
 * - Rejoin & retry paths for network drops, expired tokens, or unstarted classes
 */

import { getSupabase } from './supabaseClient.js';

let currentClassId = null;
let currentClassMeta = null;
let activeIframe = null;
let isJoining = false;

function showSection(sectionId) {
  const sections = ['prejoin-lobby', 'room-loading', 'room-error', 'room-ended', 'embed-frame-wrapper'];
  sections.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === sectionId ? (id === 'embed-frame-wrapper' ? 'block' : 'flex') : 'none';
  });
}

function updateStatusBadge(status, isHost) {
  const badge = document.getElementById('room-status-badge');
  if (!badge) return;

  if (isHost) {
    badge.className = 'badge badge-primary';
    badge.innerHTML = 'Host Studio';
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
    case 'ended':
      badge.className = 'badge badge-neutral';
      badge.textContent = 'Ended';
      break;
    case 'cancelled':
      badge.className = 'badge badge-danger';
      badge.textContent = 'Cancelled';
      break;
    case 'scheduled':
    default:
      badge.className = 'badge badge-info';
      badge.textContent = 'Scheduled';
      break;
  }
}

/**
 * Loads metadata for the class (without minting join token yet)
 */
async function loadClassMetadata(classId) {
  showSection('room-loading');

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
    body: JSON.stringify({ action: 'get_class_details', classId }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    showError(data.error || 'Could not load class details.', data.code);
    return;
  }

  currentClassMeta = data.class;

  // Update header and lobby
  const titleEl = document.getElementById('room-class-title');
  const teacherEl = document.getElementById('room-teacher-name');
  const lobbyTitle = document.getElementById('lobby-title');
  const lobbyTeacher = document.getElementById('lobby-teacher');
  const backNav = document.getElementById('btn-back-nav');
  const backNavLabel = document.getElementById('label-back-nav');

  if (titleEl) titleEl.textContent = currentClassMeta.title;
  if (teacherEl) teacherEl.textContent = `with ${currentClassMeta.teacherName}`;
  if (lobbyTitle) lobbyTitle.textContent = currentClassMeta.title;
  if (lobbyTeacher) lobbyTeacher.textContent = `with ${currentClassMeta.teacherName}`;

  if (currentClassMeta.isHost) {
    if (backNav) backNav.href = '/pages/teacher.html';
    if (backNavLabel) backNavLabel.textContent = 'Back to Workspace';
    const errorBack = document.getElementById('btn-error-back');
    const endedBack = document.getElementById('btn-ended-back');
    if (errorBack) errorBack.href = '/pages/teacher.html';
    if (endedBack) endedBack.href = '/pages/teacher.html';
  }

  updateStatusBadge(currentClassMeta.status, currentClassMeta.isHost);

  // If class is cancelled or ended, show relevant notice
  if (currentClassMeta.status === 'cancelled') {
    showError('This live class has been cancelled by the teacher or institute.', 'CLASS_CANCELLED');
    return;
  }
  if (currentClassMeta.status === 'ended') {
    showSection('room-ended');
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
      body: JSON.stringify({ action: 'join', classId: currentClassId }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'Failed to authorize live room access.');
    }

    // Embed URL is held strictly in local function closure memory
    mountEmbeddedPlayer(data.embedUrl);

    // Show rejoin button in header for easy reconnection
    const rejoinBtn = document.getElementById('btn-rejoin-room');
    if (rejoinBtn) rejoinBtn.style.display = 'inline-block';

  } catch (err) {
    showError(err.message || 'Connection failed.');
  } finally {
    isJoining = false;
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Enter Live Room →';
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

function showError(message, code) {
  const errMsg = document.getElementById('room-error-message');
  if (errMsg) errMsg.textContent = message;
  showSection('room-error');
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
