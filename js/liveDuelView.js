/**
 * Trendz Tracker - live duel HTML builders (js/liveDuelView.js)
 *
 * Pure functions that turn live duel data into HTML for pages/live-duel.html.
 * No DOM access here so tests can check the markup.
 */

import { LIVE_DUEL_EMOTES, raceLanePercent } from '../shared/liveDuel.js';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RESULT_TEXT = { won: 'You won!', lost: 'You lost', draw: 'A draw', none: 'Nobody played' };
const RESULT_ICON = { won: '🏆', lost: '💪', draw: '🤝', none: '⏸️' };

export function ratingDeltaText(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return '±0';
  return n > 0 ? `+${n}` : String(n);
}

/** The question as the player sees it: add/sub rows stacked, others on one line. */
export function buildQuestionHtml(q) {
  if (!q) return '<div class="ld-q ld-q-done">That is every question. Well done!</div>';
  if (q.type === 'add_sub' && Array.isArray(q.rows)) {
    const rows = q.rows.map((n, i) => {
      const sign = n < 0 ? '−' : i === 0 ? '' : '+';
      return `<div class="ld-row"><span class="ld-sign">${sign}</span>${Math.abs(n)}</div>`;
    });
    return `<div class="ld-q ld-q-rows" aria-label="${esc(q.text)}">${rows.join('')}</div>`;
  }
  const text = String(q.text ?? '').replace(/\s[x*]\s/i, ' × ').replace(/\s\/\s/, ' ÷ ');
  return `<div class="ld-q ld-q-line">${esc(text)}</div>`;
}

/** Two race lanes: me and the opponent, sized against the leader. */
export function buildLanesHtml({ myName = 'You', otherName = 'Opponent', mine = 0, theirs = 0, ghost = false }) {
  const lane = (who, name, n, other, cls) => `
    <div class="ld-lane ${cls}">
      <div class="ld-lane-head"><span class="ld-lane-name">${esc(name)}</span><span class="ld-lane-n num">${n}</span></div>
      <div class="ld-track" role="progressbar" aria-label="${esc(who)} correct answers" aria-valuenow="${n}">
        <div class="ld-fill" style="width:${raceLanePercent(n, other)}%"><span class="ld-runner" aria-hidden="true">${cls === 'is-me' ? '🏃' : ghost ? '👻' : '🏃'}</span></div>
      </div>
    </div>`;
  return lane('Your', myName, mine, theirs, 'is-me') + lane('Their', otherName, theirs, mine, 'is-other');
}

export function buildEmoteBarHtml(muted = false) {
  const buttons = Object.entries(LIVE_DUEL_EMOTES)
    .map(([key, icon]) => `<button type="button" class="ld-emote" data-emote="${key}" aria-label="Send ${key}">${icon}</button>`)
    .join('');
  return `${buttons}<button type="button" class="ld-mute" data-mute aria-pressed="${muted}">${muted ? '🔇 Emotes off' : '🔔 Emotes on'}</button>`;
}

export function buildResultHtml(state) {
  const result = state?.result || 'none';
  const me = state?.me || {};
  const other = state?.other || {};
  const ratingLine = state?.kind === 'ghost' && result !== 'none'
    ? `Duel rating ${ratingDeltaText(me.rating_delta)} (ghost races count half)`
    : `Duel rating ${ratingDeltaText(me.rating_delta)}`;
  const rematchLabel = me.rematch ? 'Waiting for them…' : other.rematch ? 'Accept rematch' : 'Rematch';
  return `
    <div class="ld-result is-${esc(result)}">
      <div class="ld-result-ic" aria-hidden="true">${RESULT_ICON[result] || '⚔️'}</div>
      <h2>${RESULT_TEXT[result] || 'Duel over'}</h2>
      <p class="ld-score num"><strong>${Number(me.correct) || 0}</strong> – <strong>${Number(other.correct) || 0}</strong></p>
      <p class="ar-dim">You: ${Number(me.correct) || 0} correct of ${Number(me.attempted) || 0}. ${esc(other.name || 'Opponent')}: ${Number(other.correct) || 0} of ${Number(other.attempted) || 0}.</p>
      ${result === 'none' ? '' : `<div class="ld-rewards">
        <span class="ld-chip">⭐ +${Number(me.xp) || 0} XP</span>
        <span class="ld-chip">📈 ${esc(ratingLine)}</span>
        ${me.rating ? `<span class="ld-chip">Rating ${Number(me.rating)}</span>` : ''}
      </div>`}
      ${other.rematch && !me.rematch ? `<p class="ld-note">${esc(other.name)} wants a rematch!</p>` : ''}
      <div class="ld-actions">
        <button type="button" class="btn btn-primary" data-rematch ${me.rematch ? 'disabled' : ''}>${rematchLabel}</button>
        <a class="btn btn-outline" href="/pages/live-duel.html">Back to lobby</a>
      </div>
    </div>`;
}

export function buildRatingHtml(rating) {
  const r = rating || {};
  return `
    <div class="ld-rating">
      <div><span class="ld-big num">${Number(r.rating) || 1000}</span><span class="ar-dim">Duel rating</span></div>
      <div class="ar-dim num">${Number(r.won) || 0} won · ${Number(r.drawn) || 0} drawn · ${Number(r.lost) || 0} lost</div>
    </div>`;
}

export function buildInvitesHtml(invites = [], sent = []) {
  const parts = [];
  for (const inv of invites) {
    parts.push(`
      <div class="ld-invite" data-invite="${esc(inv.id)}">
        <span>⚡ <strong>${esc(inv.from_name)}</strong> challenges you to a live duel · ${esc(inv.category_name)}</span>
        <span class="ld-actions">
          <button type="button" class="btn btn-primary btn-sm" data-accept="${esc(inv.id)}">Accept</button>
          <button type="button" class="btn btn-outline btn-sm" data-decline="${esc(inv.id)}">Not now</button>
        </span>
      </div>`);
  }
  for (const s of sent) {
    parts.push(`
      <div class="ld-invite is-sent">
        <span>⏳ Waiting for <strong>${esc(s.to_name)}</strong> to accept…</span>
        <button type="button" class="btn btn-outline btn-sm" data-cancel-invite="${esc(s.id)}">Cancel</button>
      </div>`);
  }
  return parts.join('');
}

export function buildClassmatesHtml(opponents = [], online = new Set()) {
  if (!opponents.length) return '<p class="ar-dim">No classmates at your level yet.</p>';
  const sorted = [...opponents].sort((x, y) => Number(online.has(y.id)) - Number(online.has(x.id)));
  return `<ul class="ar-board ld-mates">${sorted
    .map((o) => {
      const on = online.has(o.id);
      return `<li><span class="ld-dot ${on ? 'is-on' : ''}" title="${on ? 'Online now' : 'Offline'}"></span>
        <span class="ar-name">${esc(o.display_name)}</span>
        <button type="button" class="btn btn-outline btn-sm" data-challenge="${esc(o.id)}" ${on ? '' : 'disabled'}>${on ? 'Challenge' : 'Offline'}</button></li>`;
    })
    .join('')}</ul>`;
}

export function buildBoardHtml(board = []) {
  if (!board.length) return '<p class="ar-dim">Nobody has a duel rating yet. Be the first!</p>';
  return `<ol class="ar-board">${board
    .map((b, i) => `<li class="${b.me ? 'me' : ''}"><span class="ar-rank">#${i + 1}</span><span class="ar-name">${esc(b.display_name)}</span><span class="ar-xp num">${Number(b.rating)}</span></li>`)
    .join('')}</ol>`;
}

export function buildRecentHtml(recent = []) {
  if (!recent.length) return '<p class="ar-dim">No live duels yet.</p>';
  return `<ul class="ar-board">${recent
    .map((r) => `<li><span class="ld-res is-${esc(r.result)}">${esc(r.result === 'won' ? 'Won' : r.result === 'lost' ? 'Lost' : 'Draw')}</span>
      <span class="ar-name">vs ${esc(r.other_name)} · ${esc(r.category_name)}</span>
      <span class="num">${Number(r.my_correct) || 0}–${Number(r.other_correct) || 0}</span>
      <span class="ar-dim num">${ratingDeltaText(r.rating_delta)}</span></li>`)
    .join('')}</ul>`;
}

export function buildStaffHtml(feed) {
  const duels = Array.isArray(feed?.duels) ? feed.duels : [];
  const toggle = feed?.can_toggle
    ? `<label class="ld-toggle"><input type="checkbox" data-live-toggle ${feed.enabled ? 'checked' : ''}/> Live duels are ${feed.enabled ? 'on' : 'off'} for students</label>`
    : `<p class="ar-dim">Live duels are ${feed?.enabled ? 'on' : 'off'}. Only admins can switch them.</p>`;
  const flagged = duels.filter((d) => d.flagged).length;
  const rows = duels.length
    ? `<div class="table-wrap"><table class="table ld-staff"><thead><tr><th>When</th><th>Players</th><th>Score</th><th>Winner</th><th>Type</th><th></th></tr></thead><tbody>${duels
      .map((d) => `<tr class="${d.flagged ? 'is-flagged' : ''}">
        <td class="num">${esc(new Date(d.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td>
        <td>${esc(d.a_name)} vs ${esc(d.b_name)}<div class="ar-dim">${esc(d.level)} · ${esc(d.category_name)}</div></td>
        <td class="num">${Number(d.a_correct) || 0}/${Number(d.a_attempted) || 0} – ${Number(d.b_correct) || 0}/${Number(d.b_attempted) || 0}</td>
        <td>${esc(d.winner || (d.status === 'live' ? 'Playing…' : '—'))}</td>
        <td>${esc(d.kind)}</td>
        <td>${d.flagged ? '<span class="ld-flag" title="An answer came in faster than a person can type">⚠️ Too fast</span>' : ''}</td></tr>`)
      .join('')}</tbody></table></div>`
    : '<p class="ar-dim">No live duels in the last 7 days.</p>';
  return `${toggle}<p class="ar-dim">${duels.length} live duels in the last 7 days${flagged ? ` · <strong>${flagged} flagged</strong>` : ''}.</p>${rows}`;
}
