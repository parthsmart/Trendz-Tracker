/**
 * Trendz Tracker - Route Guard & Header Setup
 * Protects pages from unauthorized access and syncs user header info.
 */

import { getCurrentProfile, logoutUser, redirectByRole } from './auth.js';
import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { isDemoMode } from './demoDb.js';
import { openModal } from './modal.js';
import { showToast } from './toast.js';
import { initStudentNotificationBell } from './notificationBadge.js';
import { setupHeaderNavigation } from './headerNav.js';
import { formatShortFirstName } from './navConfig.js';
import { readProfileCache } from './profileCache.js';
import { markPerf, reportPagePerf } from './perf.js';

/**
 * Enforces production configuration lock:
 * If Supabase is unconfigured on a production hostname, renders a full-page
 * configuration error and stops all execution.
 */
export function checkProductionConfigLock() {
  if (!isSupabaseConfigured() && !isDemoAllowedHost()) {
    document.body.innerHTML = `
      <main style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f8fafc; font-family: system-ui, -apple-system, sans-serif; padding: 24px;">
        <div style="max-width: 480px; width: 100%; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
          <h1 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">Configuration error</h1>
          <p style="font-size: 15px; color: #475569; line-height: 1.5; margin: 0;">Please contact the administrator.</p>
        </div>
      </main>
    `;
    return true;
  }
  return false;
}

/**
 * Route guard for protected pages (Student & Admin).
 * @param {Array<'student' | 'admin'>} allowedRoles
 */
export async function requireAuth(allowedRoles = ['student', 'admin']) {
  markPerf('tt:guard-start');
  if (checkProductionConfigLock()) {
    return null;
  }

  // Synchronously pre-render the header navigation from navConfig.js before awaiting network
  const earlyCachedProfile = readProfileCache();
  if (earlyCachedProfile && allowedRoles.includes(earlyCachedProfile.role)) {
    setupHeaderNavigation(earlyCachedProfile);
    setupHeaderUserUI(earlyCachedProfile);
  } else if (Array.isArray(allowedRoles) && allowedRoles.length === 1) {
    setupHeaderNavigation({ role: allowedRoles[0] });
  } else {
    setupHeaderNavigation(null);
  }

  const profile = await getCurrentProfile({
    allowCached: true,
    onRevalidated: (freshProfile) => {
      if (!freshProfile || !allowedRoles.includes(freshProfile.role)) {
        if (freshProfile?.role === 'student') {
          window.location.href = '/pages/student.html';
        } else {
          window.location.href = '/index.html';
        }
        return;
      }
      setupHeaderNavigation(freshProfile);
      setupHeaderUserUI(freshProfile);
    },
  });

  if (!profile) {
    // Save attempted URL or redirect to login
    window.location.href = '/index.html';
    return null;
  }

  if (!allowedRoles.includes(profile.role)) {
    // If student attempts to view admin page:
    if (profile.role === 'student') {
      window.location.href = '/pages/student.html';
      return null;
    }
    window.location.href = '/index.html';
    return null;
  }

  // Mount Phase 14e header & mobile three-dot menu and populate user details
  setupHeaderNavigation(profile);
  setupHeaderUserUI(profile);
  renderConfigBanner();
  initStudentNotificationBell(profile);

  markPerf('tt:guard-ready');
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      window.setTimeout(() => reportPagePerf(), 0);
    });
  }

  return profile;
}

/**
 * Route guard for public pages (Login page).
 * If user is already authenticated, redirects them straight to their dashboard.
 */
export async function requireNoAuth() {
  markPerf('tt:guard-start');
  if (checkProductionConfigLock()) {
    return;
  }

  const profile = await getCurrentProfile({ allowCached: true });
  markPerf('tt:guard-ready');
  if (profile) {
    redirectByRole(profile);
  } else {
    renderConfigBanner();
    reportPagePerf('/index.html');
  }
}

/**
 * Injects user details and sign out handler into top navigation bar.
 */
function setupHeaderUserUI(profile) {
  const userNameEl = document.getElementById('header-user-name');
  const userRoleEl = document.getElementById('header-user-role');
  const userCodeEl = document.getElementById('header-user-code');
  const logoutBtn = document.getElementById('btn-header-logout');

  if (userNameEl) {
    userNameEl.textContent = profile.full_name;
    userNameEl.setAttribute(
      'data-short-name',
      formatShortFirstName(profile.full_name, profile.role === 'admin' ? 'Admin' : 'Student')
    );
    userNameEl.title = profile.full_name || '';
  }
  if (userRoleEl) userRoleEl.textContent = profile.role === 'admin' ? 'Admin' : 'Student';
  if (userCodeEl) userCodeEl.textContent = profile.student_code || (profile.role === 'admin' ? 'Admin' : 'STU');

  if (logoutBtn && !logoutBtn.dataset.logoutWired) {
    logoutBtn.dataset.logoutWired = 'true';
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await logoutUser();
      showToast('info', 'Logged out successfully');
    });
  }
}

/**
 * Renders an informative, friendly status banner if Supabase is in Demo Mode.
 * Only renders where demo mode is permitted (localhost or run.app).
 */
function renderConfigBanner() {
  const container = document.getElementById('config-banner-placeholder');
  if (!container) return;

  if (isDemoMode()) {
    container.innerHTML = `
      <div class="banner banner-warning" style="margin-bottom: var(--space-4); border: 2px dashed var(--color-warning);">
        <div>
          <strong>⚠️ DEMO MODE — data is fake:</strong> Running in local preview mode. Real Supabase keys are not set.
        </div>
        <button id="btn-show-sql-guide" class="btn btn-outline btn-sm" style="background:#fff;">
          Setup Guide & SQL
        </button>
      </div>
    `;

    const guideBtn = document.getElementById('btn-show-sql-guide');
    if (guideBtn) {
      guideBtn.addEventListener('click', () => {
        openModal('guide-modal');
      });
    }
  } else {
    container.innerHTML = '';
  }
}
