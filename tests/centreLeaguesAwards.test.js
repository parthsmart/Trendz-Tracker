/**
 * Multi-centre step 5b: leagues, Star of the Month and Champion of the Week per centre.
 *
 *  - migration 39 on PGlite after migrations 30, 32 and 33, with the pre-39
 *    production definitions (the rollback file) as the starting point;
 *  - league groups never mix two centres; students, teachers and centre heads see
 *    their own centre; owners and directors see every centre;
 *  - week and month winners are settled per centre and level, and star_of_month
 *    shows only your own centre's winners; older awards get their centre filled in;
 *  - escalation: students cannot widen the view or call the internal functions;
 *  - the rollback brings back the network-wide behaviour without losing data.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const MIGRATION_39 = read('supabase/migrations/39_centre_leagues_awards.sql');
const ROLLBACK_39 = read('supabase/rollbacks/39_centre_leagues_awards_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1), DIRECTOR: id(2),
  HEAD_B: id(10), TCH_B: id(12), STU_B1: id(13), STU_B2: id(14), STU_B3: id(15),
  HEAD_K: id(20), TCH_K: id(21), STU_K: id(22),
};

// Last week (settled) and this week (live board).
const LAST_WEEK = "(date_trunc('week', current_date)::date - 7)";
const THIS_WEEK = "date_trunc('week', current_date)::date";
const LAST_MONTH = "(date_trunc('month', current_date) - interval '1 month')::date";

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE FUNCTION public.is_standard_student_level(l text) RETURNS boolean LANGUAGE sql IMMUTABLE
    AS $$ SELECT l IN ('Level 1', 'Level 2', 'Level 3', 'Master') $$;

  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY,
    student_code text UNIQUE,
    full_name text,
    role text NOT NULL,
    level text,
    active boolean NOT NULL DEFAULT true,
    leaderboard_visible boolean NOT NULL DEFAULT true,
    avatar_path text,
    deleted_at timestamptz,
    deleted_by uuid,
    CONSTRAINT profiles_role_check CHECK (role IN ('student', 'teacher', 'admin')),
    CONSTRAINT profiles_level_allowed CHECK (level IS NULL OR public.is_standard_student_level(level)
      OR (role = 'teacher' AND level = 'Teacher') OR (role = 'admin' AND level = 'Admin'))
  );
  CREATE TABLE public.teacher_student_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    UNIQUE (teacher_id, student_id)
  );
  CREATE TABLE public.teacher_permissions (
    teacher_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    can_view_students boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );
  CREATE TABLE public.student_xp_events (student_id uuid, day date, xp int);
  CREATE TABLE public.student_badges (student_id uuid, badge_key text, PRIMARY KEY (student_id, badge_key));
  CREATE TABLE public.league_tiers (tier smallint PRIMARY KEY, name text, icon text);
  INSERT INTO public.league_tiers VALUES (1, 'Bronze', 'b'), (2, 'Silver', 's'), (3, 'Gold', 'g'), (4, 'Ruby', 'r'), (5, 'Galaxy', 'x');
  CREATE TABLE public.student_leagues (student_id uuid PRIMARY KEY, tier smallint NOT NULL DEFAULT 1, updated_at timestamptz);
  CREATE TABLE public.league_weeks (week_start date PRIMARY KEY);
  CREATE TABLE public.league_results (
    week_start date, student_id uuid, tier_before smallint, tier_after smallint, group_no integer,
    rank integer, group_size integer, xp bigint, PRIMARY KEY (week_start, student_id));
  CREATE TABLE public.xp_award_periods (kind text, period_start date, period_end date, PRIMARY KEY (kind, period_start));
  CREATE TABLE public.xp_awards (
    id bigserial PRIMARY KEY, kind text NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
    level text, student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, xp bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX xp_awards_unique_idx ON public.xp_awards (kind, period_start, COALESCE(level, ''), student_id);
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.is_teacher(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'teacher' AND active FROM public.profiles WHERE id = u), false) $$;
  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_date $$;
  CREATE FUNCTION public.display_name_for(n text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT n $$;
  CREATE FUNCTION public.avatar_visible(s uuid, p text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p $$;
  CREATE FUNCTION public.global_leaderboard_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.league_zone(p_tier smallint, p_rank integer, p_size integer, p_xp bigint) RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN p_rank = 1 AND p_xp > 0 AND p_tier < 5 THEN 'up'
                  WHEN p_size >= 3 AND p_rank = p_size AND p_tier > 1 THEN 'down' ELSE '' END $$;
  CREATE FUNCTION public.league_settle() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.xp_settle_awards() RETURNS void LANGUAGE sql AS $$ SELECT $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN RETURN NEW; END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.OWNER}', 'ADMIN01', 'Owner', 'admin', 'Admin'),
    ('${P.DIRECTOR}', 'DIR01', 'Director', 'student', NULL),
    ('${P.HEAD_B}', 'HEADB', 'Head Baran', 'student', NULL),
    ('${P.TCH_B}', 'TCHB', 'Teacher Baran', 'teacher', 'Teacher'),
    ('${P.STU_B1}', 'STUB1', 'Asha', 'student', 'Level 1'),
    ('${P.STU_B2}', 'STUB2', 'Ravi', 'student', 'Level 1'),
    ('${P.STU_B3}', 'STUB3', 'Meera', 'student', 'Level 2'),
    ('${P.HEAD_K}', 'HEADK', 'Head Kota', 'student', NULL),
    ('${P.TCH_K}', 'TCHK', 'Teacher Kota', 'teacher', 'Teacher'),
    ('${P.STU_K}', 'STUK', 'Kiran', 'student', 'Level 1');

  -- Kiran (Kota) has the most XP of the whole network in both weeks and last month.
  INSERT INTO public.student_xp_events VALUES
    ('${P.STU_B1}', ${LAST_WEEK}, 30), ('${P.STU_B2}', ${LAST_WEEK}, 20), ('${P.STU_K}', ${LAST_WEEK}, 90),
    ('${P.STU_B3}', ${LAST_WEEK}, 10),
    ('${P.STU_B1}', ${THIS_WEEK}, 30), ('${P.STU_B2}', ${THIS_WEEK}, 20), ('${P.STU_K}', ${THIS_WEEK}, 90),
    ('${P.STU_B1}', ${LAST_MONTH}, 300), ('${P.STU_B2}', ${LAST_MONTH}, 200), ('${P.STU_K}', ${LAST_MONTH}, 900);
`;

async function as(db, uid, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec(`SET ROLE ${role}`);
}

async function rows(db, sql, params = []) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  return (await db.query(sql, params)).rows;
}

async function q(db, uid, sql, params = []) {
  await as(db, uid);
  try {
    return { ok: true, rows: (await db.query(sql, params)).rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function board(db, uid, tier = null) {
  const r = await q(db, uid, 'SELECT public.league_board($1::smallint) AS b', [tier]);
  assert.equal(r.ok, true, r.error);
  return r.rows[0].b;
}

async function stars(db, uid, level = null) {
  const r = await q(db, uid, 'SELECT public.star_of_month($1) AS s', [level]);
  assert.equal(r.ok, true, r.error);
  return r.rows[0].s;
}

const boardNames = (b) => (b.rows || []).map((r) => r.display_name).sort();
const winners = (s, kind) => s[kind].winners.map((w) => w.display_name).sort();

async function settle(db) {
  await rows(db, `SELECT public.league_settle_week(${LAST_WEEK})`);
  await rows(db, `SELECT public.xp_settle_period('week', ${LAST_WEEK}, ${LAST_WEEK} + 6)`);
  await rows(db, `SELECT public.xp_settle_period('month', ${LAST_MONTH}, (${LAST_MONTH} + interval '1 month')::date - 1)`);
}

/**
 * Starts from the pre-39 production functions (the rollback file), records one
 * award the old way (no centre), then sets up centres BRN and KTA and, unless
 * `with39` is false, applies migration 39.
 */
async function freshDb({ with39 = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
  await db.exec(ROLLBACK_39);
  // Production grants: the settle functions are internal (service_role only).
  await db.exec(`REVOKE ALL ON FUNCTION public.league_settle_week(date), public.xp_settle_period(text, date, date)
                   FROM PUBLIC, anon, authenticated`);
  await db.exec(`INSERT INTO public.xp_awards (kind, period_start, period_end, level, student_id, xp)
                 VALUES ('week', '2026-01-05', '2026-01-11', 'Level 1', '${P.STU_B1}', 55)`);
  await as(db, P.OWNER);
  const [{ id: kta }] = (await db.query("INSERT INTO public.centres (name, code) VALUES ('Kota Centre', 'KTA') RETURNING id")).rows;
  const [{ id: brn }] = await rows(db, "SELECT id FROM public.centres WHERE code = 'BRN'");
  await rows(db, 'UPDATE public.profiles SET centre_id = $1 WHERE id = ANY ($2::uuid[])', [kta, [P.TCH_K, P.STU_K]]);
  await as(db, P.OWNER);
  for (const [target, role, centre] of [
    [P.DIRECTOR, 'director', null],
    [P.HEAD_B, 'centre_head', brn],
    [P.HEAD_K, 'centre_head', kta],
  ]) {
    await db.query('SELECT public.set_person_role($1, $2, $3)', [target, role, centre]);
  }
  if (with39) {
    await rows(db, 'SELECT 1');
    await db.exec(MIGRATION_39);
  }
  return { db, brn, kta };
}

describe('migration 39: league groups per centre', () => {
  it('a student only sees their own centre in their league group', async () => {
    const { db } = await freshDb();
    const b = await board(db, P.STU_B1);
    assert.equal(b.member, true);
    assert.equal(b.staff, false);
    assert.deepEqual(boardNames(b), ['Asha', 'Ravi']);
    assert.equal(b.rows.find((r) => r.display_name === 'Asha').rank, 1, 'Asha leads Baran even though Kiran has more XP');
    const k = await board(db, P.STU_K);
    assert.deepEqual(k.rows.map((r) => [r.display_name, r.rank, r.is_me]), [['Kiran', 1, true]]);
  });

  it('a student cannot pick another tier or see other groups', async () => {
    const { db } = await freshDb();
    for (const tier of [1, 2, 5]) {
      const b = await board(db, P.STU_B2, tier);
      assert.equal(b.tier, 1);
      assert.deepEqual(boardNames(b), ['Asha', 'Ravi']);
    }
  });

  it('tier counts cover only the caller’s centre', async () => {
    const { db } = await freshDb();
    const b = await board(db, P.STU_K);
    assert.equal(b.tiers.find((t) => t.tier === 1).students, 1);
    const o = await board(db, P.OWNER, 1);
    assert.equal(o.tiers.find((t) => t.tier === 1).students, 4);
  });

  it('teachers and centre heads see the groups of their own centre only', async () => {
    const { db } = await freshDb();
    for (const [who, expected] of [
      [P.TCH_B, ['Asha', 'Meera', 'Ravi']],
      [P.HEAD_B, ['Asha', 'Meera', 'Ravi']],
      [P.TCH_K, ['Kiran']],
      [P.HEAD_K, ['Kiran']],
    ]) {
      const b = await board(db, who, 1);
      assert.equal(b.staff, true, who);
      assert.deepEqual(boardNames(b), expected, who);
      assert.ok(b.rows.every((r) => !/^(BRN|KTA) /.test(r.group)), 'no centre code for one-centre staff');
    }
  });

  it('owners and directors see every centre, labelled by centre code', async () => {
    const { db } = await freshDb();
    for (const who of [P.OWNER, P.DIRECTOR]) {
      const b = await board(db, who, 1);
      assert.deepEqual(boardNames(b), ['Asha', 'Kiran', 'Meera', 'Ravi'], who);
      assert.equal(b.rows.find((r) => r.display_name === 'Kiran').group, 'KTA Level 1 Group 1');
      assert.equal(b.rows.find((r) => r.display_name === 'Asha').group, 'BRN Level 1 Group 1');
      assert.equal(b.rows.find((r) => r.display_name === 'Kiran').rank, 1);
      assert.equal(b.rows.find((r) => r.display_name === 'Asha').rank, 1, 'ranked inside each centre');
    }
  });

  it('settling a week ranks each centre on its own', async () => {
    const { db } = await freshDb();
    await settle(db);
    const res = await rows(db, 'SELECT student_id, rank, group_size, tier_after FROM public.league_results ORDER BY student_id');
    const by = Object.fromEntries(res.map((r) => [r.student_id, r]));
    assert.deepEqual([by[P.STU_K].rank, by[P.STU_K].group_size], [1, 1]);
    assert.deepEqual([by[P.STU_B1].rank, by[P.STU_B1].group_size], [1, 2]);
    assert.deepEqual([by[P.STU_B2].rank, by[P.STU_B2].group_size], [2, 2]);
    assert.equal(by[P.STU_B1].tier_after, 2, 'the Baran leader moves up');
  });

  it('a student moved to another centre joins that centre’s group', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.OWNER);
    await db.query("SELECT public.set_person_role($1, 'student', $2)", [P.STU_B2, kta]);
    assert.deepEqual(boardNames(await board(db, P.STU_K)), ['Kiran', 'Ravi']);
    assert.deepEqual(boardNames(await board(db, P.STU_B1)), ['Asha']);
  });

  it('signed-out and inactive callers get nothing', async () => {
    const { db } = await freshDb();
    const anon = await q(db, null, 'SELECT public.league_board(NULL)');
    assert.equal(anon.ok, false);
    await rows(db, 'UPDATE public.profiles SET active = false WHERE id = $1', [P.TCH_B]);
    const b = await board(db, P.TCH_B, 1);
    assert.deepEqual(boardNames(b), [], 'an inactive teacher sees no centre');
  });

  it('league_members, league_settle_week and xp_settle_period stay internal', async () => {
    const { db } = await freshDb();
    for (const sql of [
      `SELECT * FROM public.league_members(${THIS_WEEK})`,
      `SELECT public.league_settle_week(${LAST_WEEK})`,
      `SELECT public.xp_settle_period('week', ${LAST_WEEK}, ${LAST_WEEK} + 6)`,
    ]) {
      const r = await q(db, P.STU_B1, sql);
      assert.equal(r.ok, false, `${sql} must be refused`);
      assert.match(r.error, /permission denied/);
    }
  });
});

describe('migration 39: Star of the Month and Champion of the Week per centre', () => {
  it('settles one winner per centre and level, with the centre recorded', async () => {
    const { db, brn, kta } = await freshDb();
    await settle(db);
    const a = await rows(db, `SELECT kind, level, student_id, centre_id FROM public.xp_awards
                               WHERE period_start >= ${LAST_MONTH} ORDER BY kind, student_id`);
    const win = (kind, centre) => a.filter((r) => r.kind === kind && r.centre_id === centre).map((r) => r.student_id).sort();
    assert.deepEqual(win('week', brn), [P.STU_B1, P.STU_B3].sort(), 'Baran: Level 1 and Level 2 winners');
    assert.deepEqual(win('week', kta), [P.STU_K]);
    assert.deepEqual(win('month', brn), [P.STU_B1]);
    assert.deepEqual(win('month', kta), [P.STU_K]);
    const badges = await rows(db, "SELECT student_id FROM public.student_badges WHERE badge_key = 'star_month' ORDER BY 1");
    assert.deepEqual(badges.map((r) => r.student_id).sort(), [P.STU_B1, P.STU_K].sort());
  });

  it('a student sees only their own centre’s winners, even when asking for a level', async () => {
    const { db } = await freshDb();
    await settle(db);
    for (const level of [null, 'Level 1', 'Level 2']) {
      const s = await stars(db, P.STU_B2, level);
      assert.equal(s.level, 'Level 1');
      assert.deepEqual(winners(s, 'month'), ['Asha']);
      assert.deepEqual(winners(s, 'week'), ['Asha']);
    }
    const k = await stars(db, P.STU_K);
    assert.deepEqual(winners(k, 'month'), ['Kiran']);
  });

  it('teachers and heads choose a level but stay in their centre; owners see all', async () => {
    const { db } = await freshDb();
    await settle(db);
    assert.deepEqual(winners(await stars(db, P.TCH_K, 'Level 1'), 'month'), ['Kiran']);
    assert.deepEqual(winners(await stars(db, P.HEAD_B, 'Level 1'), 'month'), ['Asha']);
    assert.deepEqual(winners(await stars(db, P.HEAD_B, 'Level 2'), 'week'), ['Meera']);
    assert.deepEqual(winners(await stars(db, P.OWNER, 'Level 1'), 'month'), ['Asha', 'Kiran']);
    assert.deepEqual(winners(await stars(db, P.DIRECTOR, 'Level 1'), 'week'), ['Asha', 'Kiran']);
  });

  it('fills in the centre of awards settled before migration 39', async () => {
    const { db, brn } = await freshDb();
    const old = await rows(db, "SELECT centre_id, xp FROM public.xp_awards WHERE period_start = '2026-01-05'");
    assert.deepEqual(old.map((r) => [r.centre_id, Number(r.xp)]), [[brn, 55]]);
  });
});

describe('migration 39: files and rollback', () => {
  it('before migration 39 a league group mixed centres (the bug this fixes)', async () => {
    const { db } = await freshDb({ with39: false });
    assert.deepEqual(boardNames(await board(db, P.STU_B1)), ['Asha', 'Kiran', 'Ravi']);
  });

  it('the rollback restores network-wide leagues and awards and keeps every award', async () => {
    const { db } = await freshDb();
    await settle(db);
    const before = (await rows(db, 'SELECT count(*)::int AS n FROM public.xp_awards'))[0].n;
    await rows(db, 'SELECT 1');
    await db.exec(ROLLBACK_39);
    await db.exec(ROLLBACK_39); // idempotent
    const after = (await rows(db, 'SELECT count(*)::int AS n FROM public.xp_awards'))[0].n;
    assert.equal(after, before);
    // Asha (Baran) and Kiran (Kota) both won their group and moved up: one mixed tier-2 group again.
    assert.deepEqual(boardNames(await board(db, P.STU_B1)), ['Asha', 'Kiran']);
    assert.deepEqual(winners(await stars(db, P.STU_B1), 'month'), ['Asha', 'Kiran']);
    const r = await q(db, P.STU_B1, `SELECT * FROM public.league_members(${THIS_WEEK})`);
    assert.equal(r.ok, false, 'league_members stays internal after the rollback');
  });

  it('the migration deletes no data and drops only the league_members function', () => {
    const sql = MIGRATION_39.replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\bDELETE\b|\bTRUNCATE\s+(TABLE\s+)?public\b|DROP\s+(TABLE|COLUMN|SCHEMA|INDEX)/i);
    assert.deepEqual(sql.match(/DROP\s+FUNCTION[^;]*/gi), ['DROP FUNCTION IF EXISTS public.league_members(date)']);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS centre_id uuid/);
    assert.doesNotMatch(ROLLBACK_39.replace(/--.*$/gm, ''), /DROP\s+(TABLE|COLUMN|INDEX)|\bDELETE\b/i);
  });
});
