/**
 * Trendz Tracker - Shared Universal Modal & Admin Navigation Controller (js/modal.js)
 *
 * Phase 14b Calmer UI:
 * 1. Centered, accessible modals (max-width 520px, ESC to close, backdrop click, focus return)
 * 2. Unified Admin Navigation:
 *    Overview, Students, Review, Attendance, Weekly Tests, Leaderboard, Settings,
 *    plus the right-hand Account menu (name, Account, Sign out).
 * 3. Automatic "Settings > <Page>" breadcrumb on Settings sub-pages.
 * 4. Automatic table "Compact" density toggle remembered in localStorage.
 */

import { getSettingsBreadcrumb } from './settingsHub.js';
import { initTableDensityToggle } from './tableDensity.js';
import { setupHeaderNavigation } from './headerNav.js';

const modalFocusHistory = new Map();
const activeEscapeListeners = new Map();

/**
 * Opens a modal dialog by ID
 * @param {string} modalId - The element ID of the modal backdrop / container
 */
export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) {
    console.warn(`[modal.js] Modal not found: #${modalId}`);
    return;
  }

  if (document.activeElement && typeof document.activeElement.focus === 'function') {
    modalFocusHistory.set(modalId, document.activeElement);
  }

  if (modal.style.display === 'none') {
    modal.style.display = '';
  }
  if (modal.hasAttribute('hidden')) {
    modal.hidden = false;
    modal.removeAttribute('hidden');
  }

  modal.classList.add('open', 'is-open');
  modal.setAttribute('aria-hidden', 'false');

  const focusable = modal.querySelectorAll(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([data-close-modal]):not([data-modal-close]):not(.modal-close):not(.btn-modal-close):not([disabled])'
  );
  const closeBtn = modal.querySelector(
    '[data-close-modal], [data-modal-close], .modal-close, .modal-close-btn, .btn-modal-close'
  );

  setTimeout(() => {
    if (focusable.length > 0) {
      focusable[0].focus();
    } else if (closeBtn) {
      closeBtn.focus();
    }
  }, 50);

  const escapeHandler = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeModal(modalId);
    }
  };

  if (activeEscapeListeners.has(modalId)) {
    document.removeEventListener('keydown', activeEscapeListeners.get(modalId));
  }
  activeEscapeListeners.set(modalId, escapeHandler);
  document.addEventListener('keydown', escapeHandler);
}

/**
 * Closes a modal dialog by ID
 * @param {string} modalId - The element ID of the modal backdrop / container
 */
export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.classList.remove('open', 'is-open');
  modal.setAttribute('aria-hidden', 'true');

  if (activeEscapeListeners.has(modalId)) {
    document.removeEventListener('keydown', activeEscapeListeners.get(modalId));
    activeEscapeListeners.delete(modalId);
  }

  const prevElement = modalFocusHistory.get(modalId);
  if (prevElement && typeof prevElement.focus === 'function' && document.body.contains(prevElement)) {
    setTimeout(() => prevElement.focus(), 50);
  }
  modalFocusHistory.delete(modalId);
}

/**
 * Global helper to attach click handlers for all modal close triggers and backdrops
 */
export function setupModalListeners() {
  document.querySelectorAll('[data-close-modal], [data-modal-close]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const modalId = btn.getAttribute('data-close-modal') || btn.getAttribute('data-modal-close');
      if (modalId) {
        closeModal(modalId);
      } else {
        const parentModal = btn.closest('.modal-backdrop, .modal-overlay');
        if (parentModal && parentModal.id) closeModal(parentModal.id);
      }
    };
  });

  document.querySelectorAll('.modal-close, .modal-close-btn, .btn-modal-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const modal = btn.closest('.modal-backdrop, .modal-overlay');
      if (modal && modal.id) {
        closeModal(modal.id);
      }
    };
  });

  document.querySelectorAll('.modal-backdrop, .modal-overlay').forEach((backdrop) => {
    backdrop.onclick = (e) => {
      if (e.target === backdrop) {
        closeModal(backdrop.id);
      }
    };
  });
}

/**
 * Normalizes the Admin Navigation bar (via Phase 14d single-source headerNav),
 * Settings breadcrumb, and table Compact density toggle across all admin pages.
 * Strictly requires a verified, active admin profile passed by an authorized controller.
 * Never guesses or falls back to unverified cached admin profiles from storage.
 */
export function setupAdminNav(profile = null) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  // Strictly require an authenticated, active admin profile passed directly from caller
  if (!profile || profile.role !== 'admin' || profile.active === false) {
    return;
  }

  const pathname = window.location.pathname || '';
  const breadcrumbMeta = getSettingsBreadcrumb(pathname);

  // 1. Mount Phase 14e unified header & mobile menu for admin role if not already set to admin
  const header = document.querySelector('.app-header');
  if (!document.getElementById('btn-header-nav-menu') || header?.getAttribute('data-nav-role') !== 'admin') {
    setupHeaderNavigation(profile);
  }

  // 2. Inject "Settings > <Page>" breadcrumb on Settings sub-pages if not already present
  if (breadcrumbMeta && !document.querySelector('.breadcrumb-nav')) {
    const mainContainer =
      document.querySelector('.main-content .container') ||
      document.querySelector('.page-main .container') ||
      document.querySelector('main .container');
    const pageHeader = mainContainer?.querySelector('.page-header');
    if (mainContainer) {
      const nav = document.createElement('nav');
      nav.className = 'breadcrumb-nav';
      nav.setAttribute('aria-label', 'Breadcrumb');
      nav.innerHTML = `
        <a href="/pages/settings.html">Settings</a>
        <span class="breadcrumb-sep" aria-hidden="true">&gt;</span>
        <span class="breadcrumb-current" aria-current="page">${
          breadcrumbMeta.breadcrumbTitle || breadcrumbMeta.title
        }</span>
      `;
      if (pageHeader) {
        mainContainer.insertBefore(nav, pageHeader);
      } else {
        mainContainer.insertBefore(nav, mainContainer.firstChild);
      }
    }
  }

  // 3. Initialize Compact table density toggle on admin tables
  initTableDensityToggle();
}
