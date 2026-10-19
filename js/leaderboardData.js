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
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';

/**
 * Calls RPC `leaderboard(p_board, p_period, p_level, p_limit)`
 * @param {Object} params
 * @param {'points'|'streak'|'practice_days'|'improved'} params.board
 * @param {'week'|'month'|'all'} params.period
 * @param {string|null} params.level
 * @param {number} params.limit
 * @param {Object|null} callerProfile
 * @returns {Promise<Array<{rank: number, student_id: string|null, display_name: string, value: number, is_me: boolean}>>}
 */
export async function fetchLeaderboard(
  { board = 'points', period = 'week', level = null, limit = 10 } = {},
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
        p_limit: limit
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
    p_limit: limit
  });

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
 * @param {'points'|'streak'|'practice_days'|'improved'} board
 * @param {number|string} value
 * @returns {string}
 */
export function formatLeaderboardValue(board, value) {
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
      return `${formattedNum} ${num === 1 ? 'day' : 'days'}`;
    case 'practice_days':
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
 * Builds the plain-English "How it works" explanation per board from `competition_rules()`.
 * Always includes the required note: "Only your level is shown."
 * @param {'points'|'streak'|'practice_days'|'improved'} board
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
    case 'streak':
      return `Streak = consecutive days you entered scores in Indian time. Only your level is shown.`;
    default:
      return `Only your level is shown.`;
  }
}

/**
 * Returns an encouraging empty state message for the given board and period.
 * @param {'points'|'streak'|'practice_days'|'improved'} board
 * @param {'week'|'month'|'all'} period
 * @returns {string}
 */
export function getLeaderboardEmptyMessage(board, period = 'week') {
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
