/**
 * Trendz Tracker - tournaments on the Live Duel page (js/tournament.js)
 *
 * The Tournaments tab (#ld-tourney) for students and the tournament part of the staff
 * panel (#ld-staff-tourney). Check-in goes through /api/drill (action
 * 'tournament_check_in'), which starts the match's live duel once both players are in.
 * Everything else is a SECURITY DEFINER RPC (supabase/migrations/*_live_duel_tournaments.sql):
 * my_tournaments, tournament_state (polled while a bracket is open; it also moves the
 * tournament on), tournament_join / tournament_leave, and for staff tournaments_staff,
 * tournament_create and tournament_cancel.
 */

import { signAvatarUrls } from './avatars.js';
import {
  buildBracketHtml,
  buildMatchCardHtml,
  buildTournamentHomeHtml,
  buildTournamentStaffHtml,
} from './tournamentView.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
export const TOURNEY_KEY = 'ld-tourney';

const ts = {
  deps: null,
  root: null,     // the element the list / bracket is drawn in
  staff: false,
  id: null,       // open bracket
  state: null,
  offset: 0,
  poll: null,
  tick: null,
  avatars: new Map(),
  checkingIn: false,
  autoCheck: 0,
};

const serverNow = () => Date.now() + ts.offset;

function remember(id) {
  try {
    if (id) sessionStorage.setItem(TOURNEY_KEY, id);
    else sessionStorage.removeItem(TOURNEY_KEY);
  } catch { /* private mode */ }
}
export function rememberedTournament() {
  try { return sessionStorage.getItem(TOURNEY_KEY); } catch { return null; }
}

function stop() {
  clearInterval(ts.poll);
  clearInterval(ts.tick);
  ts.poll = null;
  ts.tick = null;
}

/** Student tab. Opens the bracket of a running tournament I am in, if there is one. */
export async function loadTournamentHome({ open = rememberedTournament() } = {}) {
  ts.root = $('ld-tourney');
  ts.staff = false;
  stop();
  const { data, error } = await ts.deps.rpc('my_tournaments');
  if (error || !data) {
    ts.root.innerHTML = '<p class="ar-dim">Could not load tournaments. Please refresh.</p>';
    return;
  }
  const list = data.tournaments || [];
  const live = list.find((t) => t.joined && t.status === 'running');
  const wanted = list.find((t) => t.id === open) || live;
  if (wanted && (wanted.status === 'running' || wanted.status === 'done' || wanted.id === open)) {
    return openBracket(wanted.id);
  }
  ts.id = null;
  ts.root.innerHTML = buildTournamentHomeHtml(data, Date.now(), { disabled: !ts.deps.enabled() });
  return null;
}

/** Staff panel: create form and list. */
export async function loadTournamentStaff() {
  ts.root = $('ld-staff-tourney');
  ts.staff = true;
  stop();
  ts.id = null;
  const { data, error } = await ts.deps.rpc('tournaments_staff');
  if (error || !data) {
    ts.root.innerHTML = '<p class="ar-dim">Could not load tournaments.</p>';
    return;
  }
  ts.root.innerHTML = buildTournamentStaffHtml(data, Date.now());
}

async function fetchState() {
  const sent = Date.now();
  const { data } = await ts.deps.rpc('tournament_state', { p_tournament: ts.id });
  if (!data) return null;
  ts.offset = Date.parse(data.server_now) + (Date.now() - sent) / 2 - Date.now();
  const missing = (data.entries || []).map((e) => e.avatar).filter((a) => a && !ts.avatars.has(a));
  if (missing.length) {
    const urls = await signAvatarUrls(missing);
    urls.forEach((v, k) => ts.avatars.set(k, v));
  }
  return data;
}

function render() {
  if (!ts.state || !ts.root) return;
  const now = serverNow();
  const card = ts.staff ? '' : buildMatchCardHtml(ts.state, now, { checkingIn: ts.checkingIn });
  ts.root.innerHTML = `${card ? `<div id="tn-card" aria-live="polite">${card}</div>` : ''}${buildBracketHtml(ts.state, now, ts.avatars)}`;
}

/** Only the match card changes every second; the bracket redraws on each poll. */
function renderCard() {
  const el = $('tn-card');
  if (!el || !ts.state || ts.staff) return;
  el.innerHTML = buildMatchCardHtml(ts.state, serverNow(), { checkingIn: ts.checkingIn });
}

async function refresh() {
  if (!ts.id) return;
  const id = ts.id;
  const s = await fetchState();
  if (id !== ts.id) return;
  if (!s) {
    stop();
    ts.root.innerHTML = '<p class="ar-dim">Tournament not found.</p>';
    return;
  }
  const before = ts.state;
  ts.state = s;
  render();
  if (!ts.staff) maybeEnterDuel(before, s);
  if (s.status === 'done' || s.status === 'cancelled') stop();
}

/** Both checked in: whoever's API call did not create the duel still needs to start it. */
function maybeEnterDuel(before, s) {
  const me = (s.entries || []).find((e) => e.me);
  if (!me) return;
  const m = (s.matches || []).find((x) => (x.a_id === me.id || x.b_id === me.id) && x.status === 'live' && x.duel_id);
  if (m && !ts.deps.inDuel()) {
    ts.deps.enterDuel(m.duel_id);
    return;
  }
  const ready = (s.matches || []).find((x) => (x.a_id === me.id || x.b_id === me.id) && x.status === 'ready' && x.a_in && x.b_in);
  if (ready && Date.now() - ts.autoCheck > 8000) {
    ts.autoCheck = Date.now();
    checkIn(ready.id, { quiet: true });
  }
}

export async function openBracket(id) {
  stop();
  ts.id = id;
  ts.state = null;
  if (!ts.staff) remember(id);
  ts.root.innerHTML = '<p class="ar-dim">Loading the bracket…</p>';
  await refresh();
  if (ts.id !== id || !ts.state) return;
  if (ts.state.status === 'signup' || ts.state.status === 'running') {
    ts.poll = setInterval(refresh, POLL_MS);
    ts.tick = setInterval(renderCard, 1000);
  }
}

async function checkIn(matchId, { quiet = false } = {}) {
  ts.checkingIn = true;
  renderCard();
  try {
    const res = await ts.deps.drillApi({ action: 'tournament_check_in', match_id: matchId });
    if (res.duel_id) {
      ts.deps.enterDuel(res.duel_id);
      return;
    }
    await refresh();
  } catch (err) {
    if (!quiet) ts.deps.showToast('error', err.message);
    await refresh();
  } finally {
    ts.checkingIn = false;
    renderCard();
  }
}

function toIso(local) {
  const t = Date.parse(local);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function create(form) {
  const f = new FormData(form);
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  const { error } = await ts.deps.rpc('tournament_create', {
    p_name: String(f.get('name') || ''),
    p_level: String(f.get('level') || ''),
    p_max_players: Number(f.get('size')),
    p_centre: f.get('centre') || null,
    p_signup_opens_at: toIso(f.get('opens')),
    p_signup_closes_at: toIso(f.get('closes')),
    p_start_at: toIso(f.get('start')),
    p_round_minutes: Number(f.get('round_minutes')) || 10,
  });
  btn.disabled = false;
  if (error) {
    ts.deps.showToast('error', error);
    return;
  }
  ts.deps.showToast('success', 'Tournament created. Students at that level can sign up now.');
  await loadTournamentStaff();
}

function onClick(e) {
  const t = e.target.closest('[data-tn-join],[data-tn-leave],[data-tn-open],[data-tn-back],[data-tn-checkin],[data-tn-duel],[data-tn-cancel]');
  if (!t) return;
  const d = t.dataset;
  if (d.tnOpen) return openBracket(d.tnOpen);
  if (t.hasAttribute('data-tn-back')) {
    stop();
    ts.id = null;
    remember(null);
    return ts.staff ? loadTournamentStaff() : loadTournamentHome({ open: null });
  }
  if (d.tnCheckin) return checkIn(d.tnCheckin);
  if (d.tnDuel) return ts.deps.enterDuel(d.tnDuel);
  return (async () => {
    t.disabled = true;
    if (d.tnJoin || d.tnLeave) {
      const { error } = await ts.deps.rpc(d.tnJoin ? 'tournament_join' : 'tournament_leave', { p_tournament: d.tnJoin || d.tnLeave });
      if (error) ts.deps.showToast('error', error);
      else ts.deps.showToast('success', d.tnJoin ? "You're signed up! Come back at the start time." : 'You left the tournament.');
      return loadTournamentHome({ open: null });
    }
    if (d.tnCancel) {
      if (!window.confirm('Cancel this tournament? Matches stop and nobody gets prizes.')) { t.disabled = false; return null; }
      const { error } = await ts.deps.rpc('tournament_cancel', { p_tournament: d.tnCancel });
      if (error) ts.deps.showToast('error', error);
      return loadTournamentStaff();
    }
    return null;
  })();
}

/**
 * deps: { rpc, drillApi, showToast, enabled, enterDuel(id), inDuel() }.
 * Call once; the listeners work for both the student tab and the staff panel.
 */
export function setupTournaments(deps) {
  ts.deps = deps;
  ['ld-tourney', 'ld-staff-tourney'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('click', onClick);
    el.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-tn-create]')) return;
      e.preventDefault();
      create(e.target);
    });
  });
}

/** The page is leaving the tab (or entering a duel): stop polling. */
export function pauseTournaments() {
  stop();
}

/** A 'tournament_ready' push: refresh whatever is open. */
export function onTournamentReady() {
  if (ts.id && !ts.staff) refresh();
  else if (ts.root && !ts.staff && !$('ld-tourney')?.closest('[hidden]')) loadTournamentHome();
}
