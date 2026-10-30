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
  if (checkProductionConfigLock()) {
    return null;
  }

  const profile = await getCurrentProfile();

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

  // Populate header UI elements if present
  setupHeaderUserUI(profile);
  renderConfigBanner();
  if (profile.role === 'student') {
    initStudentNotificationBell(profile);
  }

  return profile;
}

/**
 * Route guard for public pages (Login page).
 * If user is already authenticated, redirects them straight to their dashboard.
 */
export async function requireNoAuth() {
  if (checkProductionConfigLock()) {
    return;
  }

  const profile = await getCurrentProfile();
  if (profile) {
    redirectByRole(profile);
  } else {
    renderConfigBanner();
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

  if (userNameEl) userNameEl.textContent = profile.full_name;
  if (userRoleEl) userRoleEl.textContent = profile.role === 'admin' ? 'Teacher / Admin' : 'Student';
  if (userCodeEl) userCodeEl.textContent = profile.student_code;

  if (logoutBtn) {
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
