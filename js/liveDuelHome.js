/**
 * Trendz Tracker - student home "Live Duels" card (js/liveDuelHome.js)
 *
 * Shows how many players are online right now (same level, own centre or a centre opened to it, as duel
 * matchmaking), a small overlapping row of their avatars, and a Play button.
 *
 * "Online" is Supabase Realtime presence on the private `duel-lobby` channel, kept
 * by js/duelPresence.js on every signed-in student page. Personal challenges pop
 * up there with Accept / Reject; this card also lists them with a link to the lobby.
 * The "Challenge a player" dropdown sends a challenge to any online player.
 *
 * Names, centres and avatars come from live_duel_online_players(): the same list
 * the lobby shows (classmates first), with avatars that pass avatar_visible().
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { avatarHtml, ensureAvatarStyles, signAvatarUrls } from './avatars.js';
import { getDuelHub } from './duelPresence.js';
import { showToast } from './toast.js';

export const HOME_AVATAR_LIMIT = 5;
export const HOME_AVATAR_SIZE = 22;
const LOBBY_URL = '/pages/live-duel.html';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Known players whose id is in the presence state, minus me. Classmates first, then by name. */
export function onlinePlayers(known, presenceKeys = [], meId = null) {
  const list = [];
  for (const id of new Set(presenceKeys)) {
    const p = known?.get?.(id);
    if (p?.id && p.id !== meId) list.push(p);
  }
  return list.sort((x, y) => Number(Boolean(y.classmate)) - Number(Boolean(x.classmate))
    || String(x.display_name).localeCompare(String(y.display_name)));
}

/**
 * Card HTML. `online` is [{ id, display_name, url }]; `invites` from my_live_duels().
 * `rating` is the student's duel rating object, or null.
 */
export function buildLiveDuelHomeHtml({ online = [], invites = [], rating = null, connecting = false } = {}) {
  const shown = online.slice(0, HOME_AVATAR_LIMIT);
  const extra = online.length - shown.length;
  const avatars = shown
    .map((m) => `<span class="ldh-av" title="${esc(m.display_name)}">${avatarHtml(m.url || null, m.display_name, HOME_AVATAR_SIZE)}</span>`)
    .join('');
  const more = extra > 0 ? `<span class="ldh-more num" aria-hidden="true">+${extra}</span>` : '';
  const status = connecting
    ? '<span class="ldh-count ldh-dim">Checking who is online…</span>'
    : online.length
      ? `<span class="ldh-stack" aria-hidden="true">${avatars}${more}</span>
         <span class="ldh-count"><span class="ldh-dot" aria-hidden="true"></span><b class="num">${online.length}</b> ${online.length === 1 ? 'player' : 'players'} online now</span>`
      : '<span class="ldh-count ldh-dim"><span class="ldh-dot is-off" aria-hidden="true"></span>Be the first — play vs a ghost</span>';
  const invite = Array.isArray(invites) && invites.length
    ? `<a class="ldh-invite" href="${LOBBY_URL}">⚡ <b>${esc(invites[0].from_name || 'A player')}</b> challenges you! <span>Accept ›</span></a>`
    : '';
  const pick = !connecting && online.length
    ? `<details class="ldh-pick"><summary>Challenge a player</summary><ul>${online
      .map((m) => `<li><span>${esc(m.display_name)}<small>${esc(m.classmate ? 'Your centre' : (m.centre_name || 'Another centre'))}</small></span><button type="button" data-ldh-challenge="${esc(m.id)}">Challenge</button></li>`)
      .join('')}</ul></details>`
    : '';
  const r = rating && Number(rating.played) > 0
    ? `<span class="ldh-rating num">Rating <b>${Number(rating.rating) || 1000}</b> · ${Number(rating.won) || 0} won</span>`
    : '';
  return `
    <div class="ldh-main">
      <div class="ldh-ic" aria-hidden="true">⚔️</div>
      <div class="ldh-text">
        <h2 id="ldh-title">Live Duels <span class="ldh-live">LIVE</span></h2>
        <p>60-second maths race against a student at your level.</p>
        <div class="ldh-online" aria-live="polite">${status}</div>
      </div>
      <div class="ldh-cta">
        <a class="btn btn-primary ldh-play" href="${LOBBY_URL}">Play live duel</a>
        ${r}
      </div>
    </div>
    ${pick}
    ${invite}`;
}

async function sendChallenge(opponentId) {
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const t = data?.session?.access_token;
  const resp = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ action: 'live_invite', opponent_id: opponentId }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || 'Could not send the challenge.');
  return json;
}

/** Fills the card and keeps the online row live. Hides the card when duels are off or unavailable. */
export async function renderLiveDuelHome(container, viewer) {
  if (!container || !viewer?.id || viewer.role !== 'student' || !isSupabaseConfigured()) return;
  const supabase = await getSupabase();
  if (!supabase?.rpc) return;

  const { data: home, error } = await supabase.rpc('my_live_duels');
  if (error || !home || home.enabled === false) {
    container.hidden = true;
    return;
  }
  ensureAvatarStyles(container.ownerDocument);
  const known = new Map(); // id -> player at my level, or null (not listed)
  const st = { online: [], invites: home.invites || [], connecting: true, pickOpen: false };
  const paint = () => {
    st.pickOpen = Boolean(container.querySelector('.ldh-pick')?.open);
    container.innerHTML = buildLiveDuelHomeHtml({ online: st.online, invites: st.invites, rating: home.rating, connecting: st.connecting });
    if (st.pickOpen && container.querySelector('.ldh-pick')) container.querySelector('.ldh-pick').open = true;
    container.hidden = false;
  };
  paint();

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-ldh-challenge]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await sendChallenge(btn.dataset.ldhChallenge);
      showToast('success', 'Challenge sent! They get a pop-up to accept or reject.');
      if (res.duel_id) window.location.href = `/pages/live-duel.html?duel=${encodeURIComponent(res.duel_id)}`;
    } catch (err) {
      showToast('error', err.message);
      btn.disabled = false;
      btn.textContent = 'Challenge';
    }
  });

  let seq = 0;
  const onPresence = async (ids) => {
    const mine = ++seq;
    const missing = ids.filter((id) => id !== viewer.id && !known.has(id));
    if (missing.length) {
      const { data } = await supabase.rpc('live_duel_online_players', { p_ids: missing.slice(0, 300) });
      for (const id of missing) if (!known.has(id)) known.set(id, null);
      for (const p of Array.isArray(data) ? data : []) known.set(p.id, p);
    }
    const list = onlinePlayers(known, ids, viewer.id);
    const urls = await signAvatarUrls(list.slice(0, HOME_AVATAR_LIMIT).map((m) => m.avatar_path).filter(Boolean)).catch(() => new Map());
    if (mine !== seq) return;
    st.connecting = false;
    st.online = list.map((m) => ({ ...m, url: urls.get(m.avatar_path) || null }));
    paint();
  };
  const refreshInvites = async () => {
    const { data } = await supabase.rpc('my_live_duels');
    if (data) {
      st.invites = data.invites || [];
      paint();
    }
  };

  const hub = await getDuelHub(viewer);
  if (hub) {
    for (const ev of ['invite', 'cancelled', 'responded']) hub.on(ev, refreshInvites);
    hub.onPresence(onPresence);
  }
  // If presence never syncs (socket blocked), stop saying "checking".
  setTimeout(() => {
    if (st.connecting) {
      st.connecting = false;
      paint();
    }
  }, 8000);
}
