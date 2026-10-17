/**
 * Trendz Tracker - Route Guard & Header Setup
 * Protects pages from unauthorized access and syncs user header info.
 */

import { getCurrentProfile, logoutUser, redirectByRole } from './auth.js';
import { isSupabaseConfigured } from './config.js';
import { showToast } from './toast.js';

/**
 * Route guard for protected pages (Student & Admin).
 * @param {Array<'student' | 'admin'>} allowedRoles
 */
export async function requireAuth(allowedRoles = ['student', 'admin']) {
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

  return profile;
}

/**
 * Route guard for public pages (Login page).
 * If user is already authenticated, redirects them straight to their dashboard.
 */
export async function requireNoAuth() {
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
 */
function renderConfigBanner() {
  const container = document.getElementById('config-banner-placeholder');
  if (!container) return;

  if (!isSupabaseConfigured()) {
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
        const modal = document.getElementById('guide-modal');
        if (modal) modal.classList.add('open');
      });
    }
  } else {
    container.innerHTML = '';
  }
}
