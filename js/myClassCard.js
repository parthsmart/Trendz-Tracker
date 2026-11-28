/**
 * Trendz Tracker - student home "My class" card (js/myClassCard.js)
 *
 * The latest 5 positive moments at my level in my centre, with preset reactions,
 * and how many friend requests are waiting for me. Hidden when the centre has
 * switched the feed and friends off. Full page: pages/friends.html.
 */

import { socialRpc } from './socialApi.js';
import { ensureSocialStyles, esc, feedItemHtml, socialMessage } from './socialView.js';
import { showToast } from './toast.js';

export const MY_CLASS_LIMIT = 5;

export function buildMyClassCardHtml({ items = [], reactionsEnabled = true, incoming = 0, now = Date.now() } = {}) {
  const badge = incoming > 0 ? ` <span class="sc-badge" aria-label="${incoming} friend requests">${incoming}</span>` : '';
  const list = items.length
    ? `<ul class="sc-list">${items.slice(0, MY_CLASS_LIMIT).map((i) => feedItemHtml(i, { reactionsEnabled, showReport: false, now })).join('')}</ul>`
    : '<p class="sc-empty">When someone at your level levels up or earns a badge, it shows here.</p>';
  return `<h2 id="my-class-title"><span>👥 My class</span><a class="btn btn-ghost btn-sm" href="/pages/friends.html">Friends${badge} ›</a></h2>${list}`;
}

export async function renderMyClassCard(container, viewer) {
  if (!container || viewer?.role !== 'student') return;
  ensureSocialStyles(container.ownerDocument);
  const paint = async () => {
    const [feed, home] = await Promise.all([
      socialRpc('social_feed', { p_scope: 'level', p_before: null, p_limit: MY_CLASS_LIMIT }),
      socialRpc('social_home'),
    ]);
    const feedOn = feed.data?.ok && feed.data.enabled;
    const friendsOn = home.data?.ok && home.data.enabled?.friends;
    if (!feedOn && !friendsOn) { container.hidden = true; return; }
    const incoming = (home.data?.requests || []).filter((r) => r.direction === 'in' && r.status === 'pending_student').length;
    container.innerHTML = buildMyClassCardHtml({
      items: feedOn ? feed.data.items : [], reactionsEnabled: Boolean(feed.data?.reactions_enabled), incoming,
    });
    container.hidden = false;
  };
  container.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-react]');
    if (!b) return;
    b.disabled = true;
    const res = await socialRpc('social_react', { p_kind: b.dataset.kind, p_target: b.dataset.target, p_reaction: b.dataset.react });
    if (res.error || res.data?.ok === false) showToast('error', res.error || socialMessage(res.data.code));
    await paint();
  });
  await paint();
}
