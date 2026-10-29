/**
 * Trendz Tracker - Pure Leaderboard View Helpers (js/leaderboardView.js)
 *
 * Pure formatting and row-mapping helpers for the Student and Admin Leaderboard views.
 * - Never calculates ranks, points, streaks, or task counts in JavaScript.
 * - Formats scope labels, card titles, and row display view-models from authoritative RPC data.
 */

export const BOARD_LABELS = {
  points: 'Points',
  streak: 'Streak',
  practice_days: 'Practice days',
  todo: 'Daily To-Do',
  improved: 'Most improved'
};

export const PERIOD_LABELS = {
  week: 'This week',
  month: 'This month',
  all: 'All time'
};

/**
 * Returns whether a given leaderboard board uses the time period switch ('week' | 'month' | 'all').
 * @param {string} board
 * @returns {boolean}
 */
export function boardUsesPeriod(board) {
  return board === 'points' || board === 'practice_days' || board === 'todo';
}

/**
 * Formats the student scope label for their own level or global scope.
 * - When scope is 'global', returns "Global (all trainees)".
 * - When level is non-empty, returns "<level> (your level only)" (e.g. "Junior 2 (your level only)").
 * - When the student has no level, returns "Your group (your level only)".
 *
 * @param {string|null|undefined} level
 * @param {'level'|'global'} [scope='level']
 * @returns {string}
 */
export function scopeLabel(level, scope = 'level') {
  if (scope === 'global') {
    return 'Global (all trainees)';
  }
  const cleanLevel = typeof level === 'string' ? level.trim() : '';
  if (cleanLevel) {
    return `${cleanLevel} (your level only)`;
  }
  return 'Your group (your level only)';
}

/**
 * Builds the card header title showing the board, period (when applicable), and scope.
 * Examples:
 * - boardTitle('streak', 'week', 'global') -> "Streak - Global (all trainees)"
 * - boardTitle('todo', 'week', 'level', 'Junior 2') -> "Daily To-Do - This week - Junior 2 (your level only)"
 * - boardTitle('points', 'month', 'Junior 2 (your level only)') -> "Points - This month - Junior 2 (your level only)"
 *
 * @param {string} board - 'points' | 'streak' | 'practice_days' | 'todo' | 'improved'
 * @param {string|null|undefined} period - 'week' | 'month' | 'all'
 * @param {string} scope - 'level' | 'global' or a pre-formatted scope label string
 * @param {string|null|undefined} [level=null] - optional student level when scope === 'level'
 * @returns {string}
 */
export function boardTitle(board, period, scope, level = null) {
  const bLabel = BOARD_LABELS[board] || 'Leaderboard';
  const usesPeriod = boardUsesPeriod(board);
  const pLabel = usesPeriod && period ? (PERIOD_LABELS[period] || PERIOD_LABELS.week) : null;

  let resolvedScope = '';
  if (scope === 'global') {
    resolvedScope = 'Global (all trainees)';
  } else if (scope === 'level') {
    resolvedScope = scopeLabel(level, 'level');
  } else if (typeof scope === 'string' && scope.trim()) {
    resolvedScope = scope.trim();
  } else {
    resolvedScope = scopeLabel(level, 'level');
  }

  if (pLabel) {
    return `${bLabel} - ${pLabel} - ${resolvedScope}`;
  }
  return `${bLabel} - ${resolvedScope}`;
}

/**
 * Formats the authoritative `value` returned by `leaderboard()` with its unit.
 * Never performs any score or rank calculation.
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} board
 * @param {number|string} value
 * @returns {string}
 */
export function formatBoardValue(board, value) {
  const num = Number(value);
  const formattedNum = Number.isFinite(num)
    ? num % 1 === 0
      ? num.toLocaleString('en-IN')
      : num.toFixed(1).replace(/\.0$/, '')
    : String(value ?? '0');

  switch (board) {
    case 'points':
      return `${formattedNum} ${num === 1 ? 'point' : 'points'}`;
    case 'streak':
    case 'practice_days':
    case 'todo':
      return `${formattedNum} ${num === 1 ? 'day' : 'days'}`;
    case 'improved': {
      const prefix = num > 0 ? '+' : '';
      return `${prefix}${formattedNum}% accuracy`;
    }
    default:
      return `${formattedNum}`;
  }
}

/**
 * Purely maps RPC rows returned by `leaderboard(p_board, p_period, p_level, p_limit, p_scope)`
 * into presentation row objects without computing ranks or values in JavaScript.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {string} [options.board='points']
 * @param {'level'|'global'} [options.scope='level']
 * @param {boolean} [options.isAdmin=false]
 * @returns {Array<{
 *   rank: number,
 *   student_id: string|null,
 *   display_name: string,
 *   value: number,
 *   formatted_value: string,
 *   is_me: boolean,
 *   is_outside_top_10: boolean,
 *   level: string|null,
 *   show_level_chip: boolean
 * }>}
 */
export function mapLeaderboardRows(
  rows,
  { board = 'points', scope = 'level', isAdmin = false } = {}
) {
  if (!Array.isArray(rows)) return [];

  return rows.map((row, index) => {
    const rankNum = Number(row?.rank);
    const isMe = !isAdmin && row?.is_me === true;
    const isOutsideTop10 = !isAdmin && isMe && (rankNum > 10 || index >= 10);
    const cleanLevel =
      typeof row?.level === 'string' && row.level.trim() ? row.level.trim() : null;
    const showLevelChip = Boolean(cleanLevel && scope === 'global');

    return {
      rank: rankNum,
      student_id: isAdmin && row?.student_id ? String(row.student_id) : null,
      display_name: String(row?.display_name ?? ''),
      value: Number(row?.value ?? 0),
      formatted_value: formatBoardValue(board, row?.value),
      is_me: isMe,
      is_outside_top_10: isOutsideTop10,
      level: cleanLevel,
      show_level_chip: showLevelChip
    };
  });
}
