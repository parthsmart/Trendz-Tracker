/**
 * Unit Tests for Trendz Tracker Phase 4c-2a & 4c-2b Import Planner, Resolver & Execution Chunking (tests/importPlan.test.js)
 * Run with: node --test tests/importPlan.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScoreSheetCsv, SAMPLE_TWO_BLOCK_CSV } from '../js/importParser.js';
import {
  buildImportPreviewState,
  buildImportExecutionPlan,
  materializeBlockRoundChunks,
  chunkRoundsForImport,
  validatePayload,
  createEmptyEditState,
  validateRoundEdit,
  validateCellEdit,
  applyPreviewEdits,
  buildPreviewEditsList,
  buildImportPayload,
} from '../js/importPlan.js';

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
  { category_id: 'cat-1', series_id: 'ser-old', sort_order: 1 },
  { category_id: 'cat-2', series_id: 'ser-old', sort_order: 2 },
  { category_id: 'cat-8', series_id: 'ser-old', sort_order: 3 },
  { category_id: 'cat-9', series_id: 'ser-old', sort_order: 4 },
  { category_id: 'cat-5', series_id: 'ser-old', sort_order: 5 },
  { category_id: 'cat-7', series_id: 'ser-old', sort_order: 6 },
  { category_id: 'cat-1', series_id: 'ser-new', sort_order: 1 },
  { category_id: 'cat-2', series_id: 'ser-new', sort_order: 2 },
  { category_id: 'cat-3', series_id: 'ser-new', sort_order: 3 },
  { category_id: 'cat-4', series_id: 'ser-new', sort_order: 4 },
  { category_id: 'cat-5', series_id: 'ser-new', sort_order: 5 },
  { category_id: 'cat-6', series_id: 'ser-new', sort_order: 6 },
  { category_id: 'cat-7', series_id: 'ser-new', sort_order: 7 },
];

const CLEAN_TWO_BLOCK_CSV = [
  'Name -- TEST STUDENT,,JUNIOR -1,,JUNIOR -1,,,NEW SIMULATOR,,JUNIOR -2,,JUNIOR -2,,JUNIOR -2,',
  'INDEX,Category,Round 1,,Round 2,,,INDEX,Category,Round 1,,Round 2,,Round 3,',
  ',,17/08/2026,,21/08/2026,,,,,18/08/2026,,19/08/2026,,20/08/2026,',
  ',,Score ,Time,Score,Time,,,,Score,Time,Score,Time,Score,Time',
  '1,ADD,85/90,1:25,88/90,1:15,,1,ADD,85/85,1:20,90/90,,89/90,1:10',
  '2,Currency,40/45,2:10,42/45,2:05,,2,HCF and LCM,80/85,2:05,84/85,,85/85,1:55',
  '3,Missing Figures,38/40,1:50,40/40,1:45,,3,Approximation,40/45,2:15,43/45,,45/45,2:00',
  '4,Calender,45/50,1:40,48/50,1:30,,4,Time Elapse,50/50,1:40,49/50,,50/50,1:35',
  '5,Surprise Task,Done,,25/25,0:55,,5,Surprise Task,,,Done by Oral,,30/30,1:05',
  ',Round Type,Category wise,,Flat Round,,,,Round Type,Flat Round,,Without Time,,Category wise,',
  'Time Taken,,1:05:30,,58:20,,,,Time Taken,1:05:20,,,,52:10,',
  ',Final Score,208,,243,,,,Final Score,255,,266,,299,',
].join('\r\n');

test('buildImportExecutionPlan skips unreadable cells in acknowledgments without blocking import, and blocks unconfirmed series', () => {
  // SAMPLE_TWO_BLOCK_CSV has '75' in E5 (unreadable plain-number time)
  const parsedWithErr = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // 1. Unconfirmed series blocks import
  const stateUnconfirmed = buildImportPreviewState(parsedWithErr, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    roundSeries: MOCK_ROUND_SERIES,
    categorySeries: MOCK_CATEGORY_SERIES,
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    existingStudentRounds: [],
    existingResults: [],
    blockUiState: {
      1: { seriesId: 'ser-old', confirmed: false, adminMappings: {} },
      2: { seriesId: 'ser-new', confirmed: true, adminMappings: {} },
    },
  });
  const planUnconfirmed = buildImportExecutionPlan(parsedWithErr, stateUnconfirmed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    fileName: 'sample.csv',
  });
  assert.equal(planUnconfirmed.readyToImport, false);

  // 2. Once series are confirmed, unreadable cell E5 is skipped (not imported) and listed in acknowledgments
  const stateConfirmed = buildImportPreviewState(parsedWithErr, {
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
  const planConfirmed = buildImportExecutionPlan(parsedWithErr, stateConfirmed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    fileName: 'sample.csv',
  });
  assert.equal(planConfirmed.readyToImport, true);
  assert.equal(planConfirmed.acknowledgmentCounts.unreadableCellsSkipped, 1);
  assert.ok(planConfirmed.acknowledgments.some((a) => a.type === 'unreadable_cells_skipped'));
});

test('buildImportExecutionPlan produces ready plan, categoriesToEnsure, aliasesToSave, and chunked rounds on clean sheet', () => {
  const parsed = parseScoreSheetCsv(CLEAN_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // Add extra categories to Block 1 to test link_existing, create_historical, and mapped_existing + saveAlias
  parsed.blocks[0].categories.push(
    { rowIndex: 9, indexLabel: '6', sheetName: 'Approximation', ref: 'B10', rawKey: 'approximation' },
    { rowIndex: 10, indexLabel: '7', sheetName: 'Mental Math', ref: 'B11', rawKey: 'mentalmath' },
    { rowIndex: 11, indexLabel: '8', sheetName: 'Subtraction Alias', ref: 'B12', rawKey: 'subtractionalias' }
  );
  // Add a cell in Round 1 for Mental Math (rowIndex 10)
  parsed.blocks[0].rounds[0].cells.push({
    rowIndex: 10,
    categoryName: 'Mental Math',
    scoreRef: 'C11',
    timeRef: 'D11',
    rawScore: '30/30',
    rawTime: '1:00',
    status: 'ok',
    correct: 30,
    total: 30,
    timeSeconds: 60,
    note: null,
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
      1: {
        seriesId: 'ser-old',
        confirmed: true,
        adminMappings: {
          mentalmath: {
            action: 'create_historical',
            targetCategoryId: null,
            saveAlias: false,
          },
          subtractionalias: {
            action: 'map',
            targetCategoryId: 'cat-2',
            saveAlias: true,
          },
        },
      },
      2: { seriesId: 'ser-new', confirmed: true, adminMappings: {} },
    },
  });

  const plan = buildImportExecutionPlan(parsed, state, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    fileName: 'clean.csv',
    markVerified: true,
    onDateConflict: 'use_existing',
  });

  assert.equal(plan.readyToImport, true);
  assert.equal(plan.blockingReasons.length, 0);

  const bp1 = plan.blockPlans[0];
  // Approximation is an existing category not in Old simulator -> link_existing op
  assert.ok(
    bp1.categoriesToEnsure.some(
      (op) => op.mode === 'link_existing' && op.p_category === 'cat-4'
    )
  );
  // Mental Math is create_historical in Old simulator
  assert.ok(
    bp1.categoriesToEnsure.some(
      (op) => op.mode === 'create_historical' && op.p_new_name === 'Mental Math'
    )
  );
  // Save alias requested for subtractionalias -> cat-2
  assert.equal(bp1.aliasesToSave.length, 1);
  assert.equal(bp1.aliasesToSave[0].alias, 'subtractionalias');
  assert.equal(bp1.aliasesToSave[0].category_id, 'cat-2');

  // Materialize chunks with newly created category ID for rowIndex 10
  const ensuredMap = new Map([[10, 'cat-mental-99']]);
  const chunksBlk1 = materializeBlockRoundChunks(bp1, ensuredMap);
  assert.equal(chunksBlk1.length, 1);
  assert.equal(chunksBlk1[0].length, 2); // 2 rounds in Block 1
  assert.equal(chunksBlk1[0][0].round_number, 1);
  assert.equal(chunksBlk1[0][0].round_date, '2026-08-17');
  assert.equal(chunksBlk1[0][0].round_type, 'Category wise');
  assert.equal(chunksBlk1[0][0].time_taken_seconds, 3930);

  // Surprise Task in Round 1 has note 'Done' -> correct=null, total=null, note='Done'
  const surpriseCell = chunksBlk1[0][0].cells.find((c) => c.category_id === 'cat-7');
  assert.ok(surpriseCell);
  assert.equal(surpriseCell.correct, null);
  assert.equal(surpriseCell.total, null);
  assert.equal(surpriseCell.note, 'Done');

  // Newly created category Mental Math in Round 1 resolved to 'cat-mental-99'
  const mentalCell = chunksBlk1[0][0].cells.find((c) => c.category_id === 'cat-mental-99');
  assert.ok(mentalCell);
  assert.equal(mentalCell.correct, 30);
  assert.equal(mentalCell.total, 30);
  assert.equal(mentalCell.time_seconds, 60);
});

test('chunkRoundsForImport and materializeBlockRoundChunks split 101 rounds and >3000 cells into valid calls', () => {
  // Create 101 planned rounds with 10 cells each -> must split into 2 calls (100 and 1), both passing validatePayload
  const rounds101 = [];
  for (let i = 1; i <= 101; i++) {
    const cells = [];
    for (let c = 1; c <= 10; c++) {
      cells.push({
        rowIndex: c,
        rawKey: `cat${c}`,
        category_id: `cat-${c}`,
        correct: 40,
        total: 50,
        time_seconds: 60,
        note: null,
      });
    }
    rounds101.push({
      round_number: i,
      round_date: '2026-08-18',
      round_type: 'Category wise',
      time_taken_seconds: 1200,
      cells,
    });
  }

  const chunks101 = materializeBlockRoundChunks(
    { blockNumber: 1, rounds: rounds101 },
    new Map(),
    { maxRoundsPerCall: 100, maxCellsPerCall: 3000 }
  );

  assert.equal(chunks101.length, 2);
  assert.equal(chunks101[0].length, 100);
  assert.equal(chunks101[1].length, 1);
  assert.equal(validatePayload(chunks101[0], { todayIST: '2026-10-18' }).length, 0);
  assert.equal(validatePayload(chunks101[1], { todayIST: '2026-10-18' }).length, 0);
  assert.equal('rawKey' in chunks101[0][0].cells[0], false);
  assert.equal('rowIndex' in chunks101[0][0].cells[0], false);

  // Also test cell limit splitting when a single chunk exceeds 3000 cells with fewer than 100 rounds
  const denseRounds = [];
  for (let i = 1; i <= 80; i++) {
    const cells = Array.from({ length: 50 }, (_, idx) => ({
      category_id: `cat-${idx}`,
      correct: 10,
      total: 10,
      time_seconds: 30,
      note: null,
    }));
    denseRounds.push({
      round_number: i,
      round_date: '2026-08-18',
      round_type: 'Category wise',
      time_taken_seconds: 1000,
      cells,
    });
  }
  const denseChunks = chunkRoundsForImport(denseRounds, {
    maxRoundsPerCall: 100,
    maxCellsPerCall: 3000,
  });
  // 60 rounds * 50 cells = 3000 cells -> chunk 1 has 60 rounds, chunk 2 has 20 rounds
  assert.equal(denseChunks.length, 2);
  assert.equal(denseChunks[0].length, 60);
  assert.equal(denseChunks[1].length, 20);
  assert.equal(validatePayload(denseChunks[0], { todayIST: '2026-10-18' }).length, 0);
  assert.equal(validatePayload(denseChunks[1], { todayIST: '2026-10-18' }).length, 0);
});

test('Phase 4c-2c: Time Taken of 59:23:00 produces null time_taken_seconds in payload, warning in acknowledgments, and passes validatePayload', () => {
  const csv = [
    'INDEX,Category,Round 14,',
    ',,12/08/2026,',
    ',,Score,Time',
    '1,ADD,85/90,1:20',
    ',Round Type,Category wise,',
    ',Time Taken,59:23:00,',
  ].join('\n');

  const parsed = parseScoreSheetCsv(csv, {
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
    },
  });
  const plan = buildImportExecutionPlan(parsed, state, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    fileName: 'round14.csv',
    todayIST: '2026-10-18',
  });

  assert.equal(plan.readyToImport, true);
  assert.equal(plan.totalRounds, 1);
  assert.equal(plan.acknowledgmentCounts.timeTakenOverLimit, 1);
  assert.equal(plan.blockPlans[0].rounds[0].round_number, 14);
  assert.equal(plan.blockPlans[0].rounds[0].time_taken_seconds, null);

  const chunks = materializeBlockRoundChunks(plan.blockPlans[0]);
  assert.equal(chunks[0][0].time_taken_seconds, null);
  assert.equal(validatePayload(chunks[0], { todayIST: '2026-10-18' }).length, 0);
});

test('Phase 4c-2c: validatePayload names the round number, field, and value for each broken rule', () => {
  const brokenPayload = [
    {
      round_number: 100001, // > 100000
      round_date: '2019-12-31', // < 2020-01-01
      round_type: 'X'.repeat(41), // > 40 chars
      time_taken_seconds: 28801, // > 28800
      cells: [
        {
          category_id: 'cat-1',
          correct: 55,
          total: 50, // correct > total
          time_seconds: 14401, // > 14400
          note: null,
        },
        {
          category_id: 'cat-1', // duplicate category_id in same round
          correct: null,
          total: null,
          time_seconds: null,
          note: '', // empty note when correct/total absent
        },
      ],
    },
    {
      round_number: 15,
      round_date: '2026-10-19', // > todayIST (2026-10-18)
      round_type: 'Category wise',
      time_taken_seconds: 1200,
      cells: [
        {
          category_id: 'cat-7',
          correct: null,
          total: null,
          time_seconds: null,
          note: 'Z'.repeat(501), // > 500 chars
        },
      ],
    },
  ];

  const problems = validatePayload(brokenPayload, { todayIST: '2026-10-18' });

  const hasProblem = (rNum, field, val) =>
    problems.some(
      (p) => p.round_number === rNum && p.field === field && p.value === val
    );

  assert.ok(hasProblem(100001, 'round_number', 100001));
  assert.ok(hasProblem(100001, 'round_date', '2019-12-31'));
  assert.ok(hasProblem(100001, 'round_type', 'X'.repeat(41)));
  assert.ok(hasProblem(100001, 'time_taken_seconds', 28801));
  assert.ok(hasProblem(100001, 'correct', 55));
  assert.ok(hasProblem(100001, 'time_seconds', 14401));
  assert.ok(hasProblem(100001, 'category_id', 'cat-1'));
  assert.ok(hasProblem(100001, 'note', ''));
  assert.ok(hasProblem(15, 'round_date', '2026-10-19'));
  assert.ok(hasProblem(15, 'note', 'Z'.repeat(501)));
});

test('Phase 4c-2d: editing a round total time from 59:23:00 to 0:59:23 removes the warning and payload sends 3563 seconds; resetting restores the original', () => {
  const csv = [
    'INDEX,Category,Round 14,',
    ',,12/08/2026,',
    ',,Score,Time',
    '1,ADD,85/90,1:20',
    ',Round Type,Category wise,',
    ',Time Taken,59:23:00,',
  ].join('\n');

  const parsed = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // Before edit: warning present, time_taken_seconds is null in payload
  const initialPayload = buildImportPayload(parsed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    roundSeries: MOCK_ROUND_SERIES,
    categorySeries: MOCK_CATEGORY_SERIES,
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    existingStudentRounds: [],
    existingResults: [],
    blockUiState: {
      1: { seriesId: 'ser-old', confirmed: true, adminMappings: {} },
    },
    fileName: 'round14.csv',
  });
  assert.equal(initialPayload.acknowledgmentCounts.timeTakenOverLimit, 1);
  assert.equal(initialPayload.blockPlans[0].rounds[0].time_taken_seconds, null);

  // Edit Round 14 total time from 59:23:00 to 0:59:23 (3563 seconds)
  const roundValidation = validateRoundEdit(
    {
      skip: false,
      roundDate: '2026-08-12',
      roundType: 'Category wise',
      timeTakenRaw: '0:59:23',
    },
    { todayIST: '2026-10-18' }
  );
  assert.equal(roundValidation.ok, true);
  assert.equal(roundValidation.value.timeTakenSeconds, 3563);

  const editState = createEmptyEditState();
  editState.rounds['1-14'] = roundValidation.value;

  const editedPayload = buildImportPayload(parsed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    roundSeries: MOCK_ROUND_SERIES,
    categorySeries: MOCK_CATEGORY_SERIES,
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    existingStudentRounds: [],
    existingResults: [],
    blockUiState: {
      1: { seriesId: 'ser-old', confirmed: true, adminMappings: {} },
    },
    editState,
    fileName: 'round14.csv',
  });

  // Warning is removed and payload sends 3563 seconds
  assert.equal(editedPayload.acknowledgmentCounts.timeTakenOverLimit, 0);
  assert.equal(
    editedPayload.previewState.combinedAttention.some(
      (i) => i.type === 'time_taken_exceeds_limit'
    ),
    false
  );
  assert.equal(editedPayload.blockPlans[0].rounds[0].time_taken_seconds, 3563);
  assert.equal(editedPayload.edits.length, 1);
  assert.equal(editedPayload.edits[0].round_number, 14);
  assert.equal(editedPayload.edits[0].field, 'time_taken_seconds');
  assert.equal(editedPayload.edits[0].original_value, '59:23:00');
  assert.equal(editedPayload.edits[0].new_value, '0:59:23');

  // Resetting editState restores the original warning and null time_taken_seconds in payload
  const resetPayload = buildImportPayload(parsed, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    roundSeries: MOCK_ROUND_SERIES,
    categorySeries: MOCK_CATEGORY_SERIES,
    roundCategories: MOCK_ROUND_CATEGORIES,
    categoryAliases: [],
    existingStudentRounds: [],
    existingResults: [],
    blockUiState: {
      1: { seriesId: 'ser-old', confirmed: true, adminMappings: {} },
    },
    editState: createEmptyEditState(),
    fileName: 'round14.csv',
  });
  assert.equal(resetPayload.acknowledgmentCounts.timeTakenOverLimit, 1);
  assert.equal(resetPayload.blockPlans[0].rounds[0].time_taken_seconds, null);
  assert.equal(resetPayload.edits.length, 0);
});

test('Phase 4c-2d: editing a cell to make the sums equal the sheet Final Score clears that mismatch', () => {
  const csv = [
    'INDEX,Category,Round 1,',
    ',,17/08/2026,',
    ',,Score,Time',
    '1,ADD,84/90,1:25',
    '2,SUB,40/45,1:10',
    ',Final Score,125,',
    ',Total Attempt,135,',
    ',Marks TO BE CORRECTED,10,',
    ',Round Type,Category wise,',
    ',Time Taken,0:10:00,',
  ].join('\n');

  const parsed = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // Initially: ADD is 84/90 + SUB 40/45 => sumCorrect = 124 (mismatch vs Final Score 125) and sumWrong = 11 (mismatch vs Marks 10)
  const initialRound = parsed.blocks[0].rounds[0];
  assert.equal(initialRound.crossChecks.finalScore.status, 'MISMATCH');
  assert.equal(initialRound.crossChecks.marksToBeCorrected.status, 'MISMATCH');
  assert.equal(
    parsed.needsAttention.some((a) => a.type === 'crosscheck_mismatch'),
    true
  );

  // Edit ADD cell (rowIndex = 3) from 84/90 to 85/90 so sumCorrect = 125 and sumWrong = 10
  const addCellRowIndex = initialRound.cells[0].rowIndex;
  const cellValidation = validateCellEdit({
    skip: false,
    correct: 85,
    total: 90,
    timeRaw: '1:25',
    note: '',
  });
  assert.equal(cellValidation.ok, true);

  const editState = createEmptyEditState();
  editState.cells[`1-1-${addCellRowIndex}`] = cellValidation.value;

  const recalculated = applyPreviewEdits(parsed, { editState, todayIST: '2026-10-18' });
  const updatedRound = recalculated.blocks[0].rounds[0];

  assert.equal(updatedRound.crossChecks.finalScore.status, 'OK');
  assert.equal(updatedRound.crossChecks.finalScore.computedValue, 125);
  assert.equal(updatedRound.crossChecks.totalAttempt.status, 'OK');
  assert.equal(updatedRound.crossChecks.marksToBeCorrected.status, 'OK');
  assert.equal(
    recalculated.needsAttention.some((a) => a.type === 'crosscheck_mismatch'),
    false
  );
});

test('Phase 4c-2d: skipping a round removes it from the payload and from the counts', () => {
  const parsed = parseScoreSheetCsv(CLEAN_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });
  assert.equal(parsed.summary.totalRounds, 5);

  const editState = createEmptyEditState();
  // Skip Block 1 Round 2
  editState.rounds['1-2'] = {
    skip: true,
    roundDate: '2026-08-21',
    roundType: 'Flat Round',
    timeTakenSeconds: 1850,
  };

  const payload = buildImportPayload(parsed, {
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
    editState,
    fileName: 'clean-sheet.csv',
  });

  // Total active rounds drops from 5 to 4; Block 1 only sends Round 1
  assert.equal(payload.previewState.effectiveParsed.summary.totalRounds, 4);
  assert.equal(payload.previewState.effectiveParsed.summary.skippedRoundsCount, 1);
  assert.equal(payload.totalRounds, 4);
  assert.equal(payload.blockPlans[0].rounds.length, 1);
  assert.equal(payload.blockPlans[0].rounds[0].round_number, 1);

  // Edits list records the skipped round
  assert.equal(payload.edits.length, 1);
  assert.equal(payload.edits[0].round_number, 2);
  assert.equal(payload.edits[0].skipped, true);
  assert.equal(payload.edits[0].field, 'round_skipped');
});

test('Phase 4c-2d: invalid edit (correct greater than total) is rejected with a message, and edits list contains original and new values', () => {
  // 1. Invalid cell edit: correct > total
  const badEdit = validateCellEdit({
    skip: false,
    correct: 80,
    total: 75,
    timeRaw: '1:10',
    note: '',
  });
  assert.equal(badEdit.ok, false);
  assert.match(badEdit.error, /Correct \(80\) cannot be greater than Total \(75\)/);

  // 2. Invalid cell edit: time > 4 hours (14400s)
  const badTimeEdit = validateCellEdit({
    skip: false,
    correct: 70,
    total: 75,
    timeRaw: '4:00:01',
    note: '',
  });
  assert.equal(badTimeEdit.ok, false);
  assert.match(badTimeEdit.error, /between 0 and 4 hours/);

  // 3. Valid edits populate buildPreviewEditsList and p_summary.edits with original_value and new_value
  const parsed = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  // Fix unreadable cell in Block 1 Round 1 ADD (rowIndex = 5, rawTime was "75")
  const b1r1 = parsed.blocks[0].rounds[0];
  const unreadableAddCell = b1r1.cells.find((c) => c.categoryName === 'ADD');
  assert.equal(unreadableAddCell.status, 'unreadable');

  const editState = createEmptyEditState();
  editState.cells[`1-1-${unreadableAddCell.rowIndex}`] = {
    skip: false,
    correct: 75,
    total: 75,
    timeSeconds: 72,
    note: null,
  };
  editState.rounds['1-1'] = {
    skip: false,
    roundDate: '2026-08-17',
    roundType: 'Flat Round', // changed from 'Category wise'
    timeTakenSeconds: 2510,
  };

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
    editState,
  });

  // Unreadable cell is now 'ok' and counts as an ok cell
  const fixedCell = state.effectiveParsed.blocks[0].rounds[0].cells.find(
    (c) => c.categoryName === 'ADD'
  );
  assert.equal(fixedCell.status, 'ok');
  assert.equal(fixedCell.isEdited, true);

  const editsList = state.editsList;
  assert.ok(editsList.length >= 2);

  const roundTypeEdit = editsList.find(
    (e) => e.round_number === 1 && e.field === 'round_type'
  );
  assert.ok(roundTypeEdit);
  assert.equal(roundTypeEdit.series, 'Old simulator');
  assert.equal(roundTypeEdit.original_value, 'Category wise');
  assert.equal(roundTypeEdit.new_value, 'Flat Round');
  assert.equal(roundTypeEdit.skipped, false);

  const cellTimeEdit = editsList.find(
    (e) => e.round_number === 1 && e.field === 'ADD.time_seconds'
  );
  assert.ok(cellTimeEdit);
  assert.equal(cellTimeEdit.original_value, '75');
  assert.equal(cellTimeEdit.new_value, '1:12');
});


