/**
 * Trendz Tracker — Student "My account" page (js/account.js)
 *
 * Read-only account details (name, ID, level, status, joined date), a summary of the
 * practice access the trainer has set, device preferences (Flash Anzan sound, menu
 * labels), install-app and sign-out. No form collects student information: details
 * are changed by the trainer/admin, and passwords are reset by the trainer.
 */

import { requireAuth } from './guard.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { isSupabaseConfigured } from './config.js';
import { getSupabase } from './supabaseClient.js';
import { resolveStudentProfile } from './dashboardData.js';
import { fetchStudentEffectiveAccess } from './studentAccess.js';
import { registerInstallTrigger, isStandalone } from './pwaInstall.js';
import { logoutUser } from './auth.js';
import { showToast } from './toast.js';

// Same key js/flash.js reads, so the switch here changes the Flash Anzan setting.
const FLASH_SOUND_KEY = 'trendz_flash_sound_v1';

const MEMORIAD_MODULES = 4;

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function formatJoined(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDetails(p) {
  const name = p.full_name || 'Student';
  const code = p.student_code || '—';
  const level = p.level || '—';
  const active = p.active !== false;
  const joined = formatJoined(p.created_at);

  setText('account-avatar', name.trim().charAt(0).toUpperCase() || 'S');
  setText('account-name', name);
  setText('account-code', code);
  setText('account-level', level);
  const joinedFact = document.getElementById('account-joined-fact');
  if (joinedFact) joinedFact.hidden = !joined;
  setText('account-joined', joined);

  const status = document.getElementById('account-status');
  if (status) {
    status.textContent = active ? 'Active' : 'Paused';
    status.classList.toggle('is-off', !active);
  }

  setText('account-detail-name', name);
  setText('account-detail-code', code);
  setText('account-detail-level', level);
  setText('account-detail-status', active ? 'Active' : 'Paused, talk to your trainer');
  setText('account-detail-leaderboard', p.leaderboard_visible === false ? 'Hidden by your trainer' : 'Shown');
  setText('account-detail-joined', joined || '—');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const count = (arr) => (Array.isArray(arr) ? arr.length : 0);

/** One line per practice area: icon, name, and how much of it is open. */
export function summarizeAccess(settings) {
  const s = settings || {};
  const rows = [];

  const basics = s.basics || {};
  const nBasics = count(basics.categories);
  rows.push({
    icon: '➕',
    name: 'Basics',
    state: basics.all ? 'full' : nBasics ? 'some' : 'none',
    text: basics.all ? 'All categories' : nBasics ? plural(nBasics, 'category', 'categories') : 'Not open yet',
  });

  const flashOn = (s.flash || {}).allowed !== false;
  rows.push({ icon: '⚡', name: 'Flash Anzan', state: flashOn ? 'full' : 'none', text: flashOn ? 'Open' : 'Not open yet' });

  const el = s.elements || {};
  const nDrills = count(el.drills);
  rows.push({
    icon: '🧩',
    name: 'Elements',
    state: el.all ? 'full' : nDrills ? 'some' : 'none',
    text: el.all ? 'All drills' : nDrills ? plural(nDrills, 'drill', 'drills') : 'Not open yet',
  });

  const mem = s.memoriad || {};
  const nMods = count(mem.modules);
  rows.push({
    icon: '🧠',
    name: 'Memoriad',
    state: mem.all ? 'full' : nMods ? 'some' : 'none',
    text: mem.all ? 'All modules' : nMods ? `${nMods} of ${MEMORIAD_MODULES} modules` : 'Not open yet',
  });

  const mr = s.main_round || {};
  const nMr = count(mr.categories);
  rows.push({
    icon: '📝',
    name: 'Main round',
    state: mr.all ? 'full' : nMr ? 'some' : 'none',
    text: mr.all ? 'All categories' : nMr ? plural(nMr, 'category', 'categories') : 'Not open yet',
  });
  return rows;
}

async function renderAccess(profile) {
  const list = document.getElementById('account-access-list');
  if (!list) return;
  let settings = profile.practice_access || null;
  let sourceLabel = '';
  try {
    const isDemo = isDemoMode();
    const supabase = !isDemo && isSupabaseConfigured() ? await getSupabase() : null;
    const res = await fetchStudentEffectiveAccess(profile.id, { supabase, isDemo, DemoDB: isDemo ? DemoDB : null });
    if (res?.ok && res.settings) {
      settings = res.settings;
      sourceLabel = res.has_override ? 'Set for you by your trainer' : `Set for ${res.level || 'your level'}`;
    }
  } catch {
    /* fall back to whatever the profile carried */
  }

  if (!settings) {
    list.innerHTML = '<li class="ac-loading">Could not load your practice access. Try again later.</li>';
    return;
  }
  if (sourceLabel) setText('account-access-source', sourceLabel);
  const label = { full: 'Open', some: 'Some', none: 'Locked' };
  list.innerHTML = summarizeAccess(settings)
    .map(
      (r) => `<li class="ac-acc is-${r.state}">
        <span class="ac-acc-ic" aria-hidden="true">${r.icon}</span>
        <span class="ac-acc-t"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.text)}</span></span>
        <span class="ac-acc-pill">${label[r.state]}</span>
      </li>`
    )
    .join('');
}

function setupPreferences() {
  const sound = document.getElementById('pref-flash-sound');
  if (sound) {
    try {
      sound.checked = localStorage.getItem(FLASH_SOUND_KEY) === 'true';
    } catch {
      sound.checked = false;
    }
    sound.addEventListener('change', () => {
      try {
        localStorage.setItem(FLASH_SOUND_KEY, String(sound.checked));
        showToast('success', sound.checked ? 'Flash Anzan sound is on.' : 'Flash Anzan sound is off.', 2500);
      } catch {
        showToast('error', 'Could not save this setting on this device.');
      }
    });
  }

  const labels = document.getElementById('pref-rail-expanded');
  if (labels) {
    const sync = () => {
      labels.checked = document.body.classList.contains('rail-expanded');
    };
    sync();
    labels.addEventListener('change', () => {
      // Reuse the side menu's own toggle so its saved state and labels stay in step.
      const toggle = document.getElementById('btn-rail-toggle');
      if (toggle && labels.checked !== document.body.classList.contains('rail-expanded')) toggle.click();
      sync();
    });
    document.getElementById('btn-rail-toggle')?.addEventListener('click', () => setTimeout(sync, 0));
  }
}

function setupActions() {
  const installRow = document.getElementById('account-install-row');
  if (installRow && !isStandalone()) {
    registerInstallTrigger(installRow);
  }

  document.getElementById('btn-account-signout')?.addEventListener('click', async () => {
    const headerLogout = document.getElementById('btn-header-logout');
    if (headerLogout) headerLogout.click();
    else await logoutUser();
  });
}

async function initAccountPage() {
  const profile = await requireAuth(['student']);
  if (!profile) return;

  renderDetails(profile);
  setupPreferences();
  setupActions();

  // Fill in fields the cached profile may not carry (joined date, leaderboard visibility).
  resolveStudentProfile(profile.id)
    .then((full) => {
      if (full) renderDetails({ ...profile, ...full });
    })
    .catch(() => {});

  renderAccess(profile);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initAccountPage);
}
