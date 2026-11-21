/**
 * Trendz Tracker - Progressive Web App (PWA) Install Controller (js/pwaInstall.js)
 *
 * Provides:
 * 1. Native beforeinstallprompt capture and deferred prompt invocation.
 * 2. Standalone mode detection (matchMedia, navigator.standalone, search params).
 * 3. iOS / iPadOS Safari detection with accessible step-by-step instructions:
 *    "Share → Add to Home Screen → Open as Web App".
 * 4. Automatic visibility synchronization across:
 *    - Sign In page trigger (#btn-login-pwa-install / #login-pwa-install-container)
 *    - Desktop header actions (#btn-header-pwa-install)
 *    - Mobile navigation menu drawer ([data-nav-action="install-pwa"])
 * 5. Strictly avoids pop-ups on page load.
 * 6. Hides all install triggers once installed or when running in standalone mode.
 */

import { openModal, closeModal } from './modal.js';

let deferredInstallPrompt = null;
const registeredTriggers = new Set();
let isInitialized = false;

// Safari Share & Plus SVG icons for instructions
const SHARE_ICON_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
    <polyline points="16 6 12 2 8 6"></polyline>
    <line x1="12" y1="2" x2="12" y2="15"></line>
  </svg>
`;

const PLUS_SQUARE_ICON_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <line x1="12" y1="8" x2="12" y2="16"></line>
    <line x1="8" y1="12" x2="16" y2="12"></line>
  </svg>
`;

const INSTALL_ARROW_SVG = `
  <svg class="pwa-install-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
    <polyline points="7 10 12 15 17 10"></polyline>
    <line x1="12" y1="15" x2="12" y2="3"></line>
  </svg>
`;

/**
 * Checks if the application is currently running in standalone (installed) mode.
 * Strictly detects installed mode through the browser's display mode media query
 * or iOS Safari's navigator.standalone flag.
 * Does NOT treat query parameters (?source=pwa) as standalone so shared links in a regular tab remain installable.
 * @returns {boolean}
 */
export function isStandalone() {
  if (typeof window === 'undefined') return false;

  // Modern standard display-mode check (standalone or fullscreen)
  if (typeof window.matchMedia === 'function') {
    const isStandaloneDisplay = window.matchMedia('(display-mode: standalone)').matches;
    if (isStandaloneDisplay) return true;

    const isFullscreenDisplay = window.matchMedia('(display-mode: fullscreen)').matches;
    if (isFullscreenDisplay) return true;
  }

  // iOS Safari specific standalone flag
  if (typeof window.navigator !== 'undefined' && window.navigator.standalone === true) {
    return true;
  }

  return false;
}

/**
 * Detects whether the user is on an iOS or iPadOS device in Safari/WebKit.
 * @returns {boolean}
 */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent || '';
  const isIosDevice = /iphone|ipad|ipod/i.test(ua);
  const isIpadOsDesktopMode = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  return isIosDevice || isIpadOsDesktopMode;
}

/**
 * Checks if an install option should be presented to the user.
 * True when NOT standalone AND either:
 * - Chromium/Edge beforeinstallprompt event has fired
 * - Device is iOS/iPadOS (which requires manual "Add to Home Screen" instructions)
 * @returns {boolean}
 */
export function isInstallAvailable() {
  if (isStandalone()) {
    return false;
  }
  return Boolean(deferredInstallPrompt) || isIOS();
}

/**
 * Returns the currently deferred BeforeInstallPromptEvent, if any.
 */
export function getDeferredPrompt() {
  return deferredInstallPrompt;
}

/**
 * Manually sets the deferred install prompt (primarily for testing and event routing).
 * @param {Event|null} prompt
 */
export function setDeferredPrompt(prompt) {
  deferredInstallPrompt = prompt;
  updateAllInstallTriggers();
}

/**
 * Ensures the accessible iOS Safari install instructions modal is present in DOM.
 */
export function ensureIosInstallModal() {
  if (typeof document === 'undefined') return null;

  let modal = document.getElementById('ios-pwa-install-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'ios-pwa-install-modal';
  modal.className = 'modal-backdrop';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="ios-pwa-modal-title" style="max-width: 460px;">
      <div class="modal-header">
        <div>
          <h2 id="ios-pwa-modal-title" class="modal-title">Install Trendz Tracker</h2>
          <p class="modal-subtitle">Add Trendz Tracker to your iPhone or iPad for quick fullscreen practice.</p>
        </div>
        <button type="button" class="modal-close" data-close-modal="ios-pwa-install-modal" aria-label="Close dialog">
          &times;
        </button>
      </div>
      <div class="modal-body">
        <div class="ios-install-steps" style="display: grid; gap: var(--space-4); margin-bottom: var(--space-4);">
          <div class="ios-install-step" style="display: flex; gap: var(--space-3); align-items: flex-start;">
            <div class="ios-step-num" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-full); background: var(--primary-blue-subtle, #EFF6FF); color: var(--primary-blue, #2563EB); font-weight: var(--weight-bold); flex-shrink: 0;">1</div>
            <div style="flex: 1;">
              <div style="font-weight: var(--weight-semibold); color: var(--text-main); margin-bottom: 2px;">
                Tap <strong>Share</strong> in Safari
              </div>
              <div style="font-size: var(--text-sm); color: var(--text-muted); line-height: 1.4;">
                Tap the Share icon <span style="display: inline-flex; vertical-align: middle; color: var(--primary-blue);">${SHARE_ICON_SVG}</span> in Safari's bottom toolbar (or top on iPad).
              </div>
            </div>
          </div>

          <div class="ios-install-step" style="display: flex; gap: var(--space-3); align-items: flex-start;">
            <div class="ios-step-num" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-full); background: var(--primary-blue-subtle, #EFF6FF); color: var(--primary-blue, #2563EB); font-weight: var(--weight-bold); flex-shrink: 0;">2</div>
            <div style="flex: 1;">
              <div style="font-weight: var(--weight-semibold); color: var(--text-main); margin-bottom: 2px;">
                Select <strong>Add to Home Screen</strong>
              </div>
              <div style="font-size: var(--text-sm); color: var(--text-muted); line-height: 1.4;">
                Scroll down in the share sheet and tap <strong>Add to Home Screen</strong> <span style="display: inline-flex; vertical-align: middle; color: var(--text-main);">${PLUS_SQUARE_ICON_SVG}</span>.
              </div>
            </div>
          </div>

          <div class="ios-install-step" style="display: flex; gap: var(--space-3); align-items: flex-start;">
            <div class="ios-step-num" style="display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-full); background: var(--primary-blue-subtle, #EFF6FF); color: var(--primary-blue, #2563EB); font-weight: var(--weight-bold); flex-shrink: 0;">3</div>
            <div style="flex: 1;">
              <div style="font-weight: var(--weight-semibold); color: var(--text-main); margin-bottom: 2px;">
                Open as Web App
              </div>
              <div style="font-size: var(--text-sm); color: var(--text-muted); line-height: 1.4;">
                Tap <strong>Add</strong> in the top-right corner. Trendz Tracker is now ready on your home screen.
              </div>
            </div>
          </div>
        </div>

        <div class="ios-install-summary" style="padding: var(--space-3); background: var(--bg-surface-subtle, #F8FAFC); border: 1px solid var(--border-color, #E2E8F0); border-radius: var(--radius-md); font-size: var(--text-xs); color: var(--text-secondary, #475569); text-align: center; font-weight: var(--weight-medium);">
          Quick: <strong>Share</strong> &rarr; <strong>Add to Home Screen</strong> &rarr; <strong>Open as Web App</strong>
        </div>
      </div>
      <div class="modal-footer" style="justify-content: flex-end;">
        <button type="button" class="btn btn-primary" data-close-modal="ios-pwa-install-modal">Got it</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelectorAll('[data-close-modal="ios-pwa-install-modal"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal('ios-pwa-install-modal');
    });
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal('ios-pwa-install-modal');
    }
  });

  return modal;
}

/**
 * Triggers the install action:
 * - For browsers supporting beforeinstallprompt: opens native installation prompt.
 * - For iOS / iPadOS Safari: opens accessible instructions modal.
 * - Strictly avoids popups on load; only invoked on explicit user interaction.
 *
 * @returns {Promise<'accepted'|'dismissed'|'instructions'|'unavailable'>}
 */
export async function triggerPwaInstall() {
  if (isStandalone()) {
    updateAllInstallTriggers();
    return 'unavailable';
  }

  // 1. Native BeforeInstallPrompt flow (Chromium / Edge / Android)
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    // The browser's BeforeInstallPromptEvent can only be used once.
    // Clear the saved reference immediately so an expired prompt is never retried.
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choiceResult = await promptEvent.userChoice;
      const outcome = choiceResult && choiceResult.outcome === 'accepted' ? 'accepted' : 'dismissed';
      return outcome;
    } catch (err) {
      console.warn('[PWA] Prompt invocation error:', err);
      return 'dismissed';
    } finally {
      deferredInstallPrompt = null;
      updateAllInstallTriggers();
    }
  }

  // 2. iOS Safari step-by-step instructions modal
  if (isIOS()) {
    ensureIosInstallModal();
    openModal('ios-pwa-install-modal');
    return 'instructions';
  }

  return 'unavailable';
}

/**
 * Updates visibility of all registered install triggers and standard elements.
 */
export function updateAllInstallTriggers() {
  if (typeof document === 'undefined') return;

  const available = isInstallAvailable();

  // 1. Login page triggers
  const loginWrapper = document.getElementById('login-pwa-install-container');
  if (loginWrapper) {
    loginWrapper.style.display = available ? 'block' : 'none';
  }
  const loginBtn = document.getElementById('btn-login-pwa-install');
  if (loginBtn) {
    loginBtn.style.display = available ? 'inline-flex' : 'none';
    if (isIOS()) {
      loginBtn.setAttribute('title', 'Add Trendz Tracker to your Home Screen');
    }
  }

  // 2. Desktop header actions trigger
  const headerBtn = document.getElementById('btn-header-pwa-install');
  if (headerBtn) {
    headerBtn.style.display = available ? 'inline-flex' : 'none';
    if (isIOS()) {
      headerBtn.setAttribute('title', 'Add Trendz Tracker to your Home Screen');
    }
  }

  // 3. Navigation drawer menu items & container groups
  const menuItems = document.querySelectorAll('[data-nav-action="install-pwa"]');
  menuItems.forEach((el) => {
    el.style.display = available ? '' : 'none';
    if (available) {
      el.removeAttribute('hidden');
    } else {
      el.setAttribute('hidden', 'true');
    }
  });

  const pwaGroups = document.querySelectorAll('.header-nav-pwa-group');
  pwaGroups.forEach((group) => {
    group.style.display = available ? '' : 'none';
    if (available) {
      group.removeAttribute('hidden');
    } else {
      group.setAttribute('hidden', 'true');
    }
  });

  // 4. Any custom registered elements
  registeredTriggers.forEach((el) => {
    if (el && typeof el.style !== 'undefined') {
      el.style.display = available ? '' : 'none';
    }
  });
}

/**
 * Registers an arbitrary DOM element as an install trigger.
 * Clicking it invokes triggerPwaInstall().
 * @param {HTMLElement} element
 */
export function registerInstallTrigger(element) {
  if (!element) return;
  registeredTriggers.add(element);

  element.addEventListener('click', (e) => {
    e.preventDefault();
    triggerPwaInstall();
  });

  element.style.display = isInstallAvailable() ? '' : 'none';
}

/**
 * Initializes the PWA install controller:
 * - Sets up window event listeners for beforeinstallprompt, appinstalled, and display-mode.
 * - Registers the service worker (/sw.js) when supported.
 */
export function initPwaController() {
  if (typeof window === 'undefined' || isInitialized) return;
  isInitialized = true;

  // Listen for native install prompt (Chrome / Edge / Chromium / Android)
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent standard automatic mini-infobar prompt
    e.preventDefault();
    deferredInstallPrompt = e;
    updateAllInstallTriggers();
  });

  // Listen for successful installation completion
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateAllInstallTriggers();
    console.log('[PWA] Trendz Tracker installed successfully');
  });

  // Listen for standalone display mode changes
  if (typeof window.matchMedia === 'function') {
    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    standaloneMedia.addEventListener?.('change', () => {
      updateAllInstallTriggers();
    });
  }

  // Register pass-through service worker for installability
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Non-blocking warning if service worker cannot register in restricted environment
        console.warn('[PWA] Service worker registration note:', err?.message || err);
      });
    });
  }

  // Initial trigger sync
  updateAllInstallTriggers();
}

/**
 * Mounts the compact "Install Trendz Tracker" option near Sign In on the login page (index.html).
 */
export function mountLoginPwaInstall() {
  if (typeof document === 'undefined') return;

  initPwaController();

  let container = document.getElementById('login-pwa-install-container');
  if (!container) {
    const loginCard = document.querySelector('.login-card');
    const loginForm = document.getElementById('login-form');

    container = document.createElement('div');
    container.id = 'login-pwa-install-container';
    container.className = 'login-pwa-install-zone';
    container.style.display = isInstallAvailable() ? 'block' : 'none';
    container.style.marginTop = 'var(--space-4, 16px)';
    container.style.textAlign = 'center';

    container.innerHTML = `
      <button
        type="button"
        id="btn-login-pwa-install"
        class="btn btn-ghost btn-sm btn-pwa-install"
        aria-label="Install Trendz Tracker as a web app"
        style="width: 100%; display: ${isInstallAvailable() ? 'inline-flex' : 'none'}; align-items: center; justify-content: center; gap: 8px; font-size: var(--text-sm); color: var(--primary-blue, #2563EB); border: 1px dashed var(--border-color, #E2E8F0); padding: 8px 12px; border-radius: var(--radius-md, 8px);"
      >
        ${INSTALL_ARROW_SVG}
        <span>Install Trendz Tracker</span>
      </button>
    `;

    if (loginForm && loginForm.parentNode) {
      loginForm.parentNode.insertBefore(container, loginForm.nextSibling);
    } else if (loginCard) {
      loginCard.appendChild(container);
    }
  }

  const btn = document.getElementById('btn-login-pwa-install');
  if (btn) {
    btn.onclick = (e) => {
      e.preventDefault();
      triggerPwaInstall();
    };
  }

  updateAllInstallTriggers();
}
