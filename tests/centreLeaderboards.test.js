/**
 * Multi-centre step 5a: every leaderboard covers one centre.
 *
 *  - migration 37 on PGlite after migrations 30, 32 and 33: students, teachers and
 *    centre heads see only their own centre on every board; owners and directors
 *    see every centre; asking for the "global" scope or a bigger limit does not
 *    widen it; the rollback brings back the network-wide boards;
 *  - async duels: duel_options lists classmates of your centre only, and
 *    /api/drill duel_create refuses an opponent from another centre.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { handleDuelCreate, sameCentre } from '../api/_duels.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const MIGRATION_37 = read('supabase/migrations/37_centre_scoped_leaderboards.sql');
const ROLLBACK_37 = read('supabase/rollbacks/37_centre_scoped_leaderboards_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1), DIRECTOR: id(2),
  HEAD_B: id(10), TCH_B: id(12), STU_B1: id(13), STU_B2: id(14),
  HEAD_K: id(20), TCH_K: id(21), STU_K: id(22),
};
const TASK = id(500);
const CAT = id(600);
const TEST = id(700);

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
  CREATE TABLE public.categories (id uuid PRIMARY KEY, name text, section text, active boolean DEFAULT true);
  CREATE TABLE public.results (
    id serial PRIMARY KEY, student_id uuid, score int, entry_date date DEFAULT current_date,
    correct int, total int, time_seconds numeric, category_id uuid, source text DEFAULT 'site');
  CREATE TABLE public.weekly_tests (
    id uuid PRIMARY KEY, test_date date, audience_level text, test_type text DEFAULT 'offline', closes_at timestamptz);
  CREATE TABLE public.weekly_test_scores (
    student_id uuid, test_id uuid, correct int, total int, time_seconds int);
  CREATE TABLE public.attendance_sessions (id uuid PRIMARY KEY, session_date date);
  CREATE TABLE public.attendance (student_id uuid, session_id uuid, status text);
  CREATE TABLE public.daily_todo_log (student_id uuid, day date, tasks_total int, all_done boolean);
  CREATE TABLE public.student_xp_events (student_id uuid, day date, xp int);
  CREATE TABLE public.daily_tasks (id uuid PRIMARY KEY, active boolean, section text, category_id uuid);
  CREATE TABLE public.daily_challenge_attempts (
    student_id uuid, day date, level text, correct int, total int, time_seconds numeric, submitted_at timestamptz);
  CREATE TABLE public.duels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, challenger_id uuid, opponent_id uuid,
    created_day date DEFAULT current_date);
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.is_teacher(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'teacher' AND active FROM public.profiles WHERE id = u), false) $$;
  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_date $$;
  CREATE FUNCTION public.period_bounds(p text) RETURNS TABLE(d_from date, d_to date) LANGUAGE sql STABLE
    AS $$ SELECT current_date - 30, current_date $$;
  CREATE FUNCTION public.competition_rules()
    RETURNS TABLE(weekly_test_multiplier numeric, attendance_present_points numeric, improved_min_entries integer, leaderboard_names text)
    LANGUAGE sql STABLE AS $$ SELECT 1::numeric, 1::numeric, 1, 'first_name_initial'::text $$;
  CREATE FUNCTION public.streak_calc(s uuid) RETURNS TABLE(current_streak integer) LANGUAGE sql STABLE AS $$ SELECT 1 $$;
  CREATE FUNCTION public.practice_days_for(s uuid, a date, b date) RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 1 $$;
  CREATE FUNCTION public.todo_all_done_on(s uuid, d date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
  CREATE FUNCTION public.display_name_for(n text, c text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT n $$;
  CREATE FUNCTION public.avatar_visible(s uuid, p text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT p $$;
  CREATE FUNCTION public.global_leaderboard_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.daily_challenge_candidates(l text) RETURNS TABLE(category_id uuid, name text, students integer)
    LANGUAGE sql STABLE AS $$ SELECT NULL::uuid, NULL::text, 0 WHERE false $$;
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
    ('${P.HEAD_K}', 'HEADK', 'Head Kota', 'student', NULL),
    ('${P.TCH_K}', 'TCHK', 'Teacher Kota', 'teacher', 'Teacher'),
    ('${P.STU_K}', 'STUK', 'Kiran', 'student', 'Level 1');

  INSERT INTO public.categories VALUES ('${CAT}', 'Mental Basics: 1d4r', 'basics', true);
  INSERT INTO public.daily_tasks VALUES ('${TASK}', true, 'basics', '${CAT}');
  INSERT INTO public.weekly_tests VALUES ('${TEST}', current_date - 1, NULL, 'offline', NULL);
  INSERT INTO public.student_xp_events VALUES
    ('${P.STU_B1}', current_date, 30), ('${P.STU_B2}', current_date, 20), ('${P.STU_K}', current_date, 90);
  INSERT INTO public.results (student_id, correct, total, time_seconds, category_id) VALUES
    ('${P.STU_B1}', 20, 25, 60, '${CAT}'), ('${P.STU_B2}', 15, 20, 60, '${CAT}'), ('${P.STU_K}', 40, 40, 60, '${CAT}');
  INSERT INTO public.weekly_test_scores VALUES
    ('${P.STU_B1}', '${TEST}', 18, 20, 300), ('${P.STU_B2}', '${TEST}', 12, 20, 300), ('${P.STU_K}', '${TEST}', 20, 20, 200);
  INSERT INTO public.daily_challenge_attempts VALUES
    ('${P.STU_B1}', current_date, 'Level 1', 8, 10, 50, now()),
    ('${P.STU_B2}', current_date, 'Level 1', 6, 10, 55, now()),
    ('${P.STU_K}', current_date, 'Level 1', 10, 10, 40, now());
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

const names = (list) => list.map((r) => r.display_name).sort();

/**
 * Migrations 30, 32, 33 and 37; centres BRN (default) and KTA. With `with37: false` the
 * boards are the pre-37 production definitions (the rollback file) instead.
 */
async function freshDb({ with37 = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
  await db.exec(with37 ? MIGRATION_37 : ROLLBACK_37);
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
  return { db, brn, kta };
}

const XP_BOARD = "SELECT * FROM public.leaderboard('xp', 'month', $1, $2, $3)";

describe('migration 37: leaderboard()', () => {
  it('a student sees only their own centre, even with the global scope and a big limit', async () => {
    const { db } = await freshDb();
    for (const args of [[null, 10, 'level'], [null, 10, 'global'], ['all', 200, 'global']]) {
      const r = await q(db, P.STU_B1, XP_BOARD, args);
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(names(r.rows), ['Asha', 'Ravi'], `args ${JSON.stringify(args)}`);
      assert.ok(r.rows.every((row) => row.student_id === null), 'students never get ids');
    }
  });

  it('the other centre sees only its own student, ranked first', async () => {
    const { db } = await freshDb();
    const r = await q(db, P.STU_K, XP_BOARD, [null, 10, 'global']);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.rows.map((row) => [row.display_name, row.rank, row.is_me]), [['Kiran', 1, true]]);
  });

  it('every board type stays inside the centre', async () => {
    const { db } = await freshDb();
    for (const board of ['points', 'streak', 'practice_days', 'xp']) {
      const r = await q(db, P.STU_B2, "SELECT * FROM public.leaderboard($1, 'month', NULL, 10, 'global')", [board]);
      assert.equal(r.ok, true, `${board}: ${r.error}`);
      assert.ok(!names(r.rows).includes('Kiran'), `${board} leaks Kota`);
      assert.ok(r.rows.length > 0, `${board} is empty`);
    }
  });

  it('owners and directors see every centre, with ids', async () => {
    const { db } = await freshDb();
    for (const who of [P.OWNER, P.DIRECTOR]) {
      const r = await q(db, who, XP_BOARD, ['all', 50, 'global']);
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(names(r.rows), ['Asha', 'Kiran', 'Ravi']);
      assert.equal(r.rows.find((row) => row.display_name === 'Kiran').student_id, P.STU_K);
    }
  });

  it('teachers and centre heads see only their own centre', async () => {
    const { db } = await freshDb();
    for (const [who, expected] of [[P.TCH_B, ['Asha', 'Ravi']], [P.TCH_K, ['Kiran']], [P.HEAD_B, ['Asha', 'Ravi']]]) {
      const r = await q(db, who, XP_BOARD, ['all', 200, 'global']);
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(names(r.rows), expected, who);
    }
  });

  it('a student moved to another centre moves boards with them', async () => {
    const { db, kta } = await freshDb();
    await as(db, P.OWNER);
    await db.query("SELECT public.set_person_role($1, 'student', $2)", [P.STU_B2, kta]);
    const r = await q(db, P.STU_K, XP_BOARD, [null, 10, 'global']);
    assert.deepEqual(names(r.rows), ['Kiran', 'Ravi']);
    const b = await q(db, P.STU_B1, XP_BOARD, [null, 10, 'global']);
    assert.deepEqual(names(b.rows), ['Asha']);
  });

  it('a student cannot move themself into another centre to see its board', async () => {
    const { db, kta } = await freshDb();
    const r = await q(db, P.STU_B1, 'UPDATE public.profiles SET centre_id = $1 WHERE id = $2', [kta, P.STU_B1]);
    const [{ centre_id: after }] = await rows(db, 'SELECT centre_id FROM public.profiles WHERE id = $1', [P.STU_B1]);
    assert.notEqual(after, kta, r.ok ? 'update went through' : r.error);
  });

  it('a deactivated student sees no centre board', async () => {
    const { db } = await freshDb();
    await rows(db, 'UPDATE public.profiles SET active = false WHERE id = $1', [P.STU_B1]);
    const r = await q(db, P.STU_B1, XP_BOARD, [null, 10, 'global']);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.rows, []);
  });

  it('signed-out callers are refused', async () => {
    const { db } = await freshDb();
    const r = await q(db, null, XP_BOARD, [null, 10, 'global']);
    assert.equal(r.ok, false);
  });
});

describe('migration 37: the other boards', () => {
  it('todo_task_leaderboard stays inside the centre', async () => {
    const { db } = await freshDb();
    const sql = "SELECT * FROM public.todo_task_leaderboard($1, 'month', NULL, 200, 'global')";
    const b = await q(db, P.STU_B1, sql, [TASK]);
    assert.equal(b.ok, true, b.error);
    assert.deepEqual(names(b.rows), ['Asha', 'Ravi']);
    const o = await q(db, P.OWNER, sql, [TASK]);
    assert.deepEqual(names(o.rows), ['Asha', 'Kiran', 'Ravi']);
  });

  it('weekly_test_leaderboard stays inside the centre, for one test and for a period', async () => {
    const { db } = await freshDb();
    for (const test of [TEST, null]) {
      const sql = "SELECT * FROM public.weekly_test_leaderboard($1, 'month', NULL, 200, 'global')";
      const k = await q(db, P.STU_K, sql, [test]);
      assert.equal(k.ok, true, k.error);
      assert.deepEqual(names(k.rows), ['Kiran']);
      const o = await q(db, P.DIRECTOR, sql, [test]);
      assert.deepEqual(names(o.rows), ['Asha', 'Kiran', 'Ravi']);
    }
  });

  it('class_vs_class counts only the centre', async () => {
    const { db } = await freshDb();
    const sql = "SELECT public.class_vs_class('week') AS r";
    const b = await q(db, P.STU_B1, sql);
    assert.equal(b.ok, true, b.error);
    const level1 = b.rows[0].r.classes.find((c) => c.level === 'Level 1');
    assert.equal(level1.students, 2);
    assert.equal(Number(level1.xp), 50);
    const o = await q(db, P.OWNER, sql);
    assert.equal(o.rows[0].r.classes.find((c) => c.level === 'Level 1').students, 3);
  });

  it('daily_challenge_board counts only the centre', async () => {
    const { db } = await freshDb();
    const b = await q(db, P.STU_B2, 'SELECT * FROM public.daily_challenge_board(NULL, NULL)');
    assert.equal(b.ok, true, b.error);
    assert.deepEqual(names(b.rows), ['Asha', 'Ravi']);
    assert.ok(b.rows.every((row) => row.players === 2));
    const t = await q(db, P.TCH_K, "SELECT * FROM public.daily_challenge_board(NULL, 'Level 1')");
    assert.deepEqual(names(t.rows), ['Kiran']);
    const o = await q(db, P.OWNER, "SELECT * FROM public.daily_challenge_board(NULL, 'Level 1')");
    assert.deepEqual(names(o.rows), ['Asha', 'Kiran', 'Ravi']);
  });

  it('duel_options lists classmates of your own centre only', async () => {
    const { db } = await freshDb();
    const b = await q(db, P.STU_B1, 'SELECT public.duel_options() AS r');
    assert.equal(b.ok, true, b.error);
    assert.deepEqual(b.rows[0].r.opponents.map((o) => o.display_name), ['Ravi']);
    const k = await q(db, P.STU_K, 'SELECT public.duel_options() AS r');
    assert.deepEqual(k.rows[0].r.opponents, []);
  });

  it('signed-in people can still run every board (grants are kept)', async () => {
    const { db } = await freshDb();
    const [g] = await rows(db, `SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS ok
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('leaderboard', 'todo_task_leaderboard', 'weekly_test_leaderboard', 'class_vs_class', 'daily_challenge_board', 'duel_options')`);
    assert.equal(g.ok, true);
  });
});

describe('migration 37: before and rollback', () => {
  it('before migration 37 the boards were network-wide (what this step fixes)', async () => {
    const { db } = await freshDb({ with37: false });
    const r = await q(db, P.STU_B1, XP_BOARD, [null, 10, 'global']);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(names(r.rows), ['Asha', 'Kiran', 'Ravi']);
  });

  it('the rollback brings back the network-wide boards and is idempotent', async () => {
    const { db } = await freshDb();
    await rows(db, 'SELECT 1');
    await db.exec(ROLLBACK_37);
    await db.exec(ROLLBACK_37);
    const r = await q(db, P.STU_B1, XP_BOARD, [null, 10, 'global']);
    assert.deepEqual(names(r.rows), ['Asha', 'Kiran', 'Ravi']);
    const d = await q(db, P.STU_B1, 'SELECT public.duel_options() AS r');
    assert.deepEqual(d.rows[0].r.opponents.map((o) => o.display_name).sort(), ['Kiran', 'Ravi']);
  });

  it('the migration changes nothing but the centre filter', () => {
    const body = (sql) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION'));
    const added = body(MIGRATION_37).split('\n').filter((line) => !body(ROLLBACK_37).split('\n').includes(line));
    assert.ok(added.length > 0);
    for (const line of added) {
      assert.match(line.trim(), /^(v_centre (UUID|uuid) := public\.my_centre\(\);|v_net boolean := public\.is_network_admin\(\);|AND \((v_admin|v_net) OR p\.centre_id = v_centre\)|AND p\.centre_id = v_centre)$/, line);
    }
    assert.ok(!/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/i.test(MIGRATION_37.replace(/--.*$/gm, '')), 'no data or schema changes');
  });
});

/** A tiny stand-in for the admin Supabase client used by handleDuelCreate. */
function fakeAdmin(profiles, inserted) {
  return {
    from(table) {
      const filters = [];
      const api = {
        select() { return api; },
        eq(col, val) { filters.push((r) => r[col] === val); return api; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
        maybeSingle() { return Promise.resolve({ data: api._rows()[0] || null }); },
        single() { return Promise.resolve({ data: { id: 'duel-1' }, error: null }); },
        insert(row) { inserted.push(row); return api; },
        _rows() {
          const src = table === 'profiles' ? profiles
            : table === 'categories' ? [{ id: CAT, name: '1d4r', section: 'basics', active: true }]
              : [];
          return src.filter((r) => filters.every((f) => f(r)));
        },
        then(resolve) { return resolve(table === 'duels' ? { count: 0 } : { data: api._rows() }); },
      };
      return api;
    },
    rpc() { return Promise.resolve({ data: null }); },
  };
}

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('async duels across centres (api/_duels.js)', () => {
  const me = { id: P.STU_B1, role: 'student', active: true, level: 'Level 1', leaderboard_visible: true, centre_id: 'brn' };
  const mate = { id: P.STU_B2, role: 'student', active: true, level: 'Level 1', leaderboard_visible: true, centre_id: 'brn' };
  const other = { id: P.STU_K, role: 'student', active: true, level: 'Level 1', leaderboard_visible: true, centre_id: 'kta' };

  it('sameCentre needs both students in the same, known centre', () => {
    assert.equal(sameCentre(me, mate), true);
    assert.equal(sameCentre(me, other), false);
    assert.equal(sameCentre({ centre_id: null }, { centre_id: null }), false);
    assert.equal(sameCentre(undefined, mate), false);
  });

  it('a classmate of the same centre can be challenged', async () => {
    const inserted = [];
    const res = fakeRes();
    await handleDuelCreate({
      body: { opponent_id: P.STU_B2, category_id: CAT },
      student: me, adminSupabase: fakeAdmin([me, mate, other], inserted), res,
    });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].opponent_id, P.STU_B2);
  });

  it('a student of another centre cannot be challenged, even by id', async () => {
    const inserted = [];
    const res = fakeRes();
    await handleDuelCreate({
      body: { opponent_id: P.STU_K, category_id: CAT },
      student: me, adminSupabase: fakeAdmin([me, mate, other], inserted), res,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(inserted.length, 0);
  });
});

