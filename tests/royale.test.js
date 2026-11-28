/**
 * Battle royale: the shared rules (shared/royale.js), the join API (api/_royale.js),
 * the SQL (supabase/migrations/46_battle_royale.sql, in PGlite) and the page.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  ROYALE_FILL_SECONDS,
  ROYALE_MAX_PLAYERS,
  ROYALE_ROUNDS,
  ROYALE_POOL,
  compareRoyaleRound,
  nextRoyaleSlot,
  ordinal,
  royaleOutCount,
  royalePlaceXp,
  settleRoyaleRound,
} from '../shared/royale.js';
import { buildRoyaleRounds, handleRoyaleJoin, royaleStartAt, ROYALE_FULL_START_SECONDS } from '../api/_royale.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ROYALE_FILE = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).find((f) => /_battle_royale\.sql$/.test(f));
const ROYALE_SQL = read(`supabase/migrations/${ROYALE_FILE}`);

/* ============================================================ rules */

describe('battle royale rules', () => {
  it('puts out a quarter, at least one, every idle player, never the last', () => {
    assert.equal(royaleOutCount(1), 0);
    assert.equal(royaleOutCount(2), 1);
    assert.equal(royaleOutCount(3), 1);
    assert.equal(royaleOutCount(8), 2);
    assert.equal(royaleOutCount(20), 5);
    assert.equal(royaleOutCount(8, 4), 4, 'idle players all go');
    assert.equal(royaleOutCount(5, 5), 4, 'someone always stays');
  });

  it('ranks by correct, then speed, idle players last', () => {
    const players = [
      { id: 'idle', round_correct: 0, round_attempted: 0, round_last_ms: null },
      { id: 'wrong', round_correct: 0, round_attempted: 3, round_last_ms: null },
      { id: 'slow', round_correct: 2, round_attempted: 2, round_last_ms: 9000 },
      { id: 'fast', round_correct: 2, round_attempted: 2, round_last_ms: 4000 },
    ];
    assert.deepEqual([...players].sort(compareRoyaleRound).map((p) => p.id), ['fast', 'slow', 'wrong', 'idle']);
    const { stay, out } = settleRoyaleRound(players);
    assert.deepEqual(stay.map((p) => p.id), ['fast', 'slow', 'wrong']);
    assert.deepEqual(out.map((p) => [p.id, p.place]), [['idle', 4]]);
  });

  it('gives place XP and slots on the half hour', () => {
    assert.deepEqual([1, 2, 3, 4, 10, 11, 20].map((p) => royalePlaceXp(p, 20)), [30, 20, 15, 10, 10, 5, 5]);
    assert.equal(nextRoyaleSlot(Date.parse('2026-11-28T10:07:00Z')), '2026-11-28T10:30:00.000Z');
    assert.equal(nextRoyaleSlot(Date.parse('2026-11-28T10:30:00Z')), '2026-11-28T10:30:00.000Z');
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
  });

  it('builds the same rounds from the same seed, different questions per round', () => {
    const a = buildRoyaleRounds('2d5r', 42);
    const b = buildRoyaleRounds('2d5r', 42);
    assert.equal(a.questions.length, ROYALE_ROUNDS);
    assert.equal(a.questions[0].length, ROYALE_POOL);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.questions[0], a.questions[1]);
    assert.equal(JSON.stringify(a.questions).includes('expected'), false);
  });

  it('starts sooner when 4 are in and almost at once when full', () => {
    const now = Date.parse('2026-11-28T10:00:00Z');
    const slot = '2026-11-28T10:30:00.000Z';
    assert.equal(royaleStartAt(slot, 3, now), slot);
    assert.equal(royaleStartAt(slot, 4, now), new Date(now + ROYALE_FILL_SECONDS * 1000).toISOString());
    assert.equal(royaleStartAt(slot, ROYALE_MAX_PLAYERS, now), new Date(now + ROYALE_FULL_START_SECONDS * 1000).toISOString());
    assert.equal(royaleStartAt('2026-11-28T10:00:05.000Z', 4, now), '2026-11-28T10:00:05.000Z', 'never later');
  });

  it('keeps the SQL in step with shared/royale.js', () => {
    assert.match(ROYALE_SQL, /floor\(p_alive \* 0\.25\)/);
    assert.match(ROYALE_SQL, /THEN 30 WHEN p_place = 2 THEN 20 WHEN p_place = 3 THEN 15/);
    assert.match(ROYALE_SQL, /\(round_attempted = 0\) ASC/);
    assert.match(ROYALE_SQL, /\(p_index \+ 1\) \* 250/);
    assert.match(ROYALE_SQL, /\/ 1800\) \* 1800/);
  });
});

/* ============================================================ API */

function fakeDb(seed = {}) {
  const tables = { royale_games: [], royale_keys: [], royale_players: [], duel_ratings: [], categories: [], ...seed };
  const calls = [];
  let n = 0;
  function query(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = false;
    let head = false;
    let limit = null;
    const q = {
      select(_c, opts) { head = Boolean(opts?.head); return q; },
      insert(v) { op = 'insert'; payload = v; return q; },
      update(v) { op = 'update'; payload = v; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      order() { return q; },
      limit(k) { limit = k; return q; },
      single() { single = true; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    function run() {
      const rows = tables[table];
      if (op === 'insert') {
        if (table === 'royale_games' && rows.some((r) => r.status === 'waiting' && r.level === payload.level)) {
          return { data: null, error: { message: 'duplicate key' } };
        }
        if (table === 'royale_players' && rows.some((r) => r.game_id === payload.game_id && r.student_id === payload.student_id)) {
          return { data: null, error: { message: 'duplicate key' } };
        }
        const row = { ...(table === 'royale_games' ? { id: `game-${++n}` } : {}), place: null, ...payload };
        rows.push(row);
        calls.push({ table, op, row });
        return { data: row, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); return { data: hit, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
      if (head) return { count: hit.length, error: null };
      const out = limit ? hit.slice(0, limit) : hit;
      return { data: single ? out[0] ?? null : out, error: null };
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
      if (name === 'daily_challenge_candidates') return { data: [{ category_id: 'cat-1', name: '2d5r' }], error: null };
      if (name === 'royale_tick') {
        const g = tables.royale_games.find((r) => r.id === args.p_game);
        if (g) g.status = 'live';
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  };
}

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

const join = async (db, id, now, level = 'Level 2') => {
  const res = fakeRes();
  await handleRoyaleJoin({ student: { id, level }, adminSupabase: db, res, now });
  return res;
};

describe('battle royale API', () => {
  const NOW = Date.parse('2026-11-28T10:07:00Z');

  it('opens a waiting game with 12 rounds and a hidden key, then adds the next players', async () => {
    const db = fakeDb();
    const a = await join(db, 'stu-a', NOW);
    assert.equal(a.statusCode, 200);
    const [game] = db.tables.royale_games;
    assert.equal(a.body.game_id, game.id);
    assert.equal(game.status, 'waiting');
    assert.equal(game.level, 'Level 2');
    assert.equal(game.start_at, '2026-11-28T10:30:00.000Z');
    assert.equal(game.rounds.length, ROYALE_ROUNDS);
    assert.equal(JSON.stringify(game).includes('expected'), false);
    assert.equal(db.tables.royale_keys[0].expected.length, ROYALE_ROUNDS);
    const b = await join(db, 'stu-b', NOW);
    assert.equal(b.body.game_id, game.id);
    assert.equal(db.tables.royale_games.length, 1);
    assert.equal(db.tables.royale_players.length, 2);
    const again = await join(db, 'stu-a', NOW);
    assert.equal(again.body.game_id, game.id, 'already in: same game back');
    assert.equal(db.tables.royale_players.length, 2);
  });

  it('pulls the start in when 4 are waiting, and refuses a full game', async () => {
    const db = fakeDb();
    for (const id of ['s1', 's2', 's3']) await join(db, id, NOW);
    assert.equal(db.tables.royale_games[0].start_at, '2026-11-28T10:30:00.000Z');
    const fourth = await join(db, 's4', NOW);
    assert.equal(fourth.body.start_at, new Date(NOW + ROYALE_FILL_SECONDS * 1000).toISOString());
    assert.equal(db.tables.royale_games[0].start_at, fourth.body.start_at);
    for (let i = 5; i <= ROYALE_MAX_PLAYERS; i += 1) await join(db, `s${i}`, NOW + 1000);
    assert.equal(db.tables.royale_games[0].start_at, new Date(NOW + 1000 + ROYALE_FULL_START_SECONDS * 1000).toISOString());
    const late = await join(db, 'late', NOW + 2000);
    assert.equal(late.statusCode, 409);
    assert.match(late.body.error, /full/);
  });

  it('keeps levels apart and opens a new game once the old one has started', async () => {
    const db = fakeDb();
    await join(db, 'l2', NOW);
    await join(db, 'l3', NOW, 'Level 3');
    assert.equal(db.tables.royale_games.length, 2);
    db.tables.royale_games[0].start_at = new Date(NOW - 1000).toISOString();
    db.tables.royale_players.find((p) => p.student_id === 'l2').place = 1;
    const next = await join(db, 'other', NOW);
    assert.ok(db.calls.some((c) => c.rpc === 'royale_tick'), 'a past-due game is ticked first');
    assert.equal(db.tables.royale_games.length, 3);
    assert.equal(next.body.game_id, db.tables.royale_games[2].id);
  });

  it('needs live duels switched on and a level', async () => {
    assert.equal((await join(fakeDb({ enabled: false }), 'x', NOW)).statusCode, 403);
    assert.equal((await join(fakeDb(), 'x', NOW, null)).statusCode, 400);
  });
});

/* ============================================================ SQL */

describe('battle royale SQL (PGlite)', () => {
  let db;
  const IDS = ['a', 'b', 'c', 'd', 'e'].map((c, i) => `${c.repeat(8)}-0000-4000-8000-00000000000${i + 1}`);
  const [A, B, C, D, E] = IDS;
  const X = 'ffffffff-0000-4000-8000-000000000009';

  const as = async (uid, fn) => {
    await db.exec(`SET app.uid = '${uid}'; SET ROLE authenticated;`);
    try { return await fn(); } finally { await db.exec('RESET ROLE;'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const state = (uid, game) => as(uid, async () => (await one('SELECT public.royale_state($1) AS s', [game])).s);
  const answer = (uid, game, i, v) => as(uid, async () => (await one('SELECT public.royale_answer($1, $2, $3) AS r', [game, i, v])).r);
  /** Round open since 10 s ago (answers allowed). */
  const openRound = (game) => db.query(
    "UPDATE public.royale_games SET round_start_at = now() - interval '10 seconds', round_end_at = now() + interval '20 seconds' WHERE id = $1", [game]);
  /** Round over (the next state call settles it). */
  const closeRound = (game) => db.query(
    "UPDATE public.royale_games SET round_start_at = now() - interval '40 seconds', round_end_at = now() - interval '10 seconds' WHERE id = $1", [game]);

  async function newGame(players, { startIn = '-1 second' } = {}) {
    const g = await one(
      `INSERT INTO public.royale_games (level, category_name, seed, rounds, start_at)
       VALUES ('Level 2', '2d5r', 7, $1, now() + $2::interval) RETURNING id`,
      [JSON.stringify(Array.from({ length: 12 }, () => Array.from({ length: 10 }, (_, i) => ({ q: `${i + 1}` })))), startIn],
    );
    await db.query('INSERT INTO public.royale_keys (game_id, expected) VALUES ($1, $2)', [
      g.id, JSON.stringify(Array.from({ length: 12 }, () => Array.from({ length: 10 }, (_, i) => i + 1))),
    ]);
    for (const [i, id] of players.entries()) {
      await db.query("INSERT INTO public.royale_players (game_id, student_id, joined_at) VALUES ($1, $2, now() + make_interval(secs => $3))", [g.id, id, i]);
    }
    return g.id;
  }
  /** `n` correct answers (then `wrong` wrong ones) for a player this round. */
  async function play(uid, game, n, wrong = 0) {
    for (let i = 0; i < n + wrong; i += 1) {
      const r = await answer(uid, game, i, i < n ? String(i + 1) : '0');
      assert.equal(r.ok, true, JSON.stringify(r));
    }
  }

  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, level text, full_name text, student_code text, avatar_path text);
      CREATE TABLE public.student_badges (student_id uuid, badge_key text, PRIMARY KEY (student_id, badge_key));
      CREATE TABLE public.badge_catalogue (key text PRIMARY KEY, name text, icon text, description text, category text, sort_order int);
      CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;
      CREATE FUNCTION public.display_name_for(p_name text, p_code text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_name, p_code) $$;
      CREATE FUNCTION public.avatar_visible(p_student uuid, p_path text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p_path $$;
      CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.is_teacher(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id uuid, p_student_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.live_duel_grade(p_answer text, p_expected text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
        SELECT btrim(COALESCE(p_answer, '')) = btrim(COALESCE(p_expected, '')) $$;
    `);
    const xp = read('supabase/migrations/23_phase23_xp_and_personal_bests.sql');
    await db.exec(xp.slice(xp.indexOf('CREATE TABLE IF NOT EXISTS public.student_xp_events'), xp.indexOf('-- Per-source mapping')));
    await db.exec(`ALTER TABLE public.student_xp_events DROP CONSTRAINT IF EXISTS student_xp_events_source_check;
      ALTER TABLE public.student_xp_events ADD CONSTRAINT student_xp_events_source_check
        CHECK (source IN ('result', 'activity', 'jmcwc', 'duel'));`);
    await db.exec(ROYALE_SQL);
    await db.query(
      `INSERT INTO public.profiles (id, role, level, full_name) VALUES
        ($1, 'student', 'Level 2', 'Asha'), ($2, 'student', 'Level 2', 'Ben'), ($3, 'student', 'Level 2', 'Cara'),
        ($4, 'student', 'Level 2', 'Dev'), ($5, 'student', 'Level 2', 'Esha'), ($6, 'student', 'Level 2', 'Xen')`,
      [...IDS, X],
    );
  });
  after(async () => { await db?.close(); });

  it('applies twice and adds the winner badge', async () => {
    await db.exec(ROYALE_SQL);
    assert.equal((await one("SELECT name FROM public.badge_catalogue WHERE key = 'royale_win'")).name, 'Royale winner');
  });

  it('keeps the tables away from students', async () => {
    await assert.rejects(as(A, () => db.query('SELECT * FROM public.royale_keys')));
    await assert.rejects(as(A, () => db.query('SELECT public.royale_tick(gen_random_uuid())')));
  });

  it('waits, then a lone player is moved to the next slot', async () => {
    const game = await newGame([X]);
    const s = await state(X, game);
    assert.equal(s.status, 'waiting');
    assert.equal(s.questions, null);
    const g = await one('SELECT start_at > now() AS later, extract(minute FROM start_at)::int % 30 AS m FROM public.royale_games WHERE id = $1', [game]);
    assert.deepEqual(g, { later: true, m: 0 });
    assert.equal((await as(X, async () => (await one('SELECT public.royale_leave($1) AS r', [game])).r)).ok, true);
    assert.equal((await one('SELECT count(*)::int AS n FROM public.royale_players WHERE game_id = $1', [game])).n, 0);
    await db.query("UPDATE public.royale_games SET status = 'done' WHERE id = $1", [game]);
  });

  it('runs a game: same questions, eliminations, places, XP and the badge', async () => {
    const game = await newGame(IDS);
    let s = await state(A, game);
    assert.equal(s.status, 'live');
    assert.equal(s.round, 1);
    assert.equal(s.questions, null, 'no questions before the round starts');
    assert.equal((await answer(A, game, 0, '1')).code, 'NOT_STARTED');

    await openRound(game);
    s = await state(A, game);
    assert.equal(s.questions.length, 10);
    assert.deepEqual((await state(B, game)).questions, s.questions, 'everyone gets the same questions');
    assert.equal(JSON.stringify(s).includes('expected'), false);
    assert.equal((await answer(A, game, 1, '2')).code, 'OUT_OF_ORDER');
    assert.equal((await as(X, async () => (await one('SELECT public.royale_answer($1, 0, $2) AS r', [game, '1'])).r)).code, 'NOT_FOUND');

    // Round 1: A 4, B 3, C 2, D 0 of 2, E idle -> E out (idle), 5th.
    await play(A, game, 4);
    await play(B, game, 3);
    await play(C, game, 2);
    await play(D, game, 0, 2);
    await closeRound(game);
    s = await state(E, game);
    assert.equal(s.round, 2);
    assert.deepEqual([s.me.alive, s.me.place, s.me.out_round], [false, 5, 1]);
    assert.equal(s.players.filter((p) => p.alive).length, 4);
    assert.equal(s.players.find((p) => p.name === 'Asha').last, 4);

    // Round 2: D 3, A 2, B 2 (slower), C 1 -> C out, 4th.
    await openRound(game);
    assert.equal(s.questions, null, 'players who are out get no questions');
    assert.equal((await answer(E, game, 0, '1')).code, 'OUT');
    await play(D, game, 3);
    await play(A, game, 2);
    await play(B, game, 2);
    await play(C, game, 1);
    await closeRound(game);
    s = await state(C, game);
    assert.deepEqual([s.me.alive, s.me.place], [false, 4]);

    // Round 3: A 3, B 2, D 1 -> D out, 3rd. Round 4: B 2, A 1 -> A 2nd, B wins.
    await openRound(game);
    await play(A, game, 3);
    await play(B, game, 2);
    await play(D, game, 1);
    await closeRound(game);
    await state(A, game);
    await openRound(game);
    await play(B, game, 2);
    await play(A, game, 1);
    await closeRound(game);
    s = await state(B, game);
    assert.equal(s.status, 'done');
    assert.equal(s.winner, 'Ben');
    assert.deepEqual([s.me.alive, s.me.place], [true, 1]);

    const places = (await db.query('SELECT student_id, place, xp FROM public.royale_players WHERE game_id = $1', [game])).rows;
    const placeOf = Object.fromEntries(places.map((p) => [p.student_id, p.place]));
    assert.deepEqual([B, A, D, C, E].map((id) => placeOf[id]), [1, 2, 3, 4, 5]);
    const ev = (await db.query("SELECT student_id, bonus_xp, score_label FROM public.student_xp_events WHERE source = 'duel' AND source_id LIKE $1", [`royale:${game}:%`])).rows;
    assert.equal(ev.length, 4, 'the idle player answered nothing: no XP row');
    const bonus = Object.fromEntries(ev.map((e) => [e.student_id, e.bonus_xp]));
    assert.deepEqual([bonus[B], bonus[A], bonus[D], bonus[C]], [30, 20, 15, 5]);
    assert.equal(ev.find((e) => e.student_id === B).score_label, '#1 of 5');
    assert.ok(places.find((p) => p.student_id === B).xp > 30);
    assert.ok(await one("SELECT 1 AS ok FROM public.student_badges WHERE student_id = $1 AND badge_key = 'royale_win'", [B]));
    assert.equal(await one("SELECT 1 AS ok FROM public.student_badges WHERE student_id = $1 AND badge_key = 'royale_win'", [A]), undefined);

    const mine = await as(A, async () => (await one('SELECT public.my_royale() AS r', [])).r);
    assert.equal(mine.active, null);
    assert.equal(mine.recent[0].place, 2);
    assert.equal(mine.recent[0].size, 5);
  });

  it('flags answers that come impossibly fast', async () => {
    const game = await newGame([A, B]);
    await state(A, game);
    await db.query("UPDATE public.royale_games SET round_start_at = now() - interval '100 milliseconds', round_end_at = now() + interval '30 seconds' WHERE id = $1", [game]);
    assert.equal((await answer(A, game, 0, '1')).code, 'TOO_FAST');
    assert.equal((await one('SELECT flagged FROM public.royale_players WHERE game_id = $1 AND student_id = $2', [game, A])).flagged, true);
  });

  it('finishes after the last prepared round with several still in', async () => {
    const game = await newGame([C, D]);
    await state(C, game);
    await db.query('UPDATE public.royale_games SET round = 12 WHERE id = $1', [game]);
    await openRound(game);
    await play(C, game, 1);
    await play(D, game, 1);
    await closeRound(game);
    // Both answered 1: the earlier correct answer stays and wins the out; one is out anyway (2 -> 1).
    const s = await state(C, game);
    assert.equal(s.status, 'done');
    assert.equal(s.players.filter((p) => p.place === 1).length, 1);
  });
});

/* ============================================================ page */

describe('battle royale page', () => {
  it('has a Battle royale tab and section on the Live Duel page', () => {
    const page = read('pages/live-duel.html');
    assert.match(page, /data-ld-mode="royale"/);
    assert.match(page, /id="ld-royale"/);
    assert.match(page, /id="ld-royale-game"/);
    assert.match(page, /id="br-form"/);
    const js = read('js/liveDuel.js');
    assert.match(js, /const MODES = \['duel', 'ghost', 'royale', 'tourney']/);
    assert.match(js, /'ld-royale-game'\]/);
    assert.match(read('api/drill.js'), /action === 'royale_join'/);
  });
});

describe('battle royale view', async () => {
  const view = await import('../js/royaleView.js');
  const T0 = Date.parse('2026-11-28T10:00:00Z');
  const iso = (s) => new Date(T0 + s * 1000).toISOString();

  it('works out the phase from the clock', () => {
    const live = { status: 'live', round: 1, round_start_at: iso(5), round_end_at: iso(35) };
    assert.deepEqual(view.royalePhase(live, T0), { phase: 'countdown', secs: 5 });
    assert.deepEqual(view.royalePhase(live, T0 + 6000), { phase: 'round', secs: 29 });
    assert.deepEqual(view.royalePhase(live, T0 + 36000), { phase: 'settling', secs: 0 });
    assert.equal(view.royalePhase({ ...live, round: 2 }, T0).phase, 'break');
    assert.deepEqual(view.royalePhase({ status: 'waiting', start_at: iso(20) }, T0), { phase: 'waiting', secs: 20 });
    assert.equal(view.royalePhase({ status: 'done' }, T0).phase, 'done');
    assert.deepEqual([5, 89, 90, 1603].map(view.waitText), ['5s', '89s', '1:30', '26:43']);
  });

  it('shows the join card, waiting count and recent places', () => {
    const html = view.buildRoyaleHomeHtml({ waiting: { count: 3, start_at: iso(600) }, wins: 2,
      recent: [{ place: 1, size: 6, xp: 52, category_name: 'Mix' }] });
    assert.match(html, /data-royale-join/);
    assert.match(html, /<b class="num">3<\/b> of 20 waiting/);
    assert.match(html, /1st/);
    assert.match(html, /\+52 XP/);
    assert.match(view.buildRoyaleHomeHtml({}, { disabled: true }), /data-royale-join disabled/);
  });

  it('fades players who are out and marks me', () => {
    const html = view.buildRoyaleStripHtml([
      { id: 1, name: 'Asha', alive: true, me: true },
      { id: 2, name: '<b>Ben</b>', alive: false, place: 3 },
    ]);
    assert.match(html, /<b class="num">1<\/b> of <span class="num">2<\/span> left/);
    assert.match(html, /br-player is-in is-me/);
    assert.match(html, /br-player is-out/);
    assert.match(html, />3rd</);
    assert.equal(html.includes('<b>Ben</b>'), false, 'names are escaped');
  });

  it('tells players who are out, through, or the winner', () => {
    const out = view.buildRoyaleNoteHtml({ me: { alive: false, place: 7 } }, { phase: 'round', secs: 10 });
    assert.match(out, /out in <b>7th<\/b>/);
    assert.match(out, /data-royale-back/);
    const through = view.buildRoyaleNoteHtml({ round: 3, me: { alive: true, last_round_correct: 6 } }, { phase: 'break', secs: 4 });
    assert.match(through, /through with <b class="num">6<\/b>/);
    assert.match(view.buildRoyaleNoteHtml({ players: [{}], me: { alive: true } }, { phase: 'waiting', secs: 9 }), /data-royale-leave/);
    const win = view.buildRoyaleFinalHtml({ me: { place: 1, xp: 61 }, players: [{}, {}], winner: 'Asha' });
    assert.match(win, /You won the battle royale/);
    assert.match(win, /Royale winner/);
    const lost = view.buildRoyaleFinalHtml({ me: { place: 2, xp: 30 }, players: [{}, {}], winner: 'Asha' });
    assert.match(lost, /You came 2nd of 2/);
    assert.match(lost, /Winner: <b>Asha<\/b>/);
  });
});
