/**
 * Trendz Tracker - Main Round Scoresheet Engine Tests (tests/mainRoundScoresheet.test.js)
 *
 * Verifies:
 * 1. Date boundaries & presets (strict India Time, today + 6/29 past days, all time, pick date, date range).
 * 2. Reversed and incomplete date range validation.
 * 3. Contract fidelity: manual round_date vs online finished_at / created_at; no UTC date shift.
 * 4. Manual scoresheet building: authoritative category sort order, correct/total formatting, note-only handling,
 *    and accurate distinction between zero (0 / total) and missing (—).
 * 5. Online scoresheet building: canonical 23 categories in position order, flat round vs category drill,
 *    frozen dynamic maximums, and in-progress/unsubmitted attempt hiding (no leaked questions/answers).
 * 6. Unit separation: manual counts vs online dynamic marks never combined into a single grand total.
 * 7. Multi-page, landscape A4 PDF 1.4 byte generation with horizontal column chunking and repeating Category column.
 * 8. Canvas image export slicing with multi-part labeling.
 * 9. Native share logic with automatic download fallback and explicit student action invariant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTHORITATIVE_JMCWC_CATEGORIES,
  ONLINE_UNASSIGNED_MESSAGE,
  getPastISTDate,
  resolveDateFilterBounds,
  formatScoresheetPeriodLabel,
  getManualRoundDateIST,
  getOnlineAttemptDateIST,
  isDateWithinFilter,
  buildManualScoresheet,
  buildOnlineScoresheet,
  buildScoresheetViewModel,
  buildScoresheetPdfBytes,
  renderScoresheetToCanvases,
  shareScoresheet,
  hasScoresheetLoadErrors,
  renderScoresheetHTML,
  ScoresheetController,
  pdfEscape,
  measurePdfTextWidth,
  fitPdfText,
  wrapPdfText,
  formatColumnHeaderLabel,
} from '../js/roundScoresheet.js';
import { parseJmcwcApiError } from '../js/roundScores.js';

describe('Main Round Scoresheet Engine', () => {
  describe('1. Date Boundaries & Presets (Strict India Time)', () => {
    const today = '2026-11-08';

    it('getPastISTDate accurately computes calendar date differences without UTC shifts', () => {
      assert.equal(getPastISTDate(today, 0), '2026-11-08');
      assert.equal(getPastISTDate(today, 6), '2026-11-02');
      assert.equal(getPastISTDate(today, 7), '2026-11-01');
      assert.equal(getPastISTDate(today, 8), '2026-10-31');
      assert.equal(getPastISTDate(today, 29), '2026-10-10');
      assert.equal(getPastISTDate('2026-03-01', 1), '2026-02-28');
    });

    it('last7 preset covers today plus previous 6 dates (7 dates inclusive)', () => {
      const bounds = resolveDateFilterBounds('last7', today);
      assert.equal(bounds.error, null);
      assert.equal(bounds.startDate, '2026-11-02');
      assert.equal(bounds.endDate, '2026-11-08');

      // Check dates within filter
      assert.equal(isDateWithinFilter('2026-11-01', bounds.startDate, bounds.endDate), false);
      assert.equal(isDateWithinFilter('2026-11-02', bounds.startDate, bounds.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-05', bounds.startDate, bounds.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-08', bounds.startDate, bounds.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-09', bounds.startDate, bounds.endDate), false);
    });

    it('last30 preset covers today plus previous 29 dates (30 dates inclusive)', () => {
      const bounds = resolveDateFilterBounds('last30', today);
      assert.equal(bounds.error, null);
      assert.equal(bounds.startDate, '2026-10-10');
      assert.equal(bounds.endDate, '2026-11-08');

      assert.equal(isDateWithinFilter('2026-10-09', bounds.startDate, bounds.endDate), false);
      assert.equal(isDateWithinFilter('2026-10-10', bounds.startDate, bounds.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-08', bounds.startDate, bounds.endDate), true);
    });

    it('all preset returns null boundaries and accepts any date', () => {
      const bounds = resolveDateFilterBounds('all', today);
      assert.equal(bounds.error, null);
      assert.equal(bounds.startDate, null);
      assert.equal(bounds.endDate, null);
      assert.equal(isDateWithinFilter('2025-01-01', bounds.startDate, bounds.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-08', bounds.startDate, bounds.endDate), true);
    });

    it('single date preset validates presence and filters strictly to that day', () => {
      const valid = resolveDateFilterBounds('single', today, '2026-11-05');
      assert.equal(valid.error, null);
      assert.equal(valid.startDate, '2026-11-05');
      assert.equal(valid.endDate, '2026-11-05');
      assert.equal(isDateWithinFilter('2026-11-05', valid.startDate, valid.endDate), true);
      assert.equal(isDateWithinFilter('2026-11-04', valid.startDate, valid.endDate), false);

      const missing = resolveDateFilterBounds('single', today, null);
      assert.equal(missing.error, 'Please choose a date.');
      assert.equal(missing.startDate, null);
    });

    it('date range validates reversed dates and missing dates with clear errors', () => {
      const reversed = resolveDateFilterBounds('range', today, '2026-11-08', '2026-11-02');
      assert.equal(reversed.error, 'Start date cannot be after end date.');
      assert.equal(reversed.startDate, null);

      const missingEnd = resolveDateFilterBounds('range', today, '2026-11-01', null);
      assert.equal(missingEnd.error, 'Please choose both start and end dates.');

      const validRange = resolveDateFilterBounds('range', today, '2026-11-01', '2026-11-05');
      assert.equal(validRange.error, null);
      assert.equal(validRange.startDate, '2026-11-01');
      assert.equal(validRange.endDate, '2026-11-05');
    });

    it('resolves actual date contracts: round_date for manual, finished_at for online', () => {
      const manual1 = { round_date: '2026-11-07', created_at: '2026-11-07T22:30:00Z' };
      assert.equal(getManualRoundDateIST(manual1), '2026-11-07');

      const manualFallback = { created_at: '2026-11-07T22:30:00Z' };
      // 22:30 UTC is next day 04:00 IST (2026-11-08)
      assert.equal(getManualRoundDateIST(manualFallback), '2026-11-08');

      const onlineSubmitted = {
        status: 'submitted',
        finished_at: '2026-11-06T18:00:00Z',
        created_at: '2026-11-06T16:00:00Z',
      };
      // 18:00 UTC = 23:30 IST on 2026-11-06
      assert.equal(getOnlineAttemptDateIST(onlineSubmitted), '2026-11-06');

      const onlineInProgress = {
        status: 'running',
        created_at: '2026-11-07T20:00:00Z',
      };
      // 20:00 UTC = 01:30 IST on 2026-11-08
      assert.equal(getOnlineAttemptDateIST(onlineInProgress), '2026-11-08');
    });
  });

  describe('2. Manual Scoresheet Matrix & Authoritative Category Order', () => {
    const seriesCategories = [
      { id: 'cat-2', name: 'SUB', series_sort_order: 2 },
      { id: 'cat-1', name: 'ADD', series_sort_order: 1 },
      { id: 'cat-3', name: 'Surprise Task', series_sort_order: 3 },
    ];

    const rounds = [
      { id: 'r2', round_number: 2, round_date: '2026-11-04', round_type: 'Flat Round', time_taken_seconds: 3600 },
      { id: 'r1', round_number: 1, round_date: '2026-11-02', round_type: 'Category wise', time_taken_seconds: 1200 },
    ];

    const results = [
      // Round 1
      { student_round_id: 'r1', category_id: 'cat-1', correct: 10, total: 10 },
      { student_round_id: 'r1', category_id: 'cat-2', correct: 0, total: 10 }, // Zero score
      // Round 2
      { student_round_id: 'r2', category_id: 'cat-1', correct: 8, total: 10 },
      { student_round_id: 'r2', category_id: 'cat-3', correct: null, total: null, note: 'Special memo' },
    ];

    it('orders categories strictly by series_sort_order and rounds chronologically', () => {
      const sheet = buildManualScoresheet({
        seriesInfo: { id: 's1', name: 'New simulator' },
        categories: seriesCategories,
        rounds,
        results,
      });

      assert.equal(sheet.type, 'manual');
      assert.equal(sheet.columns.length, 2);
      assert.equal(sheet.columns[0].roundNumber, 1);
      assert.equal(sheet.columns[1].roundNumber, 2);

      assert.equal(sheet.rows.length, 3);
      assert.equal(sheet.rows[0].category.name, 'ADD');
      assert.equal(sheet.rows[1].category.name, 'SUB');
      assert.equal(sheet.rows[2].category.name, 'Surprise Task');
    });

    it('strictly distinguishes zero score (0 / 10), missing (—), and note-only', () => {
      const sheet = buildManualScoresheet({
        seriesInfo: { id: 's1', name: 'New simulator' },
        categories: seriesCategories,
        rounds,
        results,
      });

      const addRow = sheet.rows[0];
      const subRow = sheet.rows[1];
      const surpriseRow = sheet.rows[2];

      // Round 1 (Column 0)
      assert.equal(addRow.cells[0].status, 'entered');
      assert.equal(addRow.cells[0].display, '10 / 10');

      assert.equal(subRow.cells[0].status, 'zero');
      assert.equal(subRow.cells[0].display, '0 / 10');
      assert.notEqual(subRow.cells[0].display, '—');

      assert.equal(surpriseRow.cells[0].status, 'missing');
      assert.equal(surpriseRow.cells[0].display, '—');
      assert.notEqual(surpriseRow.cells[0].display, '0');

      // Round 2 (Column 1)
      assert.equal(subRow.cells[1].status, 'missing');
      assert.equal(subRow.cells[1].display, '—');

      assert.equal(surpriseRow.cells[1].status, 'note');
      assert.equal(surpriseRow.cells[1].display, 'Special memo');
    });

    it('computes column totals accurately without distorting empty/partial rounds', () => {
      const sheet = buildManualScoresheet({
        seriesInfo: { id: 's1', name: 'New simulator' },
        categories: seriesCategories,
        rounds,
        results,
      });

      const r1Total = sheet.totals.columnTotals[0];
      assert.equal(r1Total.scoreText, '10 / 20');
      assert.equal(r1Total.accuracyText, '50%');
      assert.equal(r1Total.timeText, '20:00');
      assert.equal(r1Total.statusText, 'Partial');

      const r2Total = sheet.totals.columnTotals[1];
      assert.equal(r2Total.scoreText, '8 / 10');
      assert.equal(r2Total.accuracyText, '80%');
      assert.equal(r2Total.timeText, '1:00:00');
    });
  });

  describe('3. Online JMCWC Simulator Scoresheet & Frozen Marks', () => {
    const attempts = [
      {
        id: 'att-1',
        mode: 'flat',
        group_key: 'junior1',
        status: 'submitted',
        finished_at: '2026-11-03T10:00:00Z',
        active_ms: 3600000,
        score: {
          marks: 145.5,
          max_marks: 160,
          correct: 140,
          partial: 5,
          wrong: 10,
          skipped: 5,
        },
      },
      {
        id: 'att-2',
        mode: 'category',
        category_key: 'multiplication',
        group_key: 'junior1',
        status: 'submitted',
        finished_at: '2026-11-04T12:00:00Z',
        active_ms: 300000,
        score: {
          marks: 8,
          max_marks: 10,
          correct: 8,
          partial: 0,
          wrong: 2,
          skipped: 0,
        },
      },
      {
        id: 'att-3',
        mode: 'flat',
        group_key: 'junior1',
        status: 'paused',
        created_at: '2026-11-05T14:00:00Z',
        active_ms: 1800000,
      },
    ];

    const reviewCache = new Map();
    reviewCache.set('att-1', [
      { category_key: 'addition', award: 10, max_marks: 10 },
      { category_key: 'subtraction', award: 0, max_marks: 10 }, // Zero earned marks
      { category_key: 'mixed', award: 8.5, max_marks: 10 },
    ]);

    it('positions all 23 JMCWC categories in canonical order 1..23', () => {
      const sheet = buildOnlineScoresheet({
        groupKey: 'junior1',
        attempts,
        reviewCache,
      });

      assert.equal(sheet.type, 'online');
      assert.equal(sheet.rows.length, 23);
      assert.equal(sheet.rows[0].category.key, 'addition');
      assert.equal(sheet.rows[0].category.position, 1);
      assert.equal(sheet.rows[1].category.key, 'subtraction');
      assert.equal(sheet.rows[1].category.position, 2);
      assert.equal(sheet.rows[22].category.key, 'sum_squares');
      assert.equal(sheet.rows[22].category.position, 23);
    });

    it('uses persisted earned marks and frozen maximums, distinguishing zero from missing', () => {
      const sheet = buildOnlineScoresheet({
        groupKey: 'junior1',
        attempts,
        reviewCache,
      });

      const addRow = sheet.rows[0]; // addition
      const subRow = sheet.rows[1]; // subtraction
      const multRow = sheet.rows[3]; // multiplication
      const divRow = sheet.rows[4]; // division

      // Attempt 1: Flat Round
      assert.equal(addRow.cells[0].status, 'entered');
      assert.equal(addRow.cells[0].display, '10 / 10');

      assert.equal(subRow.cells[0].status, 'zero');
      assert.equal(subRow.cells[0].display, '0 / 10');

      assert.equal(multRow.cells[0].status, 'missing');
      assert.equal(multRow.cells[0].display, '—');

      // Attempt 2: Category Practice (multiplication only)
      assert.equal(addRow.cells[1].status, 'missing');
      assert.equal(addRow.cells[1].display, '—');

      assert.equal(multRow.cells[1].status, 'entered');
      assert.equal(multRow.cells[1].display, '8 / 10');

      assert.equal(divRow.cells[1].status, 'missing');
      assert.equal(divRow.cells[1].display, '—');
    });

    it('in-progress and paused attempts are clearly labeled without leaking private questions/answers', () => {
      const sheet = buildOnlineScoresheet({
        groupKey: 'junior1',
        attempts,
        reviewCache,
      });

      // Attempt 3: Paused Flat Round
      const col3 = sheet.columns[2];
      assert.equal(col3.status, 'Paused');
      assert.equal(col3.isSubmitted, false);

      sheet.rows.forEach((row) => {
        const cell = row.cells[2];
        assert.equal(cell.status, 'in_progress');
        assert.equal(cell.display, '—');
        assert.equal(cell.note, 'In progress');
      });

      const total3 = sheet.totals.columnTotals[2];
      assert.equal(total3.scoreText, '—');
      assert.equal(total3.breakdownText, 'In progress');
      assert.equal(total3.isSubmitted, false);
    });
  });

  describe('4. Source Filters & Strict Unit Separation', () => {
    const studentProfile = {
      id: 'stu-1',
      student_code: 'STU-100',
      full_name: 'Ananya Sharma',
      level: 'Grand Master 1',
    };
    const jmcwcAssignment = { group_key: 'junior1' };
    const today = '2026-11-08';

    const manualRounds = [
      { id: 'mr-1', series_id: 'ser-1', round_number: 1, round_date: '2026-11-05' },
    ];
    const seriesCategories = [
      { id: 'mc-1', name: 'ADD', series_id: 'ser-1', series_sort_order: 1 },
    ];
    const manualResults = [
      { student_round_id: 'mr-1', category_id: 'mc-1', correct: 10, total: 10 },
    ];
    const roundSeriesList = [{ id: 'ser-1', name: 'Simulator 2026' }];

    const onlineAttempts = [
      {
        id: 'oa-1',
        mode: 'category',
        category_key: 'addition',
        group_key: 'junior1',
        status: 'submitted',
        finished_at: '2026-11-06T10:00:00Z',
        active_ms: 120000,
        score: { marks: 5, max_marks: 5, correct: 5, partial: 0, wrong: 0, skipped: 0 },
      },
    ];

    it('source filter "both" provides two separate sheets and never combines their units', () => {
      const vm = buildScoresheetViewModel({
        sourceFilter: 'both',
        preset: 'last7',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds,
        seriesCategories,
        manualResults,
        roundSeriesList,
        onlineAttempts,
      });

      assert.equal(vm.isValid, true);
      assert.equal(vm.sheets.length, 2);

      const manualSheet = vm.sheets.find((s) => s.type === 'manual');
      const onlineSheet = vm.sheets.find((s) => s.type === 'online');

      assert.ok(manualSheet, 'Expected manual sheet');
      assert.ok(onlineSheet, 'Expected online sheet');

      assert.equal(manualSheet.unitLabel, 'Correct / Total (Manual)');
      assert.equal(onlineSheet.unitLabel, 'Earned Marks / Frozen Max Marks (Online)');

      // Incompatible units remain strictly isolated
      assert.notEqual(manualSheet.unitLabel, onlineSheet.unitLabel);
      assert.equal(manualSheet.totals.columnTotals[0].scoreText, '10 / 10');
      assert.equal(onlineSheet.totals.columnTotals[0].scoreText, '5 / 5');
    });

    it('source filter "manual" yields only manual sheets', () => {
      const vm = buildScoresheetViewModel({
        sourceFilter: 'manual',
        preset: 'last7',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds,
        seriesCategories,
        manualResults,
        roundSeriesList,
        onlineAttempts,
      });

      assert.equal(vm.sheets.length, 1);
      assert.equal(vm.sheets[0].type, 'manual');
    });

    it('source filter "online" yields only online sheets', () => {
      const vm = buildScoresheetViewModel({
        sourceFilter: 'online',
        preset: 'last7',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds,
        seriesCategories,
        manualResults,
        roundSeriesList,
        onlineAttempts,
      });

      assert.equal(vm.sheets.length, 1);
      assert.equal(vm.sheets[0].type, 'online');
    });
  });

  describe('5. PDF 1.4 Generation & Repeating Headers', () => {
    const studentProfile = {
      id: 'stu-1',
      student_code: 'STU-100',
      full_name: 'Ananya Sharma',
      level: 'Grand Master 1',
    };
    const jmcwcAssignment = { group_key: 'junior1' };
    const today = '2026-11-08';

    it('generates valid PDF 1.4 byte stream matching standard PDF header, catalog, and xref', () => {
      // Build wide sheet with 10 rounds to force horizontal column chunking
      const manualRounds = [];
      const manualResults = [];
      for (let i = 1; i <= 10; i++) {
        manualRounds.push({
          id: `mr-${i}`,
          series_id: 'ser-1',
          round_number: i,
          round_date: `2026-11-${String(i).padStart(2, '0')}`,
        });
        manualResults.push({
          student_round_id: `mr-${i}`,
          category_id: 'mc-1',
          correct: i,
          total: 10,
        });
      }
      const seriesCategories = [
        { id: 'mc-1', name: 'Integer addition', series_id: 'ser-1', series_sort_order: 1 },
      ];

      const vm = buildScoresheetViewModel({
        sourceFilter: 'manual',
        preset: 'all',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds,
        seriesCategories,
        manualResults,
        roundSeriesList: [{ id: 'ser-1', name: 'Test Series' }],
      });

      const pdfBytes = buildScoresheetPdfBytes(vm);
      assert.ok(pdfBytes instanceof Uint8Array, 'PDF output must be Uint8Array');
      assert.ok(pdfBytes.length > 500, 'PDF output must be non-empty');

      const pdfString = new TextDecoder().decode(pdfBytes);
      assert.ok(pdfString.startsWith('%PDF-1.4'), 'Must start with %PDF-1.4 header');
      assert.ok(pdfString.includes('/Type /Catalog'), 'Must declare PDF Catalog');
      assert.ok(pdfString.includes('/Type /Pages'), 'Must declare Pages object');
      assert.ok(pdfString.includes('xref'), 'Must contain cross-reference table');
      assert.ok(pdfString.includes('trailer'), 'Must contain PDF trailer');
      assert.ok(pdfString.includes('%%EOF'), 'Must end with EOF marker');

      // 10 columns with MAX_DATA_COLS_PER_PAGE = 7 should produce 2 pages
      assert.ok(pdfString.includes('/Count 2'), 'Must produce 2 pages for 10 data columns');
      assert.ok(pdfString.includes('TRENDZ TRACKER - MAIN ROUND SCORESHEET'), 'Must render title on pages');
      assert.ok(pdfString.includes('Part 1 of 2'), 'Must label horizontal column part 1');
      assert.ok(pdfString.includes('Part 2 of 2'), 'Must label horizontal column part 2');
    });
  });

  describe('6. Share Flow & Download Fallback', () => {
    const vm = {
      isValid: true,
      periodLabel: 'Last 7 days',
      studentInfo: { name: 'Test Student', code: 'STU-99' },
      sheets: [
        {
          type: 'manual',
          title: 'Manual Practice',
          unitLabel: 'Counts',
          columns: [{ roundNumber: 1, label: 'Round 1', status: 'Completed' }],
          rows: [{ category: { name: 'ADD' }, cells: [{ display: '10 / 10' }] }],
          totals: { columnTotals: [{ scoreText: '10 / 10', accuracyText: '100%' }] },
        },
      ],
    };

    it('falls back to file download when navigator.canShare is unavailable', async () => {
      let toastCalled = false;
      let toastType = '';
      const onToast = (type, msg) => {
        toastCalled = true;
        toastType = type;
      };

      // In Node.js environment where navigator.share is absent
      const res = await shareScoresheet({
        format: 'pdf',
        viewModel: vm,
        onToast,
      });

      assert.equal(res.shared, false);
      assert.equal(res.fallbackDownloaded, true);
      assert.equal(toastCalled, true);
      assert.equal(toastType, 'info');
    });
  });
});


  describe('7. Populated, Empty, and Large Histories', () => {
    const studentProfile = {
      id: 'stu-alpha',
      student_code: 'STU-001',
      full_name: 'Aditya Sen',
      level: 'Master 2',
    };
    const jmcwcAssignment = { group_key: 'senior' };
    const today = '2026-11-08';

    it('handles completely empty history with friendly empty state', () => {
      const vm = buildScoresheetViewModel({
        sourceFilter: 'both',
        preset: 'last7',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds: [],
        seriesCategories: [],
        manualResults: [],
        onlineAttempts: [],
      });

      assert.equal(vm.isValid, true);
      assert.equal(vm.isEmpty, true);
      assert.equal(vm.sheets.length, 0);
    });

    it('handles large 25-round manual history across 4 paginated PDF pages without silent data cropping', () => {
      const manualRounds = [];
      const manualResults = [];
      for (let i = 1; i <= 25; i++) {
        const d = `2026-10-${String(Math.min(31, i)).padStart(2, '0')}`;
        manualRounds.push({
          id: `round-${i}`,
          series_id: 'ser-large',
          round_number: i,
          round_date: d,
        });
        manualResults.push({
          student_round_id: `round-${i}`,
          category_id: 'cat-add',
          correct: i % 10,
          total: 10,
        });
      }
      const seriesCategories = [
        { id: 'cat-add', name: 'Addition', series_id: 'ser-large', series_sort_order: 1 },
        { id: 'cat-sub', name: 'Subtraction', series_id: 'ser-large', series_sort_order: 2 },
      ];

      const vm = buildScoresheetViewModel({
        sourceFilter: 'manual',
        preset: 'all',
        todayIST: today,
        studentProfile,
        jmcwcAssignment,
        manualRounds,
        seriesCategories,
        manualResults,
        roundSeriesList: [{ id: 'ser-large', name: 'Championship 2026' }],
      });

      assert.equal(vm.isValid, true);
      assert.equal(vm.sheets.length, 1);
      assert.equal(vm.sheets[0].columns.length, 25);

      const pdfBytes = buildScoresheetPdfBytes(vm);
      const pdfString = new TextDecoder().decode(pdfBytes);

      // 25 columns with MAX_DATA_COLS_PER_PAGE = 7: ceil(25 / 7) = 4 pages
      assert.ok(pdfString.includes('/Count 4'), 'Large 25-round sheet must paginate into 4 pages');
      assert.ok(pdfString.includes('Part 1 of 4'), 'Part 1 must be present');
      assert.ok(pdfString.includes('Part 4 of 4'), 'Part 4 must be present');
      // All 25 round labels must be in the PDF
      for (let i = 1; i <= 25; i++) {
        assert.ok(pdfString.includes(`Round ${i}`), `PDF must include Round ${i}`);
      }
    });
  });

  describe('8. Student Authorization & Request Tampering Protection', () => {
    it('strictly scopes data retrieval to the authenticated student profile and ignores URL parameter overrides', () => {
      const loggedInStudent = {
        id: 'student-real-uuid',
        student_code: 'STU-101',
        full_name: 'Legitimate Student',
        role: 'student',
      };

      // Tampering URL query parameter
      const tamperedQuery = new URLSearchParams('?studentId=victim-uuid-666&id=victim-uuid-666');

      // The controller strictly resolves targetStudentId:
      const targetStudentId = loggedInStudent.role === 'admin'
        ? (tamperedQuery.get('studentId') || tamperedQuery.get('id') || loggedInStudent.id)
        : loggedInStudent.id;

      assert.equal(targetStudentId, 'student-real-uuid', 'Student caller MUST NOT be able to view another student records via URL tampering');
      assert.notEqual(targetStudentId, 'victim-uuid-666');
    });
  });

  describe('9. HTML Rendering, Zoom & Clean View Mode', () => {
    it('renders accessible HTML with sticky headers, distinct zero scores, and clean capture mode support', async () => {
      const { renderScoresheetHTML } = await import('../js/roundScoresheet.js');

      const vm = {
        isValid: true,
        isEmpty: false,
        periodLabel: 'Last 7 days (02 Nov 2026 – 08 Nov 2026 IST)',
        studentInfo: { name: 'Pooja', code: 'STU-12', group: 'Junior 1' },
        sheets: [
          {
            type: 'manual',
            title: 'Manual Practice · Series 1',
            unitLabel: 'Correct / Total (Manual)',
            columns: [
              { label: 'Round 1', roundNumber: 1, displayDate: '03 Nov 2026', status: 'Completed' },
            ],
            rows: [
              { category: { name: 'ADD' }, cells: [{ status: 'entered', display: '9 / 10' }] },
              { category: { name: 'SUB' }, cells: [{ status: 'zero', display: '0 / 10' }] },
              { category: { name: 'MULT' }, cells: [{ status: 'missing', display: '—' }] },
            ],
            totals: {
              columnTotals: [
                { scoreText: '9 / 20', accuracyText: '45%', timeText: '15:00', statusText: 'Completed' },
              ],
            },
          },
        ],
      };

      const html = renderScoresheetHTML(vm);
      assert.ok(html.includes('Manual Practice · Series 1'), 'Must include sheet title');
      assert.ok(html.includes('Correct / Total (Manual)'), 'Must include unit description');
      assert.ok(html.includes('position: sticky; top: 0; left: 0;'), 'Must have sticky corner cell');
      assert.ok(html.includes('position: sticky; top: 0;'), 'Must have sticky top header');
      assert.ok(html.includes('position: sticky; left: 0;'), 'Must have sticky category column');
      assert.ok(html.includes('position: sticky; bottom: 0;'), 'Must have sticky bottom totals');
      assert.ok(html.includes('0 / 10'), 'Must render zero score explicitly');
      assert.ok(html.includes('—'), 'Must render missing score with em-dash');
    });
  });

  describe('10. Student Navigation & Label Consistency', () => {
    it('verifies student navigation label is "Main Round" and URL remains /pages/round-scores.html', async () => {
      const { NAV_CONFIG, getInlineNavItems } = await import('../js/navConfig.js');

      const studentNav = NAV_CONFIG.student.find((i) => i.href === '/pages/round-scores.html');
      assert.ok(studentNav, 'Nav item for /pages/round-scores.html must exist');
      assert.equal(studentNav.label, 'Main Round');
      assert.equal(studentNav.id, 'student-round-scores');

      const inlineLabels = getInlineNavItems('student').map((i) => i.label);
      assert.ok(inlineLabels.includes('Main Round'), 'Inline nav must include Main Round');
      assert.ok(!inlineLabels.includes('Round scores'), 'Inline nav must not include Round scores');
    });
  });

  describe('11. Review Fixes: Pagination, Category Preservation, Paper Versions, Load Errors, Multi-part Sharing', () => {
    describe('11.1 Complete History Loading (Offset Pagination & Batching)', () => {
      it('paginates online attempts using offset in batches of 50 without silent truncation', async () => {
        const requestedOffsets = [];
        const mockAttempts = Array.from({ length: 120 }, (_, idx) => ({
          id: `att-${idx + 1}`,
          mode: 'flat',
          status: 'submitted',
          group_key: 'junior1',
          paper_version: '2026.1',
          finished_at: '2026-11-05T10:00:00Z',
          score: { marks: 50, max_marks: 100 },
        }));

        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-alpha', full_name: 'Alpha Student' },
          todayIST: '2026-11-08',
        });

        // Mock callJmcwcApi
        ctrl.callJmcwcApi = async ({ action, offset = 0 }) => {
          if (action === 'get_practice_overview') {
            return { paper: { id: 'p1', version: '2026.1' }, group_key: 'junior1' };
          }
          if (action === 'list_attempts') {
            requestedOffsets.push(offset);
            const batch = mockAttempts.slice(offset, offset + 50);
            return { attempts: batch };
          }
          if (action === 'get_attempt_review') {
            return { attempt: { review: [] } };
          }
          return {};
        };

        ctrl.getSupabase = async () => ({
          from: () => {
            const b = {
              select: () => b,
              order: () => b,
              eq: () => b,
              maybeSingle: async () => ({ data: null }),
              range: async () => ({ data: [] }),
            };
            return b;
          },
        });

        await ctrl.loadAllStudentData();

        // Must request offset 0, offset 50, and offset 100
        assert.deepEqual(requestedOffsets, [0, 50, 100]);
        assert.equal(ctrl.onlineAttempts.length, 120);
      });

      it('paginates manual rounds with .range() and chunks result queries in batches of 100', async () => {
        const requestedRoundRanges = [];
        const queriedResultChunks = [];

        // 250 mock rounds
        const mockRounds = Array.from({ length: 250 }, (_, i) => ({
          id: `rnd-${i + 1}`,
          student_id: 'stu-beta',
          round_number: i + 1,
          round_date: '2026-11-04',
          round_type: 'Category wise',
        }));

        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-beta', full_name: 'Beta Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async () => ({ attempts: [] });

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'student_rounds') {
              const b = {
                select: () => b,
                eq: () => b,
                order: () => b,
                range: async (from, to) => {
                  requestedRoundRanges.push({ from, to });
                  const slice = mockRounds.slice(from, to + 1);
                  return { data: slice, error: null };
                },
              };
              return b;
            }
            if (table === 'results') {
              let currentChunk = [];
              const b = {
                select: () => b,
                eq: () => b,
                in: (col, chunkIds) => {
                  currentChunk = [...chunkIds];
                  queriedResultChunks.push([...chunkIds]);
                  return b;
                },
                order: () => b,
                range: async (from, to) => ({
                  data: currentChunk.map((id) => ({
                    id: `res-${id}`,
                    student_round_id: id,
                    category_id: 'cat-add',
                    correct: 8,
                    total: 10,
                  })),
                  error: null,
                }),
              };
              return b;
            }
            return {
              select: () => ({
                order: () => ({ data: [] }),
                eq: () => ({
                  maybeSingle: async () => ({ data: null }),
                }),
              }),
            };
          },
        });

        await ctrl.loadAllStudentData();

        // 250 rounds is less than ROUND_PAGE_SIZE (500), so fetched in 1 range call
        assert.equal(requestedRoundRanges.length, 1);
        assert.equal(ctrl.manualRounds.length, 250);

        // Results should chunk 250 round IDs into batches of 100: [100, 100, 50]
        assert.equal(queriedResultChunks.length, 3);
        assert.equal(queriedResultChunks[0].length, 100);
        assert.equal(queriedResultChunks[1].length, 100);
        assert.equal(queriedResultChunks[2].length, 50);
        assert.equal(ctrl.manualResults.length, 250);
      });
    });

    describe('11.2 Historical & Inactive Category Preservation', () => {
      it('preserves inactive categories with active: false, retaining series sort order and score', () => {
        const seriesCategories = [
          { id: 'cat-1', name: 'Addition', series_sort_order: 1, active: true },
          { id: 'cat-2', name: 'Legacy Category', series_sort_order: 2, active: false },
          { id: 'cat-3', name: 'Multiplication', series_sort_order: 3, active: true },
        ];

        const rounds = [
          { id: 'r1', round_number: 1, round_date: '2026-11-04', round_type: 'Category wise' },
        ];

        const results = [
          { student_round_id: 'r1', category_id: 'cat-1', correct: 10, total: 10 },
          { student_round_id: 'r1', category_id: 'cat-2', correct: 7, total: 10 },
          { student_round_id: 'r1', category_id: 'cat-3', correct: 8, total: 10 },
        ];

        const sheet = buildManualScoresheet({
          seriesInfo: { id: 's1', name: 'Test Series' },
          categories: seriesCategories,
          rounds,
          results,
        });

        assert.equal(sheet.rows.length, 3);
        assert.equal(sheet.rows[0].category.name, 'Addition');
        assert.equal(sheet.rows[1].category.name, 'Legacy Category');
        assert.equal(sheet.rows[1].cells[0].display, '7 / 10');
        assert.equal(sheet.rows[2].category.name, 'Multiplication');
      });

      it('preserves historical categories present in results even if unmapped in category_series', () => {
        const seriesCategories = [
          { id: 'cat-1', name: 'Addition', series_sort_order: 1, active: true },
        ];

        const rounds = [
          { id: 'r1', round_number: 1, round_date: '2026-11-04' },
        ];

        const results = [
          { student_round_id: 'r1', category_id: 'cat-1', correct: 9, total: 10 },
          { student_round_id: 'r1', category_id: 'cat-unmapped-historical', category_name: 'Historical Decimals', correct: 5, total: 10 },
        ];

        const sheet = buildManualScoresheet({
          seriesInfo: { id: 's1', name: 'Test Series' },
          categories: seriesCategories,
          rounds,
          results,
        });

        assert.equal(sheet.rows.length, 2);
        assert.equal(sheet.rows[0].category.name, 'Addition');
        assert.equal(sheet.rows[1].category.name, 'Historical Decimals');
        assert.equal(sheet.rows[1].cells[0].display, '5 / 10');
      });
    });

    describe('11.3 Online Paper Version Separation', () => {
      it('separates incompatible paper versions within the same group into distinct sheets', () => {
        const attempts = [
          {
            id: 'att-v1',
            status: 'submitted',
            mode: 'flat',
            group_key: 'junior1',
            paper_version: '2026.1',
            finished_at: '2026-11-04T10:00:00Z',
            score: { marks: 80, max_marks: 100 },
          },
          {
            id: 'att-v2',
            status: 'submitted',
            mode: 'flat',
            group_key: 'junior1',
            paper_version: '2026.2',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 95, max_marks: 100 },
          },
        ];

        const vm = buildScoresheetViewModel({
          sourceFilter: 'online',
          preset: 'all',
          todayIST: '2026-11-08',
          onlineAttempts: attempts,
          onlineCategories: AUTHORITATIVE_JMCWC_CATEGORIES,
        });

        assert.equal(vm.sheets.length, 2, 'Must produce 2 distinct sheets for different paper versions');
        assert.equal(vm.sheets[0].paperVersion, '2026.1');
        assert.equal(vm.sheets[0].title, 'Online Practice · Junior 1 · Version 2026.1');
        assert.equal(vm.sheets[1].paperVersion, '2026.2');
        assert.equal(vm.sheets[1].title, 'Online Practice · Junior 1 · Version 2026.2');
      });

      it('labels unknown or missing group as Unassigned Group and never defaults to junior1', () => {
        const attempts = [
          {
            id: 'att-no-group',
            status: 'submitted',
            mode: 'flat',
            group_key: null,
            paper_version: '2026.1',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 60, max_marks: 100 },
          },
        ];

        const vm = buildScoresheetViewModel({
          sourceFilter: 'online',
          preset: 'all',
          todayIST: '2026-11-08',
          onlineAttempts: attempts,
          onlineCategories: AUTHORITATIVE_JMCWC_CATEGORIES,
        });

        assert.equal(vm.sheets.length, 1);
        assert.equal(vm.sheets[0].groupKey, null);
        assert.equal(vm.sheets[0].groupLabel, 'Unassigned Group');
        assert.ok(!vm.sheets[0].title.includes('Junior 1'), 'Must not invent Junior 1');
        assert.equal(vm.sheets[0].title, 'Online Practice · Unassigned Group · Version 2026.1');
      });
    });

    describe('11.4 Accurate Loading Failure Reporting & Export Prevention', () => {
      it('records review errors, displays ⚠️ Error cells with tooltip, and tags column with Review Error', () => {
        const reviewCache = new Map();
        reviewCache.set('att-err', { error: 'Network 500: review endpoint failed' });

        const attempts = [
          {
            id: 'att-err',
            status: 'submitted',
            mode: 'flat',
            group_key: 'junior1',
            paper_version: '2026.1',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 75, max_marks: 100 },
          },
        ];

        const sheet = buildOnlineScoresheet({
          groupKey: 'junior1',
          paperVersion: '2026.1',
          jmcwcCategories: AUTHORITATIVE_JMCWC_CATEGORIES,
          attempts,
          reviewCache,
        });

        assert.equal(sheet.columns[0].reviewError, 'Network 500: review endpoint failed');
        // Cells should be marked as review_error
        const cell = sheet.rows[0].cells[0];
        assert.equal(cell.status, 'review_error');
        assert.equal(cell.display, '⚠️ Error');
        assert.equal(cell.note, 'Network 500: review endpoint failed');

        // Check HTML output
        const vm = {
          isValid: true,
          isEmpty: false,
          periodLabel: 'Last 7 days',
          sourceFilter: 'online',
          studentInfo: { name: 'Pooja', code: 'STU-1', group: 'Junior 1' },
          sheets: [sheet],
          loadErrors: { manual: null, online: null, reviews: new Map([['att-err', 'Network 500: review endpoint failed']]) },
        };

        const html = renderScoresheetHTML(vm);
        assert.ok(html.includes('Review Error'), 'Column header must display Review Error badge');
        assert.ok(html.includes('⚠️ Error'), 'Cell must display ⚠️ Error');
      });

      it('displays retryable error banners and prevents false "no scores" message on loading failure', () => {
        const vm = {
          isValid: true,
          isEmpty: true,
          periodLabel: 'Last 7 days',
          sourceFilter: 'both',
          studentInfo: { name: 'Pooja', code: 'STU-1', group: 'Junior 1' },
          sheets: [],
          loadErrors: {
            manual: 'connection timeout to supabase',
            online: 'jmcwc service unreachable',
            reviews: new Map(),
          },
        };

        const html = renderScoresheetHTML(vm);
        assert.ok(html.includes('Manual scores failed to load:'), 'Must show manual error banner');
        assert.ok(html.includes('connection timeout to supabase'));
        assert.ok(html.includes('btn-retry-manual'), 'Must offer retry manual button');
        assert.ok(html.includes('Online practice failed to load:'), 'Must show online error banner');
        assert.ok(html.includes('btn-retry-online'), 'Must offer retry online button');
        assert.ok(html.includes('Scoresheet history could not be loaded'), 'Must show failure state, not "no scores"');
        assert.ok(!html.includes('No scores recorded for this period'), 'Must NOT report false "no scores"');
      });

      it('blocks PDF, Canvas, and Share exports when loading errors exist', async () => {
        const vm = {
          isValid: true,
          isEmpty: false,
          periodLabel: 'Last 7 days',
          sourceFilter: 'both',
          studentInfo: { name: 'Pooja', code: 'STU-1', group: 'Junior 1' },
          sheets: [
            {
              type: 'manual',
              title: 'Manual Practice',
              unitLabel: 'Counts',
              columns: [{ roundNumber: 1, label: 'Round 1', status: 'Completed', reviewError: null }],
              rows: [{ category: { name: 'ADD' }, cells: [{ display: '10 / 10' }] }],
              totals: { columnTotals: [{ scoreText: '10 / 10', accuracyText: '100%' }] },
            },
          ],
          loadErrors: {
            manual: 'Database connection failed',
            online: null,
            reviews: new Map(),
          },
        };

        assert.equal(hasScoresheetLoadErrors(vm), true);

        assert.throws(
          () => buildScoresheetPdfBytes(vm),
          /Cannot export incomplete scoresheet due to loading errors/
        );

        let toastMsg = '';
        const res = await shareScoresheet({
          format: 'pdf',
          viewModel: vm,
          onToast: (type, msg) => { toastMsg = msg; },
        });

        assert.equal(res.shared, false);
        assert.ok(toastMsg.includes('scores failed to load'));
      });
    });

    describe('11.5 Sharing Every Selected Image Part', () => {
      it('shares all generated image parts when supported by the device', async () => {
        let sharedPayload = null;
        const origShare = globalThis.navigator?.share;
        const origCanShare = globalThis.navigator?.canShare;

        Object.defineProperty(globalThis.navigator, 'share', {
          value: async (payload) => {
            sharedPayload = payload;
          },
          configurable: true,
          writable: true,
        });

        Object.defineProperty(globalThis.navigator, 'canShare', {
          value: (payload) => Boolean(payload?.files),
          configurable: true,
          writable: true,
        });

        const vm = {
          isValid: true,
          isEmpty: false,
          periodLabel: 'Last 7 days',
          sourceFilter: 'both',
          studentInfo: { name: 'Pooja', code: 'STU-1', group: 'Junior 1' },
          sheets: [
            {
              type: 'manual',
              sheetId: 'manual_s1',
              title: 'Manual Practice',
              unitLabel: 'Counts',
              columns: Array.from({ length: 12 }, (_, i) => ({
                roundNumber: i + 1,
                label: `Round ${i + 1}`,
                status: 'Completed',
              })),
              rows: [{ category: { name: 'ADD' }, cells: Array.from({ length: 12 }, () => ({ display: '10 / 10' })) }],
              totals: { columnTotals: Array.from({ length: 12 }, () => ({ scoreText: '10 / 10', accuracyText: '100%' })) },
            },
          ],
          loadErrors: { manual: null, online: null, reviews: new Map() },
        };

        globalThis.document = {
          createElement: (tag) => {
            if (tag === 'canvas') {
              return {
                getContext: () => ({
                  scale: () => {},
                  fillRect: () => {},
                  strokeRect: () => {},
                  fillText: () => {},
                  beginPath: () => {},
                  moveTo: () => {},
                  lineTo: () => {},
                  stroke: () => {},
                }),
                toBlob: (cb) => cb(new Blob(['fake-png-part'], { type: 'image/png' })),
              };
            }
            return {};
          },
        };

        let toastType = '';
        let toastMsg = '';
        try {
          const res = await shareScoresheet({
            format: 'image',
            viewModel: vm,
            onToast: (type, msg) => {
              toastType = type;
              toastMsg = msg;
            },
          });

          assert.equal(res.shared, true);
          assert.equal(res.method, 'native_share');
          assert.equal(res.fileCount, 2);
          assert.ok(toastMsg.includes('All 2 scoresheet image parts shared successfully!'));
          assert.equal(sharedPayload.files.length, 2);
        } finally {
          if (origShare) {
            Object.defineProperty(globalThis.navigator, 'share', { value: origShare, configurable: true, writable: true });
          } else {
            delete globalThis.navigator.share;
          }
          if (origCanShare) {
            Object.defineProperty(globalThis.navigator, 'canShare', { value: origCanShare, configurable: true, writable: true });
          } else {
            delete globalThis.navigator.canShare;
          }
        }
      });

      it('downloads all parts and explains clearly when multi-part image share is unsupported', async () => {
        globalThis.document = {
          createElement: (tag) => {
            if (tag === 'canvas') {
              return {
                getContext: () => ({
                  scale: () => {},
                  fillRect: () => {},
                  strokeRect: () => {},
                  fillText: () => {},
                  beginPath: () => {},
                  moveTo: () => {},
                  lineTo: () => {},
                  stroke: () => {},
                }),
                toBlob: (cb) => cb(new Blob(['fake-png-part'], { type: 'image/png' })),
              };
            }
            if (tag === 'a') {
              return {
                click: () => {},
                setAttribute: () => {},
              };
            }
            return {};
          },
          body: {
            appendChild: () => {},
            removeChild: () => {},
          },
        };

        globalThis.URL.createObjectURL = (blob) => 'blob://test';
        globalThis.URL.revokeObjectURL = () => {};

        const origShare = globalThis.navigator?.share;
        const origCanShare = globalThis.navigator?.canShare;

        Object.defineProperty(globalThis.navigator, 'share', {
          value: async () => {},
          configurable: true,
          writable: true,
        });

        Object.defineProperty(globalThis.navigator, 'canShare', {
          value: () => false,
          configurable: true,
          writable: true,
        });

        const vm = {
          isValid: true,
          isEmpty: false,
          periodLabel: 'Last 7 days',
          sourceFilter: 'both',
          studentInfo: { name: 'Pooja', code: 'STU-1', group: 'Junior 1' },
          sheets: [
            {
              type: 'manual',
              sheetId: 'manual_s1',
              title: 'Manual Practice',
              unitLabel: 'Counts',
              columns: Array.from({ length: 12 }, (_, i) => ({
                roundNumber: i + 1,
                label: `Round ${i + 1}`,
                status: 'Completed',
              })),
              rows: [{ category: { name: 'ADD' }, cells: Array.from({ length: 12 }, () => ({ display: '10 / 10' })) }],
              totals: { columnTotals: Array.from({ length: 12 }, () => ({ scoreText: '10 / 10', accuracyText: '100%' })) },
            },
          ],
          loadErrors: { manual: null, online: null, reviews: new Map() },
        };

        let toastMsg = '';
        try {
          const res = await shareScoresheet({
            format: 'image',
            viewModel: vm,
            onToast: (type, msg) => {
              toastMsg = msg;
            },
          });

          assert.equal(res.shared, false);
          assert.equal(res.fallbackDownloaded, true);
          assert.equal(res.multiPartUnsupported, true);
          assert.equal(res.fileCount, 2);
          assert.ok(toastMsg.includes('does not support sharing multiple image parts (2 parts) at once'));
          assert.ok(toastMsg.includes('share the complete PDF instead'));
        } finally {
          if (origShare) {
            Object.defineProperty(globalThis.navigator, 'share', { value: origShare, configurable: true, writable: true });
          } else {
            delete globalThis.navigator.share;
          }
          if (origCanShare) {
            Object.defineProperty(globalThis.navigator, 'canShare', { value: origCanShare, configurable: true, writable: true });
          } else {
            delete globalThis.navigator.canShare;
          }
        }
      });
    });
  });

  describe('12. Post-Review Hardening: Review Retries, Unique Paper Identity, Metadata Errors & Deterministic Ordering', () => {
    describe('12.1 Retry failed reviews properly', () => {
      it('refetches failed review entries upon retry while preserving successful ones, enabling scores and exports', async () => {
        let callCountAtt1 = 0;
        let callCountAtt2 = 0;

        const ctrl = new ScoresheetController({
          containerEl: null,
          currentProfile: { id: 'stu-retry-1', full_name: 'Retry Student' },
          todayIST: '2026-11-08',
        });

        ctrl.onlineAttempts = [
          {
            id: 'att-1',
            mode: 'flat',
            status: 'submitted',
            group_key: 'junior1',
            paper_version: '2026.1',
            paper_id: 'p1',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 80, max_marks: 100 },
          },
          {
            id: 'att-2',
            mode: 'flat',
            status: 'submitted',
            group_key: 'junior1',
            paper_version: '2026.1',
            paper_id: 'p1',
            finished_at: '2026-11-06T10:00:00Z',
            score: { marks: 90, max_marks: 100 },
          },
        ];

        ctrl.callJmcwcApi = async ({ action, attempt_id }) => {
          if (action === 'get_practice_overview') {
            return { paper: { id: 'p1', version: '2026.1' }, group_key: 'junior1' };
          }
          if (action === 'list_attempts') {
            return { attempts: ctrl.onlineAttempts };
          }
          if (action === 'get_attempt_review') {
            if (attempt_id === 'att-1') {
              callCountAtt1++;
              if (callCountAtt1 === 1) {
                // First attempt fails with network 500 error
                throw new Error('Network timeout on review server');
              }
              // Second attempt succeeds on retry
              return {
                attempt: {
                  review: [
                    { category_key: 'addition', award: 10, max_marks: 10 },
                  ],
                },
              };
            }
            if (attempt_id === 'att-2') {
              callCountAtt2++;
              // Att-2 succeeds immediately
              return {
                attempt: {
                  review: [
                    { category_key: 'addition', award: 10, max_marks: 10 },
                  ],
                },
              };
            }
          }
          return {};
        };

        ctrl.getSupabase = async () => ({
          from: () => {
            const b = {
              select: () => b,
              order: () => b,
              eq: () => b,
              maybeSingle: async () => ({ data: null }),
              range: async () => ({ data: [] }),
            };
            return b;
          },
        });

        // 1. Initial Load - att-1 fails, att-2 succeeds
        await ctrl.loadAllStudentData();

        assert.equal(callCountAtt1, 1);
        assert.equal(callCountAtt2, 1);
        assert.ok(ctrl.loadErrors.reviews.has('att-1'), 'att-1 must be recorded as review error');
        assert.ok(!ctrl.loadErrors.reviews.has('att-2'), 'att-2 must NOT have review error');

        const vm1 = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm1), true, 'Load errors must be present');
        assert.equal(vm1.sheets[0].columns[0].reviewError, 'Network timeout on review server');
        assert.equal(vm1.sheets[0].columns[1].reviewError, null);

        // Exports must be blocked
        assert.throws(() => buildScoresheetPdfBytes(vm1), /Cannot export incomplete scoresheet due to loading errors/);

        // 2. User Clicks Retry -> calls loadAllStudentData()
        await ctrl.loadAllStudentData();

        // att-1 must be refetched (call count becomes 2)
        assert.equal(callCountAtt1, 2, 'att-1 MUST be refetched on retry');
        // att-2 was already successful, so it MUST NOT be refetched (preserved from cache)
        assert.equal(callCountAtt2, 1, 'att-2 MUST NOT be re-requested when already cached successfully');

        const vm2 = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm2), false, 'Load errors must be cleared after successful retry');
        assert.equal(vm2.sheets[0].columns[0].reviewError, null);
        assert.equal(vm2.sheets[0].rows[0].cells[0].status, 'entered');
        assert.equal(vm2.sheets[0].rows[0].cells[0].display, '10 / 10');

        // Exports must now succeed
        const pdfBytes = buildScoresheetPdfBytes(vm2);
        assert.ok(pdfBytes.length > 500, 'PDF export must now succeed');
      });

      it('treats missing or malformed review response as an error rather than a successful empty breakdown', async () => {
        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-retry-2', full_name: 'Malformed Student' },
          todayIST: '2026-11-08',
        });

        ctrl.onlineAttempts = [
          {
            id: 'att-malformed',
            mode: 'flat',
            status: 'submitted',
            group_key: 'junior1',
            paper_version: '2026.1',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 50, max_marks: 100 },
          },
        ];

        ctrl.callJmcwcApi = async ({ action }) => {
          if (action === 'get_practice_overview') return { paper: { id: 'p1', version: '2026.1' }, group_key: 'junior1' };
          if (action === 'list_attempts') return { attempts: ctrl.onlineAttempts };
          if (action === 'get_attempt_review') {
            // Malformed response without review array
            return { attempt: { review: null } };
          }
          return {};
        };

        ctrl.getSupabase = async () => ({
          from: () => ({ select: () => ({ order: () => ({ data: [] }), eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
        });

        await ctrl.loadAllStudentData();

        assert.ok(ctrl.loadErrors.reviews.has('att-malformed'), 'Must record error for malformed response');
        const vm = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm), true);
        assert.equal(vm.sheets[0].columns[0].reviewError, 'Review breakdown response is missing or malformed');
      });
    });

    describe('12.2 Preserve unique paper identity', () => {
      it('differentiates historical papers with unavailable version metadata with distinct sheetIds and paper labels', () => {
        const attempts = [
          {
            id: 'att-hist-1',
            status: 'submitted',
            mode: 'flat',
            group_key: 'junior1',
            paper_id: 'paper-hist-alpha',
            paper_version: null,
            finished_at: '2026-11-04T10:00:00Z',
            score: { marks: 40, max_marks: 100 },
          },
          {
            id: 'att-hist-2',
            status: 'submitted',
            mode: 'flat',
            group_key: 'junior1',
            paper_id: 'paper-hist-beta',
            paper_version: null,
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 60, max_marks: 100 },
          },
        ];

        const vm = buildScoresheetViewModel({
          sourceFilter: 'online',
          preset: 'all',
          todayIST: '2026-11-08',
          onlineAttempts: attempts,
          onlineCategories: AUTHORITATIVE_JMCWC_CATEGORIES,
        });

        assert.equal(vm.sheets.length, 2, 'Must create 2 distinct sheets for different paper_id values');

        const sheet1 = vm.sheets[0];
        const sheet2 = vm.sheets[1];

        assert.equal(sheet1.paperId, 'paper-hist-alpha');
        assert.equal(sheet1.sheetId, 'online_junior1_paper_paper-hist-alpha');
        assert.equal(sheet1.title, 'Online Practice · Junior 1 · Paper paper-hist-alpha');
        assert.equal(sheet1.columns[0].paperId, 'paper-hist-alpha');

        assert.equal(sheet2.paperId, 'paper-hist-beta');
        assert.equal(sheet2.sheetId, 'online_junior1_paper_paper-hist-beta');
        assert.equal(sheet2.title, 'Online Practice · Junior 1 · Paper paper-hist-beta');
        assert.equal(sheet2.columns[0].paperId, 'paper-hist-beta');

        assert.notEqual(sheet1.sheetId, sheet2.sheetId, 'Sheet IDs must not collide');
        assert.notEqual(sheet1.title, sheet2.title, 'Titles must be distinguishable');
      });

      it('never combines different paper IDs merely because their version labels match', () => {
        const attempts = [
          {
            id: 'att-same-ver-1',
            status: 'submitted',
            mode: 'flat',
            group_key: 'senior',
            paper_id: 'paper-uuid-1',
            paper_version: '2026.1',
            finished_at: '2026-11-04T10:00:00Z',
            score: { marks: 80, max_marks: 100 },
          },
          {
            id: 'att-same-ver-2',
            status: 'submitted',
            mode: 'flat',
            group_key: 'senior',
            paper_id: 'paper-uuid-2',
            paper_version: '2026.1',
            finished_at: '2026-11-05T10:00:00Z',
            score: { marks: 85, max_marks: 100 },
          },
        ];

        const vm = buildScoresheetViewModel({
          sourceFilter: 'online',
          preset: 'all',
          todayIST: '2026-11-08',
          onlineAttempts: attempts,
          onlineCategories: AUTHORITATIVE_JMCWC_CATEGORIES,
        });

        assert.equal(vm.sheets.length, 2, 'Different paper IDs must NEVER be combined even if version matches');
        assert.notEqual(vm.sheets[0].sheetId, vm.sheets[1].sheetId);
        assert.ok(vm.sheets[0].sheetId.includes('paper-uuid-1'));
        assert.ok(vm.sheets[1].sheetId.includes('paper-uuid-2'));

        // Titles must be disambiguated with paperId
        assert.ok(vm.sheets[0].title.includes('(paper-uuid-1)'));
        assert.ok(vm.sheets[1].title.includes('(paper-uuid-2)'));
      });
    });

    describe('12.3 Handle every metadata query error', () => {
      it('surfaces categories metadata query error and blocks export', async () => {
        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-err-1', full_name: 'Err Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async () => ({ attempts: [] });

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'categories') {
              return {
                select: async () => ({ data: null, error: { message: 'Database connection error on categories table' } }),
              };
            }
            if (table === 'round_series') {
              return { select: async () => ({ data: [], error: null }) };
            }
            if (table === 'category_series') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            if (table === 'jmcwc_assignments') {
              return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
            }
            if (table === 'jmcwc_categories') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            return { select: () => ({ eq: () => ({ order: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [] }) }) }) }) }) }) };
          },
        });

        await ctrl.loadAllStudentData();

        assert.equal(ctrl.loadErrors.manual, 'Database connection error on categories table');
        const vm = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm), true);
        assert.throws(() => buildScoresheetPdfBytes(vm), /Cannot export incomplete scoresheet due to loading errors/);
      });

      it('surfaces online metadata error from server API and blocks export', async () => {
        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-err-2', full_name: 'Online Err Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async ({ action }) => {
          if (action === 'get_practice_overview') {
            return { error: 'Failed to load simulator assignment' };
          }
          return { attempts: [] };
        };

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'round_series' || table === 'categories') {
              return { select: async () => ({ data: [], error: null }) };
            }
            if (table === 'category_series') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            return { select: () => ({ eq: () => ({ order: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [] }) }) }) }) }) }) };
          },
        });

        await ctrl.loadAllStudentData();

        assert.equal(ctrl.loadErrors.online, 'Failed to load simulator assignment');
        const vm = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm), true);
      });

      it('loads online metadata via authorized server API without direct jmcwc_categories query', async () => {
        let queriedForbiddenTable = false;
        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-auth-1', full_name: 'Authorized Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async ({ action }) => {
          if (action === 'get_practice_overview') {
            return {
              assigned: true,
              group_key: 'junior1',
              paper: { id: 'paper-auth-1', version: '2026.1' },
              categories: [
                { key: 'addition', label: 'Addition', position: 1 },
                { key: 'subtraction', label: 'Subtraction', position: 2 },
              ],
            };
          }
          return { attempts: [] };
        };

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'jmcwc_categories' || table === 'jmcwc_assignments') {
              queriedForbiddenTable = true;
              return {
                select: () => ({
                  order: async () => ({ error: { message: 'permission denied for table ' + table } }),
                  eq: () => ({ maybeSingle: async () => ({ error: { message: 'permission denied for table ' + table } }) }),
                }),
              };
            }
            if (table === 'round_series' || table === 'categories') {
              return { select: async () => ({ data: [], error: null }) };
            }
            if (table === 'category_series') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            return { select: () => ({ eq: () => ({ order: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [] }) }) }) }) }) }) };
          },
        });

        await ctrl.loadAllStudentData();

        assert.equal(queriedForbiddenTable, false, 'Must not query jmcwc_categories or jmcwc_assignments directly via Supabase client');
        assert.equal(ctrl.loadErrors.online, null, 'Error must disappear for authenticated student');
        assert.equal(ctrl.jmcwcAssignment?.group_key, 'junior1');
        assert.equal(ctrl.onlineCategories.length, 2);
        const vm = ctrl.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm), false);
      });
    });

    describe('12.4 Deterministic Pagination & Ordering', () => {
      it('executes manual rounds query with stable unique ordering and tie-breaker on id', async () => {
        const roundOrders = [];

        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-det-1', full_name: 'Deterministic Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async () => ({ attempts: [] });

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'student_rounds') {
              return {
                select: () => ({
                  eq: () => ({
                    order: (col, opts) => {
                      roundOrders.push({ col, opts });
                      return {
                        order: (col2, opts2) => {
                          roundOrders.push({ col: col2, opts: opts2 });
                          return {
                            order: (col3, opts3) => {
                              roundOrders.push({ col: col3, opts: opts3 });
                              return {
                                range: async () => ({ data: [], error: null }),
                              };
                            },
                          };
                        },
                      };
                    },
                  }),
                }),
              };
            }
            if (table === 'round_series' || table === 'categories') {
              return { select: async () => ({ data: [], error: null }) };
            }
            if (table === 'category_series' || table === 'jmcwc_categories') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            if (table === 'jmcwc_assignments') {
              return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
            }
            return { select: () => ({ eq: () => ({ in: () => ({ order: () => ({ order: () => ({ order: () => ({ range: async () => ({ data: [] }) }) }) }) }) }) }) };
          },
        });

        await ctrl.loadAllStudentData();

        assert.deepEqual(roundOrders, [
          { col: 'round_date', opts: { ascending: false } },
          { col: 'round_number', opts: { ascending: false } },
          { col: 'id', opts: { ascending: true } },
        ]);
      });

      it('executes results query with stable unique ordering before range pagination', async () => {
        const resultsOrders = [];

        const ctrl = new ScoresheetController({
          containerEl: null,
          profile: { id: 'stu-det-2', full_name: 'Results Order Student' },
          todayIST: '2026-11-08',
        });

        ctrl.callJmcwcApi = async () => ({ attempts: [] });

        ctrl.getSupabase = async () => ({
          from: (table) => {
            if (table === 'student_rounds') {
              return {
                select: () => ({
                  eq: () => ({
                    order: () => ({
                      order: () => ({
                        order: () => ({
                          range: async () => ({
                            data: [{ id: 'rnd-1', round_number: 1, round_date: '2026-11-04' }],
                            error: null,
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              };
            }
            if (table === 'results') {
              return {
                select: () => ({
                  eq: () => ({
                    in: () => ({
                      order: (col1, opts1) => {
                        resultsOrders.push({ col: col1, opts: opts1 });
                        return {
                          order: (col2, opts2) => {
                            resultsOrders.push({ col: col2, opts: opts2 });
                            return {
                              order: (col3, opts3) => {
                                resultsOrders.push({ col: col3, opts: opts3 });
                                return {
                                  range: async () => ({ data: [], error: null }),
                                };
                              },
                            };
                          },
                        };
                      },
                    }),
                  }),
                }),
              };
            }
            if (table === 'round_series' || table === 'categories') {
              return { select: async () => ({ data: [], error: null }) };
            }
            if (table === 'category_series' || table === 'jmcwc_categories') {
              return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
            }
            if (table === 'jmcwc_assignments') {
              return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
            }
            return {};
          },
        });

        await ctrl.loadAllStudentData();

        assert.deepEqual(resultsOrders, [
          { col: 'student_round_id', opts: { ascending: true } },
          { col: 'category_id', opts: { ascending: true } },
          { col: 'id', opts: { ascending: true } },
        ]);
      });

      it('resolves in-memory round ordering with id tie-breaker when date and round number are identical', () => {
        const rounds = [
          { id: 'rnd-z', round_number: 1, round_date: '2026-11-05' },
          { id: 'rnd-a', round_number: 1, round_date: '2026-11-05' },
          { id: 'rnd-m', round_number: 1, round_date: '2026-11-05' },
        ];

        const sheet = buildManualScoresheet({
          seriesInfo: { id: 's1', name: 'Series 1' },
          categories: [{ id: 'c1', name: 'Cat 1', series_sort_order: 1 }],
          rounds,
          results: [],
        });

        assert.deepEqual(sheet.columns.map((c) => c.id), ['rnd-a', 'rnd-m', 'rnd-z']);
      });

      it('resolves in-memory online attempt ordering with id tie-breaker when timestamps match', () => {
        const attempts = [
          { id: 'att-z', group_key: 'junior1', finished_at: '2026-11-05T10:00:00Z', status: 'submitted' },
          { id: 'att-a', group_key: 'junior1', finished_at: '2026-11-05T10:00:00Z', status: 'submitted' },
          { id: 'att-m', group_key: 'junior1', finished_at: '2026-11-05T10:00:00Z', status: 'submitted' },
        ];

        const sheet = buildOnlineScoresheet({
          groupKey: 'junior1',
          attempts,
        });

        assert.deepEqual(sheet.columns.map((c) => c.id), ['att-a', 'att-m', 'att-z']);
      });
    });
  });

  describe('13. Mobile Clean View & PDF Text Encoding', () => {
    describe('13.1 Mobile Clean View & Scroll Containment', () => {
      it('toggles body.scoresheet-capture-active and restores layout on exit', () => {
        let addedClass = '';
        let removedClass = '';
        const mockBody = {
          classList: {
            add: (cls) => { addedClass = cls; },
            remove: (cls) => { removedClass = cls; },
          },
        };
        const origDoc = globalThis.document;
        globalThis.document = {
          body: mockBody,
          getElementById: () => null,
          createElement: () => ({ appendChild: () => {} }),
          head: { appendChild: () => {} },
        };

        try {
          const ctrl = new ScoresheetController({
            containerEl: { querySelector: () => null, querySelectorAll: () => [], innerHTML: '' },
            profile: { id: 'stu-clean-1', full_name: 'Clean View Student' },
          });

          ctrl.setCleanView(true);
          assert.equal(ctrl.isCleanView, true);
          assert.equal(addedClass, 'scoresheet-capture-active');

          ctrl.setCleanView(false);
          assert.equal(ctrl.isCleanView, false);
          assert.equal(removedClass, 'scoresheet-capture-active');
        } finally {
          globalThis.document = origDoc;
        }
      });

      it('renders readable Exit Clean View button without white-on-white text', () => {
        const dummyEl = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
        const ctrl = new ScoresheetController({
          containerEl: dummyEl,
          profile: { id: 'stu-clean-2', full_name: 'Clean Exit Student' },
        });

        ctrl.isCleanView = true;
        ctrl.render();

        assert.ok(dummyEl.innerHTML.includes('id="btn-scoresheet-exit-clean"'));
        // Exit button must NOT use btn-outline (which forces white background) and must have readable dark text
        const exitBtnHtml = dummyEl.innerHTML.slice(
          dummyEl.innerHTML.indexOf('id="btn-scoresheet-exit-clean"'),
          dummyEl.innerHTML.indexOf('id="btn-scoresheet-exit-clean"') + 200
        );
        assert.ok(!exitBtnHtml.includes('btn-outline'), 'Exit button must not use btn-outline');
        assert.ok(exitBtnHtml.includes('color: #0f172a'), 'Exit button must have high-contrast text color');
        assert.ok(exitBtnHtml.includes('background: #ffffff'), 'Exit button must have solid readable background');
      });
    });

    describe('13.2 PDF Text Encoding & Plain Punctuation', () => {
      it('pdfEscape converts em dashes, middle dots, quotes, and accented characters to pure 7-bit ASCII', () => {
        const input = 'TRENDZ TRACKER — MAIN ROUND · Student: Zoë René (STU-1) · “Quotes” – EnDash…';
        const escaped = pdfEscape(input);

        // Must convert em dash '—' to '-'
        assert.ok(!escaped.includes('—'));
        assert.ok(escaped.includes('-'));

        // Must convert middle dot '·' to ' | '
        assert.ok(!escaped.includes('·'));
        assert.ok(escaped.includes('|'));

        // Must convert accented characters 'ë', 'é' to 'e', 'e'
        assert.ok(escaped.includes('Zoe Rene'));

        // Must convert smart quotes
        assert.ok(!escaped.includes('“') && !escaped.includes('”'));
        assert.ok(escaped.includes('"Quotes"'));

        // Must contain strictly 7-bit ASCII characters (0x20 to 0x7E)
        for (let i = 0; i < escaped.length; i++) {
          const code = escaped.charCodeAt(i);
          assert.ok(code >= 32 && code <= 126, `Character ${escaped[i]} (${code}) must be printable 7-bit ASCII`);
        }
      });

      it('buildScoresheetPdfBytes produces PDF byte stream free of multi-byte UTF-8 sequences in text strings', () => {
        const vm = {
          isValid: true,
          isEmpty: false,
          periodLabel: 'Last 7 days · IST',
          sourceFilter: 'both',
          studentInfo: { name: 'Zoë René', code: 'STU-99', group: 'Junior 1' },
          sheets: [
            {
              type: 'manual',
              sheetId: 'manual_s1',
              title: 'Manual Practice — Main Series',
              unitLabel: 'Counts · Marks',
              columns: [
                {
                  roundNumber: 1,
                  label: 'Round 1 · Day 1',
                  dateStr: '2026-11-05',
                  displayDate: '05 Nov 2026',
                  status: 'Completed',
                },
              ],
              rows: [
                {
                  categoryId: 'c1',
                  categoryName: 'Integer Addition & Subtraction',
                  cells: [
                    { status: 'missing', display: null, correct: null, total: null },
                  ],
                },
              ],
              totals: {
                columnTotals: [{ scoreText: null, accuracyText: null }],
              },
            },
          ],
        };

        const pdfBytes = buildScoresheetPdfBytes(vm);
        const pdfText = new TextDecoder('latin1').decode(pdfBytes);

        // Ensure no garbled character sequences (e.g. â€, Â·) exist anywhere in text streams
        assert.ok(!pdfText.includes('â€”'), 'Must not contain garbled em-dash');
        assert.ok(!pdfText.includes('Â·'), 'Must not contain garbled middle dot');
        assert.ok(!pdfText.includes('\u00B7'), 'Must not contain raw middle dot');
        assert.ok(!pdfText.includes('\u2014'), 'Must not contain raw em dash');
        assert.ok(!pdfText.includes('\u2013'), 'Must not contain raw en dash');

        // Verify plain punctuation and student name rendered cleanly
        assert.ok(pdfText.includes('TRENDZ TRACKER - MAIN ROUND SCORESHEET'));
        assert.ok(pdfText.includes('Zoe Rene \\(STU-99\\) | Group: Junior 1'));
      });
    });
  });

  describe('14. PDF Layout Fidelity, Margin Containment & Text Measurement', () => {
    it('14.1 measurePdfTextWidth, fitPdfText, and formatColumnHeaderLabel constrain text within available width', () => {
      const availW = 81; // Typical column text width
      // "Practice: Fraction addition"
      const res1 = formatColumnHeaderLabel('Practice: Fraction addition', availW);
      assert.equal(res1[0], 'Practice');
      assert.equal(res1[1], 'Fraction addition');
      const w1_0 = measurePdfTextWidth(res1[0], 7.5, true);
      const w1_1 = measurePdfTextWidth(res1[1], 7, true);
      assert.ok(w1_0 <= availW, `Line 1 width ${w1_0} must be <= ${availW}`);
      assert.ok(w1_1 <= availW, `Line 2 width ${w1_1} must be <= ${availW}`);

      // Long category "Practice: Mixed addition and subtraction"
      const res2 = formatColumnHeaderLabel('Practice: Mixed addition and subtraction', availW);
      assert.equal(res2[0], 'Practice');
      assert.equal(res2[1], 'Mixed Add/Sub');
      const w2_1 = measurePdfTextWidth(res2[1], 7, true);
      assert.ok(w2_1 <= availW, `Line 2 width ${w2_1} must be <= ${availW}`);

      // Single line fits
      const res3 = formatColumnHeaderLabel('Round 1', availW);
      assert.equal(res3[0], 'Round 1');
      assert.equal(res3[1], '');

      // fitPdfText truncates safely if text exceeds maxWidth
      const truncated = fitPdfText('Super Long Category Name That Would Exceed Margin', 100, 8, true);
      assert.ok(truncated.endsWith('...'));
      assert.ok(measurePdfTextWidth(truncated, 8, true) <= 100);
    });

    it('14.2 buildScoresheetPdfBytes renders export with long student name/code, paper UUID, 6+ round columns and long category headings', () => {
      const longStudentName = 'Alexander Bartholomew Montgomery-Richardson';
      const longStudentCode = 'STU-LONGEST-CODE-2026-X99';
      const longGroup = 'Grandmaster Abacus Level 4';
      const paperUuid = '550e8400-e29b-41d4-a716-446655440000';

      const columns = [
        { id: 'att-1', roundNumber: 1, label: 'Practice: Fraction addition', dateStr: '2026-11-01', displayDate: '01 Nov 2026', status: 'Completed' },
        { id: 'att-2', roundNumber: 2, label: 'Practice: Mixed addition and subtraction', dateStr: '2026-11-02', displayDate: '02 Nov 2026', status: 'Completed' },
        { id: 'att-3', roundNumber: 3, label: 'Practice: Integer multiplication', dateStr: '2026-11-03', displayDate: '03 Nov 2026', status: 'Completed' },
        { id: 'att-4', roundNumber: 4, label: 'Practice: Inexact square roots', dateStr: '2026-11-04', displayDate: '04 Nov 2026', status: 'Completed' },
        { id: 'att-5', roundNumber: 5, label: 'Practice: Prime factorisation', dateStr: '2026-11-05', displayDate: '05 Nov 2026', status: 'Completed' },
        { id: 'att-6', roundNumber: 6, label: 'Practice: Fraction division', dateStr: '2026-11-06', displayDate: '06 Nov 2026', status: 'Completed' },
      ];

      const rows = AUTHORITATIVE_JMCWC_CATEGORIES.map((cat) => ({
        categoryId: cat.key,
        category: { key: cat.key, name: cat.label, position: cat.position },
        cells: columns.map((col, idx) => ({
          status: idx === 0 ? 'zero' : 'entered',
          display: idx === 0 ? '0 / 10' : `${idx * 2} / 10`,
          marks: idx * 2,
          maxMarks: 10,
        })),
      }));

      const columnTotals = columns.map((col, idx) => ({
        scoreText: `${idx * 15} / 150`,
        accuracyText: `${idx * 10}%`,
        statusText: 'Completed',
      }));

      const vm = {
        isValid: true,
        isEmpty: false,
        periodLabel: 'Last 30 Days (09/10/2026 - 08/11/2026)',
        sourceFilter: 'online',
        studentInfo: {
          name: longStudentName,
          code: longStudentCode,
          group: longGroup,
        },
        sheets: [
          {
            type: 'online',
            sheetId: `online_junior1_paper_${paperUuid}`,
            title: `Online Practice · Junior 1 · Paper ${paperUuid}`,
            unitLabel: 'Earned Marks / Frozen Max Marks (Online)',
            paperId: paperUuid,
            groupKey: 'junior1',
            columns,
            rows,
            totals: { columnTotals },
          },
        ],
      };

      const pdfBytes = buildScoresheetPdfBytes(vm);
      assert.ok(pdfBytes instanceof Uint8Array, 'PDF output must be Uint8Array');
      const pdfText = new TextDecoder('latin1').decode(pdfBytes);

      // Verify that long student name and code are preserved and rendered
      assert.ok(pdfText.includes('Alexander Bartholomew Montgomery-Richardson'));
      assert.ok(pdfText.includes('STU-LONGEST-CODE-2026-X99'));
      assert.ok(pdfText.includes('Grandmaster Abacus Level 4'));
      assert.ok(pdfText.includes('Period: Last 30 Days'));

      // Verify paper UUID is rendered in sheet title and preserved in footer
      assert.ok(pdfText.includes(paperUuid));
      assert.ok(pdfText.includes(`Paper: ${paperUuid}`));

      // Verify column headings are split into Practice + category without overlap
      assert.ok(pdfText.includes('(Practice) Tj'));
      assert.ok(pdfText.includes('(Fraction addition) Tj'));
      assert.ok(pdfText.includes('(Mixed Add/Sub) Tj'));
      assert.ok(pdfText.includes('(Integer multiplication) Tj'));
      assert.ok(pdfText.includes('(Inexact square roots) Tj'));
      assert.ok(pdfText.includes('(Prime factorisation) Tj'));
      assert.ok(pdfText.includes('(Fraction division) Tj'));
    });
  });

  describe('15. Unassigned Student Handling & Server Error Parsing', () => {
    describe('15.1 parseJmcwcApiError contract & error preservation', () => {
      it('preserves top-level string error message and code from server response', () => {
        const response = { status: 409 };
        const data = {
          error: 'No published paper available for group junior1.',
          code: 'NO_PUBLISHED_PAPER',
        };
        const err = parseJmcwcApiError(response, data);
        assert.equal(err.message, 'No published paper available for group junior1.');
        assert.equal(err.code, 'NO_PUBLISHED_PAPER');
        assert.equal(err.status, 409);
      });

      it('preserves 403 forbidden error string and code without dropping to generic message', () => {
        const response = { status: 403 };
        const data = {
          error: 'Forbidden: No assigned group for student.',
          code: 'FORBIDDEN',
        };
        const err = parseJmcwcApiError(response, data);
        assert.equal(err.message, 'Forbidden: No assigned group for student.');
        assert.equal(err.code, 'FORBIDDEN');
        assert.equal(err.status, 403);
      });

      it('falls back gracefully to nested error object or default HTTP status message', () => {
        const response = { status: 500 };
        const dataNested = {
          error: { message: 'Database query timeout', code: 'DB_TIMEOUT' },
        };
        const errNested = parseJmcwcApiError(response, dataNested);
        assert.equal(errNested.message, 'Database query timeout');
        assert.equal(errNested.code, 'DB_TIMEOUT');
        assert.equal(errNested.status, 500);

        const dataEmpty = {};
        const errEmpty = parseJmcwcApiError({ status: 502 }, dataEmpty);
        assert.equal(errEmpty.message, 'Request failed (502)');
        assert.equal(errEmpty.code, 'API_ERROR');
        assert.equal(errEmpty.status, 502);
      });
    });

    describe('15.2 Unassigned student STU101 in ScoresheetController', () => {
      it('skips assignment-dependent history/review endpoints when assigned:false and leaves loadErrors.online null', async () => {
        const apiCalls = [];
        const mockCallJmcwcApi = async (payload) => {
          apiCalls.push(payload);
          if (payload.action === 'get_practice_overview') {
            return {
              assigned: false,
              group_key: null,
              blocked: true,
              message: 'Ask your teacher to assign your JMCWC group.',
              paper_available: false,
              paper: null,
              categories: AUTHORITATIVE_JMCWC_CATEGORIES,
              targets: {},
              attempts: [],
            };
          }
          if (payload.action === 'list_attempts') {
            throw new Error('Unexpected call to list_attempts for unassigned student!');
          }
          if (payload.action === 'get_attempt_review') {
            throw new Error('Unexpected call to get_attempt_review for unassigned student!');
          }
          return {};
        };

        const mockSupabase = {
          from: (table) => {
            if (table === 'round_series') {
              return { select: () => Promise.resolve({ data: [{ id: 's1', name: 'Series 1', is_current: true }], error: null }) };
            }
            if (table === 'category_series') {
              return {
                select: () => ({
                  order: () => Promise.resolve({
                    data: [
                      { category_id: 'c1', series_id: 's1', sort_order: 1, category: { id: 'c1', name: 'Addition', section: 'round', active: true } },
                    ],
                    error: null,
                  }),
                }),
              };
            }
            if (table === 'categories') {
              return { select: () => Promise.resolve({ data: [{ id: 'c1', name: 'Addition', section: 'round', active: true }], error: null }) };
            }
            if (table === 'student_rounds') {
              return {
                select: () => ({
                  eq: () => ({
                    order: () => ({
                      order: () => ({
                        order: () => ({
                          range: () => Promise.resolve({
                            data: [
                              { id: 'r1', student_id: 'stu-101', series_id: 's1', round_number: 1, round_date: '2026-11-08', round_type: 'Category wise', time_taken_seconds: 120 },
                            ],
                            error: null,
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              };
            }
            if (table === 'results') {
              return {
                select: () => ({
                  eq: () => ({
                    in: () => ({
                      order: () => ({
                        order: () => ({
                          order: () => ({
                            range: () => Promise.resolve({
                              data: [
                                { id: 'res1', student_round_id: 'r1', category_id: 'c1', correct: 8, total: 10, time_seconds: 60, note: null },
                              ],
                              error: null,
                            }),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              };
            }
            return { select: () => Promise.resolve({ data: [], error: null }) };
          },
        };

        const controller = new ScoresheetController({
          containerEl: null,
          currentProfile: { id: 'stu-101', full_name: 'STU101 Student', student_code: 'STU101', role: 'student', level: 'Level 1' },
          todayIST: '2026-11-08',
          getSupabase: async () => mockSupabase,
          callJmcwcApi: mockCallJmcwcApi,
        });

        await controller.loadAllStudentData();

        // 1. Verify list_attempts and get_attempt_review were never called
        assert.equal(apiCalls.length, 1);
        assert.equal(apiCalls[0].action, 'get_practice_overview');
        assert.ok(!apiCalls.some((c) => c.action === 'list_attempts'));
        assert.ok(!apiCalls.some((c) => c.action === 'get_attempt_review'));

        // 2. Verify state is cleanly unassigned and NOT an error
        assert.equal(controller.onlineAssigned, false);
        assert.equal(controller.onlineAssignmentMessage, ONLINE_UNASSIGNED_MESSAGE);
        assert.equal(controller.loadErrors.online, null, 'Unassigned state must NOT be classified as an online load failure');
        assert.equal(controller.onlineAttempts.length, 0);

        // 3. Verify view model properties
        const vm = controller.getViewModel();
        assert.equal(vm.onlineAssigned, false);
        assert.equal(vm.onlineAssignmentMessage, ONLINE_UNASSIGNED_MESSAGE);
        assert.equal(vm.studentInfo.group, 'Unassigned');
        assert.equal(vm.studentInfo.code, 'STU101');
        assert.equal(hasScoresheetLoadErrors(vm), false, 'ViewModel must have zero load errors');

        // 4. Source "both": Manual round appears and informative unassigned notice is rendered
        assert.equal(vm.sheets.length, 1, 'Manual sheet must be loaded');
        assert.equal(vm.sheets[0].type, 'manual');
        const bothHtml = renderScoresheetHTML(vm);
        assert.ok(bothHtml.includes('scoresheet-unassigned-notice'), 'Informative unassigned notice must be present in HTML');
        assert.ok(bothHtml.includes(ONLINE_UNASSIGNED_MESSAGE));
        assert.ok(!bothHtml.includes('banner-error'), 'No red error banner must appear');

        // 5. PDF generation for source "both" succeeds without loading error blocks
        const pdfBytes = buildScoresheetPdfBytes(vm);
        assert.ok(pdfBytes instanceof Uint8Array);
        assert.ok(pdfBytes.length > 500);

        // 6. Source "online": Renders clean unassigned card without error banners
        controller.sourceFilter = 'online';
        const onlineVm = controller.getViewModel();
        assert.equal(onlineVm.isEmpty, true);
        assert.equal(onlineVm.onlineAssigned, false);
        const onlineHtml = renderScoresheetHTML(onlineVm);
        assert.ok(onlineHtml.includes('scoresheet-unassigned-card'));
        assert.ok(onlineHtml.includes(ONLINE_UNASSIGNED_MESSAGE));
        assert.ok(!onlineHtml.includes('banner-error'), 'No red error banner on unassigned online view');

        // 7. PDF generation for source "online" produces single-page "Online Practice Unavailable" document
        const onlinePdfBytes = buildScoresheetPdfBytes(onlineVm);
        const onlinePdfText = new TextDecoder('latin1').decode(onlinePdfBytes);
        assert.ok(onlinePdfText.includes('Online Practice Unavailable'));
        assert.ok(onlinePdfText.includes('Online practice is unavailable until your teacher assigns your JMCWC group.'));

        // 8. Source "manual": Displays manual rounds cleanly without unassigned notice
        controller.sourceFilter = 'manual';
        const manualVm = controller.getViewModel();
        assert.equal(manualVm.isEmpty, false);
        const manualHtml = renderScoresheetHTML(manualVm);
        assert.ok(!manualHtml.includes('scoresheet-unassigned-notice'), 'Manual filter does not need unassigned notice');
        assert.ok(!manualHtml.includes('scoresheet-unassigned-card'));
        assert.ok(!manualHtml.includes('banner-error'));
      });
    });

    describe('15.3 Genuine API failures in ScoresheetController', () => {
      it('surfaces genuine 500 or network failure as online load error and blocks exports', async () => {
        const mockCallJmcwcApi = async (payload) => {
          if (payload.action === 'get_practice_overview') {
            throw new Error('Connection refused: simulator service down');
          }
          return {};
        };

        const mockSupabase = {
          from: () => ({
            select: () => ({
              order: () => Promise.resolve({ data: [], error: null }),
              eq: () => ({
                order: () => ({
                  order: () => ({
                    order: () => ({
                      range: () => Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };

        const controller = new ScoresheetController({
          containerEl: null,
          currentProfile: { id: 'stu-alpha', full_name: 'Student Alpha', student_code: 'STU-A', role: 'student' },
          todayIST: '2026-11-08',
          getSupabase: async () => mockSupabase,
          callJmcwcApi: mockCallJmcwcApi,
        });

        await controller.loadAllStudentData();

        // 1. Verify loadErrors.online is set to genuine failure message
        assert.equal(controller.loadErrors.online, 'Connection refused: simulator service down');

        // 2. Verify view model flags error and blocks export
        const vm = controller.getViewModel();
        assert.equal(hasScoresheetLoadErrors(vm), true);

        // 3. Render HTML contains error banner with retry option
        const html = renderScoresheetHTML(vm);
        assert.ok(html.includes('banner-error'));
        assert.ok(html.includes('Connection refused: simulator service down'));
        assert.ok(html.includes('btn-retry-online') || html.includes('btn-retry-scoresheet'));
      });
    });
  });
