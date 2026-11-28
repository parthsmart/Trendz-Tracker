/**
 * Trendz Tracker - live duel tournaments: the shared rules (shared/tournament.js)
 *
 * Single elimination, seeded by duel rating. Every match is a normal 60-second live duel.
 * The SQL in supabase/migrations/*_live_duel_tournaments.sql mirrors these rules and a
 * test checks that the two agree.
 */

export const TOURNAMENT_SIZES = Object.freeze([8, 16, 32]);
/** Fewer sign-ups than this at the start time and the tournament is cancelled. */
export const TOURNAMENT_MIN_PLAYERS = 4;
/** Seconds both players have to check in once their match is ready. */
export const TOURNAMENT_CHECKIN_SECONDS = 180;
export const TOURNAMENT_ROUND_MINUTES = 10;
export const TOURNAMENT_ROUND_MINUTES_RANGE = Object.freeze([5, 60]);
/** Store balance ("XP to spend") for the top finishers. Not XP: leaderboards are unchanged. */
export const TOURNAMENT_PRIZES = Object.freeze({ champion: 500, finalist: 250, semi: 100 });
export const TOURNAMENT_BADGES = Object.freeze({
  champion: { key: 'tourney_champion', name: 'Tournament champion', icon: '🏆' },
  finalist: { key: 'tourney_finalist', name: 'Tournament finalist', icon: '🥈' },
  semi: { key: 'tourney_semi', name: 'Tournament semi-finalist', icon: '🥉' },
});

/** The smallest bracket (4, 8, 16, 32) that holds everyone, never above the cap. */
export function bracketSize(count, cap = 32) {
  let size = 4;
  while (size < count && size < cap) size *= 2;
  return size;
}

export function roundCount(size) {
  let rounds = 0;
  for (let n = size; n > 1; n /= 2) rounds += 1;
  return rounds;
}

/**
 * Standard bracket order: seed 1 and seed 2 can only meet in the final.
 * seedOrder(8) -> [1, 8, 4, 5, 2, 7, 3, 6]; pairs are (1 v 8), (4 v 5), (2 v 7), (3 v 6).
 */
export function seedOrder(size) {
  if (size < 2) return [1];
  let order = [1, 2];
  while (order.length < size) {
    const len = order.length * 2;
    order = order.flatMap((s) => [s, len + 1 - s]);
  }
  return order;
}

/** Seeds 1..n by rating (high first), then who signed up first. */
export function seedPlayers(entries) {
  return [...entries]
    .sort((a, b) => (Number(b.rating) || 1000) - (Number(a.rating) || 1000)
      || String(a.joined_at).localeCompare(String(b.joined_at))
      || String(a.id).localeCompare(String(b.id)))
    .map((e, i) => ({ ...e, seed: i + 1 }));
}

/** Round 1 pairs as [aSeed, bSeed]; a seed above the entry count is a bye (null). */
export function firstRoundPairs(count, size = bracketSize(count)) {
  const order = seedOrder(size);
  const pairs = [];
  for (let i = 0; i < order.length; i += 2) {
    const a = order[i] <= count ? order[i] : null;
    const b = order[i + 1] <= count ? order[i + 1] : null;
    pairs.push([a, b]);
  }
  return pairs;
}

/** Where a winner goes next: round r+1, slot floor(slot/2), side a for even slots. */
export function nextSlot(round, slot) {
  return { round: round + 1, slot: Math.floor(slot / 2), side: slot % 2 === 0 ? 'a' : 'b' };
}

/**
 * A ready match whose check-in time ran out. Checked in beats not checked in;
 * if neither came, the higher seed (lower number) goes through.
 */
export function timeoutWinner({ aIn, bIn, aSeed, bSeed }) {
  if (aIn && !bIn) return { side: 'a', how: 'forfeit' };
  if (bIn && !aIn) return { side: 'b', how: 'forfeit' };
  return { side: (Number(aSeed) || 99) <= (Number(bSeed) || 99) ? 'a' : 'b', how: aIn && bIn ? 'seed' : 'no_show' };
}

export function roundName(round, rounds) {
  const left = rounds - round;
  if (left === 0) return 'Final';
  if (left === 1) return 'Semi-finals';
  if (left === 2) return 'Quarter-finals';
  return `Round of ${2 ** (left + 1)}`;
}
