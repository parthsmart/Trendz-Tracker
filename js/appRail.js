/**
 * Trendz Tracker - App side navigation (js/appRail.js)
 *
 * One navigation shell for students, teachers and admins:
 * - Desktop (>= 1024px): a 76px icon rail. Every page opens with it closed; ☰ opens a
 *   232px sidebar with labels and groups over the page (the content never shifts), and
 *   clicking outside it, pressing Escape or following a link closes it again.
 * - Below 1024px: a slim top bar (brand, bell, account) and a bottom tab bar. Tabs that
 *   hold several pages open a sheet (students: Practice and More; staff: More).
 *
 * Items come from NAV_CONFIG, so student practice access and teacher permissions still
 * decide what is shown. Staff also get shortcuts to the Settings pages they use most;
 * those pages stay guarded by their own requireAuth checks.
 * Mounted from headerNav.setupHeaderNavigation for verified profiles (and cached students).
 */

import { STAFF_PAGE_ICONS, enhanceStaffUi } from './staffUi.js';
import { getRoleNavItems, isNavItemCurrent } from './navConfig.js';

/**
 * Per-role layout.
 * rail: ordered rail entries. `id` refers to a NAV_CONFIG item; entries with `href`
 *       are staff shortcuts that are not in NAV_CONFIG. `perm` hides a teacher shortcut
 *       unless that permission is granted.
 * tabs: bottom tab bar between Home and More (ids or { sheet } entries).
 * more: ids listed in the More sheet before Account and Sign out.
 */
const ROLE_LAYOUTS = {
  student: {
    label: 'Student',
    home: '/pages/student.html',
    rail: [
      { id: 'student-today', short: 'Home', icon: '🏠', group: '', label: 'Home' },
      { id: 'student-live-classes', short: 'Live', icon: '🎥', group: '', label: 'Live Classes' },
      { id: 'student-basics', short: 'Basics', icon: '➕', group: 'Practice' },
      { id: 'student-flash', short: 'Flash', icon: '⚡', group: 'Practice' },
      { id: 'student-elements', short: 'Elements', icon: '🧩', group: 'Practice' },
      { id: 'student-memoriad', short: 'Memoriad', icon: '🧠', group: 'Practice' },
      { id: 'student-round-scores', short: 'Main', icon: '🎯', group: 'Results', sheetLabel: 'Main round' },
      { id: 'student-weekly-test', short: 'Tests', icon: '📝', group: 'Results' },
      { id: 'student-leaderboard', short: 'Ranks', icon: '🏆', group: 'Results' },
      { id: 'student-monthly-report', short: 'Report', icon: '📊', group: 'Results' },
    ],
    tabs: [
      { sheet: 'practice', icon: '✏️', label: 'Practice', ids: ['student-basics', 'student-flash', 'student-elements', 'student-memoriad', 'student-round-scores'] },
      { id: 'student-weekly-test', icon: '📝', label: 'Tests' },
      { id: 'student-leaderboard', icon: '🏆', label: 'Ranks' },
    ],
    more: ['student-live-classes', 'student-monthly-report', 'student-notifications', 'student-account'],
  },
  admin: {
    label: 'Admin',
    home: '/pages/admin.html',
    rail: [
      { id: 'admin-overview', short: 'Home', icon: '🏠', group: '', label: 'Overview' },
      { id: 'admin-students', short: 'Students', icon: '👥', group: 'Students' },
      { id: 'admin-attendance', short: 'Attend.', icon: '✅', group: 'Students' },
      { id: 'admin-review', short: 'Review', icon: '🔍', group: 'Results' },
      { id: 'admin-weekly-tests', short: 'Tests', icon: '📝', group: 'Results' },
      { id: 'admin-leaderboard', short: 'Ranks', icon: '🏆', group: 'Results' },
      { id: 'admin-monthly-report', short: 'Report', icon: '📊', group: 'Results' },
      { id: 'admin-live-classes', href: '/pages/live-classes.html', label: 'Live Classes', short: 'Live', icon: '🎥', group: 'Manage' },
      { id: 'admin-homework', href: '/pages/homework.html', label: 'Homework', short: 'Homework', icon: '📚', group: 'Manage' },
      { id: 'admin-teachers', href: '/pages/teachers.html', label: 'Teachers', short: 'Teachers', icon: '🧑‍🏫', group: 'Manage' },
      { id: 'admin-settings', short: 'Settings', icon: '⚙️', group: 'Manage' },
    ],
    tabs: [
      { id: 'admin-students', icon: '👥', label: 'Students' },
      { id: 'admin-review', icon: '🔍', label: 'Review' },
      { id: 'admin-weekly-tests', icon: '📝', label: 'Tests' },
    ],
    more: [
      'admin-attendance', 'admin-leaderboard', 'admin-monthly-report', 'admin-live-classes',
      'admin-homework', 'admin-teachers', 'admin-settings', 'admin-account',
    ],
  },
  teacher: {
    label: 'Teacher',
    home: '/pages/teacher.html',
    rail: [
      { id: 'teacher-overview', short: 'Home', icon: '🏠', group: '', label: 'Overview' },
      { id: 'teacher-students', short: 'Students', icon: '👥', group: 'Class' },
      { id: 'teacher-attendance', short: 'Attend.', icon: '✅', group: 'Class' },
      { id: 'teacher-todos', short: 'Tasks', icon: '☑️', group: 'Class' },
      { id: 'teacher-live-classes', href: '/pages/live-classes.html', label: 'Live Classes', short: 'Live', icon: '🎥', group: 'Class' },
      { id: 'teacher-homework', href: '/pages/homework.html', label: 'Homework', short: 'Homework', icon: '📚', group: 'Class' },
      { id: 'teacher-review', short: 'Review', icon: '🔍', group: 'Results' },
      { id: 'teacher-weekly-tests', short: 'Tests', icon: '📝', group: 'Results' },
      { id: 'teacher-monthly-report', short: 'Reports', icon: '📊', group: 'Results' },
      { id: 'teacher-announcements', short: 'News', icon: '📣', group: 'Content' },
      { id: 'teacher-resources', short: 'Resources', icon: '📁', group: 'Content' },
    ],
    // First three that the teacher has permission for are used.
    tabs: [
      { id: 'teacher-students', icon: '👥', label: 'Students' },
      { id: 'teacher-attendance', icon: '✅', label: 'Attendance' },
      { id: 'teacher-review', icon: '🔍', label: 'Review' },
      { id: 'teacher-todos', icon: '☑️', label: 'Tasks' },
      { id: 'teacher-weekly-tests', icon: '📝', label: 'Tests' },
    ],
    more: [
      'teacher-todos', 'teacher-live-classes', 'teacher-homework', 'teacher-weekly-tests', 'teacher-review', 'teacher-attendance',
      'teacher-monthly-report', 'teacher-announcements', 'teacher-resources', 'teacher-account',
    ],
  },
};

const EXTRA_META = new Map([
  ['student-notifications', { icon: '🔔' }],
  ['student-account', { icon: '👤' }],
  ['admin-account', { icon: '👤' }],
  ['teacher-account', { icon: '👤' }],
]);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function signOut() {
  const logoutBtn = document.getElementById('btn-header-logout');
  if (logoutBtn) {
    logoutBtn.click();
  } else {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  }
}

/**
 * Resolves the items a profile may see, keyed by id, with each item's current state.
 * Exported for tests.
 * @param {object} profile
 * @param {string} pathname
 */
export function resolveRailItems(profile, pathname) {
  const role = profile?.role;
  const layout = ROLE_LAYOUTS[role];
  if (!layout) return null;

  const permissions = role === 'teacher' ? profile.permissions || null : null;
  const access = role === 'student' ? profile.practice_access || profile.access || null : null;
  const navItems = getRoleNavItems(role, permissions, access);
  const byId = new Map(navItems.map((i) => [i.id, { ...i }]));

  // Staff shortcuts that are not part of NAV_CONFIG
  for (const r of layout.rail) {
    if (!r.href || byId.has(r.id)) continue;
    if (r.perm && permissions && permissions[r.perm] === false) continue;
    byId.set(r.id, { id: r.id, label: r.label, href: r.href, group: r.group });
  }

  // Current page: an exact shortcut match wins over the Settings hub's sub-page match.
  const clean = String(pathname || '').split('?')[0].split('#')[0];
  const exact = [...byId.values()].some((i) => !i.isHub && i.href && !i.href.startsWith('#') && clean.endsWith(i.href));
  for (const item of byId.values()) {
    item.current = item.isHub && exact ? false : isNavItemCurrent(item, clean);
  }
  return { layout, byId };
}

/**
 * Mounts (or re-renders) the side rail and the phone bars. Safe to call more than once.
 * @param {object} profile - verified profile (or cached student profile)
 * @param {{ onAccount?: () => void }} [opts]
 */
export function mountAppRail(profile, { onAccount } = {}) {
  if (typeof document === 'undefined' || !profile) return;
  const resolved = resolveRailItems(profile, window.location.pathname || '');
  if (!resolved) return;
  const { layout, byId } = resolved;
  const role = profile.role;

  let rail = document.getElementById('app-rail');
  if (!rail) {
    rail = document.createElement('nav');
    rail.id = 'app-rail';
    rail.className = 'app-rail';
    document.body.insertBefore(rail, document.body.firstChild);
  }
  rail.setAttribute('aria-label', `${layout.label} navigation`);
  rail.dataset.role = role;

  let lastGroup = null;
  const linksHtml = layout.rail
    .filter((r) => byId.has(r.id))
    .map((r) => {
      const item = byId.get(r.id);
      const label = r.label || item.label;
      const groupHtml = r.group && r.group !== lastGroup ? `<span class="rail-group">${esc(r.group)}</span>` : '';
      lastGroup = r.group || lastGroup;
      return `${groupHtml}<a href="${item.href}" class="rail-link${item.current ? ' is-current' : ''}" title="${esc(label)}"${item.current ? ' aria-current="page"' : ''}>
          <span class="ic" aria-hidden="true">${r.icon}</span><span class="short">${esc(r.short)}</span><span class="full">${esc(label)}</span></a>`;
    })
    .join('');

  const name = profile.full_name || layout.label;
  const initial = name.trim().charAt(0).toUpperCase() || layout.label.charAt(0);
  const code = profile.student_code || '';
  const who = role === 'student' ? code : [code, layout.label].filter(Boolean).join(' · ');
  const bellItem = byId.get('student-notifications');

  rail.innerHTML = `
    <div class="rail-top">
      <a href="${layout.home}" class="rail-brand" aria-label="Trendz Tracker home">T</a>
      <span class="rail-title">Trendz Tracker${role !== 'student' ? `<small>${esc(layout.label)}</small>` : ''}</span>
      <button type="button" class="rail-toggle" id="btn-rail-toggle" aria-label="Expand menu" aria-expanded="false" title="Show or hide menu labels">☰</button>
    </div>
    <div class="rail-links">${linksHtml}</div>
    <div class="rail-bottom">
      ${bellItem ? `<a href="${bellItem.href}" class="rail-bell${bellItem.current ? ' is-current' : ''}" aria-label="Notifications" title="Notifications"><span aria-hidden="true">🔔</span><span class="full">Notifications</span><span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span></a>` : ''}
      <button type="button" class="rail-avatar" id="btn-rail-account" aria-haspopup="true" aria-expanded="false" aria-controls="rail-account-menu" title="${esc(name)}"><span class="av">${esc(initial)}</span><span class="full">${esc(name)}</span></button>
      <div class="rail-menu" id="rail-account-menu" role="menu" hidden>
        <div class="who"><b>${esc(name)}</b>${esc(who)}</div>
        <button type="button" role="menuitem" data-rail-action="account">Account</button>
        <button type="button" role="menuitem" class="danger" data-rail-action="signout">Sign out</button>
      </div>
    </div>`;

  const applyExpanded = (expanded) => {
    document.body.classList.toggle('rail-expanded', expanded);
    const t = rail.querySelector('#btn-rail-toggle');
    t.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    t.setAttribute('aria-label', expanded ? 'Collapse menu' : 'Expand menu');
  };
  // Always start closed. The open sidebar floats over the page, so close it on any
  // click outside it, on Escape, and when a link inside it is followed.
  applyExpanded(false);
  rail.querySelector('#btn-rail-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    applyExpanded(!document.body.classList.contains('rail-expanded'));
  });
  rail.querySelector('.rail-links')?.addEventListener('click', (e) => {
    if (e.target.closest('a')) applyExpanded(false);
  });
  if (!rail.dataset.expandListeners) {
    rail.dataset.expandListeners = '1';
    document.addEventListener('click', (e) => {
      if (document.body.classList.contains('rail-expanded') && !rail.contains(e.target)) applyExpanded(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('rail-expanded')) {
        applyExpanded(false);
        rail.querySelector('#btn-rail-toggle')?.focus();
      }
    });
  }

  const btn = rail.querySelector('#btn-rail-account');
  const menu = rail.querySelector('#rail-account-menu');
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  if (!rail.dataset.globalListeners) {
    rail.dataset.globalListeners = '1';
    document.addEventListener('click', (e) => {
      const m = document.getElementById('rail-account-menu');
      const b = document.getElementById('btn-rail-account');
      if (m && !m.hidden && !m.contains(e.target)) {
        m.hidden = true;
        b?.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      const m = document.getElementById('rail-account-menu');
      if (e.key === 'Escape' && m && !m.hidden) {
        m.hidden = true;
        document.getElementById('btn-rail-account')?.focus();
      }
    });
  }
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-rail-action]')?.getAttribute('data-rail-action');
    if (!action) return;
    setOpen(false);
    if (action === 'account') {
      if (typeof onAccount === 'function') onAccount();
      else window.location.href = '/pages/account.html';
    } else if (action === 'signout') {
      await signOut();
    }
  });

  mountMobileBars(profile, layout, byId, { name, initial, who });
  if (role !== 'student') {
    decorateStaffPageHeader(layout, byId);
    enhanceStaffUi();
  }
  document.body.classList.add('has-app-rail');
  document.body.classList.toggle('has-student-rail', role === 'student');
  document.body.classList.toggle('has-staff-rail', role !== 'student');
}

/**
 * Teacher / admin pages: turns the page title row into the same soft header card the
 * student Home uses, with the page's icon beside the title. Visual only; safe to repeat.
 */
function decorateStaffPageHeader(layout, byId) {
  const container = document.querySelector('.main-content .container');
  const h1 = container?.querySelector('h1');
  if (!h1 || document.querySelector('.sf-hero')) return; // Home pages already have their header
  let head = h1.parentElement;
  while (head && head.parentElement && head.parentElement !== container) head = head.parentElement;
  if (!head || head === h1 || head.parentElement !== container || head.classList.contains('card') || head.classList.contains('sf-page-head')) return;

  const file = (window.location.pathname || '').split('/').pop();
  const current = [...byId.values()].find((i) => i.current);
  const railIcon = current ? (layout.rail.find((r) => r.id === current.id)?.icon || '') : '';
  const icon = STAFF_PAGE_ICONS[file] || railIcon;

  head.classList.add('sf-page-head');
  let title = h1;
  while (title.parentElement && title.parentElement !== head) title = title.parentElement;
  title.classList.add('sf-page-title');
  if (icon) title.insertAdjacentHTML('beforebegin', `<span class="sf-page-emblem" aria-hidden="true">${icon}</span>`);
}

/** @deprecated kept for older imports; use mountAppRail. */
export const mountStudentRail = mountAppRail;

/* ------------------------------------------------------------------
 * Phones and tablets (< 1024px): slim top bar + bottom tab bar + sheets.
 * ------------------------------------------------------------------ */
function closeMobileSheets() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('#app-msheets .msheet').forEach((m) => { m.hidden = true; });
  const bd = document.querySelector('#app-msheets .msheet-backdrop');
  if (bd) bd.hidden = true;
  document.querySelectorAll('#app-mtabs [data-msheet]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
    b.classList.remove('is-open');
  });
  document.body.classList.remove('msheet-open');
}

function mountMobileBars(profile, layout, byId, { name, initial, who }) {
  const ensure = (id, tag, cls, label) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      el.className = cls;
      document.body.appendChild(el);
    }
    if (label) el.setAttribute('aria-label', label);
    return el;
  };
  const railMeta = new Map(layout.rail.map((r) => [r.id, r]));
  const isCur = (id) => Boolean(byId.get(id)?.current);
  const sheetLink = (id) => {
    const item = byId.get(id);
    if (!item) return '';
    const meta = railMeta.get(id) || EXTRA_META.get(id) || { icon: '•' };
    const label = meta.sheetLabel || meta.label || item.label;
    const cur = item.current;
    const badge = id === 'student-notifications'
      ? '<span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span>'
      : '';
    return `<a href="${item.href}" role="menuitem" class="msheet-link${cur ? ' is-current' : ''}"${cur ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${meta.icon}</span><span class="lbl">${esc(label)}</span>${badge}</a>`;
  };
  const bellItem = byId.get('student-notifications');
  const accountId = `${profile.role}-account`;

  const top = ensure('app-mbar', 'header', 'app-mbar', `${layout.label} top bar`);
  top.innerHTML = `
    <a href="${layout.home}" class="mbar-brand"><span class="mbar-logo" aria-hidden="true">T</span><span>Trendz Tracker</span>${profile.role !== 'student' ? `<span class="mbar-role">${esc(layout.label)}</span>` : ''}</a>
    <div class="mbar-actions">
      ${bellItem ? `<a href="${bellItem.href}" class="mbar-bell${bellItem.current ? ' is-current' : ''}" aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span></a>` : ''}
      <a href="/pages/account.html" class="mbar-av${isCur(accountId) ? ' is-current' : ''}" aria-label="My account" title="${esc(name)}">${esc(initial)}</a>
    </div>`;

  // Bottom tabs: Home, up to three role tabs, More
  const homeId = layout.rail[0].id;
  const tabDefs = [];
  for (const t of layout.tabs) {
    if (tabDefs.length >= 3) break;
    if (t.sheet) {
      const ids = t.ids.filter((id) => byId.has(id));
      if (ids.length) tabDefs.push({ ...t, ids });
    } else if (byId.has(t.id)) {
      tabDefs.push(t);
    }
  }
  const tabbedIds = new Set(tabDefs.filter((t) => t.id).map((t) => t.id));
  const more = layout.more.filter((id) => byId.has(id) && !tabbedIds.has(id));

  const tabLink = (id, icon, label) => {
    const item = byId.get(id);
    if (!item) return '';
    const cur = item.current;
    return `<a href="${item.href}" class="mtab${cur ? ' is-current' : ''}"${cur ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${icon}</span><span>${esc(label)}</span></a>`;
  };
  const sheetBtn = (key, icon, label, cur) =>
    `<button type="button" class="mtab${cur ? ' is-current' : ''}" data-msheet="${key}" aria-haspopup="true" aria-expanded="false" aria-controls="app-msheet-${key}"><span class="ic" aria-hidden="true">${icon}</span><span>${esc(label)}</span></button>`;

  const tabs = ensure('app-mtabs', 'nav', 'app-mtabs', `${layout.label} navigation`);
  tabs.innerHTML = `
    ${tabLink(homeId, '🏠', 'Home')}
    ${tabDefs.map((t) => (t.sheet ? sheetBtn(t.sheet, t.icon, t.label, t.ids.some(isCur)) : tabLink(t.id, t.icon, t.label))).join('')}
    ${sheetBtn('more', '☰', 'More', more.some(isCur))}`;

  const sheets = ensure('app-msheets', 'div', 'app-msheets');
  const gridSheets = tabDefs
    .filter((t) => t.sheet)
    .map(
      (t) => `<div class="msheet" id="app-msheet-${t.sheet}" role="menu" aria-label="${esc(t.label)}" hidden>
      <p class="msheet-h">${esc(t.label)}</p>
      <div class="msheet-grid">${t.ids.map(sheetLink).join('')}</div>
    </div>`
    )
    .join('');
  const moreBody = profile.role === 'student'
    ? `<div class="msheet-list">${more.map(sheetLink).join('')}`
    : `<div class="msheet-grid">${more.filter((id) => id !== accountId).map(sheetLink).join('')}</div>
      <div class="msheet-list">${sheetLink(accountId)}`;
  sheets.innerHTML = `
    <div class="msheet-backdrop" hidden></div>
    ${gridSheets}
    <div class="msheet" id="app-msheet-more" role="menu" aria-label="More" hidden>
      <div class="msheet-who"><span class="mbar-av" aria-hidden="true">${esc(initial)}</span><span><b>${esc(name)}</b>${esc(who)}</span></div>
      ${moreBody}
        <button type="button" role="menuitem" class="msheet-link danger" data-msheet-action="signout"><span class="ic" aria-hidden="true">↩</span><span class="lbl">Sign out</span></button>
      </div>
    </div>`;

  tabs.querySelectorAll('[data-msheet]').forEach((b) => {
    b.addEventListener('click', () => {
      const sheet = sheets.querySelector(`#app-msheet-${b.dataset.msheet}`);
      const wasOpen = sheet && !sheet.hidden;
      closeMobileSheets();
      if (!sheet || wasOpen) return;
      sheet.hidden = false;
      sheets.querySelector('.msheet-backdrop').hidden = false;
      b.setAttribute('aria-expanded', 'true');
      b.classList.add('is-open');
      document.body.classList.add('msheet-open');
      sheet.querySelector('a, button')?.focus({ preventScroll: true });
    });
  });
  sheets.querySelector('.msheet-backdrop').addEventListener('click', closeMobileSheets);
  if (!document.body.dataset.msheetEsc) {
    document.body.dataset.msheetEsc = '1';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('msheet-open')) closeMobileSheets();
    });
  }
  sheets.querySelector('[data-msheet-action="signout"]')?.addEventListener('click', async () => {
    closeMobileSheets();
    await signOut();
  });
}
