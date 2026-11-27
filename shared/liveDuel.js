/**
 * Trendz Tracker: live duel rules (shared/liveDuel.js)
 *
 * A live duel is two students racing the same seeded 60-second basics round at
 * the same moment, each seeing the other's progress as it happens. When nobody
 * is free, the student races a "ghost": a replay of a real past run at the same
 * level (or a practice bot when there is no past run yet).
 *
 * This file holds the pure rules shared by the API (api/_liveDuels.js), the
 * page (js/liveDuel.js) and the tests. The database (supabase/migrations/
 * 31_live_duels.sql) applies the same rules when it grades answers and settles
 * a duel; tests/liveDuel.test.js checks the two agree.
 */

import { STUDENT_LEVELS, normalizeLevel } from './levels.js';

export const LIVE_DUEL_SECONDS = 60;
export const LIVE_DUEL_COUNTDOWN_SECONDS = 5;
export const LIVE_DUEL_GRACE_SECONDS = 2;
export const LIVE_DUEL_MIN_MS_PER_ANSWER = 250;
export const LIVE_DUEL_MAX_ANSWER_LENGTH = 20;
export const LIVE_DUEL_POOL = 100;
export const GHOST_WAIT_SECONDS = 10;
export const QUEUE_STALE_SECONDS = 8;
export const INVITE_SECONDS = 60;
export const LIVE_DUELS_PER_HOUR = 30;
export const BONUS_DUELS_PER_DAY = 10;
export const DUEL_BONUS_XP = Object.freeze({ won: 15, draw: 8, lost: 5 });
export const RATING_START = 1000;
export const RATING_K = 24;
export const RATING_FLOOR = 100;
/** Winning by this many correct answers (or more) counts as a full win for the rating. */
export const RATING_FULL_MARGIN = 8;
export const EMOTE_COOLDOWN_SECONDS = 3;

/** Preset emotes: the only thing players can "say" to each other. No free text. */
export const LIVE_DUEL_EMOTES = Object.freeze({
  thumbs: '👍',
  wow: '😮',
  fire: '🔥',
  clap: '👏',
  phew: '😅',
  gg: '🤝',
});

export function isLiveDuelEmote(key) {
  return Object.prototype.hasOwnProperty.call(LIVE_DUEL_EMOTES, String(key ?? ''));
}

/* ------------------------------------------------------------- Answers */

/**
 * Same rule as parseIntegerAnswer in api/_drills.js and the SQL grader:
 * spaces and commas are ignored, anything that is not whole digits is wrong.
 */
export function cleanLiveAnswer(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/[\s,]/g, '');
}

export function gradeLiveAnswer(raw, expected) {
  const cleaned = cleanLiveAnswer(raw);
  if (!/^\d{1,16}$/.test(cleaned)) return false;
  const exp = Number(expected);
  if (!Number.isSafeInteger(exp)) return false;
  return Number(cleaned) === exp;
}

/**
 * Timing and order checks for one answer, mirroring live_duel_answer() in SQL.
 * Returns { ok: true } or { ok: false, code }.
 */
export function checkLiveAnswer({ startMs, endMs, nowMs, index, attempted, poolSize = LIVE_DUEL_POOL, answer = '' }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, code: 'NOT_STARTED' };
  if (nowMs < startMs) return { ok: false, code: 'NOT_STARTED' };
  if (nowMs > endMs + LIVE_DUEL_GRACE_SECONDS * 1000) return { ok: false, code: 'TIME_UP' };
  if (!Number.isInteger(index) || index !== attempted) return { ok: false, code: 'OUT_OF_ORDER' };
  if (index >= poolSize) return { ok: false, code: 'POOL_DONE' };
  if (String(answer ?? '').length > LIVE_DUEL_MAX_ANSWER_LENGTH) return { ok: false, code: 'BAD_ANSWER' };
  if (nowMs - startMs < (index + 1) * LIVE_DUEL_MIN_MS_PER_ANSWER) return { ok: false, code: 'TOO_FAST' };
  return { ok: true };
}

/* -------------------------------------------------------------- Result */

/**
 * More correct answers wins. Equal correct: whoever reached that score first
 * (lower last_correct_ms). Still equal: a draw. A side that answered nothing
 * never wins. Returns 'a' | 'b' | 'draw' | 'none' (nobody played).
 */
export function decideLiveResult(a, b) {
  const aPlayed = Number(a?.attempted) > 0;
  const bPlayed = Number(b?.attempted) > 0;
  if (!aPlayed && !bPlayed) return 'none';
  if (!bPlayed) return 'a';
  if (!aPlayed) return 'b';
  const ac = Number(a.correct) || 0;
  const bc = Number(b.correct) || 0;
  if (ac !== bc) return ac > bc ? 'a' : 'b';
  if (ac === 0) return 'draw';
  const at = Number.isFinite(Number(a.last_correct_ms)) ? Number(a.last_correct_ms) : Infinity;
  const bt = Number.isFinite(Number(b.last_correct_ms)) ? Number(b.last_correct_ms) : Infinity;
  if (at !== bt) return at < bt ? 'a' : 'b';
  return 'draw';
}

export function eloExpected(rating, other) {
  return 1 / (1 + 10 ** ((Number(other) - Number(rating)) / 400));
}

/** Rating change for one player. score: 1 win, 0.5 draw, 0 loss. */
export function eloDelta(rating, other, score, k = RATING_K) {
  return Math.round(k * (score - eloExpected(rating, other)));
}

/**
 * How much of a win the result was, for the rating (0..1, 0.5 = draw).
 * A close race moves ratings a little; a big win moves them fully:
 * the winner scores 0.5 + margin/16 (capped at 1 from an 8-answer margin), and a
 * win on time with equal answers counts as a 0.5-answer margin.
 */
export function liveDuelScore(outcome, margin = 0) {
  if (outcome === 'draw') return 0.5;
  const m = Math.max(0.5, Math.abs(Number(margin) || 0));
  const win = 0.5 + Math.min(0.5, m / (2 * RATING_FULL_MARGIN));
  return outcome === 'win' ? win : 1 - win;
}

/** Rating change for one side. Winners never lose rating and losers never gain it. */
export function liveDuelRatingDelta(rating, other, outcome, margin, k = RATING_K) {
  const raw = k * (liveDuelScore(outcome, margin) - eloExpected(rating, other));
  const d = Math.sign(raw) * Math.round(Math.abs(raw)); // rounds halves away from zero, like SQL round()
  if (outcome === 'win') return Math.max(1, d);
  if (outcome === 'loss') return Math.min(0, d);
  return d;
}

/**
 * Rating changes for a settled duel, scaled by the winning margin (correct answers).
 * Ghost duels move only the real player, at half K. Returns { a, b } (b is null
 * for ghosts) or zeros for 'none'.
 */
export function liveRatingChanges({ aRating = RATING_START, bRating = RATING_START, result, ghost = false, aCorrect = 0, bCorrect = 0 }) {
  if (result === 'none') return { a: 0, b: ghost ? null : 0 };
  const k = ghost ? RATING_K / 2 : RATING_K;
  const margin = Math.abs((Number(aCorrect) || 0) - (Number(bCorrect) || 0));
  const aOut = result === 'a' ? 'win' : result === 'b' ? 'loss' : 'draw';
  const bOut = result === 'b' ? 'win' : result === 'a' ? 'loss' : 'draw';
  const a = liveDuelRatingDelta(aRating, bRating, aOut, margin, k);
  return { a, b: ghost ? null : liveDuelRatingDelta(bRating, aRating, bOut, margin, k) };
}

export function applyRating(rating, delta) {
  return Math.max(RATING_FLOOR, Math.round(Number(rating) || RATING_START) + (Number(delta) || 0));
}

/**
 * Extra XP on top of the round's normal XP. Only the first BONUS_DUELS_PER_DAY
 * duels a day earn it; ghost duels earn half (rounded up). Nobody earns a bonus
 * for a duel they did not play.
 */
export function liveDuelBonusXp(outcome, bonusesToday, { ghost = false, played = true } = {}) {
  if (!played) return 0;
  if ((Number(bonusesToday) || 0) >= BONUS_DUELS_PER_DAY) return 0;
  const base = DUEL_BONUS_XP[outcome] ?? 0;
  return ghost ? Math.ceil(base / 2) : base;
}

/** 'won' | 'lost' | 'draw' from one side's point of view. */
export function outcomeFor(side, result) {
  if (result === 'draw') return 'draw';
  if (result === 'none') return 'lost';
  return result === side ? 'won' : 'lost';
}

/* ---------------------------------------------------------- Difficulty */

/**
 * Duel questions get harder as the rating climbs. Each tier mixes addition and
 * subtraction rows with multiplication and exact division (basics category specs).
 * A duel uses the average rating of its two players (the player's own against a
 * ghost) and is stored with category_name "Mixed ★<tier>" so replays and ghosts
 * rebuild exactly the same questions from the seed.
 */
export const LIVE_DUEL_TIERS = Object.freeze([
  { tier: 1, from: 0, mix: ['1d3r', '1d4r', '1dx1d', '1d/1d'] },
  { tier: 2, from: 950, mix: ['1d5r', '2d3r', '1dx1d', '2dx1d', '2d/1d'] },
  { tier: 3, from: 1100, mix: ['2d4r', '2d5r', '2dx1d', '3d/1d'] },
  { tier: 4, from: 1250, mix: ['2d6r', '3d4r', '3dx1d', '2dx2d', '3d/1d'] },
  { tier: 5, from: 1400, mix: ['3d5r', '2d8r', '3dx2d', '2dx2d', '4d/1d', '4d/2d'] },
]);

/** Tier (1-5) for a rating, or for the average of several ratings. */
export function liveDuelTier(...ratings) {
  const list = ratings.map((r) => Number(r)).filter(Number.isFinite);
  const avg = list.length ? list.reduce((a, b) => a + b, 0) / list.length : RATING_START;
  let tier = 1;
  for (const t of LIVE_DUEL_TIERS) if (avg >= t.from) tier = t.tier;
  return tier;
}

export function liveDuelMixName(tier) {
  const t = Math.min(5, Math.max(1, Math.round(Number(tier) || 1)));
  return `Mixed ★${t}`;
}

/** The category specs mixed into a "Mixed ★<tier>" duel, or null for a single-category name. */
export function liveDuelMix(categoryName) {
  const m = String(categoryName ?? '').trim().match(/^Mixed ★([1-5])$/);
  if (!m) return null;
  return LIVE_DUEL_TIERS.find((t) => t.tier === Number(m[1])).mix;
}

/* --------------------------------------------------------- Matchmaking */

function levelKey(level) {
  return String(normalizeLevel(level) ?? level ?? '').trim().toLowerCase();
}

export function sameLiveLevel(a, b) {
  const ka = levelKey(a);
  return ka !== '' && ka === levelKey(b);
}

/** Same centre: both unknown (single-centre today) or both the same centre. */
export function sameLiveCentre(a, b) {
  const ca = a ? String(a) : null;
  const cb = b ? String(b) : null;
  return ca === cb;
}

/** How far apart two ratings may be; widens the longer someone waits. */
export function ratingWindow(waitSeconds) {
  const w = Math.max(0, Number(waitSeconds) || 0);
  return Math.min(400, 100 + 50 * Math.floor(w / 3));
}

/**
 * Picks the best waiting opponent for `me` from queue rows
 * ({ student_id, level, centre_id, rating, joined_at, seen_at }).
 * Same level only, from any centre; rating gap inside the wider of the two windows;
 * closest rating first, then whoever has waited longest. Stale rows (not seen
 * for QUEUE_STALE_SECONDS) are skipped. Returns the row or null.
 */
export function pickLiveOpponent(me, waiting, nowMs = Date.now()) {
  if (!me || !Array.isArray(waiting)) return null;
  const myWait = (nowMs - new Date(me.joined_at ?? nowMs).getTime()) / 1000;
  let best = null;
  let bestGap = Infinity;
  let bestJoined = Infinity;
  for (const row of waiting) {
    if (!row || row.student_id === me.student_id) continue;
    if (!sameLiveLevel(row.level, me.level)) continue;
    const seen = new Date(row.seen_at ?? row.joined_at).getTime();
    if (!Number.isFinite(seen) || nowMs - seen > QUEUE_STALE_SECONDS * 1000) continue;
    const joined = new Date(row.joined_at).getTime();
    const theirWait = (nowMs - joined) / 1000;
    const gap = Math.abs((Number(row.rating) || RATING_START) - (Number(me.rating) || RATING_START));
    if (gap > Math.max(ratingWindow(myWait), ratingWindow(theirWait))) continue;
    if (gap < bestGap || (gap === bestGap && joined < bestJoined)) {
      best = row;
      bestGap = gap;
      bestJoined = joined;
    }
  }
  return best;
}

/* ------------------------------------------------------- Ghosts & bots */

/**
 * A ghost timeline from a past run's answers ({ q_index, correct, ms }):
 * [[ms, 1|0], ...] in answer order, inside the round.
 */
export function ghostTimelineFromAnswers(rows, seconds = LIVE_DUEL_SECONDS) {
  const limit = seconds * 1000;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => Number.isFinite(Number(r?.ms)) && Number(r.ms) >= 0 && Number(r.ms) <= limit)
    .sort((x, y) => Number(x.q_index) - Number(y.q_index))
    .map((r) => [Math.round(Number(r.ms)), r.correct ? 1 : 0]);
}

/** Small deterministic generator so a bot run is the same for the same seed. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A practice bot's run when no real past run exists: steady pace with some
 * jitter, a little faster at higher levels, about 85% accurate.
 */
export function botTimeline(seed, level, seconds = LIVE_DUEL_SECONDS, tier = 2) {
  const rng = mulberry32(Number(seed) || 1);
  const idx = Math.max(0, STUDENT_LEVELS.indexOf(normalizeLevel(level) ?? ''));
  // Harder tiers have longer sums, so the bot slows down with them (tier 2 = the old pace).
  const tierPace = 1 + 0.15 * ((Number(tier) || 2) - 2);
  const meanMs = Math.round(Math.max(1800, 4200 - idx * 180) * tierPace);
  const out = [];
  let t = 0;
  while (out.length < LIVE_DUEL_POOL) {
    t += Math.round(meanMs * (0.6 + rng() * 0.8));
    if (t > seconds * 1000) break;
    out.push([t, rng() < 0.85 ? 1 : 0]);
  }
  return out;
}

/** Progress of a timeline at a moment: { correct, attempted, last_correct_ms }. */
export function timelineProgress(timeline, ms) {
  let correct = 0;
  let attempted = 0;
  let last = null;
  for (const [t, ok] of Array.isArray(timeline) ? timeline : []) {
    if (t > ms) break;
    attempted += 1;
    if (ok) {
      correct += 1;
      last = t;
    }
  }
  return { correct, attempted, last_correct_ms: last };
}

/* ------------------------------------------------------------------ UI */

/** Width (0–100) of a lane in the race bar: the leader sits near the end. */
export function raceLanePercent(correct, otherCorrect) {
  const lead = Math.max(Number(correct) || 0, Number(otherCorrect) || 0);
  const span = Math.max(10, lead + 4);
  return Math.max(0, Math.min(100, Math.round(((Number(correct) || 0) / span) * 100)));
}

/** Seconds left in the round from a server-corrected clock. */
export function secondsLeft(endMs, nowMs) {
  return Math.max(0, Math.ceil((endMs - nowMs) / 1000));
}
