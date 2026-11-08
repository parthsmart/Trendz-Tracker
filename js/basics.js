/**
 * Trendz Tracker - Student Basics Speed Drills Module
 * Handles recording mental calculation drills (digits and rows),
 * 7-day backdating management, date-grouped history, and non-overriding updates.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { requireAuth } from './guard.js';
import { getScoreFeedback } from './scoreColors.js';
import { DemoDB, getSupabase } from './supabaseClient.js';
import { formatSecondsToMMSS, parseTimeToSeconds } from './timeUtils.js';
import { formatSecondsToTime } from './stats.js';
import { isBasicsOnlineAvailable } from './practiceStats.js';
import { showToast } from './toast.js';
import {
  toISTDateString,
  filterAndSortHistory,
  paginateHistory,
  renderHistoryFilterToolbarHtml,
  renderHistoryPaginationHtml,
  fetchAllRowsBatched,
  resolveEntrySource,
  renderSourceChipHtml,
  renderCompactHistoryRowHtml,
  practiceRecordStatus,
  formatFriendlyDateIST,
  formatAccuracyDisplay,
  resolveHistoryTargetStudent,
  renderTargetStudentBanner,
} from './historyFilters.js';

let currentProfile = null;
let activeHistoryStudent = null;
let basicsCategories = [];
let allBasicsResults = [];
let activeThresholds = [];
let editingDrillId = null;
let serverTodayIST = null;
let serverTodayError = null;

let basicsHistoryFilters = {
  dateFrom: '',
  dateTo: '',
  category: 'all',
  source: 'all',
  sort: 'newest',
};
let basicsHistoryPage = 1;
const BASICS_PAGE_SIZE = 20;

export function isViewingOtherStudent() {
  return Boolean(activeHistoryStudent && currentProfile && activeHistoryStudent.id !== currentProfile.id);
}

export function applyBasicsStudentViewMode(isOtherStudent) {
  const entryCard = document.getElementById('basics-entry-card') || document.getElementById('basics-form')?.closest('.card') || document.querySelector('section.card[aria-labelledby="entry-heading"]');
  if (entryCard) {
    entryCard.style.display = isOtherStudent ? 'none' : '';
  }

  const onlineCard = document.getElementById('online-practice-categories-card') || document.getElementById('basics-online-practice-card');
  if (onlineCard) {
    if (isOtherStudent) {
      onlineCard.style.display = 'none';
    } else if (basicsCategories && basicsCategories.length > 0) {
      onlineCard.style.display = 'block';
    }
  }

  const onlineBtn = document.getElementById('btn-selected-practice-online');
  if (onlineBtn) {
    if (isOtherStudent) {
      onlineBtn.style.display = 'none';
    } else {
      const selectEl = document.getElementById('basics-category-select');
      if (selectEl && selectEl.value) {
        updateCategoryTargetDisplay(selectEl.value);
      } else {
        onlineBtn.style.display = '';
      }
    }
  }
}


/**
 * Obtains today's date in IST from the authoritative server/database RPC source (`today_ist`).
 * In live mode: queries `supabase.rpc('today_ist')`.
 * In demo mode: queries `DemoDB.mockTodayIST()` (deterministic, supports localStorage override).
 *
 * Rejects with an error if the database call fails or returns an invalid date,
 * ensuring date loading failures are handled explicitly rather than falling back to
 * an unverified or desynchronized device clock.
 *
 * @returns {Promise<string>} Format: "YYYY-MM-DD"
 */
export async function fetchServerTodayIST() {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (!supabase) {
      throw new Error('Supabase client unavailable');
    }
    const { data, error } = await supabase.rpc('today_ist');
    if (error) {
      throw new Error(error.message || 'Failed to fetch server today_ist');
    }
    const clean = data ? String(data).trim() : '';
    if (!clean || !/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      throw new Error(`Invalid server date format: "${clean}"`);
    }
    return clean;
  }

  // Demo mode: deterministic demo date source
  if (typeof DemoDB !== 'undefined' && typeof DemoDB.mockTodayIST === 'function') {
    const demoDate = await DemoDB.mockTodayIST();
    const clean = demoDate ? String(demoDate).trim() : '';
    if (clean && /^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      return clean;
    }
  }

  throw new Error('Demo database unavailable or returned invalid date');
}

export function setServerTodayISTForTesting(dateOrNull) {
  serverTodayIST = dateOrNull;
}

export function setServerTodayErrorForTesting(errOrNull) {
  serverTodayError = errOrNull;
}

export function getServerTodayIST() {
  return serverTodayIST;
}

export function getActiveHistoryStudent() {
  return activeHistoryStudent;
}

export function setActiveHistoryStudentForTesting(stu) {
  activeHistoryStudent = stu;
}

export function setBasicsResultsForTesting(results) {
  allBasicsResults = Array.isArray(results) ? [...results] : [];
}

export function getBasicsResultsForTesting() {
  return allBasicsResults;
}

export function setBasicsCategoriesForTesting(cats) {
  basicsCategories = Array.isArray(cats) ? [...cats] : [];
}

export function setBasicsFiltersForTesting(filters) {
  basicsHistoryFilters = { ...basicsHistoryFilters, ...filters };
}

export function setBasicsPageForTesting(page) {
  basicsHistoryPage = page;
}

export function setCurrentProfileForTesting(profile) {
  currentProfile = profile;
}


/**
 * Format date into "3 Oct 2026"
 */
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Configure min/max on custom date input (up to 7 days back)
 * Uses server-authoritative date if available.
 */
function setupDateLimits(todayDateStr = null) {
  const customDateInput = document.getElementById('basics-custom-date');
  if (!customDateInput) return;

  const resolvedToday = todayDateStr && /^\d{4}-\d{2}-\d{2}$/.test(todayDateStr)
    ? todayDateStr
    : null;

  if (resolvedToday) {
    const [y, m, d] = resolvedToday.split('-').map(Number);
    const past7Date = new Date(Date.UTC(y, m - 1, d - 7));
    customDateInput.max = resolvedToday;
    customDateInput.min = past7Date.toISOString().slice(0, 10);
    customDateInput.value = resolvedToday;
  } else {
    const now = new Date();
    const past7 = new Date();
    past7.setDate(now.getDate() - 7);
    customDateInput.max = now.toISOString().split('T')[0];
    customDateInput.min = past7.toISOString().split('T')[0];
    customDateInput.value = customDateInput.max;
  }
}

/**
 * Load active basics categories
 */
async function loadBasicsCategories() {
  const selectEl = document.getElementById('basics-category-select');
  selectEl.innerHTML = '<option value="">Loading categories...</option>';

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('categories')
          .select('id, name, section, sort_order, active')
          .eq('section', 'basics')
          .eq('active', true)
          .order('sort_order', { ascending: true });

        if (!error && Array.isArray(data) && data.length > 0) {
          basicsCategories = data;
        } else {
          if (error) console.warn('Could not load categories from Supabase, using defaults:', error.message);
          basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
        }
      } else {
        basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
      }
    } else {
      basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
    }

    if (basicsCategories.length === 0) {
      selectEl.innerHTML = '<option value="">No basics categories found</option>';
      return;
    }

    selectEl.innerHTML = basicsCategories.map(c => `
      <option value="${c.id}">${escapeHtml(c.name)}</option>
    `).join('');

    // Preselect category if passed in URL query parameter (e.g. from Today's To-Do link)
    const urlParams = new URLSearchParams(window.location.search);
    const catParam = urlParams.get('cat') || urlParams.get('category') || urlParams.get('category_id');
    if (catParam && selectEl.querySelector(`option[value="${catParam}"]`)) {
      selectEl.value = catParam;
    }

    renderOnlinePracticeButtons();
    updateCategoryTargetDisplay(selectEl.value);
  } catch (err) {
    console.warn('Error in loadBasicsCategories, falling back to local categories:', err);
    basicsCategories = DemoDB.getCategories().filter(c => c.section === 'basics' && c.active);
    if (basicsCategories.length > 0) {
      selectEl.innerHTML = basicsCategories.map(c => `
        <option value="${c.id}">${escapeHtml(c.name)}</option>
      `).join('');

      const urlParams = new URLSearchParams(window.location.search);
      const catParam = urlParams.get('cat') || urlParams.get('category') || urlParams.get('category_id');
      if (catParam && selectEl.querySelector(`option[value="${catParam}"]`)) {
        selectEl.value = catParam;
      }
      renderOnlinePracticeButtons();
      updateCategoryTargetDisplay(selectEl.value);
    } else {
      showToast('error', 'Failed to load categories: ' + (err.message || 'Network error'));
    }
  }

  // Update target badge when student changes chosen category
  selectEl.addEventListener('change', () => {
    updateCategoryTargetDisplay(selectEl.value);
  });
}

/**
 * Renders a "Practice online" button for each basics category that is available online
 */
function renderOnlinePracticeButtons() {
  const cardEl = document.getElementById('online-practice-categories-card') || document.getElementById('basics-online-practice-card');
  const listEl = document.getElementById('online-practice-buttons-list');
  if (!cardEl || !listEl) return;

  if (isViewingOtherStudent()) {
    cardEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  const onlineCats = basicsCategories.filter(c => isBasicsOnlineAvailable(c));
  if (onlineCats.length === 0) {
    cardEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = onlineCats.map(c => `
    <a
      href="/pages/basics-practice.html?cat=${encodeURIComponent(c.id)}"
      class="btn btn-primary btn-sm"
      style="text-decoration: none;"
    >
      ${escapeHtml(c.name)} &middot; Practice online
    </a>
  `).join('');
  cardEl.style.display = 'block';
}

/**
 * Loads active target thresholds from database or demoDb
 */
async function loadActiveThresholds() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('basics_thresholds')
        .select('id, category_id, level, min_accuracy, max_time_seconds, min_questions_per_minute, active')
        .eq('active', true);

      if (!error && data) {
        activeThresholds = data;
      }
    } else {
      activeThresholds = DemoDB.getBasicsThresholds().filter(t => t.active !== false);
    }
  } catch (err) {
    console.warn('Could not load basics thresholds:', err);
  }
}

/**
 * Shows the student's target (level rule if one exists, else the default)
 * e.g. "Target: 90% accuracy in 2:00 or less"
 */
function updateCategoryTargetDisplay(categoryId) {
  const container = document.getElementById('category-target-display');
  const textEl = document.getElementById('category-target-text');
  const onlineBtn = document.getElementById('btn-selected-practice-online');

  const selectedCat = basicsCategories.find(c => c.id === categoryId);
  if (onlineBtn) {
    if (!isViewingOtherStudent() && selectedCat && isBasicsOnlineAvailable(selectedCat)) {
      onlineBtn.href = `/pages/basics-practice.html?cat=${encodeURIComponent(selectedCat.id)}`;
      onlineBtn.textContent = `Practice ${selectedCat.name} online →`;
      onlineBtn.style.display = 'inline-flex';
    } else {
      onlineBtn.style.display = 'none';
    }
  }

  if (!container || !textEl) return;

  if (!categoryId) {
    container.style.display = 'none';
    return;
  }

  const studentLevel = (currentProfile?.level || '').trim().toLowerCase();

  // 1. Level-specific rule beats default rule
  let rule = null;
  if (studentLevel) {
    rule = activeThresholds.find(t => t.category_id === categoryId && t.level && t.level.trim().toLowerCase() === studentLevel);
  }
  // 2. Fall back to default rule
  if (!rule) {
    rule = activeThresholds.find(t => t.category_id === categoryId && (!t.level || !t.level.trim()));
  }

  if (rule) {
    const parts = [`${rule.min_accuracy}% accuracy`];
    if (rule.min_questions_per_minute && Number(rule.min_questions_per_minute) > 0) {
      parts.push(`at least ${Number(rule.min_questions_per_minute)} questions per minute in timed rounds`);
    }
    if (rule.max_time_seconds) {
      parts.push(`in ${formatSecondsToTime(rule.max_time_seconds)} or less for typed entries`);
    }
    textEl.textContent = `Target: ${parts.join(', ')}`;
    container.style.display = 'block';
  } else {
    container.style.display = 'none';
  }
}

/**
 * Load all basics results for this student
 */
export async function loadBasicsHistory() {
  const todayContainer = document.getElementById('today-drills-container');
  const pastContainer = document.getElementById('past-drills-container');
  const todayBadge = document.getElementById('today-count-badge');

  if (todayContainer) todayContainer.innerHTML = '<div class="skeleton-row"></div>';
  if (pastContainer) pastContainer.innerHTML = '<div class="skeleton-row"></div>';

  try {
    // 1. Fetch server-authoritative today IST date
    try {
      serverTodayIST = await fetchServerTodayIST();
      serverTodayError = null;
      setupDateLimits(serverTodayIST);
    } catch (dateErr) {
      serverTodayIST = null;
      serverTodayError = dateErr;
      console.warn('Error fetching server today_ist:', dateErr);
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const categoryIds = basicsCategories.map(c => c.id);

      if (categoryIds.length === 0) {
        if (todayContainer) todayContainer.innerHTML = '<p style="font-size: var(--text-sm); color: var(--text-dim);">No categories found.</p>';
        if (pastContainer) pastContainer.innerHTML = '';
        return;
      }

      if (supabase && categoryIds.length > 0) {
        // Read entries from results_with_target view for authoritative meets_target calculation
        allBasicsResults = await fetchAllRowsBatched(async (from, to) => {
          const { data, error } = await supabase
            .from('results_with_target')
            .select(`
              id,
              student_id,
              category_id,
              correct,
              total,
              time_seconds,
              note,
              entry_date,
              source,
              practice_mode,
              verified,
              verified_at,
              verified_by,
              corrected_at,
              corrected_by,
              flagged,
              flag_note,
              created_at,
              min_accuracy,
              min_questions_per_minute,
              max_time_seconds,
              meets_target,
              categories (
                name,
                sort_order
              )
            `)
            .eq('student_id', (activeHistoryStudent && activeHistoryStudent.id) || currentProfile.id)
            .in('category_id', categoryIds)
            .order('entry_date', { ascending: false })
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);

          if (error) {
            console.warn('Could not fetch basics results_with_target batch:', error.message);
            return [];
          }
          return data || [];
        }, { batchSize: 1000 });
      } else {
        allBasicsResults = [];
      }
    } else {
      // Demo Mode retrieval with pre-computed meets_target
      const targetId = (activeHistoryStudent && activeHistoryStudent.id) || currentProfile?.id || 'usr-101';
      const demoDbResults = DemoDB.getResultsWithTarget(targetId, 'basics');
      const demoKey = `trendz_demo_basics_${targetId}`;
      const localAdded = JSON.parse(localStorage.getItem(demoKey) || '[]');
      // Merge local additions with targets
      allBasicsResults = [...localAdded, ...demoDbResults.filter(d => !localAdded.some(l => l.id === d.id))];
    }

    renderHistory();
  } catch (err) {
    console.warn('Error loading basics history:', err);
    allBasicsResults = isSupabaseConfigured()
      ? []
      : DemoDB.getResultsWithTarget(currentProfile?.id || 'default', 'basics');
    renderHistory();
  }
}

/**
 * Render history split into Today's sessions and Past 7 days grouped by date
 */
export function renderHistory() {
  const todayContainer = document.getElementById('today-drills-container');
  const pastContainer = document.getElementById('past-drills-container');
  const todayBadge = document.getElementById('today-count-badge');
  const toolbarContainer = document.getElementById('basics-history-toolbar-container');
  const paginationContainer = document.getElementById('basics-history-pagination-container');

  if (allBasicsResults.length === 0 && !serverTodayError) {
    if (todayContainer) {
      todayContainer.innerHTML = `
        <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
          No basics speed drills logged yet. Record your first drill above!
        </div>
      `;
    }
    if (pastContainer) pastContainer.innerHTML = '';
    if (toolbarContainer) toolbarContainer.innerHTML = '';
    if (paginationContainer) paginationContainer.innerHTML = '';
    if (todayBadge) todayBadge.textContent = '(0)';
    return;
  }

  // Handle server date loading failure explicitly
  if (serverTodayError || !serverTodayIST) {
    if (todayBadge) todayBadge.textContent = '(!)';
    if (todayContainer) {
      todayContainer.innerHTML = `
        <div class="banner banner-error" role="alert" style="margin-bottom: var(--space-4);">
          Unable to verify current date from server. Today's drills cannot be loaded.
        </div>
      `;
    }
  } else {
    // Authoritative server IST date for Today's practice
    const todayItems = allBasicsResults.filter(
      (r) => toISTDateString(r.entry_date || r.created_at) === serverTodayIST
    );

    if (todayBadge) todayBadge.textContent = `(${todayItems.length})`;

    // Render Today's items
    if (todayContainer) {
      if (todayItems.length === 0) {
        todayContainer.innerHTML = `
          <div class="card" style="padding: var(--space-4); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
            No speed drills logged yet for today.
          </div>
        `;
      } else {
        todayContainer.innerHTML = `
          <div class="card history-compact-card">
            <div class="table-container" style="border: none; border-radius: 0;">
              <table class="history-compact-table" aria-label="Today's Basics Drills">
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
                  ${todayItems.map(item => renderDrillRow(item, 'today')).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }
    }
  }

  // Render Filter Toolbar
  if (toolbarContainer) {
    toolbarContainer.innerHTML = renderHistoryFilterToolbarHtml({
      idPrefix: 'basics',
      categories: basicsCategories.map(c => ({ id: c.id, name: c.name })),
      currentFilters: basicsHistoryFilters,
      hasTyped: true,
    });
    wireBasicsFilterListeners();
  }

  // Filter & Sort all results across full history
  const filtered = filterAndSortHistory(allBasicsResults, basicsHistoryFilters, {
    sectionKind: 'basics',
  });

  const paged = paginateHistory(filtered, {
    page: basicsHistoryPage,
    pageSize: BASICS_PAGE_SIZE,
  });

  if (pastContainer) {
    if (paged.totalCount === 0) {
      pastContainer.innerHTML = `
        <div class="card" style="padding: var(--space-6); text-align: center; color: var(--text-dim); font-size: var(--text-sm);">
          No basics practice history matching the selected filters. Try clearing or adjusting your filters.
        </div>
      `;
    } else {
      const isAccuracySort =
        basicsHistoryFilters.sort === 'accuracy_desc' ||
        basicsHistoryFilters.sort === 'accuracy_asc';

      if (isAccuracySort) {
        // Render flat list without date grouping to preserve global accuracy ordering across pagination
        pastContainer.innerHTML = `
          <div class="card history-compact-card" style="margin-bottom: var(--space-4);">
            <div class="table-container" style="border: none; border-radius: 0;">
              <table class="history-compact-table" aria-label="Basics drills ranked by accuracy">
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
                  ${paged.items.map((item) => renderDrillRow(item, 'history')).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      } else {
        // Group paged items by entry_date for date-based sorting
        const grouped = new Map();
        paged.items.forEach((item) => {
          const dateKey = item.entry_date || 'Earlier';
          if (!grouped.has(dateKey)) grouped.set(dateKey, []);
          grouped.get(dateKey).push(item);
        });

        let pastHtml = '';
        grouped.forEach((items, dateKey) => {
          pastHtml += `
            <div class="card history-compact-card" style="margin-bottom: var(--space-4);">
              <div class="card-header" style="padding: var(--space-3) var(--space-5); background-color: var(--bg-surface-subtle); display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
                  📅 ${formatDateDisplay(dateKey)}
                </span>
                <span class="num" style="font-size: var(--text-xs); color: var(--text-dim);">
                  ${items.length} ${items.length === 1 ? 'drill' : 'drills'}
                </span>
              </div>
              <div class="table-container" style="border: none; border-radius: 0;">
                <table class="history-compact-table" aria-label="Drills for ${escapeHtml(dateKey)}">
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
                    ${items.map((item) => renderDrillRow(item, 'history')).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `;
        });
        pastContainer.innerHTML = pastHtml;
      }
    }
  }

  // Render Pagination
  if (paginationContainer) {
    paginationContainer.innerHTML = renderHistoryPaginationHtml({
      idPrefix: 'basics',
      page: paged.page,
      totalPages: paged.totalPages,
      totalCount: paged.totalCount,
    });

    const prevBtn = document.getElementById('basics-btn-prev-page');
    const nextBtn = document.getElementById('basics-btn-next-page');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (basicsHistoryPage > 1) {
          basicsHistoryPage--;
          renderHistory();
        }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        if (basicsHistoryPage < paged.totalPages) {
          basicsHistoryPage++;
          renderHistory();
        }
      });
    }
  }

  attachDrillActionListeners();
}

function wireBasicsFilterListeners() {
  const fromInput = document.getElementById('basics-filter-from');
  const toInput = document.getElementById('basics-filter-to');
  const catSelect = document.getElementById('basics-filter-cat');
  const sourceSelect = document.getElementById('basics-filter-source');
  const sortSelect = document.getElementById('basics-filter-sort');
  const clearBtn = document.getElementById('basics-btn-clear-filters');

  const onFilterChange = () => {
    basicsHistoryFilters.dateFrom = fromInput?.value || '';
    basicsHistoryFilters.dateTo = toInput?.value || '';
    basicsHistoryFilters.category = catSelect?.value || 'all';
    basicsHistoryFilters.source = sourceSelect?.value || 'all';
    basicsHistoryFilters.sort = sortSelect?.value || 'newest';
    basicsHistoryPage = 1;
    renderHistory();
  };

  fromInput?.addEventListener('change', onFilterChange);
  toInput?.addEventListener('change', onFilterChange);
  catSelect?.addEventListener('change', onFilterChange);
  sourceSelect?.addEventListener('change', onFilterChange);
  sortSelect?.addEventListener('change', onFilterChange);

  clearBtn?.addEventListener('click', () => {
    basicsHistoryFilters = {
      dateFrom: '',
      dateTo: '',
      category: 'all',
      source: 'all',
      sort: 'newest',
    };
    basicsHistoryPage = 1;
    renderHistory();
  });
}

/**
 * Render single drill list row (Compact 6-column format with expandable Details)
 *
 * @param {Record<string, any>} drill
 * @param {'today'|'history'} [contextPrefix='history'] - Context prefix for distinct DOM IDs
 */
export function renderDrillRow(drill, contextPrefix = 'history') {
  const catName = drill.categories?.name || basicsCategories.find(c => c.id === drill.category_id)?.name || 'Basics';
  const feedback = getScoreFeedback(drill.correct, drill.total);
  const timeFormatted = formatSecondsToMMSS(drill.time_seconds);
  const entrySource = resolveEntrySource(drill, 'basics');
  const isSite = entrySource === 'site';
  const practiceMode = drill.practice_mode === 'timed' ? 'Timed' : (drill.practice_mode === 'unlimited' ? 'Unlimited' : null);
  const attemptedPerMinute = practiceMode && Number(drill.total) > 0 && Number(drill.time_seconds) > 0
    ? (Math.round((Number(drill.total) / (Number(drill.time_seconds) / 60)) * 10) / 10).toFixed(1)
    : null;
  const isVerified = drill.verified === true || !!drill.verified_at || !!drill.verified_by;
  const isCorrected = !!drill.corrected_at || !!drill.corrected_by;
  const isFlagged = drill.flagged === true;
  const flagNote = drill.flag_note || '';
  const isLocked = isSite || isVerified || isCorrected;

  const targetStatusHtml = drill.meets_target === true
    ? '<span class="status-chip chip-verified" title="Meets target benchmark">🎯 Target met</span>'
    : drill.meets_target === false
    ? '<span class="status-chip" style="background-color: rgba(239, 68, 68, 0.12); color: #B91C1C; border: 1px solid rgba(239, 68, 68, 0.3);" title="Below target benchmark">⚠️ Below target</span>'
    : '—';

  // Authoritative derivation of status & lock:
  // Online sessions are locked against modification, but only teacher review marks verified/corrected
  const lockExplanation = practiceRecordStatus(drill, { readOnly: false });

  // Authoritative note: database column is "note", with fallback to "notes"
  const actualNote = drill.note ?? drill.notes ?? '';

  // Sentence-case labels without tiny uppercase
  const detailsMeta = [
    { label: 'Wrong answers', valueHtml: `<span class="score-tag ${feedback.badgeClass}">${escapeHtml(feedback.wrongText)}</span>` },
    { label: 'Speed / rate', valueHtml: attemptedPerMinute ? `${attemptedPerMinute} / min` : '—' },
    { label: 'Entry source', valueHtml: renderSourceChipHtml(entrySource) },
  ];

  // Only include practice mode if defined; never invent "Standard"
  if (practiceMode) {
    detailsMeta.push({ label: 'Practice mode', valueHtml: `<span class="status-chip chip-unverified">${practiceMode}</span>` });
  }

  detailsMeta.push(
    { label: 'Target benchmark', valueHtml: targetStatusHtml },
    { label: 'Status & lock', valueHtml: lockExplanation },
    { label: 'Notes', valueHtml: actualNote ? escapeHtml(actualNote) : '<span style="color: var(--text-dim);">None</span>' }
  );

  const isOtherStudentView = isViewingOtherStudent();
  const actionsHtml = isOtherStudentView
    ? ''
    : (!isLocked
      ? `
        <button
          type="button"
          class="btn btn-outline btn-sm btn-edit-drill"
          data-id="${drill.id}"
          style="min-height: 44px; min-width: 80px;"
          title="Edit drill"
        >
          Edit
        </button>
        <button
          type="button"
          class="btn btn-outline btn-sm btn-delete-drill"
          data-id="${drill.id}"
          style="min-height: 44px; min-width: 80px; color: #DC2626;"
          title="Delete drill"
        >
          Delete
        </button>
      `
      : `
        <span style="font-size: 11px; color: var(--text-dim); padding-right: var(--space-2);">
          🔒 Locked (editing and deletion disabled)
        </span>
      `);

  return renderCompactHistoryRowHtml({
    rowId: `${contextPrefix}-drill-${drill.id}`,
    category: catName,
    correct: drill.correct,
    total: drill.total,
    timeFormatted: timeFormatted,
    dateVal: drill.entry_date,
    isFlagged: isFlagged,
    flagNote: flagNote,
    statusBadgeHtml: '',
    detailsMeta: detailsMeta,
    actionsHtml: actionsHtml,
    mainRowAttrs: `data-drill-id="${drill.id}"`,
    mainRowClass: isLocked ? 'row-verified' : '',
  });
}

/**
 * Attach click handlers for edit and delete buttons
 */
function attachDrillActionListeners() {
  document.querySelectorAll('.btn-edit-drill').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isViewingOtherStudent()) {
        showToast('error', 'Cannot edit practice drills while viewing another student.');
        return;
      }
      const drillId = btn.getAttribute('data-id');
      const drill = allBasicsResults.find(r => r.id === drillId);
      if (!drill) return;

      if (drill.verified === true || !!drill.verified_at || !!drill.corrected_at) {
        showToast('error', 'This drill is locked and cannot be edited.');
        return;
      }

      editingDrillId = drill.id;
      document.getElementById('edit-drill-id').value = drill.id;
      document.getElementById('basics-category-select').value = drill.category_id;
      document.getElementById('basics-correct').value = drill.correct;
      document.getElementById('basics-total').value = drill.total;
      document.getElementById('basics-time').value = formatSecondsToMMSS(drill.time_seconds);

      // Hide date picker on edit as entry_date must never be changed on update
      document.getElementById('date-selection-group').style.display = 'none';

      document.getElementById('form-card-title').textContent = 'Edit Basics Drill';
      document.getElementById('btn-submit-drill-text').textContent = 'Update Drill';
      document.getElementById('btn-cancel-edit').style.display = 'inline-flex';

      updateLiveFeedback();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  document.querySelectorAll('.btn-delete-drill').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (isViewingOtherStudent()) {
        showToast('error', 'Cannot delete practice drills while viewing another student.');
        return;
      }
      const drillId = btn.getAttribute('data-id');
      const drill = allBasicsResults.find(r => r.id === drillId);
      if (drill && (drill.verified === true || !!drill.verified_at || !!drill.corrected_at)) {
        showToast('error', 'This drill is locked and cannot be deleted.');
        return;
      }

      if (!confirm('Are you sure you want to delete this drill entry?')) return;

      btn.disabled = true;
      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .delete()
            .eq('id', drillId)
            .eq('student_id', currentProfile.id);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          allBasicsResults = allBasicsResults.filter(r => r.id !== drillId);
          localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
        }

        showToast('success', 'Drill entry deleted.');
        await loadBasicsHistory();
      } catch (err) {
        showToast('error', 'Failed to delete drill: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function cancelEditMode() {
  editingDrillId = null;
  document.getElementById('basics-form').reset();
  document.getElementById('edit-drill-id').value = '';
  document.getElementById('date-selection-group').style.display = 'flex';
  document.getElementById('form-card-title').textContent = 'Record a Basics Drill';
  document.getElementById('btn-submit-drill-text').textContent = 'Save Drill Entry';
  document.getElementById('btn-cancel-edit').style.display = 'none';
  document.getElementById('basics-live-feedback').textContent = '—';
  document.getElementById('basics-live-feedback').className = 'score-tag score-tag-neutral';
}

function updateLiveFeedback() {
  const correct = document.getElementById('basics-correct').value.trim();
  const total = document.getElementById('basics-total').value.trim();
  const feedbackEl = document.getElementById('basics-live-feedback');

  const feedback = getScoreFeedback(correct, total);
  feedbackEl.textContent = feedback.wrongText;
  feedbackEl.className = `score-tag ${feedback.badgeClass}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

/**
 * Initialize Basics Page
 */
async function initBasics() {
  currentProfile = await requireAuth(['student', 'admin', 'teacher']);
  if (!currentProfile) return;

  const urlParams = new URLSearchParams(window.location.search);
  const requestedStudentId = urlParams.get('student_id') || urlParams.get('student');
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  const targetResult = await resolveHistoryTargetStudent({
    loggedInProfile: currentProfile,
    urlStudentId: requestedStudentId,
    supabase,
    isDemo: isDemoMode(),
    DemoDB,
  });

  if (targetResult.error) {
    showToast('error', targetResult.error);
    if (!targetResult.targetStudent) {
      const bannerPlaceholder = document.getElementById('config-banner-placeholder');
      if (bannerPlaceholder) {
        bannerPlaceholder.innerHTML = `<div class="banner banner-error" style="margin-bottom: var(--space-4);" role="alert">${escapeHtml(targetResult.error)}</div>`;
        bannerPlaceholder.style.display = 'block';
      }
      return;
    }
  }

  activeHistoryStudent = targetResult.targetStudent || currentProfile;

  const isOther = isViewingOtherStudent();
  applyBasicsStudentViewMode(isOther);

  if (isOther && activeHistoryStudent) {
    const bannerPlaceholder = document.getElementById('config-banner-placeholder');
    renderTargetStudentBanner(bannerPlaceholder, activeHistoryStudent);
  }
  if (!currentProfile) return;

  const pillContainer = document.getElementById('user-pill-container');
  if (pillContainer) pillContainer.style.display = 'flex';

  setupDateLimits();

  // Date preset toggle
  const datePreset = document.getElementById('basics-date-preset');
  const customDateContainer = document.getElementById('custom-date-container');

  datePreset?.addEventListener('change', () => {
    if (datePreset.value === 'custom') {
      customDateContainer.style.display = 'block';
    } else {
      customDateContainer.style.display = 'none';
    }
  });

  // Cancel edit handler
  document.getElementById('btn-cancel-edit')?.addEventListener('click', cancelEditMode);

  // Live score feedback listeners
  document.getElementById('basics-correct')?.addEventListener('input', updateLiveFeedback);
  document.getElementById('basics-total')?.addEventListener('input', updateLiveFeedback);

  // Time format on blur
  const timeInput = document.getElementById('basics-time');
  timeInput?.addEventListener('blur', () => {
    const raw = timeInput.value.trim();
    if (!raw) return;
    const sec = parseTimeToSeconds(raw);
    if (sec !== null) {
      timeInput.value = formatSecondsToMMSS(sec);
    }
  });

  // Form submit
  document.getElementById('basics-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isViewingOtherStudent()) {
      showToast('error', 'Cannot record or edit practice drills while viewing another student.');
      return;
    }
    const errorEl = document.getElementById('basics-form-error');
    const submitBtn = document.getElementById('btn-submit-drill');
    const btnText = document.getElementById('btn-submit-drill-text');

    errorEl.style.display = 'none';

    const category_id = document.getElementById('basics-category-select').value;
    const correctRaw = document.getElementById('basics-correct').value.trim();
    const totalRaw = document.getElementById('basics-total').value.trim();
    const timeRaw = document.getElementById('basics-time').value.trim();

    if (!category_id) {
      errorEl.textContent = 'Please choose a category.';
      errorEl.style.display = 'block';
      return;
    }

    const correct = parseInt(correctRaw, 10);
    const total = parseInt(totalRaw, 10);
    const time_seconds = timeRaw ? parseTimeToSeconds(timeRaw) : null;

    if (isNaN(correct) || correct < 0) {
      errorEl.textContent = 'Correct answers must be a non-negative number.';
      errorEl.style.display = 'block';
      return;
    }
    if (isNaN(total) || total <= 0) {
      errorEl.textContent = 'Total attempted must be greater than zero.';
      errorEl.style.display = 'block';
      return;
    }
    if (correct > total) {
      errorEl.textContent = 'Correct answers cannot be more than the total.';
      errorEl.style.display = 'block';
      return;
    }

    submitBtn.disabled = true;
    btnText.innerHTML = '<span class="spinner" style="margin-right: 6px;"></span> Saving...';

    try {
      if (editingDrillId) {
        // UPDATE: Never send entry_date when updating an existing row
        const updatePayload = {
          category_id,
          correct,
          total,
          time_seconds
        };

        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .update(updatePayload)
            .eq('id', editingDrillId)
            .eq('student_id', currentProfile.id);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          const idx = allBasicsResults.findIndex(r => r.id === editingDrillId);
          if (idx !== -1) {
            allBasicsResults[idx] = { ...allBasicsResults[idx], ...updatePayload };
            localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
          }
        }

        showToast('success', 'Basics drill updated successfully.');
        cancelEditMode();
      } else {
        // INSERT:
        // CRITICAL DATABASE RULE: When today is chosen, do NOT send entry_date so
        // default today_ist() is applied! Only send entry_date if custom earlier day chosen.
        const insertPayload = {
          student_id: currentProfile.id,
          category_id,
          correct,
          total,
          time_seconds,
          verified: false
        };

        if (datePreset.value === 'custom') {
          const pickedDate = document.getElementById('basics-custom-date').value;
          if (pickedDate) {
            insertPayload.entry_date = pickedDate;
          }
        }

        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase
            .from('results')
            .insert([insertPayload]);

          if (error) throw new Error(error.message);
        } else {
          const demoKey = `trendz_demo_basics_${currentProfile.id}`;
          const todayFallBack = serverTodayIST || (await fetchServerTodayIST().catch(() => new Date().toISOString().split('T')[0]));
          const newEntry = {
            id: `bas-${Date.now()}`,
            ...insertPayload,
            entry_date: insertPayload.entry_date || todayFallBack,
            created_at: new Date().toISOString()
          };
          allBasicsResults.unshift(newEntry);
          localStorage.setItem(demoKey, JSON.stringify(allBasicsResults));
        }

        showToast('success', 'Basics speed drill recorded!');
        document.getElementById('basics-correct').value = '';
        document.getElementById('basics-total').value = '';
        document.getElementById('basics-time').value = '';
        document.getElementById('basics-live-feedback').textContent = '—';
        document.getElementById('basics-live-feedback').className = 'score-tag score-tag-neutral';
      }

      await loadBasicsHistory();
    } catch (err) {
      console.error('Save error:', err);
      // Show message from any database error in a friendly toast
      showToast('error', err.message || 'Failed to save drill.');
      errorEl.textContent = err.message || 'Failed to save drill.';
      errorEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      btnText.textContent = editingDrillId ? 'Update Drill' : 'Save Drill Entry';
    }
  });

  // Initial load: fetch categories and thresholds in parallel
  await Promise.all([loadBasicsCategories(), loadActiveThresholds()]);
  updateCategoryTargetDisplay(document.getElementById('basics-category-select')?.value);
  await loadBasicsHistory();
  await handleBasicsUrlParams();
}

/**
 * Handles incoming URL query parameter for result linking:
 * - ?resultId=<uuid>
 * - Verifies recipient ownership and record existence
 * - Selects the required category/date filters and pagination page
 * - Scrolls to and highlights the referenced row
 */
export async function handleBasicsUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const resultId = urlParams.get('resultId');
  if (!resultId) return;

  let targetRow = allBasicsResults.find((r) => String(r.id) === String(resultId));

  if (!targetRow && isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('results_with_target')
          .select(`
            id,
            student_id,
            category_id,
            correct,
            total,
            time_seconds,
            note,
            entry_date,
            source,
            practice_mode,
            verified,
            verified_at,
            verified_by,
            corrected_at,
            corrected_by,
            flagged,
            flag_note,
            created_at,
            min_accuracy,
            min_questions_per_minute,
            max_time_seconds,
            meets_target,
            categories (
              name,
              sort_order
            )
          `)
          .eq('id', resultId)
          .maybeSingle();

        if (error || !data) {
          showToast('error', 'The referenced practice score could not be found.');
          return;
        }

        if (currentProfile?.role !== 'admin' && data.student_id !== currentProfile?.id) {
          showToast('error', 'You do not have permission to view this practice score.');
          return;
        }

        targetRow = data;
        allBasicsResults.unshift(targetRow);
      }
    } catch {
      showToast('error', 'The referenced practice score could not be found.');
      return;
    }
  }

  const activeProfile = currentProfile || (isDemoMode() ? (JSON.parse(localStorage.getItem('trendz_current_user') || 'null') || { id: 'usr-101', role: 'student' }) : null);

  if (!targetRow && !isSupabaseConfigured() && isDemoMode() && DemoDB) {
    try {
      const demoList = typeof DemoDB.getResults === 'function'
        ? DemoDB.getResults()
        : DemoDB.results || JSON.parse(localStorage.getItem('trendz_demo_results_v3') || localStorage.getItem('tt_results') || '[]');
      const found = demoList.find((r) => String(r.id) === String(resultId)) || null;
      if (found) {
        targetRow = found;
        allBasicsResults.unshift(targetRow);
      }
    } catch {
      // ignore
    }
  }

  if (!targetRow) {
    showToast('error', 'The referenced practice score could not be found.');
    return;
  }

  if (activeProfile?.role !== 'admin' && targetRow.student_id && targetRow.student_id !== activeProfile?.id) {
    showToast('error', 'You do not have permission to view this practice score.');
    return;
  }

  // Adjust filters so targetRow is not excluded
  if (basicsHistoryFilters.category !== 'all' && basicsHistoryFilters.category !== String(targetRow.category_id)) {
    basicsHistoryFilters.category = 'all';
  }
  if (basicsHistoryFilters.source !== 'all') {
    const rowSource = resolveEntrySource(targetRow, 'basics');
    if (basicsHistoryFilters.source !== rowSource) {
      basicsHistoryFilters.source = 'all';
    }
  }
  const rowDateIST = toISTDateString(targetRow.entry_date || targetRow.created_at);
  if (basicsHistoryFilters.dateFrom && rowDateIST && rowDateIST < basicsHistoryFilters.dateFrom) {
    basicsHistoryFilters.dateFrom = '';
  }
  if (basicsHistoryFilters.dateTo && rowDateIST && rowDateIST > basicsHistoryFilters.dateTo) {
    basicsHistoryFilters.dateTo = '';
  }

  const filtered = filterAndSortHistory(allBasicsResults, basicsHistoryFilters, {
    sectionKind: 'basics',
  });
  const targetIdx = filtered.findIndex((r) => String(r.id) === String(resultId));
  if (targetIdx !== -1) {
    basicsHistoryPage = Math.floor(targetIdx / BASICS_PAGE_SIZE) + 1;
  }

  renderHistory();

  // Scroll and highlight
  setTimeout(() => {
    const rowEl = document.querySelector(`[data-drill-id="${resultId}"]`);
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      rowEl.classList.add('row-linked-highlight');
      rowEl.style.outline = '2px solid var(--color-primary, #4338CA)';
      rowEl.style.backgroundColor = 'var(--bg-highlight, rgba(99, 102, 241, 0.12))';
      setTimeout(() => {
        rowEl.style.transition = 'background-color 2s ease, outline 2s ease';
        rowEl.style.backgroundColor = '';
        rowEl.style.outline = '';
      }, 3500);
    }
  }, 100);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initBasics);
}
