/**
 * Trendz Tracker - Admin Weekly Tests Controller (js/weeklyTests.js)
 *
 * Phase 4b + Phase 13a + Phase 16a:
 * - Admin-only route guard
 * - Two test types: 'offline' (trainer enters scores) and 'online' (students take it on the website)
 * - Lists tests newest first with 'Offline' or 'Online' chip, date, and section summaries
 * - Create & edit test modal:
 *   - Type choice radio ('offline' default or 'online')
 *   - Date (IST), Title (1-80 chars), Notes, Level (optional, with suggestions from student levels),
 *     Remind students from N days before (0-30, default 7)
 *   - Multi-kind sections builder (Offline: 0 to 12 sections; Online: 1 to 12 sections):
 *     - Kinds: 'basics', 'flash', 'elements', 'memoriad', 'round' ('round' is offline-only)
 *     - Up/Down reorder & Remove buttons
 *     - Per-section lock for sections that already have scores or attempts; in-place save by section id
 * - Detail view:
 *   - Top tabs: "Scores / Results" and "Leaderboard" (live weekly_test_leaderboard RPC view)
 *   - Tests with sections: one tab per section (labelled with sectionSummary) for trainer score entry
 *     with "N of M students entered" per tab, saving section_id + category_id (when applicable) + entered_by
 *   - Legacy offline tests with no sections: keeps category dropdown
 *   - Online test results table: one column per section of ANY kind, status chips, score, accuracy, time,
 *     shared score colour, "tries n of m" for Flash, and "Reset" by section_id
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getScoreFeedback } from './scoreColors.js';
import {
  isBasicsOnlineAvailable,
  WEEKLY_TEST_DURATION_OPTIONS,
} from './basicsSupport.js';
import {
  SECTION_KINDS,
  FLASH_MODES,
  MEMORIAD_MODULES,
  sectionSummary,
  speedMsToSecondsText,
  validateSections,
  toRows,
  getEnabledElementsDrills,
} from './weeklySections.js';
import {
  boardTitle,
  mapWeeklyTestLeaderboardRows,
} from './weeklyTestBoard.js';
import { fetchWeeklyTestLeaderboard } from './leaderboardData.js';
import { windowText } from './weeklyTestView.js';
import { formatReminderStartPreview } from './reportMessage.js';
import {
  getISTDateString,
  formatDisplayDateIST,
  formatSecondsToTime,
  parseTimeToSeconds,
} from './stats.js';
import { openModal, closeModal, setupModalListeners, setupAdminNav } from './modal.js';
import { shouldOpenMoreOptions, buildModalLiveSummary, setMoreOptionsOpen } from './formPattern.js';

let currentProfile = null;
let allTests = [];
let activeTestId = null;
let allCategories = [];
let categoriesById = new Map();
let activeCategoryId = null;
let activeSectionId = null;
let activeDetailTab = 'scores'; // 'scores' | 'leaderboard'
let onlineEntryMode = false; // false = Online Results table, true = Section Score Entry tabs
let activeStudents = [];
let studentLevels = new Set();
let adminProfilesMap = new Map();

// test_id -> array of section rows ordered by position
let testSectionsByTestId = new Map();
// For active test: all scores and attempts loaded
let activeTestAllScores = [];
let activeOnlineAttempts = [];
let activeOnlineScores = [];

// Modal sections builder state
let modalExistingSections = [];
let modalSectionsDraft = [];
let modalLockedSectionIds = new Set();
let modalHasAnyScoresOrAttempts = false;

// Pending reset attempt target: { testId, studentId, studentName, sectionId, categoryId, sectionLabel }
let pendingResetTarget = null;

// student_id -> { id?: string, correct: number|string, total: number|string, time_seconds: number|null, formatted_time?: string, source?: string, is_saved: boolean }
let currentScoresMap = new Map();
let hasUnsavedChanges = false;

let searchQuery = '';
let selectedLevelFilter = '';

async function initWeeklyTestsPage() {
  currentProfile = await requireAuth(['admin']);
  if (!currentProfile) return;

  renderHeaderUser(currentProfile);
  setupAdminNav();
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupDetailTabsHandlers();
  setupTestModalHandlers();
  setupRemoveTestHandlers();
  setupRecentlyRemovedHandlers();
  setupResetAttemptHandlers();
  setupFilterHandlers();
  setupUnsavedChangesGuard();

  await Promise.all([
    loadActiveStudents(),
    loadCategories(),
    loadRecentlyRemovedCount(),
    loadTests(),
  ]);
}

/**
 * Sets up the top detail view tabs ("Scores / Results" and "Leaderboard")
 * and the online score entry toggle button.
 */
function setupDetailTabsHandlers() {
  const tabBtns = document.querySelectorAll('[data-detail-tab]');
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetTab = btn.getAttribute('data-detail-tab') || 'scores';
      if (targetTab === activeDetailTab) return;

      if (hasUnsavedChanges) {
        const proceed = confirm(
          'You have unsaved score changes. Discard changes and switch view?'
        );
        if (!proceed) return;
        hasUnsavedChanges = false;
        setUnsavedIndicator(false);
      }

      activeDetailTab = targetTab;
      syncDetailTabsUI();
      const activeTest = allTests.find((t) => t.id === activeTestId);
      if (activeTest) {
        await renderActiveTestDetailContent(activeTest);
      }
    });
  });

  const btnToggleOnlineEntry = document.getElementById('btn-toggle-online-score-entry');
  if (btnToggleOnlineEntry) {
    btnToggleOnlineEntry.addEventListener('click', async () => {
      if (hasUnsavedChanges) {
        const proceed = confirm(
          'You have unsaved score changes. Discard changes and switch view?'
        );
        if (!proceed) return;
        hasUnsavedChanges = false;
        setUnsavedIndicator(false);
      }
      onlineEntryMode = !onlineEntryMode;
      const activeTest = allTests.find((t) => t.id === activeTestId);
      if (activeTest) {
        await renderActiveTestDetailContent(activeTest);
      }
    });
  }
}

function syncDetailTabsUI() {
  const tabBtns = document.querySelectorAll('[data-detail-tab]');
  tabBtns.forEach((btn) => {
    const isMatch = btn.getAttribute('data-detail-tab') === activeDetailTab;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });
}

/**
 * Loads all active students for score entry & level suggestions
 */
async function loadActiveStudents() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('profiles')
        .select('id, student_code, full_name, level, role, active')
        .order('student_code', { ascending: true });

      if (error) throw error;
      const rows = data || [];
      adminProfilesMap.clear();
      rows.forEach((p) => {
        adminProfilesMap.set(p.id, p.full_name || p.student_code || 'Admin');
      });
      activeStudents = rows.filter((s) => s.role === 'student' && s.active !== false);
    } else {
      adminProfilesMap.set('usr-admin-1', 'Chief Trainer');
      activeStudents = DemoDB.getStudents()
        .filter((s) => s.role === 'student' && s.active !== false)
        .sort((a, b) => String(a.student_code).localeCompare(String(b.student_code)));
    }

    studentLevels.clear();
    activeStudents.forEach((s) => {
      if (s.level && s.level.trim()) studentLevels.add(s.level.trim());
    });

    populateLevelFilter();
  } catch (err) {
    console.error('Failed to load active students:', err);
    showToast('error', 'Failed to load active students roster.');
  }
}

/**
 * Populates the level filter dropdown and the modal datalist suggestions
 */
function populateLevelFilter() {
  const sortedLevels = Array.from(studentLevels).sort();

  const select = document.getElementById('student-level-filter');
  if (select) {
    select.innerHTML = `
      <option value="">All Levels</option>
      ${sortedLevels
        .map(
          (lvl) => `
        <option value="${escapeHtml(lvl)}">${escapeHtml(lvl)}</option>
      `
        )
        .join('')}
    `;
  }

  const datalist = document.getElementById('student-levels-datalist');
  if (datalist) {
    datalist.innerHTML = sortedLevels
      .map((lvl) => `<option value="${escapeHtml(lvl)}"></option>`)
      .join('');
  }
}

/**
 * Loads categories and groups them with basics first
 */
async function loadCategories() {
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true });

      if (error) throw error;
      allCategories = data || [];
    } else {
      allCategories = DemoDB.getCategories()
        .filter((c) => c.active !== false)
        .sort((a, b) => a.sort_order - b.sort_order);
    }

    categoriesById = new Map(allCategories.map((c) => [c.id, c]));
    renderGroupedCategorySelect();
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

/**
 * Renders the category dropdown grouped by section (used only for legacy offline tests without sections).
 */
function renderGroupedCategorySelect() {
  const select = document.getElementById('score-category-select');
  if (!select) return;

  if (allCategories.length === 0) {
    select.innerHTML = '<option value="">No categories available</option>';
    return;
  }

  const basics = allCategories.filter((c) => c.section === 'basics');
  const rounds = allCategories.filter((c) => c.section === 'round');
  const elements = allCategories.filter((c) => c.section === 'elements');
  const flash = allCategories.filter((c) => c.section === 'flash');

  let html = '';

  if (basics.length > 0) {
    html += `<optgroup label="Basics Track">`;
    basics.forEach((c) => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (rounds.length > 0) {
    html += `<optgroup label="Competition Rounds">`;
    rounds.forEach((c) => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (elements.length > 0) {
    html += `<optgroup label="Elements Track">`;
    elements.forEach((c) => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  if (flash.length > 0) {
    html += `<optgroup label="Flash Anzan">`;
    flash.forEach((c) => {
      html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
    });
    html += `</optgroup>`;
  }

  select.innerHTML = html;

  if (basics.length > 0) {
    activeCategoryId = basics[0].id;
  } else if (allCategories.length > 0) {
    activeCategoryId = allCategories[0].id;
  }
  select.value = activeCategoryId;

  select.onchange = async () => {
    if (hasUnsavedChanges) {
      const confirmLeave = confirm(
        'You have unsaved score changes for the current category. Discard changes and switch category?'
      );
      if (!confirmLeave) {
        select.value = activeCategoryId;
        return;
      }
    }
    activeCategoryId = select.value;
    await loadScoresForCurrentSelection();
  };
}

/**
 * Loads weekly tests list (newest first) along with section rows and score counts
 */
async function loadTests(selectTestId = null) {
  const container = document.getElementById('tests-list-container');
  const badge = document.getElementById('tests-count-badge');

  try {
    testSectionsByTestId.clear();

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      const [testRes, countRes, sectionsRes] = await Promise.all([
        supabase
          .from('weekly_tests')
          .select('id, title, test_date, audience_level, notes, test_type, opens_at, closes_at, remind_days_before, created_at')
          .order('test_date', { ascending: false }),
        supabase.from('weekly_test_scores').select('test_id'),
        supabase
          .from('weekly_test_sections')
          .select('id, test_id, position, kind, category_id, activity_key, seconds, flash_digits, flash_count, flash_speed_ms, flash_mode, question_count')
          .order('position', { ascending: true }),
      ]);

      if (testRes.error) throw testRes.error;

      const countsMap = new Map();
      (countRes.data || []).forEach((row) => {
        countsMap.set(row.test_id, (countsMap.get(row.test_id) || 0) + 1);
      });

      (sectionsRes.data || []).forEach((sec) => {
        if (!testSectionsByTestId.has(sec.test_id)) {
          testSectionsByTestId.set(sec.test_id, []);
        }
        testSectionsByTestId.get(sec.test_id).push(sec);
      });

      allTests = (testRes.data || []).map((t) => {
        const secs = testSectionsByTestId.get(t.id) || [];
        return {
          ...t,
          test_type: t.test_type || 'offline',
          scores_count: countsMap.get(t.id) || 0,
          sections_count: secs.length,
        };
      });
    } else {
      const rawTests = DemoDB.getWeeklyTests();
      allTests = rawTests.map((t) => {
        const secs = DemoDB.getWeeklyTestSections ? DemoDB.getWeeklyTestSections(t.id) : [];
        testSectionsByTestId.set(t.id, secs);
        return {
          ...t,
          test_type: t.test_type || 'offline',
          sections_count: secs.length,
        };
      });
    }

    if (badge) {
      badge.textContent = `${allTests.length} ${allTests.length === 1 ? 'test' : 'tests'}`;
    }

    renderTestsList(selectTestId);
  } catch (err) {
    console.error('Failed to load tests list:', err);
    if (container) {
      container.innerHTML = `
        <div style="padding: var(--space-4); color: var(--color-danger); font-size: var(--text-xs);">
          Failed to load weekly tests: ${escapeHtml(err.message)}
        </div>
      `;
    }
  }
}

/**
 * Renders the sidebar tests list:
 * Each row shows an "Offline" or "Online" chip, the date, and section summaries when sections exist.
 */
function renderTestsList(requestedSelectId = null) {
  const container = document.getElementById('tests-list-container');
  if (!container) return;

  if (allTests.length === 0) {
    container.innerHTML = `
      <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-xs);">
        No weekly tests scheduled yet.
        <br />
        Click <strong>+ New Weekly Test</strong> above to create one.
      </div>
    `;
    clearTestDetail();
    return;
  }

  const chosenId =
    requestedSelectId && allTests.some((t) => t.id === requestedSelectId)
      ? requestedSelectId
      : activeTestId && allTests.some((t) => t.id === activeTestId)
        ? activeTestId
        : allTests[0].id;

  let html = `<div style="display: flex; flex-direction: column;">`;

  allTests.forEach((test) => {
    const isSelected = test.id === chosenId;
    const dateFormatted = formatDisplayDateIST(test.test_date);
    const isOnline = test.test_type === 'online';
    const typeChipLabel = isOnline ? 'Online' : 'Offline';
    const typeChipStyle = isOnline
      ? 'background: var(--color-primary-subtle); color: var(--color-primary-text);'
      : 'background: var(--chip-neutral-bg); color: var(--chip-neutral-text); border: 1px solid var(--border-subtle);';

    const secs = testSectionsByTestId.get(test.id) || [];
    const sectionsCount = secs.length;
    const summariesText =
      sectionsCount > 0
        ? secs.map((s) => sectionSummary(s, categoriesById)).join(' · ')
        : '';
    const sectionsMeta =
      sectionsCount > 0
        ? `${sectionsCount} ${sectionsCount === 1 ? 'section' : 'sections'}`
        : test.notes
          ? escapeHtml(test.notes)
          : 'Category score entry';

    html += `
      <button type="button" class="test-item-btn ${isSelected ? 'active' : ''}" data-test-id="${test.id}" style="
        text-align: left;
        background: ${isSelected ? 'var(--color-primary-subtle)' : 'transparent'};
        border: none;
        border-bottom: 1px solid var(--border-hairline);
        border-left: 3px solid ${isSelected ? 'var(--color-primary)' : 'transparent'};
        padding: var(--space-3) var(--space-4);
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        width: 100%;
      ">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-2);">
          <span style="font-weight: 700; font-size: var(--text-sm); color: ${isSelected ? 'var(--color-primary)' : 'var(--text-main)'};">
            ${escapeHtml(test.title)}
          </span>
          <span class="num" style="font-size: var(--text-xs); color: var(--text-muted); font-weight: 600; white-space: nowrap;">
            ${escapeHtml(dateFormatted)}
          </span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 2px; gap: var(--space-2);">
          <div style="display: inline-flex; align-items: center; gap: 6px; min-width: 0;">
            <span class="status-chip" style="${typeChipStyle}">
              ${typeChipLabel}
            </span>
            ${
              test.audience_level
                ? `<span class="status-chip">${escapeHtml(test.audience_level)}</span>`
                : ''
            }
            <span style="font-size: var(--text-xs); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(sectionsMeta)}
            </span>
          </div>
          <span class="status-chip ${test.scores_count > 0 ? 'chip-verified' : 'chip-unverified'}" style="flex-shrink: 0;">
            ${test.scores_count} ${test.scores_count === 1 ? 'score' : 'scores'}
          </span>
        </div>
        ${
          summariesText
            ? `<div style="font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;" title="${escapeHtml(summariesText)}">${escapeHtml(summariesText)}</div>`
            : ''
        }
      </button>
    `;
  });

  html += `</div>`;
  container.innerHTML = html;

  container.querySelectorAll('.test-item-btn').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-test-id');
      if (id === activeTestId) return;

      if (hasUnsavedChanges) {
        const confirmLeave = confirm(
          'You have unsaved score changes. Discard changes and select a different test?'
        );
        if (!confirmLeave) return;
      }

      onlineEntryMode = false;
      await selectTest(id);
    };
  });

  selectTest(chosenId);
}

/**
 * Activates a test and loads its detail view (Scores / Results or Leaderboard)
 */
async function selectTest(testId) {
  const isSameTest = activeTestId === testId;
  activeTestId = testId;
  hasUnsavedChanges = false;
  setUnsavedIndicator(false);

  const container = document.getElementById('tests-list-container');
  if (container) {
    container.querySelectorAll('.test-item-btn').forEach((b) => {
      const match = b.getAttribute('data-test-id') === testId;
      b.classList.toggle('active', match);
      b.style.background = match ? 'var(--color-primary-subtle)' : 'transparent';
      b.style.borderLeftColor = match ? 'var(--color-primary)' : 'transparent';
    });
  }

  const activeTest = allTests.find((t) => t.id === testId);
  if (!activeTest) {
    clearTestDetail();
    return;
  }

  const secs = testSectionsByTestId.get(activeTest.id) || [];
  if (!isSameTest || !activeSectionId || !secs.some((s) => s.id === activeSectionId)) {
    activeSectionId = secs[0]?.id || null;
  }

  const isOnline = activeTest.test_type === 'online';

  const titleEl = document.getElementById('active-test-title');
  const typeChipEl = document.getElementById('active-test-type-chip');
  const metaEl = document.getElementById('active-test-meta');
  const btnEdit = document.getElementById('btn-edit-active-test');
  const btnRemove = document.getElementById('btn-remove-active-test');

  if (titleEl) titleEl.textContent = activeTest.title;
  if (typeChipEl) {
    typeChipEl.style.display = 'inline-flex';
    typeChipEl.textContent = isOnline ? 'Online' : 'Offline';
    typeChipEl.style.background = isOnline ? 'var(--color-primary-subtle)' : 'var(--chip-neutral-bg)';
    typeChipEl.style.color = isOnline ? 'var(--color-primary-text)' : 'var(--chip-neutral-text)';
  }

  if (metaEl) {
    const formattedDate = formatDisplayDateIST(activeTest.test_date);
    const levelLabel = activeTest.audience_level
      ? ` &middot; <strong>Level:</strong> ${escapeHtml(activeTest.audience_level)}`
      : ' &middot; <strong>Level:</strong> All levels';
    const windowLabel = isOnline
      ? ` &middot; <strong>Window:</strong> ${escapeHtml(windowText(activeTest.opens_at, activeTest.closes_at))}`
      : '';
    const notesLabel = activeTest.notes ? ` &middot; <em>${escapeHtml(activeTest.notes)}</em>` : '';
    const sectionChipsHtml =
      secs.length > 0
        ? `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
            ${secs
              .map(
                (sec, idx) =>
                  `<span class="status-chip chip-unverified" style="font-size: 11px;">${idx + 1}. ${escapeHtml(
                    sectionSummary(sec, categoriesById)
                  )}</span>`
              )
              .join('')}
          </div>`
        : '';

    metaEl.innerHTML = `
      <div><strong>Date:</strong> <span class="num">${escapeHtml(formattedDate)}</span>${levelLabel}${windowLabel}${notesLabel}</div>
      ${sectionChipsHtml}
    `;
  }

  if (btnEdit) {
    btnEdit.style.display = 'inline-block';
    btnEdit.onclick = () => openTestModal(activeTest);
  }
  if (btnRemove) {
    btnRemove.style.display = 'inline-block';
    btnRemove.onclick = () => openRemoveTestModal(activeTest);
  }

  syncDetailTabsUI();
  await renderActiveTestDetailContent(activeTest);
}

/**
 * Renders the appropriate detail sub-view (Scores / Results vs Leaderboard) for the active test.
 */
async function renderActiveTestDetailContent(activeTest) {
  const isOnline = activeTest.test_type === 'online';
  const secs = testSectionsByTestId.get(activeTest.id) || [];
  const hasSections = secs.length > 0;

  const onlineBanner = document.getElementById('online-test-info-banner');
  const onlineModeActions = document.getElementById('online-view-mode-actions');
  const btnToggleOnlineEntry = document.getElementById('btn-toggle-online-score-entry');
  const sectionTabsBar = document.getElementById('section-tabs-bar');
  const offlineCatWrapper = document.getElementById('offline-category-select-wrapper');
  const studentSearchWrapper = document.getElementById('student-search-wrapper');
  const toolbar = document.getElementById('test-controls-toolbar');
  const offlineView = document.getElementById('offline-scores-view');
  const onlineView = document.getElementById('online-results-view');
  const leaderboardView = document.getElementById('test-leaderboard-view');

  if (activeDetailTab === 'leaderboard') {
    if (onlineBanner) onlineBanner.style.display = 'none';
    if (onlineModeActions) onlineModeActions.style.display = 'none';
    if (sectionTabsBar) sectionTabsBar.style.display = 'none';
    if (offlineCatWrapper) offlineCatWrapper.style.display = 'none';
    if (studentSearchWrapper) studentSearchWrapper.style.display = 'none';
    if (toolbar) toolbar.style.gridTemplateColumns = '200px';
    if (offlineView) offlineView.style.display = 'none';
    if (onlineView) onlineView.style.display = 'none';
    if (leaderboardView) leaderboardView.style.display = 'block';
    await loadTestLeaderboardForActiveTest(activeTest);
    return;
  }

  // Scores / Results tab
  if (leaderboardView) leaderboardView.style.display = 'none';
  if (studentSearchWrapper) studentSearchWrapper.style.display = 'block';

  if (isOnline && hasSections) {
    if (onlineModeActions) onlineModeActions.style.display = 'inline-flex';
    if (btnToggleOnlineEntry) {
      btnToggleOnlineEntry.textContent = onlineEntryMode
        ? 'View Online Results Table'
        : 'Enter / Edit Section Scores';
    }
  } else {
    if (onlineModeActions) onlineModeActions.style.display = 'none';
    onlineEntryMode = false;
  }

  if (isOnline && !onlineEntryMode) {
    // Online Results Matrix view
    if (onlineBanner) onlineBanner.style.display = 'block';
    if (sectionTabsBar) sectionTabsBar.style.display = 'none';
    if (offlineCatWrapper) offlineCatWrapper.style.display = 'none';
    if (toolbar) toolbar.style.gridTemplateColumns = '1fr 160px';
    if (offlineView) offlineView.style.display = 'none';
    if (onlineView) onlineView.style.display = 'block';
    await loadOnlineResultsForActiveTest(activeTest);
  } else if (hasSections) {
    // Section-based Score Entry view (for offline tests with sections, or online tests when trainer clicks Enter/Edit Section Scores)
    if (onlineBanner) onlineBanner.style.display = 'none';
    if (sectionTabsBar) sectionTabsBar.style.display = 'flex';
    if (offlineCatWrapper) offlineCatWrapper.style.display = 'none';
    if (toolbar) toolbar.style.gridTemplateColumns = '1fr 160px';
    if (offlineView) offlineView.style.display = 'block';
    if (onlineView) onlineView.style.display = 'none';
    if (!activeSectionId || !secs.some((s) => s.id === activeSectionId)) {
      activeSectionId = secs[0].id;
    }
    await loadScoresForCurrentSelection();
  } else {
    // Legacy Offline Test with NO sections (Category dropdown)
    if (onlineBanner) onlineBanner.style.display = 'none';
    if (sectionTabsBar) sectionTabsBar.style.display = 'none';
    if (offlineCatWrapper) offlineCatWrapper.style.display = 'block';
    if (toolbar) toolbar.style.gridTemplateColumns = 'minmax(220px, 300px) 1fr 140px';
    if (offlineView) offlineView.style.display = 'block';
    if (onlineView) onlineView.style.display = 'none';
    await loadScoresForCurrentSelection();
  }
}

/**
 * Clears the test detail section when no test is selected
 */
function clearTestDetail() {
  activeTestId = null;
  const titleEl = document.getElementById('active-test-title');
  const typeChipEl = document.getElementById('active-test-type-chip');
  const metaEl = document.getElementById('active-test-meta');
  const btnEdit = document.getElementById('btn-edit-active-test');
  const btnRemove = document.getElementById('btn-remove-active-test');
  const tbody = document.getElementById('scores-roster-tbody');

  if (titleEl) titleEl.textContent = 'Select a Test';
  if (typeChipEl) typeChipEl.style.display = 'none';
  if (metaEl) metaEl.textContent = 'Select a test from the left to view or enter scores.';
  if (btnEdit) btnEdit.style.display = 'none';
  if (btnRemove) btnRemove.style.display = 'none';
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-state" style="text-align: center; padding: var(--space-8);">
          No test selected.
        </td>
      </tr>
    `;
  }
}

/**
 * Returns active students filtered by the test's audience_level (when set)
 */
function getEligibleStudentsForTest(test) {
  if (!test || !test.audience_level || !String(test.audience_level).trim()) {
    return activeStudents;
  }
  const targetLvl = String(test.audience_level).trim().toLowerCase();
  return activeStudents.filter(
    (s) => String(s.level || '').trim().toLowerCase() === targetLvl
  );
}

// ============================================================================
// ADMIN TEST DETAIL LEADERBOARD TAB
// ============================================================================

async function loadTestLeaderboardForActiveTest(test) {
  const headingEl = document.getElementById('test-leaderboard-heading');
  const tbody = document.getElementById('test-leaderboard-tbody');
  if (!tbody) return;

  const effectiveLevel = selectedLevelFilter ? selectedLevelFilter : test.audience_level || 'all';
  const effectiveScope = effectiveLevel && effectiveLevel !== 'all' ? 'level' : 'global';

  if (headingEl) {
    headingEl.textContent = boardTitle(
      test.title,
      'all',
      effectiveScope,
      effectiveLevel !== 'all' ? effectiveLevel : null
    );
  }

  tbody.innerHTML = `
    <tr>
      <td colspan="5" class="loading-state" style="text-align: center; padding: var(--space-6);">
        Loading test leaderboard...
      </td>
    </tr>
  `;

  try {
    const rawRows = await fetchWeeklyTestLeaderboard(
      {
        testId: test.id,
        period: 'all',
        level: effectiveLevel,
        limit: 200,
        scope: effectiveScope,
      },
      currentProfile
    );

    const mapped = mapWeeklyTestLeaderboardRows(rawRows, {
      scope: effectiveScope,
      isAdmin: true,
    });

    if (mapped.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: var(--space-8); color: var(--text-muted); font-size: var(--text-xs);">
            No weekly test scores recorded for this test yet.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = mapped
      .map((row) => {
        const nameHtml = row.student_id
          ? `<a href="/pages/student-detail.html?id=${encodeURIComponent(row.student_id)}" style="font-weight: 600; color: var(--color-primary); text-decoration: none;">${escapeHtml(row.display_name)}</a>`
          : `<span style="font-weight: 600; color: var(--text-main);">${escapeHtml(row.display_name)}</span>`;
        const levelChip = row.level
          ? `<span class="badge badge-neutral" style="margin-left: 8px;">${escapeHtml(row.level)}</span>`
          : '';
        return `
          <tr>
            <td><span class="num" style="font-weight: 700;">#${escapeHtml(row.rank)}</span></td>
            <td>${nameHtml}${levelChip}</td>
            <td class="num" style="text-align: right; font-weight: 700;">${escapeHtml(row.formatted_points)}</td>
            <td class="num" style="text-align: right;">${escapeHtml(row.formatted_score)}</td>
            <td class="num" style="text-align: right; color: var(--text-muted);">${escapeHtml(row.formatted_time)}</td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load weekly test leaderboard:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="color: var(--color-danger); text-align: center; padding: var(--space-4);">
          Failed to load leaderboard: ${escapeHtml(err.message || 'Unknown error')}
        </td>
      </tr>
    `;
  }
}

// ============================================================================
// ONLINE TEST RESULTS & RESET VIEW (ALL SECTION KINDS)
// ============================================================================

async function loadOnlineResultsForActiveTest(test) {
  const thead = document.getElementById('online-results-thead');
  const tbody = document.getElementById('online-results-tbody');
  if (!thead || !tbody) return;

  tbody.innerHTML = `
    <tr>
      <td colspan="4" class="loading-state" style="text-align: center; padding: var(--space-6);">
        Loading online test attempts and scores...
      </td>
    </tr>
  `;

  try {
    let sections = testSectionsByTestId.get(test.id) || [];
    let attempts = [];
    let scores = [];

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const hasCachedSections = testSectionsByTestId.has(test.id);
      const [secRes, attRes, scRes] = await Promise.all([
        hasCachedSections
          ? Promise.resolve({ data: testSectionsByTestId.get(test.id) || [], error: null })
          : supabase
              .from('weekly_test_sections')
              .select('id, test_id, position, kind, category_id, activity_key, seconds, flash_digits, flash_count, flash_speed_ms, flash_mode, question_count')
              .eq('test_id', test.id)
              .order('position', { ascending: true }),
        supabase
          .from('weekly_test_attempts')
          .select('id, test_id, student_id, section_id, category_id, session_id, status, tries_started, tries_correct, seconds_used, started_at, finished_at')
          .eq('test_id', test.id),
        supabase
          .from('weekly_test_scores')
          .select('id, test_id, student_id, section_id, category_id, correct, total, time_seconds, source')
          .eq('test_id', test.id),
      ]);

      if (secRes.error) throw secRes.error;
      if (attRes.error) throw attRes.error;
      if (scRes.error) throw scRes.error;

      sections = secRes.data || [];
      attempts = attRes.data || [];
      scores = scRes.data || [];
      testSectionsByTestId.set(test.id, sections);
    } else {
      sections = DemoDB.getWeeklyTestSections ? DemoDB.getWeeklyTestSections(test.id) : [];
      attempts = DemoDB.getWeeklyTestAttempts ? DemoDB.getWeeklyTestAttempts(test.id) : [];
      scores = DemoDB.getAllWeeklyTestScoresForTest
        ? DemoDB.getAllWeeklyTestScoresForTest(test.id)
        : [];
      testSectionsByTestId.set(test.id, sections);
    }

    activeOnlineAttempts = attempts;
    activeOnlineScores = scores;

    renderOnlineResultsTable(test, sections, attempts, scores);
  } catch (err) {
    console.error('Failed to load online test results:', err);
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="color: var(--color-danger); text-align: center; padding: var(--space-4);">
          Failed to load online test results: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

/**
 * Finds the attempt and score for a given student and section (matching by section_id first,
 * falling back to category_id for legacy rows).
 */
function findStudentSectionAttemptAndScore(studentId, sec, attempts, scores) {
  const att =
    attempts.find(
      (a) =>
        a.student_id === studentId &&
        ((a.section_id && sec.id && a.section_id === sec.id) ||
          (!a.section_id && sec.category_id && a.category_id === sec.category_id))
    ) || null;

  const sc =
    scores.find(
      (s) =>
        s.student_id === studentId &&
        ((s.section_id && sec.id && s.section_id === sec.id) ||
          (!s.section_id && sec.category_id && s.category_id === sec.category_id))
    ) || null;

  return { att, sc };
}

function renderOnlineResultsTable(test, sections, attempts, scores) {
  const thead = document.getElementById('online-results-thead');
  const tbody = document.getElementById('online-results-tbody');
  const badge = document.getElementById('completion-summary-badge');
  if (!thead || !tbody) return;

  const sortedSections = [...sections].sort(
    (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
  );

  // Build table header: Student | Level | Section 1 ... Section N (of ANY kind)
  thead.innerHTML = `
    <tr>
      <th style="min-width: 170px;">Student</th>
      <th style="width: 90px;">Level</th>
      ${sortedSections
        .map((sec, idx) => {
          const summaryLabel = sectionSummary(sec, categoriesById);
          return `
            <th style="min-width: 195px;">
              <div style="font-weight: 700; color: var(--text-main);">${idx + 1}. ${escapeHtml(summaryLabel)}</div>
            </th>
          `;
        })
        .join('')}
    </tr>
  `;

  const eligibleStudents = getEligibleStudentsForTest(test);

  if (badge) {
    const studentsWithSubmittedOrScore = new Set([
      ...attempts.filter((a) => a.status === 'submitted').map((a) => a.student_id),
      ...scores.map((s) => s.student_id),
    ]);
    const doneStudentsCount = eligibleStudents.filter((s) =>
      studentsWithSubmittedOrScore.has(s.id)
    ).length;
    badge.textContent = `${doneStudentsCount} of ${eligibleStudents.length} students participated`;
    badge.className = `status-chip ${
      doneStudentsCount > 0 ? 'chip-verified' : 'chip-unverified'
    }`;
  }

  const query = searchQuery.trim().toLowerCase();
  const filteredStudents = eligibleStudents.filter((s) => {
    if (selectedLevelFilter && s.level !== selectedLevelFilter) return false;
    if (query) {
      const matchName = (s.full_name || '').toLowerCase().includes(query);
      const matchCode = (s.student_code || '').toLowerCase().includes(query);
      return matchName || matchCode;
    }
    return true;
  });

  if (filteredStudents.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${2 + sortedSections.length}" style="text-align: center; padding: var(--space-8); color: var(--text-muted); font-size: var(--text-xs);">
          No active students match the test level or current search filter.
        </td>
      </tr>
    `;
    return;
  }

  let rowsHtml = '';
  filteredStudents.forEach((student) => {
    rowsHtml += `
      <tr data-student-id="${student.id}">
        <td>
          <div style="font-weight: 600; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(student.full_name)}
          </div>
          <div class="num" style="font-size: 11px; color: var(--text-muted);">
            ${escapeHtml(student.student_code)}
          </div>
        </td>
        <td>
          <span style="font-size: 11px; font-weight: 500; color: var(--text-main);">
            ${student.level ? escapeHtml(student.level) : '—'}
          </span>
        </td>
        ${sortedSections
          .map((sec) => {
            const { att, sc } = findStudentSectionAttemptAndScore(
              student.id,
              sec,
              attempts,
              scores
            );
            const secLabel = sectionSummary(sec, categoriesById);
            const kind = String(sec.kind || 'basics').toLowerCase();

            if (!att && !sc) {
              return `
                <td style="vertical-align: middle;">
                  <span class="status-chip chip-unverified" style="font-size: 11px;">Not started</span>
                </td>
              `;
            }

            if (att && att.status === 'started' && (kind === 'flash' || !sc)) {
              const triesNote =
                kind === 'flash'
                  ? `<div class="num" style="font-size: 11px; color: var(--text-muted);">tries ${Number(att.tries_started) || 0} of ${Number(sec.question_count) || 5}</div>`
                  : '';
              return `
                <td style="vertical-align: middle;">
                  <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start;">
                    <span class="status-chip chip-flagged" style="font-size: 11px;">Started, not finished</span>
                    ${triesNote}
                    <button
                      type="button"
                      class="btn btn-outline btn-sm btn-reset-online-attempt"
                      data-student-id="${student.id}"
                      data-student-name="${escapeHtml(student.full_name)}"
                      data-section-id="${escapeHtml(sec.id || '')}"
                      data-category-id="${escapeHtml(sec.category_id || '')}"
                      data-section-label="${escapeHtml(secLabel)}"
                      style="padding: 1px 8px; font-size: 11px; min-height: 24px;"
                    >
                      Reset
                    </button>
                  </div>
                </td>
              `;
            }

            const correct = sc ? Number(sc.correct) : Number(att?.tries_correct) || 0;
            const total = sc ? Number(sc.total) : Number(att?.tries_started) || 0;
            const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;
            const timeSec =
              sc && sc.time_seconds != null
                ? Number(sc.time_seconds)
                : att && att.seconds_used != null
                  ? Number(att.seconds_used)
                  : null;
            const timeLabel = timeSec != null ? formatSecondsToTime(timeSec) : '—';
            const fb = total > 0 ? getScoreFeedback(correct, total) : null;
            const flashTriesText =
              kind === 'flash'
                ? ` &middot; tries ${Number(att?.tries_started ?? total) || 0} of ${Number(sec.question_count) || total || 5}`
                : '';

            return `
              <td style="vertical-align: middle;">
                <div style="display: flex; flex-direction: column; gap: 3px; align-items: flex-start;">
                  <div style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span class="status-chip chip-verified" style="font-size: 10px; padding: 1px 6px;">Done</span>
                    <span class="num" style="font-weight: 700; font-size: var(--text-xs); color: ${fb ? fb.colorVar : 'var(--text-main)'};">
                      ${correct} of ${total}
                    </span>
                  </div>
                  <div class="num" style="font-size: 11px; color: var(--text-muted);">
                    ${accuracy}% &middot; ${escapeHtml(timeLabel)}${flashTriesText}
                    ${fb ? ` &middot; <span style="color: ${fb.colorVar}; font-weight: 600;">${escapeHtml(fb.wrongText)}</span>` : ''}
                  </div>
                  <button
                    type="button"
                    class="btn btn-outline btn-sm btn-reset-online-attempt"
                    data-student-id="${student.id}"
                    data-student-name="${escapeHtml(student.full_name)}"
                    data-section-id="${escapeHtml(sec.id || '')}"
                    data-category-id="${escapeHtml(sec.category_id || '')}"
                    data-section-label="${escapeHtml(secLabel)}"
                    style="padding: 1px 8px; font-size: 11px; min-height: 24px; margin-top: 2px;"
                  >
                    Reset
                  </button>
                </div>
              </td>
            `;
          })
          .join('')}
      </tr>
    `;
  });

  tbody.innerHTML = rowsHtml;

  tbody.querySelectorAll('.btn-reset-online-attempt').forEach((btn) => {
    btn.onclick = () => {
      pendingResetTarget = {
        testId: test.id,
        studentId: btn.getAttribute('data-student-id'),
        studentName: btn.getAttribute('data-student-name'),
        sectionId: btn.getAttribute('data-section-id') || null,
        categoryId: btn.getAttribute('data-category-id') || null,
        sectionLabel: btn.getAttribute('data-section-label') || 'Section',
      };
      const summaryEl = document.getElementById('reset-attempt-student-summary');
      if (summaryEl) {
        summaryEl.innerHTML = `Reset section <strong>${escapeHtml(
          pendingResetTarget.sectionLabel
        )}</strong> for <strong>${escapeHtml(pendingResetTarget.studentName)}</strong>?`;
      }
      openModal('reset-attempt-modal');
    };
  });
}

function setupResetAttemptHandlers() {
  const btnConfirm = document.getElementById('btn-confirm-reset-attempt');
  if (!btnConfirm) return;

  btnConfirm.onclick = async () => {
    if (!pendingResetTarget) return;
    const { testId, studentId, studentName, sectionId, categoryId, sectionLabel } =
      pendingResetTarget;
    btnConfirm.disabled = true;

    try {
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        let attQuery = supabase
          .from('weekly_test_attempts')
          .delete()
          .eq('test_id', testId)
          .eq('student_id', studentId);
        let scQuery = supabase
          .from('weekly_test_scores')
          .delete()
          .eq('test_id', testId)
          .eq('student_id', studentId);

        if (sectionId) {
          attQuery = attQuery.eq('section_id', sectionId);
          scQuery = scQuery.eq('section_id', sectionId);
        } else if (categoryId) {
          attQuery = attQuery.eq('category_id', categoryId);
          scQuery = scQuery.eq('category_id', categoryId);
        }

        const [delAtt, delScore] = await Promise.all([attQuery, scQuery]);
        if (delAtt.error) throw delAtt.error;
        if (delScore.error) throw delScore.error;
      } else if (DemoDB && DemoDB.resetWeeklyTestSectionAttempt) {
        DemoDB.resetWeeklyTestSectionAttempt(testId, studentId, categoryId, sectionId);
      }

      closeModal('reset-attempt-modal');
      showToast('success', `Reset ${sectionLabel} for ${studentName}.`);
      pendingResetTarget = null;

      await loadTests(testId);
    } catch (err) {
      console.error('Failed to reset attempt:', err);
      showToast('error', 'Failed to reset section attempt: ' + (err.message || 'Unknown error'));
    } finally {
      btnConfirm.disabled = false;
    }
  };
}

// ============================================================================
// SECTION-BASED & LEGACY CATEGORY SCORE ENTRY
// ============================================================================

/**
 * Renders the section tabs bar when a test has sections.
 */
function renderSectionTabsBar(test, sections, allScoresForTest) {
  const listEl = document.getElementById('section-tabs-list');
  const countEl = document.getElementById('section-tab-entered-count');
  if (!listEl) return;

  const eligible = getEligibleStudentsForTest(test);
  const eligibleIds = new Set(eligible.map((s) => s.id));

  const sortedSections = [...sections].sort(
    (a, b) => (Number(a.position) || 0) - (Number(b.position) || 0)
  );

  listEl.innerHTML = sortedSections
    .map((sec, idx) => {
      const isActive = sec.id === activeSectionId;
      const summary = sectionSummary(sec, categoriesById);
      const enteredForSec = allScoresForTest.filter(
        (sc) =>
          eligibleIds.has(sc.student_id) &&
          Number(sc.total) > 0 &&
          ((sc.section_id && sc.section_id === sec.id) ||
            (!sc.section_id && sec.category_id && sc.category_id === sec.category_id))
      ).length;

      return `
        <button
          type="button"
          role="tab"
          aria-selected="${isActive ? 'true' : 'false'}"
          class="segmented-btn ${isActive ? 'active' : ''}"
          data-section-tab-id="${escapeHtml(sec.id)}"
        >
          <span>${idx + 1}. ${escapeHtml(summary)}</span>
          <span class="num" style="margin-left: 6px; font-size: 11px; opacity: 0.85;">(${enteredForSec}/${eligible.length})</span>
        </button>
      `;
    })
    .join('');

  listEl.querySelectorAll('[data-section-tab-id]').forEach((btn) => {
    btn.onclick = async () => {
      const targetSecId = btn.getAttribute('data-section-tab-id');
      if (!targetSecId || targetSecId === activeSectionId) return;

      if (hasUnsavedChanges) {
        const confirmSwitch = confirm(
          'You have unsaved score changes in this section. Discard changes and switch section?'
        );
        if (!confirmSwitch) return;
      }

      activeSectionId = targetSecId;
      populateCurrentScoresMapFromLoaded();
      renderSectionTabsBar(test, sections, activeTestAllScores);
      renderScoresTable();
      updateCompletionBadge();
    };
  });

  if (countEl) {
    let activeEntered = 0;
    eligible.forEach((st) => {
      const s = currentScoresMap.get(st.id);
      if (s && s.total !== '' && s.total !== null && s.total !== undefined && Number(s.total) > 0) {
        activeEntered++;
      }
    });
    countEl.textContent = `${activeEntered} of ${eligible.length} students entered`;
    countEl.className = `status-chip ${
      activeEntered === eligible.length && eligible.length > 0 ? 'chip-verified' : 'chip-unverified'
    }`;
  }
}

function populateCurrentScoresMapFromLoaded() {
  currentScoresMap.clear();
  const activeTest = allTests.find((t) => t.id === activeTestId);
  const sections = activeTest ? testSectionsByTestId.get(activeTest.id) || [] : [];
  const hasSections = sections.length > 0;
  const activeSection = hasSections
    ? sections.find((s) => s.id === activeSectionId) || sections[0]
    : null;

  activeTestAllScores.forEach((sc) => {
    let match = false;
    if (hasSections && activeSection) {
      match =
        (sc.section_id && sc.section_id === activeSection.id) ||
        (!sc.section_id &&
          activeSection.category_id &&
          sc.category_id === activeSection.category_id);
    } else if (!hasSections && activeCategoryId) {
      match = sc.category_id === activeCategoryId;
    }

    if (match) {
      currentScoresMap.set(sc.student_id, {
        id: sc.id,
        correct: sc.correct,
        total: sc.total,
        time_seconds: sc.time_seconds,
        formatted_time: sc.time_seconds ? formatSecondsToTime(sc.time_seconds) : '',
        source: sc.source || 'teacher',
        is_saved: true,
      });
    }
  });

  hasUnsavedChanges = false;
  setUnsavedIndicator(false);
}

async function loadScoresForCurrentSelection() {
  if (!activeTestId) return;
  const activeTest = allTests.find((t) => t.id === activeTestId);
  if (!activeTest) return;

  const sections = testSectionsByTestId.get(activeTest.id) || [];
  const hasSections = sections.length > 0;
  if (!hasSections && !activeCategoryId) return;

  const tbody = document.getElementById('scores-roster-tbody');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="loading-state" style="text-align: center; padding: var(--space-6);">
          Loading student scores...
        </td>
      </tr>
    `;
  }

  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase
        .from('weekly_test_scores')
        .select('*')
        .eq('test_id', activeTestId);

      if (error) throw error;
      activeTestAllScores = data || [];
    } else {
      activeTestAllScores = DemoDB.getAllWeeklyTestScoresForTest
        ? DemoDB.getAllWeeklyTestScoresForTest(activeTestId)
        : DemoDB.getWeeklyTestScores(activeTestId, activeCategoryId);
    }

    populateCurrentScoresMapFromLoaded();

    if (hasSections) {
      renderSectionTabsBar(activeTest, sections, activeTestAllScores);
    }

    renderScoresTable();
    updateCompletionBadge();
  } catch (err) {
    console.error('Failed to load test scores:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="color: var(--color-danger); text-align: center; padding: var(--space-4);">
            Failed to load scores: ${escapeHtml(err.message)}
          </td>
        </tr>
      `;
    }
  }
}

function updateCompletionBadge() {
  const badge = document.getElementById('completion-summary-badge');
  const sectionCountEl = document.getElementById('section-tab-entered-count');

  const activeTest = allTests.find((t) => t.id === activeTestId);
  const eligible = getEligibleStudentsForTest(activeTest);

  let enteredCount = 0;
  eligible.forEach((st) => {
    const s = currentScoresMap.get(st.id);
    if (s && s.total !== '' && s.total !== null && s.total !== undefined && Number(s.total) > 0) {
      enteredCount++;
    }
  });

  const totalActive = eligible.length;
  const text = `${enteredCount} of ${totalActive} students entered`;
  const chipClass = `status-chip ${
    enteredCount === totalActive && totalActive > 0 ? 'chip-verified' : 'chip-unverified'
  }`;

  if (badge) {
    badge.textContent = text;
    badge.className = chipClass;
  }
  if (sectionCountEl) {
    sectionCountEl.textContent = text;
    sectionCountEl.className = chipClass;
  }
}

function renderScoresTable() {
  const tbody = document.getElementById('scores-roster-tbody');
  if (!tbody) return;

  const activeTest = allTests.find((t) => t.id === activeTestId);
  const eligible = getEligibleStudentsForTest(activeTest);

  const query = searchQuery.trim().toLowerCase();
  const filtered = eligible.filter((s) => {
    if (selectedLevelFilter && s.level !== selectedLevelFilter) return false;
    if (query) {
      const matchName = (s.full_name || '').toLowerCase().includes(query);
      const matchCode = (s.student_code || '').toLowerCase().includes(query);
      return matchName || matchCode;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: var(--space-8); color: var(--text-muted); font-size: var(--text-xs);">
          No active students match the current search / filter criteria.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';

  filtered.forEach((student, index) => {
    const score = currentScoresMap.get(student.id) || {
      correct: '',
      total: '',
      time_seconds: null,
      formatted_time: '',
      source: 'teacher',
      is_saved: false,
    };

    const hasData =
      score.total !== '' &&
      score.total !== null &&
      score.total !== undefined &&
      Number(score.total) > 0;
    const feedback = hasData ? getScoreFeedback(score.correct, score.total) : null;

    const statusBadge = hasData
      ? score.source === 'online'
        ? `<span class="status-chip chip-verified" title="Submitted online by student">✓ Online</span>`
        : `<span class="status-chip chip-corrected" title="Official score entered by teacher">✓ Entered by teacher</span>`
      : `<span class="status-chip chip-unverified">Not entered</span>`;

    const feedbackHtml = feedback
      ? `<span class="status-chip ${feedback.badgeClass}" style="color: ${feedback.colorVar}; background: ${feedback.bgVar}; font-size: 11px;">
           ${feedback.wrongText}
         </span>`
      : `<span style="color: var(--text-dim); font-size: 11px;">—</span>`;

    html += `
      <tr data-student-id="${student.id}" data-index="${index}">
        <td>
          <div style="font-weight: 600; color: var(--text-main); font-size: var(--text-sm);">
            ${escapeHtml(student.full_name)}
          </div>
          <div class="num" style="font-size: 11px; color: var(--text-muted);">
            ${escapeHtml(student.student_code)}
          </div>
        </td>

        <td>
          <span style="font-size: 11px; font-weight: 500; color: var(--text-main);">
            ${student.level ? escapeHtml(student.level) : '—'}
          </span>
        </td>

        <td>
          <input
            type="number"
            class="form-input score-input-correct"
            data-student-id="${student.id}"
            data-field="correct"
            data-index="${index}"
            min="0"
            value="${score.correct !== null && score.correct !== undefined ? score.correct : ''}"
            placeholder="0"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td>
          <input
            type="number"
            class="form-input score-input-total"
            data-student-id="${student.id}"
            data-field="total"
            data-index="${index}"
            min="1"
            value="${score.total !== null && score.total !== undefined ? score.total : ''}"
            placeholder="20"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td>
          <input
            type="text"
            class="form-input score-input-time"
            data-student-id="${student.id}"
            data-field="time"
            data-index="${index}"
            placeholder="1:30"
            value="${score.formatted_time || ''}"
            style="min-height: 34px; padding: 4px 8px; font-variant-numeric: tabular-nums;"
          />
        </td>

        <td style="text-align: center;" class="cell-score-feedback" data-student-id="${student.id}">
          ${feedbackHtml}
        </td>

        <td style="text-align: center;" class="cell-score-status" data-student-id="${student.id}">
          ${statusBadge}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;

  attachScoreInputHandlers();
}

function attachScoreInputHandlers() {
  const tbody = document.getElementById('scores-roster-tbody');
  if (!tbody) return;

  tbody.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const studentId = input.getAttribute('data-student-id');
      const row = tbody.querySelector(`tr[data-student-id="${studentId}"]`);
      if (!row) return;

      const correctInput = row.querySelector('.score-input-correct');
      const totalInput = row.querySelector('.score-input-total');
      const timeInput = row.querySelector('.score-input-time');

      const cVal = correctInput.value.trim();
      const tVal = totalInput.value.trim();
      const timeVal = timeInput.value.trim();

      const prev = currentScoresMap.get(studentId);
      const secVal = timeVal ? parseTimeToSeconds(timeVal) : null;
      currentScoresMap.set(studentId, {
        correct: cVal !== '' ? Number(cVal) : '',
        total: tVal !== '' ? Number(tVal) : '',
        time_seconds: secVal,
        formatted_time: timeVal,
        source: 'teacher',
        is_saved: Boolean(prev?.is_saved),
      });

      const feedbackCell = row.querySelector('.cell-score-feedback');
      const statusCell = row.querySelector('.cell-score-status');

      if (tVal !== '' && Number(tVal) > 0 && cVal !== '') {
        const numC = Number(cVal);
        const numT = Number(tVal);
        const fb = getScoreFeedback(numC, numT);
        if (feedbackCell) {
          feedbackCell.innerHTML = `
            <span class="status-chip ${fb.badgeClass}" style="color: ${fb.colorVar}; background: ${fb.bgVar}; font-size: 11px;">
              ${fb.wrongText}
            </span>
          `;
        }
        if (statusCell) {
          statusCell.innerHTML = `<span class="status-chip chip-flagged">Unsaved</span>`;
        }
      } else if (cVal === '' && tVal === '') {
        if (feedbackCell)
          feedbackCell.innerHTML = `<span style="color: var(--text-dim); font-size: 11px;">—</span>`;
        if (statusCell)
          statusCell.innerHTML = `<span class="status-chip chip-unverified">Not entered</span>`;
      } else {
        if (feedbackCell) {
          feedbackCell.innerHTML = `<span class="status-chip chip-flagged" style="font-size: 10px;">Incomplete</span>`;
        }
      }

      markUnsaved();
      updateCompletionBadge();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const field = input.getAttribute('data-field');
        const currIdx = Number(input.getAttribute('data-index'));

        if (field === 'correct') {
          const totalInp = tbody.querySelector(`.score-input-total[data-index="${currIdx}"]`);
          if (totalInp) totalInp.focus();
        } else if (field === 'total') {
          const timeInp = tbody.querySelector(`.score-input-time[data-index="${currIdx}"]`);
          if (timeInp) timeInp.focus();
        } else if (field === 'time') {
          const nextIdx = currIdx + 1;
          const nextCorrect = tbody.querySelector(`.score-input-correct[data-index="${nextIdx}"]`);
          if (nextCorrect) {
            nextCorrect.focus();
          } else {
            const saveBtn = document.getElementById('btn-save-scores');
            if (saveBtn) saveBtn.focus();
          }
        }
      }
    });
  });

  const btnSave = document.getElementById('btn-save-scores');
  if (btnSave) {
    btnSave.onclick = saveScores;
  }
}

async function saveScores() {
  if (!activeTestId) {
    showToast('error', 'Please select a test first.');
    return;
  }

  const activeTest = allTests.find((t) => t.id === activeTestId);
  const sections = activeTest ? testSectionsByTestId.get(activeTest.id) || [] : [];
  const hasSections = sections.length > 0;
  const activeSection = hasSections
    ? sections.find((s) => s.id === activeSectionId) || sections[0]
    : null;

  if (hasSections && !activeSection) {
    showToast('error', 'Please select a test section first.');
    return;
  }
  if (!hasSections && !activeCategoryId) {
    showToast('error', 'Please select a category first.');
    return;
  }

  const btnSave = document.getElementById('btn-save-scores');
  btnSave.disabled = true;

  try {
    const scoresToUpsert = [];
    let hasValidationError = false;

    const eligible = getEligibleStudentsForTest(activeTest);
    const resolvedSectionId = hasSections ? activeSection.id : null;
    const resolvedCategoryId = hasSections
      ? activeSection.kind === 'basics' || activeSection.kind === 'round'
        ? activeSection.category_id || null
        : null
      : activeCategoryId;

    for (const student of eligible) {
      const s = currentScoresMap.get(student.id);
      if (!s) continue;

      const hasCorrect = s.correct !== '' && s.correct !== null && s.correct !== undefined;
      const hasTotal = s.total !== '' && s.total !== null && s.total !== undefined;

      if (!hasCorrect && !hasTotal) {
        continue;
      }

      if (!hasCorrect || !hasTotal) {
        showToast(
          'error',
          `Student ${student.full_name}: Please enter both Correct and Total, or leave both blank.`
        );
        hasValidationError = true;
        break;
      }

      const numC = Number(s.correct);
      const numT = Number(s.total);

      if (isNaN(numC) || isNaN(numT) || numT <= 0) {
        showToast('error', `Student ${student.full_name}: Total must be greater than 0.`);
        hasValidationError = true;
        break;
      }

      if (numC > numT) {
        showToast(
          'error',
          `Student ${student.full_name}: Correct (${numC}) cannot exceed Total (${numT}).`
        );
        hasValidationError = true;
        break;
      }

      if (numC < 0) {
        showToast('error', `Student ${student.full_name}: Correct cannot be negative.`);
        hasValidationError = true;
        break;
      }

      let timeSec = null;
      if (s.formatted_time && s.formatted_time.trim()) {
        timeSec = parseTimeToSeconds(s.formatted_time);
        if (timeSec === null || timeSec < 0) {
          showToast(
            'error',
            `Student ${student.full_name}: Time must be in mm:ss format (e.g. 1:30).`
          );
          hasValidationError = true;
          break;
        }
      }

      const rowPayload = {
        test_id: activeTestId,
        student_id: student.id,
        section_id: resolvedSectionId,
        category_id: resolvedCategoryId,
        correct: numC,
        total: numT,
        time_seconds: timeSec,
        source: 'teacher',
        entered_by: currentProfile.id,
      };

      scoresToUpsert.push(rowPayload);
    }

    if (hasValidationError) {
      btnSave.disabled = false;
      return;
    }

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();

      if (scoresToUpsert.length > 0) {
        const conflictTarget = resolvedSectionId
          ? 'test_id,student_id,section_id'
          : 'test_id,student_id,category_id';
        const { error: upsertErr } = await supabase
          .from('weekly_test_scores')
          .upsert(scoresToUpsert, {
            onConflict: conflictTarget,
          });

        if (upsertErr) throw upsertErr;
      }

      const clearedStudentIds = [];
      eligible.forEach((st) => {
        const s = currentScoresMap.get(st.id);
        const hasCorrect = s && s.correct !== '' && s.correct !== null && s.correct !== undefined;
        const hasTotal = s && s.total !== '' && s.total !== null && s.total !== undefined;
        if (!hasCorrect && !hasTotal && s && s.is_saved) {
          clearedStudentIds.push(st.id);
        }
      });

      if (clearedStudentIds.length > 0) {
        let delQuery = supabase
          .from('weekly_test_scores')
          .delete()
          .eq('test_id', activeTestId)
          .in('student_id', clearedStudentIds);
        if (resolvedSectionId) {
          delQuery = delQuery.eq('section_id', resolvedSectionId);
        } else {
          delQuery = delQuery.eq('category_id', resolvedCategoryId);
        }
        await delQuery;
      }
    } else {
      DemoDB.saveWeeklyTestScores(
        activeTestId,
        resolvedSectionId ? { section_id: resolvedSectionId, category_id: resolvedCategoryId } : resolvedCategoryId,
        eligible.map((st) => {
          const s = currentScoresMap.get(st.id);
          return {
            student_id: st.id,
            correct: s?.correct ?? '',
            total: s?.total ?? '',
            time_seconds: s?.time_seconds ?? null,
          };
        }),
        currentProfile.id
      );
    }

    showToast('success', 'Weekly test scores saved successfully.');
    hasUnsavedChanges = false;
    setUnsavedIndicator(false);

    await loadTests(activeTestId);
    await loadScoresForCurrentSelection();
  } catch (err) {
    console.error('Failed to save scores:', err);
    showToast('error', 'Failed to save weekly test scores: ' + friendlyDbErrorMessage(err));
  } finally {
    btnSave.disabled = false;
  }
}

/**
 * Sets up student search and level filtering for Offline, Online, and Leaderboard views
 */
function setupFilterHandlers() {
  const rerunActiveRender = () => {
    const activeTest = allTests.find((t) => t.id === activeTestId);
    if (!activeTest) return;
    if (activeDetailTab === 'leaderboard') {
      loadTestLeaderboardForActiveTest(activeTest);
      return;
    }
    if (activeTest.test_type === 'online' && !onlineEntryMode) {
      const secs = testSectionsByTestId.get(activeTest.id) || [];
      renderOnlineResultsTable(activeTest, secs, activeOnlineAttempts, activeOnlineScores);
    } else {
      renderScoresTable();
    }
  };

  const searchInput = document.getElementById('student-search-input');
  if (searchInput) {
    searchInput.oninput = () => {
      searchQuery = searchInput.value;
      rerunActiveRender();
    };
  }

  const levelSelect = document.getElementById('student-level-filter');
  if (levelSelect) {
    levelSelect.onchange = () => {
      selectedLevelFilter = levelSelect.value;
      rerunActiveRender();
    };
  }
}

// ============================================================================
// CREATE / EDIT WEEKLY TEST MODAL & MULTI-KIND SECTIONS BUILDER
// ============================================================================

function isoToIstDatetimeLocal(isoStr) {
  if (!isoStr) return '';
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return '';
  const istMs = dt.getTime() + 330 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 16);
}

function istDatetimeLocalToIso(localStr) {
  if (!localStr || !String(localStr).trim()) return null;
  const trimmed = String(localStr).trim();
  const withOffset = trimmed.length === 16 ? `${trimmed}:00+05:30` : `${trimmed}+05:30`;
  const dt = new Date(withOffset);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function getDefaultOnlineBasicsCategoryId(excludeIds = new Set()) {
  const basicsCats = allCategories.filter((c) => c.section === 'basics');
  const firstAvailable = basicsCats.find(
    (c) => isBasicsOnlineAvailable(c.name) && !excludeIds.has(c.id)
  );
  if (firstAvailable) return firstAvailable.id;
  const anySupported = basicsCats.find((c) => isBasicsOnlineAvailable(c.name));
  return anySupported ? anySupported.id : basicsCats[0]?.id || '';
}

function getDefaultRoundCategoryId() {
  const roundCats = allCategories.filter((c) => c.section === 'round');
  return roundCats[0]?.id || '';
}

function createDefaultSectionDraft(kind = 'basics', isOnline = false) {
  const usedBasics = new Set(
    modalSectionsDraft.filter((s) => s.kind === 'basics').map((s) => s.category_id)
  );
  const drills = getEnabledElementsDrills();

  switch (kind) {
    case 'flash':
      return {
        kind: 'flash',
        flash_digits: 1,
        flash_count: 20,
        flash_speed_seconds: '0.8',
        flash_speed_ms: 800,
        flash_mode: 'add',
        question_count: 5,
      };
    case 'elements':
      return {
        kind: 'elements',
        activity_key: drills[0]?.key || 'tables_2_digit',
      };
    case 'memoriad':
      return {
        kind: 'memoriad',
        activity_key: MEMORIAD_MODULES[0]?.key || 'calendar',
      };
    case 'round':
      return {
        kind: 'round',
        category_id: getDefaultRoundCategoryId(),
      };
    case 'basics':
    default:
      return {
        kind: 'basics',
        category_id: getDefaultOnlineBasicsCategoryId(usedBasics),
        seconds: isOnline ? 60 : 60,
      };
  }
}

function renderSectionsBuilder() {
  const listEl = document.getElementById('sections-builder-list');
  const addBtn = document.getElementById('btn-add-section-row');
  const titleEl = document.getElementById('sections-builder-title');
  const hintEl = document.getElementById('sections-builder-hint');
  if (!listEl) return;

  const isOnline = Boolean(document.getElementById('test-type-online')?.checked);
  const basicsCats = allCategories.filter((c) => c.section === 'basics');
  const roundCats = allCategories.filter((c) => c.section === 'round');
  const enabledDrills = getEnabledElementsDrills();

  if (titleEl) {
    titleEl.textContent = isOnline
      ? 'Online test sections (1 to 12 required)'
      : 'Test sections (0 to 12 optional)';
  }
  if (hintEl) {
    hintEl.textContent = isOnline
      ? 'Choose Basics, Flash Anzan, Elements, or Memoriad sections in order. Students can start Basics sections online now; Flash, Elements, and Memoriad show "Available soon".'
      : 'Define ordered sections of any kind (Basics, Flash Anzan, Elements, Memoriad, or Round scores) for structured trainer score entry, or leave empty to enter scores by category.';
  }

  if (addBtn) {
    addBtn.disabled = modalSectionsDraft.length >= 12;
  }

  if (modalSectionsDraft.length === 0) {
    listEl.innerHTML = `
      <div style="padding: var(--space-3); text-align: center; font-size: var(--text-xs); color: var(--text-muted); border: 1px dashed var(--border-subtle); border-radius: var(--radius-sm);">
        No sections added. ${
          isOnline
            ? 'Click <strong>+ Add section</strong> above to add 1 to 12 sections.'
            : 'Click <strong>+ Add section</strong> above to add structured sections, or save without sections for category-dropdown entry.'
        }
      </div>
    `;
    return;
  }

  let html = '';
  modalSectionsDraft.forEach((sec, idx) => {
    const isLocked = Boolean(sec.id && modalLockedSectionIds.has(sec.id));
    const kind = String(sec.kind || 'basics').toLowerCase();

    const kindOptionsHtml = SECTION_KINDS.map((k) => {
      const isRoundOnline = isOnline && k.key === 'round';
      const selected = k.key === kind ? 'selected' : '';
      const disabledAttr = isRoundOnline ? 'disabled' : '';
      const label = isRoundOnline
        ? `${k.label} (Round scores are available for offline tests only for now)`
        : k.label;
      return `<option value="${escapeHtml(k.key)}" ${selected} ${disabledAttr}>${escapeHtml(label)}</option>`;
    }).join('');

    let fieldsHtml = '';
    if (kind === 'basics') {
      const catOptionsHtml = basicsCats
        .map((c) => {
          const supported = isBasicsOnlineAvailable(c.name);
          const selected = c.id === sec.category_id ? 'selected' : '';
          const disabledAttr = isOnline && !supported ? 'disabled' : '';
          const suffix = isOnline && !supported ? ' (Not available online)' : '';
          return `<option value="${escapeHtml(c.id)}" ${selected} ${disabledAttr}>${escapeHtml(c.name)}${suffix}</option>`;
        })
        .join('');

      const noTimeOpt = !isOnline
        ? `<option value="" ${!sec.seconds ? 'selected' : ''}>No time limit</option>`
        : '';
      const durOptionsHtml =
        noTimeOpt +
        WEEKLY_TEST_DURATION_OPTIONS.map((opt) => {
          const selected = Number(sec.seconds) === opt.seconds ? 'selected' : '';
          return `<option value="${opt.seconds}" ${selected}>${escapeHtml(opt.label)}</option>`;
        }).join('');

      fieldsHtml = `
        <div style="display: grid; grid-template-columns: 1fr 140px; gap: var(--space-2); flex: 1;">
          <select class="form-select sec-basics-cat" data-index="${idx}" style="min-height: 34px; font-size: var(--text-xs);" ${isLocked ? 'disabled' : ''}>
            <option value="">Select Basics category...</option>
            ${catOptionsHtml}
          </select>
          <select class="form-select sec-basics-sec" data-index="${idx}" style="min-height: 34px; font-size: var(--text-xs);" ${isLocked ? 'disabled' : ''}>
            ${durOptionsHtml}
          </select>
        </div>
      `;
    } else if (kind === 'round') {
      const roundOptionsHtml = roundCats
        .map((c) => {
          const selected = c.id === sec.category_id ? 'selected' : '';
          return `<option value="${escapeHtml(c.id)}" ${selected}>${escapeHtml(c.name)}</option>`;
        })
        .join('');

      fieldsHtml = `
        <div style="flex: 1;">
          <select class="form-select sec-round-cat" data-index="${idx}" style="min-height: 34px; font-size: var(--text-xs);" ${isLocked ? 'disabled' : ''}>
            <option value="">Select Round category...</option>
            ${roundOptionsHtml}
          </select>
        </div>
      `;
    } else if (kind === 'elements') {
      const drillOptsHtml = enabledDrills
        .map((d) => {
          const selected = d.key === sec.activity_key ? 'selected' : '';
          return `<option value="${escapeHtml(d.key)}" ${selected}>${escapeHtml(d.code)} &mdash; ${escapeHtml(d.label)}</option>`;
        })
        .join('');

      fieldsHtml = `
        <div style="flex: 1;">
          <select class="form-select sec-elements-key" data-index="${idx}" style="min-height: 34px; font-size: var(--text-xs);" ${isLocked ? 'disabled' : ''}>
            <option value="">Select Elements drill...</option>
            ${drillOptsHtml}
          </select>
        </div>
      `;
    } else if (kind === 'memoriad') {
      const modOptsHtml = MEMORIAD_MODULES.map((m) => {
        const selected = m.key === sec.activity_key ? 'selected' : '';
        return `<option value="${escapeHtml(m.key)}" ${selected}>${escapeHtml(m.label)}</option>`;
      }).join('');

      fieldsHtml = `
        <div style="flex: 1;">
          <select class="form-select sec-memoriad-key" data-index="${idx}" style="min-height: 34px; font-size: var(--text-xs);" ${isLocked ? 'disabled' : ''}>
            <option value="">Select Memoriad module...</option>
            ${modOptsHtml}
          </select>
        </div>
      `;
    } else if (kind === 'flash') {
      const digitsVal = Number(sec.flash_digits) || 1;
      const countVal = Number(sec.flash_count) || 20;
      const speedSecVal =
        sec.flash_speed_seconds !== undefined && sec.flash_speed_seconds !== null
          ? sec.flash_speed_seconds
          : speedMsToSecondsText(sec.flash_speed_ms || 800);
      const modeVal = sec.flash_mode === 'add_sub' ? 'add_sub' : 'add';
      const triesVal = Number(sec.question_count) || 5;

      const modeOptsHtml = FLASH_MODES.map((m) => {
        const selected = m.key === modeVal ? 'selected' : '';
        return `<option value="${escapeHtml(m.key)}" ${selected}>${escapeHtml(m.label)}</option>`;
      }).join('');

      fieldsHtml = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 6px; flex: 1;">
          <div>
            <label style="font-size: 10px; color: var(--text-muted); display: block;">Digits (1–5)</label>
            <input type="number" class="form-input num sec-flash-digits" data-index="${idx}" min="1" max="5" step="1" value="${digitsVal}" style="min-height: 32px; font-size: var(--text-xs); padding: 2px 6px;" ${isLocked ? 'disabled' : ''} />
          </div>
          <div>
            <label style="font-size: 10px; color: var(--text-muted); display: block;">Numbers (2–1000)</label>
            <input type="number" class="form-input num sec-flash-count" data-index="${idx}" min="2" max="1000" step="1" value="${countVal}" style="min-height: 32px; font-size: var(--text-xs); padding: 2px 6px;" ${isLocked ? 'disabled' : ''} />
          </div>
          <div>
            <label style="font-size: 10px; color: var(--text-muted); display: block;">Speed s (0.2–5.0)</label>
            <input type="number" class="form-input num sec-flash-speed" data-index="${idx}" min="0.2" max="5.0" step="0.1" value="${escapeHtml(speedSecVal)}" style="min-height: 32px; font-size: var(--text-xs); padding: 2px 6px;" ${isLocked ? 'disabled' : ''} />
          </div>
          <div>
            <label style="font-size: 10px; color: var(--text-muted); display: block;">Mode</label>
            <select class="form-select sec-flash-mode" data-index="${idx}" style="min-height: 32px; font-size: var(--text-xs); padding: 2px 6px;" ${isLocked ? 'disabled' : ''}>
              ${modeOptsHtml}
            </select>
          </div>
          <div>
            <label style="font-size: 10px; color: var(--text-muted); display: block;">Tries (1–10)</label>
            <input type="number" class="form-input num sec-flash-tries" data-index="${idx}" min="1" max="10" step="1" value="${triesVal}" style="min-height: 32px; font-size: var(--text-xs); padding: 2px 6px;" ${isLocked ? 'disabled' : ''} />
          </div>
        </div>
      `;
    }

    const minAllowed = isOnline ? 1 : 0;
    const canRemove = !isLocked && modalSectionsDraft.length > minAllowed;

    html += `
      <div class="section-builder-row" data-index="${idx}" style="display: flex; flex-direction: column; gap: 6px; background: var(--bg-surface); padding: var(--space-2) var(--space-3); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap;">
          <div style="display: inline-flex; align-items: center; gap: 8px;">
            <span class="num" style="font-size: var(--text-xs); font-weight: 700; color: var(--text-muted);">
              #${idx + 1}
            </span>
            <select class="form-select sec-kind-select" data-index="${idx}" style="min-height: 32px; font-size: var(--text-xs); width: auto; min-width: 150px;" ${isLocked ? 'disabled' : ''}>
              ${kindOptionsHtml}
            </select>
            ${
              isLocked
                ? `<span class="status-chip chip-flagged" style="font-size: 10px;">Locked (has scores/attempts)</span>`
                : ''
            }
          </div>

          <div style="display: inline-flex; gap: 4px;">
            <button type="button" class="btn btn-outline btn-sm btn-sec-up" data-index="${idx}" title="Move up" style="padding: 2px 6px; min-height: 28px; font-size: 11px;" ${idx === 0 ? 'disabled' : ''}>
              &uarr;
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-sec-down" data-index="${idx}" title="Move down" style="padding: 2px 6px; min-height: 28px; font-size: 11px;" ${idx === modalSectionsDraft.length - 1 ? 'disabled' : ''}>
              &darr;
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-sec-remove" data-index="${idx}" title="Remove section" style="padding: 2px 8px; min-height: 28px; font-size: 11px; color: #DC2626;" ${!canRemove ? 'disabled' : ''}>
              Remove
            </button>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2);">
          ${fieldsHtml}
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  // Bind kind switcher
  listEl.querySelectorAll('.sec-kind-select').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      const existing = modalSectionsDraft[i];
      if (!existing || (existing.id && modalLockedSectionIds.has(existing.id))) return;
      const nextDraft = createDefaultSectionDraft(sel.value, isOnline);
      if (existing.id) nextDraft.id = existing.id;
      modalSectionsDraft[i] = nextDraft;
      renderSectionsBuilder();
      updateTestLiveSummary();
    };
  });

  // Bind Basics inputs
  listEl.querySelectorAll('.sec-basics-cat').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].category_id = sel.value;
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.sec-basics-sec').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].seconds = sel.value === '' ? null : Number(sel.value);
        updateTestLiveSummary();
      }
    };
  });

  // Bind Round inputs
  listEl.querySelectorAll('.sec-round-cat').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].category_id = sel.value;
        updateTestLiveSummary();
      }
    };
  });

  // Bind Elements inputs
  listEl.querySelectorAll('.sec-elements-key').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].activity_key = sel.value;
        updateTestLiveSummary();
      }
    };
  });

  // Bind Memoriad inputs
  listEl.querySelectorAll('.sec-memoriad-key').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].activity_key = sel.value;
        updateTestLiveSummary();
      }
    };
  });

  // Bind Flash inputs
  listEl.querySelectorAll('.sec-flash-digits').forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].flash_digits = inp.value;
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.sec-flash-count').forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].flash_count = inp.value;
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.sec-flash-speed').forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].flash_speed_seconds = inp.value;
        modalSectionsDraft[i].flash_speed_ms = undefined;
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.sec-flash-mode').forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].flash_mode = sel.value;
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.sec-flash-tries').forEach((inp) => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-index'));
      if (modalSectionsDraft[i]) {
        modalSectionsDraft[i].question_count = inp.value;
        updateTestLiveSummary();
      }
    };
  });

  // Reorder & remove buttons
  listEl.querySelectorAll('.btn-sec-up').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-index'));
      if (i > 0) {
        const tmp = modalSectionsDraft[i - 1];
        modalSectionsDraft[i - 1] = modalSectionsDraft[i];
        modalSectionsDraft[i] = tmp;
        renderSectionsBuilder();
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.btn-sec-down').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-index'));
      if (i < modalSectionsDraft.length - 1) {
        const tmp = modalSectionsDraft[i + 1];
        modalSectionsDraft[i + 1] = modalSectionsDraft[i];
        modalSectionsDraft[i] = tmp;
        renderSectionsBuilder();
        updateTestLiveSummary();
      }
    };
  });

  listEl.querySelectorAll('.btn-sec-remove').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-index'));
      const sec = modalSectionsDraft[i];
      if (!sec || (sec.id && modalLockedSectionIds.has(sec.id))) return;
      const minAllowed = isOnline ? 1 : 0;
      if (modalSectionsDraft.length > minAllowed) {
        modalSectionsDraft.splice(i, 1);
        renderSectionsBuilder();
        updateTestLiveSummary();
      }
    };
  });
}

function updateOnlineFieldsVisibility() {
  const onlineRadio = document.getElementById('test-type-online');
  const windowContainer = document.getElementById('online-window-fields-container');
  const noticeEl = document.getElementById('sections-builder-notice');

  const isOnline = Boolean(onlineRadio && onlineRadio.checked);
  if (windowContainer) windowContainer.style.display = isOnline ? 'block' : 'none';

  if (isOnline) {
    // Remove any unlocked 'round' sections when switching from Offline to Online
    const hadRound = modalSectionsDraft.some((s) => String(s.kind).toLowerCase() === 'round');
    if (hadRound) {
      modalSectionsDraft = modalSectionsDraft.filter(
        (s) => String(s.kind).toLowerCase() !== 'round' || (s.id && modalLockedSectionIds.has(s.id))
      );
      if (noticeEl) {
        noticeEl.textContent =
          'Round scores are available for offline tests only for now — Round sections were removed for this online test.';
        noticeEl.style.display = 'block';
      }
    }
    // Ensure Basics sections have a valid duration when switching to Online
    modalSectionsDraft.forEach((s) => {
      if (String(s.kind || 'basics').toLowerCase() === 'basics' && !s.seconds) {
        s.seconds = 60;
      }
    });
    if (modalSectionsDraft.length === 0) {
      modalSectionsDraft.push(createDefaultSectionDraft('basics', true));
    }
  } else if (noticeEl) {
    noticeEl.style.display = 'none';
  }

  renderSectionsBuilder();
  updateTestLiveSummary();
}

function updateTestLiveSummary() {
  const summaryEl = document.getElementById('test-live-summary');
  if (!summaryEl) return;

  const isOnline = Boolean(document.getElementById('test-type-online')?.checked);
  const titleVal = document.getElementById('test-title-input')?.value || '';
  const dateVal = document.getElementById('test-date-input')?.value || '';
  const levelVal = document.getElementById('test-level-input')?.value || '';

  summaryEl.textContent = buildModalLiveSummary('weeklyTest', {
    title: titleVal,
    test_type: isOnline ? 'online' : 'offline',
    test_date: dateVal,
    audience_level: levelVal,
    sections_count: modalSectionsDraft.length,
  });
}

let submitAndAddAnotherTest = false;

/**
 * Saves sections in-place for an existing test without deleting all and re-inserting:
 * - Deletes removed unlocked sections by id
 * - Updates existing sections in place by id (handling position changes safely)
 * - Inserts newly added sections
 */
async function saveTestSectionsInPlace(supabase, testId, normalizedRows) {
  const draftIds = new Set(normalizedRows.filter((r) => r.id).map((r) => r.id));
  const idsToDelete = modalExistingSections
    .filter((oldSec) => oldSec.id && !draftIds.has(oldSec.id) && !modalLockedSectionIds.has(oldSec.id))
    .map((oldSec) => oldSec.id);

  if (idsToDelete.length > 0) {
    const { error: delErr } = await supabase
      .from('weekly_test_sections')
      .delete()
      .in('id', idsToDelete);
    if (delErr) throw delErr;
  }

  const existingToUpdate = normalizedRows.filter((r) => r.id);
  const newToInsert = normalizedRows.filter((r) => !r.id);

  // Offset positions first if any existing row's position changed to avoid unique (test_id, position) collision
  const oldPosMap = new Map(modalExistingSections.map((s) => [s.id, Number(s.position)]));
  const needsPositionShift = existingToUpdate.some(
    (r) => oldPosMap.get(r.id) !== Number(r.position)
  );

  if (needsPositionShift) {
    for (let i = 0; i < existingToUpdate.length; i++) {
      const row = existingToUpdate[i];
      const { error: shiftErr } = await supabase
        .from('weekly_test_sections')
        .update({ position: 1000 + i + 1 })
        .eq('id', row.id);
      if (shiftErr) throw shiftErr;
    }
  }

  for (const row of existingToUpdate) {
    const isLocked = modalLockedSectionIds.has(row.id);
    const updatePayload = isLocked
      ? { position: row.position }
      : {
          position: row.position,
          kind: row.kind,
          category_id: row.category_id,
          activity_key: row.activity_key,
          seconds: row.seconds,
          flash_digits: row.flash_digits,
          flash_count: row.flash_count,
          flash_speed_ms: row.flash_speed_ms,
          flash_mode: row.flash_mode,
          question_count: row.question_count,
        };

    const { error: updErr } = await supabase
      .from('weekly_test_sections')
      .update(updatePayload)
      .eq('id', row.id);
    if (updErr) throw updErr;
  }

  if (newToInsert.length > 0) {
    const insertRows = newToInsert.map((r) => {
      const copy = { ...r, test_id: testId };
      delete copy.id;
      return copy;
    });
    const { error: insErr } = await supabase
      .from('weekly_test_sections')
      .insert(insertRows);
    if (insErr) throw insErr;
  }
}

function setupTestModalHandlers() {
  const btnCreate = document.getElementById('btn-create-test');
  if (btnCreate) {
    btnCreate.onclick = () => openTestModal(null);
  }

  const offlineRadio = document.getElementById('test-type-offline');
  const onlineRadio = document.getElementById('test-type-online');
  if (offlineRadio) offlineRadio.onchange = updateOnlineFieldsVisibility;
  if (onlineRadio) onlineRadio.onchange = updateOnlineFieldsVisibility;

  const dateInput = document.getElementById('test-date-input');
  const remindInput = document.getElementById('test-remind-days-input');
  const titleInput = document.getElementById('test-title-input');
  const levelInput = document.getElementById('test-level-input');

  if (dateInput) {
    dateInput.addEventListener('input', () => {
      updateReminderPreviewText();
      updateTestLiveSummary();
    });
  }
  if (remindInput) remindInput.addEventListener('input', updateReminderPreviewText);
  if (titleInput) titleInput.addEventListener('input', updateTestLiveSummary);
  if (levelInput) levelInput.addEventListener('input', updateTestLiveSummary);

  const btnAddSec = document.getElementById('btn-add-section-row');
  if (btnAddSec) {
    btnAddSec.onclick = () => {
      if (modalSectionsDraft.length >= 12) return;
      const isOnline = Boolean(document.getElementById('test-type-online')?.checked);
      modalSectionsDraft.push(createDefaultSectionDraft('basics', isOnline));
      renderSectionsBuilder();
      updateTestLiveSummary();
    };
  }

  const btnSaveAddAnother = document.getElementById('btn-save-add-another-test');
  const form = document.getElementById('test-form');
  if (btnSaveAddAnother && form) {
    btnSaveAddAnother.addEventListener('click', () => {
      submitAndAddAnotherTest = true;
      form.requestSubmit();
    });
  }

  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btnSubmit = document.getElementById('btn-submit-test');
      const errBanner = document.getElementById('test-error-banner');
      if (errBanner) errBanner.style.display = 'none';

      const idVal = document.getElementById('test-id-input').value.trim();
      const dateVal = document.getElementById('test-date-input').value.trim();
      const titleVal = document.getElementById('test-title-input').value.trim();
      const notesVal = document.getElementById('test-notes-input').value.trim();
      const levelVal = document.getElementById('test-level-input').value.trim();
      const remindRaw = document.getElementById('test-remind-days-input').value.trim();
      const isOnline = Boolean(document.getElementById('test-type-online')?.checked);
      const testType = isOnline ? 'online' : 'offline';

      const opensLocal = document.getElementById('test-opens-at-input')?.value || '';
      const closesLocal = document.getElementById('test-closes-at-input')?.value || '';

      if (!dateVal) {
        showModalError('Please enter a Test Date.');
        return;
      }

      if (!titleVal || titleVal.length < 1 || titleVal.length > 80) {
        showModalError('Test Title must be between 1 and 80 characters.');
        return;
      }

      const remindDays = remindRaw === '' ? 7 : Number(remindRaw);
      if (!Number.isInteger(remindDays) || remindDays < 0 || remindDays > 30) {
        showModalError('Reminder days must be a whole number from 0 to 30.');
        return;
      }

      let opensAtIso = null;
      let closesAtIso = null;

      if (isOnline) {
        opensAtIso = istDatetimeLocalToIso(opensLocal);
        closesAtIso = istDatetimeLocalToIso(closesLocal);

        if (opensLocal && !opensAtIso) {
          showModalError('Invalid "Opens at" date/time.');
          return;
        }
        if (closesLocal && !closesAtIso) {
          showModalError('Invalid "Closes at" date/time.');
          return;
        }
        if (opensAtIso && closesAtIso && new Date(closesAtIso) <= new Date(opensAtIso)) {
          showModalError('"Closes at" must be after "Opens at".');
          return;
        }
      }

      // Validate sections via pure helper validateSections(sections, testType, categories)
      const secValidation = validateSections(modalSectionsDraft, testType, allCategories);
      if (!secValidation.ok) {
        showModalError(secValidation.error);
        return;
      }

      const normalizedSectionRows = toRows(modalSectionsDraft, allCategories);

      btnSubmit.disabled = true;
      let newlyCreatedTestId = null;

      try {
        let savedTestId = null;
        const testPayload = {
          test_date: dateVal,
          title: titleVal,
          notes: notesVal || null,
          test_type: testType,
          audience_level: levelVal || null,
          opens_at: isOnline ? opensAtIso : null,
          closes_at: isOnline ? closesAtIso : null,
          remind_days_before: remindDays,
        };

        if (idVal) {
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { error } = await supabase
              .from('weekly_tests')
              .update(testPayload)
              .eq('id', idVal);

            if (error) throw error;

            await saveTestSectionsInPlace(supabase, idVal, normalizedSectionRows);
          } else {
            DemoDB.updateWeeklyTest(idVal, testPayload);
            if (DemoDB.saveWeeklyTestSections) {
              DemoDB.saveWeeklyTestSections(idVal, normalizedSectionRows);
            }
          }
          savedTestId = idVal;
          showToast('success', 'Weekly test details updated.');
        } else {
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { data, error } = await supabase
              .from('weekly_tests')
              .insert(testPayload)
              .select('id')
              .single();

            if (error) throw error;
            newlyCreatedTestId = data.id;
            savedTestId = data.id;

            if (normalizedSectionRows.length > 0) {
              const sectionRows = normalizedSectionRows.map((r) => {
                const copy = { ...r, test_id: savedTestId };
                delete copy.id;
                return copy;
              });
              const { error: secErr } = await supabase
                .from('weekly_test_sections')
                .insert(sectionRows);

              if (secErr) {
                await supabase.from('weekly_tests').delete().eq('id', newlyCreatedTestId);
                newlyCreatedTestId = null;
                throw secErr;
              }
            }
          } else {
            const created = DemoDB.createWeeklyTest(testPayload);
            newlyCreatedTestId = created.id;
            savedTestId = created.id;
            if (normalizedSectionRows.length > 0 && DemoDB.saveWeeklyTestSections) {
              DemoDB.saveWeeklyTestSections(savedTestId, normalizedSectionRows);
            }
          }
          showToast('success', 'New weekly test created.');
        }

        const addAnother = submitAndAddAnotherTest && !idVal;
        submitAndAddAnotherTest = false;
        await loadTests(savedTestId);
        if (addAnother) {
          await openTestModal(null);
        } else {
          closeModal('test-modal');
        }
      } catch (err) {
        submitAndAddAnotherTest = false;
        console.error('Failed to save test:', err);
        showModalError(friendlyDbErrorMessage(err));
      } finally {
        btnSubmit.disabled = false;
      }
    };
  }
}

function friendlyDbErrorMessage(err) {
  const raw = String(err?.message || err || 'Failed to save test.');
  const lower = raw.toLowerCase();
  if (lower.includes('round') && lower.includes('online')) {
    return 'Round scores are available for offline tests only for now.';
  }
  if (lower.includes('basics') && lower.includes('category')) {
    return 'Basics sections must use an active Basics category.';
  }
  if (lower.includes('round') && lower.includes('category')) {
    return 'Round sections must use an active Round category.';
  }
  if (lower.includes('seconds') && lower.includes('basics')) {
    return 'Online Basics sections require a duration of 30, 60, 120, or 300 seconds.';
  }
  return raw;
}

async function openTestModal(test = null) {
  const modalTitle = document.getElementById('test-modal-title');
  const idInput = document.getElementById('test-id-input');
  const dateInput = document.getElementById('test-date-input');
  const titleInput = document.getElementById('test-title-input');
  const notesInput = document.getElementById('test-notes-input');
  const levelInput = document.getElementById('test-level-input');
  const remindInput = document.getElementById('test-remind-days-input');
  const offlineRadio = document.getElementById('test-type-offline');
  const onlineRadio = document.getElementById('test-type-online');
  const opensInput = document.getElementById('test-opens-at-input');
  const closesInput = document.getElementById('test-closes-at-input');
  const lockedBanner = document.getElementById('test-attempts-locked-banner');
  const errBanner = document.getElementById('test-error-banner');
  const noticeEl = document.getElementById('sections-builder-notice');

  if (errBanner) errBanner.style.display = 'none';
  if (lockedBanner) lockedBanner.style.display = 'none';
  if (noticeEl) noticeEl.style.display = 'none';
  modalLockedSectionIds = new Set();
  modalHasAnyScoresOrAttempts = false;
  modalExistingSections = [];

  if (test) {
    if (modalTitle) modalTitle.textContent = 'Edit Weekly Test';
    if (idInput) idInput.value = test.id;
    if (dateInput) dateInput.value = test.test_date;
    if (titleInput) titleInput.value = test.title;
    if (notesInput) notesInput.value = test.notes || '';
    if (levelInput) levelInput.value = test.audience_level || '';
    if (remindInput)
      remindInput.value =
        test.remind_days_before !== undefined && test.remind_days_before !== null
          ? test.remind_days_before
          : 7;

    const isOnline = test.test_type === 'online';
    if (offlineRadio) offlineRadio.checked = !isOnline;
    if (onlineRadio) onlineRadio.checked = isOnline;

    if (opensInput) opensInput.value = isOnline ? isoToIstDatetimeLocal(test.opens_at) : '';
    if (closesInput) closesInput.value = isOnline ? isoToIstDatetimeLocal(test.closes_at) : '';

    const existingSections = testSectionsByTestId.get(test.id) || [];
    modalExistingSections = existingSections.map((s) => ({ ...s }));
    modalSectionsDraft = existingSections.map((s) => ({
      id: s.id,
      kind: s.kind || 'basics',
      category_id: s.category_id || null,
      activity_key: s.activity_key || null,
      seconds: s.seconds ?? null,
      flash_digits: s.flash_digits ?? 1,
      flash_count: s.flash_count ?? 20,
      flash_speed_ms: s.flash_speed_ms ?? 800,
      flash_speed_seconds: speedMsToSecondsText(s.flash_speed_ms ?? 800),
      flash_mode: s.flash_mode || 'add',
      question_count: s.question_count ?? 5,
    }));

    // Detect which sections already have scores or attempts
    try {
      let attRows = [];
      let scRows = [];
      if (isSupabaseConfigured()) {
        const supabase = await getSupabase();
        const [attRes, scRes] = await Promise.all([
          supabase
            .from('weekly_test_attempts')
            .select('section_id, category_id')
            .eq('test_id', test.id),
          supabase
            .from('weekly_test_scores')
            .select('section_id, category_id')
            .eq('test_id', test.id),
        ]);
        attRows = attRes.data || [];
        scRows = scRes.data || [];
      } else if (DemoDB) {
        attRows = DemoDB.getWeeklyTestAttempts ? DemoDB.getWeeklyTestAttempts(test.id) : [];
        scRows = DemoDB.getAllWeeklyTestScoresForTest
          ? DemoDB.getAllWeeklyTestScoresForTest(test.id)
          : [];
      }

      modalHasAnyScoresOrAttempts = attRows.length > 0 || scRows.length > 0;
      existingSections.forEach((sec) => {
        const hasAtt = attRows.some(
          (a) =>
            (a.section_id && a.section_id === sec.id) ||
            (!a.section_id && sec.category_id && a.category_id === sec.category_id)
        );
        const hasSc = scRows.some(
          (s) =>
            (s.section_id && s.section_id === sec.id) ||
            (!s.section_id && sec.category_id && s.category_id === sec.category_id)
        );
        if (hasAtt || hasSc) {
          modalLockedSectionIds.add(sec.id);
        }
      });
    } catch {
      modalLockedSectionIds = new Set();
    }

    if (modalLockedSectionIds.size > 0 && lockedBanner) {
      lockedBanner.style.display = 'block';
    }

    if (offlineRadio) offlineRadio.disabled = modalHasAnyScoresOrAttempts;
    if (onlineRadio) onlineRadio.disabled = modalHasAnyScoresOrAttempts;

    const btnSaveAnother = document.getElementById('btn-save-add-another-test');
    if (btnSaveAnother) btnSaveAnother.style.display = 'none';

    const moreDetails = document.getElementById('test-more-options');
    const hasCustomRemind =
      test.remind_days_before !== undefined &&
      test.remind_days_before !== null &&
      Number(test.remind_days_before) !== 7;
    setMoreOptionsOpen(
      moreDetails,
      shouldOpenMoreOptions(
        [
          test.audience_level,
          test.notes,
          test.opens_at,
          test.closes_at,
          hasCustomRemind ? String(test.remind_days_before) : '',
        ],
        true
      )
    );
  } else {
    if (modalTitle) modalTitle.textContent = 'Create Weekly Test';
    if (idInput) idInput.value = '';
    if (dateInput) dateInput.value = getISTDateString(new Date());
    if (titleInput) titleInput.value = '';
    if (notesInput) notesInput.value = '';
    if (levelInput) levelInput.value = '';
    if (remindInput) remindInput.value = '7';
    if (offlineRadio) {
      offlineRadio.checked = true;
      offlineRadio.disabled = false;
    }
    if (onlineRadio) {
      onlineRadio.checked = false;
      onlineRadio.disabled = false;
    }
    if (opensInput) opensInput.value = '';
    if (closesInput) closesInput.value = '';
    modalSectionsDraft = [createDefaultSectionDraft('basics', false)];

    const btnSaveAnother = document.getElementById('btn-save-add-another-test');
    if (btnSaveAnother) btnSaveAnother.style.display = 'inline-flex';

    const moreDetails = document.getElementById('test-more-options');
    setMoreOptionsOpen(moreDetails, false);
  }

  updateOnlineFieldsVisibility();
  updateReminderPreviewText();
  renderSectionsBuilder();
  updateTestLiveSummary();
  openModal('test-modal');
}

function updateReminderPreviewText() {
  const previewEl = document.getElementById('test-remind-preview-text');
  if (!previewEl) return;
  const dateVal = document.getElementById('test-date-input')?.value || '';
  const remindVal = document.getElementById('test-remind-days-input')?.value ?? '7';
  previewEl.textContent = formatReminderStartPreview(dateVal, remindVal);
}

function showModalError(msg) {
  const banner = document.getElementById('test-error-banner');
  if (banner) {
    banner.textContent = msg;
    banner.style.display = 'block';
  } else {
    showToast('error', msg);
  }
}

// ============================================================================
// REMOVE WEEKLY TEST & RECENTLY REMOVED DRAWER (30-DAY SNAPSHOT)
// ============================================================================

async function openRemoveTestModal(test) {
  if (!test) return;

  const titleLabel = document.getElementById('remove-test-title-label');
  const countsSummary = document.getElementById('remove-test-counts-summary');
  const reasonInput = document.getElementById('remove-test-reason-input');
  const checkbox = document.getElementById('remove-test-confirm-checkbox');
  const confirmBtn = document.getElementById('btn-confirm-remove-test');
  const errBanner = document.getElementById('remove-test-error-banner');

  if (titleLabel) titleLabel.textContent = test.title;
  if (reasonInput) reasonInput.value = '';
  if (checkbox) checkbox.checked = false;
  if (confirmBtn) confirmBtn.disabled = true;
  if (errBanner) errBanner.style.display = 'none';
  if (countsSummary) countsSummary.textContent = 'Checking saved scores and attempts...';

  openModal('remove-test-modal');

  try {
    let scoresCount = Number(test.scores_count) || 0;
    let attemptsCount = 0;

    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const [scRes, attRes] = await Promise.all([
        supabase
          .from('weekly_test_scores')
          .select('id', { count: 'exact', head: true })
          .eq('test_id', test.id),
        supabase
          .from('weekly_test_attempts')
          .select('id', { count: 'exact', head: true })
          .eq('test_id', test.id),
      ]);
      scoresCount = Number(scRes.count) || 0;
      attemptsCount = Number(attRes.count) || 0;
    } else if (DemoDB) {
      scoresCount = Number(test.scores_count) || 0;
      attemptsCount = DemoDB.getWeeklyTestAttempts
        ? DemoDB.getWeeklyTestAttempts(test.id).length
        : 0;
    }

    if (countsSummary) {
      countsSummary.textContent = `${scoresCount} saved ${
        scoresCount === 1 ? 'score' : 'scores'
      } and ${attemptsCount} ${
        attemptsCount === 1 ? 'attempt' : 'attempts'
      } will be removed.`;
    }
  } catch {
    if (countsSummary) {
      countsSummary.textContent = `${test.scores_count || 0} saved scores will be removed.`;
    }
  }
}

function setupRemoveTestHandlers() {
  const checkbox = document.getElementById('remove-test-confirm-checkbox');
  const confirmBtn = document.getElementById('btn-confirm-remove-test');
  const form = document.getElementById('remove-test-form');

  if (checkbox && confirmBtn) {
    checkbox.onchange = () => {
      confirmBtn.disabled = !checkbox.checked;
    };
  }

  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!activeTestId) return;
      if (checkbox && !checkbox.checked) return;

      const reasonInput = document.getElementById('remove-test-reason-input');
      const errBanner = document.getElementById('remove-test-error-banner');
      const reason = reasonInput ? reasonInput.value.trim() : '';

      if (errBanner) errBanner.style.display = 'none';
      if (confirmBtn) confirmBtn.disabled = true;

      try {
        if (isSupabaseConfigured()) {
          const supabase = await getSupabase();
          const { error } = await supabase.rpc('admin_remove_weekly_test', {
            p_test: activeTestId,
            p_reason: reason || null,
          });
          if (error) throw error;
        } else if (DemoDB && DemoDB.mockAdminRemoveWeeklyTest) {
          DemoDB.mockAdminRemoveWeeklyTest(
            activeTestId,
            reason || null,
            currentProfile?.id || 'usr-admin-1'
          );
        }

        const removedTitle =
          allTests.find((t) => t.id === activeTestId)?.title || 'Weekly test';
        activeTestId = null;
        hasUnsavedChanges = false;
        setUnsavedIndicator(false);

        closeModal('remove-test-modal');
        showToast('success', `"${removedTitle}" removed. You can restore it for 30 days.`);

        await Promise.all([loadTests(), loadRecentlyRemovedCount()]);
      } catch (err) {
        console.error('Failed to remove test:', err);
        if (errBanner) {
          errBanner.textContent = err.message || 'Failed to remove test.';
          errBanner.style.display = 'block';
        }
      } finally {
        if (confirmBtn) confirmBtn.disabled = !(checkbox && checkbox.checked);
      }
    };
  }
}

async function fetchRecentRemovals() {
  const cutoffIso = new Date(Date.now() - 30 * 86400000).toISOString();
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from('weekly_test_removals')
      .select('id, removed_by, removed_at, reason, title, test_date, scores_count, restored_at')
      .is('restored_at', null)
      .gte('removed_at', cutoffIso)
      .order('removed_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  if (DemoDB && DemoDB.getWeeklyTestRemovals) {
    return DemoDB.getWeeklyTestRemovals();
  }
  return [];
}

async function loadRecentlyRemovedCount() {
  const badge = document.getElementById('removed-count-badge');
  if (!badge) return;
  try {
    const list = await fetchRecentRemovals();
    if (list.length > 0) {
      badge.textContent = String(list.length);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  } catch {
    badge.style.display = 'none';
  }
}

function setupRecentlyRemovedHandlers() {
  const btn = document.getElementById('btn-recently-removed');
  if (!btn) return;

  btn.onclick = async () => {
    openModal('recently-removed-modal');
    await renderRecentlyRemovedList();
  };
}

async function renderRecentlyRemovedList() {
  const container = document.getElementById('recently-removed-list-container');
  if (!container) return;

  container.innerHTML = `
    <div class="loading-state" style="text-align: center; padding: var(--space-6);">
      Loading removed tests...
    </div>
  `;

  try {
    const removals = await fetchRecentRemovals();

    if (removals.length === 0) {
      container.innerHTML = `
        <div style="padding: var(--space-6); text-align: center; color: var(--text-muted); font-size: var(--text-xs);">
          No removed weekly tests in the last 30 days.
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        ${removals
          .map((item) => {
            const testDateLabel = item.test_date
              ? formatDisplayDateIST(item.test_date)
              : '—';
            const removedWhen = item.removed_at
              ? new Date(item.removed_at).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  day: 'numeric',
                  month: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : '—';
            const removedByName =
              adminProfilesMap.get(item.removed_by) || item.removed_by || 'Admin';
            const scCount = Number(item.scores_count) || 0;

            return `
              <div style="display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-surface);">
                <div>
                  <div style="font-weight: 700; font-size: var(--text-sm); color: var(--text-main);">
                    ${escapeHtml(item.title)}
                    <span class="num" style="font-weight: 500; font-size: var(--text-xs); color: var(--text-muted); margin-left: 6px;">
                      (${escapeHtml(testDateLabel)})
                    </span>
                  </div>
                  <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
                    Removed ${escapeHtml(removedWhen)} by ${escapeHtml(removedByName)} &middot;
                    <strong class="num">${scCount}</strong> ${scCount === 1 ? 'score' : 'scores'}
                  </div>
                  ${
                    item.reason
                      ? `<div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">Reason: <em>${escapeHtml(item.reason)}</em></div>`
                      : ''
                  }
                </div>
                <button
                  type="button"
                  class="btn btn-primary btn-sm btn-restore-removed-test"
                  data-removal-id="${escapeHtml(item.id)}"
                  data-removal-title="${escapeHtml(item.title)}"
                >
                  Restore
                </button>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    container.querySelectorAll('.btn-restore-removed-test').forEach((restoreBtn) => {
      restoreBtn.onclick = async () => {
        const removalId = restoreBtn.getAttribute('data-removal-id');
        const removalTitle = restoreBtn.getAttribute('data-removal-title');
        restoreBtn.disabled = true;

        try {
          let restoredTestId = null;
          if (isSupabaseConfigured()) {
            const supabase = await getSupabase();
            const { data, error } = await supabase.rpc('admin_restore_weekly_test', {
              p_removal: removalId,
            });
            if (error) throw error;
            restoredTestId = typeof data === 'string' ? data : data?.id || null;
          } else if (DemoDB && DemoDB.mockAdminRestoreWeeklyTest) {
            const restored = DemoDB.mockAdminRestoreWeeklyTest(removalId);
            restoredTestId = restored?.id || null;
          }

          showToast('success', `Restored "${removalTitle}".`);
          await Promise.all([
            loadTests(restoredTestId),
            loadRecentlyRemovedCount(),
            renderRecentlyRemovedList(),
          ]);
        } catch (err) {
          console.error('Failed to restore test:', err);
          showToast('error', 'Failed to restore test: ' + (err.message || 'Unknown error'));
          restoreBtn.disabled = false;
        }
      };
    });
  } catch (err) {
    console.error('Failed to load recently removed tests:', err);
    container.innerHTML = `
      <div style="padding: var(--space-4); color: var(--color-danger); font-size: var(--text-xs);">
        Failed to load removed tests: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

/**
 * Unsaved changes warning guard (browser navigation + beforeunload)
 */
function setupUnsavedChangesGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue =
        'You have unsaved weekly test score changes. Are you sure you want to leave?';
      return e.returnValue;
    }
  });

  document.querySelectorAll('a').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      if (hasUnsavedChanges) {
        const proceed = confirm(
          'You have unsaved weekly test score changes. Are you sure you want to navigate away?'
        );
        if (!proceed) {
          e.preventDefault();
        }
      }
    });
  });
}

function markUnsaved() {
  hasUnsavedChanges = true;
  setUnsavedIndicator(true);
}

function setUnsavedIndicator(visible) {
  const ind = document.getElementById('unsaved-warning-indicator');
  if (ind) ind.style.display = visible ? 'inline' : 'none';
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');

  if (nameEl) nameEl.textContent = profile.full_name || 'Admin';
  if (roleEl) roleEl.textContent = profile.student_code || 'ADMIN';
  if (container) container.style.display = 'flex';
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-warning" style="margin-bottom: var(--space-6);" role="alert">
      <strong>Demo Mode Active:</strong> You are exploring with mock data on localhost/preview. Supabase credentials are not configured.
    </div>
  `;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', initWeeklyTestsPage);
