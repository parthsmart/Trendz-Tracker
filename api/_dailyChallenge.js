/**
 * Daily challenge helpers for /api/drill (underscore file: not a Vercel function).
 *
 * Every level gets one basics category per day (India time), picked from the
 * categories that level has practised online recently. Everyone at the level gets
 * the same questions (seeded by day + level + category) and one attempt.
 */

import { parseBasicsCategoryName } from './_drills.js';

export const CHALLENGE_SECONDS = 60;

/** FNV-1a 32-bit hash of a string (stable across runtimes). */
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function challengeLevelKey(level) {
  return String(level ?? '').trim();
}

/** Seed for the shared question set. */
export function challengeSeed(day, level, categoryId) {
  return hashString(`challenge|${day}|${challengeLevelKey(level)}|${categoryId}`);
}

/**
 * Picks today's category from candidate rows ({ category_id, name, students }).
 * Prefers categories at least 2 students of the level have practised; ignores
 * categories that cannot be generated online. Deterministic for (day, level).
 */
export function pickDailyChallenge(candidates, day, level) {
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.category_id && c.name && parseBasicsCategoryName(c.name))
    .map((c) => ({ id: String(c.category_id), name: String(c.name), students: Number(c.students) || 0 }));
  if (!usable.length) return null;
  const popular = usable.filter((c) => c.students >= 2);
  const pool = (popular.length ? popular : usable).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const index = hashString(`${day}|${challengeLevelKey(level)}`) % pool.length;
  return pool[index];
}

async function todayIst(adminSupabase, fallback) {
  try {
    const { data, error } = await adminSupabase.rpc('today_ist');
    if (!error && data) return String(data).trim();
  } catch {
    // fall through
  }
  return fallback();
}

/** Resolves today's challenge for the student: { day, level, category } or { day, level, category: null }. */
export async function resolveTodaysChallenge(adminSupabase, student, fallbackToday) {
  const day = await todayIst(adminSupabase, fallbackToday);
  const level = student?.level ?? null;
  const { data, error } = await adminSupabase.rpc('daily_challenge_candidates', { p_level: level });
  if (error) {
    const err = new Error('Could not load today’s challenge. Please try again.');
    err.statusCode = 503;
    throw err;
  }
  return { day, level, category: pickDailyChallenge(data, day, level) };
}

export async function fetchChallengeAttempt(adminSupabase, studentId, day) {
  const { data } = await adminSupabase
    .from('daily_challenge_attempts')
    .select('id, day, category_id, category_name, seconds, correct, total, time_seconds, started_at, submitted_at')
    .eq('student_id', studentId)
    .eq('day', day)
    .maybeSingle();
  return data || null;
}

/** POST { action: 'challenge_info' } -> today's challenge and the caller's attempt. */
export async function handleChallengeInfo({ student, adminSupabase, res, fallbackToday }) {
  let info;
  try {
    info = await resolveTodaysChallenge(adminSupabase, student, fallbackToday);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const attempt = await fetchChallengeAttempt(adminSupabase, student.id, info.day);
  const cat = attempt
    ? { id: attempt.category_id, name: attempt.category_name }
    : info.category
      ? { id: info.category.id, name: info.category.name }
      : null;
  return res.status(200).json({
    day: info.day,
    available: Boolean(cat),
    category: cat,
    seconds: CHALLENGE_SECONDS,
    attempt: attempt
      ? {
          started_at: attempt.started_at,
          submitted_at: attempt.submitted_at,
          correct: attempt.correct,
          total: attempt.total,
          time_seconds: attempt.time_seconds,
        }
      : null,
  });
}

/** Records the result of a finished challenge session (best effort, never blocks the score). */
export async function recordChallengeResult(adminSupabase, session, student, scored) {
  const day = session?.settings?.challenge_day;
  if (!day) return;
  try {
    await adminSupabase
      .from('daily_challenge_attempts')
      .update({
        result_id: scored.result_id || null,
        correct: Number(scored.correct) || 0,
        total: Number(scored.total) || 0,
        time_seconds: Number.isFinite(Number(scored.time_seconds)) ? Number(scored.time_seconds) : null,
        submitted_at: new Date().toISOString(),
      })
      .eq('student_id', student.id)
      .eq('day', day)
      .eq('session_id', session.id)
      .is('submitted_at', null);
  } catch {
    // Non-fatal: the practice score is already saved.
  }
}
