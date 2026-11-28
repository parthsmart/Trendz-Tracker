/**
 * Trendz Tracker - tournament HTML builders (js/tournamentView.js)
 *
 * Pure functions for the Tournaments tab on pages/live-duel.html and the staff panel.
 * No DOM access here so tests can check the markup.
 */

import { TOURNAMENT_PRIZES, TOURNAMENT_SIZES, roundName } from '../shared/tournament.js';
import { avatarHtml } from './avatars.js';
import { esc } from './liveDuelView.js';
import { waitText } from './royaleView.js';

const when = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const clock = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const secsUntil = (iso, nowMs) => Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 1000));

const HOW = { bye: 'Bye', forfeit: 'Won by forfeit', no_show: 'No-show: higher seed through', seed: 'Higher seed through' };
const FINISH = { champion: '🏆 Champion', finalist: '🥈 Finalist', semi: '🥉 Semi-finalist' };

/** Where a tournament card stands: 'soon', 'open', 'closed' (waiting for the start), 'running', 'done', 'cancelled'. */
export function tournamentPhase(t, nowMs) {
  if (!t) return 'none';
  if (t.status === 'done' || t.status === 'cancelled' || t.status === 'running') return t.status;
  if (nowMs < Date.parse(t.signup_opens_at)) return 'soon';
  if (nowMs < Date.parse(t.signup_closes_at)) return 'open';
  return 'closed';
}

function statusLine(t, phase) {
  const where = t.centre_id ? esc(t.centre_name || 'Your centre') : 'All centres';
  const count = `<b class="num">${Number(t.count) || 0}</b> of ${Number(t.max_players) || 0} signed up`;
  const text = {
    soon: `Sign-up opens ${esc(when(t.signup_opens_at))}`,
    open: `${count} · sign-up closes ${esc(when(t.signup_closes_at))}`,
    closed: `${count} · starts ${esc(when(t.start_at))}`,
    running: `Live now · ${Number(t.count) || 0} players`,
    done: t.champion ? `Champion: <b>${esc(t.champion)}</b>` : 'Finished',
    cancelled: esc(t.note || 'Cancelled'),
  }[phase] || '';
  return `<span class="tn-meta">${esc(t.level)} · ${where} · starts ${esc(when(t.start_at))}</span><span class="tn-status">${text}</span>`;
}

/** One tournament in the list (student tab and staff panel). */
export function buildTournamentCardHtml(t, nowMs, { staff = false, disabled = false } = {}) {
  const phase = tournamentPhase(t, nowMs);
  const buttons = [];
  if (!staff && phase === 'open' && !t.joined) {
    buttons.push(`<button type="button" class="btn btn-primary" data-tn-join="${esc(t.id)}" ${disabled ? 'disabled' : ''}>Sign up</button>`);
  }
  if (!staff && (phase === 'open' || phase === 'closed' || phase === 'soon') && t.joined) {
    buttons.push(`<span class="ld-chip">✅ You're in</span><button type="button" class="btn btn-outline" data-tn-leave="${esc(t.id)}">Leave</button>`);
  }
  if (phase === 'running' || phase === 'done' || (staff && phase !== 'cancelled')) {
    buttons.push(`<button type="button" class="btn ${phase === 'running' && t.joined ? 'btn-primary' : 'btn-outline'}" data-tn-open="${esc(t.id)}">View bracket</button>`);
  }
  if (staff && t.can_manage && (t.status === 'signup' || t.status === 'running')) {
    buttons.push(`<button type="button" class="btn btn-outline tn-danger" data-tn-cancel="${esc(t.id)}">Cancel</button>`);
  }
  const ready = !staff && t.my_match && (t.my_match.status === 'ready' || t.my_match.status === 'live');
  return `<li class="tn-card is-${phase}${ready ? ' is-ready' : ''}">
      <div class="tn-card-main"><strong>🏆 ${esc(t.name)}</strong>${statusLine(t, phase)}
        ${ready ? `<span class="tn-ready">⚔️ Your match is ready</span>` : ''}</div>
      <div class="tn-card-actions">${buttons.join('')}</div>
    </li>`;
}

/** The Tournaments tab. */
export function buildTournamentHomeHtml(home, nowMs, { disabled = false } = {}) {
  const list = Array.isArray(home?.tournaments) ? home.tournaments : [];
  const body = list.length
    ? `<ul class="tn-list">${list.map((t) => buildTournamentCardHtml(t, nowMs, { disabled })).join('')}</ul>`
    : '<p class="ar-dim">No tournaments at your level right now. Your centre will announce the next one.</p>';
  return `
    <section class="tn-hero">
      <div>
        <span class="ld-kicker">Knockout · 8, 16 or 32 players</span>
        <h2>Tournaments</h2>
        <p>Sign up, get seeded by your duel rating, then win 60-second live duels round by round. Check in within 3 minutes when your match is ready.</p>
      </div>
      <div class="br-wins"><span class="num">${Number(home?.titles) || 0}</span><span>titles</span></div>
    </section>
    <section class="card ar-panel">${body}</section>
    <p class="ar-dim ld-ghost-note">Prizes: 🏆 champion ${TOURNAMENT_PRIZES.champion}, 🥈 finalist ${TOURNAMENT_PRIZES.finalist}, 🥉 semi-finalists ${TOURNAMENT_PRIZES.semi} store balance, plus a badge. Matches are rated and give XP like any live duel.</p>`;
}

/** The match I am in (or my bye / exit), for the card above the bracket. */
export function myTournamentSpot(state) {
  const me = (state?.entries || []).find((e) => e.me);
  if (!me) return null;
  const matches = state.matches || [];
  const mine = matches.filter((m) => m.a_id === me.id || m.b_id === me.id);
  const open = mine.find((m) => m.status === 'ready' || m.status === 'live');
  if (open) return { kind: 'match', match: open, me };
  if (me.finish === 'champion') return { kind: 'champion', me };
  if (me.out_round) return { kind: 'out', me };
  const last = mine.filter((m) => m.status === 'done').sort((a, b) => b.round - a.round)[0];
  if (last && last.how === 'bye') return { kind: 'bye', match: last, me };
  if (state.status === 'running') return { kind: 'waiting', me };
  return { kind: 'entered', me };
}

/** "Your match is ready" (check-in) and friends. */
export function buildMatchCardHtml(state, nowMs, { checkingIn = false } = {}) {
  const spot = myTournamentSpot(state);
  if (!spot || state.status === 'cancelled') return '';
  const rounds = Number(state.rounds) || 0;
  const name = (id) => (state.entries || []).find((e) => e.id === id)?.name || 'TBD';
  if (spot.kind === 'champion') {
    return `<div class="tn-match is-win"><div class="br-big">🏆</div><h3>You won ${esc(state.name)}!</h3>
      <p>+${TOURNAMENT_PRIZES.champion} store balance and the Tournament champion badge.</p></div>`;
  }
  if (spot.kind === 'out') {
    const finish = spot.me.finish ? `${FINISH[spot.me.finish]}: +${TOURNAMENT_PRIZES[spot.me.finish]} store balance and a badge.` : 'Well played!';
    return `<div class="tn-match is-out"><h3>You're out in the ${esc(roundName(spot.me.out_round, rounds).toLowerCase())}</h3>
      <p>${esc(finish)} Watch the bracket to see who wins.</p></div>`;
  }
  if (spot.kind === 'bye') {
    return `<div class="tn-match"><h3>Bye: you're through to the ${esc(roundName(spot.match.round + 1, rounds).toLowerCase())}</h3>
      <p>Top seeds skip round 1. Race a ghost while you wait.</p>
      <a class="btn btn-outline" href="/pages/live-duel.html?mode=ghost">👻 Race a ghost</a></div>`;
  }
  if (spot.kind === 'waiting') {
    return `<div class="tn-match"><h3>Through! Waiting for your next opponent</h3><p>The other match in your half is still going.</p></div>`;
  }
  if (spot.kind === 'entered') {
    return `<div class="tn-match"><h3>You're signed up</h3><p>The bracket is drawn at ${esc(clock(state.start_at))}. Keep this page open, or come back then.</p></div>`;
  }
  const m = spot.match;
  const iAmA = m.a_id === spot.me.id;
  const opp = name(iAmA ? m.b_id : m.a_id);
  const title = `${roundName(m.round, rounds)} vs ${opp}`;
  if (m.status === 'live') {
    return `<div class="tn-match is-ready"><h3>⚔️ ${esc(title)}</h3><p>Your duel is on!</p>
      <button type="button" class="btn btn-primary" data-tn-duel="${esc(m.duel_id || '')}">Go to the duel</button></div>`;
  }
  if (nowMs < Date.parse(m.ready_at)) {
    return `<div class="tn-match"><h3>${esc(title)}</h3>
      <p>Check-in opens at <b>${esc(clock(m.ready_at))}</b> (in <span class="num">${waitText(secsUntil(m.ready_at, nowMs))}</span>).</p></div>`;
  }
  const mine = iAmA ? m.a_in : m.b_in;
  const theirs = iAmA ? m.b_in : m.a_in;
  const left = secsUntil(m.checkin_until, nowMs);
  if (mine) {
    return `<div class="tn-match is-ready"><h3>✅ Checked in · ${esc(title)}</h3>
      <p>${theirs ? 'Both in. Starting your duel…' : `Waiting for ${esc(opp)} to check in. If they don't come in <span class="num">${waitText(left)}</span>, you win by forfeit.`}</p></div>`;
  }
  return `<div class="tn-match is-ready" role="alert"><h3>⚔️ Your match is ready: ${esc(title)}</h3>
    <p>Check in within <b class="num">${waitText(left)}</b> or you forfeit.${theirs ? ` ${esc(opp)} is already in.` : ''}</p>
    <button type="button" class="ld-quick" data-tn-checkin="${esc(m.id)}" ${checkingIn ? 'disabled' : ''}>${checkingIn ? 'Checking in…' : '✅ Check in'}</button></div>`;
}

function playerRow(m, side, state, avatarUrls) {
  const id = m[`${side}_id`];
  const seed = m[`${side}_seed`];
  const e = (state.entries || []).find((x) => x.id === id);
  const score = m[`${side}_correct`];
  const won = m.status === 'done' && m.winner_id && m.winner_id === id;
  const lost = m.status === 'done' && m.winner_id && id && m.winner_id !== id;
  const cls = ['tn-slot', won ? 'is-won' : '', lost ? 'is-lost' : '', e?.me ? 'is-me' : '', id ? '' : 'is-empty'].filter(Boolean).join(' ');
  if (!id) {
    const label = m.status === 'done' && m.how === 'bye' ? 'Bye' : 'TBD';
    return `<div class="${cls}"><span class="tn-seed"></span><span class="tn-name ar-dim">${label}</span><span class="tn-score"></span></div>`;
  }
  const checked = m.status === 'ready' && m[`${side}_in`] ? ' <span class="tn-in" title="Checked in">✓</span>' : '';
  return `<div class="${cls}"><span class="tn-seed num">${seed ?? ''}</span>
    ${avatarHtml(avatarUrls.get(e?.avatar) || null, e?.name || '', 22)}
    <span class="tn-name">${esc(e?.me ? 'You' : e?.name || '')}${checked}</span>
    <span class="tn-score num">${score ?? ''}</span></div>`;
}

/** The bracket: one column per round. */
export function buildBracketHtml(state, nowMs, avatarUrls = new Map()) {
  if (!state) return '<p class="ar-dim">Tournament not found.</p>';
  const rounds = Number(state.rounds) || 0;
  const head = `<div class="tn-head"><div><button type="button" class="btn btn-outline btn-sm" data-tn-back>‹ All tournaments</button>
      <h2>🏆 ${esc(state.name)}</h2>${statusLine(state, tournamentPhase(state, nowMs))}</div></div>`;
  if (!rounds) {
    const entries = state.entries || [];
    const list = entries.length
      ? `<ul class="tn-entries">${entries.map((e) => `<li>${avatarHtml(avatarUrls.get(e.avatar) || null, e.name, 28)}<span>${esc(e.me ? 'You' : e.name)}</span></li>`).join('')}</ul>`
      : '<p class="ar-dim">Nobody has signed up yet.</p>';
    return `${head}<p class="ar-dim">The bracket is drawn at the start time, seeded by duel rating.</p>${list}`;
  }
  const cols = [];
  for (let r = 1; r <= rounds; r += 1) {
    const ms = (state.matches || []).filter((m) => Number(m.round) === r);
    const roundAt = Date.parse(state.start_at) + (r - 1) * (Number(state.round_minutes) || 10) * 60000;
    cols.push(`<section class="tn-round" aria-label="${esc(roundName(r, rounds))}">
      <h3>${esc(roundName(r, rounds))}<span class="ar-dim"> · ${esc(clock(new Date(roundAt).toISOString()))}</span></h3>
      ${ms.map((m) => `<div class="tn-box is-${esc(m.status)}">
        ${playerRow(m, 'a', state, avatarUrls)}${playerRow(m, 'b', state, avatarUrls)}
        ${m.status === 'done' && HOW[m.how] && m.how !== 'bye' ? `<span class="tn-how">${esc(HOW[m.how])}</span>` : ''}
        ${m.status === 'live' ? '<span class="tn-how is-live"><span class="ld-live">LIVE</span></span>' : ''}
      </div>`).join('')}
    </section>`);
  }
  const champ = (state.entries || []).find((e) => e.finish === 'champion');
  cols.push(`<section class="tn-round tn-champ"><h3>Champion</h3><div class="tn-box${champ ? ' is-done' : ''}">
    ${champ ? `<div class="tn-slot is-won">${avatarHtml(avatarUrls.get(champ.avatar) || null, champ.name, 22)}<span class="tn-name">🏆 ${esc(champ.me ? 'You' : champ.name)}</span></div>` : '<div class="tn-slot is-empty"><span class="tn-seed"></span><span class="tn-name ar-dim">TBD</span></div>'}
  </div></section>`);
  return `${head}<div class="tn-bracket" style="--tn-rounds:${rounds + 1}">${cols.join('')}</div>`;
}

const pad = (n) => String(n).padStart(2, '0');
/** A value for <input type="datetime-local"> in the browser's time zone. */
export function localInputValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Staff: create form and the list. */
export function buildTournamentStaffHtml(data, nowMs) {
  const list = Array.isArray(data?.tournaments) ? data.tournaments : [];
  const levels = Array.isArray(data?.levels) ? data.levels : [];
  const centres = Array.isArray(data?.centres) ? data.centres : [];
  const start = Math.ceil((nowMs + 2 * 3600000) / 1800000) * 1800000;
  const form = !data?.can_create ? '' : `
    <form class="tn-form" data-tn-create>
      <h3>New tournament</h3>
      <label>Name <input name="name" required minlength="3" maxlength="60" placeholder="Saturday Speed Cup"></label>
      <label>Level <select name="level" required>${levels.map((l) => `<option>${esc(l)}</option>`).join('')}</select></label>
      <label>Players <select name="size">${TOURNAMENT_SIZES.map((n) => `<option value="${n}"${n === 16 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>Who can play <select name="centre">
        ${data.all_centres ? '<option value="">All centres</option>' : ''}
        ${centres.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
      </select></label>
      <label>Sign-up opens <input type="datetime-local" name="opens" required value="${localInputValue(nowMs)}"></label>
      <label>Sign-up closes <input type="datetime-local" name="closes" required value="${localInputValue(start - 600000)}"></label>
      <label>Starts <input type="datetime-local" name="start" required value="${localInputValue(start)}"></label>
      <label>Minutes between rounds <input type="number" name="round_minutes" min="5" max="60" value="10"></label>
      <p class="ar-dim">Seeded by duel rating, top seeds get byes. Fewer than 4 sign-ups at the start and it is cancelled.</p>
      <button type="submit" class="btn btn-primary">Create tournament</button>
    </form>`;
  const body = list.length
    ? `<ul class="tn-list">${list.map((t) => buildTournamentCardHtml(t, nowMs, { staff: true })).join('')}</ul>`
    : '<p class="ar-dim">No tournaments yet.</p>';
  return `${form}<h3>Tournaments</h3>${body}`;
}
