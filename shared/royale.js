/**
 * Trendz Tracker - battle royale rules shared by the API, the page and the tests (shared/royale.js)
 *
 * Up to 20 students at one level, from any centre. A game starts as soon as 4 are
 * waiting (after a short fill-up countdown) or at the next scheduled slot (every
 * 30 minutes) with 2 or more. Everyone gets the same questions in rounds of 30
 * seconds. After each round the server ranks the players still in by correct
 * answers, then by who reached that score first, and the bottom quarter (at least
 * one, and everyone who did not answer) is out. The last one standing wins.
 *
 * The SQL in supabase/migrations/40_battle_royale.sql mirrors royaleOutCount,
 * the round ranking and royalePlaceXp.
 */

export const ROYALE_MAX_PLAYERS = 20;
/** A game starts early (after ROYALE_FILL_SECONDS) once this many are waiting. */
export const ROYALE_MIN_TO_START = 4;
/** At a scheduled slot the game runs with at least this many. */
export const ROYALE_MIN_PLAYERS = 2;
export const ROYALE_ROUND_SECONDS = 30;
/** Pause between rounds to show who went out. */
export const ROYALE_BREAK_SECONDS = 6;
/** Rounds prepared per game: 20 players need at most 10 with a quarter out each round. */
export const ROYALE_ROUNDS = 12;
export const ROYALE_POOL = 60;
export const ROYALE_SLOT_MINUTES = 30;
export const ROYALE_FILL_SECONDS = 20;

/** How many go out after a round: a quarter (at least 1, and every idle player), never the last one. */
export function royaleOutCount(alive, idle = 0) {
  const n = Math.max(0, Math.floor(Number(alive) || 0));
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(1, Math.floor(n * 0.25), Math.floor(Number(idle) || 0)));
}

/**
 * Round ranking, best first: more correct, then reached it sooner, then answered
 * at all (idle players last), then fewer attempts, then more correct over the whole game, then joined earlier.
 */
export function compareRoyaleRound(x, y) {
  return (Number(y.round_correct) || 0) - (Number(x.round_correct) || 0)
    || (x.round_last_ms ?? Infinity) - (y.round_last_ms ?? Infinity)
    || (Number(x.round_attempted) > 0 ? 0 : 1) - (Number(y.round_attempted) > 0 ? 0 : 1)
    || (Number(x.round_attempted) || 0) - (Number(y.round_attempted) || 0)
    || (Number(y.total_correct) || 0) - (Number(x.total_correct) || 0)
    || String(x.joined_at ?? '').localeCompare(String(y.joined_at ?? ''));
}

/** Players still in after a round, and those who went out with their places. */
export function settleRoyaleRound(alivePlayers) {
  const ranked = [...(alivePlayers || [])].sort(compareRoyaleRound);
  const idle = ranked.filter((p) => !(Number(p.round_attempted) > 0)).length;
  const out = royaleOutCount(ranked.length, idle);
  const keep = ranked.length - out;
  return {
    stay: ranked.slice(0, keep),
    out: ranked.slice(keep).map((p, i) => ({ ...p, place: keep + i + 1 })),
  };
}

/** Bonus XP by final place. */
export function royalePlaceXp(place, size) {
  const p = Number(place) || 0;
  if (p === 1) return 30;
  if (p === 2) return 20;
  if (p === 3) return 15;
  return p > 0 && p <= Math.ceil((Number(size) || 0) / 2) ? 10 : 5;
}

/** The next scheduled start (every 30 minutes, on the half hour). */
export function nextRoyaleSlot(nowMs = Date.now()) {
  const step = ROYALE_SLOT_MINUTES * 60 * 1000;
  return new Date(Math.ceil(nowMs / step) * step).toISOString();
}

/** "1st", "2nd", "3rd", "4th" ... */
export function ordinal(n) {
  const v = Math.abs(Math.floor(Number(n) || 0));
  const t = v % 100;
  if (t >= 11 && t <= 13) return `${v}th`;
  return `${v}${({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th'}`;
}
