/**
 * Pure presentation helpers for Weekly Test Leaderboards (Phase 16a).
 *
 * Intent:
 * - Format weekly test leaderboard titles, "correct of attempted" text, and row view-models.
 * - Strictly preserve database-computed ranks and points without ever calculating
 *   points or sorting/ranking in JavaScript.
 * - Zero DOM or network dependencies so it can be unit-tested with `node --test`.
 */

import { resolvePeriodTitleLabel, scopeLabel } from './leaderboardView.js';
import { formatSecondsToTime } from './stats.js';

export const WEEKLY_TEST_BOARD_EXPLANATION =
  'Points = correct answers minus wrong answers in each section (never below 0). Online tests appear after they close.';

export const ONLINE_TEST_NOT_CLOSED_MESSAGE =
  'The leaderboard of an online test appears after the test closes.';

/**
 * Formats correct and attempted counts into plain English ("38 of 40").
 * @param {number|string|null|undefined} correct
 * @param {number|string|null|undefined} attempted
 * @returns {string}
 */
export function scoreText(correct, attempted) {
  const c = Math.max(0, Math.round(Number(correct) || 0));
  const a = Math.max(0, Math.round(Number(attempted) || 0));
  return `${c} of ${a}`;
}

/**
 * Builds the heading title for a Weekly Test leaderboard view.
 *
 * Examples:
 * - Single test: "Sunday Test #4 - Level 2 (your level)"
 * - All tests in period: "Weekly tests - This month - Global (all trainees)"
 *
 * @param {object|string|null} test - Weekly test object `{ title }` or title string, or null for "All tests"
 * @param {string} period - Period key ('today'|'yesterday'|'week'|'month'|'year'|'all'|'date:YYYY-MM-DD')
 * @param {string} scope - 'level' | 'global'
 * @param {string|null} [level] - Student or filter level label
 * @param {string} [todayIST] - Optional YYYY-MM-DD override for deterministic tests
 * @returns {string}
 */
export function boardTitle(test, period = 'month', scope = 'level', level = null, todayIST = undefined) {
  const sLabel = scopeLabel(level, scope);
  const testTitle = typeof test === 'string'
    ? test.trim()
    : String(test?.title || '').trim();

  if (testTitle) {
    return `${testTitle} - ${sLabel}`;
  }

  const pLabel = resolvePeriodTitleLabel(period || 'month', todayIST);
  return `Weekly tests - ${pLabel} - ${sLabel}`;
}

/**
 * Maps raw rows returned by `weekly_test_leaderboard(p_test, p_period, p_level, p_limit, p_scope)`
 * into display-ready row view-models WITHOUT computing points or ranks.
 *
 * @param {Array<object>} rows
 * @param {{ scope?: string, isAdmin?: boolean }} [options]
 * @returns {Array<object>}
 */
export function mapWeeklyTestLeaderboardRows(rows, { scope = 'level', isAdmin = false } = {}) {
  if (!Array.isArray(rows)) return [];
  const showLevelChip = scope === 'global' || Boolean(isAdmin);

  return rows.map((row) => {
    const rank = Number(row.rank) || 0;
    const points = Number(row.points) || 0;
    const correct = Number(row.correct) || 0;
    const attempted = Number(row.attempted) || 0;
    const seconds = row.seconds !== null && row.seconds !== undefined ? Number(row.seconds) : null;
    const tests = Number(row.tests) || 0;
    const isMe = Boolean(row.is_me);

    return {
      rank,
      student_id: isAdmin && row.student_id ? String(row.student_id) : null,
      display_name: String(row.display_name || 'Student'),
      level: row.level ? String(row.level) : '',
      points,
      formatted_points: `${points.toLocaleString('en-IN')} ${points === 1 ? 'point' : 'points'}`,
      correct,
      attempted,
      formatted_score: scoreText(correct, attempted),
      seconds,
      formatted_time: seconds !== null && Number.isFinite(seconds) && seconds > 0
        ? formatSecondsToTime(seconds)
        : '—',
      tests,
      is_me: isMe,
      is_outside_top_10: rank > 10 && isMe,
      show_level_chip: showLevelChip
    };
  });
}
