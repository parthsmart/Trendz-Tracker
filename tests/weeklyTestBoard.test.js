import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKLY_TEST_BOARD_EXPLANATION,
  ONLINE_TEST_NOT_CLOSED_MESSAGE,
  scoreText,
  boardTitle,
  mapWeeklyTestLeaderboardRows
} from '../js/weeklyTestBoard.js';

test('scoreText formats correct and attempted counts in plain English', () => {
  assert.equal(scoreText(38, 40), '38 of 40');
  assert.equal(scoreText(0, 15), '0 of 15');
  assert.equal(scoreText(null, undefined), '0 of 0');
});

test('boardTitle formats single test and all-tests titles with scope', () => {
  assert.equal(
    boardTitle({ title: 'Sunday Test #5' }, 'month', 'level', 'Level 2'),
    'Sunday Test #5 - Level 2 (your level only)'
  );
  assert.equal(
    boardTitle('Sunday Test #5', 'month', 'global', 'Level 2'),
    'Sunday Test #5 - Global (all trainees)'
  );
  assert.equal(
    boardTitle(null, 'month', 'level', 'Level 3', '2026-04-19'),
    'Weekly tests - This month - Level 3 (your level only)'
  );
  assert.equal(
    boardTitle(null, 'date:2026-04-12', 'global', 'Level 1', '2026-04-19'),
    'Weekly tests - Sun 12 Apr 2026 - Global (all trainees)'
  );
});

test('mapWeeklyTestLeaderboardRows preserves DB rank and points without recomputing', () => {
  const raw = [
    {
      rank: 1,
      student_id: 'stu-1',
      display_name: 'Aarav K.',
      level: 'Level 2',
      points: 72,
      correct: 38,
      attempted: 40,
      seconds: 115,
      tests: 2,
      is_me: false
    },
    {
      rank: 14,
      student_id: 'stu-2',
      display_name: 'Meera S.',
      level: 'Level 2',
      points: 45,
      correct: 25,
      attempted: 30,
      seconds: null,
      tests: 1,
      is_me: true
    }
  ];

  const studentMapped = mapWeeklyTestLeaderboardRows(raw, { scope: 'level', isAdmin: false });
  assert.equal(studentMapped.length, 2);
  assert.equal(studentMapped[0].rank, 1);
  assert.equal(studentMapped[0].points, 72);
  assert.equal(studentMapped[0].formatted_points, '72 points');
  assert.equal(studentMapped[0].formatted_score, '38 of 40');
  assert.equal(studentMapped[0].formatted_time, '01:55');
  assert.equal(studentMapped[0].student_id, null);
  assert.equal(studentMapped[0].show_level_chip, false);

  assert.equal(studentMapped[1].rank, 14);
  assert.equal(studentMapped[1].is_outside_top_10, true);
  assert.equal(studentMapped[1].formatted_time, '—');

  const adminMapped = mapWeeklyTestLeaderboardRows(raw, { scope: 'global', isAdmin: true });
  assert.equal(adminMapped[0].student_id, 'stu-1');
  assert.equal(adminMapped[0].show_level_chip, true);
});

test('constants match required user-facing copy', () => {
  assert.equal(
    WEEKLY_TEST_BOARD_EXPLANATION,
    'Points = correct answers minus wrong answers in each section (never below 0). Online tests appear after they close.'
  );
  assert.equal(
    ONLINE_TEST_NOT_CLOSED_MESSAGE,
    'The leaderboard of an online test appears after the test closes.'
  );
});
