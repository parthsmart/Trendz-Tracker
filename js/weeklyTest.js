/**
 * Trendz Tracker - Student Weekly Test Controller (js/weeklyTest.js)
 *
 * Phase 13a + Phase 16a:
 * - Top tabs: "My Tests" and "Leaderboard"
 * - Calls `my_weekly_tests()` (or DemoDB.mockMyWeeklyTests in Demo Mode).
 * - Groups tests via `groupTests(tests)` into "Available now", "Upcoming", and "Past".
 * - Online test cards show title, date, opening/closing window (India time; "All day (India time)" when empty),
 *   notes, and section cards in position order with kind label, sectionSummary, and status chip:
 *   - Online Basics sections show "Start" when open and unattempted (`isSectionStartable`).
 *   - Online Flash, Elements, and Memoriad sections show a disabled button "Available soon" (`isSectionComingSoon`).
 * - Offline test cards show date, "With your trainer", their sections as information, and per-section scores
 *   once entered ("Entered by teacher", shared score colour, "n wrong").
 * - Past tests show per-section scores with the shared score colour (js/scoreColors.js).
 * - Closed online tests show "Practise": a no-stakes retake (same sections, time limits and scoring)
 *   stored apart from official results, with "Where you would have stood" on the official board
 *   (labelled "Practice — not official"). See js/weeklyTestPracticeView.js and migration 38.
 * - Leaderboard tab:
 *   - Test selector: "All tests" (with period selector: This week, This month [default], This year, All time,
 *     Pick a date reusing js/periods.js) plus one entry per test whose `leaderboard_ready` is true.
 *   - Scope switch ("<your level> (your level only)" / "All levels (your centre)", hidden when global_leaderboard_enabled() is false).
 *   - Columns: Rank, Student (with level chip in global scope), Points, Correct of attempted, Time.
 *   - Highlights the student's own row and shows their own rank below the top 10.
 *   - Text under the table: "Points = correct answers minus wrong answers in each section (never below 0). Online tests appear after they close."
 */

import { requireAuth } from './guard.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { isDemoMode } from './demoDb.js';
import { showToast } from './toast.js';
import { getScoreFeedback, getWeeklyTestScoreFeedback } from './scoreColors.js';
import { formatSectionDuration } from './basicsSupport.js';
import {
  sectionStatusLabel,
  isSectionStartable,
  isSectionResumable,
  isSectionComingSoon,
  nextSection,
  windowText,
  groupTests,
  sectionKindLabel,
  sectionSummary,
} from './weeklyTestView.js';
import {
  START_SECTION_CONFIRM_TEXT,
  runnerLink,
} from './weeklyTestRunner.js';
import {
  PRACTICE_LABEL,
  PRACTICE_EXPLANATION,
  canOfferPractice,
  practiceSectionRows,
  standingHeadline,
} from './weeklyTestPracticeView.js';
import {
  WEEKLY_TEST_BOARD_EXPLANATION,
  boardTitle,
  mapWeeklyTestLeaderboardRows,
} from './weeklyTestBoard.js';
import {
  fetchWeeklyTestLeaderboard,
  fetchGlobalLeaderboardEnabled,
} from './leaderboardData.js';
import { scopeLabel } from './leaderboardView.js';
import {
  MIN_LEADERBOARD_DATE,
  getISTDateYMD,
  periodValue,
  validatePeriodDate,
} from './periods.js';
import { createDrillPlayer, computeRemainingSeconds } from './drillPlayer.js';
import { formatDisplayDateIST, formatSecondsToTime } from './stats.js';
import { openModal, closeModal, setupModalListeners } from './modal.js';

const WT_SCOPE_STORAGE_KEY = 'trendz_wt_leaderboard_scope_v1';

let currentProfile = null;
let myTests = [];
let activeTab = 'my_tests'; // 'my_tests' | 'leaderboard'

// Weekly Test Leaderboard tab state
let todayIST = getISTDateYMD();
let wtSelectedTestId = 'all'; // 'all' or a test.id
let wtPeriodChoice = 'month'; // 'week' | 'month' | 'year' | 'all' | 'date'
let wtPeriod = 'month';
let wtCustomDate = '';
let wtScope = 'level'; // 'level' | 'global'
let wtGlobalEnabled = true;

// Active running section state
let pendingStartRequest = null; // { testId, testTitle, sectionId, categoryId, categoryName, seconds }
let activeTestId = null;
let activeTestTitle = '';
let activeSectionId = null;
let activeCategoryId = null;
let activeCategoryName = '';
let activeSessionId = null;
let activeSeconds = 60;
let activeExpiresAtMs = 0;
let activePlayer = null;
let roundTimerId = null;
let countdownEndMs = 0;
let sectionRunning = false;
let roundEnded = false;
let isSubmitting = false;
let pendingSubmissionAnswers = null;

function readStoredWtScope() {
  try {
    const val = localStorage.getItem(WT_SCOPE_STORAGE_KEY);
    if (val === 'global' || val === 'level') return val;
  } catch {
    // Ignore storage errors
  }
  return 'level';
}

function writeStoredWtScope(scope) {
  try {
    localStorage.setItem(WT_SCOPE_STORAGE_KEY, scope === 'global' ? 'global' : 'level');
  } catch {
    // Ignore storage errors
  }
}

async function getAccessToken() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

function formatSecondsToMMSS(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

async function initStudentWeeklyTestPage() {
  currentProfile = await requireAuth(['student']);
  if (!currentProfile) return;

  todayIST = getISTDateYMD();
  wtCustomDate = todayIST;
  wtScope = readStoredWtScope();

  renderHeaderUser(currentProfile);
  setupModalListeners();

  if (isDemoMode()) {
    renderDemoBanner();
  }

  setupBeforeUnloadGuard();
  setupTopTabsAndLeaderboardControls();
  setupStartModalHandlers();
  setupPlayerHandlers();
  setupResultsHandlers();
  setupPracticeHandlers();

  const [, globalFlag] = await Promise.all([
    loadMyWeeklyTests(),
    fetchGlobalLeaderboardEnabled().catch(() => false),
  ]);

  wtGlobalEnabled = Boolean(globalFlag);
  if (!wtGlobalEnabled && wtScope === 'global') {
    wtScope = 'level';
    writeStoredWtScope('level');
  }
  syncWtScopeUI();
  await handleWeeklyTestUrlParams();

  const practiceTestParam = new URLSearchParams(window.location.search).get('practice_test');
  if (practiceTestParam && myTests.some((t) => String(t.id) === practiceTestParam)) {
    openPracticeModal(practiceTestParam);
  }
}

function setupBeforeUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (sectionRunning) {
      e.preventDefault();
      e.returnValue =
        'You are currently taking a weekly test section. If you leave the page, this section is lost.';
      return e.returnValue;
    }
  });
}

function showErrorBanner(msg) {
  const banner = document.getElementById('weekly-test-error-banner');
  if (!banner) return;
  if (!msg) {
    banner.style.display = 'none';
    banner.textContent = '';
  } else {
    banner.textContent = msg;
    banner.style.display = 'block';
  }
}

function showScreen(screenId) {
  ['screen-list', 'screen-player', 'screen-results'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = id === screenId ? 'block' : 'none';
    }
  });
}

function switchTopTab(tabKey, targetTestId = null) {
  activeTab = tabKey === 'leaderboard' ? 'leaderboard' : 'my_tests';

  document.querySelectorAll('[data-wt-tab]').forEach((btn) => {
    const isActive = btn.getAttribute('data-wt-tab') === activeTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const myTestsPanel = document.getElementById('wt-panel-my-tests');
  const lbPanel = document.getElementById('wt-panel-leaderboard');
  if (myTestsPanel) myTestsPanel.style.display = activeTab === 'my_tests' ? 'block' : 'none';
  if (lbPanel) lbPanel.style.display = activeTab === 'leaderboard' ? 'block' : 'none';

  if (activeTab === 'leaderboard') {
    if (targetTestId) {
      wtSelectedTestId = targetTestId;
    }
    populateWtBoardTestSelect();
    syncWtBoardControlsUI();
    loadStudentWeeklyTestLeaderboard();
  }
}

function setupTopTabsAndLeaderboardControls() {
  document.querySelectorAll('[data-wt-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-wt-tab');
      if (!targetTab || targetTab === activeTab) return;
      switchTopTab(targetTab);
    });
  });

  const testSelect = document.getElementById('wt-board-test-select');
  if (testSelect) {
    testSelect.addEventListener('change', () => {
      wtSelectedTestId = testSelect.value || 'all';
      syncWtBoardControlsUI();
      loadStudentWeeklyTestLeaderboard();
    });
  }

  document.querySelectorAll('[data-wt-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = btn.getAttribute('data-wt-scope');
      if (!s || s === wtScope) return;
      if (s === 'global' && !wtGlobalEnabled) return;
      wtScope = s === 'global' ? 'global' : 'level';
      writeStoredWtScope(wtScope);
      syncWtScopeUI();
      loadStudentWeeklyTestLeaderboard();
    });
  });

  const dateInput = document.getElementById('input-wt-board-date');
  const dateError = document.getElementById('wt-board-date-error');

  document.querySelectorAll('[data-wt-period-choice]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const choice = btn.getAttribute('data-wt-period-choice');
      if (!choice) return;

      if (dateError) {
        dateError.style.display = 'none';
        dateError.textContent = '';
      }

      if (choice === 'date') {
        wtPeriodChoice = 'date';
        const candidateDate = dateInput?.value || wtCustomDate || todayIST;
        const check = validatePeriodDate(candidateDate, todayIST);
        const validDate = check.valid ? check.dateText : todayIST;
        wtCustomDate = validDate;
        if (dateInput) dateInput.value = validDate;
        const resolved = periodValue('date', validDate, todayIST);
        if (resolved) wtPeriod = resolved;
        syncWtBoardControlsUI();
        loadStudentWeeklyTestLeaderboard();
        return;
      }

      const resolved = periodValue(choice, '', todayIST);
      if (!resolved) return;
      if (choice === wtPeriodChoice && resolved === wtPeriod) return;
      wtPeriodChoice = choice;
      wtPeriod = resolved;
      syncWtBoardControlsUI();
      loadStudentWeeklyTestLeaderboard();
    });
  });

  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const check = validatePeriodDate(dateInput.value, todayIST);
      if (!check.valid) {
        if (dateError) {
          dateError.textContent = check.error || 'Enter a valid date.';
          dateError.style.display = 'inline-block';
        }
        return;
      }
      if (dateError) {
        dateError.textContent = '';
        dateError.style.display = 'none';
      }
      wtCustomDate = check.dateText;
      wtPeriodChoice = 'date';
      const resolved = periodValue('date', check.dateText, todayIST);
      if (resolved) {
        wtPeriod = resolved;
        syncWtBoardControlsUI();
        loadStudentWeeklyTestLeaderboard();
      }
    });
  }
}

function populateWtBoardTestSelect() {
  const selectEl = document.getElementById('wt-board-test-select');
  if (!selectEl) return;

  const readyTests = myTests.filter((t) => Boolean(t.leaderboard_ready));
  if (wtSelectedTestId !== 'all' && !readyTests.some((t) => String(t.id) === String(wtSelectedTestId))) {
    wtSelectedTestId = 'all';
  }

  const optionsHtml =
    `<option value="all" ${wtSelectedTestId === 'all' ? 'selected' : ''}>All tests</option>` +
    readyTests
      .map((t) => {
        const isSel = String(t.id) === String(wtSelectedTestId);
        const dateStr = formatDisplayDateIST(t.test_date);
        return `<option value="${escapeHtml(t.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(t.title)} (${escapeHtml(dateStr)})</option>`;
      })
      .join('');

  selectEl.innerHTML = optionsHtml;
}

function syncWtScopeUI() {
  const btnLevel = document.getElementById('btn-wt-scope-level');
  const btnGlobal = document.getElementById('btn-wt-scope-global');
  const scopeContainer = document.getElementById('wt-board-scope-controls');

  if (btnLevel) {
    btnLevel.textContent = scopeLabel(currentProfile?.level, 'level');
    const isLevel = wtScope === 'level';
    btnLevel.classList.toggle('active', isLevel);
    btnLevel.setAttribute('aria-pressed', isLevel ? 'true' : 'false');
  }
  if (btnGlobal) {
    btnGlobal.textContent = scopeLabel(currentProfile?.level, 'global');
    btnGlobal.style.display = wtGlobalEnabled ? '' : 'none';
    const isGlobal = wtScope === 'global' && wtGlobalEnabled;
    btnGlobal.classList.toggle('active', isGlobal);
    btnGlobal.setAttribute('aria-pressed', isGlobal ? 'true' : 'false');
  }
  if (scopeContainer) {
    scopeContainer.style.display = wtGlobalEnabled ? 'inline-flex' : 'none';
  }
}

function syncWtBoardControlsUI() {
  const periodWrapper = document.getElementById('wt-board-period-wrapper');
  const isAllTests = !wtSelectedTestId || wtSelectedTestId === 'all';
  if (periodWrapper) {
    periodWrapper.style.display = isAllTests ? 'flex' : 'none';
  }

  document.querySelectorAll('[data-wt-period-choice]').forEach((btn) => {
    const choice = btn.getAttribute('data-wt-period-choice');
    const active = choice === wtPeriodChoice;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const dateBox = document.getElementById('wt-board-date-picker-box');
  const dateInput = document.getElementById('input-wt-board-date');
  if (dateInput) {
    dateInput.setAttribute('min', MIN_LEADERBOARD_DATE);
    dateInput.setAttribute('max', todayIST);
    if (wtCustomDate && dateInput.value !== wtCustomDate) {
      dateInput.value = wtCustomDate;
    }
  }
  if (dateBox) {
    dateBox.style.display = isAllTests && wtPeriodChoice === 'date' ? 'inline-flex' : 'none';
  }

  syncWtScopeUI();

  const selectedTestObj =
    !isAllTests ? myTests.find((t) => String(t.id) === String(wtSelectedTestId)) : null;
  const titleEl = document.getElementById('wt-board-card-title');
  const badgeEl = document.getElementById('wt-board-scope-badge');
  const footerEl = document.getElementById('wt-board-footer');

  if (titleEl) {
    titleEl.textContent = boardTitle(
      selectedTestObj ? selectedTestObj.title : null,
      wtPeriod,
      wtScope,
      currentProfile?.level,
      todayIST
    );
  }
  if (badgeEl) {
    badgeEl.textContent = scopeLabel(currentProfile?.level, wtScope);
  }
  if (footerEl) {
    footerEl.textContent = WEEKLY_TEST_BOARD_EXPLANATION;
  }
}

async function loadStudentWeeklyTestLeaderboard() {
  const tbody = document.getElementById('wt-board-tbody');
  const tableEl = document.getElementById('wt-board-table');
  const emptyEl = document.getElementById('wt-board-empty');
  const emptyTitleEl = document.getElementById('wt-board-empty-title');
  const emptyDescEl = document.getElementById('wt-board-empty-desc');

  if (!tbody) return;

  if (emptyEl) emptyEl.style.display = 'none';
  if (tableEl) tableEl.style.display = 'table';
  tbody.innerHTML = `
    <tr>
      <td colspan="5" class="loading-state" style="text-align: center; padding: var(--space-6);">
        Loading weekly test leaderboard...
      </td>
    </tr>
  `;

  try {
    const isAllTests = !wtSelectedTestId || wtSelectedTestId === 'all';
    const rawRows = await fetchWeeklyTestLeaderboard(
      {
        testId: isAllTests ? null : wtSelectedTestId,
        period: isAllTests ? wtPeriod : 'all',
        level: null,
        limit: 10,
        scope: wtScope,
      },
      currentProfile
    );

    const mapped = mapWeeklyTestLeaderboardRows(rawRows, {
      scope: wtScope,
      isAdmin: false,
    });

    if (mapped.length === 0) {
      tbody.innerHTML = '';
      if (tableEl) tableEl.style.display = 'none';
      if (emptyTitleEl) emptyTitleEl.textContent = 'No weekly test rankings yet';
      if (emptyDescEl) emptyDescEl.textContent = WEEKLY_TEST_BOARD_EXPLANATION;
      if (emptyEl) emptyEl.style.display = 'flex';
      return;
    }

    const htmlRows = [];
    mapped.forEach((row) => {
      const isMe = row.is_me;
      if (row.is_outside_top_10) {
        htmlRows.push(`
          <tr class="section-divider-row" aria-label="Your rank outside top 10">
            <th colspan="5" style="text-align: center; font-size: var(--text-sm); color: var(--text-muted);">
              &bull; &bull; &bull; Your Rank &bull; &bull; &bull;
            </th>
          </tr>
        `);
      }

      const rowStyle = isMe
        ? 'background-color: var(--color-primary-subtle); font-weight: 700;'
        : '';
      const levelChip =
        row.show_level_chip && row.level
          ? `<span class="badge badge-neutral" style="margin-left: 8px;">${escapeHtml(row.level)}</span>`
          : '';
      const youBadge = isMe
        ? `<span class="badge badge-neutral" style="margin-left: 8px;">You</span>`
        : '';

      htmlRows.push(`
        <tr style="${rowStyle}" data-is-me="${isMe ? 'true' : 'false'}">
          <td><span class="num" style="font-weight: 700;">#${escapeHtml(row.rank)}</span></td>
          <td>
            <div style="display: inline-flex; align-items: center; flex-wrap: wrap;">
              <span style="font-weight: ${isMe ? '700' : '600'}; color: var(--text-main);">${escapeHtml(row.display_name)}</span>
              ${levelChip}
              ${youBadge}
            </div>
          </td>
          <td class="num" style="text-align: right; font-weight: 700; color: ${isMe ? 'var(--color-primary)' : 'var(--text-main)'};">
            ${escapeHtml(row.formatted_points)}
          </td>
          <td class="num" style="text-align: right; color: var(--text-main);">
            ${escapeHtml(row.formatted_score)}
          </td>
          <td class="num" style="text-align: right; color: var(--text-muted);">
            ${escapeHtml(row.formatted_time)}
          </td>
        </tr>
      `);
    });

    tbody.innerHTML = htmlRows.join('');
  } catch (err) {
    const errMsg = err?.message || 'Unable to load weekly test leaderboard.';
    if (wtScope === 'global' && errMsg.toLowerCase().includes('switched off')) {
      showToast('info', 'The global leaderboard is switched off.');
      wtGlobalEnabled = false;
      wtScope = 'level';
      writeStoredWtScope('level');
      syncWtScopeUI();
      await loadStudentWeeklyTestLeaderboard();
      return;
    }

    tbody.innerHTML = '';
    if (tableEl) tableEl.style.display = 'none';
    if (emptyTitleEl) emptyTitleEl.textContent = 'Leaderboard unavailable';
    if (emptyDescEl) emptyDescEl.textContent = errMsg;
    if (emptyEl) emptyEl.style.display = 'flex';
  }
}

async function loadMyWeeklyTests() {
  const container = document.getElementById('weekly-tests-content');
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('my_weekly_tests');
      if (error) throw error;
      myTests = Array.isArray(data) ? data : [];
    } else if (isDemoMode() && DemoDB && DemoDB.mockMyWeeklyTests) {
      myTests = DemoDB.mockMyWeeklyTests(currentProfile.id);
    } else {
      myTests = [];
    }

    populateWtBoardTestSelect();
    renderWeeklyTestsGroups();
  } catch (err) {
    console.error('Failed to load my_weekly_tests:', err);
    if (container) {
      container.innerHTML = `
        <div class="card" style="padding: var(--space-6); color: var(--color-danger); text-align: center;">
          Could not load weekly tests: ${escapeHtml(err.message || 'Unknown error')}
        </div>
      `;
    }
  }
}

function renderWeeklyTestsGroups() {
  const container = document.getElementById('weekly-tests-content');
  if (!container) return;

  const { availableNow, upcoming, past } = groupTests(myTests);

  if (availableNow.length === 0 && upcoming.length === 0 && past.length === 0) {
    container.innerHTML = `
      <div class="card wt-empty">
        <div class="wt-empty-ic" aria-hidden="true">📝</div>
        <h2>No weekly tests yet</h2>
        <p>When your trainer schedules an online or offline weekly test for your level, it will appear here.</p>
      </div>
    `;
    return;
  }

  const countText = (n) => `${n} ${n === 1 ? 'test' : 'tests'}`;
  const group = (title, list, kind, extraHead = '') => `
    <section class="wt-group wt-group-${kind}" aria-label="${escapeHtml(title)}">
      <div class="wt-grp">
        ${kind === 'available' ? '<span class="wt-dot" aria-hidden="true"></span>' : ''}
        <h2>${escapeHtml(title)}</h2>
        <span class="wt-grp-count">${countText(list.length)}</span>
        ${extraHead}
      </div>
      <div class="wt-list">
        ${list.map((test) => renderTestCard(test, kind)).join('')}
      </div>
    </section>
  `;

  let html = '';
  if (availableNow.length > 0) html += group('Available now', availableNow, 'available');
  if (upcoming.length > 0) html += group('Upcoming', upcoming, 'upcoming');
  if (past.length > 0) {
    const accs = past.map((t) => testTotals(t)).filter((t) => t.total > 0).map((t) => (t.correct / t.total) * 100);
    const avg = accs.length ? `<span class="wt-grp-avg">Average ${Math.round(accs.reduce((a, b) => a + b, 0) / accs.length)}%</span>` : '';
    html += group('Past', past, 'past', avg);
  }

  container.innerHTML = html;

  // Bind "Start" and "Continue" buttons on startable/resumable online sections
  container.querySelectorAll('.btn-start-test-section').forEach((btn) => {
    btn.onclick = () => {
      const testId = btn.getAttribute('data-test-id');
      const testTitle = btn.getAttribute('data-test-title');
      const sectionId = btn.getAttribute('data-section-id') || null;
      const kind = btn.getAttribute('data-kind') || 'basics';
      const categoryId = btn.getAttribute('data-category-id') || '';
      const categoryName = btn.getAttribute('data-category-name') || '';
      const summaryText = btn.getAttribute('data-summary') || categoryName;
      const seconds = Number(btn.getAttribute('data-seconds')) || 60;
      const resume = btn.getAttribute('data-resume') === 'true';

      promptStartSection({
        testId,
        testTitle,
        sectionId,
        kind,
        categoryId,
        categoryName,
        summaryText,
        seconds,
        resume,
      });
    };
  });

  // Bind "Practise" buttons on closed online tests
  container.querySelectorAll('.btn-practise-test').forEach((btn) => {
    btn.onclick = () => openPracticeModal(btn.getAttribute('data-test-id'));
  });

  // Bind "View test leaderboard" buttons
  container.querySelectorAll('.btn-open-test-leaderboard').forEach((btn) => {
    btn.onclick = () => {
      const testId = btn.getAttribute('data-test-id');
      switchTopTab('leaderboard', testId);
    };
  });
}

/**
 * Calendar block (weekday + day) for a YYYY-MM-DD test date.
 */
function testCalendarHtml(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return '<div class="wt-cal" aria-hidden="true"><span>—</span><b>—</b></div>';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getUTCDay()];
  return `<div class="wt-cal" aria-hidden="true"><span>${wd}</span><b class="num">${Number(m[3])}</b></div>`;
}

/**
 * Sections in position order, plus the scored rows (sections with a score, or teacher score rows).
 */
function testSections(test) {
  return Array.isArray(test.sections)
    ? [...test.sections].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))
    : [];
}

function testTotals(test) {
  const isOnline = String(test.type || test.test_type || 'offline').toLowerCase() === 'online';
  const sections = testSections(test);
  let rows;
  if (sections.length > 0) {
    rows = sections.filter((sec) => (isOnline ? sec.attempt === 'submitted' : true) && Number(sec.total) > 0);
  } else {
    rows = (Array.isArray(test.scores) ? test.scores : []).filter((sc) => Number(sc.total) > 0);
  }
  return rows.reduce(
    (acc, r) => ({ correct: acc.correct + (Number(r.correct) || 0), total: acc.total + (Number(r.total) || 0), n: acc.n + 1 }),
    { correct: 0, total: 0, n: 0 }
  );
}

function renderTestCard(test, groupKind) {
  const isOnline = String(test.type || test.test_type || 'offline').toLowerCase() === 'online';
  const dateLabel = formatDisplayDateIST(test.test_date);
  const state = String(test.state || '').toLowerCase();
  const sections = testSections(test);
  const lbReady = Boolean(test.leaderboard_ready);
  const lbBtnHtml = lbReady
    ? `<button type="button" class="btn btn-outline btn-sm btn-open-test-leaderboard" data-test-id="${escapeHtml(test.id)}"><span aria-hidden="true">🏆</span> Leaderboard</button>`
    : '';
  const practiseBtnHtml = canOfferPractice(test)
    ? `<button type="button" class="btn btn-outline btn-sm btn-practise-test" data-test-id="${escapeHtml(test.id)}" title="Retake for practice. Does not change the official leaderboard."><span aria-hidden="true">🔁</span> Practise</button>`
    : '';
  const typeChip = isOnline
    ? '<span class="wt-chip wt-chip-blue">Online</span>'
    : '<span class="wt-chip">With your trainer</span>';
  const metaLine = isOnline
    ? `<span class="num"><b>${escapeHtml(dateLabel)}</b></span> &middot; <span>Window: ${escapeHtml(windowText(test.opens_at, test.closes_at))}</span>`
    : `<span class="num"><b>${escapeHtml(dateLabel)}</b></span> &middot; Offline assessment`;
  const notesHtml = test.notes ? `<p class="wt-notes">${escapeHtml(test.notes)}</p>` : '';

  // ---------- Past: one compact row with total score and per-section pills ----------
  if (groupKind === 'past') {
    const totals = testTotals(test);
    const pct = totals.total > 0 ? Math.round((totals.correct / totals.total) * 1000) / 10 : null;
    const accClass = pct === null ? '' : pct >= 90 ? 'is-good' : pct >= 75 ? 'is-warn' : 'is-low';
    const pills = renderPastSectionPills(test, sections, isOnline, state);
    return `
      <article class="card wt-test wt-past" data-test-card-id="${escapeHtml(test.id)}">
        <div class="wt-th">
          ${testCalendarHtml(test.test_date)}
          <div class="wt-th-body">
            <h3>${escapeHtml(test.title)} ${typeChip}</h3>
            <div class="wt-meta">${metaLine}</div>
          </div>
          <div class="wt-th-side">
            ${
              pct !== null
                ? `<div class="wt-total"><b class="num">${totals.correct} / ${totals.total}</b><span class="wt-acc ${accClass} num">${pct}%</span></div>`
                : ''
            }
            ${lbBtnHtml}
            ${practiseBtnHtml}
          </div>
        </div>
        ${pills}
      </article>
    `;
  }

  // ---------- Available / Upcoming ----------
  let progressChip = '';
  if (isOnline && sections.length > 0) {
    const done = sections.filter((s) => s.attempt === 'submitted').length;
    progressChip = `<span class="wt-chip ${done === sections.length ? 'wt-chip-ok' : ''} num">${done} of ${sections.length} done</span>`;
  }

  const sectionsHtml = isOnline
    ? sections.map((sec, idx) => renderOnlineSectionTile(test, sec, idx, state)).join('')
    : sections.map((sec, idx) => renderOfflineSectionTile(sec, idx)).join('');

  const scores = Array.isArray(test.scores) ? test.scores : [];
  let bodyHtml = '';
  if (sections.length > 0) {
    bodyHtml = `<div class="wt-secs">${sectionsHtml}</div>`;
  } else if (!isOnline && scores.length > 0) {
    bodyHtml = `<div class="wt-secs">${scores.map((sc) => renderScoreRowTile(sc)).join('')}</div>`;
  } else if (!isOnline) {
    bodyHtml = '<p class="wt-pending">Scores will appear here once entered by your trainer.</p>';
  }

  return `
    <article class="card wt-test ${groupKind === 'available' ? 'is-live' : ''}" data-test-card-id="${escapeHtml(test.id)}">
      <div class="wt-th">
        ${testCalendarHtml(test.test_date)}
        <div class="wt-th-body">
          <h3>${escapeHtml(test.title)} ${typeChip}</h3>
          <div class="wt-meta">${metaLine}</div>
          ${notesHtml}
        </div>
        <div class="wt-th-side">${progressChip}${lbBtnHtml}</div>
      </div>
      ${bodyHtml}
    </article>
  `;
}

function sectionTileHead(sec, idx) {
  return `
    <div class="wt-sec-r">
      <span class="wt-kind">${escapeHtml(sectionKindLabel(sec.kind))}</span>
      <span class="wt-pos num">#${idx + 1}</span>
    </div>
    <b class="wt-sec-title">${escapeHtml(sectionSummary(sec))}</b>
  `;
}

function renderOnlineSectionTile(test, sec, idx, state) {
  const summaryText = sectionSummary(sec);
  const statusText = sectionStatusLabel(sec, state);
  const startable = isSectionStartable(sec, state);
  const resumable = isSectionResumable(sec, state);
  const comingSoon = isSectionComingSoon(sec, state);
  const hasScore = sec.attempt === 'submitted' && sec.total !== null && sec.total !== undefined && Number(sec.total) > 0;
  const fb = hasScore ? getWeeklyTestScoreFeedback(sec.correct, sec.total, sec) : null;

  let chipHtml = '';
  let tileState = '';
  if (statusText.startsWith('Done:')) {
    tileState = 'is-done';
    chipHtml = fb
      ? `<span class="status-chip ${fb.badgeClass} wt-status" style="color: ${fb.colorVar}; background: ${fb.bgVar};">${escapeHtml(statusText)} &middot; ${escapeHtml(fb.wrongText)}</span>`
      : `<span class="status-chip chip-verified wt-status">${escapeHtml(statusText)}</span>`;
  } else if (statusText.startsWith('In progress:')) {
    tileState = 'is-prog';
    chipHtml = `<span class="wt-chip wt-chip-blue wt-status">${escapeHtml(statusText)}</span>`;
  } else if (statusText === 'Missed') {
    tileState = 'is-missed';
    chipHtml = '<span class="status-chip chip-flagged wt-status">Missed</span>';
  } else {
    chipHtml = '<span class="wt-chip wt-status">To do</span>';
  }

  let actionBtnHtml = '';
  if (startable || resumable) {
    const btnLabel = resumable ? 'Continue' : 'Start';
    actionBtnHtml = `
      <button
        type="button"
        class="btn btn-primary btn-sm btn-start-test-section"
        data-test-id="${escapeHtml(test.id)}"
        data-test-title="${escapeHtml(test.title)}"
        data-section-id="${escapeHtml(sec.section_id || sec.id || '')}"
        data-kind="${escapeHtml(String(sec.kind || 'basics').toLowerCase())}"
        data-category-id="${escapeHtml(sec.category_id || '')}"
        data-category-name="${escapeHtml(sec.name || summaryText)}"
        data-summary="${escapeHtml(summaryText)}"
        data-seconds="${Number(sec.seconds) || 60}"
        data-resume="${resumable ? 'true' : 'false'}"
      >${btnLabel}</button>
    `;
  } else if (comingSoon) {
    actionBtnHtml = '<button type="button" class="btn btn-outline btn-sm wt-soon" disabled>Available soon</button>';
  }

  return `
    <div class="wt-sec ${tileState}" data-section-item="true" data-section-id="${escapeHtml(sec.section_id || sec.id || '')}" data-category-id="${escapeHtml(sec.category_id || '')}">
      ${sectionTileHead(sec, idx)}
      <div class="wt-sec-status">
        ${chipHtml}
        ${hasScore && sec.time_seconds != null ? `<span class="wt-time num">${escapeHtml(formatSecondsToTime(sec.time_seconds))}</span>` : ''}
      </div>
      ${actionBtnHtml}
    </div>
  `;
}

function renderOfflineSectionTile(sec, idx) {
  const hasScore = sec.total !== null && sec.total !== undefined && Number(sec.total) > 0;
  const fb = hasScore ? getWeeklyTestScoreFeedback(sec.correct, sec.total, sec) : null;
  return `
    <div class="wt-sec ${hasScore ? 'is-done' : ''}" data-section-item="true" data-section-id="${escapeHtml(sec.section_id || sec.id || '')}" data-category-id="${escapeHtml(sec.category_id || '')}">
      ${sectionTileHead(sec, idx)}
      ${
        hasScore && fb
          ? `<div class="wt-sec-status">
               <span class="status-chip ${fb.badgeClass} wt-status" style="color: ${fb.colorVar}; background: ${fb.bgVar};">${sec.correct} of ${sec.total} &middot; ${escapeHtml(fb.wrongText)}</span>
               ${sec.time_seconds != null ? `<span class="wt-time num">${escapeHtml(formatSecondsToTime(sec.time_seconds))}</span>` : ''}
             </div>
             <span class="wt-src">Entered by teacher</span>`
          : '<span class="wt-src">With your trainer</span>'
      }
    </div>
  `;
}

function renderScoreRowTile(sc) {
  const fb = getWeeklyTestScoreFeedback(sc.correct, sc.total, sc);
  const sourceLabel = sc.source === 'online' ? 'Online' : 'Entered by teacher';
  const labelText = sc.category || sectionKindLabel(sc.kind) || 'Section';
  return `
    <div class="wt-sec is-done" data-section-item="true" data-section-id="${escapeHtml(sc.section_id || sc.id || '')}" data-category-id="${escapeHtml(sc.category_id || '')}">
      <b class="wt-sec-title">${escapeHtml(labelText)}</b>
      <div class="wt-sec-status">
        <span class="status-chip ${fb.badgeClass} wt-status" style="color: ${fb.colorVar}; background: ${fb.bgVar};">${sc.correct} of ${sc.total} &middot; ${escapeHtml(fb.wrongText)}</span>
        ${sc.time_seconds != null ? `<span class="wt-time num">${escapeHtml(formatSecondsToTime(sc.time_seconds))}</span>` : ''}
      </div>
      <span class="wt-src">${escapeHtml(sourceLabel)}</span>
    </div>
  `;
}

/**
 * Past tests: one small pill per section (score + time), so the row stays compact.
 */
function renderPastSectionPills(test, sections, isOnline, state) {
  const pill = (id, catId, label, scoreHtml, extra = '') => `
    <span class="wt-pill ${extra}" data-section-item="true" data-section-id="${escapeHtml(id || '')}" data-category-id="${escapeHtml(catId || '')}">
      <span class="wt-pill-l">${escapeHtml(label)}</span>${scoreHtml}
    </span>`;
  const scoreSpan = (r) => {
    const fb = getWeeklyTestScoreFeedback(r.correct, r.total, r);
    return `<b class="num" style="color: ${fb.colorVar};" title="${escapeHtml(fb.wrongText)}">${r.correct}/${r.total}</b>${
      r.time_seconds != null ? `<span class="wt-time num">${escapeHtml(formatSecondsToTime(r.time_seconds))}</span>` : ''
    }`;
  };

  let items = [];
  if (sections.length > 0) {
    items = sections.map((sec) => {
      const label = sectionSummary(sec);
      const scored = Number(sec.total) > 0 && (!isOnline || sec.attempt === 'submitted');
      if (scored) return pill(sec.section_id || sec.id, sec.category_id, label, scoreSpan(sec));
      const status = isOnline ? sectionStatusLabel(sec, state) : 'With your trainer';
      return pill(sec.section_id || sec.id, sec.category_id, label, `<span class="wt-pill-s">${escapeHtml(status)}</span>`, status === 'Missed' ? 'is-missed' : 'is-muted');
    });
  } else {
    const scores = Array.isArray(test.scores) ? test.scores : [];
    items = scores.map((sc) =>
      pill(sc.section_id || sc.id, sc.category_id, sc.category || sectionKindLabel(sc.kind) || 'Section', scoreSpan(sc) + `<span class="wt-pill-s">${sc.source === 'online' ? 'Online' : 'Entered by teacher'}</span>`)
    );
  }
  if (items.length === 0) {
    return isOnline ? '' : '<p class="wt-pending">Scores will appear here once entered by your trainer.</p>';
  }
  return `<div class="wt-pills">${items.join('')}</div>`;
}

// ============================================================================
// START SECTION CONFIRMATION & TIMED BASICS PLAYER
// ============================================================================

function promptStartSection({
  testId,
  testTitle,
  sectionId,
  kind = 'basics',
  categoryId,
  categoryName,
  summaryText,
  seconds,
  resume = false,
}) {
  pendingStartRequest = {
    testId,
    testTitle,
    sectionId,
    kind: String(kind || 'basics').toLowerCase(),
    categoryId,
    categoryName,
    summaryText: summaryText || categoryName,
    seconds,
    resume,
  };
  const titleEl = document.getElementById('start-section-modal-title');
  const summaryEl = document.getElementById('start-section-modal-summary');
  const warningEl = document.getElementById('start-section-modal-warning');
  const confirmBtn = document.getElementById('btn-confirm-start-section');

  if (titleEl) {
    titleEl.textContent = resume ? 'Continue Test Section' : 'Start Test Section';
  }
  if (summaryEl) {
    const label = summaryText || `${categoryName} (${formatSectionDuration(seconds)})`;
    summaryEl.textContent = `${testTitle} — ${label}`;
  }
  if (warningEl) {
    warningEl.textContent = START_SECTION_CONFIRM_TEXT;
  }
  if (confirmBtn) {
    confirmBtn.textContent = resume ? 'Continue' : 'Start';
  }
  openModal('start-section-modal');
}

function setupStartModalHandlers() {
  const btnConfirm = document.getElementById('btn-confirm-start-section');
  if (!btnConfirm) return;

  btnConfirm.onclick = async () => {
    if (!pendingStartRequest) return;
    const reqInfo = { ...pendingStartRequest };
    btnConfirm.disabled = true;

    try {
      closeModal('start-section-modal');
      if (
        reqInfo.kind === 'elements' ||
        reqInfo.kind === 'flash' ||
        reqInfo.kind === 'memoriad'
      ) {
        const targetUrl = runnerLink(
          { kind: reqInfo.kind, section_id: reqInfo.sectionId },
          reqInfo.testId
        );
        if (targetUrl) {
          window.location.href = targetUrl;
          return;
        }
      }
      await startWeeklyTestSection(reqInfo);
    } finally {
      btnConfirm.disabled = false;
    }
  };
}

async function startWeeklyTestSection({
  testId,
  testTitle,
  sectionId,
  categoryId,
  categoryName,
  seconds,
}) {
  showErrorBanner('');

  try {
    let payload = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/weekly-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'start',
          test_id: testId,
          section_id: sectionId || undefined,
          category_id: categoryId,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not start this weekly test section.');
      }
      payload = data;
    } else if (isDemoMode() && DemoDB && DemoDB.mockStartWeeklyTestSection) {
      payload = DemoDB.mockStartWeeklyTestSection(
        currentProfile.id,
        testId,
        categoryId,
        sectionId
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    activeTestId = testId;
    activeTestTitle = payload.title || testTitle || 'Weekly Test';
    activeSectionId = payload.section_id || sectionId || null;
    activeCategoryId = categoryId;
    activeCategoryName = payload.category_name || categoryName;
    activeSessionId = payload.session_id;
    activeSeconds = Number(payload.seconds || seconds || 60);
    activeExpiresAtMs = Date.now() + (activeSeconds + 60) * 1000;

    roundEnded = false;
    sectionRunning = true;
    pendingSubmissionAnswers = null;

    const retryBox = document.getElementById('player-submit-retry-box');
    const answerForm = document.getElementById('player-answer-form');
    if (retryBox) retryBox.style.display = 'none';
    if (answerForm) answerForm.style.display = 'flex';

    const testBadgeEl = document.getElementById('player-test-badge');
    const catBadgeEl = document.getElementById('player-category-badge');
    if (testBadgeEl) testBadgeEl.textContent = activeTestTitle;
    if (catBadgeEl) catBadgeEl.textContent = activeCategoryName;

    activePlayer = createDrillPlayer(payload.questions || [], {
      mode: 'timed',
      revisitSkipped: false,
    });

    showScreen('screen-player');
    startSectionCountdown();
    renderCurrentPlayerQuestion();
  } catch (err) {
    console.error('Failed to start weekly test section:', err);
    showErrorBanner(err.message || 'Could not start weekly test section.');
    showToast('error', err.message || 'Could not start weekly test section.');
    await loadMyWeeklyTests();
  }
}

function startSectionCountdown() {
  stopSectionCountdown();
  const nowPerf = performance.now();
  countdownEndMs = nowPerf + Number(activeSeconds) * 1000;

  const stopwatchEl = document.getElementById('player-stopwatch');
  const fillEl = document.getElementById('player-progress-bar-fill');

  if (stopwatchEl) stopwatchEl.textContent = formatSecondsToMMSS(activeSeconds);
  if (fillEl) fillEl.style.width = '100%';

  roundTimerId = window.setInterval(() => {
    if (roundEnded) return;
    const tick = computeRemainingSeconds(
      countdownEndMs,
      performance.now(),
      Number(activeSeconds)
    );
    if (stopwatchEl) {
      stopwatchEl.textContent = formatSecondsToMMSS(tick.remainingSeconds);
    }
    if (fillEl) {
      fillEl.style.width = `${tick.progressPercent.toFixed(1)}%`;
    }
    if (tick.expired) {
      handleSectionTimeUp();
    }
  }, 250);
}

function stopSectionCountdown() {
  if (roundTimerId !== null) {
    clearInterval(roundTimerId);
    roundTimerId = null;
  }
}

function renderCurrentPlayerQuestion() {
  if (!activePlayer) return;
  const state = activePlayer.getState();

  const answeredLabelEl = document.getElementById('player-answered-label');
  if (answeredLabelEl) {
    answeredLabelEl.textContent = `Answered ${state.attemptedCount}`;
  }

  if (state.isFinished) {
    roundEnded = true;
    stopSectionCountdown();
    const finalAnswers = activePlayer.finish();
    if (finalAnswers !== null) {
      submitWeeklyTestSection(finalAnswers);
    }
    return;
  }

  const stageEl = document.getElementById('player-question-stage');
  const inputEl = document.getElementById('player-answer-input');
  const q = state.currentQuestion;

  if (stageEl && q) {
    if (typeof q === 'object' && Array.isArray(q.rows)) {
      const rowsHtml = q.rows
        .map((num) => {
          const sign = num < 0 ? '-' : '+';
          const mag = Math.abs(Number(num));
          return `
            <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); width: 140px; padding: 2px 0; font-size: 1.65rem; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.25;">
              <span style="color: ${num < 0 ? 'var(--color-score-warning)' : 'var(--text-muted)'}; font-weight: 700;">${sign}</span>
              <span style="text-align: right; color: var(--text-main);">${mag}</span>
            </div>
          `;
        })
        .join('');

      stageEl.innerHTML = `
        <div style="display: inline-flex; flex-direction: column; align-items: center; padding: var(--space-2) var(--space-4);">
          ${rowsHtml}
          <div style="width: 156px; border-bottom: 3px solid var(--text-main); margin-top: var(--space-2);" aria-hidden="true"></div>
        </div>
      `;
    } else {
      const promptText =
        typeof q === 'object' && q !== null ? String(q.text || '') : String(q ?? '');
      stageEl.innerHTML = `
        <div style="font-size: 2.25rem; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text-main); text-align: center; padding: var(--space-4);">
          ${escapeHtml(promptText)}
        </div>
      `;
    }
  }

  if (inputEl) {
    inputEl.value = '';
    inputEl.disabled = false;
    inputEl.focus();
  }
}

function handleSectionTimeUp() {
  if (roundEnded || !activePlayer) return;
  roundEnded = true;
  stopSectionCountdown();

  const reachedAnswers = activePlayer.finish();
  if (reachedAnswers === null) return;
  submitWeeklyTestSection(reachedAnswers);
}

function setupPlayerHandlers() {
  const form = document.getElementById('player-answer-form');
  const inputEl = document.getElementById('player-answer-input');
  const skipBtn = document.getElementById('btn-player-skip');
  const finishBtn = document.getElementById('btn-player-finish');
  const retryBtn = document.getElementById('btn-retry-submit');

  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      if (roundEnded || !activePlayer || isSubmitting) return;
      const val = inputEl ? inputEl.value.trim() : '';
      if (!val) {
        if (inputEl) inputEl.focus();
        return;
      }
      activePlayer.submitCurrent(val);
      renderCurrentPlayerQuestion();
    };
  }

  if (skipBtn) {
    skipBtn.onclick = () => {
      if (roundEnded || !activePlayer || isSubmitting) return;
      activePlayer.skipCurrent();
      renderCurrentPlayerQuestion();
    };
  }

  if (finishBtn) {
    finishBtn.onclick = () => {
      if (roundEnded || !activePlayer || isSubmitting) return;
      const reachedCount = activePlayer.getAttemptedCount();
      const confirmMsg =
        reachedCount === 0
          ? 'You have not answered any questions yet. Submit this section with 0 answers (you cannot take it again)?'
          : `Finish this section early and submit the ${reachedCount} ${
              reachedCount === 1 ? 'question' : 'questions'
            } you have answered?`;

      if (!window.confirm(confirmMsg)) {
        if (inputEl) inputEl.focus();
        return;
      }

      roundEnded = true;
      stopSectionCountdown();
      const reachedAnswers = activePlayer.finish();
      if (reachedAnswers !== null) {
        submitWeeklyTestSection(reachedAnswers);
      }
    };
  }

  if (retryBtn) {
    retryBtn.onclick = () => {
      if (!pendingSubmissionAnswers || isSubmitting) return;
      if (Date.now() > activeExpiresAtMs) {
        showToast('error', 'The submission window for this section has expired.');
        sectionRunning = false;
        showScreen('screen-list');
        loadMyWeeklyTests();
        return;
      }
      submitWeeklyTestSection(pendingSubmissionAnswers);
    };
  }
}

async function submitWeeklyTestSection(answersArray) {
  if (isSubmitting) return;
  isSubmitting = true;
  pendingSubmissionAnswers = answersArray;

  const inputEl = document.getElementById('player-answer-input');
  const answerForm = document.getElementById('player-answer-form');
  const retryBox = document.getElementById('player-submit-retry-box');
  const retryMsg = document.getElementById('player-submit-retry-msg');
  const retryBtn = document.getElementById('btn-retry-submit');

  if (inputEl) inputEl.disabled = true;
  if (retryBtn) retryBtn.disabled = true;

  try {
    let resultPayload = null;

    if (isSupabaseConfigured()) {
      const token = await getAccessToken();
      const resp = await fetch('/api/weekly-test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          action: 'submit',
          session_id: activeSessionId,
          answers: answersArray,
        }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || 'Could not submit weekly test section.');
      }
      resultPayload = data;
    } else if (isDemoMode() && DemoDB && DemoDB.mockSubmitWeeklyTestSection) {
      resultPayload = DemoDB.mockSubmitWeeklyTestSection(
        currentProfile.id,
        activeSessionId,
        answersArray
      );
    } else {
      throw new Error('Database connection is not configured.');
    }

    sectionRunning = false;
    pendingSubmissionAnswers = null;

    await loadMyWeeklyTests();
    renderSectionResultsScreen(resultPayload);
  } catch (err) {
    console.error('Failed to submit weekly test section:', err);
    if (answerForm) answerForm.style.display = 'none';
    if (retryBox) retryBox.style.display = 'block';

    const expired = Date.now() > activeExpiresAtMs;
    if (retryMsg) {
      retryMsg.textContent = expired
        ? 'The submission window for this section has expired.'
        : `${err.message || 'Could not send your section answers.'} Your answers are still safe in memory.`;
    }
    if (retryBtn) {
      retryBtn.style.display = expired ? 'none' : 'inline-flex';
      retryBtn.disabled = false;
    }
  } finally {
    isSubmitting = false;
  }
}

function renderSectionResultsScreen(result) {
  const correct = Number(result?.correct) || 0;
  const attempted = Number(result?.attempted) || 0;
  const accuracy = Number(result?.accuracy) || 0;
  const usedSeconds = Number(result?.used_seconds) || activeSeconds;

  const savedBadgeEl = document.getElementById('results-saved-badge');
  const headlineEl = document.getElementById('results-headline');
  const subheadlineEl = document.getElementById('results-subheadline');
  const scoreTextEl = document.getElementById('results-score-text');
  const accTextEl = document.getElementById('results-accuracy-text');
  const timeTextEl = document.getElementById('results-time-text');
  const nextSecBtn = document.getElementById('btn-results-next-section');
  const backBtn = document.getElementById('btn-results-back-list');

  if (savedBadgeEl) {
    savedBadgeEl.textContent = `Saved as part of ${activeTestTitle}`;
  }
  if (headlineEl) {
    headlineEl.textContent = `${correct} out of ${attempted}`;
  }
  if (scoreTextEl) {
    scoreTextEl.textContent = `${correct} out of ${attempted}`;
  }
  if (accTextEl) {
    accTextEl.textContent = `${accuracy}%`;
  }
  if (timeTextEl) {
    timeTextEl.textContent = formatSecondsToTime(usedSeconds);
  }

  // Check if there is a next startable Basics section in this test
  const updatedTest = myTests.find((t) => t.id === activeTestId);
  const nextTodoSec =
    updatedTest && String(updatedTest.state).toLowerCase() === 'open'
      ? nextSection(updatedTest.sections || [])
      : null;

  if (nextTodoSec) {
    const nextSummary = sectionSummary(nextTodoSec);
    const nextResumable = isSectionResumable(nextTodoSec, 'open');
    if (subheadlineEl) {
      subheadlineEl.textContent = `${activeCategoryName} complete · Up next: ${nextSummary}`;
    }
    if (nextSecBtn) {
      nextSecBtn.style.display = 'inline-flex';
      nextSecBtn.textContent = `${nextResumable ? 'Continue' : 'Next'} section: ${nextSummary} →`;
      nextSecBtn.onclick = () => {
        promptStartSection({
          testId: updatedTest.id,
          testTitle: updatedTest.title,
          sectionId: nextTodoSec.section_id || nextTodoSec.id || null,
          kind: String(nextTodoSec.kind || 'basics').toLowerCase(),
          categoryId: nextTodoSec.category_id,
          categoryName: nextTodoSec.name || nextSummary,
          summaryText: nextSummary,
          seconds: Number(nextTodoSec.seconds) || 60,
          resume: nextResumable,
        });
      };
    }
    if (backBtn) {
      backBtn.textContent = 'Back to Weekly Tests';
    }
  } else {
    if (subheadlineEl) {
      subheadlineEl.textContent = 'Test complete';
    }
    if (nextSecBtn) {
      nextSecBtn.style.display = 'none';
    }
    if (backBtn) {
      backBtn.textContent = 'Test complete — View Weekly Tests';
    }
  }

  showScreen('screen-results');
}

function setupResultsHandlers() {
  const backBtn = document.getElementById('btn-results-back-list');
  if (backBtn) {
    backBtn.onclick = async () => {
      showScreen('screen-list');
      await loadMyWeeklyTests();
    };
  }
}

function renderHeaderUser(profile) {
  const container = document.getElementById('user-pill-container');
  const nameEl = document.getElementById('header-user-name');
  const codeEl = document.getElementById('header-user-code');

  if (nameEl) nameEl.textContent = profile.full_name || 'Student';
  if (codeEl) codeEl.textContent = profile.student_code || '';
  if (container) container.style.display = 'flex';
}

function renderDemoBanner() {
  const placeholder = document.getElementById('config-banner-placeholder');
  if (!placeholder) return;
  placeholder.innerHTML = `
    <div class="banner banner-warning" style="margin-bottom: var(--space-5);" role="alert">
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

/**
 * Handles incoming URL query parameters for weekly test linking:
 * - ?testId=<uuid>
 * - ?attemptId=<uuid>
 * - Verifies recipient ownership and record existence
 * - Locates and highlights the referenced weekly test card and attempt section
 * - Strictly NEVER starts, resumes, or counts down the section automatically
 * - Shows a user-facing toast error for missing or unauthorized records
 */
export async function handleWeeklyTestUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const testId = urlParams.get('testId');
  const attemptId = urlParams.get('attemptId');
  if (!testId && !attemptId) return;

  let targetTestId = testId || null;
  let targetSectionId = null;
  let targetCategoryId = null;

  const activeProfile = currentProfile || (isDemoMode() ? (JSON.parse(localStorage.getItem('trendz_current_user') || 'null') || { id: 'usr-101', role: 'student' }) : null);

  // 1. If attemptId is provided, verify attempt existence and recipient ownership
  if (attemptId) {
    let attRow = null;
    if (isSupabaseConfigured()) {
      try {
        const supabase = await getSupabase();
        if (supabase) {
          const { data, error } = await supabase
            .from('weekly_test_attempts')
            .select('id, test_id, student_id, section_id, category_id')
            .eq('id', attemptId)
            .maybeSingle();

          if (error || !data) {
            showToast('error', 'The referenced weekly test attempt could not be found.');
            return;
          }
          attRow = data;
        }
      } catch {
        showToast('error', 'The referenced weekly test attempt could not be found.');
        return;
      }
    } else if (isDemoMode()) {
      try {
        const attempts = JSON.parse(
          localStorage.getItem('trendz_demo_weekly_attempts_v1') ||
          localStorage.getItem('tt_weekly_attempts') ||
          '[]'
        );
        attRow = attempts.find((a) => String(a.id) === String(attemptId)) || null;
      } catch {
        attRow = null;
      }
    }

    if (!attRow) {
      showToast('error', 'The referenced weekly test attempt could not be found.');
      return;
    }

    if (activeProfile?.role !== 'admin' && attRow.student_id && attRow.student_id !== activeProfile?.id) {
      showToast('error', 'You do not have permission to view this weekly test attempt.');
      return;
    }

    targetTestId = targetTestId || attRow.test_id;
    targetSectionId = attRow.section_id || null;
    targetCategoryId = attRow.category_id || null;
  }

  // 2. Verify test existence and student eligibility
  if (targetTestId) {
    let targetTest = myTests.find((t) => String(t.id) === String(targetTestId));

    if (!targetTest) {
      if (isSupabaseConfigured()) {
        try {
          const supabase = await getSupabase();
          if (supabase) {
            const { data, error } = await supabase
              .from('weekly_tests')
              .select('id, audience_level')
              .eq('id', targetTestId)
              .maybeSingle();

            if (error || !data) {
              showToast('error', 'The referenced weekly test could not be found.');
              return;
            }

            if (
              activeProfile?.role !== 'admin' &&
              data.audience_level &&
              activeProfile?.level &&
              String(data.audience_level).trim().toLowerCase() !== String(activeProfile.level).trim().toLowerCase()
            ) {
              showToast('error', 'You do not have permission to view this weekly test.');
              return;
            }
          }
        } catch {
          showToast('error', 'The referenced weekly test could not be found.');
          return;
        }
      } else if (isDemoMode()) {
        try {
          const allTests = JSON.parse(
            localStorage.getItem('trendz_demo_weekly_tests_v3') ||
            localStorage.getItem('tt_weekly_tests') ||
            '[]'
          );
          const tData = allTests.find((t) => String(t.id) === String(targetTestId));
          if (!tData) {
            showToast('error', 'The referenced weekly test could not be found.');
            return;
          }
          if (
            activeProfile?.role !== 'admin' &&
            tData.audience_level &&
            activeProfile?.level &&
            String(tData.audience_level).trim().toLowerCase() !== String(activeProfile.level).trim().toLowerCase()
          ) {
            showToast('error', 'You do not have permission to view this weekly test.');
            return;
          }
        } catch {
          showToast('error', 'The referenced weekly test could not be found.');
          return;
        }
      }
    }

    // 3. Locate and highlight card and section in DOM without starting or resuming
    setTimeout(() => {
      const cardEl = document.querySelector(`[data-test-card-id="${targetTestId}"]`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cardEl.classList.add('card-linked-highlight');
        cardEl.style.outline = '2px solid var(--color-primary, #4338CA)';
        cardEl.style.boxShadow = '0 0 0 4px rgba(99, 102, 241, 0.2)';

        let secEl = null;
        if (targetSectionId) {
          secEl = cardEl.querySelector(`[data-section-id="${targetSectionId}"]`);
        }
        if (!secEl && targetCategoryId) {
          secEl = cardEl.querySelector(`[data-category-id="${targetCategoryId}"]`);
        }

        if (secEl) {
          secEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          secEl.classList.add('section-linked-highlight');
          secEl.style.outline = '2px solid var(--color-primary, #4338CA)';
          secEl.style.backgroundColor = 'var(--bg-highlight, rgba(99, 102, 241, 0.12))';
          setTimeout(() => {
            secEl.style.transition = 'background-color 2s ease, outline 2s ease';
            secEl.style.backgroundColor = '';
            secEl.style.outline = '';
          }, 3500);
        }

        setTimeout(() => {
          cardEl.style.transition = 'box-shadow 2s ease, outline 2s ease';
          cardEl.style.outline = '';
          cardEl.style.boxShadow = '';
        }, 3500);
      }
    }, 150);
  }
}

document.addEventListener('DOMContentLoaded', initStudentWeeklyTestPage);

// ---------------------------------------------------------------------------
// Practice mode: retake a closed online test. Stored apart from official
// results; never changes the official leaderboard (migration 38).
// ---------------------------------------------------------------------------

let practiceTestId = null;
let practiceRunId = null;

async function practiceApi(body) {
  const token = await getAccessToken();
  const resp = await fetch('/api/weekly-test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || 'Could not start practice.');
  return data;
}

async function fetchPracticeState(testId) {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('my_weekly_test_practice', { p_test: testId });
    if (error) throw error;
    return data || { runs: [] };
  }
  if (isDemoMode() && DemoDB?.mockMyWeeklyTestPractice) {
    return DemoDB.mockMyWeeklyTestPractice(currentProfile.id, testId);
  }
  throw new Error('Database connection is not configured.');
}

async function fetchPracticeStanding(testId, runId) {
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    const { data, error } = await supabase.rpc('weekly_test_practice_standing', {
      p_test: testId,
      p_run: runId || null,
    });
    if (error) throw error;
    return data;
  }
  if (isDemoMode() && DemoDB?.mockPracticeStanding) {
    return DemoDB.mockPracticeStanding(currentProfile.id, testId, runId, currentProfile);
  }
  throw new Error('Database connection is not configured.');
}

async function beginPracticeRun(testId) {
  if (isSupabaseConfigured()) {
    return practiceApi({ action: 'practice_begin', test_id: testId });
  }
  if (isDemoMode() && DemoDB?.mockPracticeBegin) {
    return DemoDB.mockPracticeBegin(currentProfile.id, testId);
  }
  throw new Error('Database connection is not configured.');
}

function renderPracticeBoardHtml(standing) {
  const rows = Array.isArray(standing?.board) ? standing.board : [];
  if (rows.length === 0) return '';
  const body = rows
    .map((row) => {
      const mine = Boolean(row.is_practice);
      const style = mine
        ? 'background: #FFFBEB; font-weight: 700; outline: 2px dashed #F59E0B; outline-offset: -2px;'
        : '';
      const tag = mine
        ? `<span class="badge" style="margin-left: 8px; background: #FEF3C7; color: #92400E;">You (practice)</span>`
        : '';
      return `
        <tr style="${style}" data-is-practice="${mine ? 'true' : 'false'}">
          <td><span class="num" style="font-weight: 700;">#${escapeHtml(row.rank)}</span></td>
          <td><span style="font-weight: ${mine ? '700' : '600'};">${escapeHtml(row.display_name)}</span>${tag}</td>
          <td class="num" style="text-align: right; font-weight: 700;">${escapeHtml(String(row.points))}</td>
          <td class="num" style="text-align: right;">${escapeHtml(`${row.correct} of ${row.attempted}`)}</td>
          <td class="num" style="text-align: right; color: var(--text-muted);">${escapeHtml(formatSecondsToTime(row.seconds))}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="table-wrapper" style="margin-top: var(--space-3);">
      <table class="table" id="wt-practice-board" aria-label="Where you would have stood (practice, not official)">
        <thead>
          <tr>
            <th style="width: 64px;">Rank</th>
            <th>Student</th>
            <th style="text-align: right;">Points</th>
            <th style="text-align: right;">Correct of attempted</th>
            <th style="text-align: right;">Time</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderPracticeSectionsHtml(test, run) {
  const rows = practiceSectionRows(testSections(test), run);
  return rows
    .map((row, idx) => {
      const summary = sectionSummary(row.section);
      let status = '<span class="wt-chip wt-status">To do</span>';
      if (row.done && row.total !== null) {
        status = `<span class="wt-chip wt-chip-ok wt-status num">${row.correct} of ${row.total}</span>`;
      } else if (row.status) {
        status = '<span class="wt-chip wt-chip-blue wt-status">In progress</span>';
      }
      const btn = row.action
        ? `<button type="button" class="btn btn-primary btn-sm btn-practice-section"
              data-section-id="${escapeHtml(row.section_id)}"
              data-kind="${escapeHtml(row.kind)}">${row.action === 'continue' ? 'Continue' : 'Start'}</button>`
        : '';
      return `
        <div class="wt-sec ${row.done ? 'is-done' : ''}" data-practice-section="${escapeHtml(row.section_id)}">
          <div class="wt-sec-r">
            <span class="wt-kind">${escapeHtml(sectionKindLabel(row.kind))}</span>
            <span class="wt-pos num">#${idx + 1}</span>
          </div>
          <b class="wt-sec-title">${escapeHtml(summary)}</b>
          <div class="wt-sec-status">${status}${
            row.time_seconds != null
              ? `<span class="wt-time num">${escapeHtml(formatSecondsToTime(row.time_seconds))}</span>`
              : ''
          }</div>
          ${btn}
        </div>`;
    })
    .join('');
}

async function renderPracticeModal() {
  const bodyEl = document.getElementById('practice-modal-body');
  const titleEl = document.getElementById('practice-modal-title');
  const newRunBtn = document.getElementById('btn-practice-new-run');
  if (!bodyEl) return;
  const test = myTests.find((t) => String(t.id) === String(practiceTestId));
  if (!test) {
    bodyEl.innerHTML = '<p>This test was not found.</p>';
    return;
  }
  if (titleEl) titleEl.textContent = `Practise: ${test.title}`;
  bodyEl.innerHTML = '<p class="loading-state">Loading practice…</p>';

  try {
    const state = await fetchPracticeState(test.id);
    if (!state.can_practise) {
      bodyEl.innerHTML = `<p>${escapeHtml(state.reason || 'This test cannot be practised right now.')}</p>`;
      if (newRunBtn) newRunBtn.style.display = 'none';
      return;
    }
    const runs = Array.isArray(state.runs) ? state.runs : [];
    const run = runs.find((r) => r.run_id === practiceRunId) || runs[0] || null;
    practiceRunId = run ? run.run_id : null;

    let standingHtml = '';
    const hasScore = run && (run.sections || []).some((s) => s.total !== null && s.total !== undefined);
    if (hasScore) {
      try {
        const standing = await fetchPracticeStanding(test.id, practiceRunId);
        const { headline, detail } = standingHeadline(standing);
        standingHtml = `
          <div id="wt-practice-standing" style="margin-top: var(--space-4);">
            <h3 style="margin: 0 0 var(--space-1); font-size: var(--text-base);">Where you would have stood <span class="badge" style="margin-left: 6px; background: #FEF3C7; color: #92400E;">${escapeHtml(standing?.label || PRACTICE_LABEL)}</span></h3>
            <p style="margin: 0; font-weight: 700;">${escapeHtml(headline)}</p>
            <p style="margin: 0; font-size: var(--text-sm); color: var(--text-muted);">${escapeHtml(detail)}</p>
            ${renderPracticeBoardHtml(standing)}
          </div>`;
      } catch (err) {
        standingHtml = `<p style="margin-top: var(--space-4); color: var(--text-muted);">${escapeHtml(err.message || 'Standing unavailable.')}</p>`;
      }
    }

    const runInfo = run
      ? `<p style="margin: 0 0 var(--space-2); font-size: var(--text-sm); color: var(--text-muted);">Practice run started ${escapeHtml(formatDisplayDateIST(getISTDateYMD(run.started_at)))}${runs.length > 1 ? ` &middot; ${runs.length} runs so far` : ''}</p>`
      : '';

    bodyEl.innerHTML = `
      <div style="padding: var(--space-3); background: #FFFBEB; border: 1px solid #FDE68A; border-radius: var(--radius-md); font-size: var(--text-sm); color: #92400E;">
        <b>${escapeHtml(PRACTICE_LABEL)}.</b> ${escapeHtml(PRACTICE_EXPLANATION)}
      </div>
      <div style="margin-top: var(--space-3);">
        ${
          run
            ? `${runInfo}<div class="wt-secs">${renderPracticeSectionsHtml(test, run)}</div>`
            : '<p style="margin: 0;">Start a practice run to take the sections again.</p>'
        }
      </div>
      ${standingHtml}
    `;
    if (newRunBtn) {
      newRunBtn.style.display = 'inline-flex';
      newRunBtn.textContent = run ? 'New practice run' : 'Start practice';
    }

    bodyEl.querySelectorAll('.btn-practice-section').forEach((btn) => {
      btn.onclick = () => {
        const url = runnerLink(
          { kind: btn.getAttribute('data-kind') || 'basics', section_id: btn.getAttribute('data-section-id') },
          String(test.id),
          practiceRunId
        );
        if (url) window.location.href = url;
      };
    });
  } catch (err) {
    console.error('Failed to load practice:', err);
    bodyEl.innerHTML = `<p style="color: var(--color-danger);">${escapeHtml(err.message || 'Could not load practice.')}</p>`;
  }
}

function openPracticeModal(testId) {
  practiceTestId = testId;
  practiceRunId = null;
  openModal('practice-modal');
  renderPracticeModal();
}

function setupPracticeHandlers() {
  const newRunBtn = document.getElementById('btn-practice-new-run');
  if (!newRunBtn) return;
  newRunBtn.onclick = async () => {
    if (!practiceTestId) return;
    newRunBtn.disabled = true;
    try {
      const res = await beginPracticeRun(practiceTestId);
      practiceRunId = res.run_id;
      await renderPracticeModal();
    } catch (err) {
      showToast('error', err.message || 'Could not start practice.');
    } finally {
      newRunBtn.disabled = false;
    }
  };
}
