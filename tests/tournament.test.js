/**
 * Live duel tournaments: the shared rules (shared/tournament.js), check-in (api/_tournaments.js),
 * the SQL (supabase/migrations/*_live_duel_tournaments.sql, in PGlite), the view and the page.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  TOURNAMENT_PRIZES,
  bracketSize,
  firstRoundPairs,
  nextSlot,
  roundCount,
  roundName,
  seedOrder,
  seedPlayers,
  timeoutWinner,
} from '../shared/tournament.js';
import { handleTournamentCheckIn } from '../api/_tournaments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FILE = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).find((f) => /_live_duel_tournaments\.sql$/.test(f));
const SQL = read(`supabase/migrations/${FILE}`);

/* ============================================================ rules */

describe('tournament rules', () => {
  it('sizes the bracket to fit, capped', () => {
    assert.deepEqual([2, 4, 5, 8, 9, 16, 17, 32].map((n) => bracketSize(n)), [4, 4, 8, 8, 16, 16, 32, 32]);
    assert.equal(bracketSize(12, 8), 8);
    assert.deepEqual([4, 8, 16, 32].map(roundCount), [2, 3, 4, 5]);
  });

  it('keeps seeds 1 and 2 apart until the final', () => {
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    const o = seedOrder(32);
    assert.equal(o.indexOf(1) < 16, true);
    assert.equal(o.indexOf(2) >= 16, true);
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
  });

  it('gives byes to the top seeds', () => {
    assert.deepEqual(firstRoundPairs(5), [[1, null], [4, 5], [2, null], [3, null]]);
    assert.deepEqual(firstRoundPairs(4), [[1, 4], [2, 3]]);
    assert.equal(firstRoundPairs(11).filter(([, b]) => b === null).length, 5);
  });

  it('seeds by rating, then sign-up time', () => {
    const seeded = seedPlayers([
      { id: 'late', rating: 1100, joined_at: '2026-11-28T10:02:00Z' },
      { id: 'top', rating: 1300, joined_at: '2026-11-28T10:05:00Z' },
      { id: 'early', rating: 1100, joined_at: '2026-11-28T10:01:00Z' },
      { id: 'new', joined_at: '2026-11-28T10:00:00Z' },
    ]);
    assert.deepEqual(seeded.map((e) => [e.id, e.seed]), [['top', 1], ['early', 2], ['late', 3], ['new', 4]]);
  });

  it('moves winners on and settles missed check-ins', () => {
    assert.deepEqual(nextSlot(1, 3), { round: 2, slot: 1, side: 'b' });
    assert.deepEqual(nextSlot(2, 0), { round: 3, slot: 0, side: 'a' });
    assert.deepEqual(timeoutWinner({ aIn: false, bIn: true, aSeed: 1, bSeed: 8 }), { side: 'b', how: 'forfeit' });
    assert.deepEqual(timeoutWinner({ aIn: false, bIn: false, aSeed: 5, bSeed: 4 }), { side: 'b', how: 'no_show' });
    assert.deepEqual(timeoutWinner({ aIn: true, bIn: true, aSeed: 2, bSeed: 3 }), { side: 'a', how: 'seed' });
    assert.deepEqual([1, 2, 3, 4].map((r) => roundName(r, 4)), ['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
  });
});

/* ============================================================ API */

function fakeDb({ checkIn, attach = true, enabled = true } = {}) {
  const tables = { live_duels: [], live_duel_keys: [], duel_ratings: [{ student_id: 'a', rating: 1200 }] };
  const calls = [];
  let n = 0;
  const from = (table) => {
    let op = 'select';
    let payload = null;
    const filters = [];
    const q = {
      select() { return q; },
      insert(v) { op = 'insert'; payload = v; return q; },
      delete() { op = 'delete'; return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      single() { return q; },
      maybeSingle() { return q; },
      then(resolve) {
        const rows = tables[table] || [];
        if (op === 'insert') {
          const row = { id: `duel-${++n}`, ...payload };
          rows.push(row);
          return resolve({ data: row, error: null });
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === 'delete') { tables[table] = rows.filter((r) => !hit.includes(r)); return resolve({ data: null, error: null }); }
        return resolve({ data: hit[0] ?? null, error: null });
      },
    };
    return q;
  };
  return {
    tables,
    calls,
    from,
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'live_duel_enabled') return { data: enabled, error: null };
      if (name === 'daily_challenge_candidates') return { data: [{ category_id: 'cat-1', name: '2d5r' }], error: null };
      if (name === 'tournament_check_in') return { data: checkIn, error: null };
      if (name === 'tournament_attach_duel') return { data: attach, error: null };
      return { data: null, error: null };
    },
  };
}
const fakeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const MATCH = '11111111-2222-4333-8444-555555555555';
const checkInVia = async (db, body = { match_id: MATCH }) => {
  const res = fakeRes();
  await handleTournamentCheckIn({ body, student: { id: 'b', level: 'Level 2' }, adminSupabase: db, res });
  return res;
};

describe('tournament check-in API', () => {
  it('starts a rated 60-second tournament duel once both are in', async () => {
    const db = fakeDb({ checkIn: { ok: true, start: true, a_id: 'a', b_id: 'b', level: 'Level 2', centre_id: null } });
    const res = await checkInVia(db);
    assert.equal(res.statusCode, 200);
    const [duel] = db.tables.live_duels;
    assert.equal(res.body.duel_id, duel.id);
    assert.equal(duel.kind, 'tournament');
    assert.deepEqual([duel.a_id, duel.b_id, duel.seconds], ['a', 'b', 60]);
    assert.equal(JSON.stringify(duel).includes('expected'), false);
    assert.equal(db.tables.live_duel_keys.length, 1);
    assert.deepEqual(db.calls.find((c) => c.name === 'tournament_attach_duel').args, { p_match: MATCH, p_duel: duel.id });
  });

  it('waits for the other player, and returns an existing duel', async () => {
    const waiting = await checkInVia(fakeDb({ checkIn: { ok: true, start: false, waiting: true } }));
    assert.deepEqual(waiting.body, { checked_in: true, waiting: true });
    const live = await checkInVia(fakeDb({ checkIn: { ok: true, duel_id: 'existing' } }));
    assert.deepEqual(live.body, { duel_id: 'existing' });
  });

  it('drops its duel when another call attached one first', async () => {
    const db = fakeDb({ checkIn: { ok: true, start: true, a_id: 'a', b_id: 'b', level: 'Level 2' }, attach: false });
    const res = await checkInVia(db);
    assert.equal(db.tables.live_duels.length, 0);
    assert.equal(res.statusCode, 409);
  });

  it('explains refusals and checks its input', async () => {
    const early = await checkInVia(fakeDb({ checkIn: { ok: false, code: 'NOT_YET' } }));
    assert.equal(early.statusCode, 409);
    assert.match(early.body.error, /not opened/);
    assert.equal((await checkInVia(fakeDb({ checkIn: { ok: false, code: 'NOT_YOURS' } }))).statusCode, 403);
    assert.equal((await checkInVia(fakeDb(), { match_id: 'nope' })).statusCode, 400);
    assert.equal((await checkInVia(fakeDb({ enabled: false }))).statusCode, 403);
  });

  it('is routed from /api/drill and tournament duels have no rematch', () => {
    assert.match(read('api/drill.js'), /action === 'tournament_check_in'/);
    assert.match(read('api/_liveDuels.js'), /duel\.kind === 'tournament'.*no rematch/);
  });
});

/* ============================================================ SQL */

describe('tournament SQL (PGlite)', () => {
  let db;
  const id = (c, i) => `${c.repeat(8)}-0000-4000-8000-00000000000${i}`;
  const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(id);
  const X = id('f', 6);          // another level
  const HEAD = id('9', 7);       // centre head of CENTRE
  const BOSS = id('8', 8);       // director
  const CENTRE = '77777777-0000-4000-8000-000000000001';
  const OTHER_CENTRE = '77777777-0000-4000-8000-000000000002';

  const as = async (uid, fn, { net = false, head = false } = {}) => {
    await db.exec(`SET app.uid = '${uid}'; SET app.net = '${net ? 1 : 0}'; SET app.head = '${head ? 1 : 0}'; SET ROLE authenticated;`);
    try { return await fn(); } finally { await db.exec("RESET ROLE; SET app.net = '0'; SET app.head = '0';"); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const call = (uid, sql, params, opts) => as(uid, async () => (await one(sql, params)).r, opts);
  const state = (uid, t) => call(uid, 'SELECT public.tournament_state($1) AS r', [t]);
  const checkIn = async (match, uid) => (await one('SELECT public.tournament_check_in($1, $2) AS r', [match, uid])).r;
  const match = async (t, round, slot) => one('SELECT * FROM public.tournament_matches WHERE tournament_id = $1 AND round = $2 AND slot = $3', [t, round, slot]);
  const tick = (t) => db.query('SELECT public.tournament_tick($1)', [t]);
  const expire = (m) => db.query("UPDATE public.tournament_matches SET checkin_until = now() - interval '1 second' WHERE id = $1", [m]);

  async function newTournament({ players = [], startIn = '1 hour', closesIn = '30 minutes', opensIn = '-1 hour', max = 8, centre = null, level = 'Level 2' } = {}) {
    const t = await one(
      `INSERT INTO public.tournaments (name, level, max_players, centre_id, signup_opens_at, signup_closes_at, start_at, round_minutes)
       VALUES ('Cup', $1, $2, $3, now() + $4::interval, now() + $5::interval, now() + $6::interval, 10) RETURNING id`,
      [level, max, centre, opensIn, closesIn, startIn],
    );
    for (const [i, p] of players.entries()) {
      await db.query('INSERT INTO public.tournament_entries (tournament_id, student_id, joined_at) VALUES ($1, $2, now() + make_interval(secs => $3))', [t.id, p, i]);
    }
    return t.id;
  }
  /** Starts it now: the start time moves to the past and the next tick draws the bracket. */
  const start = (t) => db.query(
    "UPDATE public.tournaments SET signup_opens_at = now() - interval '3 hours', signup_closes_at = now() - interval '2 hours', start_at = now() - interval '1 hour' WHERE id = $1", [t]);
  /** A finished duel for a live match. */
  async function finishDuel(m, winner) {
    await db.query("UPDATE public.live_duels SET status = 'done', winner_id = $2, a_correct = 9, b_correct = 7 WHERE id = $1", [m.duel_id, winner]);
  }
  async function startDuel(m) {
    const d = await one("INSERT INTO public.live_duels (kind, status, a_id, b_id) VALUES ('tournament', 'live', $1, $2) RETURNING id", [m.a_id, m.b_id]);
    assert.equal((await one('SELECT public.tournament_attach_duel($1, $2) AS r', [m.id, d.id])).r, true);
    return { ...m, duel_id: d.id };
  }

  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
      CREATE TABLE public.centres (id uuid PRIMARY KEY, name text, status text DEFAULT 'active');
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, level text, full_name text, student_code text,
        avatar_path text, centre_id uuid);
      CREATE TABLE public.student_badges (student_id uuid, badge_key text, PRIMARY KEY (student_id, badge_key));
      CREATE TABLE public.badge_catalogue (key text PRIMARY KEY, name text, icon text, description text, category text, sort_order int);
      CREATE TABLE public.duel_ratings (student_id uuid PRIMARY KEY, rating integer NOT NULL DEFAULT 1000);
      CREATE TABLE public.student_xp_events (student_id uuid, day date, xp integer);
      CREATE TABLE public.reward_redemptions (student_id uuid, cost integer, status text);
      CREATE TABLE public.live_duels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL CHECK (kind IN ('quick', 'challenge', 'ghost', 'rematch')),
        status text NOT NULL DEFAULT 'live', a_id uuid, b_id uuid, winner_id uuid, a_correct int, b_correct int,
        CHECK (b_id IS NOT NULL OR kind = 'ghost'));
      CREATE FUNCTION public.display_name_for(p_name text, p_code text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_name, p_code) $$;
      CREATE FUNCTION public.avatar_visible(p_student uuid, p_path text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p_path $$;
      CREATE FUNCTION public.is_network_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.net', true) = '1' $$;
      CREATE FUNCTION public.my_centre() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT centre_id FROM public.profiles WHERE id = auth.uid() $$;
      CREATE FUNCTION public.is_centre_head(p_centre uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT public.is_network_admin() OR (current_setting('app.head', true) = '1' AND public.my_centre() = p_centre) $$;
      CREATE FUNCTION public.is_teacher(p_uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE TABLE public.sent (topic text, event text, payload jsonb);
      CREATE FUNCTION public.live_duel_send(p_topic text, p_event text, p_payload jsonb) RETURNS void LANGUAGE sql AS $$
        INSERT INTO public.sent VALUES (p_topic, p_event, p_payload) $$;
      CREATE FUNCTION public.live_duel_settle(p_duel uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    `);
    await db.exec(SQL);
    await db.query("INSERT INTO public.centres (id, name) VALUES ($1, 'North'), ($2, 'South')", [CENTRE, OTHER_CENTRE]);
    await db.query(
      `INSERT INTO public.profiles (id, role, level, full_name, centre_id) VALUES
        ($1, 'student', 'Level 2', 'Asha', $8), ($2, 'student', 'Level 2', 'Ben', $8), ($3, 'student', 'Level 2', 'Cara', $8),
        ($4, 'student', 'Level 2', 'Dev', $9), ($5, 'student', 'Level 2', 'Esha', $8), ($6, 'student', 'Level 3', 'Xen', $8),
        ($7, 'centre_head', NULL, 'Head', $8)`,
      [A, B, C, D, E, X, HEAD, CENTRE, OTHER_CENTRE],
    );
    await db.query('INSERT INTO public.profiles (id, role, full_name) VALUES ($1, $2, $3)', [BOSS, 'director', 'Boss']);
    await db.query('INSERT INTO public.duel_ratings VALUES ($1, 1200), ($2, 1100), ($3, 1000), ($4, 900), ($5, 800)', [A, B, C, D, E]);
  });
  after(async () => { await db?.close(); });

  it('applies twice, keeps the other duel checks and adds the badges', async () => {
    await db.exec(SQL);
    const checks = (await db.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'public.live_duels'::regclass AND contype = 'c'")).rows.map((r) => r.d);
    assert.equal(checks.length, 2);
    assert.ok(checks.some((d) => d.includes("'tournament'")));
    assert.ok(checks.some((d) => d.includes("'ghost'") && !d.includes("'rematch'")));
    assert.equal((await one("SELECT count(*)::int AS n FROM public.badge_catalogue WHERE key LIKE 'tourney_%'")).n, 3);
  });

  it('matches the JS rules for brackets and seeding', async () => {
    for (const n of [4, 8, 16, 32]) {
      assert.deepEqual((await one('SELECT public.tournament_seed_order($1) AS o', [n])).o, seedOrder(n));
    }
    for (const [n, cap] of [[2, 32], [5, 32], [9, 32], [17, 32], [12, 8]]) {
      assert.equal((await one('SELECT public.tournament_bracket_size($1, $2) AS s', [n, cap])).s, bracketSize(n, cap));
    }
    assert.match(SQL, /WHEN 'champion' THEN 500 WHEN 'finalist' THEN 250 ELSE 100/);
    assert.deepEqual(TOURNAMENT_PRIZES, { champion: 500, finalist: 250, semi: 100 });
  });

  it('keeps the tables and internals away from students', async () => {
    await assert.rejects(as(A, () => db.query('SELECT * FROM public.tournament_matches')));
    await assert.rejects(as(A, () => db.query('SELECT * FROM public.reward_credits')));
    await assert.rejects(as(A, () => db.query('SELECT public.tournament_tick(gen_random_uuid())')));
    await assert.rejects(as(A, () => db.query('SELECT public.tournament_check_in(gen_random_uuid(), $1)', [A])));
  });

  it('lets only admins, directors and centre heads create, centre heads for their centre', async () => {
    const args = [CENTRE];
    const sql = `SELECT public.tournament_create('Speed Cup', 'Level 2', 16, $1, now(), now() + interval '1 hour', now() + interval '2 hours') AS r`;
    await assert.rejects(call(A, sql, args), /Only admins, directors and centre heads/);
    await assert.rejects(call(HEAD, sql, [OTHER_CENTRE], { head: true }), /Only admins/);
    await assert.rejects(call(HEAD, sql, [null], { head: true }), /every centre/);
    const mine = await call(HEAD, sql, args, { head: true });
    const all = await call(BOSS, sql, [null], { net: true });
    assert.ok(mine && all);
    await assert.rejects(call(BOSS, `SELECT public.tournament_create('Cup', 'Level 2', 12, NULL, now(), now() + interval '1 hour', now() + interval '2 hours') AS r`, [], { net: true }), /8, 16 or 32/);
    await assert.rejects(call(BOSS, `SELECT public.tournament_create('Cup', 'Level 2', 8, NULL, now(), now() + interval '3 hours', now() + interval '2 hours') AS r`, [], { net: true }), /close by the start/);
    const staff = await call(HEAD, 'SELECT public.tournaments_staff() AS r', [], { head: true });
    assert.equal(staff.can_create, true);
    assert.equal(staff.all_centres, false);
    assert.deepEqual(staff.centres.map((c) => c.name), ['North']);
    assert.deepEqual(staff.levels, ['Level 2', 'Level 3']);
    assert.ok(staff.tournaments.some((t) => t.id === mine && t.can_manage));
    assert.equal((await call(HEAD, 'SELECT public.tournament_cancel($1) AS r', [mine], { head: true })).ok, true);
    await assert.rejects(call(HEAD, 'SELECT public.tournament_cancel($1) AS r', [all], { head: true }), /Not allowed/);
    await db.query("UPDATE public.tournaments SET status = 'cancelled' WHERE id = $1", [all]);
  });

  it('signs up only students at the level and centre, while sign-up is open', async () => {
    const t = await newTournament({ centre: CENTRE, max: 8 });
    assert.equal((await call(A, 'SELECT public.tournament_join($1) AS r', [t])).ok, true);
    assert.equal((await call(A, 'SELECT public.tournament_join($1) AS r', [t])).ok, true, 'joining twice is fine');
    await assert.rejects(call(X, 'SELECT public.tournament_join($1) AS r', [t]), /not open to you/, 'other level');
    await assert.rejects(call(D, 'SELECT public.tournament_join($1) AS r', [t]), /not open to you/, 'other centre');
    const home = await call(A, 'SELECT public.my_tournaments() AS r', []);
    const card = home.tournaments.find((x) => x.id === t);
    assert.equal(card.joined, true);
    assert.equal(card.count, 1);
    assert.equal(card.centre_name, 'North');
    assert.equal((await call(D, 'SELECT public.my_tournaments() AS r', [])).tournaments.some((x) => x.id === t), false);
    assert.equal((await call(A, 'SELECT public.tournament_leave($1) AS r', [t])).ok, true);
    const closed = await newTournament({ closesIn: '-1 minute' });
    await assert.rejects(call(A, 'SELECT public.tournament_join($1) AS r', [closed]), /closed/);
    const full = await newTournament({ players: [A, B, C, E, id('1', 1), id('2', 2), id('3', 3), id('4', 4)].slice(0, 4) });
    await db.query('UPDATE public.tournaments SET max_players = 8 WHERE id = $1', [full]);
    for (let i = 1; i <= 4; i += 1) {
      await db.query("INSERT INTO public.profiles (id, role, level) VALUES ($1, 'student', 'Level 2') ON CONFLICT DO NOTHING", [id(String(i), i)]);
      await db.query('INSERT INTO public.tournament_entries (tournament_id, student_id) VALUES ($1, $2)', [full, id(String(i), i)]);
    }
    await assert.rejects(call(D, 'SELECT public.tournament_join($1) AS r', [full]), /full/);
    for (const x of [t, closed, full]) await db.query("UPDATE public.tournaments SET status = 'cancelled' WHERE id = $1", [x]);
  });

  it('cancels at the start with fewer than 4 players', async () => {
    const t = await newTournament({ players: [A, B, C] });
    await start(t);
    const s = await state(A, t);
    assert.equal(s.status, 'cancelled');
    assert.match(s.note, /Fewer than 4/);
  });

  it('runs a 5-player tournament: seeds, byes, forfeit, no-show, duels, prizes', async () => {
    const t = await newTournament({ players: [E, D, C, B, A] });
    assert.equal((await state(A, t)).rounds, null, 'not drawn before the start');
    await start(t);
    let s = await state(A, t);
    assert.equal(s.status, 'running');
    assert.equal(s.bracket_size, 8);
    assert.equal(s.rounds, 3);
    assert.deepEqual(s.entries.map((e) => [e.name, e.seed]), [['Asha', 1], ['Ben', 2], ['Cara', 3], ['Dev', 4], ['Esha', 5]]);

    // Round 1: seeds 1, 2, 3 have byes; 4 v 5 plays.
    const r1 = s.matches.filter((m) => m.round === 1);
    assert.deepEqual(r1.map((m) => [m.a_seed, m.b_seed, m.status, m.how]),
      [[1, null, 'done', 'bye'], [4, 5, 'ready', null], [2, null, 'done', 'bye'], [3, null, 'done', 'bye']]);
    assert.ok((await one("SELECT count(*)::int AS n FROM public.sent WHERE event = 'tournament_ready'")).n >= 2);
    const r2b = await match(t, 2, 1);
    assert.deepEqual([r2b.a_id, r2b.b_id, r2b.status], [B, C, 'ready'], 'two byes meet in round 2');

    // 4 v 5: Dev checks in, Esha never does.
    const dve = await match(t, 1, 1);
    assert.equal((await checkIn(dve.id, A)).code, 'NOT_YOURS');
    assert.deepEqual(await checkIn(dve.id, D), { ok: true, start: false, waiting: true });
    await expire(dve.id);
    assert.equal((await checkIn(dve.id, E)).code, 'CLOSED', 'check-in settles the expired match first');
    await tick(t);
    const dveDone = await match(t, 1, 1);
    assert.deepEqual([dveDone.winner_id, dveDone.how], [D, 'forfeit']);
    const r2a = await match(t, 2, 0);
    assert.deepEqual([r2a.a_id, r2a.b_id, r2a.a_seed, r2a.b_seed, r2a.status], [A, D, 1, 4, 'ready']);

    // Semi B v C: both check in, exactly one call starts the duel, Cara wins it.
    assert.equal((await checkIn(r2b.id, B)).start, false);
    const both = await checkIn(r2b.id, C);
    assert.equal(both.start, true);
    assert.deepEqual([both.a_id, both.b_id, both.level], [B, C, 'Level 2']);
    assert.equal((await checkIn(r2b.id, B)).start, false, 'a second caller does not start another duel');
    const semi = await startDuel(r2b);
    assert.equal((await checkIn(r2b.id, B)).duel_id, semi.duel_id);
    s = await state(B, t);
    const card = s.matches.find((m) => m.id === r2b.id);
    assert.equal(card.status, 'live');
    await finishDuel(semi, C);
    await tick(t);
    assert.deepEqual(Object.values(await one('SELECT winner_id, how FROM public.tournament_matches WHERE id = $1', [r2b.id])), [C, 'duel']);
    assert.equal((await one('SELECT finish FROM public.tournament_entries WHERE tournament_id = $1 AND student_id = $2', [t, B])).finish, 'semi');

    // Semi A v D: nobody checks in, the higher seed (Asha) goes through.
    await expire(r2a.id);
    await tick(t);
    assert.deepEqual(Object.values(await one('SELECT winner_id, how FROM public.tournament_matches WHERE id = $1', [r2a.id])), [A, 'no_show']);

    // Final A v C: a drawn duel goes to the higher seed.
    const final = await match(t, 3, 0);
    assert.deepEqual([final.a_id, final.b_id, final.status], [A, C, 'ready']);
    await checkIn(final.id, A);
    assert.equal((await checkIn(final.id, C)).start, true);
    const fd = await startDuel(final);
    await db.query("UPDATE public.live_duels SET status = 'done', winner_id = NULL WHERE id = $1", [fd.duel_id]);
    s = await state(C, t);
    assert.equal(s.status, 'done');
    assert.equal(s.champion, 'Asha');
    assert.equal(s.matches.find((m) => m.round === 3).how, 'seed');
    assert.deepEqual(s.entries.map((e) => [e.name, e.finish, e.out_round]),
      [['Asha', 'champion', null], ['Ben', 'semi', 2], ['Cara', 'finalist', 3], ['Dev', 'semi', 2], ['Esha', null, 1]]);

    const badges = (await db.query("SELECT student_id, badge_key FROM public.student_badges WHERE badge_key LIKE 'tourney_%' ORDER BY badge_key, student_id")).rows;
    assert.deepEqual(badges.map((b) => [b.student_id, b.badge_key]),
      [[A, 'tourney_champion'], [C, 'tourney_finalist'], [B, 'tourney_semi'], [D, 'tourney_semi']]);
    const bal = async (who) => Number((await one('SELECT balance FROM public.reward_balance($1)', [who])).balance);
    assert.deepEqual([await bal(A), await bal(C), await bal(B), await bal(D), await bal(E)], [500, 250, 100, 100, 0]);
    await tick(t);
    assert.equal(await bal(A), 500, 'prizes are given once');
    assert.equal((await call(A, 'SELECT public.my_tournaments() AS r', [])).titles, 1);
  });
});

/* ============================================================ page and view */

describe('tournament page', () => {
  it('has a Tournaments tab, a staff panel and the duel result link', () => {
    const page = read('pages/live-duel.html');
    assert.match(page, /data-ld-mode="tourney"/);
    assert.match(page, /id="ld-tourney"/);
    assert.match(page, /id="ld-staff-tourney"/);
    const js = read('js/liveDuel.js');
    assert.match(js, /const MODES = \['duel', 'ghost', 'royale', 'tourney'\]/);
    assert.match(js, /hub\.on\('tournament_ready'/);
    assert.match(read('js/duelPresence.js'), /'tournament_ready'\]/);
  });
});

describe('tournament view', async () => {
  const view = await import('../js/tournamentView.js');
  const { buildResultHtml } = await import('../js/liveDuelView.js');
  const T0 = Date.parse('2026-11-28T10:00:00Z');
  const iso = (s) => new Date(T0 + s * 1000).toISOString();
  const base = {
    id: 't1', name: 'Cup', level: 'Level 2', status: 'signup', max_players: 8, count: 3, centre_id: null,
    signup_opens_at: iso(-3600), signup_closes_at: iso(600), start_at: iso(1200), round_minutes: 10,
  };

  it('works out where a tournament is and shows sign-up buttons', () => {
    assert.equal(view.tournamentPhase({ ...base, signup_opens_at: iso(60) }, T0), 'soon');
    assert.equal(view.tournamentPhase(base, T0), 'open');
    assert.equal(view.tournamentPhase(base, T0 + 700000), 'closed');
    assert.equal(view.tournamentPhase({ ...base, status: 'running' }, T0), 'running');
    assert.match(view.buildTournamentCardHtml(base, T0), /data-tn-join="t1"/);
    assert.match(view.buildTournamentCardHtml(base, T0), /All centres/);
    const joined = view.buildTournamentCardHtml({ ...base, joined: true }, T0);
    assert.match(joined, /data-tn-leave="t1"/);
    assert.doesNotMatch(joined, /data-tn-join/);
    const ready = view.buildTournamentCardHtml({ ...base, status: 'running', joined: true, my_match: { status: 'ready' } }, T0);
    assert.match(ready, /Your match is ready/);
    assert.match(view.buildTournamentHomeHtml({ tournaments: [], titles: 2 }, T0), /No tournaments at your level/);
  });

  const running = {
    ...base, status: 'running', rounds: 2, bracket_size: 4,
    entries: [
      { id: 'me', me: true, name: 'Asha', seed: 1 }, { id: 'b', name: 'Ben', seed: 2 },
      { id: 'c', name: 'Cara', seed: 3 }, { id: 'd', name: 'Dev', seed: 4 },
    ],
    matches: [
      { id: 'm1', round: 1, slot: 0, status: 'ready', a_id: 'me', b_id: 'd', a_seed: 1, b_seed: 4, ready_at: iso(0), checkin_until: iso(180), a_in: false, b_in: true },
      { id: 'm2', round: 1, slot: 1, status: 'done', a_id: 'b', b_id: 'c', a_seed: 2, b_seed: 3, winner_id: 'c', how: 'forfeit' },
      { id: 'm3', round: 2, slot: 0, status: 'pending', a_id: null, b_id: 'c', b_seed: 3 },
    ],
  };

  it('shows the check-in card with its countdown, then the waiting and live states', () => {
    const html = view.buildMatchCardHtml(running, T0 + 60000);
    assert.match(html, /Your match is ready: Semi-finals vs Dev/);
    assert.match(html, /data-tn-checkin="m1"/);
    assert.match(html, /<b class="num">2:00<\/b>/);
    assert.match(html, /Dev is already in/);
    const early = view.buildMatchCardHtml({ ...running, matches: [{ ...running.matches[0], ready_at: iso(300) }] }, T0);
    assert.match(early, /Check-in opens at/);
    const waiting = view.buildMatchCardHtml({ ...running, matches: [{ ...running.matches[0], a_in: true, b_in: false }] }, T0);
    assert.match(waiting, /win by forfeit/);
    const live = view.buildMatchCardHtml({ ...running, matches: [{ ...running.matches[0], status: 'live', duel_id: 'd1' }] }, T0);
    assert.match(live, /data-tn-duel="d1"/);
  });

  it('shows byes, exits and the champion', () => {
    const bye = { ...running, rounds: 3, matches: [{ id: 'x', round: 1, slot: 0, status: 'done', a_id: 'me', b_id: null, how: 'bye', winner_id: 'me' }] };
    assert.match(view.buildMatchCardHtml(bye, T0), /Bye: you're through to the semi-finals[\s\S]*mode=ghost/);
    const out = { ...running, entries: [{ id: 'me', me: true, name: 'Asha', out_round: 1, finish: 'semi' }], matches: [] };
    assert.match(view.buildMatchCardHtml(out, T0), /out in the semi-finals[\s\S]*\+100 store balance/);
    const champ = { ...running, status: 'done', entries: [{ id: 'me', me: true, name: 'Asha', finish: 'champion' }], matches: [] };
    assert.match(view.buildMatchCardHtml(champ, T0), /You won Cup![\s\S]*\+500/);
  });

  it('draws the bracket with seeds, winners and how they won', () => {
    const html = view.buildBracketHtml(running, T0);
    assert.match(html, /--tn-rounds:3/);
    assert.match(html, /Semi-finals/);
    assert.match(html, /Final/);
    assert.match(html, /tn-slot is-won[\s\S]*Cara/);
    assert.match(html, /Won by forfeit/);
    assert.match(html, />You</);
    assert.match(html, /TBD/);
    assert.match(view.buildBracketHtml({ ...base, entries: [{ id: 'a', name: 'Asha' }] }, T0), /drawn at the start time/);
  });

  it('builds the staff form for creators only', () => {
    const data = { can_create: true, all_centres: true, centres: [{ id: 'c1', name: 'North' }], levels: ['Level 2'], tournaments: [{ ...base, can_manage: true }] };
    const html = view.buildTournamentStaffHtml(data, T0);
    assert.match(html, /data-tn-create/);
    assert.match(html, /<option value="">All centres<\/option>/);
    assert.match(html, /data-tn-cancel="t1"/);
    assert.match(html, /data-tn-open="t1"/);
    assert.doesNotMatch(view.buildTournamentStaffHtml({ ...data, can_create: false }, T0), /data-tn-create/);
    assert.doesNotMatch(view.buildTournamentStaffHtml({ ...data, all_centres: false }, T0), /All centres<\/option>/);
    assert.match(view.localInputValue(new Date(2026, 10, 28, 9, 5).getTime()), /^2026-11-28T09:05$/);
  });

  it('sends tournament duels back to the bracket instead of a rematch', () => {
    const html = buildResultHtml({ kind: 'tournament', result: 'won', me: { correct: 9 }, other: { correct: 7, rematch: true } });
    assert.match(html, /Back to the bracket/);
    assert.doesNotMatch(html, /data-rematch|wants a rematch/);
    assert.match(buildResultHtml({ kind: 'quick', result: 'won', me: {}, other: {} }), /data-rematch/);
  });
});
