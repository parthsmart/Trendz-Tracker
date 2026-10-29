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

describe('boardTitle(board, period, scope, level)', () => {
  it('formats board, period (when applicable), and scope accurately', () => {
    assert.equal(
      boardTitle('streak', 'week', 'global'),
      'Streak - Global (all trainees)'
    );
    assert.equal(
      boardTitle('todo', 'week', 'level', 'Junior 2'),
      'Daily To-Do - This week - Junior 2 (your level only)'
    );
    assert.equal(
      boardTitle('todo', 'month', 'global'),
      'Daily To-Do - This month - Global (all trainees)'
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

describe('formatBoardValue(board, value) & Daily To-Do texts', () => {
  it('formats todo board value in days (1 day vs n days)', () => {
    assert.equal(formatBoardValue('todo', 1), '1 day');
    assert.equal(formatBoardValue('todo', 5), '5 days');
  });

  it('returns the exact explanation and empty state for Daily To-Do', () => {
    assert.equal(
      buildHowItWorksText('todo', {}),
      'Days on which you finished every task on your daily list. Different levels have different tasks, so we count days, not tasks.'
    );
    assert.equal(
      getLeaderboardEmptyMessage('todo', 'week'),
      'Nobody has finished a full day yet in this period'
    );
    assert.equal(
      getLeaderboardEmptyMessage('todo', 'month'),
      'Nobody has finished a full day yet in this period'
    );
  });
});

describe('mapLeaderboardRows(rows, options)', () => {
  const sampleRpcRows = [
    {
      rank: 1,
      student_id: 'usr-301',
      display_name: 'Ishaan K.',
      value: 6,
      is_me: false,
      level: 'Level 3'
    },
    {
      rank: 2,
      student_id: 'usr-101',
      display_name: 'Aarav S.',
      value: 1,
      is_me: true,
      level: 'Level 3'
    },
    {
      rank: 14,
      student_id: 'usr-109',
      display_name: 'Vihaan L.',
      value: 1,
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
    assert.equal(mapped[0].formatted_value, '6 days');
    assert.equal(mapped[0].is_me, false);
    assert.equal(mapped[0].show_level_chip, false);

    assert.equal(mapped[1].rank, 2);
    assert.equal(mapped[1].formatted_value, '1 day');
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
