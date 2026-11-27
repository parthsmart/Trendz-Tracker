/**
 * Trendz Tracker - student home "Live Duels" card (js/liveDuelHome.js)
 *
 * Shows how many classmates are online right now (same level and centre as duel
 * matchmaking), a small overlapping row of their avatars, and a Play button.
 *
 * "Online" is Supabase Realtime presence on the private `duel-lobby` channel, the
 * same one the live duel lobby uses. This page joins it too, so a student on the
 * dashboard can be challenged; challenges arrive on `duel-user:<id>` and show here
 * with a link to the lobby, where they are accepted.
 *
 * Names and avatars come from my_live_duels().mates: the same display names the
 * lobby already shows, and avatars that pass avatar_visible().
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { avatarHtml, ensureAvatarStyles, signAvatarUrls } from './avatars.js';

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

/** Classmates whose id is in the presence state, minus me. Keeps the mates order. */
export function onlineMates(mates = [], presenceKeys = [], meId = null) {
  const keys = new Set(presenceKeys);
  return (Array.isArray(mates) ? mates : []).filter((m) => m?.id && m.id !== meId && keys.has(m.id));
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
         <span class="ldh-count"><span class="ldh-dot" aria-hidden="true"></span><b class="num">${online.length}</b> ${online.length === 1 ? 'classmate' : 'classmates'} online now</span>`
      : '<span class="ldh-count ldh-dim"><span class="ldh-dot is-off" aria-hidden="true"></span>Be the first — play vs a ghost</span>';
  const invite = Array.isArray(invites) && invites.length
    ? `<a class="ldh-invite" href="${LOBBY_URL}">⚡ <b>${esc(invites[0].from_name || 'A classmate')}</b> challenges you! <span>Accept ›</span></a>`
    : '';
  const r = rating && Number(rating.played) > 0
    ? `<span class="ldh-rating num">Rating <b>${Number(rating.rating) || 1000}</b> · ${Number(rating.won) || 0} won</span>`
    : '';
  return `
    <div class="ldh-main">
      <div class="ldh-ic" aria-hidden="true">⚔️</div>
      <div class="ldh-text">
        <h2 id="ldh-title">Live Duels <span class="ldh-live">LIVE</span></h2>
        <p>60-second maths race against a classmate, answer for answer.</p>
        <div class="ldh-online" aria-live="polite">${status}</div>
      </div>
      <div class="ldh-cta">
        <a class="btn btn-primary ldh-play" href="${LOBBY_URL}">Play live duel</a>
        ${r}
      </div>
    </div>
    ${invite}`;
}

async function privateChannel(supabase, topic, { presenceKey = null, onPresence = null, broadcast = {} } = {}) {
  const ch = supabase.channel(topic, { config: { private: true, presence: presenceKey ? { key: presenceKey } : undefined } });
  for (const [event, fn] of Object.entries(broadcast)) ch.on('broadcast', { event }, (msg) => fn(msg.payload || {}));
  if (onPresence) ch.on('presence', { event: 'sync' }, () => onPresence(ch.presenceState()));
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED' && presenceKey) ch.track({ id: presenceKey, at: Date.now(), where: 'home' }).catch(() => {});
  });
  return ch;
}

/** Fills the card and keeps the online row live. Hides the card when duels are off or unavailable. */
export async function renderLiveDuelHome(container, viewer) {
  if (!container || !viewer?.id || viewer.role !== 'student' || !isSupabaseConfigured()) return;
  const supabase = await getSupabase();
  if (!supabase?.rpc || !supabase.channel) return;

  const { data: home, error } = await supabase.rpc('my_live_duels');
  if (error || !home || home.enabled === false) {
    container.hidden = true;
    return;
  }
  ensureAvatarStyles(container.ownerDocument);
  const mates = Array.isArray(home.mates) ? home.mates : [];
  const st = { online: [], invites: home.invites || [], connecting: true };
  const paint = () => {
    container.innerHTML = buildLiveDuelHomeHtml({ online: st.online, invites: st.invites, rating: home.rating, connecting: st.connecting });
    container.hidden = false;
  };
  paint();

  let seq = 0;
  const onPresence = async (state) => {
    const mine = ++seq;
    const list = onlineMates(mates, Object.keys(state || {}), viewer.id);
    const urls = await signAvatarUrls(list.slice(0, HOME_AVATAR_LIMIT).map((m) => m.avatar_path));
    if (mine !== seq) return;
    st.connecting = false;
    st.online = list.map((m) => ({ id: m.id, display_name: m.display_name, url: urls.get(m.avatar_path) || null }));
    paint();
  };
  const refreshInvites = async () => {
    const { data } = await supabase.rpc('my_live_duels');
    if (data) {
      st.invites = data.invites || [];
      paint();
    }
  };

  try {
    const { data } = await supabase.auth.getSession();
    const t = data?.session?.access_token;
    if (t) await supabase.realtime.setAuth(t);
  } catch {
    // Without a token the private channels refuse the join; the card still links to the lobby.
  }
  await privateChannel(supabase, `duel-user:${viewer.id}`, {
    broadcast: { invite: refreshInvites, cancelled: refreshInvites },
  });
  await privateChannel(supabase, 'duel-lobby', { presenceKey: viewer.id, onPresence });
  // If presence never syncs (socket blocked), stop saying "checking".
  setTimeout(() => {
    if (st.connecting) {
      st.connecting = false;
      paint();
    }
  }, 8000);
}
