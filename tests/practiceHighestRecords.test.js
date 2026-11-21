/**
 * Trendz Tracker — Practice Highest Records Test Suite
 * (tests/practiceHighestRecords.test.js)
 *
 * Verifies strictly comparable all-time records across:
 * 1. Basics (identical category & duration; 30, 60, 120, 300s; correct DESC, wrong ASC; genuine ties)
 * 2. Elements (identical drill; correct DESC, time_seconds ASC; genuine ties)
 * 3. Flash Anzan (identical benchmark settings; verified masteries; genuine ties)
 * 4. Memoriad (identical module; correct DESC, time_seconds ASC; genuine ties)
 * 5. Student privacy & eligibility: excludes active=false, leaderboard_visible=false, unverified un-online drills
 * 6. UI helpers: "You hold it", "Attempt online", "Set the record", and info popover
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASICS_RECORD_DURATIONS,
  DEFAULT_BASICS_RECORD_DURATION,
  FLASH_SUPPORTED_DIGITS,
  FLASH_RECORD_SPEEDS,
  DEFAULT_FLASH_RECORD_SPEED_MS,
  DEFAULT_FLASH_RECORD_MODE,
  FLASH_RECORD_BENCHMARKS,
  formatRecordHolderName,
  isStudentEligibleForRecords,
  isScoreEligibleForRecords,
  computeBasicsRecords,
  computeElementsRecords,
  computeFlashRecords,
  computeMemoriadRecords,
  normalizeRecordForRenderer,
} from '../js/practiceRecords.js';
import {
  getRecordsRulesExplanation,
  renderRecordCardHtml,
} from '../js/practiceRecordsCard.js';

test('Practice Highest Records — Eligibility & Privacy Filters', () => {
  // Student eligibility
  assert.equal(isStudentEligibleForRecords(null), false);
  assert.equal(isStudentEligibleForRecords({ active: false }), false);
  assert.equal(isStudentEligibleForRecords({ active: true, leaderboard_visible: false }), false);
  assert.equal(isStudentEligibleForRecords({ active: true, leaderboard_visible: true }), true);
  assert.equal(isStudentEligibleForRecords({ active: true }), true); // default visible

  // Score eligibility (online or teacher-verified)
  assert.equal(isScoreEligibleForRecords(null), false);
  assert.equal(isScoreEligibleForRecords({ source: 'paper', verified: false }), false);
  assert.equal(isScoreEligibleForRecords({ source: 'site', verified: false }), true);
  assert.equal(isScoreEligibleForRecords({ session_id: 'sess-123', verified: false }), true);
  assert.equal(isScoreEligibleForRecords({ source: 'paper', verified: true }), true);
});

test('Practice Highest Records — Display Name Formatting', () => {
  assert.equal(formatRecordHolderName('Aarav Sharma', 'STU101', 'first_name_initial'), 'Aarav S.');
  assert.equal(formatRecordHolderName('Diya Patel', 'STU102', 'first_name_initial'), 'Diya P.');
  assert.equal(formatRecordHolderName('Kabir', 'STU103', 'first_name_initial'), 'Kabir');
  assert.equal(formatRecordHolderName('', 'STU104', 'first_name_initial'), 'STU104');
  assert.equal(formatRecordHolderName('Aarav Sharma', 'STU101', 'student_code'), 'STU101');
  assert.equal(formatRecordHolderName('Aarav Sharma', 'STU101', 'full_name'), 'Aarav Sharma');
});

test('Practice Highest Records — 1. Basics Strict Comparability & Rankings', () => {
  const categories = [
    { id: 'cat-add', name: 'Addition', section: 'basics', sort_order: 1 },
    { id: 'cat-sub', name: 'Subtraction', section: 'basics', sort_order: 2 },
  ];

  const profiles = [
    { id: 'stu-1', full_name: 'Aarav Sharma', student_code: 'STU101', active: true, leaderboard_visible: true },
    { id: 'stu-2', full_name: 'Diya Patel', student_code: 'STU102', active: true, leaderboard_visible: true },
    { id: 'stu-3', full_name: 'Kabir Verma', student_code: 'STU103', active: true, leaderboard_visible: true },
    { id: 'stu-hidden', full_name: 'Secret Student', student_code: 'STU999', active: true, leaderboard_visible: false },
    { id: 'stu-inactive', full_name: 'Old Student', student_code: 'STU888', active: false, leaderboard_visible: true },
  ];

  const results = [
    // cat-add at 60s
    { id: 'r1', student_id: 'stu-1', category_id: 'cat-add', correct: 40, total: 42, time_seconds: 60, source: 'site' },
    { id: 'r2', student_id: 'stu-2', category_id: 'cat-add', correct: 45, total: 46, time_seconds: 60, source: 'site' }, // 45 correct, 1 wrong -> highest
    { id: 'r3', student_id: 'stu-3', category_id: 'cat-add', correct: 45, total: 48, time_seconds: 60, source: 'site' }, // 45 correct, 3 wrong -> loses tie-breaker on errors
    // hidden and inactive students should be ignored
    { id: 'r4', student_id: 'stu-hidden', category_id: 'cat-add', correct: 99, total: 99, time_seconds: 60, source: 'site' },
    { id: 'r5', student_id: 'stu-inactive', category_id: 'cat-add', correct: 99, total: 99, time_seconds: 60, source: 'site' },
    // cat-add at 30s (must not mix with 60s!)
    { id: 'r6', student_id: 'stu-1', category_id: 'cat-add', correct: 25, total: 25, time_seconds: 30, source: 'site' },
  ];

  // Duration 60s: stu-2 wins with 45 correct (1 wrong)
  const records60 = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 60,
    currentStudentId: 'stu-2',
  });

  assert.equal(records60.length, 2);
  const addRecord60 = records60.find((r) => r.id === 'cat-add');
  assert.ok(addRecord60);
  assert.equal(addRecord60.hasRecord, true);
  assert.equal(addRecord60.scoreNumeric, 45);
  assert.equal(addRecord60.wrongCount, 1);
  assert.equal(addRecord60.scoreDisplay, '45 correct (1 wrong)');
  assert.equal(addRecord60.holders.length, 1);
  assert.equal(addRecord60.holders[0].student_id, 'stu-2');
  assert.equal(addRecord60.holders[0].display_name, 'Diya P.');
  assert.equal(addRecord60.isHeldByMe, true);
  assert.equal(addRecord60.attemptLabel, 'Defend record');

  // Subtraction has no records
  const subRecord60 = records60.find((r) => r.id === 'cat-sub');
  assert.ok(subRecord60);
  assert.equal(subRecord60.hasRecord, false);
  assert.equal(subRecord60.scoreDisplay, '—');
  assert.equal(subRecord60.attemptLabel, 'Set the record');

  // Duration 30s: stu-1 wins with 25 correct (0 wrong)
  const records30 = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 30,
    currentStudentId: 'stu-2',
  });
  const addRecord30 = records30.find((r) => r.id === 'cat-add');
  assert.equal(addRecord30.hasRecord, true);
  assert.equal(addRecord30.scoreNumeric, 25);
  assert.equal(addRecord30.holders[0].student_id, 'stu-1');
  assert.equal(addRecord30.isHeldByMe, false);
  assert.equal(addRecord30.attemptLabel, 'Attempt online');
});

test('Practice Highest Records — Basics Genuine Ties Display Shared Holders', () => {
  const categories = [{ id: 'cat-div', name: 'Division', section: 'basics' }];
  const profiles = [
    { id: 's1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 's2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];
  // Both students have 40 correct, 0 wrong in 60s
  const results = [
    { id: 'r1', student_id: 's1', category_id: 'cat-div', correct: 40, total: 40, time_seconds: 60, source: 'site' },
    { id: 'r2', student_id: 's2', category_id: 'cat-div', correct: 40, total: 40, time_seconds: 60, source: 'site' },
  ];

  const records = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 60,
    currentStudentId: 's1',
  });

  const divRecord = records[0];
  assert.equal(divRecord.hasRecord, true);
  assert.equal(divRecord.holders.length, 2);
  const names = divRecord.holders.map((h) => h.display_name).sort();
  assert.deepEqual(names, ['Aarav S.', 'Diya P.']);
  assert.equal(divRecord.isHeldByMe, true);
});

test('Practice Highest Records — 2. Elements Strict Comparability & Rankings', () => {
  const profiles = [
    { id: 's1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 's2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];

  const activityResults = [
    // squares_stage_1: s1 has 25 in 50s, s2 has 25 in 42s (s2 wins on faster time)
    { id: 'a1', student_id: 's1', activity_type: 'element', correct: 25, total: 25, time_seconds: 50, settings: { drill: 'squares_stage_1' }, source: 'site' },
    { id: 'a2', student_id: 's2', activity_type: 'element', correct: 25, total: 25, time_seconds: 42, settings: { drill: 'squares_stage_1' }, source: 'site' },
  ];

  const records = computeElementsRecords({
    activityResults,
    profiles,
    currentStudentId: 's2',
  });

  const sq1 = records.find((r) => r.id === 'squares_stage_1');
  assert.ok(sq1);
  assert.equal(sq1.hasRecord, true);
  assert.equal(sq1.scoreNumeric, 25);
  assert.equal(sq1.timeSeconds, 42);
  assert.equal(sq1.holders[0].student_id, 's2');
  assert.equal(sq1.isHeldByMe, true);
});

test('Practice Highest Records — 3. Flash Anzan Simplified: 1 Card Per Digit, Longest Run, Speed & Mode Separation, Ties & Dedup', () => {
  const profiles = [
    { id: 's1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 's2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
    { id: 's3', full_name: 'Kabir Verma', student_code: 'STU3', active: true, leaderboard_visible: true },
  ];

  // At 0.3s (300ms) in 1-digit Addition:
  // - s1 has a correct 150-number run
  // - s1 has ANOTHER correct 150-number run (repeat run - must be deduplicated!)
  // - s2 has a correct 100-number run (150 beats 100!)
  // - s3 has a correct 150-number run (ties with s1!)
  // - s1 also has a 200-number run at 0.2s (200ms) - belongs to its own speed filter, must NOT count for 0.3s!
  // - s1 also has an 80-number run in Add & Subtract (add_sub) - separate mode, must NOT count for Addition!
  // - s2 failed a 180-number run (correct = 0) - must NOT count!
  // - attempt with missing settings - must NOT count!
  const activityResults = [
    {
      id: 'f1a',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 'sess-1a' },
    },
    {
      id: 'f1b',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 'sess-1b' },
    },
    {
      id: 'f2',
      student_id: 's2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 100, speed_ms: 300, mode: 'add', session_id: 'sess-2' },
    },
    {
      id: 'f3',
      student_id: 's3',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 'sess-3' },
    },
    // 0.2s run (different speed)
    {
      id: 'f-fast',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 200, speed_ms: 200, mode: 'add', session_id: 'sess-fast' },
    },
    // add_sub run (different mode)
    {
      id: 'f-sub',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 80, speed_ms: 300, mode: 'add_sub', session_id: 'sess-sub' },
    },
    // Failed run (correct = 0)
    {
      id: 'f-fail',
      student_id: 's2',
      activity_type: 'flash_anzan',
      correct: 0,
      total: 1,
      settings: { digits: 1, count: 180, speed_ms: 300, mode: 'add', session_id: 'sess-fail' },
    },
    // Missing settings
    {
      id: 'f-miss',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, session_id: 'sess-miss' },
    },
    // 2-digit run at 0.3s Addition
    {
      id: 'f-2d',
      student_id: 's2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 2, count: 45, speed_ms: 300, mode: 'add', session_id: 'sess-2d' },
    },
  ];

  // Query 0.3s Addition (All Students view)
  const records = computeFlashRecords({
    activityResults,
    profiles,
    currentStudentId: 's1',
    speed_ms: 300,
    mode: 'add',
    view: 'all',
  });

  // Must return exactly 5 cards (1 to 5 digits)
  assert.equal(records.length, 5);
  assert.deepEqual(records.map((r) => r.digits), [1, 2, 3, 4, 5]);

  // 1 Digit card: 150 beats 100, s1 and s3 tie, s1 deduplicated to appear once
  const card1d = records.find((r) => r.digits === 1);
  assert.ok(card1d);
  assert.equal(card1d.hasRecord, true);
  assert.equal(card1d.count, 150);
  assert.equal(card1d.scoreDisplay, '150 numbers');
  assert.equal(card1d.holders.length, 2); // s1 and s3 tie
  const hNames = card1d.holders.map((h) => h.display_name).sort();
  assert.deepEqual(hNames, ['Aarav S.', 'Kabir V.']);
  const s1Holders = card1d.holders.filter((h) => h.student_id === 's1');
  assert.equal(s1Holders.length, 1, 'Student s1 must be deduplicated despite multiple 150-number runs');
  assert.equal(card1d.isHeldByMe, true);
  assert.equal(card1d.attemptLabel, 'Defend record');

  // 2 Digits card: s2 holds it with 45 numbers
  const card2d = records.find((r) => r.digits === 2);
  assert.ok(card2d);
  assert.equal(card2d.hasRecord, true);
  assert.equal(card2d.count, 45);
  assert.equal(card2d.scoreDisplay, '45 numbers');
  assert.equal(card2d.holders[0].student_id, 's2');
  assert.equal(card2d.isHeldByMe, false);
  assert.equal(card2d.attemptLabel, 'Attempt online');

  // 3 Digits card: No record yet
  const card3d = records.find((r) => r.digits === 3);
  assert.ok(card3d);
  assert.equal(card3d.hasRecord, false);
  assert.equal(card3d.scoreDisplay, 'No record yet');
  assert.equal(card3d.holders.length, 0);

  // Separate speed test: Query at 0.2s (200ms)
  const records02s = computeFlashRecords({
    activityResults,
    profiles,
    currentStudentId: 's1',
    speed_ms: 200,
    mode: 'add',
    view: 'all',
  });
  const card1d_02s = records02s.find((r) => r.digits === 1);
  assert.equal(card1d_02s.count, 200, '0.2s run belongs to its own speed filter');
  assert.equal(card1d_02s.holders[0].student_id, 's1');

  // Separate mode test: Query Add & Subtract at 0.3s
  const recordsAddSub = computeFlashRecords({
    activityResults,
    profiles,
    currentStudentId: 's1',
    speed_ms: 300,
    mode: 'add_sub',
    view: 'all',
  });
  const card1d_addSub = recordsAddSub.find((r) => r.digits === 1);
  assert.equal(card1d_addSub.count, 80, 'Add & Subtract kept separate from Addition');
  assert.equal(card1d_addSub.holders[0].student_id, 's1');
});

test('Practice Highest Records — 4. Memoriad Strict Comparability & Rankings', () => {
  const profiles = [
    { id: 's1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 's2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];

  const activityResults = [
    // calendar dates: s1 scored 45 in 280s, s2 scored 52 in 290s (s2 wins on higher score)
    { id: 'm1', student_id: 's1', activity_type: 'memoriad', correct: 45, total: 50, time_seconds: 280, settings: { module: 'calendar' }, source: 'site' },
    { id: 'm2', student_id: 's2', activity_type: 'memoriad', correct: 52, total: 60, time_seconds: 290, settings: { module: 'calendar' }, source: 'site' },
  ];

  const records = computeMemoriadRecords({
    activityResults,
    profiles,
    currentStudentId: 's2',
  });

  const calRecord = records.find((r) => r.id === 'calendar');
  assert.ok(calRecord);
  assert.equal(calRecord.hasRecord, true);
  assert.equal(calRecord.scoreNumeric, 52);
  assert.equal(calRecord.holders[0].student_id, 's2');
  assert.equal(calRecord.isHeldByMe, true);
  assert.equal(calRecord.scoreDisplay, '52 dates in 290s');
});

test('Practice Highest Records — Rules Explanation & Card HTML Rendering', () => {
  for (const sec of ['basics', 'flash', 'element', 'memoriad']) {
    const text = getRecordsRulesExplanation(sec);
    assert.ok(text.includes('Only completed online drills or teacher-verified'));
    assert.ok(text.includes('Genuine ties share the record'));
  }

  // Card with record
  const cardHtmlActive = renderRecordCardHtml({
    id: 'test-1',
    title: 'Addition Drill',
    settingsSummary: '60 seconds',
    hasRecord: true,
    scoreDisplay: '42 correct (0 wrong)',
    holders: [{ student_id: 'u1', display_name: 'Aarav S.', is_me: true }],
    isHeldByMe: true,
    attemptUrl: '/pages/basics-practice.html?cat=c1',
    attemptLabel: 'Defend record',
  });
  assert.ok(cardHtmlActive.includes('Addition Drill'));
  assert.ok(cardHtmlActive.includes('42 correct (0 wrong)'));
  assert.ok(cardHtmlActive.includes('You hold this record!'));
  assert.ok(cardHtmlActive.includes('Aarav S.'));

  // Card without record
  const cardHtmlEmpty = renderRecordCardHtml({
    id: 'test-2',
    title: 'Cube Stage 4',
    settingsSummary: '25 Qs · 150s',
    hasRecord: false,
    scoreDisplay: '—',
    holders: [],
    isHeldByMe: false,
    attemptUrl: '/pages/element-drill.html?drill=cubes_stage_4',
    attemptLabel: 'Set the record',
  });
  assert.ok(cardHtmlEmpty.includes('Cube Stage 4'));
  assert.ok(cardHtmlEmpty.includes('No record yet'));
  assert.ok(cardHtmlEmpty.includes('Set the record'));
});

test('Practice Highest Records — 5. All 4 My Best Views (Basics, Flash, Elements, Memoriad)', () => {
  const profiles = [
    { id: 'stu-a', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 'stu-b', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];

  // 1. Basics My Best
  const categories = [
    { id: 'cat-1', name: 'Addition', section: 'basics' },
    { id: 'cat-2', name: 'Subtraction', section: 'basics' },
  ];
  const results = [
    { id: 'r1', student_id: 'stu-a', category_id: 'cat-1', correct: 35, total: 37, time_seconds: 60, source: 'site' },
    { id: 'r2', student_id: 'stu-b', category_id: 'cat-1', correct: 48, total: 48, time_seconds: 60, source: 'site' },
  ];

  const basicsMyBestA = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 60,
    currentStudentId: 'stu-a',
    view: 'my_best',
  });
  const myAdd = basicsMyBestA.find((r) => r.id === 'cat-1');
  assert.equal(myAdd.hasRecord, true);
  assert.equal(myAdd.scoreNumeric, 35, 'Shows stu-a personal best (35), not stu-b overall best (48)');
  assert.equal(myAdd.scoreDisplay, '35 correct (2 wrong)');
  assert.equal(myAdd.isHeldByMe, true);
  assert.equal(myAdd.attemptLabel, 'Defend record');

  const mySub = basicsMyBestA.find((r) => r.id === 'cat-2');
  assert.equal(mySub.hasRecord, false);
  assert.equal(mySub.scoreDisplay, 'No personal record yet');
  assert.equal(mySub.holders.length, 0);

  // 2. Flash Anzan My Best
  const flashResults = [
    {
      id: 'f1',
      student_id: 'stu-a',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 110, speed_ms: 300, mode: 'add', session_id: 's-f1' },
    },
    {
      id: 'f2',
      student_id: 'stu-b',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 180, speed_ms: 300, mode: 'add', session_id: 's-f2' },
    },
  ];
  const flashMyBestA = computeFlashRecords({
    activityResults: flashResults,
    profiles,
    currentStudentId: 'stu-a',
    speed_ms: 300,
    mode: 'add',
    view: 'my_best',
  });
  const flashCard1 = flashMyBestA.find((r) => r.digits === 1);
  assert.equal(flashCard1.hasRecord, true);
  assert.equal(flashCard1.count, 110, 'Shows stu-a personal best count (110)');
  assert.equal(flashCard1.scoreDisplay, '110 numbers');
  assert.equal(flashCard1.isHeldByMe, true);

  const flashCard2 = flashMyBestA.find((r) => r.digits === 2);
  assert.equal(flashCard2.hasRecord, false);
  assert.equal(flashCard2.scoreDisplay, 'No personal record yet');

  // 3. Elements My Best
  const elementResults = [
    { id: 'e1', student_id: 'stu-a', activity_type: 'element', correct: 20, total: 25, time_seconds: 40, settings: { drill: 'squares_stage_1' }, source: 'site' },
    { id: 'e2', student_id: 'stu-b', activity_type: 'element', correct: 25, total: 25, time_seconds: 35, settings: { drill: 'squares_stage_1' }, source: 'site' },
  ];
  const elemMyBestA = computeElementsRecords({
    activityResults: elementResults,
    profiles,
    currentStudentId: 'stu-a',
    view: 'my_best',
  });
  const sqDrill = elemMyBestA.find((r) => r.id === 'squares_stage_1');
  assert.equal(sqDrill.hasRecord, true);
  assert.equal(sqDrill.scoreNumeric, 20, 'Shows stu-a personal best (20)');
  assert.equal(sqDrill.isHeldByMe, true);

  const cubeDrill = elemMyBestA.find((r) => r.id === 'cubes_stage_1');
  assert.equal(cubeDrill.hasRecord, false);
  assert.equal(cubeDrill.scoreDisplay, 'No personal record yet');

  // 4. Memoriad My Best
  const memoResults = [
    { id: 'm1', student_id: 'stu-a', activity_type: 'memoriad', correct: 30, total: 40, time_seconds: 250, settings: { module: 'calendar', score: 30, used_seconds: 250 }, source: 'site' },
    { id: 'm2', student_id: 'stu-b', activity_type: 'memoriad', correct: 60, total: 70, time_seconds: 290, settings: { module: 'calendar', score: 60, used_seconds: 290 }, source: 'site' },
  ];
  const memoMyBestA = computeMemoriadRecords({
    activityResults: memoResults,
    profiles,
    currentStudentId: 'stu-a',
    view: 'my_best',
  });
  const calMod = memoMyBestA.find((r) => r.id === 'calendar');
  assert.equal(calMod.hasRecord, true);
  assert.equal(calMod.scoreNumeric, 30, 'Shows stu-a personal best (30)');
  assert.equal(calMod.isHeldByMe, true);
});

test('Practice Highest Records — 6. Hidden Student (leaderboard_visible = false) Sees Own Best in My Best', () => {
  const profiles = [
    { id: 'stu-public', full_name: 'Public Student', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 'stu-hidden', full_name: 'Secret Student', student_code: 'STU9', active: true, leaderboard_visible: false },
  ];

  const categories = [{ id: 'cat-add', name: 'Addition', section: 'basics' }];
  const results = [
    { id: 'r-pub', student_id: 'stu-public', category_id: 'cat-add', correct: 40, total: 40, time_seconds: 60, source: 'site' },
    { id: 'r-hid', student_id: 'stu-hidden', category_id: 'cat-add', correct: 50, total: 50, time_seconds: 60, source: 'site' },
  ];

  // In All Students: stu-hidden must NOT appear
  const allRecords = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 60,
    currentStudentId: 'stu-hidden',
    view: 'all',
  });
  assert.equal(allRecords[0].scoreNumeric, 40, 'Public view ignores hidden student even with higher score');
  assert.equal(allRecords[0].holders[0].student_id, 'stu-public');
  assert.equal(allRecords[0].isHeldByMe, false);

  // In My Best: stu-hidden sees their OWN personal best!
  const myRecords = computeBasicsRecords({
    categories,
    results,
    profiles,
    durationSeconds: 60,
    currentStudentId: 'stu-hidden',
    view: 'my_best',
  });
  assert.equal(myRecords[0].hasRecord, true);
  assert.equal(myRecords[0].scoreNumeric, 50, 'Hidden student sees their own personal best (50)');
  assert.equal(myRecords[0].isHeldByMe, true);
  assert.equal(myRecords[0].holders[0].student_id, 'stu-hidden');
});

test('Practice Highest Records — 7. HTML Rendering for My Best States & Normalization', () => {
  // My Best card with personal record
  const cardWithBest = renderRecordCardHtml({
    id: 'flash_1d',
    title: '1 Digit',
    settingsSummary: '1d · 0.3s · Add',
    hasRecord: true,
    scoreDisplay: '150 numbers',
    view: 'my_best',
    holders: [{ student_id: 's1', display_name: 'Aarav S.', is_me: true }],
    isHeldByMe: true,
    attemptUrl: '/pages/flash.html?digits=1&count=150&speed=300&mode=add',
    attemptLabel: 'Defend record',
  });
  assert.ok(cardWithBest.includes('Your Personal Best'));
  assert.ok(cardWithBest.includes('Personal Best'));
  assert.ok(cardWithBest.includes('150 numbers'));
  assert.ok(cardWithBest.includes('Personal Record:'));

  // My Best card without record ("No personal record yet")
  const cardEmptyBest = renderRecordCardHtml({
    id: 'flash_3d',
    title: '3 Digits',
    settingsSummary: '3d · 0.3s · Add',
    hasRecord: false,
    scoreDisplay: 'No personal record yet',
    view: 'my_best',
    holders: [],
    isHeldByMe: false,
    attemptUrl: '/pages/flash.html?digits=3&count=10&speed=300&mode=add',
    attemptLabel: 'Attempt online',
  });
  assert.ok(cardEmptyBest.includes('No personal record yet'));
  assert.ok(!cardEmptyBest.includes('No holder yet — be the first!'));

  // normalizeRecordForRenderer preserves empty states
  const normEmpty = normalizeRecordForRenderer({ id: 'flash_4d', digits: 4, hasRecord: false }, 'flash', 's1', { view: 'my_best' });
  assert.equal(normEmpty.scoreDisplay, 'No personal record yet');
  assert.equal(normEmpty.title, '4 Digits');

  const normAllEmpty = normalizeRecordForRenderer({ id: 'flash_4d', digits: 4, hasRecord: false }, 'flash', 's1', { view: 'all' });
  assert.equal(normAllEmpty.scoreDisplay, 'No record yet');
});

test('Practice Highest Records — 8. Authoritative Flash Validation: Missing Mode Rejected, Malformed Settings Skipped, Incorrect Runs Excluded, Dual-Contract Support', () => {
  const profiles = [
    { id: 'stu1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 'stu2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];

  const activityResults = [
    // 1. Missing mode: must NOT default to Addition!
    {
      id: 'f-no-mode',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 250, speed_ms: 300, session_id: 's-no-mode' }, // missing mode
    },
    // 2. Malformed settings: non-numeric digits, count, negative speed - skipped cleanly
    {
      id: 'f-malformed-1',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 'abc', count: 'ten', speed_ms: 'fast', mode: 'add', session_id: 's-mal1' },
    },
    {
      id: 'f-malformed-2',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 6, count: 50, speed_ms: -300, mode: 'add', session_id: 's-mal2' },
    },
    // 3. Incorrect runs: correct = 0 or correct < total - excluded!
    {
      id: 'f-incorrect-1',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 0,
      total: 1,
      settings: { digits: 1, count: 300, speed_ms: 300, mode: 'add', session_id: 's-inc1' },
    },
    {
      id: 'f-incorrect-2',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 2,
      settings: { digits: 1, count: 300, speed_ms: 300, mode: 'add', session_id: 's-inc2' },
    },
    // 4. Legitimate runs: 150-number run beats 100-number run at 0.3s Addition
    {
      id: 'f-legit-100',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 100, speed_ms: 300, mode: 'add', session_id: 's-legit-100' },
    },
    {
      id: 'f-legit-150',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 's-legit-150' },
    },
  ];

  // Query 0.3s Addition (All view)
  const records = computeFlashRecords({
    activityResults,
    profiles,
    currentStudentId: 'stu1',
    speed_ms: 300,
    mode: 'add',
    view: 'all',
  });

  const card1 = records.find((r) => r.digits === 1);
  assert.ok(card1);
  assert.equal(card1.hasRecord, true);
  // Missing-mode run (250 count) and incorrect runs (300 count) were excluded.
  // stu1's 150-number run won over stu2's 100-number run!
  assert.equal(card1.count, 150, '150-number run beats 100-number run; missing-mode 250 run and incorrect 300 run excluded');
  assert.equal(card1.holders.length, 1);
  assert.equal(card1.holders[0].student_id, 'stu1');

  // Dual-Contract Normalization:
  // 1. Legacy benchmark format preserved for existing callers
  const legacyNorm = normalizeRecordForRenderer(
    {
      id: 'flash_1d_10n_add',
      title: '1 Digit · 10 Numbers · Add',
      digits: 1,
      count: 10,
      mode: 'add',
      speed_ms: 350,
      has_record: true,
      holders: [{ student_id: 'stu1', display_name: 'Aarav S.' }],
    },
    'flash',
    'stu1',
    {}
  );
  assert.equal(legacyNorm.title, '1 Digit · 10 Numbers · Add');
  assert.equal(legacyNorm.scoreDisplay, '0.35s per number (350ms)');

  // 2. New per_digit format explicitly requested
  const perDigitNorm = normalizeRecordForRenderer(
    {
      id: 'flash_1d',
      digits: 1,
      count: 150,
      mode: 'add',
      speed_ms: 300,
      has_record: true,
      holders: [{ student_id: 'stu1', display_name: 'Aarav S.' }],
    },
    'flash',
    'stu1',
    { format: 'per_digit', speed_ms: 300, mode: 'add' }
  );
  assert.equal(perDigitNorm.title, '1 Digit');
  assert.equal(perDigitNorm.scoreDisplay, '150 numbers');
  assert.equal(perDigitNorm.settingsSummary, '1d · 0.3s · Add');
});

test('Practice Highest Records — 9. Regression: Session Settings Authority, Missing Canonical Link, Numeric Overflow, and 150 vs 100 Run', () => {
  const profiles = [
    { id: 'stu1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 'stu2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
  ];

  // Activity results
  const activityResults = [
    // 1. Settings Disagree: Score claims 500 numbers, but session was recorded as 50 numbers
    {
      id: 'f-disagree',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 500, speed_ms: 300, mode: 'add', session_id: 'd-disagree' },
    },
    // 2. Score lacks canonical session link: session_id in score JSON but session result_id does not point to score
    {
      id: 'f-unlinked',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 200, speed_ms: 300, mode: 'add', session_id: 'd-orphan' },
    },
    // 3. Numeric setting exceeds PostgreSQL integer range (oversized string)
    {
      id: 'f-overflow',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 'd-overflow' },
    },
    // 4. Invalid speed increment (250ms is not in supported 100ms steps)
    {
      id: 'f-odd-speed',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 300, speed_ms: 250, mode: 'add', session_id: 'd-odd-speed' },
    },
    // 5. Valid 100-number run for stu2
    {
      id: 'f-valid-100',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 100, speed_ms: 300, mode: 'add', session_id: 'd-valid-100' },
    },
    // 6. Valid 150-number run for stu1
    {
      id: 'f-valid-150',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add', session_id: 'd-valid-150' },
    },
  ];

  // Drill sessions with canonical links and saved settings
  const drillSessions = [
    // Session for f-disagree has count: 50 (authoritative saved settings)
    {
      id: 'd-disagree',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: 'f-disagree',
      settings: { digits: 1, count: 50, speed_ms: 300, mode: 'add' },
    },
    // Orphan session: result_id is NULL (not canonically linked to f-unlinked)
    {
      id: 'd-orphan',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: null,
      result_row_id: null,
      settings: { digits: 1, count: 200, speed_ms: 300, mode: 'add' },
    },
    // Overflow session: 40-digit count and speed strings
    {
      id: 'd-overflow',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: 'f-overflow',
      settings: {
        digits: 1,
        count: '9999999999999999999999999999999999999999',
        speed_ms: '9999999999999999999999999999999999999999',
        mode: 'add',
      },
    },
    // Odd speed session: 250ms (not a supported 100ms increment)
    {
      id: 'd-odd-speed',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: 'f-odd-speed',
      settings: { digits: 1, count: 300, speed_ms: 250, mode: 'add' },
    },
    // Canonical session for valid 100
    {
      id: 'd-valid-100',
      student_id: 'stu2',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: 'f-valid-100',
      settings: { digits: 1, count: 100, speed_ms: 300, mode: 'add' },
    },
    // Canonical session for valid 150
    {
      id: 'd-valid-150',
      student_id: 'stu1',
      activity_type: 'flash_anzan',
      status: 'submitted',
      result_id: 'f-valid-150',
      settings: { digits: 1, count: 150, speed_ms: 300, mode: 'add' },
    },
  ];

  // Execute ranking with drillSessions
  const records = computeFlashRecords({
    activityResults,
    profiles,
    drillSessions,
    currentStudentId: 'stu1',
    speed_ms: 300,
    mode: 'add',
    view: 'all',
  });

  const card1 = records.find((r) => r.digits === 1);
  assert.ok(card1);
  assert.equal(card1.hasRecord, true);
  // Authoritative ranking:
  // - f-valid-150 (count: 150) beats f-valid-100 (count: 100)
  // - f-disagree is evaluated as 50 numbers (from session settings), so 150 beats it
  // - f-unlinked is excluded because session result_id was null
  // - f-overflow is safely skipped without throwing error
  // - f-odd-speed is skipped because 250ms is not a 100ms increment
  assert.equal(card1.count, 150, 'Valid 150-number run beats valid 100-number run');
  assert.equal(card1.scoreDisplay, '150 numbers');
  assert.equal(card1.holders.length, 1);
  assert.equal(card1.holders[0].student_id, 'stu1');
  assert.equal(card1.isHeldByMe, true);
});
