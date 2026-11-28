/**
 * Battle royale helper for /api/drill (underscore file: not a Vercel function).
 *
 * { action: 'royale_join' } puts the student in the waiting game at their level,
 * creating it (12 rounds of questions plus the answer key) when there is none.
 * Everything after that runs in SECURITY DEFINER RPCs from
 * supabase/migrations/46_battle_royale.sql: royale_state, royale_answer (graded
 * there), royale_leave and my_royale. Expected answers are written to royale_keys
 * and never returned.
 */

import { newDuelSeed } from './_duels.js';
import { buildLiveDuelQuestions, liveEnabled, pickLiveCategory, ratingOf, withDifficulty } from './_liveDuels.js';
import {
  ROYALE_FILL_SECONDS,
  ROYALE_MAX_PLAYERS,
  ROYALE_MIN_TO_START,
  ROYALE_POOL,
  ROYALE_ROUNDS,
  ROYALE_ROUND_SECONDS,
  nextRoyaleSlot,
} from '../shared/royale.js';

/** Seconds before a full lobby starts. */
export const ROYALE_FULL_START_SECONDS = 3;

/** Questions and answer keys for every round; round r uses seed + r. */
export function buildRoyaleRounds(categoryName, seed, rounds = ROYALE_ROUNDS, pool = ROYALE_POOL) {
  const questions = [];
  const expected = [];
  for (let r = 1; r <= rounds; r += 1) {
    const set = buildLiveDuelQuestions(categoryName, (Number(seed) + r) >>> 0, pool);
    questions.push(set.questions);
    expected.push(set.expected);
  }
  return { questions, expected };
}

/** The start time once `count` players are in: sooner when 4 are waiting, almost at once when full. */
export function royaleStartAt(currentIso, count, nowMs, max = ROYALE_MAX_PLAYERS) {
  const current = Date.parse(currentIso) || Infinity;
  let soon = Infinity;
  if (count >= max) soon = nowMs + ROYALE_FULL_START_SECONDS * 1000;
  else if (count >= ROYALE_MIN_TO_START) soon = nowMs + ROYALE_FILL_SECONDS * 1000;
  return new Date(Math.min(current, soon)).toISOString();
}

async function waitingGame(db, level) {
  const { data } = await db
    .from('royale_games')
    .select('id, start_at, max_players, status')
    .eq('level', level)
    .eq('status', 'waiting')
    .maybeSingle();
  return data || null;
}

async function activeGameFor(db, studentId) {
  // Places are set when a player goes out or the game ends, so no place = still playing or waiting.
  const { data } = await db
    .from('royale_players')
    .select('game_id')
    .eq('student_id', studentId)
    .is('place', null)
    .order('joined_at', { ascending: false })
    .limit(1);
  return Array.isArray(data) && data[0] ? data[0].game_id : null;
}

async function createRoyaleGame(db, student, nowMs) {
  const category = withDifficulty(await pickLiveCategory(db, student.level), await ratingOf(db, student.id));
  if (!category) throw Object.assign(new Error('No practice types are ready for battle royale yet.'), { statusCode: 503 });
  const seed = newDuelSeed();
  const { questions, expected } = buildRoyaleRounds(category.name, seed);
  const { data, error } = await db
    .from('royale_games')
    .insert({
      level: student.level,
      status: 'waiting',
      category_id: category.id,
      category_name: category.name,
      seed,
      round_seconds: ROYALE_ROUND_SECONDS,
      max_players: ROYALE_MAX_PLAYERS,
      rounds: questions,
      start_at: nextRoyaleSlot(nowMs + ROYALE_FILL_SECONDS * 1000),
    })
    .select('id, start_at, max_players, status')
    .single();
  // Someone else created the level's waiting game a moment ago (one waiting game per level).
  if (error || !data) return waitingGame(db, student.level);
  const { error: keyErr } = await db.from('royale_keys').insert({ game_id: data.id, expected });
  if (keyErr) {
    await db.from('royale_games').delete().eq('id', data.id);
    throw new Error('Could not open a battle royale. Please try again.');
  }
  return data;
}

/** { action: 'royale_join' } */
export async function handleRoyaleJoin({ student, adminSupabase: db, res, now = Date.now() }) {
  if (!(await liveEnabled(db))) return res.status(403).json({ error: 'Live duels are switched off by your centre right now.' });
  if (!student.level) return res.status(400).json({ error: 'Ask your teacher to set your level before playing battle royale.' });

  const active = await activeGameFor(db, student.id);
  if (active) return res.status(200).json({ game_id: active });

  try {
    let game = await waitingGame(db, student.level);
    if (game && Date.parse(game.start_at) <= now) {
      // Past its start: let the server start it (or move it to the next slot) first.
      await db.rpc('royale_tick', { p_game: game.id });
      game = await waitingGame(db, student.level);
    }
    if (!game) game = await createRoyaleGame(db, student, now);
    if (!game) return res.status(409).json({ error: 'Could not open a battle royale. Please try again.' });

    const max = Number(game.max_players) || ROYALE_MAX_PLAYERS;
    const { count } = await db.from('royale_players').select('student_id', { count: 'exact', head: true }).eq('game_id', game.id);
    if ((count || 0) >= max) return res.status(409).json({ error: 'This battle royale is full. The next one opens in a moment.' });

    const { error } = await db.from('royale_players').insert({ game_id: game.id, student_id: student.id });
    if (error) return res.status(409).json({ error: 'Could not join the battle royale. Please try again.' });

    const startAt = royaleStartAt(game.start_at, (count || 0) + 1, now, max);
    if (startAt !== game.start_at) {
      await db.from('royale_games').update({ start_at: startAt }).eq('id', game.id).eq('status', 'waiting');
    }
    return res.status(200).json({ game_id: game.id, start_at: startAt });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message || 'Could not join the battle royale.' });
  }
}
