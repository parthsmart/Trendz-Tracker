/**
 * Fair-play guardrails: one shared, pure checker for every practice result.
 *
 * Learning first. A result is only REJECTED when it is physically impossible (the long-standing
 * floors: 0.25 s a question for drills, the Memoriad per-module floors). Anything that is merely
 * unusually fast, or whose browser time disagrees badly with the server clock, is SAVED and
 * FLAGGED for a teacher to approve or void. Honest fast students are never dropped silently.
 *
 * Thresholds are rows of `fair_play_thresholds` (kind, key, level). The defaults below are the
 * same rows the migration seeds, so the checker still works if the table cannot be read.
 * Defaults were set from production timings (counts only) and the Memoriad rules:
 *   - Basics 60 s fastest real run 0.60 s a question  -> flag under 0.50 s
 *   - Elements fastest real run 0.96 s a question      -> flag under 0.60 s
 *   - Memoriad official limits (5d x 5d 10 tasks in 5 min, 10 x 10-digit additions in 10 min,
 *     roots 15/18/22 min, 10d / 5d 6 min); flags sit far below anything seen in production.
 *   - Browser vs server clock: honest gap reached 37 s at most -> flag over 45 s and 20 %.
 *
 * Usage (server side): assessAttempt({ kind, key, level, attempted, correct, usedSeconds,
 * serverSeconds, timeLimitSeconds, previousBest }, thresholdRows) -> { verdict, reasons, ... }.
 * See api/_fairPlay.js for loading thresholds, opening reviews and rate limits.
 */

export const FAIR_PLAY_KINDS = Object.freeze([
  'basics',
  'element',
  'memoriad',
  'flash',
  'typed_round',
  'typed_basics',
  'duel',
]);

/** Rows: { kind, key, level, reject_spq, flag_spq, max_correct } ('*' = any). */
export const DEFAULT_FAIR_PLAY_THRESHOLDS = Object.freeze([
  { kind: 'basics', key: '*', level: '*', reject_spq: 0.25, flag_spq: 0.5, max_correct: null },
  { kind: 'element', key: '*', level: '*', reject_spq: 0.25, flag_spq: 0.6, max_correct: null },
  { kind: 'duel', key: '*', level: '*', reject_spq: 0.25, flag_spq: 0.5, max_correct: null },
  { kind: 'flash', key: '*', level: '*', reject_spq: null, flag_spq: null, max_correct: null },
  // Typed scores come from paper rounds; no reject, a teacher verifies them anyway.
  { kind: 'typed_round', key: '*', level: '*', reject_spq: null, flag_spq: 0.3, max_correct: 200 },
  { kind: 'typed_basics', key: '*', level: '*', reject_spq: null, flag_spq: 0.4, max_correct: 150 },
  // Memoriad: reject floors are the existing api/_memoriad.js PLAUSIBILITY_MIN_SECONDS_PER_ATTEMPT.
  { kind: 'memoriad', key: 'calendar', level: '*', reject_spq: 0.25, flag_spq: 0.75, max_correct: null },
  { kind: 'memoriad', key: 'additions', level: '*', reject_spq: 3, flag_spq: 10, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '*', reject_spq: 5, flag_spq: 10, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '3', reject_spq: 2, flag_spq: 4, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '4', reject_spq: 3, flag_spq: 6, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '6', reject_spq: 5, flag_spq: 14, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '7', reject_spq: 5, flag_spq: 20, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '8', reject_spq: 5, flag_spq: 25, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '9', reject_spq: 5, flag_spq: 32, max_correct: null },
  { kind: 'memoriad', key: 'multiplications', level: '10', reject_spq: 5, flag_spq: 40, max_correct: null },
  { kind: 'memoriad', key: 'square_roots', level: '*', reject_spq: 5, flag_spq: 15, max_correct: null },
  { kind: 'memoriad', key: 'square_roots', level: '8', reject_spq: 5, flag_spq: 20, max_correct: null },
  { kind: 'memoriad', key: 'square_roots', level: '10', reject_spq: 5, flag_spq: 25, max_correct: null },
  { kind: 'memoriad', key: 'division', level: '*', reject_spq: 3, flag_spq: 8, max_correct: null },
  { kind: 'memoriad', key: 'division', level: '10', reject_spq: 3, flag_spq: 15, max_correct: null },
]);

/** Browser time this far below the server clock (beyond prep) is flagged. */
export const TIME_MISMATCH_MIN_SECONDS = 45;
export const TIME_MISMATCH_MIN_FRACTION = 0.2;
/** A new best this much above the previous best (with enough history) is flagged. */
export const BIG_JUMP_FACTOR = 1.5;
export const BIG_JUMP_MIN_PREVIOUS = 10;

/** Student-facing wording. Never an accusation. */
export const UNDER_REVIEW_MESSAGE =
  'Great speed! Your score is saved and a teacher will give it a quick check before it shows on the record boards.';

export const REASON_LABELS = Object.freeze({
  too_fast: 'Faster per question than the flag threshold',
  time_mismatch: 'Browser time much shorter than the server clock',
  over_max: 'More correct answers than the threshold for this round',
  big_jump: 'Much higher than this student’s previous best',
});

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Finds the threshold row for (kind, key, level). Most specific wins:
 * kind+key+level, kind+key+*, kind+*+level, kind+*+*. Table rows override defaults.
 */
export function resolveThreshold(kind, key, level, rows = DEFAULT_FAIR_PLAY_THRESHOLDS) {
  const k = String(key ?? '*');
  const l = String(level ?? '*');
  const pick = (list) => {
    const forKind = (list || []).filter((r) => r && r.kind === kind && r.enabled !== false);
    const tries = [
      [k, l],
      [k, '*'],
      ['*', l],
      ['*', '*'],
    ];
    for (const [tk, tl] of tries) {
      const hit = forKind.find((r) => String(r.key ?? '*') === tk && String(r.level ?? '*') === tl);
      if (hit) return hit;
    }
    return null;
  };
  const row = pick(rows) || (rows === DEFAULT_FAIR_PLAY_THRESHOLDS ? null : pick(DEFAULT_FAIR_PLAY_THRESHOLDS));
  if (!row) return { reject_spq: null, flag_spq: null, max_correct: null, source: 'none' };
  return {
    reject_spq: numOrNull(row.reject_spq),
    flag_spq: numOrNull(row.flag_spq),
    max_correct: numOrNull(row.max_correct),
    source: `${row.kind}:${row.key ?? '*'}:${row.level ?? '*'}`,
  };
}

/**
 * Assesses one finished attempt.
 * @param {object} a
 * @param {string} a.kind          one of FAIR_PLAY_KINDS
 * @param {string} [a.key]         drill key / Memoriad module / category name
 * @param {string|number} [a.level] digits level (Memoriad) or '*'
 * @param {number} a.attempted     answers given
 * @param {number} a.correct       answers right
 * @param {number} a.usedSeconds   time the result records
 * @param {number} [a.serverSeconds] server clock from start to submit, minus prep / concentration
 * @param {number} [a.previousBest] previous best score for the same activity (same unit as score)
 * @param {number} [a.score]       score compared with previousBest (defaults to correct)
 * @param {Array}  [rows]          fair_play_thresholds rows
 * @returns {{ verdict: 'ok'|'flag'|'reject', reasons: string[], secondsPerQuestion: number|null,
 *            threshold: object, minSeconds: number|null }}
 */
export function assessAttempt(a, rows) {
  const attempted = Math.max(0, Number(a?.attempted) || 0);
  const correct = Math.max(0, Number(a?.correct) || 0);
  const used = numOrNull(a?.usedSeconds);
  const threshold = resolveThreshold(a?.kind, a?.key, a?.level, rows);
  const reasons = [];
  const spq = attempted > 0 && used !== null ? used / attempted : null;

  if (attempted <= 0) {
    return { verdict: 'ok', reasons, secondsPerQuestion: null, threshold, minSeconds: null };
  }

  const minSeconds = threshold.reject_spq !== null ? Number((attempted * threshold.reject_spq).toFixed(2)) : null;
  if (minSeconds !== null && (used === null || used < minSeconds)) {
    return { verdict: 'reject', reasons: ['impossible_time'], secondsPerQuestion: spq, threshold, minSeconds };
  }

  // Only correct answers make a fast run suspicious: fast wrong answers earn nothing.
  if (threshold.flag_spq !== null && spq !== null && correct > 0) {
    const correctSpq = used / Math.max(1, correct);
    if (correctSpq < threshold.flag_spq) reasons.push('too_fast');
  }

  if (threshold.max_correct !== null && correct > threshold.max_correct) reasons.push('over_max');

  const server = numOrNull(a?.serverSeconds);
  if (server !== null && used !== null) {
    const gap = server - used;
    if (gap > TIME_MISMATCH_MIN_SECONDS && gap > server * TIME_MISMATCH_MIN_FRACTION) {
      reasons.push('time_mismatch');
    }
  }

  const prev = numOrNull(a?.previousBest);
  const score = numOrNull(a?.score) ?? correct;
  if (prev !== null && prev >= BIG_JUMP_MIN_PREVIOUS && score > prev * BIG_JUMP_FACTOR) {
    reasons.push('big_jump');
  }

  return {
    verdict: reasons.length ? 'flag' : 'ok',
    reasons,
    secondsPerQuestion: spq === null ? null : Number(spq.toFixed(3)),
    threshold,
    minSeconds,
  };
}

/** Rate-limit buckets: limit within windowSeconds. Kept well above real peaks (29 per 10 min). */
export const FAIR_PLAY_RATE_LIMITS = Object.freeze({
  practice_start: { limit: 60, windowSeconds: 600 },
  practice_submit: { limit: 60, windowSeconds: 600 },
  typed_result: { limit: 300, windowSeconds: 3600 },
  reward_claim: { limit: 10, windowSeconds: 86400 },
  duel_create: { limit: 20, windowSeconds: 3600 },
});

/** Pure decision used by the API and tests: hits already in window -> allowed? */
export function rateLimitDecision(bucket, hitsInWindow, overrides) {
  const cfg = (overrides && overrides[bucket]) || FAIR_PLAY_RATE_LIMITS[bucket];
  if (!cfg) return { allowed: true, limit: null, retryAfterSeconds: 0 };
  const hits = Math.max(0, Number(hitsInWindow) || 0);
  return {
    allowed: hits < cfg.limit,
    limit: cfg.limit,
    retryAfterSeconds: hits < cfg.limit ? 0 : cfg.windowSeconds,
  };
}

/** Student-safe view of a review status. */
export function studentReviewLabel(status) {
  if (status === 'review') return 'Under review';
  if (status === 'voided') return 'Not counted';
  return '';
}
