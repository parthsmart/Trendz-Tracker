/**
 * Unit Tests for Trendz Tracker Score Sheet CSV Parser (tests/importParser.test.js)
 * Run with: node --test tests/importParser.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colLabel,
  cellRef,
  parseCsv,
  parseTimeCell,
  parseScoreCell,
  normalizeCategoryKey,
  parseScoreSheetCsv,
  SAMPLE_TWO_BLOCK_CSV,
} from '../js/importParser.js';

const MOCK_DB_ROUND_CATEGORIES = [
  { id: 'cat-1', name: 'ADD', section: 'round', active: true, sort_order: 1 },
  { id: 'cat-2', name: 'SUB', section: 'round', active: true, sort_order: 2 },
  { id: 'cat-3', name: 'MIX', section: 'round', active: true, sort_order: 3 },
  { id: 'cat-4', name: 'HCF and LCM', section: 'round', active: true, sort_order: 4 },
  { id: 'cat-5', name: 'Approximation', section: 'round', active: true, sort_order: 5 },
  { id: 'cat-6', name: 'Calendar', section: 'round', active: true, sort_order: 6 },
  { id: 'cat-7', name: 'Time Elapsed', section: 'round', active: true, sort_order: 7 },
  { id: 'cat-8', name: 'Surprise Task', section: 'round', active: true, sort_order: 8 },
  { id: 'cat-9', name: 'Missing Figures', section: 'round', active: false, sort_order: 9 },
];

test('colLabel and cellRef convert 0-based indices to spreadsheet coordinates', () => {
  assert.equal(colLabel(0), 'A');
  assert.equal(colLabel(25), 'Z');
  assert.equal(colLabel(26), 'AA');
  assert.equal(colLabel(27), 'AB');
  assert.equal(colLabel(51), 'AZ');
  assert.equal(colLabel(52), 'BA');
  assert.equal(colLabel(153), 'EX');

  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(4, 3), 'D5');
  assert.equal(cellRef(4, 4), 'E5');
  assert.equal(cellRef(8, 3), 'D9');
  assert.equal(cellRef(9, 14), 'O10');
});

test('parseCsv handles UTF-8 BOM, quoted fields, escaped quotes, newlines inside quotes, CRLF, and ragged rows', () => {
  const raw =
    '\uFEFF"Header, 1","Header ""Quoted"" 2",Header 3\r\n' +
    '"Line 1\nLine 2",plain,extra,ragged\r\n' +
    'short\n';

  const grid = parseCsv(raw, 2);
  assert.equal(grid.length, 3);
  // Widest row has 4 cols + 2 spare = 6 cols
  assert.equal(grid[0].length, 6);
  assert.equal(grid[1].length, 6);
  assert.equal(grid[2].length, 6);

  assert.equal(grid[0][0], 'Header, 1');
  assert.equal(grid[0][1], 'Header "Quoted" 2');
  assert.equal(grid[0][2], 'Header 3');
  assert.equal(grid[1][0], 'Line 1\nLine 2');
  assert.equal(grid[1][3], 'ragged');
  assert.equal(grid[2][0], 'short');
  assert.equal(grid[2][1], '');
});

test('parseTimeCell accepts m:ss and h:mm:ss and rejects plain numbers like "75"', () => {
  assert.deepEqual(parseTimeCell(''), { status: 'empty', seconds: null, raw: '', reason: null });
  assert.deepEqual(parseTimeCell('......'), { status: 'empty', seconds: null, raw: '......', reason: null });
  assert.deepEqual(parseTimeCell('1:42'), { status: 'ok', seconds: 102, raw: '1:42', reason: null });
  assert.deepEqual(parseTimeCell('01:08:37'), { status: 'ok', seconds: 4117, raw: '01:08:37', reason: null });

  const plainNum = parseTimeCell('75');
  assert.equal(plainNum.status, 'unreadable');
  assert.equal(plainNum.seconds, null);

  const badSecs = parseTimeCell('2:65');
  assert.equal(badSecs.status, 'unreadable');
});

test('parseScoreCell validates ratios, dots-only empty cells, Surprise Task notes, and rejects correct > total ("95/90")', () => {
  assert.equal(parseScoreCell('......').status, 'empty');
  assert.deepEqual(parseScoreCell('75/75'), {
    status: 'ok',
    correct: 75,
    total: 75,
    note: null,
    reason: null,
  });

  const invalidRatio = parseScoreCell('95/90');
  assert.equal(invalidRatio.status, 'unreadable');
  assert.match(invalidRatio.reason, /exceeds total/i);

  const zeroTotal = parseScoreCell('0/0');
  assert.equal(zeroTotal.status, 'unreadable');

  const surpriseRatio = parseScoreCell('379/384', true);
  assert.equal(surpriseRatio.status, 'ok');
  assert.equal(surpriseRatio.correct, 379);
  assert.equal(surpriseRatio.total, 384);

  const surpriseNote = parseScoreCell('Mental relay bonus', true);
  assert.equal(surpriseNote.status, 'note');
  assert.equal(surpriseNote.note, 'Mental relay bonus');
  assert.equal(surpriseNote.correct, null);
  assert.equal(surpriseNote.total, null);
});

test('SAMPLE_TWO_BLOCK_CSV parses both blocks, aliases, stray O10, ignored Round0, Time Taken, and Final Score mismatch', () => {
  const result = parseScoreSheetCsv(SAMPLE_TWO_BLOCK_CSV, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    dateFormat: 'auto',
    todayIST: '2026-10-18',
    selectedStudentName: 'TEST STUDENT',
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedDateFormat, 'DD/MM');
  assert.equal(result.dateFormatError, null);
  assert.equal(result.primaryStudentName, 'TEST STUDENT');
  assert.equal(result.studentNameMismatchWarning, null);
  assert.ok(result.levelLabels.includes('JUNIOR -1'));

  // "NEW SIMULATOR" is captured as a hint, never auto-assigned as seriesName
  assert.ok(result.labelHints.some((h) => h.text === 'NEW SIMULATOR' && h.ref === 'H1'));
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].seriesName, 'Block 1 (left)');
  assert.equal(result.blocks[1].seriesName, 'Block 2');

  // Block 1: Round0 ignored as info, 2 active rounds (Round 1, Round 2)
  const blk1 = result.blocks[0];
  assert.equal(blk1.ignoredRounds.length, 1);
  assert.equal(blk1.ignoredRounds[0].rawHeader, 'Round0');
  assert.equal(blk1.ignoredRounds[0].ref, 'C2');
  assert.equal(blk1.rounds.length, 2);
  assert.equal(blk1.rounds[0].dateISO, '2026-08-17');
  assert.equal(blk1.rounds[1].dateISO, '2026-08-21');

  // Block 1 categories: ADD (exact), SUB (exact), Currency (unmatched), Calender (alias -> Calendar), Surprise Task (exact)
  assert.equal(blk1.categories.length, 5);
  const currencyCat = blk1.categories.find((c) => c.sheetName === 'Currency');
  assert.equal(currencyCat.matchStatus, 'unmatched');
  const calenderCat = blk1.categories.find((c) => c.sheetName === 'Calender');
  assert.equal(calenderCat.matchStatus, 'alias');
  assert.equal(calenderCat.matchedCategory.name, 'Calendar');

  // Block 1 Round 1: D5="75/75", E5="75" (unreadable time), D9="......" (empty)
  const b1r1 = blk1.rounds[0];
  const cellD5 = b1r1.cells[0];
  assert.equal(cellD5.scoreRef, 'D5');
  assert.equal(cellD5.timeRef, 'E5');
  assert.equal(cellD5.correct, 75);
  assert.equal(cellD5.total, 75);
  assert.equal(cellD5.timeStatus, 'unreadable');
  assert.equal(cellD5.status, 'unreadable');

  const cellD9 = b1r1.cells[4];
  assert.equal(cellD9.scoreRef, 'D9');
  assert.equal(cellD9.status, 'empty');

  // Block 1 Round 2: Time Taken "1:08:37" -> 4117s, Surprise Task "379/384" included in sum (617 / 624)
  const b1r2 = blk1.rounds[1];
  assert.equal(b1r2.summary.roundType, 'Flat Round');
  assert.equal(b1r2.summary.timeTakenSeconds, 4117);
  assert.equal(b1r2.computed.sumCorrect, 617);
  assert.equal(b1r2.computed.sumTotal, 624);
  assert.equal(b1r2.crossChecks.finalScore.status, 'OK');
  assert.equal(b1r2.crossChecks.totalAttempt.status, 'OK');
  assert.equal(b1r2.crossChecks.marksToBeCorrected.status, 'OK');

  // Block 2: 3 rounds, "Time Elapse" alias -> "Time Elapsed", stray value at O10 ("94/231")
  const blk2 = result.blocks[1];
  assert.equal(blk2.rounds.length, 3);
  const timeElapseCat = blk2.categories.find((c) => c.sheetName === 'Time Elapse');
  assert.equal(timeElapseCat.matchStatus, 'alias');
  assert.equal(timeElapseCat.matchedCategory.name, 'Time Elapsed');

  assert.equal(blk2.strayValues.length, 1);
  assert.equal(blk2.strayValues[0].ref, 'O10');
  assert.equal(blk2.strayValues[0].rawValue, '94/231');

  // Block 2 Round 1: Final Score MISMATCH (Sheet: 250, Computed: 255, Diff: +5)
  const b2r1 = blk2.rounds[0];
  assert.equal(b2r1.crossChecks.finalScore.status, 'MISMATCH');
  assert.equal(b2r1.crossChecks.finalScore.sheetValue, 250);
  assert.equal(b2r1.crossChecks.finalScore.computedValue, 255);
  assert.equal(b2r1.crossChecks.finalScore.diff, 5);

  // Block 2 Round 2: Time Taken "Without Time" -> null seconds, withoutTime = true, Surprise Task note
  const b2r2 = blk2.rounds[1];
  assert.equal(b2r2.summary.withoutTime, true);
  assert.equal(b2r2.summary.timeTakenSeconds, null);
  const surpriseNoteCell = b2r2.cells[4];
  assert.equal(surpriseNoteCell.status, 'note');
  assert.equal(surpriseNoteCell.note, 'Mental relay bonus');

  // Block 2 Round 3: stray O10 excluded from totals (sumCorrect = 375)
  const b2r3 = blk2.rounds[2];
  assert.equal(b2r3.computed.sumCorrect, 375);
  assert.equal(b2r3.crossChecks.finalScore.status, 'OK');
});

test('Unreadable score ("95/90") marks round cross-checks as INCOMPLETE', () => {
  const csv = [
    'INDEX,Category,Round 1,',
    ',,17/08/26,',
    ',,Score,Time',
    '1,ADD,95/90,1:10',
    ',Final Score,95,',
    ',Total Attempt,90,',
    ',Marks TO BE CORRECTED,0,',
  ].join('\n');

  const res = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  assert.equal(res.ok, true);
  const rnd = res.blocks[0].rounds[0];
  assert.equal(rnd.cells[0].status, 'unreadable');
  assert.equal(rnd.crossChecks.finalScore.status, 'INCOMPLETE');
  assert.equal(rnd.crossChecks.totalAttempt.status, 'INCOMPLETE');
  assert.equal(rnd.crossChecks.marksToBeCorrected.status, 'INCOMPLETE');
});

test('Missing round headers returns a friendly layout not recognised error', () => {
  const csv = [
    'INDEX,Category,SomethingElse',
    '1,ADD,75/75',
  ].join('\n');

  const res = parseScoreSheetCsv(csv, { roundCategories: MOCK_DB_ROUND_CATEGORIES });
  assert.equal(res.ok, false);
  assert.match(res.error, /layout not recognised/i);
});

test('Out-of-order round dates and duplicate dates within a block are detected', () => {
  const csv = [
    'INDEX,Category,Round 1,,Round 2,,Round 3,',
    ',,20/08/26,,18/08/26,,18/08/26,',
    ',,Score,Time,Score,Time,Score,Time',
    '1,ADD,70/75,1:20,72/75,1:15,75/75,1:10',
  ].join('\n');

  const res = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  assert.equal(res.ok, true);
  const blk = res.blocks[0];
  // Round 2 (2026-08-18) is earlier than Round 1 (2026-08-20) -> warning
  assert.ok(blk.dateWarnings.some((w) => w.code === 'out_of_order_date'));
  // Round 2 and Round 3 share 2026-08-18 -> info
  assert.ok(blk.dateInfos.some((i) => i.code === 'duplicate_date'));
});

test('Mixed date formats (21/8/26 and 8/21/26) trigger error in Auto mode and mark impossible date unreadable when overridden', () => {
  const csv = [
    'INDEX,Category,Round 1,,Round 2,',
    ',,21/8/26,,8/21/26,',
    ',,Score,Time,Score,Time',
    '1,ADD,70/75,1:20,72/75,1:15',
  ].join('\n');

  const autoRes = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    dateFormat: 'auto',
    todayIST: '2026-10-18',
  });

  assert.equal(autoRes.ok, true);
  assert.ok(autoRes.dateFormatError);
  assert.match(autoRes.dateFormatError, /dates are mixed/i);

  // Override with DD/MM: Round 1 (21/8/26 -> 2026-08-21) is valid, Round 2 (8/21/26 -> month 21) is unreadable
  const ddmmRes = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    dateFormat: 'DD/MM',
    todayIST: '2026-10-18',
  });

  assert.equal(ddmmRes.dateFormatError, null);
  assert.equal(ddmmRes.blocks[0].rounds[0].dateISO, '2026-08-21');
  assert.equal(ddmmRes.blocks[0].rounds[1].dateStatus, 'unreadable');
});

test('Phase 4c-2c: Time Taken of 59:23:00 gives warning and null total time; 8:00:00 is accepted and 8:00:01 is not', () => {
  const csv = [
    'INDEX,Category,Round 1,,Round 2,,Round 14,',
    ',,10/08/26,,11/08/26,,12/08/26,',
    ',,Score,Time,Score,Time,Score,Time',
    '1,ADD,80/85,1:10,82/85,1:12,84/85,1:05',
    ',Time Taken,8:00:00,,8:00:01,,59:23:00,',
  ].join('\n');

  const res = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  assert.equal(res.ok, true);
  const [r1, r2, r14] = res.blocks[0].rounds;

  // 8:00:00 (28,800s) is accepted
  assert.equal(r1.summary.timeTakenSeconds, 28800);
  assert.ok(!r1.summary.timeTakenOverLimit);

  // 8:00:01 (28,801s) is over limit -> null seconds + warning
  assert.equal(r2.summary.timeTakenSeconds, null);
  assert.equal(r2.summary.timeTakenOverLimit, true);

  // 59:23:00 is over limit -> null seconds + warning and does NOT exclude the round
  assert.equal(r14.summary.timeTakenSeconds, null);
  assert.equal(r14.summary.timeTakenOverLimit, true);
  assert.equal(r14.excluded, false);

  const warn14 = res.needsAttention.find(
    (w) => w.type === 'time_taken_over_limit' && w.roundNumber === 14
  );
  assert.ok(warn14);
  assert.equal(warn14.severity, 'warning');
  assert.equal(
    warn14.message,
    `Total time 59:23:00 at ${r14.summary.timeTakenRef} is more than 8 hours: the round will be imported WITHOUT a total time`
  );
});

test('Phase 4c-2c: Cell time 4:00:00 is accepted and 4:00:01 is unreadable', () => {
  const okTime = parseTimeCell('4:00:00');
  assert.equal(okTime.status, 'ok');
  assert.equal(okTime.seconds, 14400);

  const overTime = parseTimeCell('4:00:01');
  assert.equal(overTime.status, 'unreadable');
  assert.equal(overTime.seconds, null);
  assert.match(overTime.reason, /more than 4 hours/i);
});

test('Phase 4c-2c: Round dates after today_ist() and before 2020-01-01 are excluded; round type > 40 chars and note > 500 chars are cut with warnings', () => {
  const type41 = 'A'.repeat(41);
  const note505 = 'N'.repeat(505);
  const csv = [
    'INDEX,Category,Round 1,,Round 2,,Round 3,',
    ',,31/12/2019,,19/10/2026,,15/08/2026,',
    ',,Score,Time,Score,Time,Score,Time',
    `1,ADD,70/75,1:10,72/75,1:10,75/75,1:10`,
    `2,Surprise Task,,,${note505},,${note505},`,
    `,Round Type,Category wise,,Flat Round,,${type41},`,
  ].join('\n');

  const res = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  assert.equal(res.ok, true);
  const [rBefore2020, rAfterToday, rValid] = res.blocks[0].rounds;

  assert.equal(rBefore2020.dateISO, '2019-12-31');
  assert.equal(rBefore2020.excluded, true);

  assert.equal(rAfterToday.dateISO, '2026-10-19');
  assert.equal(rAfterToday.excluded, true);

  assert.equal(rValid.dateISO, '2026-08-15');
  assert.equal(rValid.excluded, false);
  assert.equal(rValid.summary.roundType.length, 40);
  assert.equal(rValid.summary.roundTypeTruncated, true);
  assert.equal(rValid.cells[1].note.length, 500);

  assert.ok(res.needsAttention.some((w) => w.type === 'round_type_truncated'));
  assert.ok(res.needsAttention.some((w) => w.type === 'note_truncated'));
});

test('Phase 4c-2c: Strict Marks TO BE CORRECTED check flags sheet 177 vs calculated 178, and duplicate dates 25 Jul 2026 & 16 Aug 2026 emit two info lines', () => {
  const csv = [
    'INDEX,Category,Round 1,,,INDEX,Category,Round 10,,Round 11,,Round 20,,Round 21,,Round 26,',
    ',,10/08/26,,,,,25/07/26,,25/07/2026,,16/08/26,,16/08/26,,20/08/26,',
    ',,Score,Time,,,,Score,Time,Score,Time,Score,Time,Score,Time,Score,Time',
    '1,ADD,80/85,1:10,,1,ADD,80/90,1:10,82/90,1:10,85/90,1:10,84/90,1:10,822/1000,2:00',
    ',Final Score,80,,,,Final Score,80,,82,,85,,84,,823,',
    ',Total Attempt,85,,,,Total Attempt,90,,90,,90,,90,,1000,',
    ',Marks TO BE CORRECTED,5,,,,Marks TO BE CORRECTED,10,,8,,5,,6,,177,',
  ].join('\n');

  const res = parseScoreSheetCsv(csv, {
    roundCategories: MOCK_DB_ROUND_CATEGORIES,
    todayIST: '2026-10-18',
  });

  assert.equal(res.ok, true);
  const blk2 = res.blocks[1];
  const r26 = blk2.rounds.find((r) => r.roundNumber === 26);
  assert.ok(r26);
  // Sheet Final Score=823, Sheet Total Attempt=1000 (1000-823=177), Sheet Marks=177, but calculated sum(total)-sum(correct) = 1000-822 = 178
  assert.equal(r26.crossChecks.marksToBeCorrected.status, 'MISMATCH');
  assert.equal(r26.crossChecks.marksToBeCorrected.sheetValue, 177);
  assert.equal(r26.crossChecks.marksToBeCorrected.computedValue, 178);

  const dupInfos = res.needsAttention.filter(
    (item) => item.type === 'duplicate_date' && item.blockNumber === 2
  );
  assert.equal(dupInfos.length, 2);
  assert.ok(dupInfos.some((i) => i.message.includes('25 Jul 2026')));
  assert.ok(dupInfos.some((i) => i.message.includes('16 Aug 2026')));
});

