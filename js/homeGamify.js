/**
 * Trendz Tracker - student home: daily challenge and stars cards (js/homeGamify.js)
 *
 * Daily challenge: one 1-minute basics round a day, the same questions for everyone in the
 * level, one attempt. The server picks the category (POST /api/drill, action challenge_info)
 * and the board comes from the `daily_challenge_board` RPC.
 * Stars: Star of the Month and Champion of the Week from the `star_of_month` RPC.
 * Nothing is ranked or scored in JS.
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { callXpRpc, escapeXpHtml as esc, formatXp } from './xpRewards.js';
import { avatarHtml, ensureAvatarStyles, signAvatarUrls } from './avatars.js';

async function accessToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export async function fetchChallengeInfo() {
  const token = await accessToken();
  if (!token) return null;
  try {
    const resp = await fetch('/api/drill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'challenge_info' }),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Seconds -> "42s" / "1m 05s". */
export function formatSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  const s = Math.round(n);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Board rows -> <ol>. `urls` maps avatar_path -> signed URL. */
export function buildChallengeBoardHtml(rows, urls = new Map()) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<p class="gm-sub">Nobody has played today’s challenge yet. Be the first!</p>';
  return `<ol class="gm-board">${list
    .map((r) => `<li class="${r?.is_me ? 'me' : ''}">`
      + `<span class="gm-rank">#${esc(r?.rank)}</span>`
      + avatarHtml(urls.get(r?.avatar_path) || null, r?.display_name, 26)
      + `<span class="gm-name">${esc(r?.display_name)}${r?.is_me ? ' (you)' : ''}</span>`
      + `<span class="gm-val"><b>${formatXp(r?.correct)}</b>/${formatXp(r?.total)}${r?.time_seconds != null ? ` · ${esc(formatSeconds(r.time_seconds))}` : ''}</span>`
      + '</li>')
    .join('')}</ol>`;
}

export function buildChallengeStatusHtml(info) {
  if (!info || !info.available) {
    return '<p class="gm-sub">No challenge for your level today. Keep practising and check back tomorrow!</p>';
  }
  const cat = esc(info.category?.name || 'Basics');
  const a = info.attempt;
  if (a?.submitted_at) {
    return `<div class="gm-row"><p class="gm-sub">Today: <b>${cat}</b> · You scored <b>${formatXp(a.correct)}/${formatXp(a.total)}</b>. New challenge tomorrow.</p></div>`;
  }
  if (a?.started_at) {
    return `<div class="gm-row"><p class="gm-sub">Today: <b>${cat}</b> · You started this challenge but did not finish it. One attempt per day, so it counts as played.</p></div>`;
  }
  return `<div class="gm-row"><p class="gm-sub">Today: <b>${cat}</b> · 1 minute · one attempt · same questions for your whole level.</p>`
    + '<a class="btn btn-primary btn-sm" href="/pages/basics-practice.html?challenge=1">🎲 Play today’s challenge</a></div>';
}

export async function renderDailyChallengeCard(container) {
  if (!container) return;
  const [info, rows] = await Promise.all([fetchChallengeInfo(), callXpRpc('daily_challenge_board', {})]);
  if (!info) {
    container.hidden = true;
    return;
  }
  const boardRows = Array.isArray(rows) ? rows : [];
  ensureAvatarStyles(container.ownerDocument);
  const urls = await signAvatarUrls(boardRows.map((r) => r?.avatar_path));
  const players = Number(boardRows[0]?.players) || 0;
  container.innerHTML = `
    <h2>🎲 Daily challenge</h2>
    ${buildChallengeStatusHtml(info)}
    ${info.available ? `<div class="gm-row" style="margin-top:8px"><b style="font-size:14px">Today’s board</b><span class="gm-sub">${players ? `${formatXp(players)} played` : ''}</span></div>${buildChallengeBoardHtml(boardRows, urls)}` : ''}
  `;
  container.hidden = false;
}

function winnersHtml(winners, urls, unit = 'XP') {
  const list = Array.isArray(winners) ? winners : [];
  if (!list.length) return '<p class="gm-sub">Not decided yet.</p>';
  return list
    .map((w) => `<div class="gm-winner">${avatarHtml(urls.get(w?.avatar_path) || null, w?.display_name, 40)}`
      + `<div><b>${esc(w?.display_name)}${w?.is_me ? ' (you!)' : ''}</b><span class="gm-sub">${formatXp(w?.xp)} ${unit}</span></div></div>`)
    .join('');
}

export function buildStarsHtml(data, urls = new Map()) {
  if (!data) return '';
  const m = data.month || {};
  const w = data.week || {};
  const youWon = [...(m.winners || []), ...(w.winners || [])].some((x) => x?.is_me);
  return `
    <h2>🌟 Stars of ${esc(data.level || 'your level')}</h2>
    ${youWon ? '<p class="gm-sub">🎉 Congratulations, that’s you!</p>' : '<p class="gm-sub">Earn the most XP in your level to become the next star.</p>'}
    <div class="gm-winners">
      <div class="gm-winner-box"><h3>⭐ Star of the Month · ${esc(m.label || '')}</h3>${winnersHtml(m.winners, urls)}</div>
      <div class="gm-winner-box"><h3>🏆 Champion of the Week</h3>${winnersHtml(w.winners, urls)}</div>
    </div>
  `;
}

export async function renderStarsCard(container) {
  if (!container) return;
  const data = await callXpRpc('star_of_month', {});
  const any = data && ((data.month?.winners || []).length || (data.week?.winners || []).length);
  if (!any) {
    container.hidden = true;
    return;
  }
  ensureAvatarStyles(container.ownerDocument);
  const paths = [...(data.month?.winners || []), ...(data.week?.winners || [])].map((x) => x?.avatar_path);
  const urls = await signAvatarUrls(paths);
  container.innerHTML = buildStarsHtml(data, urls);
  container.hidden = false;
}
