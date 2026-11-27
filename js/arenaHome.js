/**
 * Trendz Tracker - league pill in the student home "My XP" panel (js/arenaHome.js)
 * League place from the `arena_summary` RPC, shown beside the "My XP" title.
 */

import { callXpRpc } from './xpRewards.js';
import { buildLeaguePillHtml } from './arenaView.js';

/**
 * Adds the league pill next to the My XP title once both the card and the summary are ready.
 * `cardReady` is the promise from renderXpProgressCard.
 */
export async function renderLeaguePill(card, cardReady = Promise.resolve()) {
  if (!card) return;
  const [summary] = await Promise.all([callXpRpc('arena_summary', {}), cardReady]);
  const html = buildLeaguePillHtml(summary);
  const title = card.querySelector('.xp-card-title');
  if (!html || !title || card.querySelector('.xp-league')) return;
  const head = card.ownerDocument.createElement('div');
  head.className = 'xp-head';
  title.replaceWith(head);
  head.append(title);
  head.insertAdjacentHTML('beforeend', html);
}
