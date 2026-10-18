/**
 * Unit Tests for Trendz Tracker Phase 4c-2a Import Resolver & Database Comparison (tests/importResolver.test.js)
 * Run with: node --test tests/importResolver.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScoreSheetCsv, SAMPLE_TWO_BLOCK_CSV } from '../js/importParser.js';
import {
  toMatchingKey,
  suggestSeriesForBlock,
  getBlockHeaderMetadata,
  validateBlockSeriesSelections,
  resolveBlockCategories,
  compareBlockWithExistingData,
  buildImportPreviewState,
} from '../js/importResolver.js';

const MOCK_ROUND_SERIES = [
  { id: 'ser-old', name: 'Old simulator', sort_order: 1, is_current: false },
  { id: 'ser-new', name: 'New simulator', sort_order: 2, is_current: true },
];

const MOCK_ROUND_CATEGORIES = [
  { id: 'cat-1', name: 'ADD', section: 'round', active: true, sort_order: 1 },
  { id: 'cat-2', name: 'SUB', section: 'round', active: true, sort_order: 2 },
  { id: 'cat-3', name: 'HCF and LCM', section: 'round', active: true, sort_order: 3 },
  { id: 'cat-4', name: 'Approximation', section: 'round', active: true, sort_order: 4 },
  { id: 'cat-5', name: 'Calendar', section: 'round', active: true, sort_order: 5 },
  { id: 'cat-6', name: 'Time Elapsed', section: 'round', active: true, sort_order: 6 },
  { id: 'cat-7', name: 'Surprise Task', section: 'round', active: true, sort_order: 7 },
  { id: 'cat-8', name: 'Currency', section: 'round', active: true, sort_order: 8 },
  { id: 'cat-9', name: 'Missing Figures', section: 'round', active: false, sort_order: 9 },
];

const MOCK_CATEGORY_SERIES = [
  // Old simulator: ADD, SUB, Currency, Missing Figures, Calendar, Surprise Task
  { category_id: 'cat-1', series_id: 'ser-old', sort_order: 1 },
  { category_id: 'cat-2', series_id: 'ser-old', sort_order: 2 },
  { category_id: 'cat-8', series_id: 'ser-old', sort_order: 3 },
  { category_id: 'cat-9', series_id: 'ser-old', sort_order: 4 },
  { category_id: 'cat-5', series_id: 'ser-old', sort_order: 5 },
  { category_id: 'cat-7', series_id: 'ser-old', sort_order: 6 },
  // New simulator: ADD, SUB, HCF and LCM, Approximation, Calendar, Time Elapsed, Surprise Task
  { category_id: 'cat-1', series_id: 'ser-new', sort_order: 1 },
  { category_id: 'cat-2', series_id: 'ser-new', sort_order: 2 },
  { category_id: 'cat-3', series_id: 'ser-new', sort_order: 3 },
  { category_id: 'cat-4', series_id: 'ser-new', sort_order: 4 },
  { category_id: 'cat-5', series_id: 'ser-new', sort_order: 5 },
  { category_id: 'cat-6', series_id: 'ser-new', sort_order: 6 },
  { category_id: 'cat-7', series_id: 'ser-new', sort_order: 7 },
];

test('suggestSeriesForBlock suggests Old simulator for currency/missingfigures and New simulator for approximation/hcfandlcm', () => {
  const oldBlockCats = [{ sheetName: 'ADD' }, { sheetName: 'Currency' }];
  const oldSug = suggestSeriesForBlock(oldBlockCats, MOCK_ROUND_SERIES);
  assert.equal(oldSug.suggestedSeriesId, 'ser-old');
  assert.equal(oldSug.suggestedSeriesName, 'Old simulator');

  const mfBlockCats = [{ sheetName: 'Missing Figures' }];
  const mfSug = suggestSeriesForBlock(mfBlockCats, MOCK_ROUND_SERIES);
  assert.equal(mfSug.suggestedSeriesId, 'ser-old');

  const newBlockCats = [{ sheetName: 'ADD' }, { sheetName: 'HCF and LCM' }, { sheetName: 'Approximation' }];
  const newSug = suggestSeriesForBlock(newBlockCats, MOCK_ROUND_SERIES);
  assert.equal(newSug.suggestedSeriesId, 'ser-new');
  assert.equal(newSug.suggestedSeriesName, 'New simulator');

  const neutralCats = [{ sheetName: 'ADD' }, { sheetName: 'SUB' }];
  const neutralSug = suggestSeriesForBlock(neutralCats, MOCK_ROUND_SERIES);
  assert.equal(neutralSug.suggestedSeriesId, null);
});

test('getBlockHeaderMetadata associates "NEW SIMULATOR" gap hint with Block 2 and extracts round and date ranges', () => {
  const parsed = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  const meta1 = getBlockHeaderMetadata(parsed.blocks[0], parsed.blocks, parsed.labelHints);
  assert.equal(meta1.roundRange.text, 'Rounds 1–2 (2 rounds)');
  assert.equal(meta1.dateRange.minDate, '2026-08-17');
  assert.equal(meta1.dateRange.maxDate, '2026-08-21');
  assert.equal(meta1.blockHints.length, 0);

  const meta2 = getBlockHeaderMetadata(parsed.blocks[1], parsed.blocks, parsed.labelHints);
  assert.equal(meta2.roundRange.text, 'Rounds 1–3 (3 rounds)');
  assert.equal(meta2.dateRange.minDate, '2026-08-18');
  assert.equal(meta2.dateRange.maxDate, '2026-08-20');
  assert.equal(meta2.blockHints.length, 1);
  assert.equal(meta2.blockHints[0].text, 'NEW SIMULATOR');
  assert.equal(meta2.blockHints[0].ref, 'H1');
});

test('validateBlockSeriesSelections requires confirmation for every block and blocks two blocks from using the same series', () => {
  // Unconfirmed suggestions -> invalid
  const unconfirmed = validateBlockSeriesSelections(
    [
      { blockNumber: 1, seriesId: 'ser-old', confirmed: false },
      { blockNumber: 2, seriesId: 'ser-new', confirmed: true },
    ],
    MOCK_ROUND_SERIES
  );
  assert.equal(unconfirmed.valid, false);
  assert.ok(unconfirmed.errors.some((e) => e.type === 'unconfirmed_series' && e.blockNumber === 1));

  // Duplicate series across blocks -> blocking error
  const duplicate = validateBlockSeriesSelections(
    [
      { blockNumber: 1, seriesId: 'ser-new', confirmed: true },
      { blockNumber: 2, seriesId: 'ser-new', confirmed: true },
    ],
    MOCK_ROUND_SERIES
  );
  assert.equal(duplicate.valid, false);
  assert.deepEqual(duplicate.duplicateSeriesIds, ['ser-new']);
  assert.ok(duplicate.errors.some((e) => e.type === 'duplicate_series'));

  // Distinct confirmed series -> valid
  const valid = validateBlockSeriesSelections(
    [
      { blockNumber: 1, seriesId: 'ser-old', confirmed: true },
      { blockNumber: 2, seriesId: 'ser-new', confirmed: true },
    ],
    MOCK_ROUND_SERIES
  );
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);
});

test('resolveBlockCategories enforces priority: category_aliases -> built-in aliases -> exact match, plus series check and duplicate target detection', () => {
  assert.equal(toMatchingKey('  Time   Elapse '), 'timeelapse');

  const sheetCats = [
    { rowIndex: 4, indexLabel: '1', sheetName: 'ADD', ref: 'B5', rawKey: 'add' },
    { rowIndex: 5, indexLabel: '2', sheetName: 'Calender', ref: 'B6', rawKey: 'calender' },
    { rowIndex: 6, indexLabel: '3', sheetName: 'Curr Alias', ref: 'B7', rawKey: 'curralias' },
    { rowIndex: 7, indexLabel: '4', sheetName: 'Approximation', ref: 'B8', rawKey: 'approximation' },
    { rowIndex: 8, indexLabel: '5', sheetName: 'Mystery Cat', ref: 'B9', rawKey: 'mysterycat' },
  ];

  const dbAliases = [{ alias: 'curralias', category_id: 'cat-8' }]; // Maps to Currency

  const res = resolveBlockCategories(sheetCats, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: dbAliases,
    categorySeries: MOCK_CATEGORY_SERIES,
    seriesId: 'ser-old',
    seriesName: 'Old simulator',
    blockNumber: 1,
  });

  // 1. ADD -> exact match, in Old simulator (#1)
  assert.equal(res.categories[0].effectiveStatus, 'exact');
  assert.equal(res.categories[0].inSelectedSeries, true);
  assert.equal(res.categories[0].seriesSortOrder, 1);

  // 2. Calender -> built-in alias -> Calendar, in Old simulator (#5)
  assert.equal(res.categories[1].effectiveStatus, 'builtin_alias');
  assert.equal(res.categories[1].resolvedCategory.name, 'Calendar');
  assert.equal(res.categories[1].inSelectedSeries, true);

  // 3. Curr Alias -> DB alias -> Currency, in Old simulator (#3)
  assert.equal(res.categories[2].effectiveStatus, 'db_alias');
  assert.equal(res.categories[2].resolvedCategory.name, 'Currency');
  assert.equal(res.categories[2].inSelectedSeries, true);

  // 4. Approximation -> exact match, but NOT in Old simulator!
  assert.equal(res.categories[3].effectiveStatus, 'exact');
  assert.equal(res.categories[3].inSelectedSeries, false);
  assert.ok(res.warnings.some((w) => w.type === 'category_not_in_series'));

  // 5. Mystery Cat -> unmatched
  assert.equal(res.categories[4].effectiveStatus, 'unmatched');

  // Absent categories from Old simulator: SUB (#2), Missing Figures (#4), Surprise Task (#6)
  assert.deepEqual(
    res.absentCategories.map((c) => c.name),
    ['SUB', 'Missing Figures', 'Surprise Task']
  );

  // Duplicate target category detection when admin maps "Mystery Cat" to ADD ('cat-1')
  const dupRes = resolveBlockCategories(sheetCats, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: dbAliases,
    categorySeries: MOCK_CATEGORY_SERIES,
    seriesId: 'ser-old',
    seriesName: 'Old simulator',
    adminMappings: {
      mysterycat: { action: 'map', targetCategoryId: 'cat-1' },
    },
    blockNumber: 1,
  });
  assert.equal(dupRes.errors.length, 1);
  assert.equal(dupRes.errors[0].type, 'duplicate_category_target');
  assert.equal(dupRes.categories[0].duplicateTargetError, true);
  assert.equal(dupRes.categories[4].duplicateTargetError, true);
});

test('compareBlockWithExistingData classifies new, identical, conflict, protected (verified/corrected), and db_only rounds and cells', () => {
  const parsed = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // Block 2 (New simulator): Rounds 1, 2, 3
  // Categories in Block 2: ADD (cat-1), HCF and LCM (cat-3), Approximation (cat-4), Time Elapse -> Time Elapsed (cat-6), Surprise Task (cat-7)
  const blk2 = parsed.blocks[1];
  const catRes2 = resolveBlockCategories(blk2.categories, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    categorySeries: MOCK_CATEGORY_SERIES,
    seriesId: 'ser-new',
    seriesName: 'New simulator',
    blockNumber: 2,
  });

  const existingStudentRounds = [
    // Round 1: exists in DB, identical date/type/time, and all 4 scores in DB match CSV identically!
    {
      id: 'sr-new-1',
      student_id: 'stu-1',
      series_id: 'ser-new',
      round_number: 1,
      round_date: '2026-08-18',
      round_type: 'Flat Round',
      time_taken_seconds: 3920, // 1:05:20
    },
    // Round 2: exists in DB, has verified & unverified conflicts + DB-only score
    {
      id: 'sr-new-2',
      student_id: 'stu-1',
      series_id: 'ser-new',
      round_number: 2,
      round_date: '2026-08-15', // differs from sheet 2026-08-19
      round_type: 'Without Time',
      time_taken_seconds: null,
    },
    // Round 9: exists in DB only (not in sheet)
    {
      id: 'sr-new-9',
      student_id: 'stu-1',
      series_id: 'ser-new',
      round_number: 9,
      round_date: '2026-09-01',
      round_type: 'Category wise',
      time_taken_seconds: 1200,
    },
  ];

  const existingResults = [
    // Round 1: exact matches for ADD (85/85, 80s), HCF and LCM (80/85, 125s), Approximation (40/45, 135s), Time Elapsed (50/50, 100s)
    { id: 'r1-1', student_id: 'stu-1', student_round_id: 'sr-new-1', category_id: 'cat-1', correct: 85, total: 85, time_seconds: 80, note: null },
    { id: 'r1-3', student_id: 'stu-1', student_round_id: 'sr-new-1', category_id: 'cat-3', correct: 80, total: 85, time_seconds: 125, note: null },
    { id: 'r1-4', student_id: 'stu-1', student_round_id: 'sr-new-1', category_id: 'cat-4', correct: 40, total: 45, time_seconds: 135, note: null },
    { id: 'r1-6', student_id: 'stu-1', student_round_id: 'sr-new-1', category_id: 'cat-6', correct: 50, total: 50, time_seconds: 100, note: null },

    // Round 2:
    // - ADD (cat-1): verified in DB with 88/90 (sheet has 90/90) -> protected_conflict
    { id: 'r2-1', student_id: 'stu-1', student_round_id: 'sr-new-2', category_id: 'cat-1', correct: 88, total: 90, time_seconds: 70, note: null, verified: true },
    // - HCF and LCM (cat-3): unverified in DB with 80/85 (sheet has 84/85) -> conflict
    { id: 'r2-3', student_id: 'stu-1', student_round_id: 'sr-new-2', category_id: 'cat-3', correct: 80, total: 85, time_seconds: 115, note: null, verified: false },
    // - SUB (cat-2, not in Block 2): exists in DB -> dbOnlyExtraResults
    { id: 'r2-2', student_id: 'stu-1', student_round_id: 'sr-new-2', category_id: 'cat-2', correct: 90, total: 90, time_seconds: 60, note: null, verified: false },
  ];

  const comp = compareBlockWithExistingData(blk2, catRes2.categories, {
    studentId: 'stu-1',
    seriesId: 'ser-new',
    seriesName: 'New simulator',
    existingStudentRounds,
    existingResults,
    roundCategories: MOCK_ROUND_CATEGORIES,
  });

  // Round 1 -> identical
  assert.equal(comp.rounds[0].roundComparisonStatus, 'identical');
  assert.equal(comp.rounds[0].counts.identicalCells, 4);

  // Round 2 -> conflict (date differs, 1 protected_conflict, 1 unverified conflict, 3 new cells, 1 extra DB-only cell)
  assert.equal(comp.rounds[1].roundComparisonStatus, 'conflict');
  assert.equal(comp.rounds[1].dateDiffers, true);
  assert.equal(comp.rounds[1].counts.protectedConflictCells, 1);
  assert.equal(comp.rounds[1].counts.conflictCells, 1);
  assert.equal(comp.rounds[1].counts.newCells, 3);
  assert.equal(comp.rounds[1].dbOnlyExtraResults.length, 1);
  assert.equal(comp.rounds[1].dbOnlyExtraResults[0].categoryName, 'SUB');

  // Round 3 -> new round (not in DB yet, 5 new cells)
  assert.equal(comp.rounds[2].roundComparisonStatus, 'new');
  assert.equal(comp.rounds[2].counts.newCells, 5);

  // DB-only round: Round 9
  assert.equal(comp.dbOnlyRounds.length, 1);
  assert.equal(comp.dbOnlyRounds[0].roundNumber, 9);
});

test('buildImportPreviewState combines series suggestions, category resolution, and data comparison across all blocks', () => {
  const parsed = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  const state = buildImportPreviewState(parsed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    roundSeries: MOCK_ROUND_SERIES,
    categorySeries: MOCK_CATEGORY_SERIES,
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    existingStudentRounds: [],
    existingResults: [],
    blockUiState: {
      1: { seriesId: 'ser-old', confirmed: true, adminMappings: {} },
      2: { seriesId: 'ser-new', confirmed: true, adminMappings: {} },
    },
  });

  assert.equal(state.ok, true);
  assert.equal(state.seriesValidation.valid, true);
  assert.equal(state.blockReports.length, 2);
  assert.equal(state.blockReports[0].seriesId, 'ser-old');
  assert.equal(state.blockReports[1].seriesId, 'ser-new');
  assert.equal(state.overallComparison.rounds.newRounds, 5);
});
