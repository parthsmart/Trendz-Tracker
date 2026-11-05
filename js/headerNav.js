/**
 * Trendz Tracker - Unified Header Navigation Controller (js/headerNav.js)
 *
 * Phase 14d & 14e:
 * - Single breakpoint: `NAV_MOBILE_BREAKPOINT_PX = 1024` (matching `--nav-mobile-breakpoint: 1024px`).
 * - Desktop (`width >= 1024px`):
 *     Renders the full inline navigation bar and dropdowns (`Practice ▾` for students,
 *     `Setup ▾` for admins, plus the notifications bell with count badge for students)
 *     from `js/navConfig.js`. The three-dot menu button and drawer are hidden (`display: none`
 *     and `hidden = true`) so they take no space and cannot receive keyboard focus.
 * - Mobile (`width < 1024px`):
 *     Hides the desktop inline links and dropdowns (`display: none` and `hidden = true`) and
 *     displays `[logo] [Trendz Tracker] [44x44 three-dot menu button]` on the left and
 *     `[name] [Sign out]` on the right. Opens an anchored panel (`701-1023px`) or a left
 *     slide-in drawer with dimmed backdrop (`<= 700px`).
 * - Uses `window.matchMedia('(min-width: 1024px)')` so rotating or resizing switches live
 *   without reloading and closes any open menu or dropdown on layout switch.
 * - Excludes full-screen practice/test stages (`body.stage-focus-mode`) so those keep only
 *   their own exit button.
 */

import {
  NAV_MOBILE_BREAKPOINT_PX,
  getGroupedNavItems,
  getDesktopNavEntries,
  isNavItemCurrent,
  formatShortFirstName,
} from './navConfig.js';
import {
  createMenuState,
  openMenuState,
  closeMenuState,
  moveFocusIndex,
  trapTabFocusIndex,
  isDedicatedStagePathname,
} from './navMenuState.js';
import { openModal, closeModal } from './modal.js';
import { attachLinkPrefetchListeners } from './perf.js';

const BRAND_LOGO_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="4" y="2" width="16" height="20" rx="2"></rect>
    <line x1="8" y1="6" x2="16" y2="6"></line>
    <line x1="16" y1="14" x2="16" y2="18"></line>
    <path d="M16 10h.01"></path>
    <path d="M12 10h.01"></path>
    <path d="M8 10h.01"></path>
    <path d="M12 14h.01"></path>
    <path d="M8 14h.01"></path>
    <path d="M12 18h.01"></path>
    <path d="M8 18h.01"></path>
  </svg>
`;

const THREE_DOT_SVG = `
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="5" r="2"></circle>
    <circle cx="12" cy="12" r="2"></circle>
    <circle cx="12" cy="19" r="2"></circle>
  </svg>
`;

const CHECK_ICON_SVG = `
  <svg class="header-nav-check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
`;

const BELL_ICON_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
  </svg>
`;

let activeMenuController = null;
let activeDesktopDropdownController = null;
let lastUnreadBadgeState = { count: 0, text: '' };

/**
 * Checks if any in-page full-screen practice/test stage is currently active.
 * Covers:
 * - Dedicated stage pages (basics-practice.html, element-drill.html, memoriad-play.html)
 * - Flash Anzan active play screen (#flash-play-screen)
 * - Weekly Test active section player (#screen-player)
 * - Elements active worksheet (#drill-worksheet-screen)
 * - Memoriad stage mode (body.memoriad-stage-mode)
 */
export function isFullScreenStageActive() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  const pathname = window.location.pathname || '';
  if (isDedicatedStagePathname(pathname)) {
    return true;
  }

  if (document.body.classList.contains('memoriad-stage-mode')) {
    return true;
  }

  const stageSelectors = ['#flash-play-screen', '#drill-worksheet-screen', '#screen-player'];
  for (const selector of stageSelectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (el.hasAttribute('hidden')) continue;
    const inlineDisplay = el.style?.display;
    if (inlineDisplay && inlineDisplay !== 'none') {
      return true;
    }
    if (!inlineDisplay && typeof window.getComputedStyle === 'function') {
      const computed = window.getComputedStyle(el);
      if (computed && computed.display !== 'none' && computed.visibility !== 'hidden') {
        return true;
      }
    }
  }

  return false;
}

/**
 * Updates the unread notification dot on the mobile three-dot menu button,
 * the desktop bell badge (`#nav-notifications-badge`), and the mobile menu badge.
 *
 * @param {number} count
 * @param {string} formattedText
 */
export function syncHeaderMenuNotificationBadge(count, formattedText) {
  lastUnreadBadgeState = {
    count: Number(count) || 0,
    text: String(formattedText || ''),
  };

  if (typeof document === 'undefined') return;

  const hasUnread = lastUnreadBadgeState.count > 0 && Boolean(lastUnreadBadgeState.text);
  const dotEl = document.getElementById('header-menu-unread-dot');
  if (dotEl) {
    if (hasUnread) {
      dotEl.hidden = false;
      dotEl.removeAttribute('hidden');
      dotEl.style.display = 'block';
    } else {
      dotEl.hidden = true;
      dotEl.setAttribute('hidden', '');
      dotEl.style.display = 'none';
    }
  }

  const allBadges = document.querySelectorAll('#nav-notifications-badge, .nav-notifications-badge, .header-menu-notif-badge');
  allBadges.forEach((badge) => {
    if (hasUnread) {
      badge.textContent = lastUnreadBadgeState.text;
      badge.style.display = 'inline-flex';
      badge.removeAttribute('aria-hidden');
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
      badge.setAttribute('aria-hidden', 'true');
    }
  });
}

/**
 * Ensures the lightweight Account modal exists so selecting "Account" from the menu
 * works consistently on every student and admin page.
 *
 * @param {{ full_name?: string, role?: string, student_code?: string, level?: string } | null} profile
 */
function openHeaderAccountModal(profile) {
  if (typeof document === 'undefined') return;

  let modal = document.getElementById('header-account-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'header-account-modal';
    modal.className = 'modal-backdrop';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="header-account-modal-title">
        <div class="modal-header">
          <div>
            <h2 id="header-account-modal-title" class="modal-title">Account</h2>
            <p class="modal-subtitle">Signed-in profile details for this session.</p>
          </div>
          <button type="button" class="modal-close" data-close-modal="header-account-modal" aria-label="Close">
            &times;
          </button>
        </div>
        <div class="modal-body">
          <div style="display: grid; gap: var(--space-3);">
            <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-3); background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
              <span style="font-size: var(--text-sm); color: var(--text-muted);">Name</span>
              <strong id="account-modal-name" style="font-size: var(--text-base); color: var(--text-main);">—</strong>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-3); background: var(--bg-surface-subtle); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
              <span style="font-size: var(--text-sm); color: var(--text-muted);">ID / Role</span>
              <span id="account-modal-code" class="badge badge-neutral num">—</span>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-close-modal="header-account-modal">Close</button>
          <button type="button" class="btn btn-danger" id="btn-account-modal-signout">Sign out</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-close-modal="header-account-modal"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal('header-account-modal');
      });
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal('header-account-modal');
      }
    });

    const signOutBtn = modal.querySelector('#btn-account-modal-signout');
    signOutBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal('header-account-modal');
      const headerLogoutBtn = document.getElementById('btn-header-logout');
      if (headerLogoutBtn) {
        headerLogoutBtn.click();
      }
    });
  }

  const nameEl = modal.querySelector('#account-modal-name');
  const codeEl = modal.querySelector('#account-modal-code');
  const headerName = document.getElementById('header-user-name')?.textContent?.trim();
  const headerCode = document.getElementById('header-user-code')?.textContent?.trim();

  if (nameEl) {
    nameEl.textContent = profile?.full_name || headerName || 'User';
  }
  if (codeEl) {
    if (profile?.role === 'admin') {
      codeEl.textContent = profile?.student_code
        ? `${profile.student_code} · Teacher / Admin`
        : 'Teacher / Admin';
    } else {
      const code = profile?.student_code || headerCode || 'Student';
      const level = profile?.level ? ` · ${profile.level}` : '';
      codeEl.textContent = `${code}${level}`;
    }
  }

  openModal('header-account-modal');
}

/**
 * Mounts and wires the Phase 14e desktop inline navigation (>= 1024px) and
 * mobile three-dot menu (< 1024px) for the given role/profile.
 * Safe to call multiple times (idempotent).
 *
 * @param {{ id?: string, full_name?: string, role?: 'student' | 'admin', student_code?: string, level?: string } | null} [profile]
 */
export function setupHeaderNavigation(profile = null) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const header = document.querySelector('.app-header');
  if (!header) return;

  const pathname = window.location.pathname || '';

  // Determine role strictly from verified profile. Never infer 'admin' from page URL or markup.
  const resolvedRole = profile?.role;
  if (!resolvedRole || (resolvedRole !== 'admin' && resolvedRole !== 'student')) {
    // Unverified/unauthenticated state: ensure privileged content/actions remain hidden
    header.removeAttribute('data-nav-role');
    const existingNav = header.querySelector('#header-nav-zone') || header.querySelector('.nav-zone');
    if (existingNav) existingNav.innerHTML = '';
    const mobileMenuBtn = document.getElementById('btn-header-nav-menu');
    if (mobileMenuBtn) mobileMenuBtn.remove();
    return;
  }

  header.setAttribute('data-nav-role', resolvedRole);

  // Set up stage visibility guard (hides header and closes menu on full-screen stages)
  const syncStageFocusMode = () => {
    const inStage = isFullScreenStageActive();
    if (document.body.classList.contains('stage-focus-mode') !== inStage) {
      document.body.classList.toggle('stage-focus-mode', inStage);
    }
    if (inStage) {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
      if (activeDesktopDropdownController) {
        activeDesktopDropdownController.closeAll({ returnFocus: false });
      }
    }
  };

  syncStageFocusMode();

  // If this is a dedicated stage page, keep header hidden and skip mounting the menu
  if (isDedicatedStagePathname(pathname)) {
    return;
  }

  const headerInner = header.querySelector('.header-inner');
  if (!headerInner) return;

  // 1. Remove any legacy mobile hamburger buttons or duplicate account dropdowns
  headerInner
    .querySelectorAll('.mobile-menu-btn, .nav-hamburger-btn, #btn-mobile-menu, #btn-nav-hamburger, .account-dropdown')
    .forEach((el) => el.remove());

  // 2. Ensure Brand + Three-Dot Menu cluster on the left: [logo] [Trendz Tracker] [mobile menu button]
  let brandCluster = headerInner.querySelector('.header-brand-cluster');
  const existingBrandZone = headerInner.querySelector('.brand-zone');

  if (!brandCluster) {
    brandCluster = document.createElement('div');
    brandCluster.className = 'header-brand-cluster';
    headerInner.insertBefore(brandCluster, headerInner.firstChild);
    if (existingBrandZone) {
      brandCluster.appendChild(existingBrandZone);
    }
  }

  const brandZone = brandCluster.querySelector('.brand-zone');
  if (brandZone) {
    brandZone.href = resolvedRole === 'admin' ? '/pages/admin.html' : '/pages/student.html';
    brandZone.innerHTML = `
      <span class="brand-icon" aria-hidden="true">${BRAND_LOGO_SVG}</span>
      <span class="brand-title">Trendz Tracker</span>
    `;
  }

  // Create or update the mobile three-dot menu anchor & button right beside Trendz Tracker
  let menuAnchor = brandCluster.querySelector('.header-menu-anchor');
  if (!menuAnchor) {
    menuAnchor = document.createElement('div');
    menuAnchor.className = 'header-menu-anchor';
    brandCluster.appendChild(menuAnchor);
  }

  // Remove any legacy body-level backdrop so the backdrop and drawer share the same stacking context
  const staleBodyBackdrop = document.body.querySelector(':scope > #header-nav-backdrop');
  if (staleBodyBackdrop) {
    staleBodyBackdrop.remove();
  }

  // Render Mobile Menu Button + Menu Panel/Drawer from single NAV_CONFIG
  const groups = getGroupedNavItems(resolvedRole);
  const groupsHtml = groups
    .map((groupEntry) => {
      const itemsHtml = groupEntry.items
        .map((item) => {
          const isCurrent = isNavItemCurrent(item, pathname);
          const badgeHtml =
            item.badge === 'notifications'
              ? `<span class="nav-notifications-badge header-menu-notif-badge num" style="display: none;" aria-hidden="true"></span>`
              : '';
          const currentIndicatorHtml = isCurrent
            ? `<span class="header-nav-current-indicator">${CHECK_ICON_SVG}<span class="header-nav-current-text">Current</span></span>`
            : '';

          return `
            <a
              href="${item.href}"
              class="header-nav-item${isCurrent ? ' is-current' : ''}${item.isHub ? ' is-hub' : ''}"
              data-nav-id="${item.id}"
              ${item.action ? `data-nav-action="${item.action}"` : ''}
              ${isCurrent ? 'aria-current="page"' : ''}
            >
              <span class="header-nav-item-label">${item.label}</span>
              <span class="header-nav-item-meta">
                ${badgeHtml}
                ${currentIndicatorHtml}
              </span>
            </a>
          `;
        })
        .join('');

      return `
        <div class="header-nav-group" role="group" aria-label="${groupEntry.group}">
          <div class="header-nav-group-title">${groupEntry.group}</div>
          <div class="header-nav-group-list">
            ${itemsHtml}
          </div>
        </div>
      `;
    })
    .join('');

  menuAnchor.innerHTML = `
    <button
      type="button"
      id="btn-header-nav-menu"
      class="header-menu-btn"
      aria-label="Menu"
      aria-haspopup="true"
      aria-expanded="false"
      aria-controls="header-nav-menu"
    >
      ${THREE_DOT_SVG}
      <span id="header-menu-unread-dot" class="header-menu-unread-dot" hidden aria-hidden="true"></span>
    </button>
    <div id="header-nav-backdrop" class="header-nav-backdrop" hidden aria-hidden="true"></div>
    <nav
      id="header-nav-menu"
      class="header-nav-menu"
      aria-label="${resolvedRole === 'admin' ? 'Admin menu' : 'Student menu'}"
      hidden
    >
      <div class="header-nav-drawer-top">
        <span class="header-nav-drawer-heading">Trendz Tracker</span>
        <button type="button" class="header-nav-drawer-close" id="btn-header-nav-close" aria-label="Close menu">
          &times;
        </button>
      </div>
      <div class="header-nav-groups">
        ${groupsHtml}
      </div>
    </nav>
  `;

  // 3. Render the Desktop inline navigation bar & dropdowns (>= 1024px) from single NAV_CONFIG
  const allNavZones = Array.from(headerInner.querySelectorAll('.nav-zone'));
  let navZone = allNavZones[0] || null;
  for (let i = 1; i < allNavZones.length; i += 1) {
    allNavZones[i].remove();
  }

  if (!navZone) {
    navZone = document.createElement('nav');
    navZone.className = 'nav-zone';
    const actionsZone = headerInner.querySelector('.actions-zone');
    if (actionsZone) {
      headerInner.insertBefore(navZone, actionsZone);
    } else {
      headerInner.appendChild(navZone);
    }
  }

  navZone.removeAttribute('style');
  navZone.className = 'nav-zone header-inline-nav';
  navZone.id = resolvedRole === 'admin' ? 'admin-nav-zone' : 'student-nav-zone';
  navZone.setAttribute(
    'aria-label',
    resolvedRole === 'admin' ? 'Admin Primary Navigation' : 'Student Primary Navigation'
  );

  const desktopEntries = getDesktopNavEntries(resolvedRole);
  navZone.innerHTML = desktopEntries
    .map((entry) => {
      if (entry.type === 'link') {
        const item = entry.item;
        const isCurrent = isNavItemCurrent(item, pathname);
        return `<a href="${item.href}" class="nav-link${isCurrent ? ' active' : ''}"${
          isCurrent ? ' aria-current="page"' : ''
        }>${item.label}</a>`;
      }

      if (entry.type === 'dropdown') {
        const hasActiveChild = entry.items.some((child) => isNavItemCurrent(child, pathname));
        const dropdownLinksHtml = entry.items
          .map((child) => {
            const isChildCurrent = isNavItemCurrent(child, pathname);
            return `<a href="${child.href}" class="dropdown-item${isChildCurrent ? ' active' : ''}" role="menuitem"${
              isChildCurrent ? ' aria-current="page"' : ''
            }>${child.label}</a>`;
          })
          .join('');

        return `
          <div class="nav-dropdown" id="${entry.id}">
            <button
              type="button"
              id="${entry.toggleId}"
              class="nav-link nav-dropdown-toggle${hasActiveChild ? ' active' : ''}"
              aria-expanded="false"
              aria-haspopup="true"
              aria-controls="${entry.menuId}"
            >
              ${entry.label} <span class="nav-dropdown-caret" aria-hidden="true">&#9662;</span>
            </button>
            <div id="${entry.menuId}" class="nav-dropdown-menu" role="menu" aria-label="${entry.label} pages">
              ${dropdownLinksHtml}
            </div>
          </div>
        `;
      }

      if (entry.type === 'bell') {
        const item = entry.item;
        const isCurrent = isNavItemCurrent(item, pathname);
        return `
          <a
            href="${item.href}"
            class="nav-link nav-bell-link${isCurrent ? ' active' : ''}"
            title="${item.label}"
            aria-label="${item.label}"
            ${isCurrent ? 'aria-current="page"' : ''}
          >
            <span class="nav-bell-icon-wrap">
              ${BELL_ICON_SVG}
              <span id="nav-notifications-badge" class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span>
            </span>
          </a>
        `;
      }

      return '';
    })
    .join('');

  // Re-apply cached unread notification badge state to newly rendered DOM elements
  syncHeaderMenuNotificationBadge(lastUnreadBadgeState.count, lastUnreadBadgeState.text);

  // 4. Right-hand user details (Name, ID, and Sign out)
  const actionsZone = headerInner.querySelector('.actions-zone');
  if (actionsZone) {
    let pillContainer = actionsZone.querySelector('#user-pill-container');
    if (!pillContainer) {
      pillContainer = document.createElement('div');
      pillContainer.id = 'user-pill-container';
      pillContainer.className = 'meta-row header-user-pill';
      actionsZone.insertBefore(pillContainer, actionsZone.firstChild);
    } else {
      pillContainer.classList.add('header-user-pill');
      pillContainer.style.display = 'inline-flex';
      pillContainer.removeAttribute('aria-hidden');
    }

    let nameEl = document.getElementById('header-user-name');
    if (!nameEl) {
      nameEl = document.createElement('span');
      nameEl.id = 'header-user-name';
      pillContainer.appendChild(nameEl);
    }
    nameEl.className = 'header-user-name';

    const fullName =
      profile?.full_name || nameEl.textContent?.trim() || (resolvedRole === 'admin' ? 'Admin' : 'Student');
    const shortName = formatShortFirstName(fullName, resolvedRole === 'admin' ? 'Admin' : 'Student');
    nameEl.textContent = fullName;
    nameEl.setAttribute('data-short-name', shortName);
    nameEl.title = fullName;

    // Ensure ID / role element is visible beside the name
    let codeEl = document.getElementById('header-user-code');
    const roleEl = document.getElementById('header-user-role');
    if (!codeEl && roleEl) {
      codeEl = roleEl;
    }
    if (codeEl) {
      codeEl.classList.add('header-user-id', 'num');
      if (profile?.student_code) {
        codeEl.textContent = profile.student_code;
      } else if (resolvedRole === 'admin') {
        codeEl.textContent = 'Admin';
      }
    }

    const logoutBtn = document.getElementById('btn-header-logout');
    if (logoutBtn) {
      logoutBtn.style.display = '';
      logoutBtn.textContent = 'Sign out';
      logoutBtn.classList.add('header-signout-btn');
    }
  }

  // 5. Wire desktop dropdowns (Practice ▾ and Setup ▾)
  const safeFocus = (el) => {
    if (!el || typeof el.focus !== 'function') return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        // Ignore focus errors on mobile browsers
      }
    }
  };

  const dropdownElements = Array.from(navZone.querySelectorAll('.nav-dropdown'));
  const closeDesktopDropdown = (dropdownEl, { returnFocus = false } = {}) => {
    if (!dropdownEl) return;
    const toggleBtn = dropdownEl.querySelector('.nav-dropdown-toggle');
    dropdownEl.classList.remove('is-open');
    toggleBtn?.setAttribute('aria-expanded', 'false');
    if (returnFocus && toggleBtn) {
      safeFocus(toggleBtn);
    }
  };

  const closeAllDesktopDropdowns = ({ except = null, returnFocus = false } = {}) => {
    dropdownElements.forEach((dd) => {
      if (dd !== except && dd.classList.contains('is-open')) {
        closeDesktopDropdown(dd, { returnFocus });
      }
    });
  };

  activeDesktopDropdownController = {
    closeAll: closeAllDesktopDropdowns,
  };

  dropdownElements.forEach((dropdownEl) => {
    const toggleBtn = dropdownEl.querySelector('.nav-dropdown-toggle');
    const items = Array.from(dropdownEl.querySelectorAll('.dropdown-item'));
    if (!toggleBtn) return;

    const openThisDropdown = ({ focusFirst = false } = {}) => {
      closeAllDesktopDropdowns({ except: dropdownEl });
      dropdownEl.classList.add('is-open');
      toggleBtn.setAttribute('aria-expanded', 'true');
      if (focusFirst && items.length > 0) {
        safeFocus(items[0]);
      }
    };

    toggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dropdownEl.classList.contains('is-open')) {
        closeDesktopDropdown(dropdownEl, { returnFocus: true });
      } else {
        openThisDropdown({ focusFirst: false });
      }
    });

    toggleBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        openThisDropdown({ focusFirst: true });
      } else if (e.key === 'Escape' && dropdownEl.classList.contains('is-open')) {
        e.preventDefault();
        closeDesktopDropdown(dropdownEl, { returnFocus: true });
      }
    });

    dropdownEl.addEventListener('keydown', (e) => {
      if (!dropdownEl.classList.contains('is-open')) return;
      const currentIdx = items.indexOf(document.activeElement);

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeDesktopDropdown(dropdownEl, { returnFocus: true });
      } else if (e.key === 'ArrowDown' && items.length > 0) {
        e.preventDefault();
        const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % items.length;
        safeFocus(items[nextIdx]);
      } else if (e.key === 'ArrowUp' && items.length > 0) {
        e.preventDefault();
        const prevIdx = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
        safeFocus(items[prevIdx]);
      }
    });

    items.forEach((linkEl) => {
      linkEl.addEventListener('click', () => {
        closeDesktopDropdown(dropdownEl, { returnFocus: false });
      });
    });
  });

  // 6. Wire mobile three-dot menu state, focus management, keyboard navigation, and outside/backdrop close
  const menuBtn = document.getElementById('btn-header-nav-menu');
  const menuEl = document.getElementById('header-nav-menu');
  const backdropEl = document.getElementById('header-nav-backdrop');
  const closeDrawerBtn = document.getElementById('btn-header-nav-close');
  const menuItems = Array.from(menuEl.querySelectorAll('.header-nav-item'));

  let state = createMenuState(menuItems.length);

  const focusItemAt = (index) => {
    if (index >= 0 && index < menuItems.length) {
      safeFocus(menuItems[index]);
    }
  };

  const renderMenuState = () => {
    const isOpen = state.isOpen;
    menuBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    menuEl.hidden = !isOpen;
    menuEl.classList.toggle('is-open', isOpen);

    if (backdropEl) {
      backdropEl.hidden = !isOpen;
      backdropEl.classList.toggle('is-open', isOpen);
    }

    if (document.body.classList.contains('nav-menu-open') !== isOpen) {
      document.body.classList.toggle('nav-menu-open', isOpen);
    }

    if (isOpen && state.focusedIndex >= 0) {
      focusItemAt(state.focusedIndex);
    } else if (!isOpen && state.returnFocusToButton) {
      safeFocus(menuBtn);
    }
  };

  const openMenu = () => {
    if (isFullScreenStageActive()) return;
    state = openMenuState(state, menuItems.length);
    renderMenuState();
  };

  const closeMenu = ({ returnFocus = true } = {}) => {
    if (!state.isOpen) return;
    state = closeMenuState(state, { returnFocus });
    renderMenuState();
  };

  activeMenuController = {
    isOpen: () => state.isOpen,
    open: openMenu,
    close: closeMenu,
  };

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.isOpen) {
      closeMenu({ returnFocus: true });
    } else {
      openMenu();
    }
  });

  closeDrawerBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu({ returnFocus: true });
  });

  if (backdropEl) {
    backdropEl.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ returnFocus: true });
    };
  }

  // Menu item click handling (links, Account, Sign out)
  menuItems.forEach((itemEl, idx) => {
    itemEl.addEventListener('focus', () => {
      if (state.isOpen) {
        state = Object.freeze({ ...state, focusedIndex: idx, returnFocusToButton: false });
      }
    });

    itemEl.addEventListener('click', async (e) => {
      const action = itemEl.getAttribute('data-nav-action');
      if (action === 'signout') {
        e.preventDefault();
        closeMenu({ returnFocus: false });
        const logoutBtn = document.getElementById('btn-header-logout');
        if (logoutBtn) {
          logoutBtn.click();
        } else {
          const { logoutUser } = await import('./auth.js');
          await logoutUser();
        }
        return;
      }

      if (action === 'account') {
        e.preventDefault();
        closeMenu({ returnFocus: false });
        openHeaderAccountModal(profile);
        return;
      }

      // Standard page link: close menu before navigating
      closeMenu({ returnFocus: false });
    });
  });

  // 7. Live responsive switch at NAV_MOBILE_BREAKPOINT_PX (1024px) via matchMedia
  // Ensures only ONE navigation is active in the DOM/accessibility tree at a time
  // and closes open menus/dropdowns on viewport switch.
  const applyResponsiveNavMode = (isDesktop) => {
    if (isDesktop) {
      if (state.isOpen) {
        closeMenu({ returnFocus: false });
      }
      menuAnchor.hidden = true;
      menuAnchor.setAttribute('aria-hidden', 'true');
      navZone.hidden = false;
      navZone.removeAttribute('aria-hidden');
    } else {
      closeAllDesktopDropdowns({ returnFocus: false });
      navZone.hidden = true;
      navZone.setAttribute('aria-hidden', 'true');
      menuAnchor.hidden = false;
      menuAnchor.removeAttribute('aria-hidden');
    }
  };

  if (typeof window.matchMedia === 'function') {
    const mql = window.matchMedia(`(min-width: ${NAV_MOBILE_BREAKPOINT_PX}px)`);
    applyResponsiveNavMode(mql.matches);

    if (header._ttBreakpointMql && header._ttBreakpointHandler) {
      if (typeof header._ttBreakpointMql.removeEventListener === 'function') {
        header._ttBreakpointMql.removeEventListener('change', header._ttBreakpointHandler);
      }
    }

    const onBreakpointChange = (e) => {
      applyResponsiveNavMode(Boolean(e.matches));
    };
    header._ttBreakpointMql = mql;
    header._ttBreakpointHandler = onBreakpointChange;

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onBreakpointChange);
    } else if (typeof mql.addListener === 'function') {
      mql.addListener(onBreakpointChange);
    }
  } else {
    const isDesktop = (window.innerWidth || 1280) >= NAV_MOBILE_BREAKPOINT_PX;
    applyResponsiveNavMode(isDesktop);
  }

  // Document-level Escape, Arrow keys, Tab focus trap, and outside click/tap
  if (!window.__ttHeaderNavGlobalListenersAttached) {
    window.__ttHeaderNavGlobalListenersAttached = true;

    document.addEventListener('click', (e) => {
      if (activeDesktopDropdownController) {
        const clickedDropdown = e.target?.closest ? e.target.closest('.nav-dropdown') : null;
        if (!clickedDropdown) {
          activeDesktopDropdownController.closeAll({ returnFocus: false });
        }
      }

      if (!activeMenuController || !activeMenuController.isOpen()) return;
      const currentMenuEl = document.getElementById('header-nav-menu');
      const currentBtnEl = document.getElementById('btn-header-nav-menu');
      if (
        currentMenuEl &&
        !currentMenuEl.contains(e.target) &&
        currentBtnEl &&
        !currentBtnEl.contains(e.target)
      ) {
        activeMenuController.close({ returnFocus: true });
      }
    });

    window.addEventListener('pagehide', () => {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
      activeDesktopDropdownController?.closeAll({ returnFocus: false });
    });

    window.addEventListener('popstate', () => {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
      activeDesktopDropdownController?.closeAll({ returnFocus: false });
    });

    window.addEventListener('hashchange', () => {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
      activeDesktopDropdownController?.closeAll({ returnFocus: false });
    });
  }

  // Attach keyboard navigation handler to menuEl and menuBtn
  menuEl.addEventListener('keydown', (e) => {
    if (!state.isOpen) return;

    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu({ returnFocus: true });
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const nextIndex = moveFocusIndex(state.focusedIndex, menuItems.length, e.key);
      state = Object.freeze({
        ...state,
        focusedIndex: nextIndex,
        returnFocusToButton: false,
      });
      focusItemAt(nextIndex);
      return;
    }

    if (e.key === 'Tab') {
      const { trapped, nextIndex } = trapTabFocusIndex(
        state.focusedIndex,
        menuItems.length,
        e.shiftKey
      );
      state = Object.freeze({
        ...state,
        focusedIndex: nextIndex,
        returnFocusToButton: false,
      });
      if (trapped) {
        e.preventDefault();
        focusItemAt(nextIndex);
      }
    }
  });

  menuBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.isOpen) {
      e.preventDefault();
      closeMenu({ returnFocus: true });
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !state.isOpen) {
      e.preventDefault();
      openMenu();
    }
  });

  // Watch in-page full-screen stage containers (#flash-play-screen, #screen-player, #drill-worksheet-screen)
  if (typeof MutationObserver !== 'undefined' && !header.dataset.stageObserverAttached) {
    header.dataset.stageObserverAttached = 'true';
    const stageTargets = [
      document.getElementById('flash-play-screen'),
      document.getElementById('screen-player'),
      document.getElementById('drill-worksheet-screen'),
      document.body,
    ].filter(Boolean);

    const obs = new MutationObserver(() => {
      syncStageFocusMode();
    });

    stageTargets.forEach((target) => {
      obs.observe(target, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    });
  }

  attachLinkPrefetchListeners(header);
}
