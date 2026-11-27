/**
 * Trendz Tracker - live duel presence and challenge pop-up (js/duelPresence.js)
 *
 * Started once per page for signed-in students (js/guard.js). It:
 *   - marks the student online on the private `duel-lobby` presence channel, so a
 *     student counts as online on any page of the site, not only the duel pages;
 *   - listens on the student's own `duel-user:<id>` channel and, when someone
 *     challenges them personally, shows a pop-up with Accept / Reject. Quick-match
 *     searches never send these, so they never pop up.
 *
 * The live duel page and the home card subscribe here (on / onPresence) instead
 * of opening their own copies of these channels.
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { showToast } from './toast.js';

const LOBBY_URL = '/pages/live-duel.html';
const STYLE_ID = 'tt-duel-pop-styles';

let hubPromise = null;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Ids in a presence state, minus mine. */
export function onlineIdsFrom(state, meId) {
  return Object.keys(state || {}).filter((k) => k && k !== meId);
}

/** Pop-up HTML for a personal challenge. */
export function buildDuelPopupHtml(invite, secondsLeftNow = null) {
  const from = esc(invite?.from_name || 'A student');
  const cat = invite?.category_name ? ` · ${esc(invite.category_name)}` : '';
  const left = Number.isFinite(secondsLeftNow) ? `<span class="tt-dp-left num">${Math.max(0, Math.ceil(secondsLeftNow))}s</span>` : '';
  return `
    <div class="tt-dp-ic" aria-hidden="true">⚔️</div>
    <div class="tt-dp-text">
      <strong id="tt-dp-title">${from} challenges you!</strong>
      <span>Live duel${cat} ${left}</span>
    </div>
    <div class="tt-dp-actions">
      <button type="button" class="tt-dp-accept" data-dp="accept">Accept</button>
      <button type="button" class="tt-dp-reject" data-dp="reject">Reject</button>
    </div>`;
}

function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.tt-dp { position: fixed; z-index: 10050; right: 20px; bottom: 20px; width: min(380px, calc(100vw - 24px));
  display: grid; grid-template-columns: auto 1fr; gap: 10px 12px; align-items: center; padding: 14px 16px;
  border-radius: 16px; color: #fff; background: linear-gradient(135deg, #1E1B4B 0%, #312E81 60%, #4338CA 100%);
  box-shadow: 0 18px 40px rgba(30, 27, 75, .35); animation: tt-dp-in .25s ease-out; }
.tt-dp-ic { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; font-size: 22px; background: rgba(255,255,255,.12); }
.tt-dp-text { display: grid; gap: 2px; min-width: 0; }
.tt-dp-text strong { font-size: 15px; }
.tt-dp-text span { font-size: 13px; color: rgba(255,255,255,.78); }
.tt-dp-left { margin-left: 4px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,.16); color: #fff; font-weight: 700; }
.tt-dp-actions { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tt-dp-actions button { border: 0; border-radius: 10px; padding: 10px 12px; font: inherit; font-weight: 800; cursor: pointer; }
.tt-dp-accept { background: #FACC15; color: #1E1B4B; }
.tt-dp-accept:hover { background: #FDE047; }
.tt-dp-reject { background: rgba(255,255,255,.14); color: #fff; }
.tt-dp-reject:hover { background: rgba(255,255,255,.22); }
.tt-dp button:disabled { opacity: .6; cursor: default; }
@keyframes tt-dp-in { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (max-width: 640px) { .tt-dp { right: 12px; left: 12px; bottom: 12px; width: auto; } }
@media (prefers-reduced-motion: reduce) { .tt-dp { animation: none; } }`;
  doc.head.appendChild(style);
}

async function createHub(viewer) {
  const supabase = await getSupabase();
  if (!supabase?.channel) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const t = data?.session?.access_token;
    if (t) await supabase.realtime.setAuth(t);
  } catch {
    // Without a token the private channels refuse the join.
  }

  const listeners = new Map(); // event -> Set(fn)
  const presenceFns = new Set();
  let online = [];
  let synced = false;
  let popupsBlocked = () => false;
  const popups = new Map(); // duel id -> { el, timer }

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) || []) {
      try { fn(payload); } catch { /* one listener must not break another */ }
    }
  };

  const closePopup = (id) => {
    const p = popups.get(id);
    if (!p) return;
    clearInterval(p.timer);
    p.el.remove();
    popups.delete(id);
  };

  const showPopup = (invite) => {
    const id = invite?.duel_id;
    if (!id || popups.has(id) || popupsBlocked() || typeof document === 'undefined') return;
    ensureStyles(document);
    const el = document.createElement('div');
    el.className = 'tt-dp';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-labelledby', 'tt-dp-title');
    el.dataset.duel = id;
    const expires = invite.expires_at ? new Date(invite.expires_at).getTime() : Date.now() + 60_000;
    const paint = () => {
      const left = (expires - Date.now()) / 1000;
      if (left <= 0) return closePopup(id);
      const busy = el.querySelector('button:disabled');
      if (!busy) el.innerHTML = buildDuelPopupHtml(invite, left);
    };
    paint();
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-dp]');
      if (!btn) return;
      const accept = btn.dataset.dp === 'accept';
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      btn.textContent = accept ? 'Joining…' : 'Rejecting…';
      try {
        const { data, error } = await supabase.rpc('live_duel_respond', { p_duel: id, p_accept: accept });
        closePopup(id);
        emit('responded', { duel_id: id, accept, ok: !error && data?.ok });
        if (accept && !error && data?.ok) window.location.href = `${LOBBY_URL}?duel=${encodeURIComponent(id)}`;
        else if (accept) showToast('info', data?.error || 'That challenge has ended.');
      } catch {
        closePopup(id);
      }
    });
    document.body.appendChild(el);
    popups.set(id, { el, timer: setInterval(paint, 1000) });
    el.querySelector('.tt-dp-accept')?.focus({ preventScroll: true });
  };

  const user = supabase.channel(`duel-user:${viewer.id}`, { config: { private: true } });
  for (const event of ['invite', 'cancelled', 'declined', 'matched']) {
    user.on('broadcast', { event }, (msg) => {
      const payload = msg?.payload || {};
      if (event === 'invite') showPopup(payload);
      if (event === 'cancelled') closePopup(payload.duel_id);
      emit(event, payload);
    });
  }
  user.subscribe();

  const lobby = supabase.channel('duel-lobby', { config: { private: true, presence: { key: viewer.id } } });
  lobby.on('presence', { event: 'sync' }, () => {
    online = onlineIdsFrom(lobby.presenceState(), viewer.id);
    synced = true;
    for (const fn of presenceFns) {
      try { fn(online); } catch { /* ignore */ }
    }
  });
  lobby.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      const where = typeof location !== 'undefined' ? location.pathname : '';
      lobby.track({ id: viewer.id, at: Date.now(), where }).catch(() => {});
    }
  });

  return {
    supabase,
    /** Subscribe to a duel-user event (invite, cancelled, declined, matched, responded). Returns unsubscribe. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    /** fn(onlineIds) on every presence sync (and now, if already synced). Returns unsubscribe. */
    onPresence(fn) {
      presenceFns.add(fn);
      if (synced) fn([...online]);
      return () => presenceFns.delete(fn);
    },
    onlineIds: () => [...online],
    /** The duel page hides pop-ups while a race is on screen. */
    blockPopups(fn) { popupsBlocked = typeof fn === 'function' ? fn : () => Boolean(fn); },
    closePopup,
    showPopup,
  };
}

/** Starts presence and pop-ups for a signed-in student, once per page. Resolves to the hub or null. */
export function startDuelPresence(viewer) {
  if (hubPromise) return hubPromise;
  if (!viewer?.id || viewer.role !== 'student' || !isSupabaseConfigured()) return Promise.resolve(null);
  hubPromise = createHub(viewer).catch(() => null);
  return hubPromise;
}

/** The running hub, starting it if needed. */
export function getDuelHub(viewer) {
  return hubPromise || startDuelPresence(viewer);
}
