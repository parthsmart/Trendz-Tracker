/**
 * Trendz Tracker - live duel tournaments: check-in (api/_tournaments.js)
 *
 * Brackets, seeding, deadlines and prizes run in the tournament_* RPCs
 * (supabase/migrations/*_live_duel_tournaments.sql). The only thing the API does is
 * check a student in; once both players are in, it creates the match's normal 60-second
 * live duel (kind 'tournament'), because the questions and answer key are built here.
 */

import { createLiveDuel, liveEnabled, pickLiveCategory, ratingOf, withDifficulty } from './_liveDuels.js';

const MESSAGES = {
  NOT_FOUND: [404, 'That match was not found.'],
  NOT_YOURS: [403, 'This is not your match.'],
  CLOSED: [409, 'This match is already decided.'],
  NOT_YET: [409, 'Check-in for this match has not opened yet.'],
  TOO_LATE: [409, 'Check-in for this match has closed.'],
};

/** { action: 'tournament_check_in', match_id } -> { duel_id } once the duel exists, else { checked_in: true }. */
export async function handleTournamentCheckIn({ body = {}, student, adminSupabase: db, res, now = Date.now() }) {
  const matchId = typeof body.match_id === 'string' ? body.match_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) return res.status(400).json({ error: 'Missing match.' });
  if (!(await liveEnabled(db))) return res.status(403).json({ error: 'Live duels are switched off by your centre right now.' });

  const { data: r, error } = await db.rpc('tournament_check_in', { p_match: matchId, p_student: student.id });
  if (error || !r) return res.status(500).json({ error: 'Could not check you in. Please try again.' });
  if (!r.ok) {
    const [status, message] = MESSAGES[r.code] || [400, 'Could not check you in.'];
    return res.status(status).json({ error: message, code: r.code });
  }
  if (r.duel_id) return res.status(200).json({ duel_id: r.duel_id });
  if (!r.start) return res.status(200).json({ checked_in: true, waiting: r.waiting !== false });

  const [ra, rb] = await Promise.all([ratingOf(db, r.a_id), ratingOf(db, r.b_id)]);
  const category = withDifficulty(await pickLiveCategory(db, r.level), ra, rb);
  if (!category) return res.status(503).json({ error: 'No practice types are ready for duels yet.' });
  let duelId;
  try {
    duelId = await createLiveDuel(db, {
      kind: 'tournament', aId: r.a_id, bId: r.b_id, level: r.level, centreId: r.centre_id || null, category,
    }, now);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const { data: attached } = await db.rpc('tournament_attach_duel', { p_match: matchId, p_duel: duelId });
  if (attached === false) {
    // Someone else started it first: keep theirs.
    await db.from('live_duels').delete().eq('id', duelId);
    const again = await db.rpc('tournament_check_in', { p_match: matchId, p_student: student.id });
    if (again.data?.duel_id) return res.status(200).json({ duel_id: again.data.duel_id });
    return res.status(409).json({ error: 'This match is already decided.' });
  }
  return res.status(200).json({ duel_id: duelId });
}
