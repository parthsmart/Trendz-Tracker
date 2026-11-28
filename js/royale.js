/**
 * Trendz Tracker - battle royale on the Live Duel page (js/royale.js)
 *
 * The Battle royale tab (#ld-royale) and the game screen (#ld-royale-game).
 * Joining goes through /api/drill (action 'royale_join'); everything else is a
 * SECURITY DEFINER RPC (supabase/migrations/46_battle_royale.sql): my_royale for
 * the tab, royale_state polled about once a second (it also moves the game on),
 * royale_answer for each answer (graded on the server) and royale_leave.
 */

import { LIVE_DUEL_MIN_MS_PER_ANSWER } from '../shared/liveDuel.js';
import { signAvatarUrls } from './avatars.js';
import { buildQuestionHtml } from './liveDuelView.js';
import {
  buildRoyaleFinalHtml,
  buildRoyaleHeadHtml,
  buildRoyaleHomeHtml,
  buildRoyaleNoteHtml,
  buildRoyaleStripHtml,
  royalePhase,
} from './royaleView.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 1000;

const rs = {
  deps: null,
  id: null,
  state: null,
  offset: 0,
  round: 0,
  index: 0,
  sending: Promise.resolve(),
  poll: null,
  tick: null,
  avatars: new Map(),
  celebrated: false,
};

const serverNow = () => Date.now() + rs.offset;

/** True while the student is in a game (the page holds back duel pop-ups then). */
export function royaleBusy() {
  return Boolean(rs.id && rs.state && rs.state.status !== 'done');
}

export async function loadRoyaleHome() {
  const { rpc, enabled } = rs.deps;
  const { data, error } = await rpc('my_royale');
  if (error || !data) {
    $('ld-royale').innerHTML = '<p class="ar-dim">Could not load battle royale. Please refresh.</p>';
    return;
  }
  if (data.active) return enterRoyale(data.active);
  $('ld-royale').innerHTML = buildRoyaleHomeHtml(data, { disabled: !enabled() });
  return null;
}

async function join(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Joining…'; }
  try {
    const res = await rs.deps.drillApi({ action: 'royale_join' });
    await enterRoyale(res.game_id);
  } catch (err) {
    rs.deps.showToast('error', err.message);
    if (btn) { btn.disabled = false; btn.textContent = '👑 Join battle royale'; }
  }
}

async function fetchState() {
  const sent = Date.now();
  const { data } = await rs.deps.rpc('royale_state', { p_game: rs.id });
  if (!data) return null;
  const offset = Date.parse(data.server_now) + (Date.now() - sent) / 2 - Date.now();
  if (!rs.state || Math.abs(offset - rs.offset) > 400) rs.offset = offset;
  return data;
}

async function signAvatars(players) {
  const missing = players.map((p) => p.avatar).filter((a) => a && !rs.avatars.has(a));
  if (!missing.length) return;
  try {
    const urls = await signAvatarUrls(missing);
    for (const [k, v] of urls) rs.avatars.set(k, v);
  } catch { /* initials instead */ }
}

export async function enterRoyale(id) {
  stop();
  rs.id = id;
  rs.state = null;
  rs.round = 0;
  rs.celebrated = false;
  const url = new URL(window.location.href);
  url.searchParams.set('royale', id);
  url.searchParams.delete('mode');
  window.history.replaceState(null, '', url);
  const state = await fetchState();
  if (!state) {
    rs.deps.showToast('error', 'That battle royale has ended.');
    return back();
  }
  rs.deps.show('ld-royale-game');
  await onState(state);
  rs.poll = setInterval(async () => {
    const s = await fetchState();
    if (s && rs.id === s.id) await onState(s);
  }, POLL_MS);
  rs.tick = setInterval(render, 250);
  return id;
}

async function onState(state) {
  const newRound = Number(state.round) !== rs.round;
  rs.state = state;
  if (newRound) {
    rs.round = Number(state.round);
    rs.index = Number(state.me?.round_attempted) || 0;
    rs.sending = Promise.resolve();
    $('br-answer').value = '';
  }
  await signAvatars(state.players || []);
  $('br-strip').innerHTML = buildRoyaleStripHtml(state.players || [], rs.avatars);
  if (state.status === 'done') {
    clearInterval(rs.poll);
    if (!rs.celebrated && Number(state.me?.place) === 1) rs.deps.celebrate?.();
    rs.celebrated = true;
  }
  render();
}

function render() {
  const s = rs.state;
  if (!s) return;
  const ph = royalePhase(s, serverNow());
  $('br-head').innerHTML = buildRoyaleHeadHtml(s, ph);
  const playing = ph.phase === 'round' && s.me?.alive && Array.isArray(s.questions);
  $('br-play').hidden = !playing;
  const input = $('br-answer');
  if (playing) {
    if (input.disabled) { input.disabled = false; input.focus(); }
    const q = s.questions[rs.index];
    const html = buildQuestionHtml(q);
    if ($('br-question').dataset.i !== String(rs.index)) {
      $('br-question').innerHTML = html;
      $('br-question').dataset.i = String(rs.index);
    }
    $('br-qnum').textContent = `Question ${rs.index + 1} · ${Number(s.me.round_correct) || 0} correct this round`;
  } else {
    input.disabled = true;
    $('br-question').dataset.i = '';
  }
  // A poll during the round can come back with questions missing for a moment: fetch them.
  if (ph.phase === 'round' && s.me?.alive && !Array.isArray(s.questions)) fetchState().then((x) => x && onState(x));
  const note = ph.phase === 'done' ? buildRoyaleFinalHtml(s) : buildRoyaleNoteHtml(s, ph);
  if ($('br-note').innerHTML !== note) $('br-note').innerHTML = note;
}

function submit() {
  const s = rs.state;
  const input = $('br-answer');
  const value = input.value.trim();
  if (!s || !value || input.disabled || !Array.isArray(s.questions) || rs.index >= s.questions.length) return;
  const index = rs.index;
  const round = rs.round;
  rs.index += 1;
  input.value = '';
  render();
  const startMs = Date.parse(s.round_start_at);
  rs.sending = rs.sending.then(async () => {
    const wait = startMs + (index + 1) * LIVE_DUEL_MIN_MS_PER_ANSWER + 30 - serverNow();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (round !== rs.round) return;
    const { data } = await rs.deps.rpc('royale_answer', { p_game: s.id, p_index: index, p_answer: value });
    if (!data || round !== rs.round) return;
    if (data.ok) {
      rs.state.me = { ...rs.state.me, round_correct: data.round_correct, round_attempted: data.round_attempted };
      const el = $('br-question');
      el.classList.remove('is-right', 'is-wrong');
      void el.offsetWidth;
      el.classList.add(data.correct ? 'is-right' : 'is-wrong');
    } else if (data.code === 'OUT_OF_ORDER' && Number.isInteger(data.attempted)) {
      rs.index = data.attempted;
    }
    render();
  });
}

function stop() {
  clearInterval(rs.poll);
  clearInterval(rs.tick);
  rs.poll = null;
  rs.tick = null;
}

function back() {
  stop();
  rs.id = null;
  rs.state = null;
  const url = new URL(window.location.href);
  url.searchParams.delete('royale');
  window.history.replaceState(null, '', url);
  rs.deps.back();
}

/**
 * deps: { rpc, drillApi, show(view), back(), showToast, enabled(), celebrate }
 */
export function setupRoyale(deps) {
  rs.deps = deps;
  $('ld-royale').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-royale-join]');
    if (btn) join(btn);
  });
  $('br-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $('ld-royale-game').addEventListener('click', async (e) => {
    if (e.target.closest('[data-royale-back]')) return back();
    if (e.target.closest('[data-royale-again]')) {
      stop();
      rs.id = null;
      return join(e.target.closest('[data-royale-again]'));
    }
    const leave = e.target.closest('[data-royale-leave]');
    if (leave) {
      leave.disabled = true;
      await deps.rpc('royale_leave', { p_game: rs.id });
      return back();
    }
    return null;
  });
}
