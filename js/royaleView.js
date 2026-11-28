/**
 * Trendz Tracker - battle royale HTML builders (js/royaleView.js)
 *
 * Pure functions for the Battle royale tab and game screen on
 * pages/live-duel.html. No DOM access here so tests can check the markup.
 */

import { ROYALE_MAX_PLAYERS, ROYALE_MIN_TO_START, ordinal } from '../shared/royale.js';
import { avatarHtml } from './avatars.js';
import { esc } from './liveDuelView.js';

const clock = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/** "45s" under 90 seconds, else "26:43". */
export function waitText(secs) {
  const n = Math.max(0, Math.floor(Number(secs) || 0));
  if (n < 90) return `${n}s`;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

/**
 * Where the game is: 'waiting' (lobby), 'countdown' (before round 1), 'round',
 * 'break' (between rounds), 'settling' (time up, the server is ranking) or 'done'.
 */
export function royalePhase(state, nowMs) {
  if (!state) return { phase: 'none', secs: 0 };
  const left = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));
  if (state.status === 'done') return { phase: 'done', secs: 0 };
  if (state.status === 'waiting') return { phase: 'waiting', secs: left(state.start_at) };
  if (nowMs < Date.parse(state.round_start_at)) {
    return { phase: Number(state.round) <= 1 ? 'countdown' : 'break', secs: left(state.round_start_at) };
  }
  if (nowMs < Date.parse(state.round_end_at)) return { phase: 'round', secs: left(state.round_end_at) };
  return { phase: 'settling', secs: 0 };
}

/** The Battle royale tab: join card, the waiting lobby at my level, my recent places. */
export function buildRoyaleHomeHtml(home, { disabled = false } = {}) {
  const waiting = home?.waiting;
  const count = Number(waiting?.count) || 0;
  const startAt = waiting?.start_at || home?.next_slot;
  const status = waiting && count > 0
    ? `<b class="num">${count}</b> of ${ROYALE_MAX_PLAYERS} waiting · starts ${count >= ROYALE_MIN_TO_START ? 'any second' : `at <b>${esc(clock(startAt))}</b>`}`
    : `Next game at <b>${esc(clock(startAt))}</b>, or as soon as ${ROYALE_MIN_TO_START} join`;
  const recent = Array.isArray(home?.recent) ? home.recent : [];
  const list = recent.length
    ? `<ul class="br-recent">${recent.map((r) => `
        <li><span class="br-place num${Number(r.place) === 1 ? ' is-win' : ''}">${esc(ordinal(r.place))}</span>
          <span>of ${Number(r.size) || 0}</span><span class="ar-dim">${esc(r.category_name || '')}</span>
          <span class="br-xp num">+${Number(r.xp) || 0} XP</span></li>`).join('')}</ul>`
    : '<p class="ar-dim">No battle royales yet. Your places will show here.</p>';
  return `
    <section class="br-hero">
      <div>
        <span class="ld-kicker"><span class="ld-live">LIVE</span> Up to ${ROYALE_MAX_PLAYERS} players · 30-second rounds</span>
        <h2>Last one standing wins</h2>
        <p>Everyone at your level, from any centre, gets the same questions. After each round the bottom quarter is out. Out early? Stay and watch the finish.</p>
        <p class="br-status" aria-live="polite">${status}</p>
        <button type="button" class="ld-quick" data-royale-join ${disabled ? 'disabled' : ''}>👑 Join battle royale</button>
      </div>
      <div class="br-wins"><span class="num">${Number(home?.wins) || 0}</span><span>royale wins</span></div>
    </section>
    <section class="card ar-panel">
      <div class="ld-panel-head"><h2>Your recent places</h2></div>
      ${list}
    </section>
    <p class="ar-dim ld-ghost-note">XP for every correct answer plus a place bonus: 30 for 1st, 20 for 2nd, 15 for 3rd, 10 for the top half. Winners get the 👑 Royale winner badge. Not rated.</p>`;
}

/** Avatars of everyone in the game; players who are out fade and show their place. */
export function buildRoyaleStripHtml(players = [], avatarUrls = new Map()) {
  const alive = players.filter((p) => p.alive).length;
  const items = players.map((p) => {
    const cls = ['br-player', p.alive ? 'is-in' : 'is-out', p.me ? 'is-me' : ''].filter(Boolean).join(' ');
    const tag = p.alive ? '' : `<span class="br-tag num">${esc(ordinal(p.place))}</span>`;
    const name = p.me ? 'You' : p.name;
    return `<li class="${cls}" title="${esc(name)}${p.alive ? '' : ` · out, ${ordinal(p.place)}`}">
      ${avatarHtml(avatarUrls.get(p.avatar) || null, p.name, 40)}${tag}
      <span class="br-name">${esc(name)}</span></li>`;
  }).join('');
  return `<div class="br-strip-head"><b class="num">${alive}</b> of <span class="num">${players.length}</span> left</div>
    <ul class="br-strip" aria-label="Players">${items}</ul>`;
}

/** The line above the question: round, phase and time. */
export function buildRoyaleHeadHtml(state, { phase, secs }) {
  const round = Number(state?.round) || 0;
  const label = {
    waiting: `Lobby · starts in <span class="num">${waitText(secs)}</span>`,
    countdown: `Round 1 starts in <span class="num">${secs}</span>`,
    round: `Round <span class="num">${round}</span>`,
    break: `Round <span class="num">${round}</span> starts in <span class="num">${secs}</span>`,
    settling: `Round <span class="num">${round}</span> · counting…`,
    done: 'Game over',
  }[phase] || '';
  return `<div><strong>👑 Battle royale</strong><div class="ar-dim">${esc(state?.category_name || '')}</div></div>
    <div class="br-phase">${label}</div>
    <div class="ld-timer num" aria-label="Seconds left">${phase === 'round' ? secs : ''}</div>`;
}

/** Between rounds and while watching: how the last round went for me. */
export function buildRoyaleNoteHtml(state, { phase, secs }) {
  const me = state?.me || {};
  if (phase === 'waiting') {
    const n = Array.isArray(state?.players) ? state.players.length : 0;
    return `<div class="br-note"><div class="br-big num">${waitText(secs)}</div>
      <p>${n} in the lobby. ${n >= ROYALE_MIN_TO_START ? 'Starting soon!' : `It starts early once ${ROYALE_MIN_TO_START} have joined.`}</p>
      <button type="button" class="btn btn-outline" data-royale-leave>Leave lobby</button></div>`;
  }
  if (!me.alive && phase !== 'done') {
    return `<div class="br-note is-out"><div class="br-big">💫</div>
      <p>You're out in <b>${esc(ordinal(me.place))}</b> place. Watch who wins, or head back.</p>
      <button type="button" class="btn btn-outline" data-royale-back>Back to Live Duel</button></div>`;
  }
  if (phase === 'countdown') return `<div class="br-note"><div class="br-big num">${secs}</div><p>Get ready…</p></div>`;
  if (phase === 'break') {
    const last = Number(me.last_round_correct) || 0;
    return `<div class="br-note is-through"><div class="br-big">✅</div>
      <p>You're through with <b class="num">${last}</b> correct. Round ${Number(state.round) || 0} in ${secs}…</p></div>`;
  }
  if (phase === 'settling') return '<div class="br-note"><p>Time! Ranking the round…</p></div>';
  return '';
}

/** Final screen: my place, XP, and the winner. */
export function buildRoyaleFinalHtml(state) {
  const me = state?.me || {};
  const won = Number(me.place) === 1;
  const size = Array.isArray(state?.players) ? state.players.length : 0;
  return `<div class="br-final${won ? ' is-win' : ''}">
    <div class="br-big" aria-hidden="true">${won ? '👑' : Number(me.place) <= 3 ? '🏅' : '💪'}</div>
    <h2>${won ? 'You won the battle royale!' : `You came ${esc(ordinal(me.place))} of ${size}`}</h2>
    ${won ? '<p class="ld-pb">New badge: 👑 Royale winner</p>' : `<p>Winner: <b>${esc(state?.winner || '—')}</b></p>`}
    <div class="ld-rewards"><span class="ld-chip">+<span class="num">${Number(me.xp) || 0}</span> XP</span>
      <span class="ld-chip"><span class="num">${Number(me.total_correct) || 0}</span> correct</span><span class="ld-chip">Not rated</span></div>
    <div class="br-actions">
      <button type="button" class="btn btn-primary" data-royale-again>👑 Play again</button>
      <button type="button" class="btn btn-outline" data-royale-back>Back to Live Duel</button>
    </div></div>`;
}
