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
  normalizeMemoriadModuleKey,
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

let cachedMemoriadRows = [];
let memoriadHistoryFilters = {
  dateFrom: '',
  dateTo: '',
  category: 'all',
  source: 'all',
  sort: 'newest',
};
let memoriadHistoryPage = 1;
const MEMORIAD_PAGE_SIZE = 20;

const MEMORIAD_CATEGORIES = MEMORIAD_MODULE_CATALOG.map((m) => ({
  id: m.key,
  name: m.title,
}));

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
    cachedMemoriadRows = rows || [];
    const summary = summarizeAllMemoriad(rows, new Date());

    if (weekEl) {
      weekEl.textContent = String(summary.triesThisWeek);
    }

    if (container) {
      container.innerHTML = MEMORIAD_MODULE_CATALOG.map((mod) =>
        renderModuleCard(mod, summary.modules[mod.key])
      ).join('');
    }

    renderMemoriadHistoryView();
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
            <strong>${d} dates:</strong> Score ${tierBest.score} (${tierBest.correct}/${tierBest.attempted}) in ${Number(tierBest.used_seconds).toFixed(2)}s
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
            Score ${best.score} &middot; ${best.correct}/${best.attempted} (${accuracyPct}%)${mod.key === 'square_roots' && best.digits_total ? ` &middot; ${best.digits_total}d` : ''}
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
        Last 5 tries will appear here once you complete a practice try.
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

function renderMemoriadHistoryView() {
  const toolbarContainer = document.getElementById('memoriad-history-toolbar-container');
  const tableContainer = document.getElementById('memoriad-history-table-container');
  const paginationContainer = document.getElementById('memoriad-history-pagination-container');
  const countBadge = document.getElementById('memoriad-history-count-badge');

  if (countBadge) {
    countBadge.textContent = `${cachedMemoriadRows.length} total ${cachedMemoriadRows.length === 1 ? 'try' : 'tries'}`;
  }

  if (toolbarContainer) {
    toolbarContainer.innerHTML = renderHistoryFilterToolbarHtml({
      idPrefix: 'memoriad',
      categories: MEMORIAD_CATEGORIES,
      currentFilters: memoriadHistoryFilters,
      hasTyped: false,
    });
    wireMemoriadFilterListeners();
  }

  if (!tableContainer) return;

  if (cachedMemoriadRows.length === 0) {
    tableContainer.innerHTML = `
      <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-sm);">
        No Memoriad tries completed yet. Start your first practice try above!
      </div>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  const filtered = filterAndSortHistory(cachedMemoriadRows, memoriadHistoryFilters, {
    sectionKind: 'memoriad',
  });

  const paged = paginateHistory(filtered, {
    page: memoriadHistoryPage,
    pageSize: MEMORIAD_PAGE_SIZE,
  });

  if (paged.totalCount === 0) {
    tableContainer.innerHTML = `
      <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-sm);">
        No Memoriad practice history matches the selected filters. (Memoriad tries are recorded automatically by the site).
      </div>
    `;
    if (paginationContainer) paginationContainer.innerHTML = '';
    return;
  }

  const rowsHtml = paged.items
    .map((row, idx) => {
      const modKey = row.settings?.module || row.module || row.activity_name || 'Memoriad';
      const normKey = normalizeMemoriadModuleKey(modKey);
      const catalogEntry = MEMORIAD_MODULE_CATALOG.find((m) => m.key === normKey);
      const modTitle = catalogEntry?.title || row.activity_name || modKey;
      const correct = Number(row.correct) || 0;
      const total = Number(row.total ?? row.attempted) || 0;
      const fb = getScoreFeedback(correct, total);
      const timeSec = Number(row.time_seconds) || 0;
      const timeStr = `${timeSec.toFixed(2)}s`;
      const attemptedPerMinute = total > 0 && timeSec > 0
        ? (Math.round((total / (timeSec / 60)) * 10) / 10).toFixed(1)
        : null;

      const isFlagged = row.flagged === true;
      const flagNote = row.flag_note || '';

      const entrySource = resolveEntrySource(row, 'memoriad');
      const isVerified = row.verified === true || !!row.verified_at || !!row.verified_by;
      const isCorrected = !!row.corrected_at || !!row.corrected_by;

      const lockExplanation = practiceRecordStatus(row, { readOnly: true });

      const detailsMeta = [
        { label: 'Wrong answers', valueHtml: `<span class="score-tag ${fb.badgeClass}">${escapeHtml(fb.wrongText)}</span>` },
        { label: 'Speed / rate', valueHtml: attemptedPerMinute ? `${attemptedPerMinute} / min` : '—' },
        { label: 'Module discipline', valueHtml: escapeHtml(modTitle) },
        { label: 'Entry source', valueHtml: renderSourceChipHtml(entrySource) },
        { label: 'Status & lock', valueHtml: lockExplanation },
      ];

      return renderCompactHistoryRowHtml({
        rowId: `memoriad-${row.id || idx}`,
        category: modTitle,
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
        mainRowAttrs: row.id ? `data-memoriad-id="${row.id}"` : '',
      });
    })
    .join('');

  tableContainer.innerHTML = `
    <div class="card history-compact-card" style="margin: 0; border: none; border-radius: 0;">
      <div class="table-container" style="border: none; border-radius: 0;">
        <table class="history-compact-table" aria-label="Memoriad Practice History">
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
      idPrefix: 'memoriad',
      page: paged.page,
      totalPages: paged.totalPages,
      totalCount: paged.totalCount,
    });

    document.getElementById('memoriad-btn-prev-page')?.addEventListener('click', () => {
      if (memoriadHistoryPage > 1) {
        memoriadHistoryPage--;
        renderMemoriadHistoryView();
      }
    });

    document.getElementById('memoriad-btn-next-page')?.addEventListener('click', () => {
      if (memoriadHistoryPage < paged.totalPages) {
        memoriadHistoryPage++;
        renderMemoriadHistoryView();
      }
    });
  }
}

function wireMemoriadFilterListeners() {
  const fromInput = document.getElementById('memoriad-filter-from');
  const toInput = document.getElementById('memoriad-filter-to');
  const catSelect = document.getElementById('memoriad-filter-cat');
  const sourceSelect = document.getElementById('memoriad-filter-source');
  const sortSelect = document.getElementById('memoriad-filter-sort');
  const clearBtn = document.getElementById('memoriad-btn-clear-filters');

  const onFilterChange = () => {
    memoriadHistoryFilters.dateFrom = fromInput?.value || '';
    memoriadHistoryFilters.dateTo = toInput?.value || '';
    memoriadHistoryFilters.category = catSelect?.value || 'all';
    memoriadHistoryFilters.source = sourceSelect?.value || 'all';
    memoriadHistoryFilters.sort = sortSelect?.value || 'newest';
    memoriadHistoryPage = 1;
    renderMemoriadHistoryView();
  };

  fromInput?.addEventListener('change', onFilterChange);
  toInput?.addEventListener('change', onFilterChange);
  catSelect?.addEventListener('change', onFilterChange);
  sourceSelect?.addEventListener('change', onFilterChange);
  sortSelect?.addEventListener('change', onFilterChange);

  clearBtn?.addEventListener('click', () => {
    memoriadHistoryFilters = {
      dateFrom: '',
      dateTo: '',
      category: 'all',
      source: 'all',
      sort: 'newest',
    };
    memoriadHistoryPage = 1;
    renderMemoriadHistoryView();
  });
}

document.addEventListener('DOMContentLoaded', initMemoriadHub);
