/**
 * Trendz Tracker - live duel page (js/liveDuel.js)
 *
 * Students: lobby (quick match, live challenges, rating, top duellists), then a
 * 60-second race against a classmate or a ghost with both progress lanes moving
 * live, then results with XP, rating change and rematch.
 * Teachers and admins: recent live duels, too-fast flags, and (admins) the switch.
 *
 * The server owns the clock and the score. The page never sees expected answers:
 * each answer goes to the live_duel_answer RPC, which grades it and broadcasts
 * progress on the private Realtime channel duel:<id>. If the socket drops the page
 * falls back to polling live_duel_state. Reloading with ?duel=<id> resumes.
 */

import { requireAuth } from './guard.js';
import { showToast } from './toast.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { celebrate } from './motion.js';
import { getDuelHub } from './duelPresence.js';
import { ensureAvatarStyles, signAvatarUrls } from './avatars.js';
import {
  GHOST_WAIT_SECONDS,
  LIVE_DUEL_GRACE_SECONDS,
  LIVE_DUEL_MIN_MS_PER_ANSWER,
  LIVE_DUEL_EMOTES,
  secondsLeft,
  timelineProgress,
} from '../shared/liveDuel.js';
import {
  buildBoardHtml,
  buildEmoteBarHtml,
  buildGhostOptionsHtml,
  buildInvitesHtml,
  buildLanesHtml,
  buildOnlinePlayersHtml,
  buildQuestionHtml,
  buildRatingHtml,
  buildRecentHtml,
  buildResultHtml,
  buildStaffHtml,
} from './liveDuelView.js';

const $ = (id) => document.getElementById(id);
const MUTE_KEY = 'tt.liveDuel.muted';
const VIEWS = ['ld-lobby', 'ld-search', 'ld-waiting', 'ld-race', 'ld-results', 'ld-staff'];

const st = {
  viewer: null,
  supabase: null,
  hub: null,
  players: new Map(), // id -> live_duel_online_players row
  presenceSeen: false,
  duelChannel: null,
  duelChannelOk: false,
  online: new Set(),
  opponents: [],
  home: null,
  searching: false,
  searchTimer: null,
  duel: null, // last live_duel_state
  offset: 0, // server clock minus local clock (ms)
  index: 0, // next question index to answer
  sending: Promise.resolve(),
  mine: 0,
  theirs: 0,
  tick: null,
  poll: null,
  settling: false,
  muted: false,
};

function show(view) {
  for (const v of VIEWS) if ($(v)) $(v).hidden = v !== view;
}

const serverNow = () => Date.now() + st.offset;

/* ------------------------------------------------------------ Network */

async function rpc(name, args = {}) {
  try {
    const { data, error } = await st.supabase.rpc(name, args);
    if (error) return { data: null, error: error.message || 'Something went wrong.' };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err?.message || 'Something went wrong.' };
  }
}

async function token() {
  const { data } = await st.supabase.auth.getSession();
  return data?.session?.access_token || null;
}

async function drillApi(body) {
  const t = await token();
  const resp = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

async function privateChannel(topic, handlers, presenceKey) {
  const t = await token();
  if (t) await st.supabase.realtime.setAuth(t);
  const ch = st.supabase.channel(topic, { config: { private: true, presence: presenceKey ? { key: presenceKey } : undefined } });
  for (const [event, fn] of Object.entries(handlers.broadcast || {})) {
    ch.on('broadcast', { event }, (msg) => fn(msg.payload || {}));
  }
  if (handlers.presence) ch.on('presence', { event: 'sync' }, () => handlers.presence(ch.presenceState()));
  ch.subscribe((status) => {
    if (handlers.status) handlers.status(status);
    if (status === 'SUBSCRIBED' && presenceKey) ch.track({ id: presenceKey, at: Date.now() }).catch(() => {});
  });
  return ch;
}

/* -------------------------------------------------------------- Lobby */

async function loadLobby() {
  const [home, board] = await Promise.all([rpc('my_live_duels'), rpc('live_duel_board')]);
  st.home = home.data;
  if (home.error || !home.data) {
    $('ld-lobby-body').innerHTML = '<p class="ar-dim">Could not load live duels. Please refresh.</p>';
    return;
  }
  if (home.data.active) {
    enterDuel(home.data.active);
    return;
  }
  $('ld-off').hidden = home.data.enabled !== false;
  $('ld-quick').disabled = home.data.enabled === false;
  $('ld-rating').innerHTML = buildRatingHtml(home.data.rating);
  $('ld-invites').innerHTML = buildInvitesHtml(home.data.invites, home.data.sent);
  $('ld-recent').innerHTML = buildRecentHtml(home.data.recent);
  $('ld-board').innerHTML = board.error ? '' : buildBoardHtml(board.data);
  renderMates();
  show('ld-lobby');
}

function renderMates() {
  if (!$('ld-mates')) return;
  ensureAvatarStyles(document);
  const list = [...st.online].map((id) => st.players.get(id)).filter(Boolean)
    .sort((x, y) => Number(y.classmate) - Number(x.classmate) || String(x.display_name).localeCompare(String(y.display_name)));
  $('ld-mates').innerHTML = buildOnlinePlayersHtml(list, { loading: !st.presenceSeen });
}

async function onPresence(ids) {
  st.online = new Set(ids);
  st.presenceSeen = true;
  const missing = ids.filter((id) => !st.players.has(id));
  if (missing.length) {
    const { data } = await rpc('live_duel_online_players', { p_ids: missing.slice(0, 300) });
    for (const id of missing) if (!st.players.has(id)) st.players.set(id, null); // not at my level / not listed
    const found = Array.isArray(data) ? data : [];
    const urls = await signAvatarUrls(found.map((p) => p.avatar_path).filter(Boolean)).catch(() => new Map());
    for (const p of found) st.players.set(p.id, { ...p, url: urls.get(p.avatar_path) || null });
  }
  renderMates();
}

async function startSearch() {
  if (st.searching) return;
  st.searching = true;
  show('ld-search');
  $('ld-search-text').textContent = 'Looking for a student at your level…';
  const loop = async () => {
    if (!st.searching) return;
    try {
      const res = await drillApi({ action: 'live_queue' });
      if (!st.searching) return;
      if (res.duel_id) return foundDuel(res.duel_id);
      const waited = Number(res.waited_seconds) || 0;
      const left = Math.max(0, (Number(res.ghost_after) || GHOST_WAIT_SECONDS) - waited);
      $('ld-search-text').textContent = left > 0
        ? `Looking for a student at your level… (${Math.ceil(left)}s)`
        : 'Nobody free right now. Racing a ghost runner instead…';
      if (left <= 0) {
        const g = await drillApi({ action: 'live_ghost' });
        if (st.searching && g.duel_id) return foundDuel(g.duel_id);
      }
    } catch (err) {
      stopSearch();
      showToast('error', err.message);
      return;
    }
    st.searchTimer = setTimeout(loop, 2500);
  };
  loop();
}

function stopSearch({ leave = true } = {}) {
  st.searching = false;
  clearTimeout(st.searchTimer);
  if (leave) rpc('live_duel_leave_queue');
  loadLobby();
}

function foundDuel(id) {
  st.searching = false;
  clearTimeout(st.searchTimer);
  enterDuel(id);
}

/* --------------------------------------------------------- Mode tabs */

const MODES = ['duel', 'ghost'];

function setMode(mode) {
  const m = MODES.includes(mode) ? mode : 'duel';
  document.querySelectorAll('[data-ld-mode]').forEach((b) => {
    const on = b.dataset.ldMode === m;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('[data-ld-pane]').forEach((p) => { p.hidden = p.dataset.ldPane !== m; });
  const url = new URL(window.location.href);
  if (m === 'duel') url.searchParams.delete('mode');
  else url.searchParams.set('mode', m);
  window.history.replaceState(null, '', url);
  if (m === 'ghost') loadGhostOptions();
}

async function loadGhostOptions() {
  try {
    const opts = await drillApi({ action: 'ghost_options' });
    $('ld-ghost').innerHTML = buildGhostOptionsHtml(opts, { disabled: st.home?.enabled === false });
  } catch {
    $('ld-ghost').innerHTML = '<p class="ar-dim">Could not load ghost races. Please refresh.</p>';
  }
}

function setupModeActions() {
  document.querySelectorAll('[data-ld-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.ldMode)));
  $('ld-ghost').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ghost-target]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      const res = await drillApi({ action: 'live_ghost', target: btn.dataset.ghostTarget });
      enterDuel(res.duel_id);
    } catch (err) {
      showToast('error', err.message);
      btn.disabled = false;
      btn.textContent = '👻 Start race';
    }
  });
}

function setupLobbyActions() {
  $('ld-quick').addEventListener('click', startSearch);
  $('ld-search-cancel').addEventListener('click', () => stopSearch());
  $('ld-lobby').addEventListener('click', async (e) => {
    const challenge = e.target.closest('[data-challenge]');
    const accept = e.target.closest('[data-accept]');
    const decline = e.target.closest('[data-decline]');
    const cancel = e.target.closest('[data-cancel-invite]');
    const btn = challenge || accept || decline || cancel;
    if (!btn) return;
    btn.disabled = true;
    try {
      if (challenge) {
        challenge.textContent = 'Sending…';
        await drillApi({ action: 'live_invite', opponent_id: challenge.dataset.challenge });
        showToast('success', 'Challenge sent! They get a pop-up to accept or reject.');
      } else if (accept || decline) {
        const id = (accept || decline).dataset.accept || (accept || decline).dataset.decline;
        st.hub?.closePopup(id);
        const { data, error } = await rpc('live_duel_respond', { p_duel: id, p_accept: Boolean(accept) });
        if (error || !data?.ok) throw new Error(error || data?.error || 'That challenge has ended.');
        if (accept) return enterDuel(id);
      } else {
        await rpc('live_duel_cancel', { p_duel: cancel.dataset.cancelInvite });
      }
      await loadLobby();
    } catch (err) {
      showToast('error', err.message);
      btn.disabled = false;
      if (challenge) challenge.textContent = 'Challenge';
    }
  });
}

/* --------------------------------------------------------------- Duel */

async function fetchState(id) {
  const sent = Date.now();
  const { data, error } = await rpc('live_duel_state', { p_duel: id });
  if (error || !data) return null;
  const rtt = Date.now() - sent;
  const offset = Date.parse(data.server_now) + rtt / 2 - Date.now();
  // Keep the first good estimate steady; only nudge it for large drift.
  if (!st.duel || st.duel.id !== data.id || Math.abs(offset - st.offset) > 400) st.offset = offset;
  return data;
}

async function enterDuel(id) {
  const url = new URL(window.location.href);
  url.searchParams.set('duel', id);
  window.history.replaceState(null, '', url);
  const state = await fetchState(id);
  if (!state) {
    showToast('error', 'Duel not found.');
    leaveDuelView();
    return;
  }
  const fresh = !st.duel || st.duel.id !== id;
  st.duel = state;
  if (fresh) {
    st.index = Number(state.me?.attempted) || 0;
    st.mine = Number(state.me?.correct) || 0;
    st.theirs = Number(state.other?.correct) || 0;
    st.sending = Promise.resolve();
    st.settling = false;
    await joinDuelChannel(id, state);
  }
  route();
}

function leaveDuelView() {
  clearInterval(st.tick);
  clearInterval(st.poll);
  if (st.duelChannel) st.supabase.removeChannel(st.duelChannel);
  st.duelChannel = null;
  st.duel = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('duel');
  window.history.replaceState(null, '', url);
  loadLobby();
}

async function joinDuelChannel(id, state) {
  if (st.duelChannel) st.supabase.removeChannel(st.duelChannel);
  st.duelChannelOk = false;
  if (state.other?.ghost) {
    st.duelChannel = null;
    return;
  }
  st.duelChannel = await privateChannel(`duel:${id}`, {
    broadcast: {
      progress: (p) => {
        if (p.side === st.duel?.side) return;
        st.theirs = Number(p.correct) || 0;
        renderLanes();
      },
      emote: (p) => {
        if (p.side !== st.duel?.side) showEmote(p.emote, 'is-other');
      },
      finished: () => settle(),
      rematch: () => refreshResults(),
    },
    status: (s) => {
      st.duelChannelOk = s === 'SUBSCRIBED';
    },
  }, st.viewer.id);
}

/** Decides which screen to show from the current state and clock. */
function route() {
  const d = st.duel;
  if (!d) return;
  clearInterval(st.tick);
  clearInterval(st.poll);
  if (d.status === 'invited' && d.side === 'b') return leaveDuelView(); // the lobby shows Accept / Not now
  if (d.status === 'invited') {
    show('ld-waiting');
    $('ld-waiting-text').textContent = d.side === 'a'
      ? `Waiting for ${d.other?.name || 'your classmate'} to accept…`
      : `${d.other?.name || 'A classmate'} challenged you.`;
    st.poll = setInterval(async () => {
      const s = await fetchState(d.id);
      if (!s) return;
      st.duel = s;
      if (s.status !== 'invited') route();
    }, 2000);
    return;
  }
  if (d.status === 'done' || d.status === 'expired') return showResults();
  if (d.status !== 'live') {
    showToast('info', 'That duel was cancelled.');
    return leaveDuelView();
  }
  startRace();
}

function startRace() {
  const d = st.duel;
  const startMs = Date.parse(d.start_at);
  const endMs = Date.parse(d.end_at);
  show('ld-race');
  $('ld-vs').textContent = `vs ${d.other?.name || 'Opponent'}${d.other?.ghost ? '' : d.other?.rating ? ` (${d.other.rating})` : ''}`;
  $('ld-cat').textContent = d.category_name || '';
  $('ld-emotes').hidden = Boolean(d.other?.ghost);
  $('ld-emotes').innerHTML = buildEmoteBarHtml(st.muted);
  renderLanes();
  renderQuestion();

  st.tick = setInterval(async () => {
    const now = serverNow();
    if (now < startMs) {
      $('ld-countdown').hidden = false;
      $('ld-countdown').textContent = String(Math.ceil((startMs - now) / 1000));
      $('ld-timer').textContent = String(d.seconds || 60);
      $('ld-answer').disabled = true;
      return;
    }
    if (!$('ld-countdown').hidden) {
      $('ld-countdown').hidden = true;
      await ensureQuestions();
      $('ld-answer').disabled = false;
      $('ld-answer').focus();
    }
    if (d.other?.ghost) {
      st.theirs = timelineProgress(st.duel.other.timeline, now - startMs).correct;
      renderLanes();
    }
    const left = secondsLeft(endMs, now);
    $('ld-timer').textContent = String(left);
    $('ld-timer').classList.toggle('is-low', left <= 10);
    if (now >= endMs) {
      $('ld-answer').disabled = true;
      clearInterval(st.tick);
      settle();
    }
  }, 100);

  // Polling fallback: keeps the other lane moving if the socket is down.
  st.poll = setInterval(async () => {
    if (st.duelChannelOk || st.duel?.other?.ghost) return;
    const s = await fetchState(d.id);
    if (!s) return;
    st.theirs = Number(s.other?.correct) || 0;
    renderLanes();
  }, 2500);
}

async function ensureQuestions() {
  if (Array.isArray(st.duel?.questions)) return;
  for (let i = 0; i < 5 && !Array.isArray(st.duel?.questions); i += 1) {
    const s = await fetchState(st.duel.id);
    if (s) st.duel = { ...s };
    if (!Array.isArray(st.duel?.questions)) await new Promise((r) => setTimeout(r, 300));
  }
  renderQuestion();
}

function renderQuestion() {
  const qs = st.duel?.questions;
  $('ld-question').innerHTML = Array.isArray(qs) ? buildQuestionHtml(qs[st.index]) : '<div class="ld-q ld-q-wait">Get ready…</div>';
  $('ld-qnum').textContent = Array.isArray(qs) ? `Question ${st.index + 1}` : '';
}

function renderLanes() {
  const d = st.duel;
  if (!d) return;
  $('ld-lanes').innerHTML = buildLanesHtml({
    myName: 'You',
    otherName: d.other?.name || 'Opponent',
    mine: st.mine,
    theirs: st.theirs,
    ghost: Boolean(d.other?.ghost),
  });
}

function submitAnswer() {
  const input = $('ld-answer');
  const value = input.value.trim();
  const d = st.duel;
  if (!d || !value || input.disabled || !Array.isArray(d.questions) || st.index >= d.questions.length) return;
  const index = st.index;
  st.index += 1;
  input.value = '';
  renderQuestion();
  const startMs = Date.parse(d.start_at);
  // Answers go one at a time, in order, never faster than the server allows.
  st.sending = st.sending.then(async () => {
    const earliest = startMs + (index + 1) * LIVE_DUEL_MIN_MS_PER_ANSWER + 30;
    const wait = earliest - serverNow();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const { data } = await rpc('live_duel_answer', { p_duel: d.id, p_index: index, p_answer: value });
    if (!data) return;
    if (data.ok) {
      st.mine = Number(data.my_correct) || 0;
      flash(data.correct);
      renderLanes();
    } else if (data.code === 'OUT_OF_ORDER' && Number.isInteger(data.attempted)) {
      st.index = data.attempted;
      renderQuestion();
    } else if (data.code === 'TIME_UP') {
      input.disabled = true;
    }
  });
}

function flash(ok) {
  const el = $('ld-question');
  el.classList.remove('is-right', 'is-wrong');
  void el.offsetWidth;
  el.classList.add(ok ? 'is-right' : 'is-wrong');
}

function showEmote(key, cls) {
  if (st.muted || !LIVE_DUEL_EMOTES[key]) return;
  const bubble = document.createElement('div');
  bubble.className = `ld-bubble ${cls}`;
  bubble.textContent = LIVE_DUEL_EMOTES[key];
  $('ld-race').appendChild(bubble);
  setTimeout(() => bubble.remove(), 1800);
}

function setupRaceActions() {
  $('ld-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAnswer();
  });
  $('ld-emotes').addEventListener('click', async (e) => {
    const mute = e.target.closest('[data-mute]');
    if (mute) {
      st.muted = !st.muted;
      try { localStorage.setItem(MUTE_KEY, st.muted ? '1' : '0'); } catch { /* private mode */ }
      $('ld-emotes').innerHTML = buildEmoteBarHtml(st.muted);
      return;
    }
    const btn = e.target.closest('[data-emote]');
    if (!btn || !st.duel) return;
    const { data } = await rpc('live_duel_emote', { p_duel: st.duel.id, p_emote: btn.dataset.emote });
    if (data?.ok) showEmote(btn.dataset.emote, 'is-me');
    else if (data?.code === 'SLOW_DOWN') showToast('info', 'One emote every few seconds.');
    $('ld-answer').focus();
  });
}

/* ------------------------------------------------------------ Results */

async function settle() {
  if (st.settling || !st.duel) return;
  st.settling = true;
  const id = st.duel.id;
  const endMs = Date.parse(st.duel.end_at);
  await st.sending;
  const waitMs = endMs + LIVE_DUEL_GRACE_SECONDS * 1000 + 300 - serverNow();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  for (let i = 0; i < 10; i += 1) {
    const s = await fetchState(id);
    if (s && (s.status === 'done' || s.status === 'expired')) {
      st.duel = s;
      return showResults();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  showToast('error', 'Still adding up the scores. Refresh in a moment.');
}

function showResults() {
  clearInterval(st.tick);
  clearInterval(st.poll);
  const d = st.duel;
  show('ld-results');
  $('ld-results-lanes').innerHTML = buildLanesHtml({
    otherName: d.other?.name,
    mine: Number(d.me?.correct) || 0,
    theirs: Number(d.other?.correct) || 0,
    ghost: Boolean(d.other?.ghost),
  });
  $('ld-results-body').innerHTML = buildResultHtml(d);
  if (d.result === 'won') celebrate('big', $('ld-results-body'));
  // Watch for the other player's rematch request or the new duel.
  if (!d.other?.ghost) {
    st.poll = setInterval(refreshResults, 3000);
  }
}

async function refreshResults() {
  if (!st.duel || (st.duel.status !== 'done' && st.duel.status !== 'expired')) return;
  const s = await fetchState(st.duel.id);
  if (!s) return;
  st.duel = s;
  if (s.rematch_id) {
    clearInterval(st.poll);
    return enterDuel(s.rematch_id);
  }
  $('ld-results-body').innerHTML = buildResultHtml(s);
}

function setupResultActions() {
  $('ld-results').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rematch]');
    if (!btn || !st.duel) return;
    btn.disabled = true;
    btn.textContent = 'Asking…';
    try {
      const res = await drillApi({ action: 'live_rematch', duel_id: st.duel.id });
      if (res.duel_id) return enterDuel(res.duel_id);
      btn.textContent = 'Waiting for them…';
    } catch (err) {
      showToast('error', err.message);
      btn.disabled = false;
      btn.textContent = 'Rematch';
    }
  });
}

/* -------------------------------------------------------------- Staff */

async function loadStaff() {
  show('ld-staff');
  const { data, error } = await rpc('live_duels_staff', { p_days: 7 });
  $('ld-staff-body').innerHTML = error ? '<p class="ar-dim">Could not load live duels.</p>' : buildStaffHtml(data);
}

function setupStaffActions() {
  $('ld-staff').addEventListener('change', async (e) => {
    const box = e.target.closest('[data-live-toggle]');
    if (!box) return;
    box.disabled = true;
    const { error } = await rpc('live_duel_set_enabled', { p_enabled: box.checked });
    if (error) showToast('error', error);
    else showToast('success', box.checked ? 'Live duels are on.' : 'Live duels are off. Anyone waiting was taken out of the queue.');
    await loadStaff();
  });
}

/* --------------------------------------------------------------- Init */

async function initLiveDuelPage() {
  const viewer = await requireAuth(['student', 'teacher', 'admin']);
  if (!viewer) return;
  st.viewer = viewer;
  if (!isSupabaseConfigured()) {
    $('ld-lobby-body').innerHTML = '<p class="ar-dim">Live duels need the online database.</p>';
    show('ld-lobby');
    return;
  }
  st.supabase = await getSupabase();
  try { st.muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { st.muted = false; }

  if (viewer.role !== 'student') {
    setupStaffActions();
    await loadStaff();
    return;
  }
  setupLobbyActions();
  setupModeActions();
  setupRaceActions();
  setupResultActions();

  // Presence and the personal channel are shared with the rest of the site (js/duelPresence.js):
  // invites arrive as a pop-up with Accept / Reject, here and on every other page.
  st.hub = await getDuelHub(viewer);
  if (st.hub) {
    st.hub.blockPopups(() => Boolean(st.duel && st.duel.status === 'live'));
    st.hub.on('matched', (p) => {
      if (!p.duel_id || st.duel?.id === p.duel_id) return;
      if (st.duel && st.duel.status === 'live') return;
      st.searching = false;
      clearTimeout(st.searchTimer);
      enterDuel(p.duel_id);
    });
    st.hub.on('invite', () => {
      if (!st.duel && !st.searching) loadLobby();
    });
    st.hub.on('declined', () => {
      showToast('info', 'They said not now.');
      if (st.duel?.status === 'invited') leaveDuelView();
      else if (!st.duel) loadLobby();
    });
    st.hub.on('cancelled', () => {
      if (!st.duel && !st.searching) loadLobby();
      else if (st.duel?.status === 'invited') leaveDuelView();
    });
    st.hub.on('responded', (p) => {
      if (!p.accept && !st.duel) loadLobby();
    });
    st.hub.onPresence(onPresence);
  }
  // If presence never syncs (socket blocked), stop saying "checking".
  setTimeout(() => {
    if (!st.presenceSeen) {
      st.presenceSeen = true;
      renderMates();
    }
  }, 8000);

  $('ld-waiting-cancel').addEventListener('click', async () => {
    if (st.duel) await rpc('live_duel_cancel', { p_duel: st.duel.id });
    leaveDuelView();
  });

  const params = new URLSearchParams(window.location.search);
  const duelId = params.get('duel');
  if (duelId) await enterDuel(duelId);
  else {
    await loadLobby();
    if (params.get('mode')) setMode(params.get('mode'));
  }

  window.addEventListener('pagehide', () => {
    if (st.searching) rpc('live_duel_leave_queue');
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initLiveDuelPage);
}
