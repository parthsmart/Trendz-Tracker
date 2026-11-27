/**
 * Trendz Tracker - App side navigation (js/appRail.js)
 *
 * One navigation shell for students, teachers and admins:
 * - Desktop (>= 1024px): a 76px icon rail. Every page opens with it closed; ☰ opens a
 *   232px sidebar with labels and groups over the page (the content never shifts), and
 *   clicking outside it, pressing Escape or following a link closes it again.
 *   Students get one Practice button (like the phone tab bar) that opens the practice
 *   pages beside the rail, or as a group under it when the sidebar is open. The avatar
 *   opens a profile preview beside the rail (photo, level, XP, streak and links).
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
import { isNetworkRole } from './roles.js';

/**
 * Per-role layout.
 * rail: ordered rail entries. `id` refers to a NAV_CONFIG item; entries with `href`
 *       are staff shortcuts that are not in NAV_CONFIG. `perm` hides a teacher shortcut
 *       unless that permission is granted. `in` puts an entry inside a flyout button
 *       (see `flyouts`), drawn where the first visible entry of that flyout sits.
 * flyouts: { key: { icon, short, label } } buttons that open a list of rail entries.
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
      { id: 'student-basics', short: 'Basics', icon: '➕', group: '', in: 'practice' },
      { id: 'student-flash', short: 'Flash', icon: '⚡', group: '', in: 'practice' },
      { id: 'student-elements', short: 'Elements', icon: '🧩', group: '', in: 'practice' },
      { id: 'student-memoriad', short: 'Memoriad', icon: '🧠', group: '', in: 'practice' },
      { id: 'student-oral-rounds', short: 'Oral', icon: '🗣️', group: '', in: 'practice', label: 'Oral Rounds' },
      { id: 'student-simple', short: 'Simple', icon: '🔢', group: '', in: 'practice', label: 'Simple' },
      { id: 'student-round-scores', short: 'Main', icon: '🎯', group: '', in: 'practice', label: 'Main round', sheetLabel: 'Main round' },
      { id: 'student-duels', short: 'Duels', icon: '⚔️', group: 'Play', label: 'Duels' },
      { id: 'student-store', short: 'Store', icon: '🎁', group: 'Play', label: 'Store' },
      { id: 'student-weekly-test', short: 'Tests', icon: '📝', group: 'Results' },
      { id: 'student-leaderboard', short: 'Ranks', icon: '🏆', group: 'Results' },
      { id: 'student-monthly-report', short: 'Report', icon: '📊', group: 'Results' },
    ],
    flyouts: {
      practice: { icon: '✏️', short: 'Practice', label: 'Practice' },
    },
    tabs: [
      { sheet: 'practice', icon: '✏️', label: 'Practice', ids: ['student-basics', 'student-flash', 'student-elements', 'student-memoriad', 'student-oral-rounds', 'student-simple', 'student-round-scores'] },
      { id: 'student-weekly-test', icon: '📝', label: 'Tests' },
      { id: 'student-leaderboard', icon: '🏆', label: 'Ranks' },
    ],
    more: [
      'student-live-classes', 'student-duels', 'student-store', 'student-monthly-report',
      'student-notifications', 'student-profile', 'student-account',
    ],
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
      { id: 'admin-network', href: '/pages/network.html', label: 'Network', short: 'Network', icon: '🏢', group: 'Manage', network: true },
      { id: 'admin-settings', short: 'Settings', icon: '⚙️', group: 'Manage' },
    ],
    tabs: [
      { id: 'admin-students', icon: '👥', label: 'Students' },
      { id: 'admin-review', icon: '🔍', label: 'Review' },
      { id: 'admin-weekly-tests', icon: '📝', label: 'Tests' },
    ],
    more: [
      'admin-attendance', 'admin-leaderboard', 'admin-monthly-report', 'admin-live-classes',
      'admin-homework', 'admin-teachers', 'admin-network', 'admin-settings', 'admin-account',
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
      { id: 'teacher-homework', href: '/pages/homework.html', label: 'Homework', short: 'Homework', icon: '📚', group: 'Class', perm: 'can_manage_tasks' },
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
  ['student-profile', { icon: '🏅', sheetLabel: 'My profile & badges' }],
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
    if (r.network && !isNetworkRole(profile.network_role)) continue;
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

const fmtNum = (v) => Math.round(Number(v) || 0).toLocaleString('en-IN');

/**
 * Rail links in layout order. Entries with `in` are drawn inside their flyout button,
 * which takes the place of the first visible entry of that flyout. Exported for tests.
 * @param {object} layout - ROLE_LAYOUTS entry
 * @param {Map<string, object>} byId - from resolveRailItems
 */
export function buildRailLinksHtml(layout, byId) {
  const flyouts = layout.flyouts || {};
  const drawn = new Set();
  let lastGroup = null;
  const groupHtml = (group) => {
    const html = group && group !== lastGroup ? `<span class="rail-group">${esc(group)}</span>` : '';
    lastGroup = group || lastGroup;
    return html;
  };
  const out = [];
  for (const r of layout.rail) {
    if (!byId.has(r.id)) continue;
    if (r.in && flyouts[r.in]) {
      if (drawn.has(r.in)) continue;
      drawn.add(r.in);
      const key = r.in;
      const f = flyouts[key];
      const kids = layout.rail.filter((k) => k.in === key && byId.has(k.id));
      const cur = kids.some((k) => byId.get(k.id).current);
      const kidsHtml = kids
        .map((k) => {
          const item = byId.get(k.id);
          const label = k.label || item.label;
          return `<a href="${item.href}" class="rail-fly-link${item.current ? ' is-current' : ''}"${item.current ? ' aria-current="page"' : ''}><span class="ic" aria-hidden="true">${k.icon}</span><span class="lbl">${esc(label)}</span></a>`;
        })
        .join('');
      out.push(`${groupHtml(r.group)}<button type="button" class="rail-link rail-fly${cur ? ' is-current' : ''}" id="btn-rail-fly-${key}" data-rail-pop="${key}" aria-expanded="false" aria-controls="rail-fly-${key}" title="${esc(f.label)}">
          <span class="ic" aria-hidden="true">${f.icon}</span><span class="short">${esc(f.short)}</span><span class="full">${esc(f.label)}</span><span class="chev full" aria-hidden="true">›</span></button>
        <div class="rail-pop rail-flyout" id="rail-fly-${key}" role="group" aria-label="${esc(f.label)}" data-inline="1" hidden>
          <p class="rail-pop-h">${esc(f.label)}</p>
          <div class="rail-fly-grid">${kidsHtml}</div>
        </div>`);
      continue;
    }
    const item = byId.get(r.id);
    const label = r.label || item.label;
    out.push(`${groupHtml(r.group)}<a href="${item.href}" class="rail-link${item.current ? ' is-current' : ''}" title="${esc(label)}"${item.current ? ' aria-current="page"' : ''}>
          <span class="ic" aria-hidden="true">${r.icon}</span><span class="short">${esc(r.short)}</span><span class="full">${esc(label)}</span></a>`);
  }
  return out.join('');
}

/**
 * The profile preview that opens beside the rail from the avatar. Students also get a
 * progress block that is filled from `my_profile` the first time the preview opens.
 * Exported for tests.
 */
export function buildProfilePreviewHtml(profile, layout, { name, initial, who }) {
  const isStudent = profile?.role === 'student';
  const meta = [who, isStudent ? profile.level : ''].filter(Boolean).join(' · ') || layout.label;
  return `<div class="rail-pop rail-profile" id="rail-account-menu" role="dialog" aria-label="Profile preview" data-anchor="bottom" hidden>
        <div class="rp-head"><span class="rp-av" aria-hidden="true">${esc(initial)}</span><div class="rp-id"><b>${esc(name)}</b><span>${esc(meta)}</span></div></div>
        ${isStudent ? '<div class="rp-xp" data-rp-xp aria-live="polite"><p class="rp-dim">Loading your progress…</p></div>' : ''}
        <div class="rp-actions">
          ${isStudent ? '<a href="/pages/profile.html" class="rp-link"><span class="ic" aria-hidden="true">🏅</span>My profile &amp; badges</a>' : ''}
          <button type="button" class="rp-link" data-rail-action="account"><span class="ic" aria-hidden="true">⚙️</span>Account settings</button>
          <button type="button" class="rp-link danger" data-rail-action="signout"><span class="ic" aria-hidden="true">↩</span>Sign out</button>
        </div>
      </div>`;
}

/**
 * Progress block of the profile preview, from `my_profile` and its tier progress
 * (`tierProgress` in xpRewards.js). Exported for tests.
 */
export function buildProfileXpHtml(data, tp) {
  if (!data || !tp) return '<p class="rp-dim">Finish a practice round to start earning XP.</p>';
  const streak = data.streak || {};
  const rank = data.week_rank || {};
  const next = tp.nextName ? `${fmtNum(tp.toNext)} XP to ${esc(tp.nextName)}` : 'Top tier reached';
  const pct = Math.max(0, Math.min(100, Number(tp.pct) || 0));
  return `<div class="rp-tier"><b>${tp.icon} ${esc(tp.name)}</b><span class="rp-dim">${next}</span></div>
        <div class="rp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Progress to the next tier"><span style="width:${pct}%"></span></div>
        <div class="rp-stats">
          <div><b>${fmtNum(data.season_xp ?? data.total_xp)}</b><span>${data.season_xp == null ? 'Total XP' : 'Season XP'}</span></div>
          <div><b>${fmtNum(data.week_xp)}</b><span>This week</span></div>
          <div><b>🔥 ${fmtNum(streak.current)}</b><span>Day streak</span></div>
          <div><b>${rank.rank ? `#${fmtNum(rank.rank)}` : '—'}</b><span>Week rank</span></div>
        </div>`;
}

/** Fills the student's progress (and photo) the first time the preview opens. */
async function loadProfilePreview(panel) {
  const box = panel.querySelector('[data-rp-xp]');
  if (!box || panel.dataset.loaded) return;
  panel.dataset.loaded = '1';
  try {
    const xp = await import('./xpRewards.js');
    const data = await xp.callXpRpc('my_profile', { p_student: null });
    box.innerHTML = buildProfileXpHtml(data, data ? xp.tierProgress(xp.seasonXp(data), data.tier) : null);
    const path = data?.profile?.avatar_path;
    if (path) {
      const { signAvatarUrls } = await import('./avatars.js');
      const url = (await signAvatarUrls([path])).get(path);
      if (url) {
        document.querySelectorAll('#app-rail .rp-av, #app-rail .rail-avatar .av').forEach((el) => {
          el.innerHTML = `<img src="${esc(url)}" alt="" />`;
          el.classList.add('has-photo');
        });
      }
    }
  } catch (err) {
    console.warn('Profile preview could not load progress:', err);
    box.innerHTML = '<p class="rp-dim">Could not load your progress right now.</p>';
  }
}

function railPopButtons() {
  return [...document.querySelectorAll('#app-rail [data-rail-pop]')];
}

function popPanel(btn) {
  return btn ? document.getElementById(btn.getAttribute('aria-controls')) : null;
}

/** Closes every rail flyout and the profile preview. Returns the button that was open. */
function closeRailPopovers() {
  if (typeof document === 'undefined') return null;
  let wasOpen = null;
  for (const b of railPopButtons()) {
    const panel = popPanel(b);
    if (panel && !panel.hidden) {
      panel.hidden = true;
      wasOpen = b;
    }
    b.setAttribute('aria-expanded', 'false');
    b.classList.remove('is-open');
  }
  return wasOpen;
}

/** Places a fixed popover just right of the rail, beside the button that opened it. */
function placeRailPopover(btn, panel) {
  const rail = document.getElementById('app-rail');
  if (!rail) return;
  if (panel.dataset.inline === '1' && document.body.classList.contains('rail-expanded')) return; // drawn as a group
  const rr = rail.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  panel.style.setProperty('--pop-left', `${Math.round(rr.right + 10)}px`);
  if (panel.dataset.anchor === 'bottom') {
    panel.style.setProperty('--pop-bottom', `${Math.max(8, Math.round(vh - br.bottom))}px`);
  } else {
    const h = panel.offsetHeight || 0;
    const top = Math.max(8, Math.min(br.top - 8, vh - h - 8));
    panel.style.setProperty('--pop-top', `${Math.round(top)}px`);
  }
}

/** Wires the flyouts and the profile preview (open/close, Escape, outside clicks). */
function wireRailPopovers(rail, { onAccount }) {
  for (const btn of rail.querySelectorAll('[data-rail-pop]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = popPanel(btn);
      if (!panel) return;
      const opening = panel.hidden;
      closeRailPopovers();
      if (!opening) return;
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('is-open');
      placeRailPopover(btn, panel);
      if (btn.dataset.railPop === 'profile') loadProfilePreview(panel);
      // Keyboard activation (a click with detail 0) moves focus into the panel
      if (e.detail === 0) panel.querySelector('a, button')?.focus({ preventScroll: true });
    });
  }

  rail.querySelector('#rail-account-menu')?.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-rail-action]')?.getAttribute('data-rail-action');
    if (!action) return;
    closeRailPopovers();
    if (action === 'account') {
      if (typeof onAccount === 'function') onAccount();
      else window.location.href = '/pages/account.html';
    } else if (action === 'signout') {
      await signOut();
    }
  });
  // A fixed flyout would drift from its button if the collapsed rail scrolls
  rail.addEventListener('scroll', () => {
    if (!document.body.classList.contains('rail-expanded')) closeRailPopovers();
  }, { passive: true });

  if (rail.dataset.popListeners) return;
  rail.dataset.popListeners = '1';
  document.addEventListener('click', (e) => {
    for (const b of railPopButtons()) {
      const panel = popPanel(b);
      if (panel && !panel.hidden && !panel.contains(e.target) && !b.contains(e.target)) {
        panel.hidden = true;
        b.setAttribute('aria-expanded', 'false');
        b.classList.remove('is-open');
      }
    }
  });
  // Capture phase: Escape closes an open flyout first; the next Escape closes the sidebar
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const btn = closeRailPopovers();
    if (btn) {
      e.stopImmediatePropagation();
      btn.focus();
    }
  }, true);
  window.addEventListener('resize', () => closeRailPopovers());
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

  const linksHtml = buildRailLinksHtml(layout, byId);

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
      <button type="button" class="rail-avatar" id="btn-rail-account" data-rail-pop="profile" aria-haspopup="dialog" aria-expanded="false" aria-controls="rail-account-menu" title="Profile: ${esc(name)}"><span class="av">${esc(initial)}</span><span class="full">${esc(name)}</span></button>
      ${buildProfilePreviewHtml(profile, layout, { name, initial, who })}
    </div>`;

  const applyExpanded = (expanded) => {
    if (document.body.classList.contains('rail-expanded') !== expanded) closeRailPopovers();
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

  wireRailPopovers(rail, { onAccount });

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
