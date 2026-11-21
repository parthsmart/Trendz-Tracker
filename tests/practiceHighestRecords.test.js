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
  FLASH_RECORD_BENCHMARKS,
  formatRecordHolderName,
  isStudentEligibleForRecords,
  isScoreEligibleForRecords,
  computeBasicsRecords,
  computeElementsRecords,
  computeFlashRecords,
  computeMemoriadRecords,
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

test('Practice Highest Records — 3. Flash Anzan Individual Fastest Speed Performance & Ties', () => {
  const profiles = [
    { id: 's1', full_name: 'Aarav Sharma', student_code: 'STU1', active: true, leaderboard_visible: true },
    { id: 's2', full_name: 'Diya Patel', student_code: 'STU2', active: true, leaderboard_visible: true },
    { id: 's3', full_name: 'Kabir Verma', student_code: 'STU3', active: true, leaderboard_visible: true },
  ];

  const benchmark = FLASH_RECORD_BENCHMARKS[0]; // 1d 10n add

  // Flash rows: s1 cleared at 1000ms; s2 and s3 cleared at 800ms (s2 and s3 tie for fastest speed)
  const activityResults = [
    {
      id: 'f1',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: benchmark.digits, count: benchmark.count, speed_ms: 1000, mode: benchmark.mode, session_id: 'sess-1' },
    },
    {
      id: 'f2',
      student_id: 's2',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: benchmark.digits, count: benchmark.count, speed_ms: 800, mode: benchmark.mode, session_id: 'sess-2' },
    },
    {
      id: 'f3',
      student_id: 's3',
      activity_type: 'flash_anzan',
      correct: 1,
      total: 1,
      settings: { digits: benchmark.digits, count: benchmark.count, speed_ms: 800, mode: benchmark.mode, session_id: 'sess-3' },
    },
    // Failed attempt (correct = 0) at 500ms does NOT count
    {
      id: 'f4',
      student_id: 's1',
      activity_type: 'flash_anzan',
      correct: 0,
      total: 1,
      settings: { digits: benchmark.digits, count: benchmark.count, speed_ms: 500, mode: benchmark.mode, session_id: 'sess-4' },
    },
  ];

  const records = computeFlashRecords({
    activityResults,
    profiles,
    currentStudentId: 's2',
  });

  const bm1 = records.find((r) => r.id === benchmark.key);
  assert.ok(bm1);
  assert.equal(bm1.hasRecord, true);
  assert.equal(bm1.scoreNumeric, 800); // 800ms is fastest
  assert.equal(bm1.holders.length, 2); // s2 and s3 share record
  const names = bm1.holders.map((h) => h.display_name).sort();
  assert.deepEqual(names, ['Diya P.', 'Kabir V.']);
  assert.equal(bm1.isHeldByMe, true);
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
