/**
 * Trendz Tracker - Shared Universal Modal & Navigation Controller (js/modal.js)
 * 
 * Provides:
 * 1. Centered, accessible modals (ESC to close, backdrop click, focus trap/return)
 * 2. Setup dropdown menu & mobile hamburger for Admin Navigation
 */

// Track the element that triggered the modal for focus restoration
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

  // Save current focus for restoration
  if (document.activeElement && typeof document.activeElement.focus === 'function') {
    modalFocusHistory.set(modalId, document.activeElement);
  }

  // Remove inline display none or hidden attribute if present
  if (modal.style.display === 'none') {
    modal.style.display = '';
  }
  if (modal.hasAttribute('hidden')) {
    modal.hidden = false;
    modal.removeAttribute('hidden');
  }

  modal.classList.add('open', 'is-open');
  modal.setAttribute('aria-hidden', 'false');

  // Move focus into the modal (first interactive input or button)
  const focusable = modal.querySelectorAll('input:not([type="hidden"]), select, textarea, button:not([data-close-modal]):not([data-modal-close]):not(.modal-close):not(.btn-modal-close)');
  const closeBtn = modal.querySelector('[data-close-modal], [data-modal-close], .modal-close, .modal-close-btn, .btn-modal-close');
  
  setTimeout(() => {
    if (focusable.length > 0) {
      focusable[0].focus();
    } else if (closeBtn) {
      closeBtn.focus();
    }
  }, 50);

  // Bind Escape key listener
  const escapeHandler = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeModal(modalId);
    }
  };

  // Remove existing if any, then attach
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

  // Clean up escape listener
  if (activeEscapeListeners.has(modalId)) {
    document.removeEventListener('keydown', activeEscapeListeners.get(modalId));
    activeEscapeListeners.delete(modalId);
  }

  // Return focus to previous element
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
  // Explicit close buttons with data-close-modal="modal-id" or data-modal-close="modal-id"
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

  // Generic close buttons inside modals
  document.querySelectorAll('.modal-close, .modal-close-btn, .btn-modal-close').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const modal = btn.closest('.modal-backdrop, .modal-overlay');
      if (modal && modal.id) {
        closeModal(modal.id);
      }
    };
  });

  // Backdrop click to dismiss (when clicking directly on the overlay, outside the dialog)
  document.querySelectorAll('.modal-backdrop, .modal-overlay').forEach((backdrop) => {
    backdrop.onclick = (e) => {
      if (e.target === backdrop) {
        closeModal(backdrop.id);
      }
    };
  });
}

/**
 * Sets up the Admin Navigation Setup Dropdown and Mobile Hamburger
 */
export function setupAdminNav() {
  // 1. Setup Dropdown Trigger
  const setupDropdown = document.getElementById('nav-setup-dropdown') || document.querySelector('.nav-dropdown');
  const setupBtn = document.getElementById('btn-nav-setup') || document.getElementById('btn-setup-dropdown');
  const setupMenu = document.getElementById('setup-dropdown-menu') || setupDropdown?.querySelector('.nav-dropdown-menu');

  if (setupMenu && !setupMenu.querySelector('a[href="/pages/announcements.html"]')) {
    const annLink = document.createElement('a');
    annLink.href = '/pages/announcements.html';
    const existingItem = setupMenu.querySelector('.dropdown-item, .nav-dropdown-item');
    annLink.className = existingItem ? existingItem.className.replace(/\bactive\b/g, '').trim() : 'dropdown-item';
    annLink.setAttribute('role', 'menuitem');
    annLink.textContent = 'Announcements';
    if (window.location.pathname.endsWith('/announcements.html')) {
      annLink.classList.add('active');
    }
    setupMenu.insertBefore(annLink, setupMenu.firstChild);
  }

  if (setupDropdown && setupBtn) {
    // Auto-highlight Setup parent if any dropdown item is active
    if (setupDropdown.querySelector('.nav-dropdown-item.active, .dropdown-item.active')) {
      setupBtn.classList.add('active');
      setupDropdown.classList.add('active');
    }

    setupBtn.onclick = (e) => {
      e.stopPropagation();
      const isOpen = setupDropdown.classList.toggle('open');
      if (setupMenu) setupMenu.classList.toggle('open', isOpen);
      setupBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    // Close when clicking outside
    document.addEventListener('click', (e) => {
      if (!setupDropdown.contains(e.target)) {
        setupDropdown.classList.remove('open');
        if (setupMenu) setupMenu.classList.remove('open');
        setupBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        setupDropdown.classList.remove('open');
        if (setupMenu) setupMenu.classList.remove('open');
        setupBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 2. Mobile Hamburger Toggle
  const hamburgerBtn = document.getElementById('btn-nav-hamburger') || document.getElementById('btn-mobile-menu');
  const navZone = document.querySelector('.nav-zone');

  if (hamburgerBtn && navZone) {
    hamburgerBtn.onclick = (e) => {
      e.stopPropagation();
      navZone.classList.toggle('mobile-open');
      navZone.classList.toggle('open');
      const isOpen = navZone.classList.contains('mobile-open') || navZone.classList.contains('open');
      hamburgerBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    // Close mobile nav when clicking a link
    navZone.querySelectorAll('.nav-link:not(.nav-dropdown-toggle), .nav-dropdown-item, .dropdown-item').forEach(link => {
      link.addEventListener('click', () => {
        navZone.classList.remove('mobile-open');
        navZone.classList.remove('open');
        hamburgerBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }
}
