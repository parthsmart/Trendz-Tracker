/**
 * Trendz Tracker - Unified Practice Score History Filtering, Sorting & Pagination (js/historyFilters.js)
 *
 * Implements authoritative score-history filtering across all four sections:
 * 1. Basics (results / results_with_target)
 * 2. Flash Anzan (activity_results, activity_type = 'flash_anzan')
 * 3. Elements (activity_results, activity_type = 'element')
 * 4. Memoriad (activity_results, activity_type = 'memoriad')
 *
 * Features:
 * - Date From / Date To (inclusive, India Standard Time Asia/Kolkata)
 * - Category filtering (Basics categories, 1..5 digits for Flash, drill catalog for Elements, module catalog for Memoriad)
 * - Entry source: All / Typed / Recorded by the site (authoritative: missing source is NEVER labeled site-recorded)
 * - Sort: Newest / Oldest / Highest accuracy / Lowest accuracy (safe zero totals, deterministic tie-breaking)
 * - Pagination / browsing support for arbitrary history lengths (no silent 20 or 200 cap)
 */

import './infoTooltip.js';

/** Source, teacher review and edit restrictions describe different things. */
export function practiceRecordStatus(row, { readOnly = false } = {}) {
  const corrected = Boolean(row.corrected_at || row.corrected_by);
  const teacherVerified = Boolean(row.verified_by);
  const verified = row.verified === true || Boolean(row.verified_at || row.verified_by);
  const source = resolveEntrySource(row);
  const review = corrected ? 'Corrected by teacher' : teacherVerified ? 'Verified by teacher' : verified ? 'Verified' : 'Verification not recorded';
  const restriction = readOnly ? 'Read-only practice record' : source === 'site' ? 'Online session, locked against editing' : corrected || verified ? 'Locked against editing' : 'Typed entries may be edited within the allowed date range';
  return `${escapeHtml(review)}<br><span class="history-lock-explanation">${escapeHtml(restriction)}</span>`;
}

/**
 * Normalizes a record's date to a YYYY-MM-DD string in Asia/Kolkata (IST).
 *
 * @param {string|Date|number|null|undefined} dateVal
 * @returns {string}
 */
export function toISTDateString(dateVal) {
  if (!dateVal) return '';
  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
  }

  try {
    const dt = dateVal instanceof Date ? dateVal : new Date(dateVal);
    if (Number.isNaN(dt.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dt);
  } catch {
    return '';
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deterministically fetches all rows in batches using a page fetching function.
 * Handles API limits (such as PostgREST 1000-row default maximum) gracefully.
 *
 * @template T
 * @param {(from: number, to: number) => Promise<Array<T>>} fetchPageFn
 * @param {{ batchSize?: number, maxRows?: number }} [options]
 * @returns {Promise<Array<T>>}
 */
export async function fetchAllRowsBatched(fetchPageFn, { batchSize = 1000, maxRows = 100000 } = {}) {
  const allRows = [];
  const safeBatchSize = Math.max(1, Number(batchSize) || 1000);
  const safeMaxRows = Math.max(safeBatchSize, Number(maxRows) || 100000);
  let from = 0;

  while (true) {
    if (from >= safeMaxRows) {
      throw new Error(
        `History retrieval reached safety limit of ${safeMaxRows} rows without server confirming completion. Incomplete history cannot be returned.`
      );
    }

    const to = from + safeBatchSize - 1;
    const res = await fetchPageFn(from, to);

    // Support both direct array returns and { data, count } response shapes
    const pageRows = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : null;
    const totalCount = typeof res?.count === 'number' ? res.count : null;

    if (!pageRows || pageRows.length === 0) {
      break;
    }

    allRows.push(...pageRows);
    from += pageRows.length;

    // If server provides exact total count and we have retrieved all available records, stop
    if (totalCount !== null && allRows.length >= totalCount) {
      break;
    }
  }

  return allRows;
}

/**
 * Resolves the authoritative entry source:
 * - 'site' ("Recorded by the site")
 * - 'typed' ("Typed")
 * - 'legacy' ("Legacy / Unspecified")
 *
 * Authoritative rules:
 * 1. Explicit source: 'site' | 'online' -> 'site'; 'typed' -> 'typed'.
 * 2. Verified session UUID: If row.settings?.session_id or row.session_id matches UUID format -> 'site'.
 * 3. Ambiguous records without explicit source or verified session UUID -> 'legacy' across all four sections.
 * Never classify missing-source records as site-recorded merely from activity_type, settings, or arbitrary session_id.
 *
 * @param {Record<string, any>} row
 * @param {'basics'|'flash'|'elements'|'memoriad'} [sectionKind='basics']
 * @returns {'site'|'typed'|'legacy'}
 */
export function resolveEntrySource(row, sectionKind = 'basics') {
  if (!row || typeof row !== 'object') return 'legacy';

  const rawSource = String(row.source || '').trim().toLowerCase();
  if (rawSource === 'site' || rawSource === 'online') {
    return 'site';
  }
  if (rawSource === 'typed') {
    return 'typed';
  }

  // Check verified session UUID in settings or top-level session_id
  const rawSessionId =
    (row.settings && typeof row.settings === 'object' && row.settings.session_id) ||
    row.session_id;

  if (typeof rawSessionId === 'string' && UUID_REGEX.test(rawSessionId.trim())) {
    return 'site';
  }

  // Ambiguous legacy records with neither explicit source nor verified session UUID
  return 'legacy';
}

/**
 * Renders a standardized HTML chip representing the entry source.
 *
 * @param {'site'|'typed'|'legacy'|string} source
 * @returns {string}
 */
export function renderSourceChipHtml(source) {
  const norm = String(source || '').trim().toLowerCase();
  if (norm === 'site' || norm === 'online') {
    return `<span class="status-chip chip-verified" title="Completed online and recorded by the site">Recorded by site</span>`;
  }
  if (norm === 'typed') {
    return `<span class="status-chip chip-unverified" title="Manually typed score entry">Typed</span>`;
  }
  return `<span class="status-chip" style="background-color: var(--bg-surface-subtle); color: var(--text-muted); border: 1px solid var(--border-hairline);" title="Legacy or unspecified score entry">Legacy / Unspecified</span>`;
}

/**
 * Computes accuracy percentage safely (0..100) handling zero totals.
 *
 * @param {number|string|null|undefined} correctVal
 * @param {number|string|null|undefined} totalVal
 * @returns {number}
 */
export function computeAccuracyPct(correctVal, totalVal) {
  const c = Number(correctVal) || 0;
  const t = Number(totalVal) || 0;
  if (!Number.isFinite(t) || t <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (c / t) * 100));
}

/**
 * Formats a date into a human-friendly IST label:
 * - 'Today' if matching today's date in Asia/Kolkata
 * - 'Yesterday' if matching yesterday's date in Asia/Kolkata
 * - 'D Mon YYYY' (e.g. '5 Nov 2026') for other dates
 *
 * @param {string|Date|number|null|undefined} dateVal
 * @returns {string}
 */
export function formatFriendlyDateIST(dateVal) {
  const istDateStr = toISTDateString(dateVal);
  if (!istDateStr) return '';

  const todayIST = toISTDateString(new Date());
  if (istDateStr === todayIST) {
    return 'Today';
  }

  const [ty, tm, td] = todayIST.split('-').map(Number);
  const yesterdayDate = new Date(Date.UTC(ty, tm - 1, td - 1, 12, 0, 0));
  const yesterdayIST = toISTDateString(yesterdayDate);
  if (istDateStr === yesterdayIST) {
    return 'Yesterday';
  }

  try {
    const [y, m, d] = istDateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(dateObj);
  } catch {
    return istDateStr;
  }
}

/**
 * Formats accuracy percentage cleanly for display:
 * - '95.2%' for fractional percentages
 * - '100%' or '95%' for whole percentages
 * - '0%' for zero total
 *
 * @param {number|string|null|undefined} correct
 * @param {number|string|null|undefined} total
 * @returns {string}
 */
export function formatAccuracyDisplay(correct, total) {
  const t = Number(total) || 0;
  if (!Number.isFinite(t) || t <= 0) {
    return '0%';
  }
  const pct = computeAccuracyPct(correct, total);
  if (pct % 1 === 0) {
    return `${Math.round(pct)}%`;
  }
  return `${pct.toFixed(1)}%`;
}

/**
 * Renders a standardized, accessible compact score history row pair (main row + expandable details row).
 *
 * Columns:
 * 1. Category (with attention flag if flagged)
 * 2. Score
 * 3. Accuracy
 * 4. Time
 * 5. Date (Today, Yesterday, or D Mon YYYY)
 * 6. Details (expandable toggle)
 *
 * @param {Object} params
 * @param {string} params.rowId
 * @param {string} params.category
 * @param {string} [params.categorySub]
 * @param {number|string} params.correct
 * @param {number|string} params.total
 * @param {string} [params.timeFormatted]
 * @param {string|Date|number} params.dateVal
 * @param {boolean} [params.isFlagged]
 * @param {string} [params.flagNote]
 * @param {string} [params.statusBadgeHtml]
 * @param {Array<{ label: string, valueHtml: string }>} [params.detailsMeta]
 * @param {string} [params.actionsHtml]
 * @param {string} [params.mainRowAttrs]
 * @param {string} [params.mainRowClass]
 * @returns {string}
 */
export function renderCompactHistoryRowHtml({
  rowId,
  category,
  categorySub = '',
  correct = 0,
  total = 0,
  timeFormatted = '—',
  dateVal,
  isFlagged = false,
  flagNote = '',
  statusBadgeHtml = '',
  detailsMeta = [],
  actionsHtml = '',
  mainRowAttrs = '',
  mainRowClass = '',
}) {
  const cleanId = String(rowId || 'row').replace(/[^a-zA-Z0-9_-]/g, '-');
  const detailsId = `details-${cleanId}`;
  const c = Number(correct) || 0;
  const t = Number(total) || 0;
  const accText = formatAccuracyDisplay(c, t);
  const friendlyDate = formatFriendlyDateIST(dateVal) || '—';
  const cleanTime = timeFormatted || '—';

  return `
    <tr class="history-main-row ${mainRowClass}" ${mainRowAttrs}>
      <!-- 1. Category -->
      <td class="cell-category">
        <div class="cell-header-mobile">
          <div class="cell-category-title">
            <span>${escapeHtml(category)}</span>
            ${isFlagged ? `
              <span class="status-chip chip-flagged" style="font-size: 11px; padding: 2px 6px;" title="Your teacher asked you to check this entry">
                ⚠️ Needs attention
              </span>
            ` : ''}
            ${statusBadgeHtml}
          </div>
          ${categorySub ? `
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
              ${escapeHtml(categorySub)}
            </div>
          ` : ''}
        </div>
      </td>

      <!-- 2. Score -->
      <td class="cell-score num" data-label="Score">
        <strong>${c} / ${t}</strong>
      </td>

      <!-- 3. Accuracy -->
      <td class="cell-accuracy num" data-label="Accuracy">
        <span>${accText}</span>
      </td>

      <!-- 4. Time -->
      <td class="cell-time num" data-label="Time">
        <span>${escapeHtml(cleanTime)}</span>
      </td>

      <!-- 5. Date -->
      <td class="cell-date" data-label="Date">
        <span>${escapeHtml(friendlyDate)}</span>
      </td>

      <!-- 6. Details Button -->
      <td class="cell-details" data-label="Details">
        <button
          type="button"
          class="btn btn-outline btn-sm btn-history-details"
          aria-expanded="false"
          aria-controls="${detailsId}"
          data-details-toggle="${detailsId}"
          aria-label="Toggle details for ${escapeHtml(category)}"
        >
          Details <span class="details-chevron" aria-hidden="true">▾</span>
        </button>
      </td>
    </tr>
    <tr id="${detailsId}" class="history-details-row" hidden>
      <td colspan="6" class="history-details-cell">
        <div class="history-details-panel">
          ${isFlagged ? `
            <div class="attention-explanation-box">
              <div style="font-weight: 700; color: #92400E; display: flex; align-items: center; gap: 6px;">
                ⚠️ Teacher review requested
              </div>
              <div style="color: #78350F; margin-top: 4px; font-size: var(--text-sm);">
                Your teacher asked you to check this score entry.
                ${flagNote ? `<br><strong>Teacher Note:</strong> ${escapeHtml(flagNote)}` : ''}
              </div>
            </div>
          ` : ''}
          <div class="history-meta-grid">
            ${detailsMeta.map(item => `
              <div class="meta-item">
                <span class="meta-label">${escapeHtml(item.label)}</span>
                <span class="meta-value">${item.valueHtml}</span>
              </div>
            `).join('')}
          </div>
          ${actionsHtml ? `
            <div class="history-actions-row">
              ${actionsHtml}
            </div>
          ` : ''}
        </div>
      </td>
    </tr>
  `;
}

/**
 * Normalizes a Memoriad module key, preserving stored identifiers and legacy aliases.
 * - 'calendar' -> 'calendar'
 * - 'additions' / 'addition' -> 'additions'
 * - 'multiplications' / 'multiplication' -> 'multiplications'
 * - 'square_roots' / 'square_root' -> 'square_roots'
 *
 * @param {string|null|undefined} val
 * @returns {string}
 */
export function normalizeMemoriadModuleKey(val) {
  if (!val) return '';
  const s = String(val).trim().toLowerCase();
  if (s === 'calendar' || s.includes('calendar')) return 'calendar';
  if (s === 'addition' || s === 'additions' || s.includes('addition')) return 'additions';
  if (s === 'multiplication' || s === 'multiplications' || s.includes('multiplication')) return 'multiplications';
  if (s === 'square_root' || s === 'square_roots' || s.includes('root')) return 'square_roots';
  return s;
}

/**
 * Resolves the category / drill / module identifier for filtering.
 *
 * @param {Record<string, any>} row
 * @param {'basics'|'flash'|'elements'|'memoriad'} sectionKind
 * @returns {string}
 */
export function resolveRowCategoryKey(row, sectionKind) {
  if (!row) return '';
  if (sectionKind === 'basics') {
    return String(row.category_id || row.category?.id || '').trim();
  }
  if (sectionKind === 'flash') {
    const digits =
      row.settings?.digits ??
      row.settings?.flash_digits ??
      row.flash_digits ??
      '';
    return String(digits).trim();
  }
  if (sectionKind === 'elements') {
    const drillKey =
      row.settings?.drill ??
      row.settings?.drill_key ??
      row.activity_name ??
      '';
    return String(drillKey).trim().toLowerCase();
  }
  if (sectionKind === 'memoriad') {
    const rawKey =
      row.module ??
      row.settings?.module ??
      row.activity_name ??
      '';
    return normalizeMemoriadModuleKey(rawKey);
  }
  return '';
}

/**
 * Pure filter and sort function for score histories.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{
 *   dateFrom?: string,
 *   dateTo?: string,
 *   category?: string,
 *   source?: 'all'|'typed'|'site',
 *   sort?: 'newest'|'oldest'|'accuracy_desc'|'accuracy_asc'
 * }} filters
 * @param {{
 *   sectionKind: 'basics'|'flash'|'elements'|'memoriad'
 * }} options
 * @returns {Array<Record<string, any>>}
 */
export function filterAndSortHistory(rows, filters = {}, options = { sectionKind: 'basics' }) {
  if (!Array.isArray(rows)) return [];

  const {
    dateFrom = '',
    dateTo = '',
    category = 'all',
    source = 'all',
    sort = 'newest',
  } = filters;

  const sectionKind = options.sectionKind || 'basics';

  // 1. Filter
  const filtered = rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;

    // Date range in India time
    const rowDateIST = toISTDateString(row.entry_date || row.created_at);
    if (dateFrom && rowDateIST && rowDateIST < dateFrom) {
      return false;
    }
    if (dateTo && rowDateIST && rowDateIST > dateTo) {
      return false;
    }

    // Category filter
    if (category && category !== 'all') {
      const catKey = resolveRowCategoryKey(row, sectionKind);
      const targetCat = String(category).trim().toLowerCase();
      if (sectionKind === 'basics' || sectionKind === 'flash') {
        if (catKey !== targetCat && String(row.category_id) !== String(category)) {
          return false;
        }
      } else if (sectionKind === 'memoriad') {
        const normTarget = normalizeMemoriadModuleKey(targetCat);
        const normCat = normalizeMemoriadModuleKey(catKey);
        const rowNameNorm = normalizeMemoriadModuleKey(row.activity_name);
        const rawModNorm = normalizeMemoriadModuleKey(row.module || row.settings?.module);
        if (
          normCat !== normTarget &&
          rowNameNorm !== normTarget &&
          rawModNorm !== normTarget &&
          catKey !== targetCat
        ) {
          return false;
        }
      } else {
        // Elements: compare drill key or activity name
        const rowName = String(row.activity_name || '').trim().toLowerCase();
        if (catKey !== targetCat && rowName !== targetCat) {
          return false;
        }
      }
    }

    // Source filter (all / typed / site)
    if (source && source !== 'all') {
      const resolvedSource = resolveEntrySource(row, sectionKind);
      if (resolvedSource !== source) {
        return false;
      }
    }

    return true;
  });

  // 2. Deterministic Sorting
  filtered.sort((a, b) => {
    const timeA = new Date(a.created_at || a.entry_date || 0).getTime() || 0;
    const timeB = new Date(b.created_at || b.entry_date || 0).getTime() || 0;
    const idA = String(a.id || '');
    const idB = String(b.id || '');

    if (sort === 'oldest') {
      if (timeA !== timeB) return timeA - timeB;
      return idA.localeCompare(idB);
    }

    if (sort === 'accuracy_desc' || sort === 'accuracy_asc') {
      const accA = computeAccuracyPct(a.correct, a.total ?? a.attempted);
      const accB = computeAccuracyPct(b.correct, b.total ?? b.attempted);

      if (Math.abs(accA - accB) > 0.0001) {
        return sort === 'accuracy_desc' ? accB - accA : accA - accB;
      }
      // Tie-breaker: newest first, then id
      if (timeB !== timeA) return timeB - timeA;
      return idB.localeCompare(idA);
    }

    // Default: 'newest'
    if (timeB !== timeA) return timeB - timeA;
    return idB.localeCompare(idA);
  });

  return filtered;
}

/**
 * Paginates an array of items for client-side browsing without silently capping.
 *
 * @template T
 * @param {Array<T>} items
 * @param {{ page?: number, pageSize?: number }} [config]
 * @returns {{
 *   page: number,
 *   pageSize: number,
 *   totalCount: number,
 *   totalPages: number,
 *   items: Array<T>
 * }}
 */
export function paginateHistory(items, { page = 1, pageSize = 20 } = {}) {
  const totalCount = Array.isArray(items) ? items.length : 0;
  const safePageSize = Math.max(1, Number(pageSize) || 20);
  const totalPages = Math.max(1, Math.ceil(totalCount / safePageSize));
  const currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));

  const from = (currentPage - 1) * safePageSize;
  const to = from + safePageSize;
  const slice = Array.isArray(items) ? items.slice(from, to) : [];

  return {
    page: currentPage,
    pageSize: safePageSize,
    totalCount,
    totalPages,
    items: slice,
  };
}

/**
 * Escapes HTML strings safely.
 *
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates the standardized Filter & Sort Toolbar HTML.
 *
 * @param {{
 *   idPrefix: string,
 *   categories: Array<{ id: string, name: string }>,
 *   currentFilters: {
 *     dateFrom?: string,
 *     dateTo?: string,
 *     category?: string,
 *     source?: string,
 *     sort?: string
 *   },
 *   hasTyped?: boolean
 * }} params
 * @returns {string}
 */
export function renderHistoryFilterToolbarHtml({
  idPrefix,
  categories = [],
  currentFilters = {},
  hasTyped = true,
}) {
  const {
    dateFrom = '',
    dateTo = '',
    category = 'all',
    source = 'all',
    sort = 'newest',
  } = currentFilters;

  const catOptions = [
    `<option value="all"${category === 'all' ? ' selected' : ''}>All Categories / Drills</option>`,
    ...categories.map(
      (c) =>
        `<option value="${escapeHtml(c.id)}"${category === String(c.id) ? ' selected' : ''}>${escapeHtml(
          c.name
        )}</option>`
    ),
  ].join('');

  return `
    <div class="card history-filter-toolbar" style="padding: var(--space-3) var(--space-4); margin-bottom: var(--space-4); background: var(--bg-surface-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-md);">
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end;">
        <!-- Date From -->
        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 130px; flex: 1 1 130px;">
          <label for="${idPrefix}-filter-from" style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
            Date From
          </label>
          <input
            type="date"
            id="${idPrefix}-filter-from"
            class="input-sm"
            value="${escapeHtml(dateFrom)}"
            style="width: 100%; padding: 4px 8px; font-size: var(--text-xs); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm);"
          />
        </div>

        <!-- Date To -->
        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 130px; flex: 1 1 130px;">
          <label for="${idPrefix}-filter-to" style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
            Date To
          </label>
          <input
            type="date"
            id="${idPrefix}-filter-to"
            class="input-sm"
            value="${escapeHtml(dateTo)}"
            style="width: 100%; padding: 4px 8px; font-size: var(--text-xs); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm);"
          />
        </div>

        <!-- Category -->
        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 160px; flex: 2 1 160px;">
          <label for="${idPrefix}-filter-cat" style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
            Category / Drill
          </label>
          <select
            id="${idPrefix}-filter-cat"
            class="input-sm"
            style="width: 100%; padding: 4px 8px; font-size: var(--text-xs); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm);"
          >
            ${catOptions}
          </select>
        </div>

        <!-- Source -->
        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 140px; flex: 1 1 140px;">
          <label for="${idPrefix}-filter-source" style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
            Entry Source
          </label>
          <select
            id="${idPrefix}-filter-source"
            class="input-sm"
            style="width: 100%; padding: 4px 8px; font-size: var(--text-xs); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm);"
          >
            <option value="all"${source === 'all' ? ' selected' : ''}>All Sources</option>
            <option value="typed"${source === 'typed' ? ' selected' : ''}>Typed by Student</option>
            <option value="site"${source === 'site' ? ' selected' : ''}>Recorded by Site</option>
            <option value="legacy"${source === 'legacy' ? ' selected' : ''}>Legacy / Unspecified</option>
          </select>
        </div>

        <!-- Sort -->
        <div style="display: flex; flex-direction: column; gap: 4px; min-width: 140px; flex: 1 1 140px;">
          <label for="${idPrefix}-filter-sort" style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em;">
            Sort Order
          </label>
          <select
            id="${idPrefix}-filter-sort"
            class="input-sm"
            style="width: 100%; padding: 4px 8px; font-size: var(--text-xs); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm);"
          >
            <option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest First</option>
            <option value="oldest"${sort === 'oldest' ? ' selected' : ''}>Oldest First</option>
            <option value="accuracy_desc"${sort === 'accuracy_desc' ? ' selected' : ''}>Highest Accuracy</option>
            <option value="accuracy_asc"${sort === 'accuracy_asc' ? ' selected' : ''}>Lowest Accuracy</option>
          </select>
        </div>

        <!-- Actions -->
        <div style="display: flex; gap: var(--space-2); align-items: center; margin-top: auto;">
          <button
            type="button"
            id="${idPrefix}-btn-clear-filters"
            class="btn btn-outline btn-sm"
            style="padding: 4px 10px; font-size: var(--text-xs);"
            title="Reset all filters to default"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders pagination controls HTML.
 *
 * @param {{
 *   idPrefix: string,
 *   page: number,
 *   totalPages: number,
 *   totalCount: number
 * }} params
 * @returns {string}
 */
export function renderHistoryPaginationHtml({ idPrefix, page, totalPages, totalCount }) {
  if (totalCount === 0) return '';

  return `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border-hairline); flex-wrap: wrap; gap: var(--space-2);">
      <span style="font-size: var(--text-xs); color: var(--text-muted);">
        Showing page <strong class="num">${page}</strong> of <strong class="num">${totalPages}</strong> (${totalCount} total record${totalCount === 1 ? '' : 's'})
      </span>
      <div style="display: inline-flex; gap: var(--space-2); align-items: center;">
        <button
          type="button"
          id="${idPrefix}-btn-prev-page"
          class="btn btn-outline btn-sm"
          style="padding: 3px 10px; font-size: 11px;"
          ${page <= 1 ? 'disabled' : ''}
        >
          &larr; Previous
        </button>
        <button
          type="button"
          id="${idPrefix}-btn-next-page"
          class="btn btn-outline btn-sm"
          style="padding: 3px 10px; font-size: 11px;"
          ${page >= totalPages ? 'disabled' : ''}
        >
          Next &rarr;
        </button>
      </div>
    </div>
  `;
}
