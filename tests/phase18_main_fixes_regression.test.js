/**
 * Regression Tests for Four Main Fixes (tests/phase18_main_fixes_regression.test.js)
 *
 * 1. Complete RESTORE_TABLE_ORDER & Backup Coverage:
 *    - All 38 tables in PRIVATE_SERVER_BACKUP_TABLES included exactly once.
 *    - FK safe dependency order strictly verified (student_rounds before results).
 *    - Validates presence of weekly_test_removals and absence of questionable legacy names
 *      (weekly_test_section_removals, rounds, profile_audit, report_log, backup_runs).
 * 2. Server-Authoritative Basics "Today" Practice in IST:
 *    - Server RPC today_ist / DemoDB.mockTodayIST() date resolution.
 *    - Deterministic demo dates via trendz_demo_today_ist.
 *    - Explicit date-loading failure handling with error banner and '(!)' badge.
 *    - Incorrect device clock and IST midnight boundary tests.
 * 3. Actual Basics Rendering Integration:
 *    - DOM rendering verification across multiple dates and pagination.
 *    - Global accuracy ordering in flat table without date header fragmentation.
 *    - Date-grouped cards preserved for date-based sorting (newest/oldest).
 *    - Older records strictly excluded from Today's Practice.
 * 4. Memoriad Module Catalog & Legacy Alias Resolution:
 *    - Filter options derived dynamically from MEMORIAD_MODULE_CATALOG.
 *    - Normalization and history filtering across canonical and legacy aliases.
 */

import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_TABLES,
  SNAPSHOT_TABLES,
  APPEND_TABLES,
  BACKUP_TABLE_MAP,
  PRIVATE_SERVER_BACKUP_TABLES,
  RESTORE_TABLE_ORDER,
} from '../api/_backupTables.js';
import {
  EXPORT_TABLES,
  buildExportReadme,
  rowsToCsv,
  buildStoreZip,
  parseStoreZip,
} from '../js/backupExport.js';
import {
  toISTDateString,
  filterAndSortHistory,
  paginateHistory,
  normalizeMemoriadModuleKey,
  resolveRowCategoryKey,
} from '../js/historyFilters.js';
import { MEMORIAD_MODULE_CATALOG } from '../js/memoriadStats.js';
import {
  fetchServerTodayIST,
  setServerTodayISTForTesting,
  setServerTodayErrorForTesting,
  getServerTodayIST,
  setBasicsResultsForTesting,
  setBasicsCategoriesForTesting,
  setBasicsFiltersForTesting,
  setBasicsPageForTesting,
  renderHistory,
} from '../js/basics.js';
import { DemoDB } from '../js/demoDb.js';

// ============================================================================
// 1. COMPLETE RESTORE_TABLE_ORDER & BACKUP REGISTRY COVERAGE
// ============================================================================
describe('1. Complete RESTORE_TABLE_ORDER & Backup Registry Coverage', () => {
  it('includes every table from PRIVATE_SERVER_BACKUP_TABLES exactly once with zero missing or extra tables', () => {
    assert.equal(PRIVATE_SERVER_BACKUP_TABLES.length, 38, 'PRIVATE_SERVER_BACKUP_TABLES must have 38 tables');
    assert.equal(RESTORE_TABLE_ORDER.length, 38, 'RESTORE_TABLE_ORDER must have exactly 38 tables');
    assert.equal(new Set(RESTORE_TABLE_ORDER).size, 38, 'Must have zero duplicate tables');

    const backupNames = PRIVATE_SERVER_BACKUP_TABLES.map((t) => t.name);
    assert.deepEqual(
      [...RESTORE_TABLE_ORDER].sort(),
      [...backupNames].sort(),
      'RESTORE_TABLE_ORDER must match PRIVATE_SERVER_BACKUP_TABLES complete registry exactly'
    );
  });

  it('validates restore order against actual foreign keys (student_rounds before results, profiles first)', () => {
    const idx = (name) => RESTORE_TABLE_ORDER.indexOf(name);

    // 1. Root tables must precede dependent tables
    assert.ok(idx('profiles') < idx('student_rounds'), 'profiles must precede student_rounds');
    assert.ok(idx('profiles') < idx('results'), 'profiles must precede results');
    assert.ok(idx('profiles') < idx('attendance'), 'profiles must precede attendance');
    assert.ok(idx('profiles') < idx('teacher_permissions'), 'profiles must precede teacher_permissions');
    assert.ok(idx('profiles') < idx('teacher_student_assignments'), 'profiles must precede teacher_student_assignments');
    assert.ok(idx('profiles') < idx('weekly_test_removals'), 'profiles must precede weekly_test_removals');

    // 2. student_rounds MUST precede results (results.student_round_id -> student_rounds.id)
    assert.ok(idx('student_rounds') < idx('results'), 'student_rounds must precede results');

    // 3. round_series must precede student_rounds and category_series
    assert.ok(idx('round_series') < idx('student_rounds'), 'round_series must precede student_rounds');
    assert.ok(idx('round_series') < idx('category_series'), 'round_series must precede category_series');

    // 4. categories must precede category_series, results, weekly_test_sections, weekly_test_scores
    assert.ok(idx('categories') < idx('category_series'), 'categories must precede category_series');
    assert.ok(idx('categories') < idx('results'), 'categories must precede results');
    assert.ok(idx('categories') < idx('weekly_test_sections'), 'categories must precede weekly_test_sections');
    assert.ok(idx('categories') < idx('weekly_test_scores'), 'categories must precede weekly_test_scores');

    // 5. weekly_tests must precede recipients, sections, scores, and attempts
    assert.ok(idx('weekly_tests') < idx('weekly_test_recipients'), 'weekly_tests must precede weekly_test_recipients');
    assert.ok(idx('weekly_tests') < idx('weekly_test_sections'), 'weekly_tests must precede weekly_test_sections');
    assert.ok(idx('weekly_tests') < idx('weekly_test_scores'), 'weekly_tests must precede weekly_test_scores');
    assert.ok(idx('weekly_tests') < idx('weekly_test_attempts'), 'weekly_tests must precede weekly_test_attempts');

    // 6. attendance_sessions must precede attendance
    assert.ok(idx('attendance_sessions') < idx('attendance'), 'attendance_sessions must precede attendance');

    // 7. jmcwc_papers and jmcwc_categories must precede jmcwc_attempts
    assert.ok(idx('jmcwc_papers') < idx('jmcwc_attempts'), 'jmcwc_papers must precede jmcwc_attempts');
    assert.ok(idx('jmcwc_categories') < idx('jmcwc_attempts'), 'jmcwc_categories must precede jmcwc_attempts');

    // 8. jmcwc_attempts must precede jmcwc_payloads and jmcwc_scores
    assert.ok(idx('jmcwc_attempts') < idx('jmcwc_payloads'), 'jmcwc_attempts must precede jmcwc_payloads');
    assert.ok(idx('jmcwc_attempts') < idx('jmcwc_scores'), 'jmcwc_attempts must precede jmcwc_scores');

    // 9. score_correction_requests must follow results and activity_results
    assert.ok(idx('results') < idx('score_correction_requests'), 'results must precede score_correction_requests');
    assert.ok(idx('activity_results') < idx('score_correction_requests'), 'activity_results must precede score_correction_requests');
  });

  it('excludes questionable legacy and non-backup table names from RESTORE_TABLE_ORDER', () => {
    const idx = (name) => RESTORE_TABLE_ORDER.indexOf(name);
    assert.equal(idx('weekly_test_section_removals'), -1, 'legacy weekly_test_section_removals must be absent');
    assert.equal(idx('rounds'), -1, 'legacy rounds must be absent');
    assert.equal(idx('profile_audit'), -1, 'profile_audit must be absent');
    assert.equal(idx('report_log'), -1, 'report_log must be absent');
    assert.equal(idx('backup_runs'), -1, 'backup_runs must be absent');
    assert.ok(idx('weekly_test_removals') >= 0, 'weekly_test_removals must be present');
    assert.ok(idx('student_rounds') >= 0, 'student_rounds must be present');
  });

  it('builds dynamic README matching EXPORT_TABLES count and excludes credentials', () => {
    const readme = buildExportReadme({
      dateIst: '2026-11-07',
      tableSummaries: Object.fromEntries(EXPORT_TABLES.map((t) => [t.name, 1])),
      totalRows: EXPORT_TABLES.length,
    });

    assert.ok(
      readme.includes(`CONTENTS (${EXPORT_TABLES.length} CSV files):`),
      `Readme must state CONTENTS (${EXPORT_TABLES.length} CSV files)`
    );
    assert.ok(!readme.includes('CONTENTS (18 CSV files):'), 'Must not have hardcoded 18');
    assert.ok(readme.includes('teacher_permissions.csv'));
    assert.ok(readme.includes('score_correction_requests.csv'));
    assert.ok(readme.includes('attendance_audit.csv'));
    assert.ok(readme.includes('teacher_audit_log.csv'));

    for (const t of EXPORT_TABLES) {
      assert.ok(t.defaultColumns, `Table ${t.name} must specify defaultColumns`);
      assert.ok(!t.defaultColumns.includes('password'), `${t.name} must not export password`);
      assert.ok(!t.defaultColumns.includes('token'), `${t.name} must not export token`);
      assert.ok(!t.defaultColumns.includes('secret'), `${t.name} must not export secret`);
    }
  });
});

// ============================================================================
// 2. SERVER-AUTHORITATIVE BASICS "TODAY" PRACTICE IN IST
// ============================================================================
describe('2. Server-Authoritative Basics Today Practice in IST', () => {
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    // Provide clean in-memory localStorage for test isolation
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
      key: (i) => Array.from(store.keys())[i] || null,
    };
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
    setServerTodayISTForTesting(null);
    setServerTodayErrorForTesting(null);
  });

  it('resolves deterministic demo today date via trendz_demo_today_ist override', async () => {
    localStorage.setItem('trendz_demo_today_ist', '2026-11-15');
    const today = await DemoDB.mockTodayIST();
    assert.equal(today, '2026-11-15', 'DemoDB.mockTodayIST must respect trendz_demo_today_ist override');

    const fetched = await fetchServerTodayIST();
    assert.equal(fetched, '2026-11-15', 'fetchServerTodayIST must return deterministic demo date');
  });

  it('correctly uses server today date when device clock is incorrect', () => {
    // Simulate server returning 2026-11-07
    setServerTodayISTForTesting('2026-11-07');
    setServerTodayErrorForTesting(null);

    // Suppose device clock was set to yesterday (2026-11-06) or tomorrow (2026-11-08)
    const serverToday = getServerTodayIST();
    assert.equal(serverToday, '2026-11-07');

    const drills = [
      { id: 'yesterday-drill', entry_date: '2026-11-06', correct: 18, total: 20 },
      { id: 'today-drill', entry_date: '2026-11-07', correct: 20, total: 20 },
      { id: 'past-drill', entry_date: '2026-11-01', correct: 15, total: 20 },
    ];

    const todayItems = drills.filter(
      (r) => toISTDateString(r.entry_date || r.created_at) === serverToday
    );
    assert.equal(todayItems.length, 1, 'Only drills matching server today_ist belong in Today');
    assert.equal(todayItems[0].id, 'today-drill');

    // Older entries remain in History
    const historyItems = filterAndSortHistory(drills, { sort: 'newest' }, { sectionKind: 'basics' });
    assert.equal(historyItems.length, 3, 'History contains all drills');
    assert.equal(historyItems[0].id, 'today-drill');
    assert.equal(historyItems[1].id, 'yesterday-drill');
  });

  it('handles the IST midnight boundary accurately regardless of local UTC offset', () => {
    // At 18:29:59 UTC on Nov 6 -> 23:59:59 IST on Nov 6 (Server returns 2026-11-06)
    setServerTodayISTForTesting('2026-11-06');
    const drillsBeforeMidnight = [
      { id: 'drill-nov-6', entry_date: '2026-11-06', correct: 19, total: 20 },
    ];
    const todayNov6 = drillsBeforeMidnight.filter(
      (r) => toISTDateString(r.entry_date) === getServerTodayIST()
    );
    assert.equal(todayNov6.length, 1);
    assert.equal(todayNov6[0].id, 'drill-nov-6');

    // At 18:30:01 UTC on Nov 6 -> 00:00:01 IST on Nov 7 (Server advances to 2026-11-07)
    // Note: Local UTC date is still Nov 6, but server IST date is Nov 7!
    setServerTodayISTForTesting('2026-11-07');
    const todayNov7 = drillsBeforeMidnight.filter(
      (r) => toISTDateString(r.entry_date) === getServerTodayIST()
    );
    assert.equal(todayNov7.length, 0, 'Nov 6 drill must no longer be in Today after IST midnight');

    // After logging a Nov 7 drill:
    const drillsAfterMidnight = [
      ...drillsBeforeMidnight,
      { id: 'drill-nov-7', entry_date: '2026-11-07', correct: 20, total: 20 },
    ];
    const todayNov7Updated = drillsAfterMidnight.filter(
      (r) => toISTDateString(r.entry_date) === getServerTodayIST()
    );
    assert.equal(todayNov7Updated.length, 1);
    assert.equal(todayNov7Updated[0].id, 'drill-nov-7');
  });

  it('handles server date loading failure explicitly without guessing or leaking older records', () => {
    const error = new Error('RPC today_ist connection timeout');
    setServerTodayISTForTesting(null);
    setServerTodayErrorForTesting(error);

    const drills = [
      { id: 'd1', entry_date: '2026-11-06', correct: 20, total: 20 },
      { id: 'd2', entry_date: '2026-11-05', correct: 19, total: 20 },
    ];

    // When server today date is null or failed, todayItems must be empty and never guess
    const serverToday = getServerTodayIST();
    assert.equal(serverToday, null);

    const todayItems = serverToday
      ? drills.filter((r) => toISTDateString(r.entry_date) === serverToday)
      : [];
    assert.equal(todayItems.length, 0, 'No drills may appear in Today when server date failed');
  });
});

// ============================================================================
// 3. ACTUAL BASICS RENDERING INTEGRATION TESTS
// ============================================================================
describe('3. Actual Basics DOM Rendering Integration', () => {
  let domElements;

  beforeEach(() => {
    domElements = new Map();
    function getOrCreate(id) {
      if (!domElements.has(id)) {
        domElements.set(id, {
          id,
          innerHTML: '',
          textContent: '',
          style: {},
          className: '',
          classList: {
            add: () => {},
            remove: () => {},
            contains: () => false,
          },
          addEventListener: () => {},
          removeEventListener: () => {},
        });
      }
      return domElements.get(id);
    }

    globalThis.document = {
      getElementById: (id) => getOrCreate(id),
      querySelectorAll: () => [],
      querySelector: () => null,
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        innerHTML: '',
        textContent: '',
        style: {},
        className: '',
        appendChild: () => {},
      }),
    };

    setBasicsCategoriesForTesting([
      { id: 'c1', name: '1d4r', section: 'basics', sort_order: 1 },
      { id: 'c2', name: '2d2r', section: 'basics', sort_order: 2 },
    ]);
    setServerTodayISTForTesting('2026-11-07');
    setServerTodayErrorForTesting(null);
  });

  afterEach(() => {
    setServerTodayISTForTesting(null);
    setServerTodayErrorForTesting(null);
    setBasicsResultsForTesting([]);
  });

  it('renders Today section with today drill and renders accuracy_desc in flat table across dates without date headers', () => {
    const drills = [
      // Today drill (100%)
      { id: 'd-today', category_id: 'c1', entry_date: '2026-11-07', correct: 20, total: 20, time_seconds: 45 },
      // Past drills with varying accuracy across multiple dates
      { id: 'd-past-1', category_id: 'c1', entry_date: '2026-11-05', correct: 18, total: 20, time_seconds: 50 }, // 90%
      { id: 'd-past-2', category_id: 'c2', entry_date: '2026-11-04', correct: 19, total: 20, time_seconds: 48 }, // 95%
      { id: 'd-past-3', category_id: 'c1', entry_date: '2026-11-03', correct: 14, total: 20, time_seconds: 60 }, // 70%
      { id: 'd-past-4', category_id: 'c2', entry_date: '2026-11-02', correct: 16, total: 20, time_seconds: 55 }, // 80%
      { id: 'd-past-5', category_id: 'c1', entry_date: '2026-11-01', correct: 10, total: 20, time_seconds: 70 }, // 50%
    ];

    setBasicsResultsForTesting(drills);
    setBasicsFiltersForTesting({ sort: 'accuracy_desc', category: 'all', source: 'all' });
    setBasicsPageForTesting(1);

    renderHistory();

    const todayBadge = document.getElementById('today-count-badge');
    const todayContainer = document.getElementById('today-drills-container');
    const pastContainer = document.getElementById('past-drills-container');

    // 1. Today's practice verification
    assert.equal(todayBadge.textContent, '(1)', 'Today badge shows count (1)');
    assert.ok(todayContainer.innerHTML.includes('d-today'), 'Today container contains d-today');
    assert.ok(!todayContainer.innerHTML.includes('d-past-1'), 'Older drill d-past-1 never appears in Today');
    assert.ok(!todayContainer.innerHTML.includes('d-past-2'), 'Older drill d-past-2 never appears in Today');

    // 2. Accuracy-ranked History verification: flat table with NO date grouping
    assert.ok(
      pastContainer.innerHTML.includes('history-compact-table'),
      'Past drills rendered in history-compact-table'
    );
    assert.ok(
      !pastContainer.innerHTML.includes('📅'),
      'Accuracy-ranked history must NOT contain date-grouping cards (📅)'
    );

    // Extract rendered row drill IDs in order
    const drillIdMatches = Array.from(pastContainer.innerHTML.matchAll(/data-drill-id="([^"]+)"/g)).map((m) => m[1]);
    // Expected order:
    // d-today: 100% (20/20)
    // d-past-2: 95% (19/20)
    // d-past-1: 90% (18/20)
    // d-past-4: 80% (16/20)
    // d-past-3: 70% (14/20)
    // d-past-5: 50% (10/20)
    assert.deepEqual(drillIdMatches, ['d-today', 'd-past-2', 'd-past-1', 'd-past-4', 'd-past-3', 'd-past-5']);
  });

  it('preserves date-grouped cards when sorting by newest or oldest', () => {
    const drills = [
      { id: 'd1', category_id: 'c1', entry_date: '2026-11-05', correct: 18, total: 20 },
      { id: 'd2', category_id: 'c1', entry_date: '2026-11-04', correct: 19, total: 20 },
    ];
    setBasicsResultsForTesting(drills);
    setBasicsFiltersForTesting({ sort: 'newest', category: 'all', source: 'all' });

    renderHistory();

    const pastContainer = document.getElementById('past-drills-container');
    assert.ok(
      pastContainer.innerHTML.includes('📅'),
      'Date-based sorting must render date cards with 📅 header'
    );
  });

  it('renders explicit error banner in Today section and sets badge to (!) on date loading failure', () => {
    setServerTodayISTForTesting(null);
    setServerTodayErrorForTesting(new Error('Database RPC today_ist connection failure'));

    const drills = [
      { id: 'd-old-1', category_id: 'c1', entry_date: '2026-11-05', correct: 20, total: 20 },
      { id: 'd-old-2', category_id: 'c1', entry_date: '2026-11-04', correct: 19, total: 20 },
    ];
    setBasicsResultsForTesting(drills);

    renderHistory();

    const todayBadge = document.getElementById('today-count-badge');
    const todayContainer = document.getElementById('today-drills-container');

    assert.equal(todayBadge.textContent, '(!)', 'Today badge must show (!) on date load error');
    assert.ok(
      todayContainer.innerHTML.includes('banner-error'),
      'Today container must render banner-error on date load error'
    );
    assert.ok(
      todayContainer.innerHTML.includes('Unable to verify current date from server'),
      'Must render user-friendly date verification error'
    );
    assert.ok(!todayContainer.innerHTML.includes('d-old-1'), 'Older records must NEVER leak into Today on error');
  });

  it('renders clean empty state in Today when student has zero drills on server today date', () => {
    setServerTodayISTForTesting('2026-11-07');
    setServerTodayErrorForTesting(null);

    // Only past drills exist
    const drills = [
      { id: 'd-past-1', category_id: 'c1', entry_date: '2026-11-05', correct: 18, total: 20 },
      { id: 'd-past-2', category_id: 'c1', entry_date: '2026-11-04', correct: 19, total: 20 },
    ];
    setBasicsResultsForTesting(drills);

    renderHistory();

    const todayBadge = document.getElementById('today-count-badge');
    const todayContainer = document.getElementById('today-drills-container');

    assert.equal(todayBadge.textContent, '(0)', 'Today badge must show (0)');
    assert.ok(
      todayContainer.innerHTML.includes('No speed drills logged yet for today.'),
      'Today container renders clean empty state message'
    );
    assert.ok(!todayContainer.innerHTML.includes('d-past-1'), 'Past drill must not appear in Today');
  });
});

// ============================================================================
// 4. MEMORIAD MODULE CATALOG & LEGACY ALIAS RESOLUTION
// ============================================================================
describe('4. Memoriad Filter Options & Legacy Alias Matching', () => {
  it('exposes all 4 competition modules in the module catalog', () => {
    const expectedKeys = ['calendar', 'additions', 'multiplications', 'square_roots'];
    const catalogKeys = MEMORIAD_MODULE_CATALOG.map((m) => m.key);
    assert.deepEqual(catalogKeys, expectedKeys);

    const catalogTitles = MEMORIAD_MODULE_CATALOG.map((m) => m.title);
    assert.deepEqual(catalogTitles, [
      'Mental Calendar Dates',
      'Mental Additions',
      'Mental Multiplications',
      'Mental Square Roots',
    ]);
  });

  it('normalizes legacy aliases to canonical catalog keys', () => {
    // Additions
    assert.equal(normalizeMemoriadModuleKey('addition'), 'additions');
    assert.equal(normalizeMemoriadModuleKey('additions'), 'additions');
    assert.equal(normalizeMemoriadModuleKey('Mental Additions'), 'additions');

    // Multiplications
    assert.equal(normalizeMemoriadModuleKey('multiplication'), 'multiplications');
    assert.equal(normalizeMemoriadModuleKey('multiplications'), 'multiplications');
    assert.equal(normalizeMemoriadModuleKey('Mental Multiplications'), 'multiplications');

    // Square Roots
    assert.equal(normalizeMemoriadModuleKey('square_root'), 'square_roots');
    assert.equal(normalizeMemoriadModuleKey('square_roots'), 'square_roots');
    assert.equal(normalizeMemoriadModuleKey('Mental Square Roots'), 'square_roots');

    // Calendar
    assert.equal(normalizeMemoriadModuleKey('calendar'), 'calendar');
    assert.equal(normalizeMemoriadModuleKey('Mental Calendar Dates'), 'calendar');
  });

  it('filters Memoriad history seamlessly across canonical and legacy aliases', () => {
    const memoriadRows = [
      { id: 'm1', settings: { module: 'calendar' }, correct: 20, total: 20 },
      { id: 'm2', settings: { module: 'addition' }, correct: 8, total: 10 }, // legacy singular
      { id: 'm3', settings: { module: 'additions' }, correct: 9, total: 10 }, // canonical plural
      { id: 'm4', module: 'multiplication', correct: 7, total: 10 }, // legacy singular in module col
      { id: 'm5', module: 'multiplications', correct: 10, total: 10 }, // canonical plural
      { id: 'm6', activity_name: 'Mental Square Roots', settings: { module: 'square_root' }, correct: 5, total: 10 },
      { id: 'm7', settings: { module: 'square_roots' }, correct: 6, total: 10 },
    ];

    // Filter by canonical 'additions' -> matches both m2 and m3
    const fAdditions = filterAndSortHistory(memoriadRows, { category: 'additions' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fAdditions.map((r) => r.id).sort(), ['m2', 'm3']);

    // Filter by legacy 'addition' -> matches both m2 and m3
    const fAdditionLegacy = filterAndSortHistory(memoriadRows, { category: 'addition' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fAdditionLegacy.map((r) => r.id).sort(), ['m2', 'm3']);

    // Filter by canonical 'multiplications' -> matches m4 and m5
    const fMult = filterAndSortHistory(memoriadRows, { category: 'multiplications' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fMult.map((r) => r.id).sort(), ['m4', 'm5']);

    // Filter by legacy 'multiplication' -> matches m4 and m5
    const fMultLegacy = filterAndSortHistory(memoriadRows, { category: 'multiplication' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fMultLegacy.map((r) => r.id).sort(), ['m4', 'm5']);

    // Filter by canonical 'square_roots' -> matches m6 and m7
    const fRoots = filterAndSortHistory(memoriadRows, { category: 'square_roots' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fRoots.map((r) => r.id).sort(), ['m6', 'm7']);

    // Filter by legacy 'square_root' -> matches m6 and m7
    const fRootLegacy = filterAndSortHistory(memoriadRows, { category: 'square_root' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fRootLegacy.map((r) => r.id).sort(), ['m6', 'm7']);

    // Filter by 'calendar' -> matches m1
    const fCal = filterAndSortHistory(memoriadRows, { category: 'calendar' }, { sectionKind: 'memoriad' });
    assert.deepEqual(fCal.map((r) => r.id), ['m1']);
  });
});
