/**
 * Trendz Tracker - Unified Header & Three-Dot Navigation Menu Controller (js/headerNav.js)
 *
 * Phase 14d:
 * - Renders the single-line header layout:
 *     [logo] [Trendz Tracker (nowrap + ellipsis)] [44x44 three-dot menu button]
 *     [short inline links >= 1100px] [right user name, ID & Sign out]
 * - Builds both the short inline links and the grouped menu from `js/navConfig.js`.
 * - Opens an anchored panel (> 700px) or a left slide-in drawer with dimmed backdrop (<= 700px).
 * - Implements keyboard navigation (ArrowUp/ArrowDown/Home/End wrap-around, Escape, Tab focus trap),
 *   focus transfer to first item on open and back to menu button on close, and body scroll lock.
 * - Excludes full-screen practice/test stages so those keep only their own exit button.
 */

import {
  getGroupedNavItems,
  getInlineNavItems,
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

let activeMenuController = null;

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
 * Updates the unread notification dot on the three-dot menu button and the number badge
 * next to the Notifications item inside the menu.
 *
 * @param {number} count
 * @param {string} formattedText
 */
export function syncHeaderMenuNotificationBadge(count, formattedText) {
  if (typeof document === 'undefined') return;

  const hasUnread = Number(count) > 0 && Boolean(formattedText);
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

  const menuBadges = document.querySelectorAll('.header-menu-notif-badge');
  menuBadges.forEach((badge) => {
    if (hasUnread) {
      badge.textContent = formattedText;
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
 * Mounts and wires the Phase 14d header layout and three-dot menu for the given role/profile.
 * Safe to call multiple times (idempotent).
 *
 * @param {{ id?: string, full_name?: string, role?: 'student' | 'admin', student_code?: string, level?: string } | null} [profile]
 */
export function setupHeaderNavigation(profile = null) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const header = document.querySelector('.app-header');
  if (!header) return;

  const pathname = window.location.pathname || '';

  // Determine role from profile or fallback to page context
  const inferredRole =
    profile?.role ||
    (header.querySelector('#admin-nav-zone') ||
    pathname.endsWith('/admin.html') ||
    pathname.endsWith('/students.html') ||
    pathname.endsWith('/review.html') ||
    pathname.endsWith('/attendance.html') ||
    pathname.endsWith('/weekly-tests.html') ||
    pathname.endsWith('/settings.html') ||
    pathname.endsWith('/todos.html') ||
    pathname.endsWith('/resources.html') ||
    pathname.endsWith('/categories.html') ||
    pathname.endsWith('/rounds.html') ||
    pathname.endsWith('/targets.html') ||
    pathname.endsWith('/competition.html') ||
    pathname.endsWith('/announcements.html') ||
    pathname.endsWith('/report.html') ||
    pathname.endsWith('/import.html') ||
    pathname.endsWith('/backup.html')
      ? 'admin'
      : 'student');

  // Set up stage visibility guard (hides header and closes menu on full-screen stages)
  const syncStageFocusMode = () => {
    const inStage = isFullScreenStageActive();
    document.body.classList.toggle('stage-focus-mode', inStage);
    if (inStage && activeMenuController?.isOpen()) {
      activeMenuController.close({ returnFocus: false });
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

  // 2. Ensure Brand + Three-Dot Menu cluster on the left: [logo] [Trendz Tracker] [menu button]
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
    brandZone.href = inferredRole === 'admin' ? '/pages/admin.html' : '/pages/student.html';
    brandZone.innerHTML = `
      <span class="brand-icon" aria-hidden="true">${BRAND_LOGO_SVG}</span>
      <span class="brand-title">Trendz Tracker</span>
    `;
  }

  // Create or update the three-dot menu anchor & button right beside Trendz Tracker
  let menuAnchor = brandCluster.querySelector('.header-menu-anchor');
  if (!menuAnchor) {
    menuAnchor = document.createElement('div');
    menuAnchor.className = 'header-menu-anchor';
    brandCluster.appendChild(menuAnchor);
  }

  // Ensure backdrop exists for <= 700px left slide-in drawer
  let backdropEl = document.getElementById('header-nav-backdrop');
  if (!backdropEl) {
    backdropEl = document.createElement('div');
    backdropEl.id = 'header-nav-backdrop';
    backdropEl.className = 'header-nav-backdrop';
    backdropEl.hidden = true;
    backdropEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdropEl);
  }

  // Render Menu Button + Menu Panel/Drawer from single NAV_CONFIG
  const groups = getGroupedNavItems(inferredRole);
  const groupsHtml = groups
    .map((groupEntry) => {
      const itemsHtml = groupEntry.items
        .map((item) => {
          const isCurrent = isNavItemCurrent(item, pathname);
          const badgeHtml =
            item.badge === 'notifications'
              ? `<span id="nav-notifications-badge" class="nav-notifications-badge header-menu-notif-badge num" style="display: none;" aria-hidden="true"></span>`
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
    <nav
      id="header-nav-menu"
      class="header-nav-menu"
      aria-label="${inferredRole === 'admin' ? 'Admin menu' : 'Student menu'}"
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

  // 3. Render the SHORT inline link list (>= 1100px only) from NAV_CONFIG
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
  navZone.id = inferredRole === 'admin' ? 'admin-nav-zone' : 'student-nav-zone';
  navZone.setAttribute('aria-label', inferredRole === 'admin' ? 'Admin Primary Navigation' : 'Student Primary Navigation');

  const inlineItems = getInlineNavItems(inferredRole);
  navZone.innerHTML = inlineItems
    .map((item) => {
      const isCurrent = isNavItemCurrent(item, pathname);
      return `<a href="${item.href}" class="nav-link${isCurrent ? ' active' : ''}"${
        isCurrent ? ' aria-current="page"' : ''
      }>${item.label}</a>`;
    })
    .join('');

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

    const fullName = profile?.full_name || nameEl.textContent?.trim() || (inferredRole === 'admin' ? 'Admin' : 'Student');
    const shortName = formatShortFirstName(fullName, inferredRole === 'admin' ? 'Admin' : 'Student');
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
      } else if (inferredRole === 'admin') {
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

  // 5. Wire interactive menu state, focus management, keyboard navigation, and outside/backdrop close
  const menuBtn = document.getElementById('btn-header-nav-menu');
  const menuEl = document.getElementById('header-nav-menu');
  const closeDrawerBtn = document.getElementById('btn-header-nav-close');
  const menuItems = Array.from(menuEl.querySelectorAll('.header-nav-item'));

  let state = createMenuState(menuItems.length);

  const focusItemAt = (index) => {
    if (index >= 0 && index < menuItems.length) {
      menuItems[index].focus();
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

    document.body.classList.toggle('nav-menu-open', isOpen);

    if (isOpen && state.focusedIndex >= 0) {
      focusItemAt(state.focusedIndex);
    } else if (!isOpen && state.returnFocusToButton) {
      menuBtn.focus();
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

  backdropEl.onclick = () => {
    closeMenu({ returnFocus: true });
  };

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

  // Document-level Escape, Arrow keys, Tab focus trap, and outside click/tap
  if (!window.__ttHeaderNavGlobalListenersAttached) {
    window.__ttHeaderNavGlobalListenersAttached = true;

    document.addEventListener('click', (e) => {
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
    });

    window.addEventListener('popstate', () => {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
    });

    window.addEventListener('hashchange', () => {
      if (activeMenuController?.isOpen()) {
        activeMenuController.close({ returnFocus: false });
      }
    });
  }

  // Attach keyboard navigation handler to menuEl and document
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
