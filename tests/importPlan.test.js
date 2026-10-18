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

test('buildImportExecutionPlan blocks import when unreadable cells or unconfirmed series exist', () => {
  // SAMPLE_TWO_BLOCK_CSV has 'abc' in E5 (unreadable time)
  const parsedWithErr = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });
  const stateWithErr = buildImportPreviewState(parsedWithErr, {
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
  const planErr = buildImportExecutionPlan(parsedWithErr, stateWithErr, {
    selectedStudent: { id: 'stu-1', full_name: 'TEST STUDENT', student_code: 'STU101' },
    fileName: 'sample.csv',
  });
  assert.equal(planErr.readyToImport, false);
  assert.ok(planErr.blockingReasons.some((r) => r.includes('Unreadable cell E5')));
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

test('chunkRoundsForImport and materializeBlockRoundChunks split rounds respecting maxRoundsPerCall (<=100) and maxCellsPerCall (<=3000)', () => {
  // Create 120 planned rounds with 30 cells each (3,600 total cells)
  const manyRounds = [];
  for (let i = 1; i <= 120; i++) {
    const cells = [];
    for (let c = 1; c <= 30; c++) {
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
    manyRounds.push({
      round_number: i,
      round_date: '2026-08-18',
      round_type: 'Category wise',
      time_taken_seconds: 1200,
      cells,
    });
  }

  const chunks = materializeBlockRoundChunks(
    { blockNumber: 1, rounds: manyRounds },
    new Map(),
    { maxRoundsPerCall: 100, maxCellsPerCall: 3000 }
  );

  // 100 rounds * 30 cells = 3000 cells in chunk 1, remaining 20 rounds in chunk 2
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks[1].length, 20);
  // Verify rawKey and rowIndex are stripped from final RPC payload cells
  assert.equal('rawKey' in chunks[0][0].cells[0], false);
  assert.equal('rowIndex' in chunks[0][0].cells[0], false);

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
});
