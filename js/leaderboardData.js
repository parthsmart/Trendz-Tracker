/**
 * Trendz Tracker - Leaderboard & Competition Rules Data Access (js/leaderboardData.js)
 *
 * STRICT ARCHITECTURAL CONTRACT:
 * - Never calculate points, ranks, accuracy deltas, or streaks in JavaScript.
 * - Always call PostgreSQL RPCs `leaderboard(p_board, p_period, p_level, p_limit)`
 *   and `competition_rules()`.
 * - Never expose or render raw scores on leaderboards; only render the `value`
 *   and pre-formatted `display_name` returned by `leaderboard()`.
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { formatBoardValue } from './leaderboardView.js';
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';

/**
 * Calls RPC `leaderboard(p_board, p_period, p_level, p_limit, p_scope, p_task_id)`
 * @param {Object} params
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} params.board
 * @param {'week'|'month'|'all'} params.period
 * @param {string|null} params.level
 * @param {number} params.limit
 * @param {'level'|'global'} [params.scope='level']
 * @param {string|null} [params.taskId=null]
 * @param {Object|null} callerProfile
 * @returns {Promise<Array<{rank: number, student_id: string|null, display_name: string, value: number, is_me: boolean, level?: string|null}>>}
 */
export async function fetchLeaderboard(
  { board = 'points', period = 'week', level = null, limit = 10, scope = 'level', taskId = null } = {},
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
        p_scope: scope,
        p_task_id: taskId
      },
      callerProfile
    );
  }

  const supabase = await getSupabase();
  if (!supabase) {
    throw new Error('Database client unavailable.');
  }

  const baseArgs = {
    p_board: board,
    p_period: period,
    p_level: level,
    p_limit: limit,
    p_scope: scope
  };

  let { data, error } = await supabase.rpc(
    'leaderboard',
    board === 'todo' && taskId
      ? { ...baseArgs, p_task_id: taskId }
      : baseArgs
  );

  // If the live database has not yet been updated with the 6-argument leaderboard(..., p_task_id) signature,
  // fall back to calling the 5-argument signature so the leaderboard page continues working without crashing.
  if (error && board === 'todo' && taskId) {
    const errCode = error.code || '';
    const errMsg = error.message || '';
    if (
      errCode === 'PGRST202' ||
      errMsg.includes('p_task_id') ||
      errMsg.includes('Could not find the function')
    ) {
      const retry = await supabase.rpc('leaderboard', baseArgs);
      data = retry.data;
      error = retry.error;
    }
  }

  if (error) {
    const msg = error.message || '';
    if (msg.includes('JWT') || msg.includes('token') || msg.includes('Refresh')) {
      clearStaleSupabaseSession();
      window.location.href = '/index.html';
      return [];
    }
    throw new Error(msg || 'Could not load leaderboard.');
  }

  return Array.isArray(data) ? data : [];
}

/**
 * Loads the active Daily To-Do tasks for the Daily To-Do Leaderboard task filter ("Task 1", "Task 2", "Task 3", ...).
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
 * @returns {string}
 */
export function buildHowItWorksText(board, rules) {
  const multiplier = rules?.weekly_test_multiplier ?? 2;
  const presentPts = rules?.attendance_present_points ?? 10;
  const minEntries = rules?.improved_min_entries ?? 5;

  switch (board) {
    case 'points':
      return `Points = for each weekly test category, correct answers minus wrong answers (never below 0) times ${multiplier}, plus ${presentPts} points for each session you attended; excused sessions give nothing and cost nothing. Only your level is shown.`;
    case 'improved':
      return `Most improved = this week's accuracy minus last week's, needs at least ${minEntries} entries in each week. Only your level is shown.`;
    case 'practice_days':
      return `Practice days = days you entered scores. Only your level is shown.`;
    case 'todo':
      return `Students who completed the selected Daily To-Do task in this period, ranked from fastest to slowest attempt time. Pick Task 1, Task 2, Task 3, etc. above to filter by task.`;
    case 'streak':
      return `Streak = consecutive days you entered scores in Indian time. Only your level is shown.`;
    default:
      return `Only your level is shown.`;
  }
}

/**
 * Returns an encouraging empty state message for the given board and period.
 * @param {'points'|'streak'|'practice_days'|'todo'|'improved'} board
 * @param {'week'|'month'|'all'} period
 * @returns {string}
 */
export function getLeaderboardEmptyMessage(board, period = 'week') {
  if (board === 'todo') {
    return 'No student has recorded a timed attempt for this task in this period yet.';
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
