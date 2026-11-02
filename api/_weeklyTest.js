/**
 * Trendz Tracker — Pure Weekly Test Server Logic (api/_weeklyTest.js)
 *
 * Pure ES module (no DOM, no network, no database client) containing:
 * - `applyFlashTry(attempt, section, isCorrect, seconds)`: state transition for Flash Anzan multi-try sections
 * - `finalScore(kind, evaluation)`: converter from each section runner's evaluation to `{ correct, total, time_seconds, shouldSave }`
 * - `isWeeklyTestSession(session)`: guard verifying `session.settings.kind === 'weekly_test'`
 * - `getMemoriadTestFixedSettings(moduleKey)`: fixed competition defaults for Memoriad test sections
 * - `computeFlashMinSeconds(count, speedMs)` and `computeFlashExpirySeconds(count, speedMs)`
 */

/**
 * Returns true when a `drill_sessions` row belongs to an online Weekly Test section.
 *
 * @param {Record<string, any>|null|undefined} session
 * @returns {boolean}
 */
export function isWeeklyTestSession(session) {
  if (!session || typeof session !== 'object') return false;
  const settings = session.settings;
  if (!settings || typeof settings !== 'object') return false;
  return settings.kind === 'weekly_test';
}

/**
 * Computes the minimum allowed elapsed seconds for a Flash Anzan try:
 * `max(1, floor(count * speed_ms / 1000 * 0.8))`.
 *
 * @param {number} count
 * @param {number} speedMs
 * @returns {number}
 */
export function computeFlashMinSeconds(count, speedMs) {
  const c = Math.max(2, Number(count) || 2);
  const s = Math.max(200, Number(speedMs) || 1000);
  return Math.max(1, Math.floor(((c * s) / 1000) * 0.8));
}

/**
 * Computes the session expiration window in seconds for a Flash Anzan try:
 * `ceil(count * speed_ms / 1000) + 600` (expected flash duration + 10 minutes).
 *
 * @param {number} count
 * @param {number} speedMs
 * @returns {number}
 */
export function computeFlashExpirySeconds(count, speedMs) {
  const c = Math.max(2, Number(count) || 2);
  const s = Math.max(200, Number(speedMs) || 1000);
  return Math.ceil((c * s) / 1000) + 600;
}

/**
 * Returns the fixed competition settings for a Memoriad weekly test section:
 * - Calendar: 125 dates, 5 s concentration, timer shown
 * - Additions: typing direction right to left ('rtl'), highlight columns 1, 5 s concentration, timer shown
 * - Multiplications: typing direction right to left ('rtl'), stacked format, 5 s concentration, timer shown
 * - Square roots: 5 s concentration, timer shown
 *
 * @param {string} moduleKey
 * @returns {Record<string, any>}
 */
export function getMemoriadTestFixedSettings(moduleKey) {
  const key = String(moduleKey || '').trim().toLowerCase();
  if (key === 'calendar') {
    return {
      dates: 125,
      date_format: 'DD-MM-YYYY',
      day_style: 'upper3',
      leftmost_day: 0,
      key_zero_day: 5,
      highlight_active: true,
      concentration_seconds: 5,
      timer_shown: true,
    };
  }
  if (key === 'additions') {
    return {
      typing_direction: 'rtl',
      highlight_columns: 1,
      concentration_seconds: 5,
      timer_shown: true,
    };
  }
  if (key === 'multiplications') {
    return {
      typing_direction: 'rtl',
      question_format: 'stacked',
      concentration_seconds: 5,
      timer_shown: true,
    };
  }
  return {
    concentration_seconds: 5,
    timer_shown: true,
  };
}

/**
 * Pure state transition when a student submits one Flash Anzan try in a weekly test section.
 * Note: `tries_started` is already incremented when the try is started; if `attempt.tries_started`
 * is 0 or missing, it defaults to 1.
 *
 * @param {{ tries_started?: number, tries_correct?: number, seconds_used?: number, status?: string }} attempt
 * @param {{ question_count?: number } | number} section
 * @param {boolean} isCorrect
 * @param {number} seconds
 * @returns {{
 *   tries_started: number,
 *   tries_correct: number,
 *   seconds_used: number,
 *   status: 'started' | 'submitted',
 *   done: boolean,
 *   score_row: { correct: number, total: number, time_seconds: number }
 * }}
 */
export function applyFlashTry(attempt, section, isCorrect, seconds) {
  const rawQuestionCount =
    typeof section === 'number' ? section : Number(section?.question_count);
  const questionCount = Math.max(
    1,
    Number.isFinite(rawQuestionCount) && rawQuestionCount > 0
      ? Math.round(rawQuestionCount)
      : 1
  );

  const rawStarted = Number(attempt?.tries_started);
  const triesStarted = Math.min(
    questionCount,
    Math.max(1, Number.isFinite(rawStarted) && rawStarted > 0 ? Math.round(rawStarted) : 1)
  );

  const prevCorrect = Math.max(0, Math.round(Number(attempt?.tries_correct) || 0));
  const triesCorrect = Math.min(
    triesStarted,
    prevCorrect + (isCorrect === true ? 1 : 0)
  );

  const prevSeconds = Math.max(0, Math.round(Number(attempt?.seconds_used) || 0));
  const trySeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const secondsUsed = prevSeconds + trySeconds;

  const done = triesStarted >= questionCount;
  const status = done ? 'submitted' : 'started';

  return {
    tries_started: triesStarted,
    tries_correct: triesCorrect,
    seconds_used: secondsUsed,
    status,
    done,
    score_row: {
      correct: triesCorrect,
      total: questionCount,
      time_seconds: secondsUsed,
    },
  };
}

/**
 * Converts a section evaluation into the `weekly_test_scores` row values:
 * `{ correct, total, time_seconds, shouldSave }`.
 *
 * Rules:
 * - `basics`: `correct = evaluation.correct`, `total = evaluation.attempted`, `time_seconds = round(used_seconds)`.
 *   When `attempted === 0`, `shouldSave = false`.
 * - `elements`: `correct = evaluation.correct`, `total = evaluation.attempted`, `time_seconds = round(seconds)`.
 *   When `attempted === 0`, `shouldSave = false`.
 * - `memoriad`: `correct = evaluation.correct`, `total = evaluation.questions_total` (total questions in the module),
 *   `time_seconds = round(used_seconds)`. When `attempted === 0`, `shouldSave = false`.
 * - `flash`: `correct = tries_correct`, `total = question_count`, `time_seconds = seconds_used`, `shouldSave = true`.
 *
 * @param {'basics'|'elements'|'memoriad'|'flash'|string} kind
 * @param {Record<string, any>} evaluation
 * @returns {{ correct: number, total: number, time_seconds: number, shouldSave: boolean }}
 */
export function finalScore(kind, evaluation = {}) {
  const k = String(kind || 'basics').trim().toLowerCase();

  if (k === 'flash') {
    const total = Math.max(
      1,
      Math.round(Number(evaluation?.total ?? evaluation?.question_count) || 1)
    );
    const correct = Math.max(
      0,
      Math.min(total, Math.round(Number(evaluation?.correct ?? evaluation?.tries_correct) || 0))
    );
    const timeSeconds = Math.max(
      0,
      Math.round(Number(evaluation?.time_seconds ?? evaluation?.seconds_used ?? evaluation?.seconds) || 0)
    );
    return {
      correct,
      total,
      time_seconds: timeSeconds,
      shouldSave: true,
    };
  }

  if (k === 'memoriad') {
    const attempted = Math.max(0, Math.round(Number(evaluation?.attempted) || 0));
    const questionsTotal = Math.max(
      attempted,
      Math.round(Number(evaluation?.questions_total ?? evaluation?.total) || 10)
    );
    const correct = Math.max(
      0,
      Math.min(questionsTotal, Math.round(Number(evaluation?.correct) || 0))
    );
    const timeSeconds = Math.max(
      1,
      Math.round(Number(evaluation?.used_seconds ?? evaluation?.seconds ?? evaluation?.time_seconds) || 1)
    );
    return {
      correct,
      total: questionsTotal,
      time_seconds: timeSeconds,
      shouldSave: attempted > 0,
    };
  }

  // 'basics' and 'elements'
  const attempted = Math.max(0, Math.round(Number(evaluation?.attempted ?? evaluation?.total) || 0));
  const correct = Math.max(
    0,
    Math.min(attempted, Math.round(Number(evaluation?.correct) || 0))
  );
  const timeSeconds = Math.max(
    1,
    Math.round(Number(evaluation?.used_seconds ?? evaluation?.seconds ?? evaluation?.time_seconds) || 1)
  );
  return {
    correct,
    total: attempted,
    time_seconds: timeSeconds,
    shouldSave: attempted > 0,
  };
}
