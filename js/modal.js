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

const modalFocusHistory = new Map();
const activeEscapeListeners = new Map();

const ADMIN_NAV_ITEMS = Object.freeze([
  { label: 'Overview', href: '/pages/admin.html' },
  { label: 'Students', href: '/pages/students.html' },
  { label: 'Review', href: '/pages/review.html' },
  { label: 'Attendance', href: '/pages/attendance.html' },
  { label: 'Weekly Tests', href: '/pages/weekly-tests.html' },
  { label: 'Leaderboard', href: '/pages/leaderboard.html' },
  { label: 'Settings', href: '/pages/settings.html' },
]);

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
 * Normalizes the Admin Navigation bar, Account dropdown menu, Settings breadcrumb,
 * and table Compact density toggle across all admin pages.
 */
export function setupAdminNav() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const pathname = window.location.pathname || '';
  const breadcrumbMeta = getSettingsBreadcrumb(pathname);
  const isSettingsSection = pathname.endsWith('/settings.html') || Boolean(breadcrumbMeta);
  const isStudentDetail = pathname.endsWith('/student-detail.html');

  // 1. Standardize Admin Nav Links: Overview, Students, Review, Attendance, Weekly Tests, Leaderboard, Settings
  const navZone = document.querySelector('.app-header .nav-zone');
  if (navZone) {
    navZone.innerHTML = ADMIN_NAV_ITEMS.map((item) => {
      let isActive = pathname.endsWith(item.href);
      if (item.href === '/pages/settings.html' && isSettingsSection) {
        isActive = true;
      }
      if (item.href === '/pages/students.html' && isStudentDetail) {
        isActive = true;
      }
      return `<a href="${item.href}" class="nav-link${isActive ? ' active' : ''}"${
        isActive ? ' aria-current="page"' : ''
      }>${item.label}</a>`;
    }).join('');
  }

  // 2. Build the Account menu (name, Account, Sign out) in .actions-zone while preserving #header-user-name & #btn-header-logout
  const actionsZone = document.querySelector('.app-header .actions-zone');
  if (actionsZone && !actionsZone.querySelector('.account-dropdown')) {
    const existingNameEl = document.getElementById('header-user-name');
    const existingRoleEl = document.getElementById('header-user-role');
    const existingPill = document.getElementById('user-pill-container');
    const existingLogoutBtn = document.getElementById('btn-header-logout');

    const currentName = existingNameEl?.textContent?.trim() || 'Admin';

    // Hide the old standalone pill container and logout button visually, keeping them in DOM for legacy scripts
    if (existingPill) {
      existingPill.style.display = 'none';
      existingPill.setAttribute('aria-hidden', 'true');
    }

    const accountDropdown = document.createElement('div');
    accountDropdown.className = 'account-dropdown';
    accountDropdown.innerHTML = `
      <button
        type="button"
        class="account-dropdown-btn"
        id="btn-account-menu"
        aria-haspopup="true"
        aria-expanded="false"
      >
        <span id="account-menu-user-name">${currentName}</span>
        <span aria-hidden="true" style="font-size: 12px; color: var(--text-dim);">&#9662;</span>
      </button>
      <div class="account-dropdown-menu" id="account-dropdown-menu" role="menu">
        <a href="/pages/settings.html" class="account-dropdown-item" role="menuitem">
          <span>Account</span>
          <span class="badge badge-neutral" style="font-size: 12px;">Admin</span>
        </a>
        <button type="button" class="account-dropdown-item" id="btn-account-signout" role="menuitem">
          <span>Sign out</span>
        </button>
      </div>
    `;

    actionsZone.appendChild(accountDropdown);

    // Sync any subsequent changes to #header-user-name into #account-menu-user-name
    if (existingNameEl && typeof MutationObserver !== 'undefined') {
      const labelEl = document.getElementById('account-menu-user-name');
      const syncName = () => {
        const txt = existingNameEl.textContent?.trim();
        if (txt && labelEl) labelEl.textContent = txt;
      };
      syncName();
      const obs = new MutationObserver(syncName);
      obs.observe(existingNameEl, { childList: true, characterData: true, subtree: true });
    }
    if (existingRoleEl) {
      existingRoleEl.classList.remove('badge-role');
      existingRoleEl.classList.add('badge-neutral');
    }

    // Wire Sign out inside Account menu to existing #btn-header-logout or logoutUser()
    if (existingLogoutBtn) {
      existingLogoutBtn.style.display = 'none';
    }
    const signOutMenuBtn = document.getElementById('btn-account-signout');
    signOutMenuBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (existingLogoutBtn) {
        existingLogoutBtn.click();
      } else {
        const { logoutUser } = await import('./auth.js');
        await logoutUser();
      }
    });

    const menuBtn = document.getElementById('btn-account-menu');
    const menuPanel = document.getElementById('account-dropdown-menu');
    menuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = accountDropdown.classList.toggle('open');
      menuPanel?.classList.toggle('open', isOpen);
      menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    document.addEventListener('click', (e) => {
      if (!accountDropdown.contains(e.target)) {
        accountDropdown.classList.remove('open');
        menuPanel?.classList.remove('open');
        menuBtn?.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        accountDropdown.classList.remove('open');
        menuPanel?.classList.remove('open');
        menuBtn?.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 3. Inject "Settings > <Page>" breadcrumb on Settings sub-pages if not already present
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

  // 4. Mobile Hamburger Toggle
  const hamburgerBtn =
    document.getElementById('btn-nav-hamburger') || document.getElementById('btn-mobile-menu');
  if (hamburgerBtn && navZone) {
    hamburgerBtn.onclick = (e) => {
      e.stopPropagation();
      navZone.classList.toggle('mobile-open');
      navZone.classList.toggle('open');
      const isOpen =
        navZone.classList.contains('mobile-open') || navZone.classList.contains('open');
      hamburgerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    navZone.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        navZone.classList.remove('mobile-open');
        navZone.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // 5. Initialize Compact table density toggle on admin tables
  initTableDensityToggle();
}
