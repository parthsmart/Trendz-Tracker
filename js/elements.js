/**
 * Trendz Tracker — Elements Catalog Controller (js/elements.js)
 *
 * Renders the 18 Elements worksheet drills grouped into:
 * - Codes
 * - Squares and cubes
 * - Division
 * - Time
 * - Other
 *
 * Each card displays:
 * - Drill title
 * - Question count & time limit ("56 questions - 1 minute")
 * - Student's personal best score for that drill (from activity_results, activity_type = 'element')
 * - "Start" button linking to `/pages/element-drill.html?drill=<key>`, or "Coming soon" if disabled.
 */

import { requireAuth } from './guard.js';
import {
  DRILL_GROUPS,
  DRILL_CATALOG_LIST,
  formatDrillSubtitle,
} from './drillCatalog.js';
import {
  summaryByDrill,
  setsThisWeek,
  recentSets,
  formatDrillHistoryName,
} from './drillStats.js';
import { fetchStudentElementResults } from './elementsCard.js';
import { getScoreFeedback } from './scoreColors.js';
import { formatSecondsToMMSS } from './timeUtils.js';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let currentUser = null;

async function initElementsCatalogPage() {
  const user = await requireAuth(['student', 'admin']);
  if (!user) return;
  currentUser = user;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  await loadAndRenderCatalog();
}

async function loadAndRenderCatalog() {
  const container = document.getElementById('elements-catalog-container');
  const weekSummaryEl = document.getElementById('elements-week-summary-text');
  if (!container) return;

  const rows = await fetchStudentElementResults(currentUser.id);
  const summaries = summaryByDrill(rows);
  const weekSets = setsThisWeek(rows);
  const historyRows = recentSets(rows, 20);

  if (weekSummaryEl) {
    weekSummaryEl.textContent = `${weekSets.length} set${weekSets.length === 1 ? '' : 's'} completed this week · ${rows.length} total sets`;
  }

  let html = '';

  for (const groupName of DRILL_GROUPS) {
    const groupDrills = DRILL_CATALOG_LIST.filter((d) => d.group === groupName);
    if (groupDrills.length === 0) continue;

    let innerContentHtml = '';

    if (groupName === 'Squares and cubes') {
      const subgroups = ['Squares', 'Cubes'];
      innerContentHtml = subgroups
        .map((subName) => {
          const subDrills = groupDrills.filter((d) => d.subgroup === subName);
          if (subDrills.length === 0) return '';
          return `
            <div style="margin-bottom: var(--space-5);">
              <h3 style="font-size: var(--text-sm); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 0 0 var(--space-2) 0;">
                ${escapeHtml(subName)}
              </h3>
              <div class="elements-catalog-grid">
                ${subDrills
                  .map((drill) => renderDrillCard(drill, summaries[drill.key]))
                  .join('')}
              </div>
            </div>
          `;
        })
        .join('');
    } else {
      innerContentHtml = `
        <div class="elements-catalog-grid">
          ${groupDrills
            .map((drill) => renderDrillCard(drill, summaries[drill.key]))
            .join('')}
        </div>
      `;
    }

    html += `
      <section style="margin-bottom: var(--space-8);" aria-label="${escapeHtml(groupName)} Drills">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--space-3); border-bottom: 1px solid var(--border-hairline); padding-bottom: var(--space-2);">
          <h2 style="font-size: var(--text-lg); font-weight: 700; color: var(--text-main); margin: 0;">
            ${escapeHtml(groupName)}
          </h2>
          <span style="font-size: var(--text-xs); color: var(--text-muted);">
            ${groupDrills.length} drill${groupDrills.length === 1 ? '' : 's'}
          </span>
        </div>
        ${innerContentHtml}
      </section>
    `;
  }

  html += renderHistorySection(historyRows);

  container.innerHTML = html;
}

function renderHistorySection(historyRows) {
  if (!Array.isArray(historyRows) || historyRows.length === 0) {
    return '';
  }

  const rowsHtml = historyRows
    .map((row) => {
      const displayName = formatDrillHistoryName(row);
      const correct = Number(row.correct) || 0;
      const total = Number(row.total ?? row.attempted) || 0;
      const fb = getScoreFeedback(correct, total);
      const timeStr = formatSecondsToMMSS(Number(row.time_seconds) || 0);
      const dateStr = row.created_at
        ? new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }).format(new Date(row.created_at))
        : '—';

      return `
        <tr>
          <td style="font-weight: 600; color: var(--text-main);">${escapeHtml(displayName)}</td>
          <td class="num">
            <strong style="color: ${fb.colorVar};">${correct}/${total}</strong>
            <span class="score-tag ${fb.badgeClass}" style="font-size: 11px; margin-left: 6px;">${escapeHtml(fb.wrongText)}</span>
          </td>
          <td class="num" style="color: var(--text-muted);">${escapeHtml(timeStr)}</td>
          <td class="num" style="color: var(--text-muted); font-size: var(--text-xs);">${escapeHtml(dateStr)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <section style="margin-bottom: var(--space-8);" aria-label="Recent Elements History">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--space-3); border-bottom: 1px solid var(--border-hairline); padding-bottom: var(--space-2);">
        <h2 style="font-size: var(--text-lg); font-weight: 700; color: var(--text-main); margin: 0;">
          Recent Elements History
        </h2>
        <span style="font-size: var(--text-xs); color: var(--text-muted);">
          Last ${historyRows.length} set${historyRows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Drill</th>
              <th>Score</th>
              <th>Time</th>
              <th>Date (IST)</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDrillCard(drill, drillSummary) {
  const subtitle = formatDrillSubtitle(drill);
  const best = drillSummary?.best || null;
  const count = drillSummary?.count || 0;

  let bestHtml = `
    <div style="font-size: var(--text-xs); color: var(--text-dim);">
      No attempts yet
    </div>
  `;

  if (best) {
    const fb = getScoreFeedback(best.correct, best.total);
    const timeStr = formatSecondsToMMSS(best.time_seconds);
    bestHtml = `
      <div class="num" style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-xs);">
        <span style="color: var(--text-muted); font-weight: 600;">Best:</span>
        <strong style="color: ${fb.colorVar}; font-size: var(--text-sm);">${best.correct}/${best.total}</strong>
        <span class="score-tag ${fb.badgeClass}" style="font-size: 11px;">${escapeHtml(fb.wrongText)}</span>
        <span style="color: var(--text-muted);">· ${escapeHtml(timeStr)}</span>
        <span style="color: var(--text-dim);">(${count} set${count === 1 ? '' : 's'})</span>
      </div>
    `;
  }

  const actionHtml = drill.enabled
    ? `
      <a
        href="/pages/element-drill.html?drill=${encodeURIComponent(drill.key)}"
        class="btn btn-primary btn-sm"
        style="text-decoration: none; min-width: 96px; text-align: center;"
      >
        Start &rarr;
      </a>
    `
    : `
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        disabled
        aria-disabled="true"
        style="min-width: 110px; cursor: not-allowed;"
      >
        Coming soon
      </button>
    `;

  return `
    <article class="element-drill-card ${drill.enabled ? '' : 'disabled'}" data-drill-key="${escapeHtml(drill.key)}">
      <div>
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-2); margin-bottom: 4px;">
          <h3 style="font-size: var(--text-base); font-weight: 700; color: var(--text-main); margin: 0;">
            ${escapeHtml(drill.title)}
          </h3>
          ${!drill.enabled ? `<span style="font-size: 11px; font-weight: 600; color: var(--text-muted);">Coming soon</span>` : ''}
        </div>
        <div class="num" style="font-size: var(--text-xs); font-weight: 600; color: var(--color-primary); margin-bottom: var(--space-2);">
          ${escapeHtml(subtitle)}
        </div>
        <p style="font-size: var(--text-xs); color: var(--text-muted); margin: 0; line-height: 1.4;">
          ${escapeHtml(drill.hint)}
        </p>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border-hairline); flex-wrap: wrap;">
        ${bestHtml}
        ${actionHtml}
      </div>
    </article>
  `;
}

document.addEventListener('DOMContentLoaded', initElementsCatalogPage);
