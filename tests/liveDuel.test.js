/**
 * Live duels (shared/liveDuel.js, api/_liveDuels.js, migration 31).
 *
 * 1. Pure rules: answer grading, timing checks, winner, Elo, bonus XP,
 *    matchmaking, ghost and bot timelines, race bar.
 * 2. Question seeding: both players get identical questions; no answers leak.
 * 3. API handlers against an in-memory fake of the service-role client.
 * 4. The SQL itself in PGlite: grading, order/timing checks, settling, XP,
 *    ratings, emotes, invites, Realtime topics and grants.
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  BONUS_DUELS_PER_DAY,
  DUEL_BONUS_XP,
  LIVE_DUEL_EMOTES,
  LIVE_DUEL_GRACE_SECONDS,
  LIVE_DUEL_MIN_MS_PER_ANSWER,
  LIVE_DUEL_POOL,
  LIVE_DUEL_SECONDS,
  RATING_K,
  botTimeline,
  checkLiveAnswer,
  decideLiveResult,
  eloDelta,
  ghostTimelineFromAnswers,
  gradeLiveAnswer,
  isLiveDuelEmote,
  liveDuelBonusXp,
  liveRatingChanges,
  applyRating,
  outcomeFor,
  pickLiveOpponent,
  raceLanePercent,
  ratingWindow,
  sameLiveCentre,
  sameLiveLevel,
  secondsLeft,
  timelineProgress,
} from '../shared/liveDuel.js';
import { equalIntegerAnswer, parseIntegerAnswer } from '../api/_drills.js';
import {
  buildLiveDuelQuestions,
  handleLiveGhost,
  handleLiveInvite,
  handleLiveQueue,
  handleLiveRematch,
  liveDuelWindow,
} from '../api/_liveDuels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/31_live_duels.sql'), 'utf8');

/* ===================================================================== 1 */

describe('live duel rules', () => {
  it('grades answers like the practice grader (spaces/commas ignored, digits only)', () => {
    const cases = [['42', 42], [' 4 2 ', 42], ['1,234', 1234], ['042', 42], ['-5', 5], ['4.0', 4], ['', 0], ['abc', 1], ['7', 8]];
    for (const [raw, exp] of cases) {
      const viaDrills = equalIntegerAnswer(parseIntegerAnswer(raw), exp);
      assert.equal(gradeLiveAnswer(raw, exp), viaDrills, `answer ${JSON.stringify(raw)} vs ${exp}`);
    }
    assert.equal(gradeLiveAnswer(null, 0), false);
  });

  it('checks order, time window, pool and impossible speed', () => {
    const startMs = 1_000_000;
    const endMs = startMs + LIVE_DUEL_SECONDS * 1000;
    const base = { startMs, endMs, attempted: 3, index: 3 };
    assert.deepEqual(checkLiveAnswer({ ...base, nowMs: startMs + 5000 }), { ok: true });
    assert.equal(checkLiveAnswer({ ...base, nowMs: startMs - 1 }).code, 'NOT_STARTED');
    assert.equal(checkLiveAnswer({ ...base, nowMs: endMs + LIVE_DUEL_GRACE_SECONDS * 1000 + 1 }).code, 'TIME_UP');
    assert.equal(checkLiveAnswer({ ...base, nowMs: endMs + 1000 }).ok, true, 'grace covers network delay');
    assert.equal(checkLiveAnswer({ ...base, index: 4, nowMs: startMs + 5000 }).code, 'OUT_OF_ORDER');
    assert.equal(checkLiveAnswer({ ...base, index: 2, nowMs: startMs + 5000 }).code, 'OUT_OF_ORDER');
    assert.equal(checkLiveAnswer({ ...base, nowMs: startMs + 4 * LIVE_DUEL_MIN_MS_PER_ANSWER - 1 }).code, 'TOO_FAST');
    assert.equal(checkLiveAnswer({ ...base, index: LIVE_DUEL_POOL, attempted: LIVE_DUEL_POOL, nowMs: endMs }).code, 'POOL_DONE');
    assert.equal(checkLiveAnswer({ ...base, answer: 'x'.repeat(21), nowMs: startMs + 5000 }).code, 'BAD_ANSWER');
  });

  it('decides the winner: correct first, then who got there first, never a no-show', () => {
    assert.equal(decideLiveResult({ correct: 10, attempted: 12 }, { correct: 9, attempted: 9 }), 'a');
    assert.equal(decideLiveResult({ correct: 5, attempted: 5 }, { correct: 8, attempted: 20 }), 'b');
    assert.equal(decideLiveResult({ correct: 7, attempted: 7, last_correct_ms: 40000 }, { correct: 7, attempted: 9, last_correct_ms: 39000 }), 'b');
    assert.equal(decideLiveResult({ correct: 7, attempted: 7, last_correct_ms: 1 }, { correct: 7, attempted: 7, last_correct_ms: 1 }), 'draw');
    assert.equal(decideLiveResult({ correct: 0, attempted: 3 }, { correct: 0, attempted: 2 }), 'draw');
    assert.equal(decideLiveResult({ correct: 0, attempted: 1 }, { correct: 0, attempted: 0 }), 'a');
    assert.equal(decideLiveResult({ correct: 0, attempted: 0 }, { correct: 0, attempted: 0 }), 'none');
    assert.equal(outcomeFor('a', 'a'), 'won');
    assert.equal(outcomeFor('b', 'a'), 'lost');
    assert.equal(outcomeFor('b', 'draw'), 'draw');
  });

  it('moves ratings with Elo; ghosts move only the player, at half K', () => {
    assert.equal(eloDelta(1000, 1000, 1), RATING_K / 2);
    assert.equal(eloDelta(1000, 1000, 0), -RATING_K / 2);
    assert.equal(eloDelta(1000, 1000, 0.5), 0);
    assert.ok(eloDelta(1000, 1400, 1) > eloDelta(1400, 1000, 1), 'upset wins are worth more');
    const live = liveRatingChanges({ aRating: 1100, bRating: 1000, result: 'b' });
    assert.equal(live.a + live.b, 0);
    const ghost = liveRatingChanges({ aRating: 1000, bRating: 1000, result: 'a', ghost: true });
    assert.deepEqual(ghost, { a: RATING_K / 4, b: null });
    assert.deepEqual(liveRatingChanges({ result: 'none' }), { a: 0, b: 0 });
    assert.equal(applyRating(110, -50), 100, 'rating floor');
  });

  it('gives a duel bonus only for the first duels of the day, half for ghosts', () => {
    assert.equal(liveDuelBonusXp('won', 0), DUEL_BONUS_XP.won);
    assert.equal(liveDuelBonusXp('draw', 3), DUEL_BONUS_XP.draw);
    assert.equal(liveDuelBonusXp('lost', BONUS_DUELS_PER_DAY - 1), DUEL_BONUS_XP.lost);
    assert.equal(liveDuelBonusXp('won', BONUS_DUELS_PER_DAY), 0);
    assert.equal(liveDuelBonusXp('won', 0, { ghost: true }), Math.ceil(DUEL_BONUS_XP.won / 2));
    assert.equal(liveDuelBonusXp('won', 0, { played: false }), 0);
  });

  it('only allows preset emotes', () => {
    assert.equal(isLiveDuelEmote('fire'), true);
    assert.equal(isLiveDuelEmote('hello there'), false);
    assert.equal(isLiveDuelEmote('__proto__'), false);
    for (const key of Object.keys(LIVE_DUEL_EMOTES)) assert.match(MIGRATION, new RegExp(`'${key}'`));
  });
});

describe('matchmaking', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const ago = (s) => new Date(now - s * 1000).toISOString();
  const me = { student_id: 'me', level: 'Level 2', centre_id: null, rating: 1000, joined_at: ago(0), seen_at: ago(0) };

  it('pairs only the same level and centre, skipping stale and self rows', () => {
    const rows = [
      { student_id: 'me', level: 'Level 2', rating: 1000, joined_at: ago(5), seen_at: ago(0) },
      { student_id: 'other-level', level: 'Level 3', rating: 1000, joined_at: ago(5), seen_at: ago(0) },
      { student_id: 'other-centre', level: 'Level 2', centre_id: 'c2', rating: 1000, joined_at: ago(5), seen_at: ago(0) },
      { student_id: 'stale', level: 'level 2', rating: 1000, joined_at: ago(30), seen_at: ago(20) },
    ];
    assert.equal(pickLiveOpponent(me, rows, now), null);
    rows.push({ student_id: 'ok', level: 'level2', rating: 1050, joined_at: ago(4), seen_at: ago(1) });
    assert.equal(pickLiveOpponent(me, rows, now).student_id, 'ok');
  });

  it('prefers the closest rating, then the longest wait, and widens the window over time', () => {
    const rows = [
      { student_id: 'far', level: 'Level 2', rating: 1300, joined_at: ago(2), seen_at: ago(0) },
      { student_id: 'near-new', level: 'Level 2', rating: 1020, joined_at: ago(1), seen_at: ago(0) },
      { student_id: 'near-old', level: 'Level 2', rating: 980, joined_at: ago(6), seen_at: ago(0) },
    ];
    assert.equal(pickLiveOpponent(me, rows, now).student_id, 'near-old');
    assert.equal(pickLiveOpponent(me, [rows[0]], now), null, '300 apart is too far at first');
    const waited = { ...rows[0], joined_at: ago(15) };
    assert.equal(pickLiveOpponent(me, [waited], now).student_id, 'far', 'window widens after waiting');
    assert.equal(ratingWindow(0), 100);
    assert.equal(ratingWindow(600), 400);
  });

  it('treats levels and centres consistently', () => {
    assert.equal(sameLiveLevel('KA-1', 'ka1'), true);
    assert.equal(sameLiveLevel('', ''), false);
    assert.equal(sameLiveCentre(null, undefined), true);
    assert.equal(sameLiveCentre('c1', null), false);
  });
});

describe('ghosts, bots and the race bar', () => {
  it('builds a ghost timeline in answer order inside the round', () => {
    const tl = ghostTimelineFromAnswers([
      { q_index: 1, correct: false, ms: 4000 },
      { q_index: 0, correct: true, ms: 2000 },
      { q_index: 2, correct: true, ms: 61000 },
    ]);
    assert.deepEqual(tl, [[2000, 1], [4000, 0]]);
    assert.deepEqual(timelineProgress(tl, 3000), { correct: 1, attempted: 1, last_correct_ms: 2000 });
    assert.deepEqual(timelineProgress(tl, 60000), { correct: 1, attempted: 2, last_correct_ms: 2000 });
  });

  it('makes the same bot run for the same seed, faster at higher levels', () => {
    assert.deepEqual(botTimeline(42, 'KA-1'), botTimeline(42, 'KA-1'));
    assert.notDeepEqual(botTimeline(42, 'KA-1'), botTimeline(43, 'KA-1'));
    const slow = botTimeline(7, 'KA-1').length;
    const fast = botTimeline(7, 'Grandmaster').length;
    assert.ok(fast > slow, `${fast} > ${slow}`);
    for (const [t] of botTimeline(9, 'Level 3')) assert.ok(t <= LIVE_DUEL_SECONDS * 1000);
  });

  it('sizes race lanes against the leader and counts down', () => {
    assert.equal(raceLanePercent(0, 0), 0);
    assert.ok(raceLanePercent(20, 10) > raceLanePercent(10, 20));
    assert.ok(raceLanePercent(30, 0) <= 100);
    assert.equal(secondsLeft(10_000, 0), 10);
    assert.equal(secondsLeft(10_000, 20_000), 0);
  });
});

/* ===================================================================== 2 */

describe('question seeding', () => {
  it('gives both players identical questions from the shared seed', () => {
    const a = buildLiveDuelQuestions('2d5r', 12345);
    const b = buildLiveDuelQuestions('2d5r', 12345);
    assert.deepEqual(a, b);
    assert.equal(a.questions.length, LIVE_DUEL_POOL);
    assert.notDeepEqual(buildLiveDuelQuestions('2d5r', 12346).questions, a.questions);
  });

  it('never puts expected answers in the questions sent to the browser', () => {
    const { questions, expected } = buildLiveDuelQuestions('2d5r', 99);
    assert.equal(expected.length, questions.length);
    for (const q of questions) assert.equal('expected' in q, false);
  });

  it('starts the race after the countdown and runs for the round length', () => {
    const w = liveDuelWindow(0);
    assert.equal(Date.parse(w.start_at), 5000);
    assert.equal(Date.parse(w.end_at) - Date.parse(w.start_at), LIVE_DUEL_SECONDS * 1000);
  });

  it('keeps the SQL constants in step with shared/liveDuel.js', () => {
    assert.match(MIGRATION, /interval '2 seconds'/);
    assert.match(MIGRATION, new RegExp(`\\(p_index \\+ 1\\) \\* ${LIVE_DUEL_MIN_MS_PER_ANSWER}`));
    assert.match(MIGRATION, new RegExp(`v_before >= ${BONUS_DUELS_PER_DAY}`));
    assert.match(MIGRATION, new RegExp(`'won' THEN ${DUEL_BONUS_XP.won} WHEN 'draw' THEN ${DUEL_BONUS_XP.draw} ELSE ${DUEL_BONUS_XP.lost}`));
    assert.match(MIGRATION, new RegExp(`ELSE ${RATING_K} END`));
  });
});

/* ===================================================================== 3 */

/** A tiny in-memory stand-in for the service-role Supabase client. */
function fakeDb(seed = {}) {
  const tables = {
    live_duels: [], live_duel_keys: [], live_duel_queue: [], live_duel_answers: [], duel_ratings: [],
    profiles: [], categories: [], ...seed,
  };
  const calls = [];
  let n = 0;
  const matchers = (filters) => (row) => filters.every((f) => f(row));
  function query(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    let maybe = false;
    let head = false;
    let limit = null;
    const q = {
      select(_cols, opts) { if (op === 'select') op = 'select'; head = Boolean(opts?.head); return q; },
      insert(v) { op = 'insert'; payload = v; return q; },
      upsert(v) { op = 'upsert'; payload = v; return q; },
      update(v) { op = 'update'; payload = v; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      neq(c, v) { filters.push((r) => r[c] !== v); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      gt(c, v) { filters.push((r) => r[c] > v); return q; },
      gte(c, v) { filters.push((r) => r[c] >= v); return q; },
      or(expr) {
        const parts = expr.split(',').map((p) => p.split('.'));
        filters.push((r) => parts.some(([c, , v]) => r[c] === v));
        return q;
      },
      order() { return q; },
      limit(k) { limit = k; return q; },
      single() { single = true; return q; },
      maybeSingle() { maybe = true; return q; },
      then(resolve, reject) {
        try { resolve(run()); } catch (e) { reject(e); }
      },
    };
    function run() {
      const rows = tables[table];
      if (op === 'insert') {
        const row = { id: payload.id || `id-${++n}`, ...payload };
        rows.push(row);
        calls.push({ table, op, row });
        return { data: row, error: null };
      }
      if (op === 'upsert') {
        const i = rows.findIndex((r) => r.student_id === payload.student_id);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null };
      }
      const hit = rows.filter(matchers(filters));
      if (op === 'update') {
        hit.forEach((r) => Object.assign(r, payload));
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      if (head) return { count: hit.length, error: null };
      const out = limit ? hit.slice(0, limit) : hit;
      if (single || maybe) return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
    return q;
  }
  return {
    tables,
    calls,
    from: query,
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      if (name === 'live_duel_enabled') return { data: tables.enabled !== false, error: null };
      if (name === 'live_duel_centre_of') return { data: tables.centres?.[args.p_student] ?? null, error: null };
      if (name === 'daily_challenge_candidates') {
        return { data: [{ category_id: 'cat-1', name: '2d5r', students: 3 }], error: null };
      }
      if (name === 'live_duel_claim_pair') {
        const ids = [args.p_a, args.p_b];
        const both = ids.every((id) => tables.live_duel_queue.some((r) => r.student_id === id));
        if (both) tables.live_duel_queue = tables.live_duel_queue.filter((r) => !ids.includes(r.student_id));
        return { data: both, error: null };
      }
      return { data: null, error: null };
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const STU = { id: 'stu-a', level: 'Level 2' };
const STU_B = { id: 'stu-b', level: 'Level 2' };

describe('live duel API', () => {
  it('queues, then pairs the next student at the level with the same questions', async () => {
    const db = fakeDb();
    const now = Date.now();
    const r1 = fakeRes();
    await handleLiveQueue({ student: STU, adminSupabase: db, res: r1, now });
    assert.equal(r1.body.waiting, true);
    const r2 = fakeRes();
    await handleLiveQueue({ student: STU_B, adminSupabase: db, res: r2, now: now + 1000 });
    assert.ok(r2.body.duel_id, JSON.stringify(r2.body));
    const duel = db.tables.live_duels[0];
    assert.equal(duel.a_id, 'stu-a');
    assert.equal(duel.b_id, 'stu-b');
    assert.equal(duel.kind, 'quick');
    assert.equal(db.tables.live_duel_queue.length, 0, 'both left the queue');
    const key = db.tables.live_duel_keys[0];
    assert.equal(key.duel_id, duel.id);
    assert.deepEqual(buildLiveDuelQuestions(duel.category_name, duel.seed).expected, key.expected);
    assert.equal(JSON.stringify(duel.questions).includes('expected'), false);
    // The waiting student's next poll returns the same duel.
    const r3 = fakeRes();
    await handleLiveQueue({ student: STU, adminSupabase: db, res: r3, now: now + 2000 });
    assert.equal(r3.body.duel_id, duel.id);
  });

  it('refuses when live duels are switched off or the hourly cap is reached', async () => {
    const off = fakeDb({ enabled: false });
    const r = fakeRes();
    await handleLiveQueue({ student: STU, adminSupabase: off, res: r });
    assert.equal(r.statusCode, 403);

    const now = Date.now();
    const busy = fakeDb({
      live_duels: Array.from({ length: 30 }, (_, i) => ({
        id: `d${i}`, a_id: 'stu-a', status: 'done', created_at: new Date(now - 60_000).toISOString(),
        end_at: new Date(now - 30_000).toISOString(),
      })),
    });
    const r2 = fakeRes();
    await handleLiveQueue({ student: STU, adminSupabase: busy, res: r2, now });
    assert.equal(r2.statusCode, 429);
  });

  it('races a practice bot when there is no past run yet', async () => {
    const db = fakeDb();
    const res = fakeRes();
    await handleLiveGhost({ student: STU, adminSupabase: db, res });
    const duel = db.tables.live_duels[0];
    assert.ok(res.body.duel_id);
    assert.equal(duel.kind, 'ghost');
    assert.equal(duel.b_id, null);
    assert.equal(duel.ghost.bot, true);
    assert.deepEqual(duel.ghost.timeline, botTimeline(duel.seed, 'Level 2'));
  });

  it('replays a real past run as an anonymous ghost on the same questions', async () => {
    const past = {
      id: 'past', a_id: 'stu-c', b_id: 'stu-d', a_attempted: 6, b_attempted: 2, status: 'done', level: 'Level 2',
      kind: 'quick', centre_id: null, category_id: 'cat-9', category_name: '1d3r', seed: 777,
    };
    const answers = Array.from({ length: 6 }, (_, i) => ({
      duel_id: 'past', student_id: 'stu-c', q_index: i, correct: i !== 2, ms: 2000 * (i + 1),
    }));
    const db = fakeDb({ live_duels: [past], live_duel_answers: answers });
    const res = fakeRes();
    await handleLiveGhost({ student: STU, adminSupabase: db, res });
    const duel = db.tables.live_duels.find((d) => d.kind === 'ghost');
    assert.equal(duel.ghost.bot, false);
    assert.equal(duel.ghost.label, 'Ghost runner (Level 2)');
    assert.equal(JSON.stringify(duel.ghost).includes('stu-c'), false, 'never names the other child');
    assert.equal(duel.seed, 777);
    assert.equal(duel.category_id, 'cat-9');
    assert.equal(duel.ghost.timeline.length, 6);
  });

  it('invites only an available classmate at the same level and centre', async () => {
    const profiles = [
      { id: '00000000-0000-4000-8000-00000000000b', role: 'student', active: true, level: 'level 2', leaderboard_visible: true },
      { id: '00000000-0000-4000-8000-00000000000c', role: 'student', active: true, level: 'Level 4', leaderboard_visible: true },
      { id: '00000000-0000-4000-8000-00000000000d', role: 'student', active: true, level: 'Level 2', leaderboard_visible: true },
    ];
    const db = fakeDb({ profiles, centres: { '00000000-0000-4000-8000-00000000000d': 'other-centre' } });
    const ok = fakeRes();
    await handleLiveInvite({ body: { opponent_id: profiles[0].id }, student: STU, adminSupabase: db, res: ok });
    assert.equal(ok.body.invited, true);
    assert.equal(db.tables.live_duels[0].status, 'invited');
    assert.ok(db.tables.live_duels[0].invite_expires_at);

    const again = fakeRes();
    await handleLiveInvite({ body: { opponent_id: profiles[0].id }, student: STU, adminSupabase: db, res: again });
    assert.equal(again.statusCode, 409);

    const level = fakeRes();
    await handleLiveInvite({ body: { opponent_id: profiles[1].id }, student: { id: 'x', level: 'Level 2' }, adminSupabase: db, res: level });
    assert.equal(level.statusCode, 400);

    const centre = fakeRes();
    await handleLiveInvite({ body: { opponent_id: profiles[2].id }, student: { id: 'y', level: 'Level 2' }, adminSupabase: db, res: centre });
    assert.match(centre.body.error, /centre/);

    const bad = fakeRes();
    await handleLiveInvite({ body: { opponent_id: 'nope' }, student: STU, adminSupabase: db, res: bad });
    assert.equal(bad.statusCode, 400);
  });

  it('starts a rematch only when both players ask, exactly once', async () => {
    const done = {
      id: '00000000-0000-4000-8000-0000000000aa', kind: 'quick', status: 'done', a_id: 'stu-a', b_id: 'stu-b',
      a_rematch: false, b_rematch: false, rematch_id: null, level: 'Level 2', centre_id: null,
      category_id: 'cat-1', category_name: '2d5r', seed: 5,
    };
    const db = fakeDb({ live_duels: [done] });
    const first = fakeRes();
    await handleLiveRematch({ body: { duel_id: done.id }, student: STU, adminSupabase: db, res: first });
    assert.equal(first.body.waiting, true);
    assert.ok(db.calls.some((c) => c.rpc === 'live_duel_send' && c.args.p_event === 'rematch'));
    const second = fakeRes();
    await handleLiveRematch({ body: { duel_id: done.id }, student: STU_B, adminSupabase: db, res: second });
    assert.ok(second.body.duel_id);
    const created = db.tables.live_duels.filter((d) => d.kind === 'rematch');
    assert.equal(created.length, 1);
    assert.equal(created[0].rematch_of, done.id);
    assert.notEqual(created[0].seed, done.seed);
    const third = fakeRes();
    await handleLiveRematch({ body: { duel_id: done.id }, student: STU, adminSupabase: db, res: third });
    assert.equal(third.body.duel_id, second.body.duel_id);
    const stranger = fakeRes();
    await handleLiveRematch({ body: { duel_id: done.id }, student: { id: 'zz', level: 'Level 2' }, adminSupabase: db, res: stranger });
    assert.equal(stranger.statusCode, 404);
  });
});

/* ===================================================================== 4 */

describe('live duel SQL (PGlite)', () => {
  let db;
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const C = 'cccccccc-0000-4000-8000-000000000003';
  const ADMIN = 'dddddddd-0000-4000-8000-000000000004';
  const CAT = 'eeeeeeee-0000-4000-8000-000000000005';

  const as = async (uid, fn) => {
    await db.exec(`SET app.uid = '${uid}'; SET ROLE authenticated;`);
    try { return await fn(); } finally { await db.exec('RESET ROLE;'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  /** A live duel that started `ago` ms in the past with expected answers 1..n. */
  async function liveDuel({ ago = 10_000, b = B, ghost = null, n = 10 } = {}) {
    const row = await one(
      `INSERT INTO public.live_duels (kind, a_id, b_id, ghost, level, category_id, category_name, seed, questions, start_at, end_at)
       VALUES ($1, $2, $3, $4, 'Level 2', $5, '1d3r', 1, '[]'::jsonb,
               now() - make_interval(secs => $6::numeric / 1000), now() - make_interval(secs => $6::numeric / 1000) + interval '60 seconds')
       RETURNING id`,
      [b ? 'quick' : 'ghost', A, b, ghost ? JSON.stringify(ghost) : null, CAT, ago],
    );
    await db.query('INSERT INTO public.live_duel_keys (duel_id, expected) VALUES ($1, $2)', [
      row.id, JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)),
    ]);
    return row.id;
  }
  const answer = (uid, duel, index, value) =>
    as(uid, async () => (await one('SELECT public.live_duel_answer($1, $2, $3) AS r', [duel, index, value])).r);
  const endNow = (duel) => db.query(
    "UPDATE public.live_duels SET start_at = now() - interval '70 seconds', end_at = now() - interval '10 seconds' WHERE id = $1", [duel]);

  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
      CREATE SCHEMA realtime;
      CREATE TABLE realtime.messages (id bigserial PRIMARY KEY, topic text, extension text, event text, payload jsonb, private boolean);
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
      CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic', true) $$;
      CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) RETURNS void
        LANGUAGE sql SECURITY DEFINER AS $$
        INSERT INTO realtime.messages (topic, extension, event, payload, private) VALUES (topic, 'broadcast', event, payload, private) $$;
      GRANT USAGE ON SCHEMA realtime, auth TO authenticated, anon, service_role;
      GRANT SELECT, INSERT ON realtime.messages TO authenticated; GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO authenticated;

      CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, active boolean DEFAULT true, level text,
        full_name text, student_code text, avatar_path text, leaderboard_visible boolean DEFAULT true);
      CREATE TABLE public.student_badges (student_id uuid, badge_key text, PRIMARY KEY (student_id, badge_key));
      CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;
      CREATE FUNCTION public.display_name_for(p_name text, p_code text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_name, p_code) $$;
      CREATE FUNCTION public.avatar_visible(p_student uuid, p_path text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p_path $$;
      CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;
      CREATE FUNCTION public.is_teacher(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_uid AND role = 'teacher') $$;
      CREATE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id uuid, p_student_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    `);
    const xp = fs.readFileSync(path.join(ROOT, 'supabase/migrations/23_phase23_xp_and_personal_bests.sql'), 'utf8');
    const start = xp.indexOf('CREATE TABLE IF NOT EXISTS public.student_xp_events');
    const end = xp.indexOf('-- Per-source mapping');
    await db.exec(xp.slice(start, end));
    await db.exec(MIGRATION);
    await db.query(
      `INSERT INTO public.profiles (id, role, level, full_name) VALUES
        ($1, 'student', 'Level 2', 'Asha'), ($2, 'student', 'Level 2', 'Ben'),
        ($3, 'student', 'Level 2', 'Cara'), ($4, 'admin', 'Admin', 'Boss')`,
      [A, B, C, ADMIN],
    );
  });

  it('applies twice without errors (idempotent)', async () => {
    await db.exec(MIGRATION);
  });

  it('grades each answer, broadcasts progress and enforces order', async () => {
    const duel = await liveDuel();
    let r = await answer(A, duel, 0, '1');
    assert.deepEqual([r.ok, r.correct, r.my_correct, r.my_attempted], [true, true, 1, 1]);
    r = await answer(A, duel, 1, ' 9 ');
    assert.deepEqual([r.ok, r.correct, r.my_correct], [true, false, 1]);
    r = await answer(A, duel, 1, '2');
    assert.equal(r.code, 'OUT_OF_ORDER');
    r = await answer(A, duel, 5, '6');
    assert.equal(r.code, 'OUT_OF_ORDER');
    r = await answer(B, duel, 0, '1');
    assert.equal(r.ok, true);
    r = await answer(C, duel, 0, '1');
    assert.equal(r.code, 'NOT_FOUND', 'strangers cannot answer');
    const msgs = (await db.query("SELECT event, payload FROM realtime.messages WHERE topic = $1 AND event = 'progress' ORDER BY id", [`duel:${duel}`])).rows;
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[2].payload, { side: 'b', correct: 1, attempted: 1 });
    const row = await one('SELECT a_correct, a_attempted, b_correct FROM public.live_duels WHERE id = $1', [duel]);
    assert.deepEqual(row, { a_correct: 1, a_attempted: 2, b_correct: 1 });
  });

  it('rejects impossible speed, early answers and late answers', async () => {
    const fresh = await liveDuel({ ago: 100 });
    assert.equal((await answer(A, fresh, 0, '1')).code, 'TOO_FAST');
    assert.equal((await one('SELECT flagged FROM public.live_duels WHERE id = $1', [fresh])).flagged, true);
    const future = await liveDuel({ ago: -3000 });
    assert.equal((await answer(A, future, 0, '1')).code, 'NOT_STARTED');
    const over = await liveDuel({ ago: 63_000 });
    assert.equal((await answer(A, over, 0, '1')).code, 'TIME_UP');
    const tiny = await liveDuel({ n: 1 });
    await answer(A, tiny, 0, '1');
    assert.equal((await answer(A, tiny, 1, '2')).code, 'POOL_DONE');
  });

  it('hides questions until the start and answers always', async () => {
    const future = await liveDuel({ ago: -3000 });
    const s = await as(A, async () => (await one('SELECT public.live_duel_state($1) AS s', [future])).s);
    assert.equal(s.questions, null);
    assert.equal(s.other.name, 'Ben');
    const started = await liveDuel();
    const s2 = await as(B, async () => (await one('SELECT public.live_duel_state($1) AS s', [started])).s);
    assert.deepEqual(s2.questions, []);
    assert.equal(JSON.stringify(s2).includes('expected'), false);
    const s3 = await as(C, async () => (await one('SELECT public.live_duel_state($1) AS s', [started])).s);
    assert.equal(s3, null, 'strangers see nothing');
  });

  it('settles once: winner, XP with bonus, ratings and badges', async () => {
    const duel = await liveDuel({ ago: 20_000 });
    for (let i = 0; i < 4; i += 1) await answer(A, duel, i, String(i + 1));
    await answer(B, duel, 0, '1');
    await answer(B, duel, 1, '0');
    await as(A, () => db.query('SELECT public.live_duel_settle($1)', [duel]));
    assert.equal((await one('SELECT status FROM public.live_duels WHERE id = $1', [duel])).status, 'live', 'not before the end');
    await endNow(duel);
    await as(A, () => db.query('SELECT public.live_duel_settle($1)', [duel]));
    await as(B, () => db.query('SELECT public.live_duel_settle($1)', [duel]));
    const d = await one('SELECT status, result, winner_id, a_xp, b_xp, a_rating_delta, b_rating_delta FROM public.live_duels WHERE id = $1', [duel]);
    assert.equal(d.status, 'done');
    assert.equal(d.result, 'a');
    assert.equal(d.winner_id, A);
    assert.equal(d.a_rating_delta, 12);
    assert.equal(d.b_rating_delta, -12);
    const ev = (await db.query("SELECT student_id, bonus_xp, xp FROM public.student_xp_events WHERE source = 'duel' AND source_id LIKE $1 ORDER BY source_id", [`${duel}%`])).rows;
    assert.equal(ev.length, 2, 'settled exactly once');
    assert.equal(ev[0].bonus_xp, 15);
    assert.equal(ev[1].bonus_xp, 5);
    assert.equal(d.a_xp, ev[0].xp);
    const ratings = (await db.query('SELECT student_id, rating, won, lost FROM public.duel_ratings ORDER BY rating DESC')).rows;
    assert.deepEqual(ratings.map((r) => r.rating), [1012, 988]);
    const badges = (await db.query('SELECT badge_key FROM public.student_badges WHERE student_id = $1 ORDER BY 1', [A])).rows;
    assert.deepEqual(badges.map((b) => b.badge_key), ['duel_first', 'duel_win']);
    const finished = await one("SELECT count(*)::int AS n FROM realtime.messages WHERE topic = $1 AND event = 'finished'", [`duel:${duel}`]);
    assert.equal(finished.n, 1);
  });

  it('settles a ghost race from its timeline, half bonus and half K', async () => {
    const ghost = { label: 'Practice bot', bot: true, timeline: [[3000, 1], [6000, 1], [9000, 1], [61000, 1]] };
    const duel = await liveDuel({ b: null, ghost, ago: 20_000 });
    await answer(A, duel, 0, '1');
    await endNow(duel);
    await as(A, () => db.query('SELECT public.live_duel_settle($1)', [duel]));
    const d = await one('SELECT result, b_correct, b_attempted, a_rating_delta, b_rating_delta FROM public.live_duels WHERE id = $1', [duel]);
    assert.equal(d.result, 'b');
    assert.equal(d.b_correct, 3, 'answers after the round do not count');
    assert.equal(d.a_rating_delta, -6);
    assert.equal(d.b_rating_delta, null);
    const ev = await one("SELECT bonus_xp FROM public.student_xp_events WHERE source_id = $1", [`${duel}:a`]);
    assert.equal(ev.bonus_xp, 3);
  });

  it('expires a duel nobody played without XP or rating changes', async () => {
    const duel = await liveDuel();
    await endNow(duel);
    await as(B, () => db.query('SELECT public.live_duel_settle($1)', [duel]));
    const d = await one('SELECT status, result, a_rating_delta FROM public.live_duels WHERE id = $1', [duel]);
    assert.deepEqual(d, { status: 'expired', result: 'none', a_rating_delta: null });
  });

  it('allows only preset emotes, slowly, between real players', async () => {
    const duel = await liveDuel();
    const send = (uid, e) => as(uid, async () => (await one('SELECT public.live_duel_emote($1, $2) AS r', [duel, e])).r);
    assert.equal((await send(A, 'fire')).ok, true);
    assert.equal((await send(A, 'clap')).code, 'SLOW_DOWN');
    assert.equal((await send(B, 'you are bad')).code, 'BAD_EMOTE');
    assert.equal((await send(C, 'gg')).code, 'NOT_ALLOWED');
    const ghost = await liveDuel({ b: null, ghost: { timeline: [] } });
    const g = await as(A, async () => (await one('SELECT public.live_duel_emote($1, $2) AS r', [ghost, 'gg'])).r);
    assert.equal(g.code, 'NOT_ALLOWED');
  });

  it('runs a live challenge: invite notifies, only the invitee accepts, start is set', async () => {
    const row = await one(
      `INSERT INTO public.live_duels (kind, status, a_id, b_id, level, category_id, category_name, seed, questions, invite_expires_at)
       VALUES ('challenge', 'invited', $1, $2, 'Level 2', $3, '1d3r', 1, '[]', now() + interval '60 seconds') RETURNING id`,
      [A, B, CAT],
    );
    const invite = await one("SELECT payload FROM realtime.messages WHERE topic = $1 AND event = 'invite' ORDER BY id DESC LIMIT 1", [`duel-user:${B}`]);
    assert.equal(invite.payload.from_name, 'Asha');
    const wrong = await as(A, async () => (await one('SELECT public.live_duel_respond($1, true) AS r', [row.id])).r);
    assert.equal(wrong.ok, false);
    const ok = await as(B, async () => (await one('SELECT public.live_duel_respond($1, true) AS r', [row.id])).r);
    assert.equal(ok.ok, true);
    const d = await one('SELECT status, extract(epoch FROM end_at - start_at)::int AS len FROM public.live_duels WHERE id = $1', [row.id]);
    assert.deepEqual(d, { status: 'live', len: 60 });
  });

  it('limits Realtime topics to the right people', async () => {
    const duel = await liveDuel();
    await db.query("INSERT INTO realtime.messages (topic, extension, event) VALUES ($1, 'broadcast', 'x'), ($2, 'broadcast', 'y'), ('duel-lobby', 'presence', 'p')", [`duel:${duel}`, `duel-user:${A}`]);
    const visible = async (uid, topic) => {
      await db.exec(`SET realtime.topic = '${topic}'`);
      return as(uid, async () => (await one('SELECT count(*)::int AS n FROM realtime.messages WHERE topic = $1', [topic])).n);
    };
    assert.ok((await visible(A, `duel:${duel}`)) > 0);
    assert.equal(await visible(C, `duel:${duel}`), 0);
    assert.ok((await visible(A, `duel-user:${A}`)) > 0);
    assert.equal(await visible(B, `duel-user:${A}`), 0);
    assert.ok((await visible(C, 'duel-lobby')) > 0);
    await db.exec(`SET realtime.topic = 'duel:${duel}'`);
    await assert.rejects(as(C, () => db.query("INSERT INTO realtime.messages (topic, extension) VALUES ($1, 'presence')", [`duel:${duel}`])));
    await assert.rejects(as(A, () => db.query("INSERT INTO realtime.messages (topic, extension) VALUES ($1, 'broadcast')", [`duel:${duel}`])),
      'players cannot broadcast from the browser');
    await as(A, () => db.query("INSERT INTO realtime.messages (topic, extension) VALUES ($1, 'presence')", [`duel:${duel}`]));
  });

  it('keeps tables and helpers closed to the browser', async () => {
    await assert.rejects(as(A, () => db.query('SELECT * FROM public.live_duel_keys')));
    await assert.rejects(as(A, () => db.query('SELECT * FROM public.live_duels')));
    await assert.rejects(as(A, () => db.query("SELECT public.live_duel_send('duel-user:x', 'invite', '{}')")));
    await assert.rejects(as(A, () => db.query('SELECT public.live_duel_claim_pair($1, $2)', [A, B])));
    await db.exec('SET ROLE anon;');
    await assert.rejects(db.query('SELECT public.my_live_duels()'));
    await db.exec('RESET ROLE;');
  });

  it('lets only admins switch live duels off; staff see the feed', async () => {
    await assert.rejects(as(A, () => db.query('SELECT public.live_duel_set_enabled(false)')));
    await assert.rejects(as(A, () => db.query('SELECT public.live_duels_staff(7)')));
    await as(ADMIN, () => db.query('SELECT public.live_duel_set_enabled(false)'));
    const feed = await as(ADMIN, async () => (await one('SELECT public.live_duels_staff(7) AS f', [])).f);
    assert.equal(feed.enabled, false);
    assert.equal(feed.can_toggle, true);
    assert.ok(feed.duels.some((d) => d.flagged), 'too-fast answers are flagged for staff');
    await as(ADMIN, () => db.query('SELECT public.live_duel_set_enabled(true)'));
    const mine = await as(A, async () => (await one('SELECT public.my_live_duels() AS m', [])).m);
    assert.equal(mine.enabled, true);
    assert.ok(mine.rating.played >= 1);
    assert.ok(mine.recent.length >= 1);
    assert.deepEqual(mine.mates.map((m) => m.display_name), ['Ben', 'Cara'], 'same level, not me, not staff');
  });

  it('reads centres from profiles.centre_id once multi-centre adds it', async () => {
    await db.exec('ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS centre_id uuid');
    await db.query("UPDATE public.profiles SET centre_id = '11111111-0000-4000-8000-000000000001' WHERE id IN ($1, $2)", [A, B]);
    await db.query("UPDATE public.profiles SET centre_id = '22222222-0000-4000-8000-000000000002' WHERE id = $1", [C]);
    const mine = await as(A, async () => (await one('SELECT public.my_live_duels() AS m', [])).m);
    assert.deepEqual(mine.mates.map((m) => m.display_name), ['Ben'], 'other centres are not offered');
    const board = await as(C, async () => (await one('SELECT public.live_duel_board() AS b', [])).b);
    assert.equal(board.some((r) => r.display_name === 'Asha'), false, 'top duellists are per centre');
    const centre = await one('SELECT public.live_duel_centre_of($1) AS c', [C]);
    assert.equal(centre.c, '22222222-0000-4000-8000-000000000002');
  });
});

/* ===================================================================== 5 */

describe('live duel page', () => {
  it('renders question rows, lanes, results and staff flags safely', async () => {
    const view = await import('../js/liveDuelView.js');
    const q = view.buildQuestionHtml({ type: 'add_sub', text: '+5 -3', rows: [5, -3] });
    assert.match(q, /−<\/span>3/);
    assert.match(view.buildQuestionHtml({ type: 'mul', text: '66 x 2' }), /66 × 2/);
    assert.match(view.buildLanesHtml({ otherName: '<b>x</b>', mine: 3, theirs: 1 }), /&lt;b&gt;x/);
    const res = view.buildResultHtml({ result: 'won', kind: 'quick', me: { correct: 9, attempted: 10, xp: 40, rating_delta: 12 }, other: { name: 'Ben', correct: 7, attempted: 8, rematch: true } });
    assert.match(res, /You won!/);
    assert.match(res, /\+40 XP/);
    assert.match(res, /\+12/);
    assert.match(res, /Accept rematch/);
    const staff = view.buildStaffHtml({ enabled: true, can_toggle: true, duels: [{ created_at: '2026-11-27T10:00:00Z', a_name: 'A', b_name: 'B', flagged: true, kind: 'quick' }] });
    assert.match(staff, /data-live-toggle checked/);
    assert.match(staff, /1 flagged/);
    assert.match(view.buildEmoteBarHtml(true), /Emotes off/);
  });

  it('is built, linked from Duels and highlighted under Duels in the nav', async () => {
    const vite = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    assert.match(vite, /pages\/live-duel\.html/);
    assert.match(fs.readFileSync(path.join(ROOT, 'pages/duels.html'), 'utf8'), /href="\/pages\/live-duel\.html"/);
    const page = fs.readFileSync(path.join(ROOT, 'pages/live-duel.html'), 'utf8');
    assert.match(page, /src="\/js\/liveDuel\.js"/);
    const { isNavItemCurrent } = await import('../js/navConfig.js');
    assert.equal(isNavItemCurrent({ href: '/pages/duels.html' }, '/pages/live-duel.html'), true);
  });
});
