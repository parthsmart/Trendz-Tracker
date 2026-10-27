/**
 * Trendz Tracker — Phase 10d Score-Sheet Mirror Unit Tests (tests/mirror.test.js)
 *
 * Covers:
 * 1. Shared colour boundaries (0 wrong -> green, 1 wrong -> orange, 10 wrong -> orange, 11 wrong -> cyan, total 0 -> null)
 * 2. Single series, two rounds (newest on the left): positions of Name, level, ROUND 2, ROUND 1, dates,
 *    Score/Time headers, categories, empty row, 5 summary rows, Final Score, Total Attempt, Marks TO BE CORRECTED
 * 3. Flat round: per-category Time cells are empty; Time Taken shows round time_taken_seconds in hh:mm:ss
 * 4. Round without time: Time Taken is "Without time"
 * 5. Surprise Task: numeric score -> "5/6" coloured and counted; note -> text, not coloured, not counted; neither -> "........"
 * 6. Two series (current + old): current is on the left, separated from old series by two empty columns;
 *    shorter block padded so summary rows line up
 * 7. Tab name cleaning: illegal characters removed, length capped at 95, duplicate names disambiguated (" 2", " 3")
 * 8. Stale student selection: only students whose fingerprint differs (or who have no row in mirror_state) are returned,
 *    never-built first, then oldest first
 * 9. Round-trip test: feed buildStudentTabModel (converted to CSV via modelToCsv) into parseScoreSheetCsv from js/importParser.js
 *    and verify rounds, dates, round types, scores, times, and Final Score match.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SCORE_COLOR_HEX,
  getScoreColor,
  getScoreColorHex,
  getScoreFeedback,
} from '../js/scoreColors.js';
import {
  MIRROR_FROZEN_ROWS,
  MIRROR_FROZEN_COLUMNS,
  MIRROR_COL_WIDTHS,
  tabNameFor,
  staleStudents,
  buildStudentTabModel,
  buildInfoModel,
  modelToCsv,
} from '../api/_mirror.js';
import { parseScoreSheetCsv } from '../js/importParser.js';
import { getGoogleMirrorConfig, hasGoogleMirrorConfig } from '../api/_configHelper.js';

describe('1. Shared Colour Rule (shared/scoreColors.js & js/scoreColors.js)', () => {
  it('enforces exact boundaries for 0, 1, 10, 11 wrong and total 0 / no data', () => {
    assert.equal(SCORE_COLOR_HEX.green, '#00E000');
    assert.equal(SCORE_COLOR_HEX.orange, '#FF9900');
    assert.equal(SCORE_COLOR_HEX.cyan, '#00E5FF');

    // 0 wrong and total > 0 -> green
    assert.equal(getScoreColor(20, 20), 'green');
    assert.equal(getScoreColorHex(20, 20), '#00E000');

    // 1 wrong -> orange
    assert.equal(getScoreColor(19, 20), 'orange');
    assert.equal(getScoreColorHex(19, 20), '#FF9900');

    // 10 wrong -> orange
    assert.equal(getScoreColor(10, 20), 'orange');
    assert.equal(getScoreColorHex(10, 20), '#FF9900');

    // 11 wrong -> cyan
    assert.equal(getScoreColor(9, 20), 'cyan');
    assert.equal(getScoreColorHex(9, 20), '#00E5FF');

    // total 0 or missing -> null
    assert.equal(getScoreColor(0, 0), null);
    assert.equal(getScoreColorHex(0, 0), null);
    assert.equal(getScoreColor(null, 20), null);
    assert.equal(getScoreColor(10, null), null);
    assert.equal(getScoreFeedback(0, 0).color, null);
  });
});

describe('2. Single Series, Two Rounds (Newest on the Left)', () => {
  const sampleData = {
    student: {
      id: 'stu-1',
      code: 'trendz_riya',
      name: 'Riya Sen',
      level: 'Junior 1',
    },
    series: [{ id: 'ser-2026', name: '2026 Main Series', is_current: true }],
    categories: [
      { id: 'cat-add', name: 'ADD', series_id: 'ser-2026', sort_order: 1 },
      { id: 'cat-mult', name: 'MULT', series_id: 'ser-2026', sort_order: 2 },
      { id: 'cat-div', name: 'DIV', series_id: 'ser-2026', sort_order: 3 },
    ],
    rounds: [
      // Newest round first (ROUND 2 on the left, ROUND 1 on the right)
      {
        id: 'rnd-2',
        series_id: 'ser-2026',
        number: 2,
        date: '2026-10-24',
        type: 'Category wise',
        time_taken_seconds: 4141, // 01:09:01
        cells: [
          { category_id: 'cat-add', correct: 20, total: 20, time_seconds: 138, note: null }, // 0 wrong -> green, 2:18
          { category_id: 'cat-mult', correct: 15, total: 20, time_seconds: 45, note: null }, // 5 wrong -> orange, 0:45
          { category_id: 'cat-div', correct: 8, total: 20, time_seconds: 3909, note: null }, // 12 wrong -> cyan, 1:05:09
        ],
      },
      {
        id: 'rnd-1',
        series_id: 'ser-2026',
        number: 1,
        date: '2026-10-17',
        type: 'Category wise',
        time_taken_seconds: 300, // 00:05:00
        cells: [
          { category_id: 'cat-add', correct: 19, total: 20, time_seconds: 120, note: null },
          { category_id: 'cat-mult', correct: 10, total: 20, time_seconds: 180, note: null },
        ],
      },
    ],
  };

  it('places Name, level, ROUND 2, ROUND 1, dates, Score/Time headers, categories, empty row, and 5 summary rows in exact positions', () => {
    const model = buildStudentTabModel(sampleData);

    assert.equal(model.frozenRows, MIRROR_FROZEN_ROWS);
    assert.equal(model.frozenColumns, MIRROR_FROZEN_COLUMNS);

    // 3 base cols + 2 rounds * 2 cols = 7 columns
    assert.equal(model.columnCount, 7);
    // 4 header rows + 3 categories + 1 empty row + 5 summary rows = 13 rows
    assert.equal(model.rowCount, 13);

    // Column widths: Col 0 (45), Col 1 (150), Col 2 (10), Col 3 (80), Col 4 (60), Col 5 (80), Col 6 (60)
    assert.deepEqual(
      model.columnWidths.map((w) => w.width),
      [
        MIRROR_COL_WIDTHS.index,
        MIRROR_COL_WIDTHS.category,
        MIRROR_COL_WIDTHS.spacer,
        MIRROR_COL_WIDTHS.score,
        MIRROR_COL_WIDTHS.time,
        MIRROR_COL_WIDTHS.score,
        MIRROR_COL_WIDTHS.time,
      ]
    );

    const g = model.cells;

    // Row 1 (index 0): Name in (0,0), Level in capitals above each round's Score column (cols 3 and 5)
    assert.equal(g[0][0].text, 'Name -- RIYA SEN');
    assert.equal(g[0][0].bold, true);
    assert.equal(g[0][3].text, 'JUNIOR 1');
    assert.equal(g[0][5].text, 'JUNIOR 1');

    // Row 2 (index 1): INDEX, Category, ROUND 2 (col 3), ROUND 1 (col 5)
    assert.equal(g[1][0].text, 'INDEX');
    assert.equal(g[1][1].text, 'Category');
    assert.equal(g[1][2].text, ''); // empty spacer column
    assert.equal(g[1][3].text, 'ROUND 2');
    assert.equal(g[1][5].text, 'ROUND 1');

    // Row 3 (index 2): Date - dd/mm/yyyy above each Score column
    assert.equal(g[2][3].text, 'Date - 24/10/2026');
    assert.equal(g[2][5].text, 'Date - 17/10/2026');

    // Row 4 (index 3): Score and Time labels
    assert.equal(g[3][3].text, 'Score');
    assert.equal(g[3][4].text, 'Time');
    assert.equal(g[3][5].text, 'Score');
    assert.equal(g[3][6].text, 'Time');

    // Rows 5..7 (indices 4..6): Categories 1..3
    assert.equal(g[4][0].number, 1);
    assert.equal(g[4][1].text, 'ADD');
    assert.equal(g[4][3].text, '20/20');
    assert.equal(g[4][3].bg, '#00E000'); // green
    assert.equal(g[4][4].text, '2:18');

    assert.equal(g[5][0].number, 2);
    assert.equal(g[5][1].text, 'MULT');
    assert.equal(g[5][3].text, '15/20');
    assert.equal(g[5][3].bg, '#FF9900'); // orange
    assert.equal(g[5][4].text, '0:45');

    assert.equal(g[6][0].number, 3);
    assert.equal(g[6][1].text, 'DIV');
    assert.equal(g[6][3].text, '8/20');
    assert.equal(g[6][3].bg, '#00E5FF'); // cyan
    assert.equal(g[6][4].text, '1:05:09');

    // Round 1 (col 5 & 6): DIV had no cell -> stays empty with no background
    assert.equal(g[6][5].text, '');
    assert.equal(g[6][5].bg, null);
    assert.equal(g[6][6].text, '');

    // Row 8 (index 7): Empty separator row
    for (let c = 0; c < model.columnCount; c++) {
      assert.equal(g[7][c].text || '', '');
      assert.equal(g[7][c].number, undefined);
    }

    // Summary Rows (indices 8..12)
    assert.equal(g[8][1].text, 'Round Type');
    assert.equal(g[8][3].text, 'Category wise');
    assert.equal(g[8][3].bold, true);
    assert.equal(g[8][3].bg, null);

    assert.equal(g[9][1].text, 'Time Taken');
    assert.equal(g[9][3].text, '01:09:01');
    assert.equal(g[9][5].text, '00:05:00');

    assert.equal(g[10][1].text, 'Final Score');
    assert.equal(g[10][3].number, 43); // 20 + 15 + 8
    assert.equal(g[10][5].number, 29); // 19 + 10

    assert.equal(g[11][1].text, 'Total Attempt');
    assert.equal(g[11][3].number, 60); // 20 + 20 + 20
    assert.equal(g[11][5].number, 40); // 20 + 20

    assert.equal(g[12][1].text, 'Marks TO BE CORRECTED');
    assert.equal(g[12][3].number, 17); // 60 - 43
    assert.equal(g[12][5].number, 11); // 40 - 29
  });
});

describe('3 & 4. Flat Round and Round Without Time', () => {
  it('leaves per-category Time cells empty for Flat rounds and formats Time Taken or "Without time"', () => {
    const model = buildStudentTabModel({
      student: { id: 'stu-2', code: 'aarav', name: 'Aarav', level: null },
      series: [{ id: 's1', name: 'Current', is_current: true }],
      categories: [
        { id: 'c1', name: 'ADD', series_id: 's1', sort_order: 1 },
        { id: 'c2', name: 'SUB', series_id: 's1', sort_order: 2 },
      ],
      rounds: [
        {
          id: 'r-flat',
          series_id: 's1',
          number: 2,
          date: '2026-10-25',
          type: 'Flat Round',
          time_taken_seconds: 1845, // 00:30:45
          cells: [
            { category_id: 'c1', correct: 18, total: 20, time_seconds: 110, note: null },
            { category_id: 'c2', correct: 20, total: 20, time_seconds: 95, note: null },
          ],
        },
        {
          id: 'r-notime',
          series_id: 's1',
          number: 1,
          date: '2026-10-20',
          type: 'Category wise',
          time_taken_seconds: null,
          cells: [
            { category_id: 'c1', correct: 15, total: 20, time_seconds: null, note: null },
          ],
        },
      ],
    });

    const g = model.cells;

    // Student has no level -> Row 1 above score columns stays empty
    assert.equal(g[0][3].text, '');
    assert.equal(g[0][5].text, '');

    // Flat Round (col 3 = Score, col 4 = Time): per-category Time cells must be empty
    assert.equal(g[4][3].text, '18/20');
    assert.equal(g[4][4].text, '');
    assert.equal(g[5][3].text, '20/20');
    assert.equal(g[5][4].text, '');

    // Summary row Time Taken (row index 4 + 2 + 1 + 1 = 8)
    assert.equal(g[7][1].text, 'Round Type');
    assert.equal(g[7][3].text, 'Flat Round');
    assert.equal(g[8][1].text, 'Time Taken');
    assert.equal(g[8][3].text, '00:30:45');

    // Round 1 without time -> Time Taken is "Without time"
    assert.equal(g[8][5].text, 'Without time');
  });
});

describe('5. Surprise Task Cell Rules', () => {
  it('handles numeric score ("5/6" coloured and counted), text note (uncoloured, not counted), and empty ("........")', () => {
    const model = buildStudentTabModel({
      student: { id: 'stu-3', code: 'kabir', name: 'Kabir', level: 'Level 4' },
      series: [{ id: 's1', name: 'Series 1', is_current: true }],
      categories: [
        { id: 'c-add', name: 'ADD', series_id: 's1', sort_order: 1 },
        { id: 'c-sur', name: 'Surprise Task', series_id: 's1', sort_order: 2 },
      ],
      rounds: [
        {
          id: 'r3',
          series_id: 's1',
          number: 3,
          date: '2026-10-26',
          type: 'Category wise',
          time_taken_seconds: 120,
          cells: [
            { category_id: 'c-add', correct: 10, total: 10, time_seconds: 60 },
            { category_id: 'c-sur', correct: 5, total: 6, time_seconds: 60 },
          ],
        },
        {
          id: 'r2',
          series_id: 's1',
          number: 2,
          date: '2026-10-25',
          type: 'Category wise',
          time_taken_seconds: 120,
          cells: [
            { category_id: 'c-add', correct: 10, total: 10, time_seconds: 60 },
            { category_id: 'c-sur', correct: null, total: null, time_seconds: null, note: ' Practised oral cube roots ' },
          ],
        },
        {
          id: 'r1',
          series_id: 's1',
          number: 1,
          date: '2026-10-24',
          type: 'Category wise',
          time_taken_seconds: 120,
          cells: [
            { category_id: 'c-add', correct: 10, total: 10, time_seconds: 60 },
          ],
        },
      ],
    });

    const g = model.cells;
    const surRow = 5; // 2nd category -> index 5
    const finalScoreRow = 4 + 2 + 1 + 2; // index 9
    const totalAttemptRow = finalScoreRow + 1; // index 10

    // Round 3 (scoreCol = 3): numeric Surprise Task "5/6", coloured orange (1 wrong), counted in Final Score (10+5=15) & Total Attempt (10+6=16)
    assert.equal(g[surRow][3].text, '5/6');
    assert.equal(g[surRow][3].bg, '#FF9900');
    assert.equal(g[finalScoreRow][3].number, 15);
    assert.equal(g[totalAttemptRow][3].number, 16);

    // Round 2 (scoreCol = 5): note -> trimmed text, no bg colour, not counted in Final Score (10)
    assert.equal(g[surRow][5].text, 'Practised oral cube roots');
    assert.equal(g[surRow][5].bg, null);
    assert.equal(g[finalScoreRow][5].number, 10);
    assert.equal(g[totalAttemptRow][5].number, 10);

    // Round 1 (scoreCol = 7): neither score nor note -> "........"
    assert.equal(g[surRow][7].text, '........');
    assert.equal(g[surRow][7].bg, null);
    assert.equal(g[finalScoreRow][7].number, 10);
    assert.equal(g[totalAttemptRow][7].number, 10);
  });
});

describe('6. Two Series (Current + Old) Alignment & Separation', () => {
  it('places current series on the left, separates blocks by 2 empty columns, and pads shorter blocks so summary rows line up', () => {
    const model = buildStudentTabModel({
      student: { id: 'stu-4', code: 'meera', name: 'Meera', level: 'Master' },
      series: [
        // Intentionally pass old series first in array to verify is_current sorting puts current first
        { id: 's-old', name: '2025 Archive', is_current: false },
        { id: 's-cur', name: '2026 Current', is_current: true },
        { id: 's-empty', name: 'Empty Series', is_current: false },
      ],
      categories: [
        // Current series has 2 categories
        { id: 'c1', name: 'ADD', series_id: 's-cur', sort_order: 1 },
        { id: 'c2', name: 'MULT', series_id: 's-cur', sort_order: 2 },
        // Old series has 4 categories
        { id: 'o1', name: 'Old Cat 1', series_id: 's-old', sort_order: 1 },
        { id: 'o2', name: 'Old Cat 2', series_id: 's-old', sort_order: 2 },
        { id: 'o3', name: 'Old Cat 3', series_id: 's-old', sort_order: 3 },
        { id: 'o4', name: 'Old Cat 4', series_id: 's-old', sort_order: 4 },
      ],
      rounds: [
        {
          id: 'rc-1',
          series_id: 's-cur',
          number: 1,
          date: '2026-10-10',
          type: 'Category wise',
          time_taken_seconds: 100,
          cells: [{ category_id: 'c1', correct: 10, total: 10, time_seconds: 50 }],
        },
        {
          id: 'ro-1',
          series_id: 's-old',
          number: 1,
          date: '2025-12-01',
          type: 'Category wise',
          time_taken_seconds: 200,
          cells: [{ category_id: 'o4', correct: 19, total: 20, time_seconds: 60 }],
        },
      ],
    });

    // Block 1 (s-cur): cols 0..4 (3 base + 1 round * 2 cols = 5 cols)
    // Separator: cols 5, 6 (2 empty columns, each width 30)
    // Block 2 (s-old): cols 7..11 (5 cols)
    assert.equal(model.columnCount, 12);
    assert.equal(model.columnWidths[5].width, 30);
    assert.equal(model.columnWidths[6].width, 30);

    const g = model.cells;
    // Block 1 starts at col 0; Block 2 starts at col 7
    assert.equal(g[1][0].text, 'INDEX');
    assert.equal(g[1][1].text, 'Category');
    assert.equal(g[2][3].text, 'Date - 10/10/2026'); // current series on the left

    // Separator columns 5 and 6 are completely empty across all rows
    for (let r = 0; r < model.rowCount; r++) {
      assert.equal(g[r][5].text || '', '');
      assert.equal(g[r][6].text || '', '');
    }

    assert.equal(g[1][7].text, 'INDEX');
    assert.equal(g[1][8].text, 'Category');
    assert.equal(g[2][10].text, 'Date - 01/12/2025'); // old series on the right

    // Max categories = 4 -> rows 4..7 are categories, row 8 is empty, rows 9..13 are summary rows
    // Block 1 (only 2 categories) has padded empty rows at indices 6 and 7, and its summary rows line up at rows 9..13
    assert.equal(g[6][1].text, '');
    assert.equal(g[7][1].text, '');
    assert.equal(g[7][8].text, 'Old Cat 4');

    // Summary rows line up at row 9 ("Round Type") through row 13 ("Marks TO BE CORRECTED") in both blocks
    assert.equal(g[9][1].text, 'Round Type');
    assert.equal(g[9][8].text, 'Round Type');
    assert.equal(g[11][1].text, 'Final Score');
    assert.equal(g[11][3].number, 10);
    assert.equal(g[11][8].text, 'Final Score');
    assert.equal(g[11][10].number, 19);
  });
});

describe('7. Tab Name Cleaning & Disambiguation (tabNameFor)', () => {
  it('strips trendz_ prefix, removes illegal characters, caps at 95 chars, and disambiguates duplicates', () => {
    const used = new Set();

    // Standard student
    assert.equal(tabNameFor({ name: 'Riya', code: 'trendz_riya' }, used), 'Riya (riya)');

    // Duplicate gets " 2" and " 3"
    assert.equal(tabNameFor({ name: 'Riya', code: 'trendz_riya' }, used), 'Riya (riya) 2');
    assert.equal(tabNameFor({ name: 'Riya', code: 'trendz_riya' }, used), 'Riya (riya) 3');

    // Forbidden characters [ ] * ? : / \ removed
    const cleaned = tabNameFor(
      { name: 'Aarav [Jr]*?: / \\ Sharma', code: 'trendz_aarav:1' },
      used
    );
    assert.ok(!/[\[\]*?:\/\\]/.test(cleaned));
    assert.equal(cleaned, 'Aarav Jr Sharma (aarav1)');

    // Very long name capped at <= 95 characters
    const longName = 'A'.repeat(120);
    const capped = tabNameFor({ name: longName, code: 'trendz_longcode' }, used);
    assert.ok(capped.length <= 95);
    assert.ok(capped.endsWith('(longcode)'));

    const cappedDup = tabNameFor({ name: longName, code: 'trendz_longcode' }, used);
    assert.ok(cappedDup.length <= 95);
    assert.ok(cappedDup.endsWith(' 2'));
  });
});

describe('8. Stale Student Selection (staleStudents)', () => {
  it('returns only stale or missing students, ordered never-built first then oldest last_built_at first', () => {
    const fingerprints = [
      { student_id: 'stu-fresh', fingerprint: 'fp-1' },
      { student_id: 'stu-newer-stale', fingerprint: 'fp-2-new' },
      { student_id: 'stu-never-built', fingerprint: 'fp-3' },
      { student_id: 'stu-older-stale', fingerprint: 'fp-4-new' },
      { student_id: 'stu-null-fp', fingerprint: 'fp-5' },
    ];

    const stateRows = [
      {
        student_id: 'stu-fresh',
        fingerprint: 'fp-1',
        last_built_at: '2026-10-25T10:00:00Z',
        last_error: null,
      },
      {
        student_id: 'stu-newer-stale',
        fingerprint: 'fp-2-old',
        last_built_at: '2026-10-24T10:00:00Z',
        last_error: null,
      },
      {
        student_id: 'stu-older-stale',
        fingerprint: 'fp-4-old',
        last_built_at: '2026-10-20T08:00:00Z',
        last_error: null,
      },
      {
        student_id: 'stu-null-fp',
        fingerprint: null,
        last_built_at: null,
        last_error: null,
      },
    ];

    const stale = staleStudents(fingerprints, stateRows);
    assert.deepEqual(stale, [
      'stu-never-built',
      'stu-null-fp',
      'stu-older-stale',
      'stu-newer-stale',
    ]);
  });
});

describe('9. Round-Trip Test: buildStudentTabModel -> modelToCsv -> parseScoreSheetCsv', () => {
  it('round-trips student rounds, dates, round types, scores, times, and Final Score through parseScoreSheetCsv', () => {
    const categories = [
      { id: 'cat-1', name: 'ADD', series_id: 'ser-1', sort_order: 1 },
      { id: 'cat-2', name: 'MULT', series_id: 'ser-1', sort_order: 2 },
      { id: 'cat-3', name: 'Square Root', series_id: 'ser-1', sort_order: 3 },
      { id: 'cat-4', name: 'Surprise Task', series_id: 'ser-1', sort_order: 4 },
    ];

    const originalData = {
      student: {
        id: 'stu-rt',
        code: 'trendz_diya',
        name: 'Diya Patel',
        level: 'Level 3',
      },
      series: [{ id: 'ser-1', name: '2026 Series', is_current: true }],
      categories,
      rounds: [
        {
          id: 'r-2',
          series_id: 'ser-1',
          number: 2,
          date: '2026-10-24',
          type: 'Flat Round',
          time_taken_seconds: 1500, // 00:25:00
          cells: [
            { category_id: 'cat-1', correct: 20, total: 20, time_seconds: null },
            { category_id: 'cat-2', correct: 18, total: 20, time_seconds: null },
            { category_id: 'cat-3', correct: 9, total: 10, time_seconds: null },
            { category_id: 'cat-4', correct: null, total: null, time_seconds: null, note: null },
          ],
        },
        {
          id: 'r-1',
          series_id: 'ser-1',
          number: 1,
          date: '2026-10-17',
          type: 'Category wise',
          time_taken_seconds: 225, // 00:03:45
          cells: [
            { category_id: 'cat-1', correct: 19, total: 20, time_seconds: 95 },
            { category_id: 'cat-2', correct: 17, total: 20, time_seconds: 130 },
            { category_id: 'cat-3', correct: null, total: null, time_seconds: null },
            { category_id: 'cat-4', correct: 5, total: 6, time_seconds: null },
          ],
        },
      ],
    };

    const model = buildStudentTabModel(originalData);
    const csvText = modelToCsv(model);

    const parsed = parseScoreSheetCsv(csvText, {
      categories,
    });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.error, null);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].rounds.length, 2);

    const parsedR2 = parsed.blocks[0].rounds.find((r) => r.roundNumber === 2);
    const parsedR1 = parsed.blocks[0].rounds.find((r) => r.roundNumber === 1);

    assert.ok(parsedR2, 'Round 2 must be parsed');
    assert.equal(parsedR2.dateISO, '2026-10-24');
    assert.equal(parsedR2.summary.roundType, 'Flat Round');
    assert.equal(parsedR2.summary.timeTakenSeconds, 1500);
    assert.equal(parsedR2.computed.sumCorrect, 47); // 20 + 18 + 9
    assert.equal(parsedR2.summary.finalScore, 47);
    assert.equal(parsedR2.crossChecks.finalScore.status, 'OK');

    assert.ok(parsedR1, 'Round 1 must be parsed');
    assert.equal(parsedR1.dateISO, '2026-10-17');
    assert.equal(parsedR1.summary.roundType, 'Category wise');
    assert.equal(parsedR1.summary.timeTakenSeconds, 225);
    assert.equal(parsedR1.computed.sumCorrect, 41); // 19 + 17 + 5
    assert.equal(parsedR1.summary.finalScore, 41);
    assert.equal(parsedR1.crossChecks.finalScore.status, 'OK');

    // Check individual category cells in Round 1
    const r1Add = parsedR1.cells.find((e) => e.categoryName === 'ADD');
    assert.equal(r1Add.correct, 19);
    assert.equal(r1Add.total, 20);
    assert.equal(r1Add.timeSeconds, 95);

    const r1Mult = parsedR1.cells.find((e) => e.categoryName === 'MULT');
    assert.equal(r1Mult.correct, 17);
    assert.equal(r1Mult.total, 20);
    assert.equal(r1Mult.timeSeconds, 130);
  });

  it('builds INFO tab model with read-only warning and timestamp', () => {
    const info = buildInfoModel(
      [{ name: 'Riya', code: 'riya', level: 'Junior 1', tab_name: 'Riya (riya)', last_built_at: '2026-10-27T04:00:00Z' }],
      '2026-10-27T04:00:00Z'
    );
    assert.ok(info.cells[1][0].text.includes('Do not edit — this sheet is overwritten from the website.'));
    assert.equal(info.cells[5][3].text, 'Riya (riya)');
  });

  it('extracts mirrorSheetId and sheetId in getGoogleMirrorConfig (bare ID or full Google Sheets URL)', () => {
    const fakeServiceAccount = JSON.stringify({
      client_email: 'backup-bot@trendz.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    });

    assert.equal(
      hasGoogleMirrorConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccount, MIRROR_SHEET_ID: '' }),
      false
    );

    const cfgBare = getGoogleMirrorConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccount,
      MIRROR_SHEET_ID: '1AbCdEfGhIjKlMnOpQrStUvWxYz_12345',
    });
    assert.equal(cfgBare.mirrorSheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz_12345');
    assert.equal(cfgBare.sheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz_12345');

    const cfgUrl = getGoogleMirrorConfig({
      GOOGLE_SERVICE_ACCOUNT_JSON: fakeServiceAccount,
      MIRROR_SHEET_ID: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_12345/edit#gid=0',
    });
    assert.equal(cfgUrl.mirrorSheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz_12345');
    assert.equal(cfgUrl.sheetId, '1AbCdEfGhIjKlMnOpQrStUvWxYz_12345');
  });
});
