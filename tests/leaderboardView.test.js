/**
 * Trendz Tracker - Unit Tests for Pure Leaderboard View Helpers (tests/leaderboardView.test.js)
 *
 * Tests `scopeLabel(level)`, `boardTitle(...)`, `boardUsesPeriod(board)`,
 * `isSpeedRankableTask(task)`, `formatBoardValue(board, value)`,
 * `formatTaskBestPerMinute`, `formatTaskBestRound`, `mapLeaderboardRows`, and `mapTaskLeaderboardRows`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_SPEED_EXPLANATION_TEXT,
  TASK_SPEED_EMPTY_MESSAGE,
  TASK_SPEED_UNAVAILABLE_MESSAGE,
  scopeLabel,
  boardTitle,
  boardUsesPeriod,
  isSpeedRankableTask,
  formatBoardValue,
  formatTaskBestPerMinute,
  formatTaskBestRound,
  formatTaskFilterOptions,
  mapLeaderboardRows,
  mapTaskLeaderboardRows
} from '../js/leaderboardView.js';
import {
  buildHowItWorksText,
  getLeaderboardEmptyMessage,
  normalizeLeaderboardErrorMessage
} from '../js/leaderboardData.js';

describe('scopeLabel(level, scope)', () => {
  it('returns "<student\'s level> (your level only)" when level is provided', () => {
    assert.equal(scopeLabel('Junior 2'), 'Junior 2 (your level only)');
    assert.equal(scopeLabel('  Level 3  ', 'level'), 'Level 3 (your level only)');
  });

  it('returns "Your group (your level only)" when the student has no level', () => {
    assert.equal(scopeLabel(null), 'Your group (your level only)');
    assert.equal(scopeLabel(undefined), 'Your group (your level only)');
    assert.equal(scopeLabel('   '), 'Your group (your level only)');
  });

  it('returns "Global (all trainees)" when scope is "global"', () => {
    assert.equal(scopeLabel('Junior 2', 'global'), 'Global (all trainees)');
    assert.equal(scopeLabel(null, 'global'), 'Global (all trainees)');
  });
});

describe('boardUsesPeriod(board)', () => {
  it('returns true for points, practice_days, and todo, and false for streak and improved', () => {
    assert.equal(boardUsesPeriod('points'), true);
    assert.equal(boardUsesPeriod('practice_days'), true);
    assert.equal(boardUsesPeriod('todo'), true);
    assert.equal(boardUsesPeriod('streak'), false);
    assert.equal(boardUsesPeriod('improved'), false);
  });
});

describe('boardTitle(board, period, scope, level, taskTitle, todayIST)', () => {
  it('formats board or "<task title> - <period label> - <scope or level>" accurately', () => {
    assert.equal(
      boardTitle('streak', 'week', 'global'),
      'Streak - Global (all trainees)'
    );
    assert.equal(
      boardTitle('todo', 'week', 'level', 'Junior 2'),
      'Daily To-Do - This week - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('todo', 'week', 'level', 'Junior 2', 'Mental Basics: 1d4r'),
      'Mental Basics: 1d4r - This week - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('todo', 'date:2026-10-29', 'global', null, 'Mental Basics: 1d4r', '2026-10-31'),
      'Mental Basics: 1d4r - Thu 29 Oct 2026 - Global (all trainees)'
    );
    assert.equal(
      boardTitle('points', 'all', 'Junior 2 (your level only)'),
      'Points - All time - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('improved', 'week', 'level', null),
      'Most improved - Your group (your level only)'
    );
  });
});

describe('isSpeedRankableTask(task) & formatTaskFilterOptions(tasks)', () => {
  it('returns true only for basics tasks that have a category_id', () => {
    assert.equal(
      isSpeedRankableTask({ section: 'basics', category_id: 'cat-bas-1' }),
      true
    );
    assert.equal(
      isSpeedRankableTask({ section: 'basics', category_id: null }),
      false
    );
    assert.equal(
      isSpeedRankableTask({ section: 'round', category_id: 'cat-rnd-1' }),
      false
    );
    assert.equal(
      isSpeedRankableTask({ section: 'flash', category_id: null }),
      false
    );
    assert.equal(
      isSpeedRankableTask({ section: 'elements', category_id: null }),
      false
    );
    assert.equal(
      isSpeedRankableTask({ section: 'memoriad', category_id: null }),
      false
    );
  });

  it('numbers active tasks and marks isSpeedRanked accurately', () => {
    const tasks = [
      { id: 'todo-1', title: 'Round Drill: Addition (ADD)', section: 'round', category_id: 'cat-rnd-1', level: null },
      { id: 'todo-2', title: 'Mental Basics: 1d4r', section: 'basics', category_id: 'cat-bas-1', level: 'Level 3' },
      { id: 'todo-3', title: 'Any Basics Drill', section: 'basics', category_id: null, level: null }
    ];
    const options = formatTaskFilterOptions(tasks);
    assert.equal(options.length, 3);
    assert.equal(options[0].isSpeedRanked, false);
    assert.equal(options[1].isSpeedRanked, true);
    assert.equal(options[1].category_id, 'cat-bas-1');
    assert.equal(options[2].isSpeedRanked, false);
  });
});

describe('formatBoardValue(board, value) & Task Speed formatting', () => {
  it('formats All tasks todo board value as completed days (never seconds)', () => {
    assert.equal(formatBoardValue('todo', 1), '1 day');
    assert.equal(formatBoardValue('todo', 3), '3 days');
    assert.equal(formatBoardValue('todo', 6), '6 days');
  });

  it('formats authoritative best_per_minute and best round strings without calculating in JS', () => {
    assert.equal(formatTaskBestPerMinute(42), '42 correct/min');
    assert.equal(formatTaskBestPerMinute(42.5), '42.5 correct/min');
    assert.equal(formatTaskBestRound(21, 22, 30), '21 of 22 in 30 s');
  });

  it('returns the exact explanation, unavailable notice, and empty state texts', () => {
    assert.equal(
      buildHowItWorksText('todo', {}, { isTaskSpeedBoard: true }),
      TASK_SPEED_EXPLANATION_TEXT
    );
    assert.equal(
      getLeaderboardEmptyMessage('todo', 'week', { isTaskSpeedBoard: true }),
      TASK_SPEED_EMPTY_MESSAGE
    );
    assert.equal(
      TASK_SPEED_UNAVAILABLE_MESSAGE,
      'Speed ranking is not available for this kind of task yet.'
    );
    assert.equal(
      normalizeLeaderboardErrorMessage('The date cannot be in the future.'),
      'The date cannot be in the future.'
    );
    assert.equal(
      normalizeLeaderboardErrorMessage('The global leaderboard is switched off.'),
      'The global leaderboard is switched off.'
    );
  });
});

describe('mapLeaderboardRows & mapTaskLeaderboardRows', () => {
  it('maps todo_task_leaderboard rows with Best, Best round, and Rounds columns', () => {
    const rpcRows = [
      {
        rank: 1,
        student_id: 'usr-301',
        display_name: 'Ishaan K.',
        level: 'Level 3',
        best_per_minute: 42,
        correct: 21,
        attempted: 22,
        seconds: 30,
        attempts: 5,
        is_me: false
      },
      {
        rank: 2,
        student_id: 'usr-101',
        display_name: 'Aarav S.',
        level: 'Level 3',
        best_per_minute: 38,
        correct: 19,
        attempted: 20,
        seconds: 30,
        attempts: 4,
        is_me: true
      }
    ];

    const studentGlobal = mapTaskLeaderboardRows(rpcRows, {
      scope: 'global',
      isAdmin: false
    });
    assert.equal(studentGlobal.length, 2);
    assert.equal(studentGlobal[0].rank, 1);
    assert.equal(studentGlobal[0].student_id, null);
    assert.equal(studentGlobal[0].show_level_chip, true);
    assert.equal(studentGlobal[0].formatted_best, '42 correct/min');
    assert.equal(studentGlobal[0].formatted_best_round, '21 of 22 in 30 s');
    assert.equal(studentGlobal[0].formatted_rounds, '5');
    assert.equal(studentGlobal[1].is_me, true);

    const adminRows = mapTaskLeaderboardRows(rpcRows, {
      scope: 'global',
      isAdmin: true
    });
    assert.equal(adminRows[0].student_id, 'usr-301');
    assert.equal(adminRows[1].is_me, false);
  });

  it('maps standard leaderboard rows for All tasks as completed days', () => {
    const rows = [
      { rank: 1, student_id: 'usr-301', display_name: 'Ishaan K.', value: 5, is_me: false, level: 'Level 3' },
      { rank: 2, student_id: 'usr-101', display_name: 'Aarav S.', value: 1, is_me: true, level: 'Level 3' }
    ];
    const mapped = mapLeaderboardRows(rows, { board: 'todo', scope: 'level', isAdmin: false });
    assert.equal(mapped[0].formatted_value, '5 days');
    assert.equal(mapped[1].formatted_value, '1 day');
  });
});
