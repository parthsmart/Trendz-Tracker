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
import {
  filterAndSortHistory,
  paginateHistory,
  renderHistoryFilterToolbarHtml,
  renderHistoryPaginationHtml,
  toISTDateString,
  resolveEntrySource,
  renderSourceChipHtml,
  renderCompactHistoryRowHtml,
  practiceRecordStatus,
  formatFriendlyDateIST,
  formatAccuracyDisplay,
} from './historyFilters.js';

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
let cachedElementRows = [];
let elementsHistoryFilters = {
  dateFrom: '',
  dateTo: '',
  category: 'all',
  source: 'all',
  sort: 'newest',
};
let elementsHistoryPage = 1;
const ELEMENTS_PAGE_SIZE = 20;

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
  cachedElementRows = rows;
  const summaries = summaryByDrill(rows);
  const weekSets = setsThisWeek(rows);

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

  html += `
    <section id="elements-history-section" style="margin-bottom: var(--space-8);" aria-label="Elements Practice History">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--space-3); border-bottom: 1px solid var(--border-hairline); padding-bottom: var(--space-2);">
        <h2 style="font-size: var(--text-lg); font-weight: 700; color: var(--text-main); margin: 0;">
          Elements Practice History
        </h2>
        <span style="font-size: var(--text-xs); color: var(--text-muted);" id="elements-history-count-badge">
          ${rows.length} total set${rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div id="elements-history-toolbar-container"></div>
      <div id="elements-history-table-container"></div>
      <div id="elements-history-pagination-container"></div>
    </section>
  `;

  container.innerHTML = html;
  renderElementsHistoryView();
}

function renderElementsHistoryView() {
  const toolbarContainer = document.getElementById('elements-history-toolbar-container');
  const tableContainer = document.getElementById('elements-history-table-container');
  const paginationContainer = document.getElementById('elements-history-pagination-container');

  if (toolbarContainer) {
    const drillCategories = DRILL_CATALOG_LIST.map((d) => ({
      id: d.key,
      name: d.title,
    }));

    toolbarContainer.innerHTML = renderHistoryFilterToolbarHtml({
      idPrefix: 'elements',
      categories: drillCategories,
      currentFilters: elementsHistoryFilters,
      hasTyped: false,
    });
    wireElementsFilterListeners();
  }

  if (!tableContainer) return;

  if (cachedElementRows.length === 0) {
    tableContainer.innerHTML = `
      <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-sm);">
        No elements drills completed yet. Start your first drill above!
      </div>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  const filtered = filterAndSortHistory(cachedElementRows, elementsHistoryFilters, {
    sectionKind: 'elements',
  });

  const paged = paginateHistory(filtered, {
    page: elementsHistoryPage,
    pageSize: ELEMENTS_PAGE_SIZE,
  });

  if (paged.totalCount === 0) {
    tableContainer.innerHTML = `
      <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-sm);">
        No elements practice history matches the selected filters. (Elements drills are recorded automatically by the site).
      </div>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  const rowsHtml = paged.items
    .map((row, idx) => {
      const displayName = formatDrillHistoryName(row);
      const correct = Number(row.correct) || 0;
      const total = Number(row.total ?? row.attempted) || 0;
      const fb = getScoreFeedback(correct, total);
      const timeSec = Number(row.time_seconds) || 0;
      const timeStr = formatSecondsToMMSS(timeSec);
      const drillKey = row.settings?.drill || row.settings?.drill_key || row.activity_name || '';
      const attemptedPerMinute = total > 0 && timeSec > 0
        ? (Math.round((total / (timeSec / 60)) * 10) / 10).toFixed(1)
        : null;

      const isFlagged = row.flagged === true;
      const flagNote = row.flag_note || '';

      const entrySource = resolveEntrySource(row, 'elements');
      const isVerified = row.verified === true || !!row.verified_at || !!row.verified_by;
      const isCorrected = !!row.corrected_at || !!row.corrected_by;

      const lockExplanation = practiceRecordStatus(row, { readOnly: true });

      const detailsMeta = [
        { label: 'Wrong answers', valueHtml: `<span class="score-tag ${fb.badgeClass}">${escapeHtml(fb.wrongText)}</span>` },
        { label: 'Speed / rate', valueHtml: attemptedPerMinute ? `${attemptedPerMinute} / min` : '—' },
        { label: 'Drill key', valueHtml: `<code style="font-size: 11px;">${escapeHtml(drillKey)}</code>` },
        { label: 'Entry source', valueHtml: renderSourceChipHtml(entrySource) },
        { label: 'Status & lock', valueHtml: lockExplanation },
      ];

      return renderCompactHistoryRowHtml({
        rowId: `elements-${row.id || idx}`,
        category: displayName,
        categorySub: '',
        correct: correct,
        total: total,
        timeFormatted: timeStr,
        dateVal: row.created_at,
        isFlagged: isFlagged,
        flagNote: flagNote,
        statusBadgeHtml: '',
        detailsMeta: detailsMeta,
        actionsHtml: '',
        mainRowAttrs: row.id ? `data-elements-id="${row.id}"` : '',
      });
    })
    .join('');

  tableContainer.innerHTML = `
    <div class="card history-compact-card" style="margin-top: var(--space-4);">
      <div class="table-container" style="border: none; border-radius: 0;">
        <table class="history-compact-table" aria-label="Elements Practice History">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col" class="th-num">Score</th>
              <th scope="col" class="th-num">Accuracy</th>
              <th scope="col" class="th-num">Time</th>
              <th scope="col">Date</th>
              <th scope="col" class="th-action">Details</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  if (paginationContainer) {
    paginationContainer.innerHTML = renderHistoryPaginationHtml({
      idPrefix: 'elements',
      page: paged.page,
      totalPages: paged.totalPages,
      totalCount: paged.totalCount,
    });

    document.getElementById('elements-btn-prev-page')?.addEventListener('click', () => {
      if (elementsHistoryPage > 1) {
        elementsHistoryPage--;
        renderElementsHistoryView();
      }
    });

    document.getElementById('elements-btn-next-page')?.addEventListener('click', () => {
      if (elementsHistoryPage < paged.totalPages) {
        elementsHistoryPage++;
        renderElementsHistoryView();
      }
    });
  }
}

function wireElementsFilterListeners() {
  const fromInput = document.getElementById('elements-filter-from');
  const toInput = document.getElementById('elements-filter-to');
  const catSelect = document.getElementById('elements-filter-cat');
  const sourceSelect = document.getElementById('elements-filter-source');
  const sortSelect = document.getElementById('elements-filter-sort');
  const clearBtn = document.getElementById('elements-btn-clear-filters');

  const onFilterChange = () => {
    elementsHistoryFilters.dateFrom = fromInput?.value || '';
    elementsHistoryFilters.dateTo = toInput?.value || '';
    elementsHistoryFilters.category = catSelect?.value || 'all';
    elementsHistoryFilters.source = sourceSelect?.value || 'all';
    elementsHistoryFilters.sort = sortSelect?.value || 'newest';
    elementsHistoryPage = 1;
    renderElementsHistoryView();
  };

  fromInput?.addEventListener('change', onFilterChange);
  toInput?.addEventListener('change', onFilterChange);
  catSelect?.addEventListener('change', onFilterChange);
  sourceSelect?.addEventListener('change', onFilterChange);
  sortSelect?.addEventListener('change', onFilterChange);

  clearBtn?.addEventListener('click', () => {
    elementsHistoryFilters = {
      dateFrom: '',
      dateTo: '',
      category: 'all',
      source: 'all',
      sort: 'newest',
    };
    elementsHistoryPage = 1;
    renderElementsHistoryView();
  });
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
