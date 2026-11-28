/**
 * Server-side fair-play helper. Reusable by any API route that saves a practice result.
 *
 *   import { loadFairPlayThresholds, assessFairPlay, reviewAfterSave, checkRateLimit } from './_fairPlay.js';
 *
 *   // 1. Before saving: reject only the impossible.
 *   const rows = await loadFairPlayThresholds(adminSupabase);
 *   const verdict = assessFairPlay({ kind: 'element', key: drillKey, attempted, correct, usedSeconds, serverSeconds }, rows);
 *   if (verdict.verdict === 'reject') return res.status(400).json({ error: 'finished faster than possible, not saved' });
 *
 *   // 2. After saving (XP already awarded by the DB trigger): open a review if flagged.
 *   const review = await reviewAfterSave(adminSupabase, { studentId, sourceTable: 'activity_results', sourceId, verdict, label });
 *   // review = { under_review: true, message } or { under_review: false }
 *
 *   // Rate limit anything else (reward claims, custom submits):
 *   const rl = await checkRateLimit(adminSupabase, studentId, 'reward_claim');
 *   if (!rl.allowed) return res.status(429).json({ error: rl.message });
 *
 * A failure inside this helper never blocks saving a result: reviews are best effort and logged.
 */
import {
  DEFAULT_FAIR_PLAY_THRESHOLDS,
  FAIR_PLAY_RATE_LIMITS,
  UNDER_REVIEW_MESSAGE,
  assessAttempt,
} from '../shared/fairPlay.js';

const CACHE_MS = 60_000;
let cache = { at: 0, rows: null };

export function clearFairPlayCache() {
  cache = { at: 0, rows: null };
}

/** Threshold rows from fair_play_thresholds, cached for a minute; defaults if unreadable. */
export async function loadFairPlayThresholds(db, nowMs = Date.now()) {
  if (cache.rows && nowMs - cache.at < CACHE_MS) return cache.rows;
  try {
    const { data, error } = await db
      .from('fair_play_thresholds')
      .select('kind,key,level,reject_spq,flag_spq,max_correct,enabled');
    if (!error && Array.isArray(data) && data.length) {
      cache = { at: nowMs, rows: data };
      return data;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_FAIR_PLAY_THRESHOLDS;
}

export function assessFairPlay(attempt, rows) {
  return assessAttempt(attempt, rows || DEFAULT_FAIR_PLAY_THRESHOLDS);
}

const XP_SOURCE = { results: 'result', activity_results: 'activity' };

/** Previous best (pb_score) for the activity this XP row belongs to, before this result. */
async function previousBestFor(db, studentId, sourceTable, sourceId) {
  const { data: mine } = await db
    .from('student_xp_events')
    .select('activity_key,pb_score,created_at')
    .eq('source', XP_SOURCE[sourceTable])
    .eq('source_id', String(sourceId))
    .maybeSingle();
  if (!mine?.activity_key) return { previousBest: null, score: null };
  const { data: prev } = await db
    .from('student_xp_events')
    .select('pb_score')
    .eq('student_id', studentId)
    .eq('activity_key', mine.activity_key)
    .neq('source_id', String(sourceId))
    .lt('created_at', mine.created_at)
    .order('pb_score', { ascending: false })
    .limit(1);
  const best = prev && prev[0] ? Number(prev[0].pb_score) : null;
  return { previousBest: Number.isFinite(best) ? best : null, score: Number(mine.pb_score) };
}

/**
 * After the result row is saved: adds the big-jump check, and when anything is flagged opens a
 * review (the row is marked 'review'; XP stays until a teacher voids it).
 */
export async function reviewAfterSave(db, { studentId, sourceTable, sourceId, verdict, attempt, rows, label, detail }) {
  try {
    let v = verdict;
    if (attempt && v?.verdict !== 'reject') {
      const { previousBest, score } = await previousBestFor(db, studentId, sourceTable, sourceId);
      if (previousBest !== null && Number.isFinite(score)) {
        v = assessAttempt({ ...attempt, previousBest, score }, rows || DEFAULT_FAIR_PLAY_THRESHOLDS);
      }
    }
    if (!v || v.verdict !== 'flag') return { under_review: false };
    const { error } = await db.rpc('fair_play_open_review', {
      p_student: studentId,
      p_source_table: sourceTable,
      p_source_id: sourceId,
      p_kind: attempt?.kind ?? null,
      p_key: attempt?.key != null ? String(attempt.key) : null,
      p_label: label ?? null,
      p_reasons: v.reasons,
      p_detail: {
        attempted: attempt?.attempted ?? null,
        correct: attempt?.correct ?? null,
        used_seconds: attempt?.usedSeconds ?? null,
        server_seconds: attempt?.serverSeconds != null ? Math.round(attempt.serverSeconds * 10) / 10 : null,
        seconds_per_question: v.secondsPerQuestion,
        threshold: v.threshold?.source ?? null,
        ...(detail || {}),
      },
    });
    if (error) {
      console.warn('fair play: could not open review', error.message);
      return { under_review: false };
    }
    return { under_review: true, message: UNDER_REVIEW_MESSAGE };
  } catch (err) {
    console.warn('fair play: review skipped', err?.message || err);
    return { under_review: false };
  }
}

/** Counts and records one hit in fair_play_rate_hits. Allows on any database error. */
export async function checkRateLimit(db, studentId, bucket, overrides) {
  const cfg = (overrides && overrides[bucket]) || FAIR_PLAY_RATE_LIMITS[bucket];
  if (!cfg) return { allowed: true };
  try {
    const { data, error } = await db.rpc('fair_play_rate_hit', {
      p_student: studentId,
      p_bucket: bucket,
      p_limit: cfg.limit,
      p_window_seconds: cfg.windowSeconds,
    });
    if (error || data !== false) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: cfg.windowSeconds,
      message: 'You have sent a lot of rounds in a short time. Take a short break and try again.',
    };
  } catch {
    return { allowed: true };
  }
}
