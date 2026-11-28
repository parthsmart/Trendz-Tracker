/**
 * Trendz Tracker — "My account" page for every role (js/account.js)
 *
 * Students: read-only details (name, ID, level, status, joined date), a summary of the
 * practice access the trainer has set, device preferences (Flash Anzan sound, menu
 * labels), install-app and sign-out.
 * Teachers and admins: the same page with their role, what they are allowed to do
 * (teacher permissions, or full access for admins), menu labels, install and sign-out.
 * No form collects personal information; details are changed by an admin.
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
import { signAvatarUrl } from './avatars.js';
import { celebrate, getAutoMotionLevel } from './motion.js';
import { getPrefs, setPrefs, onPrefsChange } from './prefs.js';
import { cue, canVibrate, previewMusic, isMusicPlaying, stopMusic } from './feedback.js';

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
  if (p.avatar_path) showAccountPhoto(p.avatar_path);
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

/** Replaces the initial with the student's photo when they have one. */
async function showAccountPhoto(path) {
  const url = await signAvatarUrl(path);
  const el = document.getElementById('account-avatar');
  if (!url || !el) return;
  el.textContent = '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;display:block';
  el.style.overflow = 'hidden';
  el.appendChild(img);
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

const MOTION_LABELS = { full: 'Full', lite: 'Light', off: 'Off' };
const THEME_NOTES = { system: 'Follows your device', light: 'Always light', dark: 'Always dark' };

function motionNote(pref) {
  if (pref === 'off') return 'Animations and moving effects are off';
  if (pref !== 'auto') return 'Your choice';
  return `Auto picked ${MOTION_LABELS[getAutoMotionLevel()] || 'Full'} for this device`;
}

function bindSwitch(id, key, onChange) {
  const input = document.getElementById(id);
  if (!input || input.dataset.ready) return;
  input.dataset.ready = '1';
  input.addEventListener('change', () => {
    const next = setPrefs({ [key]: input.checked });
    onChange?.(next);
  });
}

/** Fills the Settings card from the current settings (also when another device's copy arrives). */
function renderSettings(p = getPrefs()) {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(v);
  };
  set('pref-sound', p.sound);
  set('pref-music', p.music);
  set('pref-music-tests', p.musicInTests);
  set('pref-vibrate', p.vibrate && canVibrate());
  set('pref-large-numbers', p.largeNumbers);
  const vol = document.getElementById('pref-volume');
  if (vol) vol.value = String(p.volume);
  document.getElementById('pref-volume-row')?.classList.toggle('is-off', !p.sound);
  document.getElementById('pref-music-tests-row')?.classList.toggle('is-off', !p.music);
  const testsInput = document.getElementById('pref-music-tests');
  if (testsInput) testsInput.disabled = !p.music;
  document.querySelectorAll('#pref-theme [data-theme-choice]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeChoice === p.theme));
  });
  const themeNote = document.getElementById('pref-theme-note');
  if (themeNote) themeNote.textContent = THEME_NOTES[p.theme] || THEME_NOTES.system;
  const motion = document.getElementById('pref-motion');
  if (motion) motion.value = p.motion;
  const motionText = document.getElementById('pref-motion-note');
  if (motionText) motionText.textContent = motionNote(p.motion);
}

function setupSettingsPanel(profile) {
  const card = document.getElementById('settings');
  if (!card || card.dataset.ready) return;
  card.dataset.ready = '1';
  const saved = document.getElementById('pref-saved-note');
  if (saved && profile?.id && !isDemoMode()) saved.textContent = 'Saved to your account, on every device';

  if (!canVibrate()) {
    const v = document.getElementById('pref-vibrate');
    if (v) v.disabled = true;
    const note = document.getElementById('pref-vibrate-note');
    if (note) note.textContent = 'This device or browser cannot vibrate';
    document.getElementById('pref-vibrate-row')?.classList.add('is-off');
  }

  bindSwitch('pref-sound', 'sound', (p) => {
    if (p.sound) cue('correct');
  });
  bindSwitch('pref-music', 'music', (p) => {
    if (!p.music && isMusicPlaying()) stopMusic();
  });
  bindSwitch('pref-music-tests', 'musicInTests');
  bindSwitch('pref-vibrate', 'vibrate', (p) => {
    if (p.vibrate) cue('correct');
  });
  bindSwitch('pref-large-numbers', 'largeNumbers');

  document.getElementById('pref-volume')?.addEventListener('change', (e) => {
    setPrefs({ volume: Number(e.target.value) });
    cue('correct');
  });
  card.querySelectorAll('[data-try-cue]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = getPrefs();
      if (!p.sound) {
        showToast('info', 'Sound effects are off. Turn them on to hear this.', 2500);
        return;
      }
      cue(btn.dataset.tryCue);
      if (btn.dataset.tryCue === 'pb') celebrate('pb', btn);
    });
  });
  document.getElementById('pref-music-try')?.addEventListener('click', (e) => {
    if (isMusicPlaying()) {
      stopMusic();
      e.currentTarget.textContent = '▶ Listen';
      return;
    }
    previewMusic(8000);
    const btn = e.currentTarget;
    btn.textContent = '■ Stop';
    setTimeout(() => {
      btn.textContent = '▶ Listen';
    }, 8000);
  });
  card.querySelectorAll('#pref-theme [data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const root = document.documentElement;
      root.classList.add('tt-theme-switching');
      setPrefs({ theme: btn.dataset.themeChoice });
      setTimeout(() => root.classList.remove('tt-theme-switching'), 400);
    });
  });
  document.getElementById('pref-motion')?.addEventListener('change', (e) => {
    const next = setPrefs({ motion: e.target.value });
    if (next.motion !== 'off') celebrate('small', e.target);
  });

  renderSettings();
  onPrefsChange(renderSettings);
}

function setupPreferences(profile = null) {
  setupSettingsPanel(profile);
  const sound = document.getElementById('pref-flash-sound');
  if (sound && !sound.dataset.ready) {
    sound.dataset.ready = '1';
    try {
      sound.checked = localStorage.getItem(FLASH_SOUND_KEY) === 'true';
    } catch {
      sound.checked = false;
    }
    sound.addEventListener('change', () => {
      try {
        localStorage.setItem(FLASH_SOUND_KEY, String(sound.checked));
        showToast('success', sound.checked ? 'Flash Anzan beep is on.' : 'Flash Anzan beep is off.', 2500);
      } catch {
        showToast('error', 'Could not save this setting on this device.');
      }
    });
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

/** Teacher permission keys, in the order the Teachers page lists them. Exported for tests. */
export const TEACHER_PERMISSIONS = [
  { key: 'can_view_students', icon: '👥', name: 'View students', text: 'See your assigned students and their practice' },
  { key: 'can_mark_attendance', icon: '✅', name: 'Mark attendance', text: 'Take attendance for your classes' },
  { key: 'can_correct_attendance', icon: '✏️', name: 'Correct attendance', text: 'Change attendance already marked' },
  { key: 'can_review_scores', icon: '🔍', name: 'Review scores', text: 'Verify scores students enter' },
  { key: 'can_request_corrections', icon: '↩️', name: 'Request corrections', text: 'Ask students to fix a score' },
  { key: 'can_manage_tasks', icon: '☑️', name: 'Manage tasks', text: 'Set daily to-dos and homework' },
  { key: 'can_manage_tests', icon: '📝', name: 'Manage weekly tests', text: 'Create tests and enter results' },
  { key: 'can_generate_reports', icon: '📊', name: 'Monthly reports', text: 'Open and print student reports' },
  { key: 'can_publish_announcements', icon: '📣', name: 'Announcements', text: 'Post news to students' },
  { key: 'can_manage_resources', icon: '📁', name: 'Resources', text: 'Share files and links' },
  { key: 'can_schedule_live_classes', icon: '🎥', name: 'Schedule live classes', text: 'Book classes for your students', defaultOff: true },
];

/** One row per teacher permission. Missing keys count as allowed, as in the navigation, except defaultOff ones. */
export function summarizeTeacherPermissions(permissions) {
  const p = permissions || {};
  return TEACHER_PERMISSIONS.map((perm) => ({
    icon: perm.icon,
    name: perm.name,
    text: perm.text,
    state: (perm.defaultOff ? p[perm.key] === true : p[perm.key] !== false) ? 'full' : 'none',
  }));
}

const ADMIN_SUMMARY = [
  { icon: '👥', name: 'Students and teachers', text: 'Add students, manage teachers and access', state: 'full' },
  { icon: '🔍', name: 'Results', text: 'Review scores, weekly tests and reports', state: 'full' },
  { icon: '🎥', name: 'Classes', text: 'Attendance, live classes and homework', state: 'full' },
  { icon: '⚙️', name: 'Settings', text: 'Categories, rounds, targets, import and backup', state: 'full' },
];

function renderAccessRows(listId, rows, labels) {
  const list = document.getElementById(listId);
  if (!list) return;
  list.innerHTML = rows
    .map(
      (r) => `<li class="ac-acc is-${r.state}">
        <span class="ac-acc-ic" aria-hidden="true">${r.icon}</span>
        <span class="ac-acc-t"><b>${escapeHtml(r.name)}</b><span>${escapeHtml(r.text)}</span></span>
        <span class="ac-acc-pill">${labels[r.state]}</span>
      </li>`
    )
    .join('');
}

function showRoleSections(isStaff) {
  document.querySelectorAll('[data-account-role]').forEach((el) => {
    const want = el.getAttribute('data-account-role');
    el.hidden = isStaff ? want !== 'staff' : want !== 'student';
  });
}

function renderStaffAccount(p) {
  const isAdmin = p.role === 'admin';
  const roleLabel = isAdmin ? 'Admin' : 'Teacher';
  const name = p.full_name || roleLabel;
  const code = p.student_code || '—';
  const active = p.active !== false;
  const joined = formatJoined(p.created_at);

  setText('account-avatar', name.trim().charAt(0).toUpperCase() || roleLabel.charAt(0));
  setText('account-name', name);
  setText('account-code', code);
  setText('account-level-icon', isAdmin ? '🛡️' : '🧑‍🏫');
  setText('account-level', roleLabel);
  const joinedFact = document.getElementById('account-joined-fact');
  if (joinedFact) joinedFact.hidden = !joined;
  setText('account-joined', joined);
  const status = document.getElementById('account-status');
  if (status) {
    status.textContent = active ? 'Active' : 'Paused';
    status.classList.toggle('is-off', !active);
  }

  const links = document.getElementById('account-hero-links');
  if (links) {
    links.innerHTML = isAdmin
      ? '<a href="/pages/admin.html" class="btn btn-outline btn-sm">🏠 Overview</a><a href="/pages/settings.html" class="btn btn-outline btn-sm">⚙️ Settings</a>'
      : '<a href="/pages/teacher.html" class="btn btn-outline btn-sm">🏠 Overview</a><a href="/pages/live-classes.html" class="btn btn-outline btn-sm">🎥 Live classes</a>';
  }

  setText('account-details-sub', isAdmin ? 'Your sign-in profile' : 'Ask an admin to change these');
  setText('account-detail-name', name);
  setText('account-detail-code-label', 'Sign-in ID');
  setText('account-detail-code', code);
  setText('account-detail-level-label', 'Role');
  setText('account-detail-level', roleLabel);
  setText('account-detail-status', active ? 'Active' : 'Paused');
  setText('account-detail-joined', joined || '—');

  if (isAdmin) {
    setText('account-perms-source', 'Admins can open every page');
    renderAccessRows('account-perms-list', ADMIN_SUMMARY, { full: 'Full', none: 'Off' });
    setText('account-password-text', 'Admin passwords are changed by the Trendz system owner.');
    setText('account-password-tag', '🔒 Managed centrally');
  } else {
    const rows = summarizeTeacherPermissions(p.permissions);
    const allowed = rows.filter((r) => r.state === 'full').length;
    setText('account-perms-source', `${allowed} of ${rows.length} allowed · set by an admin`);
    renderAccessRows('account-perms-list', rows, { full: 'Allowed', none: 'Off' });
    setText('account-password-text', 'Forgot it or want a new one? Ask an admin to reset it from the Teachers page.');
    setText('account-password-tag', '🔒 Managed by an admin');
  }
}

async function initAccountPage() {
  const profile = await requireAuth(['student', 'teacher', 'admin']);
  if (!profile) return;

  if (profile.role !== 'student') {
    showRoleSections(true);
    renderStaffAccount(profile);
    setupPreferences(profile);
    setupActions();
    return;
  }

  showRoleSections(false);
  renderDetails(profile);
  setupPreferences(profile);
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
