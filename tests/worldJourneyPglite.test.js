/**
 * World layer migration on PGlite (supabase/migrations/*_world_journey_seasons.sql):
 *   - season windows: themed seasons replace the month; the month is clipped around them;
 *   - only owners/directors schedule seasons, never in the past, never overlapping;
 *   - journey stages count real XP events (by type and accuracy) from the island start;
 *   - the boss round opens at 5 of 6 stages, 3 tries a day; a paper is saved once;
 *     a pass flags the student and a teacher's review never changes profiles.level;
 *   - settling a themed season gives its badge, mascot outfit and podium;
 *   - leaderboard() is patched once (running the migration twice is safe);
 *   - the season board stays within the student's level and centre.
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { journeyStages } from '../shared/world.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migFile = fs.readdirSync(path.join(root, 'supabase/migrations')).find((f) => /_world_journey_seasons\.sql$/.test(f));
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations', migFile), 'utf8');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = { ADMIN: id(1), TEACHER: id(2), S1: id(11), S2: id(12), S3: id(13), S4: id(14) };
const C1 = id(901);
const C2 = id(902);
const CAT_ROUND = id(601);
const CAT_BASICS = id(602);

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE
    AS $$ SELECT COALESCE(nullif(current_setting('test.today', true), '')::date, current_date) $$;
  CREATE FUNCTION public.is_standard_student_level(l text) RETURNS boolean LANGUAGE sql IMMUTABLE
    AS $$ SELECT l IN ('KA-1','KA-2','KA-3','Level 1','Level 2','Level 3','Level 4','Level 5','Level 6','Graduate','Master','Grandmaster') $$;

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, student_code text, full_name text, role text NOT NULL, level text,
    active boolean NOT NULL DEFAULT true, leaderboard_visible boolean NOT NULL DEFAULT true, centre_id uuid
  );
  CREATE FUNCTION public.is_network_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;
  CREATE FUNCTION public.is_centre_admin(c uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.xp_can_view(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    AS $$ SELECT auth.uid() = p OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'teacher')) $$;
  CREATE FUNCTION public.display_name_for(n text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(n, c) $$;
  CREATE FUNCTION public.streak_calc(p uuid) RETURNS TABLE(current_streak int, best_streak int, shields int, active_today boolean)
    LANGUAGE sql STABLE AS $$ SELECT 0, 0, 0, false $$;
  CREATE FUNCTION public.period_bounds(p_period text, OUT d_from date, OUT d_to date) LANGUAGE sql STABLE
    AS $$ SELECT date_trunc('week', public.today_ist())::date, date_trunc('week', public.today_ist())::date + 6 $$;
  CREATE FUNCTION public.xp_season_tier(p_xp bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
    WITH t(name, floor_xp, ord) AS (VALUES ('Bronze', 0, 1), ('Silver', 300, 2), ('Gold', 1000, 3), ('Platinum', 2500, 4),
      ('Diamond', 5000, 5), ('Elite', 9000, 6), ('Legend', 15000, 7)),
    cur AS (SELECT * FROM t WHERE floor_xp <= GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp DESC LIMIT 1),
    nxt AS (SELECT * FROM t WHERE floor_xp > GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp ASC LIMIT 1)
    SELECT jsonb_build_object('name', cur.name, 'floor', cur.floor_xp, 'rank', cur.ord, 'next_name', nxt.name, 'next_floor', nxt.floor_xp)
      FROM cur LEFT JOIN nxt ON true $$;

  CREATE TABLE public.categories (id uuid PRIMARY KEY, name text, section text);
  CREATE TABLE public.results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid, category_id uuid, correct int, total int);
  CREATE TABLE public.student_xp_events (
    id bigserial PRIMARY KEY, student_id uuid NOT NULL, source text, source_id text, activity_key text, label text,
    correct int, total int, time_seconds numeric, day date NOT NULL, xp int NOT NULL DEFAULT 10,
    pb_score numeric, score_label text, is_personal_best boolean NOT NULL DEFAULT false, first_best boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.xp_seasons (season date PRIMARY KEY, settled_at timestamptz NOT NULL DEFAULT now(), players int,
    CONSTRAINT xp_seasons_first_day CHECK (extract(day FROM season) = 1));
  CREATE TABLE public.xp_season_results (season date, student_id uuid, level text, xp bigint, tier text, tier_rank smallint,
    level_rank int, level_size int, rounds int, practice_days int, new_bests int, PRIMARY KEY (season, student_id));
  CREATE TABLE public.badge_catalogue (key text PRIMARY KEY, name text, icon text, description text, category text, sort_order int);
  CREATE TABLE public.student_badges (student_id uuid, badge_key text, earned_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (student_id, badge_key));

  -- A small stand-in with the same signature and the same XP date filter as the real leaderboard().
  CREATE FUNCTION public.leaderboard(p_board text, p_period text DEFAULT 'week', p_level text DEFAULT NULL, p_limit integer DEFAULT 10, p_scope text DEFAULT 'level')
   RETURNS TABLE(student_id uuid, value numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $fn$
  DECLARE v_from date; v_to date; v_today date := public.today_ist();
  BEGIN
    IF COALESCE(p_period, 'week') = 'month' THEN
      v_from := date_trunc('month', v_today)::date; v_to := (date_trunc('month', v_today) + interval '1 month')::date - 1;
    ELSE SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds('week') b; END IF;
    RETURN QUERY SELECT x.student_id, sum(x.xp)::numeric FROM public.student_xp_events x
      WHERE x.day BETWEEN v_from AND v_to GROUP BY x.student_id ORDER BY 2 DESC;
  END $fn$;
`;

async function as(db, uid) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec('SET ROLE authenticated');
}
async function sys(db) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
}
async function today(db, day) {
  await db.query("SELECT set_config('test.today', $1, false)", [day]);
}
async function call(db, uid, sql, params = []) {
  await as(db, uid);
  try {
    return { ok: true, rows: (await db.query(sql, params)).rows };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await sys(db);
  }
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION);
  await db.query(
    `INSERT INTO public.profiles (id, full_name, role, level, centre_id) VALUES
      ($1, 'Owner', 'admin', NULL, NULL), ($2, 'Teacher T', 'teacher', NULL, $7),
      ($3, 'Asha', 'student', 'Level 2', $7), ($4, 'Bilal', 'student', 'Level 2', $7),
      ($5, 'Chen', 'student', 'Level 2', $8), ($6, 'Dev', 'student', 'Level 3', $7)`,
    [P.ADMIN, P.TEACHER, P.S1, P.S2, P.S3, P.S4, C1, C2],
  );
  await db.query("INSERT INTO public.categories VALUES ($1, 'ADD', 'round'), ($2, '2d4r', 'basics')", [CAT_ROUND, CAT_BASICS]);
  return db;
}

async function addResultEvent(db, student, cat, correct, total, day = '2026-11-20') {
  const [{ id: rid }] = (await db.query('INSERT INTO public.results (student_id, category_id, correct, total) VALUES ($1, $2, $3, $4) RETURNING id', [student, cat, correct, total])).rows;
  await db.query("INSERT INTO public.student_xp_events (student_id, source, source_id, activity_key, correct, total, day) VALUES ($1, 'result', $2, 'cat:x:t60', $3, $4, $5)", [student, rid, correct, total, day]);
}
async function addEvent(db, student, key, correct, total, day = '2026-11-20', xp = 10) {
  await db.query("INSERT INTO public.student_xp_events (student_id, source, source_id, activity_key, correct, total, day, xp) VALUES ($1, 'activity', gen_random_uuid()::text, $2, $3, $4, $5, $6)", [student, key, correct, total, day, xp]);
}

describe('world layer migration', () => {
  let db;
  before(async () => {
    db = await freshDb();
  });

  it('seeds the same stages as shared/world.js journeyStages()', async () => {
    const rows = (await db.query('SELECT level, ord, kind, rounds_needed, min_accuracy FROM public.journey_stages ORDER BY level, ord')).rows;
    assert.equal(rows.length, 72);
    for (const r of rows) {
      const js = journeyStages(r.level).find((s) => s.ord === r.ord);
      assert.deepEqual([r.kind, r.rounds_needed, r.min_accuracy], [js.kind, js.rounds_needed, js.min_accuracy], `${r.level} ${r.ord}`);
    }
  });

  it('runs a second time without changing anything (leaderboard patched once)', async () => {
    await db.exec(MIGRATION);
    const def = (await db.query("SELECT pg_get_functiondef('public.leaderboard(text,text,text,integer,text)'::regprocedure) AS d")).rows[0].d;
    assert.equal(def.split('public.season_bounds(v_today)').length - 1, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.journey_stages')).rows[0].n, 72);
  });

  it('only owners and directors schedule seasons, starting tomorrow or later, never overlapping', async () => {
    await today(db, '2026-11-10');
    const r1 = await call(db, P.S1, "SELECT public.season_save('Space Season', 'space', '2026-11-15')");
    assert.equal(r1.ok, false);
    const r2 = await call(db, P.TEACHER, "SELECT public.season_save('Space Season', 'space', '2026-11-15')");
    assert.equal(r2.ok, false);
    const r3 = await call(db, P.ADMIN, "SELECT public.season_save('Past', 'space', '2026-11-10')");
    assert.match(r3.error, /tomorrow/);
    const ok = await call(db, P.ADMIN, "SELECT public.season_save('Space Season', 'space', '2026-11-15', NULL, 300) AS id");
    assert.equal(ok.ok, true, ok.error);
    const clash = await call(db, P.ADMIN, "SELECT public.season_save('Ocean', 'ocean', '2027-01-09')");
    assert.match(clash.error, /overlaps/);
    const s = (await db.query('SELECT * FROM public.themed_seasons')).rows[0];
    assert.equal(s.ends_on.toISOString().slice(0, 10), '2027-01-09');
    const badge = (await db.query('SELECT * FROM public.badge_catalogue WHERE key = $1', [s.badge_key])).rows[0];
    assert.equal(badge.icon, '🚀');
    assert.equal(badge.category, 'season');
  });

  it('season windows: themed season, month before it clipped, month after it clipped', async () => {
    const w = async (d) => {
      const r = (await db.query('SELECT s_from::text, s_to::text, name FROM public.season_bounds($1)', [d])).rows[0];
      return [r.s_from, r.s_to, r.name];
    };
    assert.deepEqual(await w('2026-11-05'), ['2026-11-01', '2026-11-14', null]);
    assert.deepEqual(await w('2026-12-25'), ['2026-11-15', '2027-01-09', 'Space Season']);
    assert.deepEqual(await w('2027-01-20'), ['2027-01-10', '2027-01-31', null]);
    assert.deepEqual(await w('2027-03-03'), ['2027-03-01', '2027-03-31', null]);
  });

  it('journey stages count qualifying practice only, and the boss opens at 5 of 6 stages', async () => {
    await today(db, '2026-11-20');
    await db.query("INSERT INTO public.journey_level_starts (student_id, level, started_at) VALUES ($1, 'Level 2', now() - interval '1 day')", [P.S1]);
    for (let i = 0; i < 4; i += 1) await addResultEvent(db, P.S1, CAT_ROUND, 9, 10);
    await addResultEvent(db, P.S1, CAT_ROUND, 3, 10); // under 70%: does not count
    for (let i = 0; i < 4; i += 1) await addResultEvent(db, P.S1, CAT_BASICS, 8, 10);
    for (let i = 0; i < 3; i += 1) await addEvent(db, P.S1, 'flash:2d:5:visual', 7, 10);
    await addEvent(db, P.S1, 'jm:senior:main', 60, 100);
    await addEvent(db, P.S1, 'mem:numbers', 10, 20);
    await addEvent(db, P.S1, 'mem:numbers', 12, 20);

    let check = (await db.query('SELECT public.journey_boss_check($1) AS c', [P.S1])).rows[0].c;
    assert.equal(check.ok, false); // flash 3 of 4, oral 0 of 2: 4 stages cleared
    const w = (await call(db, P.S1, 'SELECT public.my_world() AS w')).rows[0].w;
    assert.deepEqual(w.stages.map((s) => Number(s.done)), [4, 4, 3, 1, 2, 0]);

    await addEvent(db, P.S1, 'flash:2d:5:visual', 7, 10);
    check = (await db.query('SELECT public.journey_boss_check($1) AS c', [P.S1])).rows[0].c;
    assert.equal(check.ok, true);
    assert.equal(check.level, 'Level 2');

    const other = await call(db, P.S2, 'SELECT public.my_world($1) AS w', [P.S1]);
    assert.match(other.error, /Access denied/);
  });

  it('saves a paper once, flags a pass, and a teacher review never changes the level', async () => {
    const mk = async () => (await db.query(
      "INSERT INTO public.journey_sessions (student_id, kind, level, questions, started_at, expires_at) VALUES ($1, 'boss', 'Level 2', '[]', '2026-11-20 06:00+00', now() + interval '10 minutes') RETURNING id",
      [P.S1],
    )).rows[0].id;
    const sid = await mk();
    const fin = (args) => db.query('SELECT public.journey_finish_session($1, $2, $3, $4, $5, $6, $7, $8) AS r', args);
    const r1 = (await fin([sid, P.S1, '[]', 15, 17, 88.2, true, '{}'])).rows[0].r;
    assert.equal(r1.ok, true);
    const r2 = (await fin([sid, P.S1, '[]', 17, 17, 100, true, '{}'])).rows[0].r;
    assert.equal(r2.ok, false); // only once
    const flag = (await db.query('SELECT status, percent FROM public.journey_levelup_flags WHERE student_id = $1', [P.S1])).rows[0];
    assert.equal(flag.status, 'pending');

    await mk();
    await mk(); // three boss sessions today
    const check = (await db.query('SELECT public.journey_boss_check($1) AS c', [P.S1])).rows[0].c;
    assert.match(check.reason, /3 times/);

    assert.equal((await call(db, P.S1, "SELECT public.journey_levelup_review($1, 'Level 2', 'agreed')", [P.S1])).ok, false);
    const ok = await call(db, P.TEACHER, "SELECT public.journey_levelup_review($1, 'Level 2', 'agreed', 'Well done')", [P.S1]);
    assert.equal(ok.ok, true, ok.error);
    const p = (await db.query('SELECT level FROM public.profiles WHERE id = $1', [P.S1])).rows[0];
    assert.equal(p.level, 'Level 2');
    const board = (await call(db, P.TEACHER, 'SELECT public.journey_staff_board() AS b')).rows[0].b;
    assert.equal(board.flags[0].status, 'agreed');
    assert.equal(board.attempts.length, 1);
    assert.equal((await call(db, P.S1, 'SELECT public.journey_staff_board()')).ok, false);
  });

  it('students pick any mascot, but only outfits they earned', async () => {
    assert.equal((await call(db, P.S2, "SELECT public.set_my_mascot('dragon')")).ok, true);
    assert.match((await call(db, P.S2, "SELECT public.set_my_mascot('dragon', 'space')")).error, /not earned/);
    assert.equal((await call(db, P.S2, "SELECT public.set_my_mascot('unicorn')")).ok, false);
    assert.equal((await call(db, P.TEACHER, "SELECT public.set_my_mascot('owl')")).ok, false);
  });

  it('the season board covers the student’s own level and centre', async () => {
    await today(db, '2026-11-20');
    await addEvent(db, P.S2, 'flash:1d:3:visual', 5, 5, '2026-11-20', 400);
    await addEvent(db, P.S3, 'flash:1d:3:visual', 5, 5, '2026-11-20', 900); // other centre
    await addEvent(db, P.S4, 'flash:1d:3:visual', 5, 5, '2026-11-20', 700); // other level
    const b = (await call(db, P.S1, "SELECT public.season_board('Level 3', $1) AS b", [C2])).rows[0].b;
    assert.equal(b.level, 'Level 2');
    assert.equal(b.name, 'Space Season');
    const names = b.rows.map((r) => r.display_name);
    assert.deepEqual(names, ['Bilal', 'Asha']); // 400 XP, then 160 XP
    const totals = (await db.query('SELECT public.xp_totals($1) AS t', [P.S1])).rows[0].t;
    assert.equal(totals.season.name, 'Space Season');
    assert.equal(totals.season.from, '2026-11-15');
  });

  it('settles windows in order and gives the themed season rewards', async () => {
    await addEvent(db, P.S2, 'flash:1d:3:visual', 5, 5, '2026-11-05', 50); // the clipped month window
    await today(db, '2027-01-20');
    const n = (await db.query('SELECT public.xp_settle_seasons() AS n')).rows[0].n;
    assert.equal(n, 2);
    const seasons = (await db.query('SELECT season::text, ends_on::text, themed_id IS NOT NULL AS themed FROM public.xp_seasons ORDER BY season')).rows;
    assert.deepEqual(seasons, [
      { season: '2026-11-01', ends_on: '2026-11-14', themed: false },
      { season: '2026-11-15', ends_on: '2027-01-09', themed: true },
    ]);
    const s = (await db.query('SELECT badge_key FROM public.themed_seasons')).rows[0];
    const badged = (await db.query('SELECT student_id FROM public.student_badges WHERE badge_key = $1 ORDER BY student_id', [s.badge_key])).rows.map((r) => r.student_id);
    assert.deepEqual(badged, [P.S2, P.S3, P.S4]); // badge XP 300; Asha has 160
    const items = (await db.query("SELECT count(*)::int AS n FROM public.world_mascot_items WHERE item_key = 'space'")).rows[0].n;
    assert.equal(items, 3);
    const pods = (await db.query("SELECT student_id, place FROM public.season_podiums WHERE season = '2026-11-15' ORDER BY centre_id, level, place")).rows;
    assert.deepEqual(pods.map((p) => [p.student_id, p.place]), [[P.S2, 1], [P.S1, 2], [P.S4, 1], [P.S3, 1]]);
    assert.equal((await db.query('SELECT public.xp_settle_seasons() AS n')).rows[0].n, 0);
    const recap = (await call(db, P.S2, 'SELECT public.my_xp_summary() AS s')).rows[0].s;
    assert.equal(recap.season_recap, null); // 11 days after the season ended
    await today(db, '2027-01-12');
    const fresh = (await call(db, P.S2, 'SELECT public.my_xp_summary() AS s')).rows[0].s;
    assert.equal(fresh.season_recap.name, 'Space Season');
    assert.equal(fresh.seasons[0].name, 'Space Season');
  });

  it('themed tiers scale with the season length', async () => {
    const t = (await db.query('SELECT public.xp_season_tier_for(1000, 56, true) AS t, public.xp_season_tier_for(1000, 30, false) AS m')).rows[0];
    assert.equal(t.t.name, 'Silver'); // 1000 XP over 8 weeks is less than Gold
    assert.equal(t.m.name, 'Gold');
    assert.equal(Number(t.t.next_floor), 1870);
  });

  it('a season can be cancelled only before it starts', async () => {
    await today(db, '2027-01-20');
    const r = await call(db, P.ADMIN, 'SELECT public.season_cancel(1)');
    assert.match(r.error, /not started/);
    const id2 = (await call(db, P.ADMIN, "SELECT public.season_save('Ocean Season', 'ocean', '2027-03-01') AS id")).rows[0].id;
    assert.equal((await call(db, P.ADMIN, 'SELECT public.season_cancel($1)', [id2])).ok, true);
    const w = (await db.query("SELECT s_from::text FROM public.season_bounds('2027-03-05')")).rows[0];
    assert.equal(w.s_from, '2027-03-01'); // back to the month
  });
});
