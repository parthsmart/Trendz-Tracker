/**
 * Trendz Tracker - Student side navigation (js/studentRail.js)
 *
 * Desktop (>= 1024px) navigation for every student page:
 * - Collapsed: a 76px icon rail (default, matches the Student Home design)
 * - Expanded: a 232px sidebar with labels and groups
 * The choice is remembered in localStorage ('tt-side-expanded').
 * Below 1024px: a slim top bar (brand, bell, account) and a bottom tab bar
 * (Home, Practice, Tests, Ranks, More) replace the rail and the old header.
 *
 * Built from NAV_CONFIG, so practice-access rules (e.g. Flash hidden) still apply.
 * Mounted from headerNav.setupHeaderNavigation for verified/cached student profiles only.
 */

import { getRoleNavItems, isNavItemCurrent } from './navConfig.js';

const STORAGE_KEY = 'tt-side-expanded';

const RAIL_ITEMS = [
  { id: 'student-today', short: 'Home', icon: '🏠', group: '' },
  { id: 'student-basics', short: 'Basics', icon: '➕', group: 'Practice' },
  { id: 'student-flash', short: 'Flash', icon: '⚡', group: 'Practice' },
  { id: 'student-elements', short: 'Elements', icon: '🧩', group: 'Practice' },
  { id: 'student-memoriad', short: 'Memoriad', icon: '🧠', group: 'Practice' },
  { id: 'student-round-scores', short: 'Main', icon: '🎯', group: 'Results' },
  { id: 'student-weekly-test', short: 'Tests', icon: '📝', group: 'Results' },
  { id: 'student-leaderboard', short: 'Ranks', icon: '🏆', group: 'Results' },
  { id: 'student-monthly-report', short: 'Report', icon: '📊', group: 'Results' },
];

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function readExpanded() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeExpanded(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* storage unavailable: keep in-memory state only */
  }
}

/**
 * Mounts (or re-renders) the student rail. Safe to call more than once.
 * @param {object} profile - verified or cached student profile
 * @param {{ onAccount?: () => void }} [opts]
 */
export function mountStudentRail(profile, { onAccount } = {}) {
  if (typeof document === 'undefined' || !profile || profile.role !== 'student') return;

  let rail = document.getElementById('student-rail');
  if (!rail) {
    rail = document.createElement('nav');
    rail.id = 'student-rail';
    rail.className = 'student-rail';
    rail.setAttribute('aria-label', 'Student navigation');
    document.body.insertBefore(rail, document.body.firstChild);
  }

  const access = profile.practice_access || profile.access || null;
  const byId = new Map(getRoleNavItems('student', null, access).map((i) => [i.id, i]));
  const pathname = window.location.pathname || '';

  let lastGroup = null;
  const linksHtml = RAIL_ITEMS.filter((r) => byId.has(r.id))
    .map((r) => {
      const item = byId.get(r.id);
      const current = isNavItemCurrent(item, pathname);
      const label = r.id === 'student-today' ? 'Home' : item.label;
      const groupHtml = r.group && r.group !== lastGroup ? `<span class="rail-group">${esc(r.group)}</span>` : '';
      lastGroup = r.group || lastGroup;
      return `${groupHtml}<a href="${item.href}" class="rail-link${current ? ' is-current' : ''}" title="${esc(label)}"${current ? ' aria-current="page"' : ''}>
          <span class="ic" aria-hidden="true">${r.icon}</span><span class="short">${esc(r.short)}</span><span class="full">${esc(label)}</span></a>`;
    })
    .join('');

  const name = profile.full_name || 'Student';
  const initial = name.trim().charAt(0).toUpperCase() || 'S';
  const showBell = byId.has('student-notifications');

  rail.innerHTML = `
    <div class="rail-top">
      <a href="/pages/student.html" class="rail-brand" aria-label="Trendz Tracker home">T</a>
      <span class="rail-title">Trendz Tracker</span>
      <button type="button" class="rail-toggle" id="btn-rail-toggle" aria-label="Expand menu" aria-expanded="false" title="Show or hide menu labels">☰</button>
    </div>
    <div class="rail-links">${linksHtml}</div>
    <div class="rail-bottom">
      ${showBell ? `<a href="/pages/notifications.html" class="rail-bell${isNavItemCurrent(byId.get('student-notifications'), pathname) ? ' is-current' : ''}" aria-label="Notifications" title="Notifications"><span aria-hidden="true">🔔</span><span class="full">Notifications</span><span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span></a>` : ''}
      <button type="button" class="rail-avatar" id="btn-rail-account" aria-haspopup="true" aria-expanded="false" aria-controls="rail-account-menu" title="${esc(name)}"><span class="av">${esc(initial)}</span><span class="full">${esc(name)}</span></button>
      <div class="rail-menu" id="rail-account-menu" role="menu" hidden>
        <div class="who"><b>${esc(name)}</b>${esc(profile.student_code || '')}</div>
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
  applyExpanded(readExpanded());
  rail.querySelector('#btn-rail-toggle').addEventListener('click', () => {
    const next = !document.body.classList.contains('rail-expanded');
    writeExpanded(next);
    applyExpanded(next);
  });

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
    if (action === 'account' && typeof onAccount === 'function') {
      onAccount();
    } else if (action === 'signout') {
      const logoutBtn = document.getElementById('btn-header-logout');
      if (logoutBtn) {
        logoutBtn.click();
      } else {
        const { logoutUser } = await import('./auth.js');
        await logoutUser();
      }
    }
  });

  mountStudentMobileBars(profile, byId, pathname, name, initial, showBell);
  document.body.classList.add('has-student-rail');
}

/* ------------------------------------------------------------------
 * Phones and tablets (< 1024px): slim top bar + bottom tab bar.
 * Tabs: Home, Practice (sheet), Tests, Ranks, More (sheet).
 * ------------------------------------------------------------------ */
const PRACTICE_IDS = ['student-basics', 'student-flash', 'student-elements', 'student-memoriad', 'student-round-scores'];
const MORE_IDS = ['student-monthly-report', 'student-notifications', 'student-account'];
const RAIL_META = new Map(RAIL_ITEMS.map((r) => [r.id, r]));
const EXTRA_META = new Map([
  ['student-notifications', { icon: '🔔' }],
  ['student-account', { icon: '👤' }],
]);

function closeMobileSheets() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('#student-msheets .msheet').forEach((m) => { m.hidden = true; });
  const bd = document.querySelector('#student-msheets .msheet-backdrop');
  if (bd) bd.hidden = true;
  document.querySelectorAll('#student-mtabs [data-msheet]').forEach((b) => {
    b.setAttribute('aria-expanded', 'false');
    b.classList.remove('is-open');
  });
  document.body.classList.remove('msheet-open');
}

function mountStudentMobileBars(profile, byId, pathname, name, initial, showBell) {
  const ensure = (id, tag, cls, label) => {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      el.className = cls;
      if (label) el.setAttribute('aria-label', label);
      document.body.appendChild(el);
    }
    return el;
  };
  const isCur = (id) => byId.has(id) && isNavItemCurrent(byId.get(id), pathname);
  const sheetLink = (id) => {
    const item = byId.get(id);
    if (!item) return '';
    const meta = RAIL_META.get(id) || EXTRA_META.get(id) || { icon: '•' };
    const label = id === 'student-round-scores' ? 'Main round' : item.label;
    const cur = isCur(id);
    const badge = id === 'student-notifications'
      ? '<span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span>'
      : '';
    return `<a href="${item.href}" role="menuitem" class="msheet-link${cur ? ' is-current' : ''}"${cur ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${meta.icon}</span><span class="lbl">${esc(label)}</span>${badge}</a>`;
  };

  const top = ensure('student-mbar', 'header', 'student-mbar', 'Student top bar');
  top.innerHTML = `
    <a href="/pages/student.html" class="mbar-brand"><span class="mbar-logo" aria-hidden="true">T</span><span>Trendz Tracker</span></a>
    <div class="mbar-actions">
      ${showBell ? `<a href="/pages/notifications.html" class="mbar-bell${isCur('student-notifications') ? ' is-current' : ''}" aria-label="Notifications"><span aria-hidden="true">🔔</span><span class="nav-notifications-badge num" style="display: none;" aria-hidden="true"></span></a>` : ''}
      <a href="/pages/account.html" class="mbar-av${isCur('student-account') ? ' is-current' : ''}" aria-label="My account" title="${esc(name)}">${esc(initial)}</a>
    </div>`;

  const practice = PRACTICE_IDS.filter((id) => byId.has(id));
  const more = MORE_IDS.filter((id) => byId.has(id));

  const tab = (id, icon, label) => {
    const item = byId.get(id);
    if (!item) return '';
    const cur = isCur(id);
    return `<a href="${item.href}" class="mtab${cur ? ' is-current' : ''}"${cur ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${icon}</span><span>${label}</span></a>`;
  };
  const sheetBtn = (key, icon, label, cur) =>
    `<button type="button" class="mtab${cur ? ' is-current' : ''}" data-msheet="${key}" aria-haspopup="true" aria-expanded="false" aria-controls="student-msheet-${key}"><span class="ic" aria-hidden="true">${icon}</span><span>${label}</span></button>`;

  const tabs = ensure('student-mtabs', 'nav', 'student-mtabs', 'Student navigation');
  tabs.innerHTML = `
    ${tab('student-today', '🏠', 'Home')}
    ${practice.length ? sheetBtn('practice', '✏️', 'Practice', practice.some(isCur)) : ''}
    ${tab('student-weekly-test', '📝', 'Tests')}
    ${tab('student-leaderboard', '🏆', 'Ranks')}
    ${sheetBtn('more', '☰', 'More', more.some(isCur))}`;

  const sheets = ensure('student-msheets', 'div', 'student-msheets');
  sheets.innerHTML = `
    <div class="msheet-backdrop" hidden></div>
    <div class="msheet" id="student-msheet-practice" role="menu" aria-label="Practice" hidden>
      <p class="msheet-h">Practice</p>
      <div class="msheet-grid">${practice.map(sheetLink).join('')}</div>
    </div>
    <div class="msheet" id="student-msheet-more" role="menu" aria-label="More" hidden>
      <div class="msheet-who"><span class="mbar-av" aria-hidden="true">${esc(initial)}</span><span><b>${esc(name)}</b>${esc(profile.student_code || '')}</span></div>
      <div class="msheet-list">${more.map(sheetLink).join('')}
        <button type="button" role="menuitem" class="msheet-link danger" data-msheet-action="signout"><span class="ic" aria-hidden="true">↩</span><span class="lbl">Sign out</span></button>
      </div>
    </div>`;

  tabs.querySelectorAll('[data-msheet]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sheet = sheets.querySelector(`#student-msheet-${btn.dataset.msheet}`);
      const wasOpen = sheet && !sheet.hidden;
      closeMobileSheets();
      if (!sheet || wasOpen) return;
      sheet.hidden = false;
      sheets.querySelector('.msheet-backdrop').hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('is-open');
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
    const logoutBtn = document.getElementById('btn-header-logout');
    if (logoutBtn) {
      logoutBtn.click();
    } else {
      const { logoutUser } = await import('./auth.js');
      await logoutUser();
    }
  });
}
