/**
 * Live duel helpers for /api/drill (underscore file: not a Vercel function).
 *
 * The API only does what needs the question generator or the service role:
 * matchmaking (live_queue), ghost races (live_ghost), live challenges
 * (live_invite) and rematches (live_rematch). Answers, emotes, accepting a
 * challenge and settling go straight to SECURITY DEFINER RPCs in
 * supabase/migrations/30_live_duels.sql, which grade every answer themselves.
 *
 * Expected answers are written to live_duel_keys and never returned.
 */

import {
  createSeededRng,
  generateBasicsSet,
  parseBasicsCategoryName,
  stripBasicsExpected,
} from './_drills.js';
import { isUuid, newDuelSeed } from './_duels.js';
import {
  GHOST_WAIT_SECONDS,
  INVITE_SECONDS,
  LIVE_DUEL_COUNTDOWN_SECONDS,
  LIVE_DUEL_GRACE_SECONDS,
  LIVE_DUEL_POOL,
  LIVE_DUEL_SECONDS,
  LIVE_DUELS_PER_HOUR,
  QUEUE_STALE_SECONDS,
  RATING_START,
  botTimeline,
  ghostTimelineFromAnswers,
  pickLiveOpponent,
  sameLiveCentre,
  sameLiveLevel,
} from '../shared/liveDuel.js';

const GHOST_MIN_ATTEMPTED = 5;

/** Questions and expected answers for a duel, the same for both players. */
export function buildLiveDuelQuestions(categoryName, seed, pool = LIVE_DUEL_POOL) {
  const generated = generateBasicsSet(categoryName, pool, createSeededRng(Number(seed) >>> 0));
  return { questions: stripBasicsExpected(generated), expected: generated.map((q) => q.expected) };
}

/** Start and end of a race that begins after the countdown. */
export function liveDuelWindow(nowMs, seconds = LIVE_DUEL_SECONDS) {
  const start = nowMs + LIVE_DUEL_COUNTDOWN_SECONDS * 1000;
  return { start_at: new Date(start).toISOString(), end_at: new Date(start + seconds * 1000).toISOString() };
}

async function liveEnabled(db) {
  try {
    const { data, error } = await db.rpc('live_duel_enabled');
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}

async function centreOf(db, studentId) {
  try {
    const { data } = await db.rpc('live_duel_centre_of', { p_student: studentId });
    return data || null;
  } catch {
    return null;
  }
}

async function activeDuelFor(db, studentId, nowMs) {
  const cutoff = new Date(nowMs - LIVE_DUEL_GRACE_SECONDS * 1000).toISOString();
  const { data } = await db
    .from('live_duels')
    .select('id')
    .or(`a_id.eq.${studentId},b_id.eq.${studentId}`)
    .eq('status', 'live')
    .gt('end_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1);
  return Array.isArray(data) && data[0] ? data[0].id : null;
}

async function overHourlyLimit(db, studentId, nowMs) {
  const since = new Date(nowMs - 3600 * 1000).toISOString();
  const { count } = await db
    .from('live_duels')
    .select('id', { count: 'exact', head: true })
    .or(`a_id.eq.${studentId},b_id.eq.${studentId}`)
    .gte('created_at', since);
  return (count || 0) >= LIVE_DUELS_PER_HOUR;
}

async function ratingOf(db, studentId) {
  const { data } = await db.from('duel_ratings').select('rating').eq('student_id', studentId).maybeSingle();
  return Number(data?.rating) || RATING_START;
}

/** A basics category for the level: one of the most-played, else any online one. */
export async function pickLiveCategory(db, level, random = Math.random) {
  let options = [];
  try {
    const { data } = await db.rpc('daily_challenge_candidates', { p_level: level });
    options = (Array.isArray(data) ? data : [])
      .map((c) => ({ id: c.category_id, name: c.name }))
      .filter((c) => c.id && parseBasicsCategoryName(c.name))
      .slice(0, 5);
  } catch {
    options = [];
  }
  if (!options.length) {
    const { data } = await db.from('categories').select('id, name, active, section').eq('section', 'basics');
    options = (Array.isArray(data) ? data : []).filter((c) => c.active !== false && parseBasicsCategoryName(c.name));
  }
  if (!options.length) return null;
  return options[Math.floor(random() * options.length) % options.length];
}

/** Inserts a duel and its answer key. Returns the duel id or throws. */
export async function createLiveDuel(db, spec, nowMs = Date.now()) {
  const seed = spec.seed ?? newDuelSeed();
  const { questions, expected } = buildLiveDuelQuestions(spec.category.name, seed);
  const row = {
    ...(spec.id ? { id: spec.id } : {}),
    kind: spec.kind,
    status: spec.status || 'live',
    a_id: spec.aId,
    b_id: spec.bId ?? null,
    ghost: spec.ghost ?? null,
    level: spec.level ?? null,
    centre_id: spec.centreId ?? null,
    category_id: spec.category.id,
    category_name: spec.category.name,
    seed,
    seconds: LIVE_DUEL_SECONDS,
    questions,
    rematch_of: spec.rematchOf ?? null,
    ...(spec.status === 'invited'
      ? { invite_expires_at: new Date(nowMs + INVITE_SECONDS * 1000).toISOString() }
      : liveDuelWindow(nowMs)),
  };
  const { data, error } = await db.from('live_duels').insert(row).select('id').single();
  if (error || !data) throw new Error('Could not start the duel. Please try again.');
  const { error: keyErr } = await db.from('live_duel_keys').insert({ duel_id: data.id, expected });
  if (keyErr) {
    await db.from('live_duels').delete().eq('id', data.id);
    throw new Error('Could not start the duel. Please try again.');
  }
  return data.id;
}

/** Shared gate for starting anything live. Returns an error response payload or null. */
async function startGate(db, student, nowMs) {
  if (!(await liveEnabled(db))) return { status: 403, error: 'Live duels are switched off by your centre right now.' };
  if (!student.level) return { status: 400, error: 'Ask your teacher to set your level before playing live duels.' };
  const active = await activeDuelFor(db, student.id, nowMs);
  if (active) return { status: 200, payload: { duel_id: active } };
  if (await overHourlyLimit(db, student.id, nowMs)) {
    return { status: 429, error: `You have played ${LIVE_DUELS_PER_HOUR} live duels this hour. Take a short break!` };
  }
  return null;
}

function respond(res, gate) {
  if (gate.payload) return res.status(gate.status).json(gate.payload);
  return res.status(gate.status).json({ error: gate.error });
}

/** { action: 'live_queue' } — join or stay in the queue; pairs when someone fits. */
export async function handleLiveQueue({ student, adminSupabase: db, res, now = Date.now() }) {
  const gate = await startGate(db, student, now);
  if (gate) return respond(res, gate);

  const nowIso = new Date(now).toISOString();
  const [rating, centreId] = await Promise.all([ratingOf(db, student.id), centreOf(db, student.id)]);
  const { data: existing } = await db.from('live_duel_queue').select('joined_at').eq('student_id', student.id).maybeSingle();
  const me = {
    student_id: student.id,
    level: student.level,
    centre_id: centreId,
    rating,
    joined_at: existing?.joined_at || nowIso,
    seen_at: nowIso,
  };
  const { error: qErr } = await db.from('live_duel_queue').upsert(me, { onConflict: 'student_id' });
  if (qErr) return res.status(500).json({ error: 'Could not join the queue. Please try again.' });

  const staleIso = new Date(now - QUEUE_STALE_SECONDS * 1000).toISOString();
  const { data: waiting } = await db
    .from('live_duel_queue')
    .select('student_id, level, centre_id, rating, joined_at, seen_at')
    .neq('student_id', student.id)
    .gt('seen_at', staleIso)
    .limit(50);
  const other = pickLiveOpponent(me, waiting || [], now);
  if (other) {
    const { data: claimed } = await db.rpc('live_duel_claim_pair', { p_a: other.student_id, p_b: student.id });
    if (claimed === true) {
      const category = await pickLiveCategory(db, student.level);
      if (!category) return res.status(503).json({ error: 'No practice types are ready for duels yet.' });
      try {
        const duelId = await createLiveDuel(db, {
          kind: 'quick',
          aId: other.student_id,
          bId: student.id,
          level: student.level,
          centreId,
          category,
        }, now);
        return res.status(200).json({ duel_id: duelId });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  }
  const waited = Math.max(0, Math.round((now - new Date(me.joined_at).getTime()) / 1000));
  return res.status(200).json({ waiting: true, waited_seconds: waited, ghost_after: GHOST_WAIT_SECONDS });
}

/** A past run at the level by someone else, as { duel, student_id, timeline }, or null. */
export async function findGhostRun(db, student, centreId, random = Math.random) {
  let q = db
    .from('live_duels')
    .select('id, a_id, b_id, a_attempted, b_attempted, category_id, category_name, seed, centre_id')
    .eq('status', 'done')
    .eq('level', student.level)
    .neq('kind', 'ghost')
    .order('finished_at', { ascending: false })
    .limit(40);
  q = centreId ? q.eq('centre_id', centreId) : q.is('centre_id', null);
  const { data } = await q;
  const sides = [];
  for (const d of Array.isArray(data) ? data : []) {
    if (d.a_id && d.a_id !== student.id && d.a_attempted >= GHOST_MIN_ATTEMPTED) sides.push({ duel: d, student_id: d.a_id });
    if (d.b_id && d.b_id !== student.id && d.b_attempted >= GHOST_MIN_ATTEMPTED) sides.push({ duel: d, student_id: d.b_id });
  }
  if (!sides.length) return null;
  const pick = sides[Math.floor(random() * sides.length) % sides.length];
  const { data: answers } = await db
    .from('live_duel_answers')
    .select('q_index, correct, ms')
    .eq('duel_id', pick.duel.id)
    .eq('student_id', pick.student_id)
    .order('q_index', { ascending: true });
  const timeline = ghostTimelineFromAnswers(answers || []);
  if (timeline.length < GHOST_MIN_ATTEMPTED) return null;
  return { ...pick, timeline };
}

async function startGhostDuel(db, student, now, rematchOf = null) {
  const centreId = await centreOf(db, student.id);
  const run = await findGhostRun(db, student, centreId);
  let category;
  let seed;
  let ghost;
  if (run) {
    category = { id: run.duel.category_id, name: run.duel.category_name };
    seed = Number(run.duel.seed);
    ghost = { label: `Ghost runner (${student.level})`, level: student.level, bot: false, source_duel: run.duel.id, timeline: run.timeline };
  } else {
    category = await pickLiveCategory(db, student.level);
    if (!category) throw Object.assign(new Error('No practice types are ready for duels yet.'), { statusCode: 503 });
    seed = newDuelSeed();
    ghost = { label: 'Practice bot', level: student.level, bot: true, timeline: botTimeline(seed, student.level) };
  }
  return createLiveDuel(db, {
    kind: 'ghost',
    aId: student.id,
    bId: null,
    ghost,
    level: student.level,
    centreId,
    category,
    seed,
    rematchOf,
  }, now);
}

/** { action: 'live_ghost' } — nobody came: race a ghost (real past run) or a practice bot. */
export async function handleLiveGhost({ student, adminSupabase: db, res, now = Date.now() }) {
  const gate = await startGate(db, student, now);
  if (gate) return respond(res, gate);
  await db.from('live_duel_queue').delete().eq('student_id', student.id);
  try {
    const duelId = await startGhostDuel(db, student, now);
    return res.status(200).json({ duel_id: duelId });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
}

/** { action: 'live_invite', opponent_id } — challenge a classmate to race right now. */
export async function handleLiveInvite({ body, student, adminSupabase: db, res, now = Date.now() }) {
  const opponentId = String(body.opponent_id || '').trim();
  if (!isUuid(opponentId)) return res.status(400).json({ error: 'Choose a classmate to challenge.' });
  if (opponentId === student.id) return res.status(400).json({ error: 'You cannot duel yourself.' });
  const gate = await startGate(db, student, now);
  if (gate) return respond(res, gate);

  const { data: opponent } = await db
    .from('profiles')
    .select('id, role, active, level, leaderboard_visible')
    .eq('id', opponentId)
    .maybeSingle();
  if (!opponent || opponent.role !== 'student' || !opponent.active || opponent.leaderboard_visible === false) {
    return res.status(404).json({ error: 'That classmate is not available for duels.' });
  }
  if (!sameLiveLevel(opponent.level, student.level)) {
    return res.status(400).json({ error: 'You can only duel classmates at your level.' });
  }
  const [myCentre, theirCentre] = await Promise.all([centreOf(db, student.id), centreOf(db, opponent.id)]);
  if (!sameLiveCentre(myCentre, theirCentre)) {
    return res.status(400).json({ error: 'You can only duel classmates at your centre.' });
  }
  const { data: pending } = await db
    .from('live_duels')
    .select('id')
    .eq('status', 'invited')
    .eq('a_id', student.id)
    .gt('invite_expires_at', new Date(now).toISOString())
    .limit(1);
  if (Array.isArray(pending) && pending.length) {
    return res.status(409).json({ error: 'Wait for your last challenge to be answered first.' });
  }
  const category = await pickLiveCategory(db, student.level);
  if (!category) return res.status(503).json({ error: 'No practice types are ready for duels yet.' });
  try {
    const duelId = await createLiveDuel(db, {
      kind: 'challenge',
      status: 'invited',
      aId: student.id,
      bId: opponent.id,
      level: student.level,
      centreId: myCentre,
      category,
    }, now);
    return res.status(200).json({ duel_id: duelId, invited: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/** { action: 'live_rematch', duel_id } — both players ask: a new race, same pair, new questions. */
export async function handleLiveRematch({ body, student, adminSupabase: db, res, now = Date.now() }) {
  const duelId = String(body.duel_id || '').trim();
  if (!isUuid(duelId)) return res.status(400).json({ error: 'Duel not found.' });
  const { data: duel } = await db
    .from('live_duels')
    .select('id, kind, status, a_id, b_id, a_rematch, b_rematch, rematch_id, level, centre_id, category_id, category_name')
    .eq('id', duelId)
    .maybeSingle();
  const side = duel?.a_id === student.id ? 'a' : duel?.b_id === student.id ? 'b' : null;
  if (!side) return res.status(404).json({ error: 'Duel not found.' });
  if (duel.status !== 'done' && duel.status !== 'expired') {
    return res.status(409).json({ error: 'This duel has not finished yet.' });
  }
  if (duel.rematch_id) return res.status(200).json({ duel_id: duel.rematch_id });

  const gate = await startGate(db, student, now);
  if (gate) return respond(res, gate);

  if (!duel.b_id) {
    try {
      const newId = await startGhostDuel(db, student, now, duel.id);
      await db.from('live_duels').update({ rematch_id: newId, a_rematch: true }).eq('id', duel.id);
      return res.status(200).json({ duel_id: newId });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message });
    }
  }

  const { data: flagged } = await db
    .from('live_duels')
    .update({ [`${side}_rematch`]: true })
    .eq('id', duel.id)
    .select('a_rematch, b_rematch, rematch_id')
    .single();
  if (!flagged) return res.status(500).json({ error: 'Could not ask for a rematch.' });
  if (flagged.rematch_id) return res.status(200).json({ duel_id: flagged.rematch_id });
  if (!(flagged.a_rematch && flagged.b_rematch)) {
    await db.rpc('live_duel_send', {
      p_topic: `duel:${duel.id}`,
      p_event: 'rematch',
      p_payload: { side },
    });
    return res.status(200).json({ waiting: true });
  }

  // Both asked: whoever claims rematch_id first creates the new duel.
  const newId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : null;
  if (!newId) return res.status(500).json({ error: 'Could not start the rematch.' });
  const { data: claimed } = await db
    .from('live_duels')
    .update({ rematch_id: newId })
    .eq('id', duel.id)
    .is('rematch_id', null)
    .select('id');
  if (!claimed || !claimed.length) {
    const { data: again } = await db.from('live_duels').select('rematch_id').eq('id', duel.id).maybeSingle();
    return res.status(200).json({ duel_id: again?.rematch_id || null });
  }
  try {
    await createLiveDuel(db, {
      id: newId,
      kind: 'rematch',
      aId: duel.a_id,
      bId: duel.b_id,
      level: duel.level,
      centreId: duel.centre_id,
      category: { id: duel.category_id, name: duel.category_name },
      rematchOf: duel.id,
    }, now);
    return res.status(200).json({ duel_id: newId });
  } catch (err) {
    await db.from('live_duels').update({ rematch_id: null }).eq('id', duel.id);
    return res.status(500).json({ error: err.message });
  }
}
