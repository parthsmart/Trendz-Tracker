/**
 * Duel helpers for /api/drill (underscore file: not a Vercel function).
 *
 * A duel is two classmates in the same centre and at the same level playing the same seeded 1-minute
 * basics round, each in their own time. More correct answers wins; equal correct
 * answers are decided by the faster time; equal both is a draw. Winners are
 * decided by the database (duel_record_result), never by the browser.
 */

import { parseBasicsCategoryName } from './_drills.js';
import { isBlockedPair } from './_socialBlocks.js';

export const DUEL_SECONDS = 60;
export const DUELS_PER_DAY = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return UUID_RE.test(String(value ?? ''));
}

/** Which side of the duel the student is on: 'c' (challenger), 'o' (opponent) or null. */
export function duelSide(duel, studentId) {
  if (!duel || !studentId) return null;
  if (duel.challenger_id === studentId) return 'c';
  if (duel.opponent_id === studentId) return 'o';
  return null;
}

/** A random 32-bit seed for the shared question set. */
export function newDuelSeed(random = Math.random) {
  return Math.floor(random() * 0x100000000) >>> 0;
}

function sameLevel(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** Async duels stay inside one centre: both students must have the same centre. */
export function sameCentre(a, b) {
  return Boolean(a?.centre_id) && a.centre_id === b?.centre_id;
}

function fail(statusCode, error, code) {
  return { ok: false, statusCode, error, code };
}

/** { action: 'duel_create', opponent_id, category_id } */
export async function handleDuelCreate({ body, student, adminSupabase, res }) {
  const opponentId = String(body.opponent_id || '').trim();
  const categoryId = String(body.category_id || '').trim();
  if (!isUuid(opponentId) || !isUuid(categoryId)) {
    return res.status(400).json({ error: 'Choose a classmate and a practice type.' });
  }
  if (opponentId === student.id) {
    return res.status(400).json({ error: 'You cannot duel yourself.' });
  }

  const { data: pair } = await adminSupabase
    .from('profiles')
    .select('id, role, active, level, leaderboard_visible, centre_id')
    .in('id', [student.id, opponentId]);
  const rows = Array.isArray(pair) ? pair : [];
  const opponent = rows.find((row) => row.id === opponentId);
  const me = rows.find((row) => row.id === student.id);
  if (!opponent || opponent.role !== 'student' || !opponent.active || opponent.leaderboard_visible === false
      || await isBlockedPair(adminSupabase, student.id, opponent.id)) {
    return res.status(404).json({ error: 'That classmate is not available for duels.' });
  }
  if (!sameCentre(me, opponent)) {
    return res.status(404).json({ error: 'That classmate is not available for duels.' });
  }
  if (!sameLevel(opponent.level, student.level)) {
    return res.status(400).json({ error: 'You can only duel classmates at your level.' });
  }

  const { data: category } = await adminSupabase
    .from('categories')
    .select('id, name, section, active')
    .eq('id', categoryId)
    .maybeSingle();
  if (!category || category.section !== 'basics' || category.active === false || !parseBasicsCategoryName(category.name)) {
    return res.status(400).json({ error: 'This practice type cannot be used for a duel.' });
  }

  let today = null;
  try {
    const { data } = await adminSupabase.rpc('today_ist');
    today = data ? String(data).trim() : null;
  } catch {
    today = null;
  }
  if (today) {
    const { count } = await adminSupabase
      .from('duels')
      .select('id', { count: 'exact', head: true })
      .eq('challenger_id', student.id)
      .eq('created_day', today);
    if ((count || 0) >= DUELS_PER_DAY) {
      return res.status(429).json({ error: `You can send ${DUELS_PER_DAY} duels a day. Try again tomorrow!` });
    }
  }

  const { data: duel, error } = await adminSupabase
    .from('duels')
    .insert({
      challenger_id: student.id,
      opponent_id: opponent.id,
      level: student.level ?? null,
      category_id: category.id,
      category_name: category.name,
      seed: newDuelSeed(),
      seconds: DUEL_SECONDS,
    })
    .select('id')
    .single();
  if (error || !duel) {
    if (error && String(error.code) === '23505') {
      return res.status(409).json({ error: 'You already have a duel open with this classmate.' });
    }
    return res.status(500).json({ error: 'Could not create the duel. Please try again.' });
  }
  return res.status(200).json({ duel_id: duel.id });
}

/** { action: 'duel_cancel', duel_id } — the challenger cancels, the opponent declines. Only before anyone plays. */
export async function handleDuelCancel({ body, student, adminSupabase, res }) {
  const duelId = String(body.duel_id || '').trim();
  if (!isUuid(duelId)) return res.status(400).json({ error: 'Duel not found.' });
  const { data: duel } = await adminSupabase
    .from('duels')
    .select('id, challenger_id, opponent_id, status, c_started_at, o_started_at')
    .eq('id', duelId)
    .maybeSingle();
  const side = duelSide(duel, student.id);
  if (!side) return res.status(404).json({ error: 'Duel not found.' });
  if (duel.status !== 'open' || duel.c_started_at || duel.o_started_at) {
    return res.status(409).json({ error: 'This duel has already started and cannot be cancelled.' });
  }
  const status = side === 'c' ? 'cancelled' : 'declined';
  const { data: updated } = await adminSupabase
    .from('duels')
    .update({ status, finished_at: new Date().toISOString() })
    .eq('id', duelId)
    .eq('status', 'open')
    .is('c_started_at', null)
    .is('o_started_at', null)
    .select('id');
  if (!updated || !updated.length) {
    return res.status(409).json({ error: 'This duel has already started and cannot be cancelled.' });
  }
  return res.status(200).json({ status });
}

/**
 * Claims the student's one play of a duel before the session is created.
 * Returns { ok, duel, side, release } where release() undoes the claim if the
 * session could not be created.
 */
export async function claimDuelStart(adminSupabase, student, duelIdRaw) {
  const duelId = String(duelIdRaw || '').trim();
  if (!isUuid(duelId)) return fail(400, 'Duel not found.');
  const { data: duel } = await adminSupabase
    .from('duels')
    .select('id, challenger_id, opponent_id, category_id, category_name, seed, seconds, status, expires_at, c_started_at, o_started_at')
    .eq('id', duelId)
    .maybeSingle();
  const side = duelSide(duel, student.id);
  if (!side) return fail(404, 'Duel not found.');
  if (duel.status !== 'open' || new Date(duel.expires_at).getTime() <= Date.now()) {
    return fail(409, 'This duel is over.', 'DUEL_CLOSED');
  }
  if (duel[`${side}_started_at`]) {
    return fail(409, 'You have already played this duel.', 'DUEL_ALREADY_PLAYED');
  }
  const startedCol = `${side}_started_at`;
  const { data: claimed } = await adminSupabase
    .from('duels')
    .update({ [startedCol]: new Date().toISOString() })
    .eq('id', duel.id)
    .eq('status', 'open')
    .is(startedCol, null)
    .select('id');
  if (!claimed || !claimed.length) {
    return fail(409, 'You have already played this duel.', 'DUEL_ALREADY_PLAYED');
  }
  return {
    ok: true,
    duel,
    side,
    async bindSession(sessionId) {
      await adminSupabase.from('duels').update({ [`${side}_session_id`]: sessionId }).eq('id', duel.id);
    },
    async release() {
      await adminSupabase.from('duels').update({ [startedCol]: null }).eq('id', duel.id);
    },
  };
}

/** Records a finished duel round. Returns { status, result } for the round screen, or null. */
export async function recordDuelResult(adminSupabase, session, student, scored) {
  const duelId = session?.settings?.duel_id;
  if (!duelId) return null;
  try {
    const { data, error } = await adminSupabase.rpc('duel_record_result', {
      p_duel: duelId,
      p_student: student.id,
      p_session: session.id,
      p_correct: Number(scored.correct) || 0,
      p_total: Number(scored.total) || 0,
      p_time: Number.isFinite(Number(scored.time_seconds)) ? Number(scored.time_seconds) : null,
    });
    if (error || !data || !data.recorded) return null;
    const result = data.status !== 'done' ? 'waiting' : !data.winner_id ? 'draw' : data.winner_id === student.id ? 'won' : 'lost';
    return { duel_id: duelId, status: data.status, result };
  } catch {
    return null; // Non-fatal: the practice score is already saved.
  }
}
