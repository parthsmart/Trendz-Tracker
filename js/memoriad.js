/**
 * Trendz Tracker — Memoriad Hub Page Controller (js/memoriad.js)
 *
 * Renders the 4 Memoriad competition modules on `/pages/memoriad.html`:
 * - Mental Calendar Dates (available)
 * - Mental Additions (available)
 * - Mental Multiplications ("Coming soon")
 * - Mental Square Roots ("Coming soon")
 *
 * Shows each module's best score (and per-date-count bests for Calendar),
 * last 5 tries (date in India time, score, attempted, time), and Start button.
 */

import { requireAuth } from './guard.js';
import { isDemoMode } from './demoDb.js';
import { fetchStudentMemoriadResults } from './memoriadCard.js';
import { MEMORIAD_MODULE_CATALOG, summarizeAllMemoriad } from './memoriadStats.js';
import { getScoreFeedback } from './scoreColors.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function initMemoriadHub() {
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;

  renderHeaderUser(profile);

  if (isDemoMode()) {
    renderDemoBanner();
  }

  const container = document.getElementById('memoriad-modules-container');
  const weekEl = document.getElementById('memoriad-tries-this-week');

  try {
    const rows = await fetchStudentMemoriadResults(profile.id);
    const summary = summarizeAllMemoriad(rows, new Date());

    if (weekEl) {
      weekEl.textContent = String(summary.triesThisWeek);
    }

    if (container) {
      container.innerHTML = MEMORIAD_MODULE_CATALOG.map((mod) =>
        renderModuleCard(mod, summary.modules[mod.key])
      ).join('');
    }
  } catch (err) {
    console.error('Failed to load Memoriad hub:', err);
    if (container) {
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; padding: var(--space-5); color: var(--color-danger);">
          Could not load your Memoriad practice history. Please refresh the page.
        </div>
      `;
    }
  }
}

function renderBestSection(mod, modSummary) {
  if (!mod.available) {
    return `
      <div class="memoriad-best-box">
        <div style="font-size: var(--text-xs); color: var(--text-dim);">
          This competition discipline will be enabled in the next phase.
        </div>
      </div>
    `;
  }

  const best = modSummary?.best;
  if (!best) {
    return `
      <div class="memoriad-best-box">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 2px;">
          Personal Best
        </div>
        <div style="font-size: var(--text-xs); color: var(--text-dim);">
          No completed attempts yet. Start your first practice try below!
        </div>
      </div>
    `;
  }

  const feedback = getScoreFeedback(best.correct, best.attempted);
  const accuracyPct = best.attempted > 0 ? Math.round((best.correct / best.attempted) * 100) : 0;

  let calendarTiersHtml = '';
  if (mod.key === 'calendar' && modSummary.bestByDates) {
    const chips = [25, 50, 75, 100, 125]
      .map((d) => {
        const tierBest = modSummary.bestByDates[d];
        if (!tierBest) return '';
        return `
          <span class="memoriad-tier-chip num">
            <strong>${d} dates:</strong> ${tierBest.correct}/${tierBest.attempted} in ${Number(tierBest.used_seconds).toFixed(2)}s
          </span>
        `;
      })
      .filter(Boolean)
      .join('');

    if (chips) {
      calendarTiersHtml = `
        <div style="margin-top: var(--space-2); padding-top: var(--space-2); border-top: 1px dashed var(--border-subtle);">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: var(--text-muted);">
            Best by Date Count
          </div>
          <div class="memoriad-dates-tiers">${chips}</div>
        </div>
      `;
    }
  }

  return `
    <div class="memoriad-best-box">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
        <div>
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted);">
            Personal Best${mod.key === 'calendar' && best.dates ? ` (${best.dates} dates)` : ''}
          </div>
          <div class="num" style="font-size: 1.25rem; font-weight: 800; color: ${feedback.colorVar}; margin-top: 2px;">
            Score ${best.score} &middot; ${best.correct}/${best.attempted} (${accuracyPct}%)
          </div>
        </div>
        <div class="num" style="text-align: right;">
          <span class="score-tag ${feedback.badgeClass}">${escapeHtml(feedback.wrongText)}</span>
          <div style="font-size: var(--text-xs); color: var(--text-muted); margin-top: 4px;">
            Time: <strong>${Number(best.used_seconds).toFixed(2)}s</strong>
          </div>
        </div>
      </div>
      ${calendarTiersHtml}
    </div>
  `;
}

function renderLastFiveTable(mod, modSummary) {
  if (!mod.available) {
    return '';
  }

  const lastFive = modSummary?.lastFive || [];
  if (lastFive.length === 0) {
    return `
      <div style="margin-bottom: var(--space-4); font-size: var(--text-xs); color: var(--text-dim); padding: var(--space-2) 0;">
        Last 5 tries will appear here once you complete a session.
      </div>
    `;
  }

  const rowsHtml = lastFive
    .map((item) => {
      const feedback = getScoreFeedback(item.correct, item.attempted);
      const datesBadge =
        mod.key === 'calendar' && item.dates
          ? `<span style="font-size: 10px; color: var(--text-muted); margin-left: 4px;">(${item.dates}d)</span>`
          : '';
      return `
        <tr>
          <td style="font-size: var(--text-xs);">${escapeHtml(item.date_display)}${datesBadge}</td>
          <td class="num" style="font-weight: 700; color: ${feedback.colorVar};">${item.score}</td>
          <td class="num" style="font-size: var(--text-xs);">
            ${item.correct}/${item.attempted}
            <span class="score-tag ${feedback.badgeClass}" style="font-size: 10px; margin-left: 4px;">${escapeHtml(feedback.wrongText)}</span>
          </td>
          <td class="num" style="font-size: var(--text-xs); text-align: right;">${Number(item.used_seconds).toFixed(2)}s</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div style="margin-bottom: var(--space-4);">
      <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: var(--space-2);">
        Last ${lastFive.length} ${lastFive.length === 1 ? 'Try' : 'Tries'} (India Time)
      </div>
      <div class="table-responsive" style="border: 1px solid var(--border-hairline); border-radius: var(--radius-md);">
        <table class="data-table" style="margin: 0;">
          <thead>
            <tr>
              <th>Date (IST)</th>
              <th>Score</th>
              <th>Attempted</th>
              <th style="text-align: right;">Time</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderModuleCard(mod, modSummary) {
  const badgeClass = mod.available ? 'badge badge-active' : 'badge badge-inactive';
  const actionHtml = mod.available
    ? `
      <a
        href="/pages/memoriad-play.html?module=${encodeURIComponent(mod.key)}"
        class="btn btn-primary"
        style="width: 100%; justify-content: center; text-decoration: none;"
      >
        Start ${escapeHtml(mod.title)} &rarr;
      </a>
    `
    : `
      <button type="button" class="btn btn-outline" style="width: 100%; justify-content: center;" disabled>
        Coming soon
      </button>
    `;

  return `
    <section class="memoriad-module-card ${mod.available ? '' : 'is-coming-soon'}" aria-labelledby="mod-title-${escapeHtml(mod.key)}">
      <div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); margin-bottom: var(--space-2);">
          <h2 id="mod-title-${escapeHtml(mod.key)}" style="font-size: 1.15rem; font-weight: 800; margin: 0; color: var(--text-main);">
            ${escapeHtml(mod.title)}
          </h2>
          <span class="${badgeClass}">${escapeHtml(mod.badge)}</span>
        </div>
        <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0;">
          ${escapeHtml(mod.subtitle)}
        </p>

        ${renderBestSection(mod, modSummary)}
        ${renderLastFiveTable(mod, modSummary)}
      </div>

      <div>
        ${actionHtml}
      </div>
    </section>
  `;
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');
  if (container) container.style.display = 'flex';
  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || 'STU';

  document.getElementById('btn-header-logout')?.addEventListener('click', async () => {
    const { logoutUser } = await import('./auth.js');
    await logoutUser();
  });
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-demo" style="margin-bottom: var(--space-4);">
      <span class="banner-icon" aria-hidden="true">ℹ️</span>
      <div class="banner-body">
        <strong>DEMO MODE &mdash; data is fake:</strong>
        Fixed sample Memoriad sessions and results are loaded for local preview.
      </div>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initMemoriadHub);
