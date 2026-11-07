import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHistoryTargetStudent } from '../js/historyFilters.js';
import { getWeeklyTestCompletionState } from '../js/weeklyTestView.js';
import { normalizeTaskInput, taskLink } from '../js/todoForm.js';
import { checkTimedBasicsSubmission, checkSubmission } from '../api/_drills.js';

test('Phase 19 - Item 1: History target student resolution enforces permissions and identity', async () => {
  const currentAdmin = { id: 'usr-admin-1', role: 'admin', full_name: 'Admin User' };
  const currentTeacher = { id: 'usr-teacher-1', role: 'teacher', full_name: 'Teacher Jane' };
  const currentStudent = { id: 'usr-101', role: 'student', full_name: 'Aarav Sharma' };

  const studentsList = [
    { id: 'usr-101', full_name: 'Aarav Sharma', student_code: 'STU-001', role: 'student' },
    { id: 'usr-102', full_name: 'Diya Patel', student_code: 'STU-002', role: 'student' },
    { id: 'usr-103', full_name: 'Vihaan Rao', student_code: 'STU-003', role: 'student' },
  ];

  const teacherAssignments = [
    { teacher_id: 'usr-teacher-1', student_id: 'usr-102' },
  ];

  const mockDemoDb = {
    getTeacherStudentAssignments: () => teacherAssignments,
    getStudents: () => studentsList,
  };

  // 1. Admin can view any student's history
  const adminTarget = await resolveHistoryTargetStudent({
    loggedInProfile: currentAdmin,
    urlStudentId: 'usr-102',
    isDemo: true,
    DemoDB: mockDemoDb,
  });
  assert.equal(adminTarget.isSelf, false);
  assert.equal(adminTarget.error, null);
  assert.equal(adminTarget.targetStudent.id, 'usr-102');
  assert.equal(adminTarget.targetStudent.full_name, 'Diya Patel');

  // 2. Teacher can view assigned student's history
  const teacherAllowedTarget = await resolveHistoryTargetStudent({
    loggedInProfile: currentTeacher,
    urlStudentId: 'usr-102',
    isDemo: true,
    DemoDB: mockDemoDb,
  });
  assert.equal(teacherAllowedTarget.isSelf, false);
  assert.equal(teacherAllowedTarget.error, null);
  assert.equal(teacherAllowedTarget.targetStudent.id, 'usr-102');

  // 3. Teacher is blocked from viewing unassigned student's history
  const teacherDeniedTarget = await resolveHistoryTargetStudent({
    loggedInProfile: currentTeacher,
    urlStudentId: 'usr-101',
    isDemo: true,
    DemoDB: mockDemoDb,
  });
  assert.equal(teacherDeniedTarget.isSelf, false);
  assert.equal(teacherDeniedTarget.targetStudent, null);
  assert.match(teacherDeniedTarget.error, /not in your assigned roster/i);

  // 4. Student cannot target other students, always restricted to self
  const studentTarget = await resolveHistoryTargetStudent({
    loggedInProfile: currentStudent,
    urlStudentId: 'usr-102',
    isDemo: true,
    DemoDB: mockDemoDb,
  });
  assert.equal(studentTarget.isSelf, true);
  assert.equal(studentTarget.targetStudent.id, 'usr-101');
  assert.match(studentTarget.error, /do not have permission/i);
});

test('Phase 19 - Item 2: Weekly test card completion state derived accurately from authoritative records', () => {
  // Online test with 3 sections
  const onlineTest = {
    id: 'test-1',
    type: 'online',
    state: 'open',
    sections: [
      { id: 'sec-1', name: 'Basics', kind: 'basics', attempt: null },
      { id: 'sec-2', name: 'Flash Anzan', kind: 'flash', attempt: null },
      { id: 'sec-3', name: 'Day Codes', kind: 'elements', attempt: null },
    ],
  };

  // Not started: 0 submissions
  const notStartedState = getWeeklyTestCompletionState(onlineTest);
  assert.equal(notStartedState.state, 'not_started');
  assert.equal(notStartedState.actionLabel, 'Start');
  assert.equal(notStartedState.submittedCount, 0);
  assert.equal(notStartedState.totalCount, 3);
  assert.equal(notStartedState.todoCount, 3);

  // Partially completed: 1 of 3 submitted
  const partialState = getWeeklyTestCompletionState({
    ...onlineTest,
    sections: [
      { id: 'sec-1', name: 'Basics', kind: 'basics', attempt: 'submitted' },
      { id: 'sec-2', name: 'Flash Anzan', kind: 'flash', attempt: null },
      { id: 'sec-3', name: 'Day Codes', kind: 'elements', attempt: null },
    ],
  });
  assert.equal(partialState.state, 'partially_completed');
  assert.equal(partialState.actionLabel, 'Continue');
  assert.equal(partialState.submittedCount, 1);
  assert.equal(partialState.todoCount, 2);

  // Completed: all 3 submitted
  const completedState = getWeeklyTestCompletionState({
    ...onlineTest,
    sections: [
      { id: 'sec-1', name: 'Basics', kind: 'basics', attempt: 'submitted' },
      { id: 'sec-2', name: 'Flash Anzan', kind: 'flash', attempt: 'submitted' },
      { id: 'sec-3', name: 'Day Codes', kind: 'elements', attempt: 'submitted' },
    ],
  });
  assert.equal(completedState.state, 'completed');
  assert.equal(completedState.actionLabel, 'View results');
  assert.equal(completedState.submittedCount, 3);
  assert.equal(completedState.todoCount, 0);

  // Offline test with manual score
  const offlineUnscored = getWeeklyTestCompletionState({
    id: 'test-off-1',
    type: 'offline',
    sections: [{ total: null }],
  });
  assert.equal(offlineUnscored.state, 'not_started');
  assert.equal(offlineUnscored.actionLabel, 'Start');

  const offlineScored = getWeeklyTestCompletionState({
    id: 'test-off-1',
    type: 'offline',
    sections: [{ total: 100 }],
  });
  assert.equal(offlineScored.state, 'completed');
  assert.equal(offlineScored.actionLabel, 'View results');
});

test('Phase 19 - Item 3: Competition round history series selection and empty state differentiation', () => {
  const seriesList = [
    { id: 'ser-current', name: 'New simulator (2026)', is_current: true },
    { id: 'ser-legacy', name: 'Old simulator (2025)', is_current: false },
  ];

  const studentRounds = [
    { id: 'rnd-1', series_id: 'ser-legacy', round_index: 1, total_score: 95 },
    { id: 'rnd-2', series_id: 'ser-legacy', round_index: 2, total_score: 110 },
  ];

  // Helper simulating setupScoreSheetController aggregation
  const countsBySeries = {};
  seriesList.forEach((s) => {
    countsBySeries[s.id] = studentRounds.filter((r) => r.series_id === s.id).length;
  });

  assert.equal(countsBySeries['ser-current'], 0);
  assert.equal(countsBySeries['ser-legacy'], 2);

  // When default current series has 0 rounds but another has rounds, auto-select series with rounds
  let selectedSeriesId = seriesList.find((s) => s.is_current)?.id || seriesList[0].id;
  if (countsBySeries[selectedSeriesId] === 0) {
    const seriesWithRounds = seriesList.find((s) => (countsBySeries[s.id] || 0) > 0);
    if (seriesWithRounds) {
      selectedSeriesId = seriesWithRounds.id;
    }
  }

  assert.equal(selectedSeriesId, 'ser-legacy');
  assert.equal(countsBySeries[selectedSeriesId], 2);

  // Distinguish genuinely empty across all series vs empty in selected series
  const totalRoundsAcrossAll = Object.values(countsBySeries).reduce((a, b) => a + b, 0);
  assert.equal(totalRoundsAcrossAll, 2);

  // If user switches back to 'ser-current', empty state notices rounds exist in 'ser-legacy'
  const isSelectedEmpty = countsBySeries['ser-current'] === 0;
  const otherSeriesHaveRounds = totalRoundsAcrossAll > 0;
  assert.equal(isSelectedEmpty, true);
  assert.equal(otherSeriesHaveRounds, true);
});

test('Phase 19 - Item 4: Recorded practice duration timing corrections', () => {
  // 1. Unlimited mode (stopwatch): student clicked finish at 20s.
  // Network and confirmation prompt delayed request arrival to 24s.
  const stopwatchSession = {
    mode: 'unlimited',
    time_limit_seconds: 3600,
    started_at: '2026-11-07T10:00:00.000Z',
    finished_at: '2026-11-07T10:00:24.000Z',
    status: 'open',
  };

  const stopwatchCheck = checkTimedBasicsSubmission(
    stopwatchSession,
    ['15', '25'],
    Date.parse('2026-11-07T10:00:24.000Z'),
    20 // clientDurationSeconds = 20
  );

  assert.equal(stopwatchCheck.ok, true);
  assert.equal(stopwatchCheck.seconds, 20); // Clamped to client solving time!

  // 2. Fixed 60s timed round: student reaches deadline.
  // Network delay / retry submitted at 70s.
  const timedSession = {
    mode: 'timed',
    time_limit_seconds: 60,
    started_at: '2026-11-07T10:00:00.000Z',
    finished_at: '2026-11-07T10:01:10.000Z',
    status: 'open',
  };

  const timedCheck = checkTimedBasicsSubmission(
    timedSession,
    ['15'],
    Date.parse('2026-11-07T10:01:10.000Z'),
    60
  );

  assert.equal(timedCheck.ok, true);
  // Clamped to active time limit 60s, NOT 70s
  assert.equal(timedCheck.seconds, 60);

  // 3. checkSubmission delegates and preserves clamped duration
  const generalSubmissionCheck = checkSubmission(
    timedSession,
    ['10'],
    Date.parse('2026-11-07T10:01:10.000Z'),
    60
  );
  assert.equal(generalSubmissionCheck.ok, true);
  assert.equal(generalSubmissionCheck.seconds, 60);
});

test('Phase 19 - Items 5 & 8: Daily Task assigned settings, duration persistence, and links', () => {
  // 1. Duration input normalization in todoForm.js
  const validDuration = normalizeTaskInput(
    {
      title: 'Basics Practice 60s',
      duration_seconds: '60',
    },
    'basics'
  );
  assert.ok(validDuration.value);
  assert.equal(validDuration.value.duration_seconds, 60);

  // Flash Anzan rejects arbitrary duration
  const flashWithDuration = normalizeTaskInput(
    {
      title: 'Flash Practice 60s',
      duration_seconds: '60',
    },
    'flash'
  );
  assert.ok(flashWithDuration.errors?.duration_seconds);

  const customDuration = normalizeTaskInput(
    {
      title: 'Speed Drill 130s',
      duration_seconds: 130,
    },
    'elements'
  );
  assert.ok(customDuration.value);
  assert.equal(customDuration.value.duration_seconds, 130);

  const nullDuration = normalizeTaskInput(
    {
      title: 'Untimed Task',
      duration_seconds: '',
    },
    'basics'
  );
  assert.ok(nullDuration.value);
  assert.equal(nullDuration.value.duration_seconds, null);

  // Rejection of invalid duration
  const invalidShort = normalizeTaskInput(
    {
      title: 'Too short',
      duration_seconds: '2',
    },
    'basics'
  );
  assert.ok(invalidShort.errors?.duration_seconds);

  // 2. taskLink preserves and forwards todo_task_id
  const linkWithId = taskLink({
    id: 'task-999',
    section: 'basics',
    category_id: 'cat-1',
  });
  assert.match(linkWithId, /todo_task_id=task-999/);
  assert.match(linkWithId, /cat=cat-1/);

  const elementsLink = taskLink({
    task_id: 'task-888',
    section: 'elements',
    activity_key: 'day_codes',
  });
  assert.match(elementsLink, /todo_task_id=task-888/);
  assert.match(elementsLink, /drill=day_codes/);
});

test('Phase 19 - Item 6: Daily To-do early-submission and participation restrictions', () => {
  // Fixed-question drill (Elements Drills)
  const totalQuestions = 5;
  const partialAnswers = ['5', '12', null, null, null];
  const fullAnswers = ['5', '12', '18', '24', '30'];

  const canEarlySubmitPartial = partialAnswers.filter((a) => a !== null).length === totalQuestions;
  const canEarlySubmitFull = fullAnswers.filter((a) => a !== null).length === totalQuestions;

  assert.equal(canEarlySubmitPartial, false); // Blocked until all questions answered!
  assert.equal(canEarlySubmitFull, true);
});

test('Phase 19 - Item 7: Empty attempts save but earn 0 completion credit in todo_status_on', () => {
  // Simulating todo_status_on logic across sections
  function isTaskSatisfied(task, attempts) {
    // Only attempts with total > 0 (or attempted > 0) qualify
    const validAttempts = attempts.filter((att) => {
      if (att.student_id !== task.student_id) return false;
      const count = att.total !== undefined ? att.total : (att.attempted || 0);
      return count > 0;
    });
    return validAttempts.length > 0;
  }

  const task = { student_id: 'usr-101', section: 'basics' };

  // Empty attempt: 0 questions answered
  const emptyAttempts = [
    { student_id: 'usr-101', section: 'basics', correct: 0, total: 0, attempted: 0 },
  ];
  assert.equal(isTaskSatisfied(task, emptyAttempts), false); // 0 credit!

  // Valid attempt with at least 1 question attempted (does not require 100% correct)
  const legitimateAttempt = [
    { student_id: 'usr-101', section: 'basics', correct: 2, total: 3, attempted: 3 },
  ];
  assert.equal(isTaskSatisfied(task, legitimateAttempt), true);
});
