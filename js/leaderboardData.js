/**
 * Trendz Tracker - Leaderboard & Competition Rules Data Access (js/leaderboardData.js)
 *
 * STRICT ARCHITECTURAL CONTRACT:
 * - Never calculate points, ranks, accuracy deltas, times, speeds, or streaks in JavaScript.
 * - Always call PostgreSQL RPCs `leaderboard(p_board, p_period, p_level, p_limit, p_scope)`,
 *   `todo_task_leaderboard(p_task, p_period, p_level, p_limit, p_scope)`,
 *   `global_leaderboard_enabled()`, and `competition_rules()`.
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import {
  formatBoardValue,
  TASK_SPEED_EXPLANATION_TEXT,
  TASK_SPEED_EMPTY_MESSAGE
} from './leaderboardView.js';
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';

/**
 * Normalizes known PostgreSQL / PostgREST error messages into friendly sentences.
 * @param {string} rawMessage
 * @returns {string}
 */
export function normalizeLeaderboardErrorMessage(rawMessage) {
  const msg = String(rawMessage || '').trim();
  const lower = msg.toLowerCase();
  if (lower.includes('future')) {
    return 'The date cannot be in the future.';
  }
  if (lower.includes('switched off')) {
    return 'The global leaderboard is switched off.';
  }
  if (lower.includes('basics tasks with a category only')) {
    return 'Speed ranking is available for basics tasks with a category only.';
  }
  if (lower.includes('before 2020')) {
    return 'The date cannot be before 2020-01-01.';
  }
  return msg || 'Could not load leaderboard.';
}

/**
 * Calls RPC `leaderboard(p_board, p_period, p_level, p_limit, p_scope)`
 * @param {Object} params
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} params.board
 * @param {string} params.period - 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' | 'date:YYYY-MM-DD'
 * @param {string|null} params.level
 * @param {number} params.limit
 * @param {'level'|'global'} [params.scope='level']
 * @param {Object|null} callerProfile
 * @returns {Promise<Array<{rank: number, student_id: string|null, display_name: string, value: number, is_me: boolean, level?: string|null}>>}
 */
export async function fetchLeaderboard(
  { board = 'points', period = 'week', level = null, limit = 10, scope = 'level' } = {},
  callerProfile = null
) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockLeaderboard(
      {
        p_board: board,
        p_period: period,
        p_level: level,
        p_limit: limit,
        p_scope: scope
      },
      callerProfile
    );
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase.rpc('leaderboard', {
    p_board: board,
    p_period: period,
    p_level: level,
    p_limit: limit,
    p_scope: scope
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
      clearStaleSupabaseSession();
      window.location.href = '/index.html';
      return [];
    }
    throw new Error(normalizeLeaderboardErrorMessage(msg));
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Calls RPC `todo_task_leaderboard(p_task, p_period, p_level, p_limit, p_scope)`.
 * Strictly for daily tasks of section 'basics' that have a category_id.
 *
 * @param {Object} params
 * @param {string} params.taskId
 * @param {string} params.period - 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all' | 'date:YYYY-MM-DD'
 * @param {string|null} params.level
 * @param {number} params.limit
 * @param {'level'|'global'} [params.scope='level']
 * @param {Object|null} callerProfile
 * @returns {Promise<Array<{
 *   rank: number,
 *   student_id: string|null,
 *   display_name: string,
 *   level: string|null,
 *   best_per_minute: number,
 *   correct: number,
 *   attempted: number,
 *   seconds: number,
 *   attempts: number,
 *   is_me: boolean
 * }>>}
 */
export async function fetchTodoTaskLeaderboard(
  { taskId, period = 'week', level = null, limit = 10, scope = 'level' } = {},
  callerProfile = null
) {
  if (!taskId) {
    throw new Error('Speed ranking is available for basics tasks with a category only.');
  }

  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockTodoTaskLeaderboard(
      {
        p_task: taskId,
        p_period: period,
        p_level: level,
        p_limit: limit,
        p_scope: scope
      },
      callerProfile
    );
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase.rpc('todo_task_leaderboard', {
    p_task: taskId,
    p_period: period,
    p_level: level,
    p_limit: limit,
    p_scope: scope
  });

  if (error) {
    const msg = error.message || '';
    if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
      clearStaleSupabaseSession();
      window.location.href = '/index.html';
      return [];
    }
    throw new Error(normalizeLeaderboardErrorMessage(msg));
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Loads the active Daily To-Do tasks for the Daily To-Do Leaderboard task filter.
 * Filters tasks according to the active scope/level:
 * - Student in 'level' scope: tasks assigned to their level or all levels (level IS NULL).
 * - Student in 'global' scope or Admin with 'all' levels: all active tasks.
 * - Admin with a specific level selected: tasks assigned to that level or all levels (level IS NULL).
 *
 * @param {Object} [params]
 * @param {string|null} [params.level=null]
 * @param {'level'|'global'} [params.scope='level']
 * @param {Object|null} [callerProfile=null]
 * @returns {Promise<Array<Object>>}
 */
export async function fetchTodoLeaderboardTasks(
  { level = null, scope = 'level' } = {},
  callerProfile = null
) {
  let rawTasks = [];

  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      return [];
    }
    rawTasks = DemoDB.getTodos().filter(t => t && t.active !== false);
  } else {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from('daily_tasks')
        .select('id, title, section, category_id, activity_key, level, required_count, sort_order, active')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (!error && Array.isArray(data)) {
        rawTasks = data;
      }
    }
  }

  const isAdmin = callerProfile?.role === 'admin';
  const targetLevel = isAdmin
    ? level && level !== 'all'
      ? String(level).trim()
      : null
    : scope === 'global'
      ? null
      : callerProfile?.level
        ? String(callerProfile.level).trim()
        : null;

  if (!targetLevel) {
    return rawTasks;
  }

  const filtered = rawTasks.filter(t => {
    const tLevel = typeof t.level === 'string' ? t.level.trim() : '';
    return !tLevel || tLevel.toLowerCase() === targetLevel.toLowerCase();
  });

  return filtered.length > 0 ? filtered : rawTasks;
}

/**
 * Calls RPC `global_leaderboard_enabled()` (callable by any logged-in user).
 * Returns true when the global leaderboard is enabled, or false when switched off.
 * @returns {Promise<boolean>}
 */
export async function fetchGlobalLeaderboardEnabled() {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockGlobalLeaderboardEnabled();
  }

  const supabase = await getSupabase();
  if (!supabase) {
    return false;
  }

  const { data, error } = await supabase.rpc('global_leaderboard_enabled');
  if (error) {
    const msg = error.message || '';
    if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
      clearStaleSupabaseSession();
      window.location.href = '/index.html';
    }
    return false;
  }

  if (Array.isArray(data)) {
    return Boolean(data[0]);
  }
  return Boolean(data);
}

/**
 * Calls RPC `competition_rules()` (callable by both students and admins)
 * @returns {Promise<{weekly_test_multiplier: number, attendance_present_points: number, improved_min_entries: number, leaderboard_names: string}>}
 */
export async function fetchCompetitionRules() {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return DemoDB.mockCompetitionRules();
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database client unavailable.');
  }

  const { data, error } = await supabase.rpc('competition_rules');

  if (error) {
    const msg = error.message || '';
    if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
      clearStaleSupabaseSession();
      window.location.href = '/index.html';
    }
    throw new Error(msg || 'Could not load competition rules.');
  }

  const row = Array.isArray(data) ? data[0] : data;
  return {
    weekly_test_multiplier: Number(row?.weekly_test_multiplier ?? 2),
    attendance_present_points: Number(row?.attendance_present_points ?? 10),
    improved_min_entries: Number(row?.improved_min_entries ?? 5),
    leaderboard_names: row?.leaderboard_names || 'first_name_initial'
  };
}

/**
 * Formats the authoritative `value` returned by `leaderboard()` with its required unit.
 * Never performs any score calculation.
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} board
 * @param {number|string} value
 * @returns {string}
 */
export function formatLeaderboardValue(board, value) {
  return formatBoardValue(board, value);
}

/**
 * Builds the plain-English "How it works" explanation per board from `competition_rules()`.
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} board
 * @param {Object} rules - returned by fetchCompetitionRules()
 * @param {Object} [options]
 * @param {boolean} [options.isTaskSpeedBoard=false]
 * @returns {string}
 */
export function buildHowItWorksText(board, rules, { isTaskSpeedBoard = false } = {}) {
  const multiplier = rules?.weekly_test_multiplier ?? 2;
  const presentPts = rules?.attendance_present_points ?? 10;
  const minEntries = rules?.improved_min_entries ?? 5;

  switch (board) {
    case 'points':
      return `Points = for each weekly test category, correct answers minus wrong answers (never below 0) times ${multiplier}, plus ${presentPts} points for each session you attended; excused sessions give nothing and cost nothing.`;
    case 'improved':
      return `Most improved = this week's accuracy minus last week's, needs at least ${minEntries} entries in each week.`;
    case 'practice_days':
      return `Practice days = days you entered scores in the selected period.`;
    case 'todo':
      if (isTaskSpeedBoard) {
        return TASK_SPEED_EXPLANATION_TEXT;
      }
      return `Daily To-Do = days in this period on which you finished every task assigned to you for that day.`;
    case 'streak':
      return `Streak = consecutive days you completed your daily plan in India time.`;
    default:
      return `Rankings are computed by the database.`;
  }
}

/**
 * Returns an encouraging empty state message for the given board and period.
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} board
 * @param {string} [period='week']
 * @param {Object} [options]
 * @param {boolean} [options.isTaskSpeedBoard=false]
 * @returns {string}
 */
export function getLeaderboardEmptyMessage(
  board,
  period = 'week',
  { isTaskSpeedBoard = false } = {}
) {
  if (board === 'todo') {
    if (isTaskSpeedBoard) {
      return TASK_SPEED_EMPTY_MESSAGE;
    }
    return 'No completed daily to-do days in this period yet.';
  }
  if (board === 'points') {
    if (period === 'week') {
      return 'No points yet this week. Weekly tests and sessions earn points.';
    }
    if (period === 'month') {
      return 'No points yet this month. Weekly tests and sessions earn points.';
    }
    return 'No points on the board yet. Weekly tests and sessions earn points.';
  }
  if (board === 'streak') {
    return 'No streaks on the board yet. Practice daily to start your streak!';
  }
  if (board === 'practice_days') {
    if (period === 'week') {
      return 'No practice days yet this week. Enter your scores today to get on the board!';
    }
    if (period === 'month') {
      return 'No practice days yet this month. Enter your scores to get on the board!';
    }
    return 'No practice days on the board yet. Enter your scores to get started!';
  }
  if (board === 'improved') {
    return 'No improvement rankings yet this week. Practice consistently each week to see your accuracy climb!';
  }
  return 'No entries on this board yet.';
}
