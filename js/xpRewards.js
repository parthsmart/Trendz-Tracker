/**
 * Trendz Tracker - XP, personal bests and the end-of-round card (js/xpRewards.js)
 *
 * XP, tiers, personal bests, ranks and streaks are never computed in JS: they come from the
 * database (student_xp_events, filled by triggers when a trusted round is saved) through
 * the RPCs `xp_round_summary_for(p_source_id)` and `my_xp_summary(p_student)`.
 * This file only formats what those return.
 */

import { getSupabase, DemoDB } from './supabaseClient.js';
import { avatarHtml, ensureAvatarStyles, signAvatarUrls } from './avatars.js';
import { celebrate, countUpWithin } from './motion.js';

const STYLE_ID = 'xp-rewards-style';
const CARD_CLASS = 'xp-round-card';

/** Escapes text for HTML. */
export function escapeXpHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 12345 -> "12,345". */
export function formatXp(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-IN');
}

const TIER_ICONS = {
  Bronze: '🥉',
  Silver: '🥈',
  Gold: '🥇',
  Platinum: '💠',
  Diamond: '💎',
  Master: '👑',
  Legend: '🌟',
};

export function tierIcon(name) {
  return TIER_ICONS[name] || '⭐';
}

/**
 * Progress through the current tier, from the RPC's tier object.
 * Returns { name, icon, pct, toNext, nextName } (pct 100 at the top tier).
 */
export function tierProgress(totalXp, tier) {
  const t = tier || {};
  const total = Math.max(0, Number(totalXp) || 0);
  const floor = Number(t.floor) || 0;
  const next = t.next_floor == null ? null : Number(t.next_floor);
  if (next == null || next <= floor) {
    return { name: t.name || 'Bronze', icon: tierIcon(t.name), pct: 100, toNext: 0, nextName: null };
  }
  const pct = Math.max(0, Math.min(100, Math.floor(((total - floor) / (next - floor)) * 100)));
  return { name: t.name || 'Bronze', icon: tierIcon(t.name), pct, toNext: Math.max(0, next - total), nextName: t.next_name || null };
}

/** "Rounds 6-10 of the same practice today earn half XP" style note, or ''. */
export function dailyFactorNote(factor) {
  const f = Number(factor);
  if (!Number.isFinite(f) || f >= 1) return '';
  if (f >= 0.5) return 'Half XP: you have done this practice 5+ times today. Try something different for full XP.';
  return 'Quarter XP: you have done this practice 10+ times today. Try something different for full XP.';
}

/** Streak line for the card. */
export function streakLine(streak) {
  const s = streak || {};
  const current = Number(s.current) || 0;
  const shields = Number(s.shields) || 0;
  if (current <= 0) return 'Start a streak: practise again tomorrow.';
  const base = `🔥 ${current}-day streak`;
  const shieldText = shields > 0 ? ` · 🛡️ ${shields} streak shield${shields === 1 ? '' : 's'}` : '';
  return `${base}${shieldText}`;
}

/** "18 XP behind Riya S." / "You lead your level this week" / '' when unranked. */
export function rankLine(weekRank) {
  const r = weekRank || {};
  if (!r.rank) return '';
  const pos = `#${r.rank} in ${r.level || 'your level'} this week`;
  if (r.rank === 1 || !r.above_name) return `🏆 ${pos}. You are on top!`;
  return `🏆 ${pos} · ${formatXp(r.gap)} XP behind ${r.above_name}`;
}

/**
 * Builds the end-of-round card HTML from `xp_round_summary_for`.
 * Returns '' when the round earned nothing (not saved, nothing answered, awaiting verification).
 */
export function buildRoundCardHtml(summary) {
  if (!summary || !summary.round) return '';
  const r = summary.round;
  const xp = Number(r.xp) || 0;
  const bonus = Number(r.bonus_xp) || 0;
  const tp = tierProgress(summary.total_xp, summary.tier);

  let bestHtml = '';
  if (r.personal_best) {
    bestHtml = `<div class="xp-pb">🎉 New personal best: <strong>${escapeXpHtml(r.score)}</strong>`
      + (r.prev_best ? ` <span class="xp-dim">(was ${escapeXpHtml(r.prev_best)})</span>` : '')
      + ` <span class="xp-chip">+${bonus} XP bonus</span></div>`;
  } else if (r.first_best) {
    bestHtml = `<div class="xp-pb">⭐ First score for this practice: <strong>${escapeXpHtml(r.score)}</strong>. Beat it next time for +25 XP.</div>`;
  } else if (r.last_time) {
    bestHtml = `<div class="xp-dim">Last time: ${escapeXpHtml(r.last_time)} · This time: ${escapeXpHtml(r.score)}</div>`;
  }

  const note = dailyFactorNote(r.daily_factor);
  const rank = rankLine(summary.week_rank);
  const newBadges = Array.isArray(summary.new_badges) ? summary.new_badges : [];
  const badgesHtml = newBadges.length
    ? `<div class="xp-badges">${newBadges
        .map((b) => `<span class="xp-badge" title="${escapeXpHtml(b?.description)}">${escapeXpHtml(b?.icon)} <b>${escapeXpHtml(b?.name)}</b></span>`)
        .join('')}<a class="xp-badges-link" href="/pages/profile.html">Badge unlocked! See all ›</a></div>`
    : '';
  const nextText = tp.nextName
    ? `${formatXp(tp.toNext)} XP to ${tierIcon(tp.nextName)} ${escapeXpHtml(tp.nextName)}`
    : 'Top tier reached';

  return `
    <div class="xp-head">
      <div class="xp-gain">+${formatXp(xp)} XP</div>
      <div class="xp-head-side">
        <div class="xp-tier">${tp.icon} ${escapeXpHtml(tp.name)} · ${formatXp(summary.total_xp)} XP</div>
        <div class="xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${tp.pct}" aria-label="Progress to next tier"><span style="width:${tp.pct}%"></span></div>
        <div class="xp-dim">${nextText}</div>
      </div>
    </div>
    ${bestHtml}
    ${badgesHtml}
    <div class="xp-meta">
      <span>${escapeXpHtml(streakLine(summary.streak))}</span>
      <span>📅 ${formatXp(summary.week_xp)} XP this week</span>
    </div>
    ${rank ? `<div class="xp-meta"><span>${escapeXpHtml(rank)}</span></div>` : ''}
    ${note ? `<div class="xp-note">${escapeXpHtml(note)}</div>` : ''}
  `;
}

/** Shared styles for the round card and the progress card (injected once). */
export function ensureXpStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${CARD_CLASS}, .xp-progress-card { border: 1px solid var(--border-color, #e2e8f0); border-radius: 14px; padding: 14px 16px; margin: 12px 0; background: var(--bg-card, var(--surface, #fff)); }
    .${CARD_CLASS} { border-left: 4px solid #f59e0b; animation: xp-pop .35s ease-out; }
    @keyframes xp-pop { from { transform: scale(.97); opacity: 0; } to { transform: none; opacity: 1; } }
    .xp-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .xp-gain { font-size: 28px; font-weight: 800; color: #d97706; line-height: 1; }
    .xp-head-side { flex: 1; min-width: 180px; }
    .xp-tier { font-weight: 700; margin-bottom: 4px; }
    .xp-bar { height: 8px; border-radius: 99px; background: var(--border-color, #e2e8f0); overflow: hidden; margin-bottom: 4px; }
    .xp-bar > span { display: block; height: 100%; background: linear-gradient(90deg, #f59e0b, #ef4444); border-radius: 99px; }
    .xp-dim { color: var(--text-muted, #64748b); font-size: 13px; }
    .xp-pb { margin-top: 10px; font-size: 14px; }
    .xp-chip { display: inline-block; background: #fef3c7; color: #92400e; border-radius: 99px; padding: 1px 8px; font-size: 12px; font-weight: 700; }
    .xp-meta { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 13px; }
    .xp-note { margin-top: 8px; font-size: 12px; color: var(--text-muted, #64748b); }
    .xp-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 10px 0; }
    .xp-stat { border: 1px solid var(--border-color, #e2e8f0); border-radius: 10px; padding: 8px 10px; }
    .xp-stat b { display: block; font-size: 20px; }
    .xp-list { list-style: none; margin: 6px 0 0; padding: 0; font-size: 13px; }
    .xp-list li { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--border-color, #f1f5f9); }
    .xp-list li:last-child { border-bottom: 0; }
    .xp-list .me { font-weight: 700; }
    .xp-section-title { font-weight: 700; margin-top: 12px; font-size: 14px; }
    .xp-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 10px; }
    .xp-badge { display: inline-flex; align-items: center; gap: 4px; background: #ede9fe; color: #5b21b6; border-radius: 99px; padding: 3px 10px; font-size: 13px; animation: xp-pop .5s ease-out; }
    .xp-badges-link { font-size: 12.5px; }
  `;
  doc.head.appendChild(style);
}

/** Calls an XP RPC; returns null on any failure (XP must never break a result screen). */
export async function callXpRpc(name, args) {
  let supabase = null;
  try {
    supabase = await getSupabase();
  } catch {
    supabase = null;
  }
  if (!supabase) {
    try {
      return DemoDB?.mockXpRpc ? await DemoDB.mockXpRpc(name, args) : null;
    } catch {
      return null;
    }
  }
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

export function fetchRoundSummary(sourceId) {
  if (!sourceId) return Promise.resolve(null);
  return callXpRpc('xp_round_summary_for', { p_source_id: String(sourceId) });
}

export function fetchXpSummary(studentId = null) {
  return callXpRpc('my_xp_summary', { p_student: studentId });
}

/** Removes a previously shown round card inside `scope`. */
export function clearRoundRewards(scope = globalThis.document) {
  scope?.querySelectorAll?.(`.${CARD_CLASS}`).forEach((el) => el.remove());
}

/**
 * Shows the XP card for one saved round, just before `anchor` (or at the top of `container`).
 * `sourceId` is the saved row id returned by the save call. Does nothing when there is no id,
 * the round earned no XP, or the RPC fails.
 */
export async function showRoundRewards({ sourceId, anchor = null, container = null } = {}) {
  const host = anchor?.parentElement || container;
  if (!host || !sourceId) return null;
  clearRoundRewards(host);
  const summary = await fetchRoundSummary(sourceId);
  const html = buildRoundCardHtml(summary);
  if (!html) return null;
  ensureXpStyles(host.ownerDocument);
  clearRoundRewards(host);
  const card = host.ownerDocument.createElement('div');
  card.className = CARD_CLASS;
  card.setAttribute('role', 'status');
  card.innerHTML = html;
  if (anchor) host.insertBefore(card, anchor);
  else host.insertBefore(card, host.firstElementChild?.nextSibling || null);
  const hasBadge = Array.isArray(summary.new_badges) && summary.new_badges.length > 0;
  celebrate(hasBadge ? 'big' : summary.round?.personal_best ? 'pb' : 'small', card);
  countUpWithin(card);
  return card;
}

/**
 * Builds the student home "My XP" card from `my_xp_summary` plus the weekly XP board rows
 * (from `leaderboard(p_board => 'xp')`). Returns '' when there is no summary.
 */
export function buildProgressCardHtml(summary, boardRows = [], avatarUrls = new Map()) {
  if (!summary) return '';
  const tp = tierProgress(summary.total_xp, summary.tier);
  const streak = summary.streak || {};
  const rank = summary.week_rank || {};
  const nextText = tp.nextName
    ? `${formatXp(tp.toNext)} XP to ${tierIcon(tp.nextName)} ${escapeXpHtml(tp.nextName)}`
    : 'Top tier reached';
  const rankText = rankLine(rank);

  const rows = Array.isArray(boardRows) ? boardRows.slice(0, 5) : [];
  const boardHtml = rows.length
    ? `<ol class="xp-list">${rows.map((row) => `<li class="${row?.is_me ? 'me' : ''}"><span style="display:inline-flex;align-items:center;gap:6px">#${escapeXpHtml(row?.rank)} ${avatarHtml(avatarUrls.get(row?.avatar_path) || null, row?.display_name, 22)} ${escapeXpHtml(row?.display_name)}${row?.is_me ? ' (you)' : ''}</span><span>${formatXp(row?.value)} XP</span></li>`).join('')}</ol>`
    : '<div class="xp-dim">No XP earned in your level yet this week. Finish a round to get on the board.</div>';

  const bests = Array.isArray(summary.bests) ? summary.bests.slice(0, 6) : [];
  const bestsHtml = bests.length
    ? `<ul class="xp-list">${bests.map((b) => `<li><span>${escapeXpHtml(b?.label)}</span><span><strong>${escapeXpHtml(b?.score)}</strong> <span class="xp-dim">${escapeXpHtml(b?.day || '')}</span></span></li>`).join('')}</ul>`
    : '<div class="xp-dim">Score 70% or more in a round to set your first personal best.</div>';

  return `
    <div class="xp-head">
      <div class="xp-gain" style="font-size:22px">${tp.icon} ${escapeXpHtml(tp.name)}</div>
      <div class="xp-head-side">
        <div class="xp-tier">${formatXp(summary.total_xp)} XP total</div>
        <div class="xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${tp.pct}" aria-label="Progress to next tier"><span style="width:${tp.pct}%"></span></div>
        <div class="xp-dim">${nextText}</div>
      </div>
    </div>
    <div class="xp-stats">
      <div class="xp-stat"><span class="xp-dim">This week</span><b>${formatXp(summary.week_xp)} XP</b></div>
      <div class="xp-stat"><span class="xp-dim">Today</span><b>${formatXp(summary.today_xp)} XP</b></div>
      <div class="xp-stat"><span class="xp-dim">Streak</span><b>🔥 ${formatXp(streak.current)}</b><span class="xp-dim">${Number(streak.shields) > 0 ? `🛡️ ${formatXp(streak.shields)} shield${Number(streak.shields) === 1 ? '' : 's'}` : `Best ${formatXp(streak.best)}`}</span></div>
      <div class="xp-stat"><span class="xp-dim">Week rank</span><b>${rank.rank ? `#${formatXp(rank.rank)}` : '—'}</b><span class="xp-dim">${rank.of ? `of ${formatXp(rank.of)}` : ''}</span></div>
    </div>
    ${rankText ? `<div class="xp-meta"><span>${escapeXpHtml(rankText)}</span></div>` : ''}
    <div class="xp-section-title">This week's XP board</div>
    ${boardHtml}
    <div class="xp-section-title">Personal bests</div>
    ${bestsHtml}
    <div class="xp-meta"><a href="/pages/leaderboard.html?board=xp">See the full XP leaderboard ›</a><a href="/pages/profile.html">My badges &amp; profile ›</a></div>
  `;
}

/**
 * Renders the "My XP" card into `container` (student home). Hides it when XP is unavailable.
 * `loadBoard` returns the weekly XP board rows; it is injected so this file has no leaderboard dependency.
 */
export async function renderXpProgressCard(container, { studentId = null, loadBoard = null } = {}) {
  if (!container) return;
  const [summary, rows] = await Promise.all([
    fetchXpSummary(studentId),
    typeof loadBoard === 'function'
      ? Promise.resolve().then(loadBoard).catch(() => [])
      : Promise.resolve([]),
  ]);
  const boardRows = Array.isArray(rows) ? rows : [];
  ensureAvatarStyles(container.ownerDocument);
  const avatarUrls = await signAvatarUrls(boardRows.map((r) => r?.avatar_path));
  const html = buildProgressCardHtml(summary, boardRows, avatarUrls);
  if (!html) {
    container.hidden = true;
    return;
  }
  ensureXpStyles(container.ownerDocument);
  container.innerHTML = `<h2 class="xp-card-title" style="margin:0 0 10px;font-size:18px">⚡ My XP</h2>${html}`;
  container.hidden = false;
}
