/**
 * Trendz Tracker - pure builders for the Arena page and home card (js/arenaView.js)
 *
 * Leagues, duels, class vs class and the reward shop are all worked out in the database
 * (league_board, my_duels, duel_options, class_vs_class, reward_shop, reward_admin,
 * arena_summary). These functions only turn that data into HTML and text.
 *
 * Kindness rules: nobody else's drop is ever shown; the student's own "down" zone is
 * worded as encouragement; class vs class compares average XP per student so small
 * classes are not punished; duels reward correct answers first, time only breaks ties.
 */

import { escapeXpHtml as esc, formatXp } from './xpRewards.js';
import { avatarHtml } from './avatars.js';

const IST = 'Asia/Kolkata';

export function shortDay(value) {
  if (!value) return '';
  const d = new Date(String(value).length === 10 ? `${value}T00:00:00+05:30` : value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'short' }).format(d);
}

export function tierById(tiers, tier) {
  return (Array.isArray(tiers) ? tiers : []).find((t) => Number(t?.tier) === Number(tier)) || null;
}

/* ------------------------------------------------------------------ League */

/** One friendly line about how last week went. */
export function leagueLastText(last, tiers) {
  if (!last) return '';
  const after = tierById(tiers, last.tier_after);
  const name = after ? `${after.icon} ${after.name}` : `league ${last.tier_after}`;
  const place = last.rank && last.group_size ? ` You finished #${formatXp(last.rank)} of ${formatXp(last.group_size)}.` : '';
  if (Number(last.tier_after) > Number(last.tier_before)) return `🎉 Promoted to ${name}!${place}`;
  if (Number(last.tier_after) < Number(last.tier_before)) return `Last week you moved to ${name}. A few rounds this week will lift you back up.${place}`;
  return `You stayed in ${name} last week.${place}`;
}

export function zoneLabel(zone, isMe) {
  if (zone === 'up') return '<span class="ar-zone ar-up" title="On course to move up">⬆️ Moving up</span>';
  if (zone === 'down' && isMe) return '<span class="ar-zone ar-down" title="Earn some XP this week to stay">💪 Earn XP to stay</span>';
  return '';
}

export function buildLeagueLadderHtml(tiers, currentTier) {
  return `<ol class="ar-ladder">${(Array.isArray(tiers) ? tiers : [])
    .map((t) => `<li class="${Number(t.tier) === Number(currentTier) ? 'is-current' : ''}${Number(t.tier) < Number(currentTier) ? ' is-past' : ''}">`
      + `<span aria-hidden="true">${esc(t.icon)}</span><b>${esc(t.name)}</b><span class="ar-dim">${formatXp(t.students)}</span></li>`)
    .join('')}</ol>`;
}

export function buildLeagueHtml(board, avatarUrls = new Map()) {
  if (!board) return '<p class="ar-dim">Could not load the league right now.</p>';
  if (board.member === false) {
    return '<p class="ar-dim">Leagues are for students who appear on the leaderboard. Ask your trainer if you would like to join.</p>';
  }
  const tier = tierById(board.tiers, board.tier);
  const rows = Array.isArray(board.rows) ? board.rows : [];
  let html = `<div class="ar-league-head"><span class="ar-league-ic" aria-hidden="true">${esc(tier?.icon || '🏅')}</span>`
    + `<div><h2>${esc(tier?.name || 'League')} league</h2>`
    + `<p class="ar-dim">This week: ${esc(shortDay(board.week?.from))} – ${esc(shortDay(board.week?.to))}. `
    + 'The top of each group moves up on Monday. Every correct answer earns XP.</p></div></div>';
  html += buildLeagueLadderHtml(board.tiers, board.tier);
  const last = leagueLastText(board.last, board.tiers);
  if (last && !board.staff) html += `<p class="ar-last">${esc(last)}</p>`;
  if (!rows.length) return `${html}<p class="ar-dim">Nobody is in this league yet.</p>`;
  let group = null;
  html += '<ol class="ar-board">';
  for (const r of rows) {
    if (board.staff && r.group !== group) {
      group = r.group;
      html += `<li class="ar-group">${esc(group)}</li>`;
    }
    html += `<li class="${r.is_me ? 'me' : ''}"><span class="ar-rank">#${formatXp(r.rank)}</span>`
      + `${avatarHtml(avatarUrls.get(r.avatar_path) || null, r.display_name, 28)}`
      + `<span class="ar-name">${esc(r.display_name)}${r.is_me ? ' (you)' : ''}</span>`
      + `${zoneLabel(r.zone, r.is_me || board.staff)}`
      + `<b class="ar-xp">${formatXp(r.xp)} XP</b></li>`;
  }
  return `${html}</ol>`;
}

/* ------------------------------------------------------------------- Duels */

export function duelScore(correct, total) {
  if (correct === null || correct === undefined) return '–';
  return `${formatXp(correct)}/${formatXp(total)}`;
}

/** Short status line for one duel from the caller's side. */
export function duelStatusText(d) {
  if (!d) return '';
  if (d.status === 'done') {
    if (d.forfeit) return d.result === 'won' ? 'You won — your classmate did not play in time.' : 'Time ran out before you played.';
    if (d.result === 'won') return 'You won! 🏆';
    if (d.result === 'draw') return 'Draw 🤝';
    return 'Your classmate won this time.';
  }
  if (d.status === 'expired') return 'Expired — nobody played.';
  if (d.status === 'declined') return d.role === 'opponent' ? 'You declined.' : 'Your classmate declined.';
  if (d.status === 'cancelled') return d.role === 'challenger' ? 'You cancelled.' : 'Cancelled by your classmate.';
  if (d.my_done) return d.other_done ? 'Working out the result…' : 'Waiting for your classmate to play.';
  if (d.my_started) return 'Your round is in progress.';
  return d.other_done ? 'Your classmate has played — your turn!' : 'Your turn!';
}

export function duelPlayHref(d) {
  return `/pages/basics-practice.html?duel=${encodeURIComponent(d.id)}`;
}

export function buildDuelListHtml(duels, avatarUrls = new Map()) {
  const list = Array.isArray(duels) ? duels : [];
  if (!list.length) return '<p class="ar-dim">No duels yet. Challenge a classmate below!</p>';
  return `<ul class="ar-duels">${list.map((d) => {
    const open = d.status === 'open';
    const canPlay = open && !d.my_started;
    const canCancel = open && !d.my_started && !d.other_done;
    const resultClass = d.result ? `is-${d.result}` : open ? 'is-open' : 'is-closed';
    const vs = d.role === 'challenger' ? 'You challenged' : 'Challenge from';
    return `<li class="ar-duel ${resultClass}">`
      + `${avatarHtml(avatarUrls.get(d.other_avatar) || null, d.other_name, 34)}`
      + `<div class="ar-duel-main"><b>${esc(vs)} ${esc(d.other_name)}</b>`
      + `<span class="ar-dim">${esc(d.category_name)} · 1 minute${open ? ` · until ${esc(shortDay(d.expires_at))}` : ''}</span>`
      + `<span class="ar-duel-status">${esc(duelStatusText(d))}</span></div>`
      + `<div class="ar-duel-score"><span>You <b>${duelScore(d.my_correct, d.my_total)}</b></span>`
      + `<span>Them <b>${d.my_done || !open ? duelScore(d.other_correct, d.other_total) : d.other_done ? '✔ played' : '–'}</b></span></div>`
      + '<div class="ar-duel-actions">'
      + (canPlay ? `<a class="btn btn-primary btn-sm" href="${esc(duelPlayHref(d))}">⚔️ Play</a>` : '')
      + (canCancel ? `<button type="button" class="btn btn-outline btn-sm" data-duel-cancel="${esc(d.id)}">${d.role === 'challenger' ? 'Cancel' : 'Decline'}</button>` : '')
      + '</div></li>';
  }).join('')}</ul>`;
}

export function buildDuelFormHtml(options) {
  const opponents = Array.isArray(options?.opponents) ? options.opponents : [];
  const categories = Array.isArray(options?.categories) ? options.categories : [];
  const left = Math.max(0, Number(options?.daily_limit ?? 3) - Number(options?.created_today ?? 0));
  if (!opponents.length) return '<p class="ar-dim">There is nobody else at your level to duel yet.</p>';
  if (!categories.length) return '<p class="ar-dim">No practice types are available for duels yet.</p>';
  const free = opponents.filter((o) => !o.busy);
  return '<form class="ar-duel-form" id="ar-duel-form">'
    + '<label>Classmate<select name="opponent" required>'
    + (free.length ? free.map((o) => `<option value="${esc(o.id)}">${esc(o.display_name)}</option>`).join('') : '<option value="">Everyone already has a duel with you</option>')
    + '</select></label>'
    + '<label>Practice<select name="category" required>'
    + categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')
    + '</select></label>'
    + `<button type="submit" class="btn btn-primary btn-sm" ${left && free.length ? '' : 'disabled'}>⚔️ Send duel</button>`
    + `<p class="ar-dim ar-full">You can send ${formatXp(left)} more today. You both get the same questions; correct answers win, time only breaks a tie.</p>`
    + '</form>';
}

/* ---------------------------------------------------------- Class vs class */

export function buildClassVsClassHtml(data) {
  const classes = Array.isArray(data?.classes) ? data.classes : [];
  if (!classes.length) return '<p class="ar-dim">No classes to compare yet.</p>';
  const top = Math.max(1, ...classes.map((c) => Number(c.avg_xp) || 0));
  const label = data.period === 'month' ? 'This month' : 'This week';
  return `<p class="ar-dim">${esc(label)} (${esc(shortDay(data.from))} – ${esc(shortDay(data.to))}): average XP per student, so every class has a fair chance whatever its size.</p>`
    + `<ol class="ar-cvc">${classes.map((c) => {
      const pct = Math.round(((Number(c.avg_xp) || 0) / top) * 100);
      return `<li class="${c.is_mine ? 'me' : ''}"><span class="ar-rank">#${formatXp(c.rank)}</span>`
        + `<span class="ar-cvc-name">${esc(c.level)}${c.is_mine ? ' (your class)' : ''}</span>`
        + `<span class="ar-cvc-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`
        + `<b>${formatXp(c.avg_xp)}</b><span class="ar-dim">${formatXp(c.active)}/${formatXp(c.students)} practised</span></li>`;
    }).join('')}</ol>`;
}

/* ----------------------------------------------------------------- Rewards */

export const REWARD_STATUS_LABELS = Object.freeze({
  requested: '⏳ Waiting — collect it from your trainer',
  given: '✅ Collected',
  rejected: '✖ Not given (XP returned)',
  cancelled: '↩ Cancelled (XP returned)',
});

export function buildRewardShopHtml(shop) {
  if (!shop) return '<p class="ar-dim">Could not load the reward shop right now.</p>';
  const items = Array.isArray(shop.items) ? shop.items : [];
  const balance = Number(shop.balance) || 0;
  let html = `<div class="ar-wallet"><div><span class="ar-dim">XP to spend</span><b>${formatXp(balance)}</b></div>`
    + `<div><span class="ar-dim">Earned</span><b>${formatXp(shop.earned)}</b></div>`
    + `<div><span class="ar-dim">Spent</span><b>${formatXp(shop.spent)}</b></div></div>`
    + '<p class="ar-dim">Spending XP never lowers your level, tier or place on the leaderboard.</p>';
  if (!items.length) {
    html += '<p class="ar-dim">No rewards in the shop yet — your trainer will add some soon.</p>';
  } else {
    html += `<ul class="ar-shop">${items.map((i) => {
      const out = i.stock !== null && i.stock !== undefined && Number(i.stock) <= 0;
      const short = Math.max(0, Number(i.cost) - balance);
      const button = !shop.can_request
        ? ''
        : out
          ? '<button type="button" class="btn btn-outline btn-sm" disabled>Out of stock</button>'
          : short > 0
            ? `<button type="button" class="btn btn-outline btn-sm" disabled>${formatXp(short)} XP to go</button>`
            : `<button type="button" class="btn btn-primary btn-sm" data-reward="${esc(i.id)}" data-reward-name="${esc(i.name)}" data-reward-cost="${esc(i.cost)}">Get it</button>`;
      return `<li><span class="ar-shop-ic" aria-hidden="true">${esc(i.icon)}</span><b>${esc(i.name)}</b>`
        + (i.description ? `<span class="ar-dim">${esc(i.description)}</span>` : '')
        + `<span class="ar-cost">${formatXp(i.cost)} XP${i.stock !== null && i.stock !== undefined ? ` · ${formatXp(i.stock)} left` : ''}</span>${button}</li>`;
    }).join('')}</ul>`;
  }
  const reds = Array.isArray(shop.redemptions) ? shop.redemptions : [];
  if (reds.length) {
    html += `<h3 class="ar-h3">My rewards</h3><ul class="ar-reds">${reds.map((r) =>
      `<li><span aria-hidden="true">${esc(r.icon)}</span><b>${esc(r.name)}</b><span class="ar-dim">${formatXp(r.cost)} XP · ${esc(shortDay(r.requested_at))}</span>`
      + `<span class="ar-red-status">${esc(REWARD_STATUS_LABELS[r.status] || r.status)}${r.note ? ` — ${esc(r.note)}` : ''}</span>`
      + (r.status === 'requested' && shop.can_request ? `<button type="button" class="btn btn-outline btn-sm" data-reward-cancel="${esc(r.id)}">Cancel</button>` : '')
      + '</li>').join('')}</ul>`;
  }
  return html;
}

export function buildRewardAdminHtml(admin) {
  if (!admin) return '<p class="ar-dim">Could not load rewards.</p>';
  const items = Array.isArray(admin.items) ? admin.items : [];
  const requests = Array.isArray(admin.requests) ? admin.requests : [];
  const waiting = requests.filter((r) => r.status === 'requested');
  let html = `<h3 class="ar-h3">Requests waiting (${formatXp(waiting.length)})</h3>`;
  html += waiting.length
    ? `<ul class="ar-reds">${waiting.map((r) =>
      `<li><span aria-hidden="true">${esc(r.icon)}</span><b>${esc(r.name)}</b>`
      + `<span>${esc(r.student_name || '')}${r.student_code ? ` · ${esc(r.student_code)}` : ''}${r.level ? ` · ${esc(r.level)}` : ''}</span>`
      + `<span class="ar-dim">${formatXp(r.cost)} XP · ${esc(shortDay(r.requested_at))}</span>`
      + `<span class="ar-red-actions"><button type="button" class="btn btn-primary btn-sm" data-decide="given" data-id="${esc(r.id)}">Mark given</button>`
      + `<button type="button" class="btn btn-outline btn-sm" data-decide="rejected" data-id="${esc(r.id)}">Reject</button></span></li>`).join('')}</ul>`
    : '<p class="ar-dim">No requests waiting.</p>';
  html += '<h3 class="ar-h3">Shop items</h3>';
  html += items.length
    ? `<ul class="ar-shop ar-shop-admin">${items.map((i) =>
      `<li class="${i.active ? '' : 'is-off'}"><span class="ar-shop-ic" aria-hidden="true">${esc(i.icon)}</span><b>${esc(i.name)}</b>`
      + `<span class="ar-cost">${formatXp(i.cost)} XP · ${i.stock === null || i.stock === undefined ? 'unlimited' : `${formatXp(i.stock)} left`} · ${formatXp(i.given)} given${i.active ? '' : ' · hidden'}</span>`
      + `<button type="button" class="btn btn-outline btn-sm" data-edit-item="${esc(i.id)}">Edit</button></li>`).join('')}</ul>`
    : '<p class="ar-dim">No items yet. Add the first reward below.</p>';
  const done = requests.filter((r) => r.status !== 'requested').slice(0, 30);
  if (done.length) {
    html += `<details class="ar-history"><summary>Recent decisions (${formatXp(done.length)})</summary><ul class="ar-reds">${done.map((r) =>
      `<li><span aria-hidden="true">${esc(r.icon)}</span><b>${esc(r.name)}</b><span>${esc(r.student_name || '')}</span>`
      + `<span class="ar-dim">${esc(r.status)} · ${esc(shortDay(r.decided_at || r.requested_at))}</span></li>`).join('')}</ul></details>`;
  }
  return html;
}

/** Validates the admin item form; returns { ok, value } or { ok: false, error }. */
export function parseRewardItemForm(raw) {
  const name = String(raw?.name ?? '').trim();
  const icon = String(raw?.icon ?? '').trim() || '🎁';
  const description = String(raw?.description ?? '').trim();
  const cost = Number(raw?.cost);
  const stockRaw = String(raw?.stock ?? '').trim();
  const stock = stockRaw === '' ? null : Number(stockRaw);
  if (!name || name.length > 60) return { ok: false, error: 'Give the reward a name (up to 60 letters).' };
  if (description.length > 140) return { ok: false, error: 'Keep the description under 140 letters.' };
  if ([...icon].length > 4) return { ok: false, error: 'Use one emoji for the icon.' };
  if (!Number.isInteger(cost) || cost < 1 || cost > 1000000) return { ok: false, error: 'XP cost must be a whole number from 1.' };
  if (stock !== null && (!Number.isInteger(stock) || stock < 0)) return { ok: false, error: 'Stock must be empty (unlimited) or a whole number.' };
  return { ok: true, value: { name, icon, description, cost, stock, active: raw?.active !== false } };
}

/* --------------------------------------------------------------- Home card */

export function buildArenaSummaryHtml(s) {
  if (!s) return '';
  const lg = s.league;
  const parts = [];
  if (lg) {
    const zone = lg.zone === 'up' ? ' · ⬆️ moving up' : '';
    parts.push(`<a class="ar-chip" href="/pages/arena.html#league">${esc(lg.icon)} ${esc(lg.name)} league · #${formatXp(lg.rank)} of ${formatXp(lg.size)}${zone}</a>`);
  }
  const duels = Number(s.duels_to_play) || 0;
  parts.push(`<a class="ar-chip${duels ? ' is-hot' : ''}" href="/pages/arena.html#duels">⚔️ ${duels ? `${formatXp(duels)} duel${duels === 1 ? '' : 's'} to play` : 'Challenge a classmate'}</a>`);
  parts.push('<a class="ar-chip" href="/pages/arena.html#classes">🏫 Class vs class</a>');
  if (Number(s.rewards_available) > 0) {
    parts.push(`<a class="ar-chip" href="/pages/arena.html#rewards">🎁 ${formatXp(s.reward_balance)} XP to spend</a>`);
  }
  return '<div class="gm-row"><h2>🏟️ Arena</h2><a class="btn btn-outline btn-sm" href="/pages/arena.html">Open</a></div>'
    + `<div class="ar-chips">${parts.join('')}</div>`;
}

/* ------------------------------------------------------------ Certificates */

const AWARD_KIND_TEXT = Object.freeze({ week: 'Champion of the Week', month: 'Star of the Month' });

/**
 * What a certificate says, from `my_profile` data. Only earned badges get one.
 * `badgeKey` is a badge key; returns null when there is nothing to certify.
 */
export function buildCertificateModel(profileData, badgeKey) {
  const badges = Array.isArray(profileData?.badges) ? profileData.badges : [];
  const badge = badges.find((b) => b?.key === badgeKey && b?.earned_at);
  if (!badge) return null;
  const name = String(profileData?.profile?.full_name || '').trim() || 'Student';
  let detail = badge.description || '';
  if (badge.category === 'award') {
    const awards = Array.isArray(profileData?.awards) ? profileData.awards : [];
    const kind = /month/i.test(badge.key) ? 'month' : /week/i.test(badge.key) ? 'week' : null;
    const latest = kind ? awards.find((a) => a?.kind === kind) : null;
    if (latest) detail = `${AWARD_KIND_TEXT[kind]} · ${shortDay(latest.from)} – ${shortDay(latest.to)}`;
  }
  return {
    name,
    title: badge.name,
    icon: badge.icon,
    detail,
    level: profileData?.profile?.level || '',
    date: new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(badge.earned_at)),
  };
}
