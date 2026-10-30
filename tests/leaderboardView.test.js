/**
 * Trendz Tracker - Unit Tests for Pure Leaderboard View Helpers (tests/leaderboardView.test.js)
 *
 * Tests `scopeLabel(level)`, `boardTitle(board, period, scope)`, `boardUsesPeriod(board)`,
 * `formatBoardValue(board, value)`, and `mapLeaderboardRows(rows, options)`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeLabel,
  boardTitle,
  boardUsesPeriod,
  formatBoardValue,
  formatTaskFilterOptions,
  mapLeaderboardRows
} from '../js/leaderboardView.js';
import {
  buildHowItWorksText,
  getLeaderboardEmptyMessage
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

describe('boardTitle(board, period, scope, level, taskLabel)', () => {
  it('formats board, optional task label, period (when applicable), and scope accurately', () => {
    assert.equal(
      boardTitle('streak', 'week', 'global'),
      'Streak - Global (all trainees)'
    );
    assert.equal(
      boardTitle('todo', 'week', 'level', 'Junior 2'),
      'Daily To-Do - This week - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('todo', 'week', 'level', 'Junior 2', 'Task 1: Round Drill: Addition (ADD)'),
      'Daily To-Do (Task 1: Round Drill: Addition (ADD)) - This week - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('todo', 'month', 'global', null, 'Task 2: Subtraction'),
      'Daily To-Do (Task 2: Subtraction) - This month - Global (all trainees)'
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

describe('formatTaskFilterOptions(tasks)', () => {
  it('numbers active tasks sequentially as Task 1, Task 2, Task 3', () => {
    const tasks = [
      { id: 'todo-1', title: 'Round Drill: Addition (ADD)', section: 'round', level: null },
      { id: 'todo-2', title: 'Round Drill: Subtraction (SUB)', section: 'round', level: 'Level 3' },
      { id: 'todo-3', title: 'Mental Basics: 1d4r', section: 'basics', level: null }
    ];
    const options = formatTaskFilterOptions(tasks);
    assert.equal(options.length, 3);
    assert.equal(options[0].shortLabel, 'Task 1');
    assert.equal(options[0].optionLabel, 'Task 1: Round Drill: Addition (ADD)');
    assert.equal(options[1].shortLabel, 'Task 2');
    assert.equal(options[1].optionLabel, 'Task 2: Round Drill: Subtraction (SUB) [Level 3]');
    assert.equal(options[2].shortLabel, 'Task 3');
    assert.equal(options[2].optionLabel, 'Task 3: Mental Basics: 1d4r');
  });
});

describe('formatBoardValue(board, value) & Daily To-Do texts', () => {
  it('formats todo board value as fastest attempt time in seconds or minutes + seconds', () => {
    assert.equal(formatBoardValue('todo', 28), '28s');
    assert.equal(formatBoardValue('todo', 65), '1m 05s');
    assert.equal(formatBoardValue('todo', 120), '2m 00s');
  });

  it('returns the exact explanation and empty state for Daily To-Do task rankings', () => {
    assert.equal(
      buildHowItWorksText('todo', {}),
      'Students who completed the selected Daily To-Do task in this period, ranked from fastest to slowest attempt time. Pick Task 1, Task 2, Task 3, etc. above to filter by task.'
    );
    assert.equal(
      getLeaderboardEmptyMessage('todo', 'week'),
      'No student has recorded a timed attempt for this task in this period yet.'
    );
    assert.equal(
      getLeaderboardEmptyMessage('todo', 'month'),
      'No student has recorded a timed attempt for this task in this period yet.'
    );
  });
});

describe('mapLeaderboardRows(rows, options)', () => {
  const sampleRpcRows = [
    {
      rank: 1,
      student_id: 'usr-301',
      display_name: 'Ishaan K.',
      value: 28,
      is_me: false,
      level: 'Level 3'
    },
    {
      rank: 2,
      student_id: 'usr-101',
      display_name: 'Aarav S.',
      value: 32,
      is_me: true,
      level: 'Level 3'
    },
    {
      rank: 14,
      student_id: 'usr-109',
      display_name: 'Vihaan L.',
      value: 75,
      is_me: true,
      level: 'Junior 2'
    }
  ];

  it('maps student level-scope rows without level chips and hides student_id', () => {
    const mapped = mapLeaderboardRows(sampleRpcRows.slice(0, 2), {
      board: 'todo',
      scope: 'level',
      isAdmin: false
    });

    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].rank, 1);
    assert.equal(mapped[0].student_id, null);
    assert.equal(mapped[0].display_name, 'Ishaan K.');
    assert.equal(mapped[0].formatted_value, '28s');
    assert.equal(mapped[0].is_me, false);
    assert.equal(mapped[0].show_level_chip, false);

    assert.equal(mapped[1].rank, 2);
    assert.equal(mapped[1].formatted_value, '32s');
    assert.equal(mapped[1].is_me, true);
    assert.equal(mapped[1].is_outside_top_10, false);
    assert.equal(mapped[1].show_level_chip, false);
  });

  it('shows level chip in global scope and flags own row outside top 10', () => {
    const mapped = mapLeaderboardRows(sampleRpcRows, {
      board: 'todo',
      scope: 'global',
      isAdmin: false
    });

    assert.equal(mapped[0].show_level_chip, true);
    assert.equal(mapped[0].level, 'Level 3');
    assert.equal(mapped[2].rank, 14);
    assert.equal(mapped[2].formatted_value, '1m 15s');
    assert.equal(mapped[2].is_me, true);
    assert.equal(mapped[2].is_outside_top_10, true);
    assert.equal(mapped[2].show_level_chip, true);
    assert.equal(mapped[2].level, 'Junior 2');
  });

  it('preserves student_id and disables is_me highlight for admins', () => {
    const mapped = mapLeaderboardRows(sampleRpcRows.slice(0, 2), {
      board: 'todo',
      scope: 'global',
      isAdmin: true
    });

    assert.equal(mapped[0].student_id, 'usr-301');
    assert.equal(mapped[1].student_id, 'usr-101');
    assert.equal(mapped[1].is_me, false);
    assert.equal(mapped[1].is_outside_top_10, false);
    assert.equal(mapped[0].show_level_chip, true);
  });
});
