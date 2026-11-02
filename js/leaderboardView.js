/**
 * Trendz Tracker - Pure Leaderboard View Helpers (js/leaderboardView.js)
 *
 * Pure formatting and row-mapping helpers for the Student and Admin Leaderboard views.
 * - Never calculates ranks, points, streaks, times, or speeds in JavaScript.
 * - Formats scope labels, card titles, and row display view-models from authoritative RPC data.
 */

import { periodLabel } from './periods.js';

export const BOARD_LABELS = {
  points: 'Points',
  weekly_tests: 'Weekly tests',
  streak: 'Streak',
  practice_days: 'Practice days',
  todo: 'Daily To-Do',
  improved: 'Most improved'
};

export const PERIOD_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  year: 'This year',
  all: 'All time'
};

export const TASK_SPEED_EXPLANATION_TEXT =
  "Ranked by correct answers per minute in each student's best round on the website. Typed scores, rounds under 20 seconds and rounds under 10 questions do not count.";

export const TASK_SPEED_EMPTY_MESSAGE = 'No qualifying rounds in this period.';

export const TASK_SPEED_UNAVAILABLE_MESSAGE =
  'Speed ranking is not available for this kind of task yet.';

/**
 * Returns whether a given leaderboard board uses the time period selector.
 * @param {string} board
 * @returns {boolean}
 */
export function boardUsesPeriod(board) {
  return (
    board === 'points' ||
    board === 'weekly_tests' ||
    board === 'practice_days' ||
    board === 'todo'
  );
}

/**
 * Returns whether a daily task supports speed ranking on the Daily To-Do Leaderboard:
 * - `basics` tasks that have a `category_id`
 * - `elements` tasks that have an `activity_key`
 * - `flash` tasks
 * @param {Object|null|undefined} task
 * @returns {boolean}
 */
export function isSpeedRankableTask(task) {
  if (!task || typeof task !== 'object') return false;
  const section = String(task.section || '').trim().toLowerCase();
  if (section === 'basics') {
    const categoryId = task.category_id ? String(task.category_id).trim() : '';
    return Boolean(categoryId);
  }
  if (section === 'elements') {
    const activityKey = task.activity_key ? String(task.activity_key).trim() : '';
    return Boolean(activityKey);
  }
  if (section === 'flash') {
    return true;
  }
  return false;
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
 * Resolves the human-readable period label for `boardTitle`.
 * @param {string|null|undefined} period
 * @param {Date|string|number} [todayIST]
 * @returns {string}
 */
export function resolvePeriodTitleLabel(period, todayIST) {
  if (!period || typeof period !== 'string') {
    return PERIOD_LABELS.week;
  }
  const clean = period.trim();
  const lower = clean.toLowerCase();
  if (PERIOD_LABELS[lower]) {
    return PERIOD_LABELS[lower];
  }
  if (lower.startsWith('date:')) {
    return periodLabel(clean, todayIST);
  }
  return clean;
}

/**
 * Builds the card header title showing the board (or selected task title), period (when applicable), and scope.
 * Examples:
 * - boardTitle('streak', 'week', 'global') -> "Streak - Global (all trainees)"
 * - boardTitle('todo', 'week', 'level', 'Junior 2') -> "Daily To-Do - This week - Junior 2 (your level only)"
 * - boardTitle('todo', 'week', 'level', 'Junior 2', 'Mental Basics: 1d4r') -> "Mental Basics: 1d4r - This week - Junior 2 (your level only)"
 * - boardTitle('todo', 'date:2026-10-29', 'global', null, 'Mental Basics: 1d4r') -> "Mental Basics: 1d4r - Thu 29 Oct 2026 - Global (all trainees)"
 * - boardTitle('points', 'month', 'Junior 2 (your level only)') -> "Points - This month - Junior 2 (your level only)"
 *
 * @param {string} board - 'points' | 'streak' | 'practice_days' | 'todo' | 'improved'
 * @param {string|null|undefined} period - 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' | 'date:YYYY-MM-DD'
 * @param {string} scope - 'level' | 'global' or a pre-formatted scope label string
 * @param {string|null|undefined} [level=null] - optional student level when scope === 'level'
 * @param {string|null|undefined} [taskTitle=null] - optional selected task title when board === 'todo'
 * @param {Date|string|number} [todayIST] - optional reference IST date for date formatting
 * @returns {string}
 */
export function boardTitle(
  board,
  period,
  scope,
  level = null,
  taskTitle = null,
  todayIST = undefined
) {
  const baseLabel = BOARD_LABELS[board] || 'Leaderboard';
  const cleanTaskTitle =
    board === 'todo' &&
    typeof taskTitle === 'string' &&
    taskTitle.trim() &&
    taskTitle.trim().toLowerCase() !== 'all' &&
    taskTitle.trim().toLowerCase() !== 'all tasks'
      ? taskTitle.trim()
      : '';
  const bLabel = cleanTaskTitle || baseLabel;

  const usesPeriod = boardUsesPeriod(board);
  const pLabel = usesPeriod ? resolvePeriodTitleLabel(period, todayIST) : null;

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
 * Formats a list of daily_tasks rows into Task filter options.
 * Preserves `category_id` and `isSpeedRanked` (`section === 'basics' && Boolean(category_id)`).
 *
 * @param {Array<Object>} tasks
 * @returns {Array<{
 *   id: string,
 *   taskNumber: number,
 *   shortLabel: string,
 *   optionLabel: string,
 *   title: string,
 *   section: string,
 *   category_id: string|null,
 *   level: string|null,
 *   isSpeedRanked: boolean
 * }>}
 */
export function formatTaskFilterOptions(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .filter(t => t && t.id)
    .map((t, index) => {
      const taskNumber = index + 1;
      const title = String(t.title || `Task ${taskNumber}`).trim();
      const shortLabel = `Task ${taskNumber}`;
      const levelSuffix =
        typeof t.level === 'string' && t.level.trim() ? ` [${t.level.trim()}]` : '';
      const categoryId =
        t.category_id !== null && t.category_id !== undefined && String(t.category_id).trim()
          ? String(t.category_id).trim()
          : null;
      const activityKey =
        t.activity_key !== null && t.activity_key !== undefined && String(t.activity_key).trim()
          ? String(t.activity_key).trim()
          : null;
      const section = String(t.section || 'round').trim().toLowerCase();
      return {
        id: String(t.id),
        taskNumber,
        shortLabel,
        optionLabel: `${shortLabel}: ${title}${levelSuffix}`,
        title,
        section,
        category_id: categoryId,
        activity_key: activityKey,
        level: typeof t.level === 'string' && t.level.trim() ? t.level.trim() : null,
        isSpeedRanked: isSpeedRankableTask({
          section,
          category_id: categoryId,
          activity_key: activityKey
        })
      };
    });
}

/**
 * Formats the authoritative `value` returned by `leaderboard()` with its unit.
 * For `'todo'` (All tasks), `value` is the number of days the student completed all assigned tasks.
 * Never performs any score, rank, or time calculation.
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
 * Formats the authoritative `best_per_minute` value from `todo_task_leaderboard`.
 * E.g. `42 -> "42 correct/min"`, `42.5 -> "42.5 correct/min"`.
 * Never computes speed from correct and seconds in JavaScript.
 * @param {number|string} bestPerMinute
 * @returns {string}
 */
export function formatTaskBestPerMinute(bestPerMinute) {
  const num = Number(bestPerMinute);
  if (!Number.isFinite(num)) {
    return '0 correct/min';
  }
  const formatted =
    num % 1 === 0
      ? num.toLocaleString('en-IN')
      : num.toFixed(1).replace(/\.0$/, '');
  return `${formatted} correct/min`;
}

/**
 * Formats the authoritative `correct`, `attempted`, and `seconds` fields from `todo_task_leaderboard`.
 * E.g. `(21, 22, 30) -> "21 of 22 in 30 s"`.
 * @param {number|string} correct
 * @param {number|string} attempted
 * @param {number|string} seconds
 * @returns {string}
 */
export function formatTaskBestRound(correct, attempted, seconds) {
  const c = Number.isFinite(Number(correct)) ? Number(correct) : 0;
  const a = Number.isFinite(Number(attempted)) ? Number(attempted) : 0;
  const s = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
  return `${c} of ${a} in ${s} s`;
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

/**
 * Purely maps RPC rows returned by `todo_task_leaderboard(p_task, p_period, p_level, p_limit, p_scope)`
 * into presentation row objects without computing ranks, times, or speeds in JavaScript.
 *
 * @param {Array<Object>} rows
 * @param {Object} [options]
 * @param {'level'|'global'} [options.scope='level']
 * @param {boolean} [options.isAdmin=false]
 * @returns {Array<{
 *   rank: number,
 *   student_id: string|null,
 *   display_name: string,
 *   level: string|null,
 *   show_level_chip: boolean,
 *   best_per_minute: number,
 *   formatted_best: string,
 *   correct: number,
 *   attempted: number,
 *   seconds: number,
 *   formatted_best_round: string,
 *   attempts: number,
 *   formatted_rounds: string,
 *   is_me: boolean,
 *   is_outside_top_10: boolean
 * }>}
 */
export function mapTaskLeaderboardRows(
  rows,
  { scope = 'level', isAdmin = false } = {}
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
      level: cleanLevel,
      show_level_chip: showLevelChip,
      best_per_minute: Number(row?.best_per_minute ?? 0),
      formatted_best: formatTaskBestPerMinute(row?.best_per_minute),
      correct: Number(row?.correct ?? 0),
      attempted: Number(row?.attempted ?? 0),
      seconds: Number(row?.seconds ?? 0),
      formatted_best_round: formatTaskBestRound(row?.correct, row?.attempted, row?.seconds),
      attempts: Number(row?.attempts ?? 0),
      formatted_rounds: String(Number(row?.attempts ?? 0)),
      is_me: isMe,
      is_outside_top_10: isOutsideTop10
    };
  });
}
