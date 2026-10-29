/**
 * Trendz Tracker - Student Dashboard Leaderboard Card Module (js/leaderboardCard.js)
 *
 * Renders the "Leaderboard" summary card on the Student Dashboard (/pages/student.html):
 * - Reuses `fetchLeaderboard({ board: 'points', period: 'week', level: null, limit: 3 })`
 *   which returns the top 3 for the student's level plus the student's own row.
 * - Displays the student's rank and points this week (or "Not on the board yet").
 * - Displays the top 3 names and a link to `/pages/leaderboard.html`.
 */

import { fetchLeaderboard, fetchGlobalLeaderboardEnabled, formatLeaderboardValue } from './leaderboardData.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

/**
 * Loads and renders the Leaderboard summary card into `containerId`.
 * @param {string} containerId
 * @param {Object|null} callerProfile
 */
export async function loadAndRenderLeaderboardCard(containerId = 'leaderboard-card-container', callerProfile = null) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Render loading skeleton
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: var(--space-2);">
      <div class="skeleton-row" style="height: 44px; margin-bottom: 0;"></div>
      <div class="skeleton-row" style="height: 32px; margin-bottom: 0;"></div>
      <div class="skeleton-row" style="height: 32px; margin-bottom: 0;"></div>
    </div>
  `;

  try {
    const [rows, globalEnabled] = await Promise.all([
      fetchLeaderboard(
        {
          board: 'points',
          period: 'week',
          level: null,
          limit: 3,
          scope: 'level'
        },
        callerProfile
      ),
      fetchGlobalLeaderboardEnabled().catch(() => true)
    ]);

    const headerGlobalLink = document.getElementById('leaderboard-card-see-global');
    if (headerGlobalLink) {
      headerGlobalLink.style.display = globalEnabled ? '' : 'none';
    }

    const ownRow = Array.isArray(rows) ? rows.find(r => r.is_me === true) : null;
    const topThree = Array.isArray(rows)
      ? rows.filter(r => Number(r.rank) <= 3).slice(0, 3)
      : [];

    // 1. Student's own rank & points this week box
    let ownSummaryHtml = '';
    if (ownRow) {
      ownSummaryHtml = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); background-color: var(--color-primary-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); margin-bottom: var(--space-3);">
          <div>
            <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--color-primary-text);">
              Your Rank This Week
            </div>
            <div style="font-size: var(--text-lg); font-weight: 700; color: var(--text-main);" class="num">
              #${escapeHtml(ownRow.rank)}
            </div>
          </div>
          <div style="text-align: right;">
            <div style="font-size: 11px; font-weight: 600; color: var(--text-muted);">
              Points This Week
            </div>
            <div style="font-size: var(--text-base); font-weight: 700; color: var(--color-primary);" class="num">
              ${escapeHtml(formatLeaderboardValue('points', ownRow.value))}
            </div>
          </div>
        </div>
      `;
    } else {
      ownSummaryHtml = `
        <div style="padding: var(--space-3) var(--space-4); background-color: var(--bg-surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-md); margin-bottom: var(--space-3);">
          <div style="font-size: var(--text-sm); font-weight: 600; color: var(--text-main);">
            Not on the board yet
          </div>
          <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;">
            Weekly tests and sessions earn points.
          </div>
        </div>
      `;
    }

    // 2. Top 3 list for the student's level
    let topListHtml = '';
    if (topThree.length === 0) {
      topListHtml = `
        <div style="font-size: var(--text-xs); color: var(--text-muted); padding: var(--space-2) 0;">
          No points yet this week in your level.
        </div>
      `;
    } else {
      const itemsHtml = topThree.map(row => {
        const isMe = row.is_me === true;
        return `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 6px 8px; border-radius: var(--radius-sm); ${isMe ? 'background-color: var(--color-primary-subtle); font-weight: 700;' : 'border-bottom: 1px solid var(--border-hairline);'}">
            <div style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;">
              <span class="num" style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted); min-width: 24px;">
                #${escapeHtml(row.rank)}
              </span>
              <span style="font-size: var(--text-sm); color: var(--text-main); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(row.display_name)}
              </span>
              ${isMe ? '<span class="badge badge-active" style="font-size: 10px; padding: 1px 6px;">You</span>' : ''}
            </div>
            <span class="num" style="font-size: var(--text-xs); font-weight: 600; color: var(--text-muted); white-space: nowrap;">
              ${escapeHtml(formatLeaderboardValue('points', row.value))}
            </span>
          </div>
        `;
      }).join('');

      topListHtml = `
        <div style="margin-bottom: var(--space-3);">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 6px;">
            Top 3 This Week (Your Level)
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            ${itemsHtml}
          </div>
        </div>
      `;
    }

    const seeGlobalFooterHtml = globalEnabled
      ? `<a href="/pages/leaderboard.html?scope=global" style="font-size: var(--text-xs); font-weight: 600; color: var(--color-primary); text-decoration: none;">See global &rarr;</a>`
      : '';

    container.innerHTML = `
      ${ownSummaryHtml}
      ${topListHtml}
      <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding-top: var(--space-1); flex-wrap: wrap;">
        <a href="/pages/leaderboard.html" class="btn btn-outline btn-sm" style="flex: 1; justify-content: center;">
          View Full Leaderboard &rarr;
        </a>
        ${seeGlobalFooterHtml}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `
      <div class="banner banner-error" style="margin-bottom: 0; align-items: center;">
        <span style="font-size: var(--text-xs);">Could not load leaderboard summary: ${escapeHtml(err.message || 'Network error')}</span>
        <button type="button" id="btn-retry-lb-card" class="btn btn-outline btn-sm">Retry</button>
      </div>
    `;
    document.getElementById('btn-retry-lb-card')?.addEventListener('click', () => {
      loadAndRenderLeaderboardCard(containerId, callerProfile);
    });
  }
}
