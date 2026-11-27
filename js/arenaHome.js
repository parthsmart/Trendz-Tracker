/**
 * Trendz Tracker - student home "Arena" card (js/arenaHome.js)
 * League place, duels waiting and reward balance from the `arena_summary` RPC.
 */

import { callXpRpc } from './xpRewards.js';
import { buildArenaSummaryHtml } from './arenaView.js';

export async function renderArenaCard(container) {
  if (!container) return;
  const summary = await callXpRpc('arena_summary', {});
  const html = buildArenaSummaryHtml(summary);
  container.innerHTML = html;
  container.hidden = !html;
}
