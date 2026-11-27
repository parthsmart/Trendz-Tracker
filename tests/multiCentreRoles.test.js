/**
 * Migration 30: multi-centre roles. Runs the real migration (and its rollback)
 * on PGlite against the production shape of `profiles`, then tries every
 * escalation we can think of as each role.
 *
 * Hierarchy: owner > director > centre head > vice head > teacher > student.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/30_multi_centre_schema.sql'), 'utf8');
const ROLLBACK = fs.readFileSync(path.join(root, 'supabase/rollbacks/30_multi_centre_schema_rollback.sql'), 'utf8');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1), OWNER2: id(2), LEGACY: id(3), DIRECTOR: id(4), DIRECTOR2: id(5),
  HEAD_A: id(10), VICE_A: id(11), TEACHER_A: id(12), STU_A1: id(13), STU_A2: id(14),
  HEAD_B: id(20), STU_B1: id(21), HEAD_C: id(30), STU_C1: id(31),
};
const C = { A: id(901), B: id(902), C: id(903) };

// Production state before migration 30 (profiles, guard, constraints, RLS).
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
    deleted_at timestamptz,
    deleted_by uuid,
    CONSTRAINT profiles_role_check CHECK (role IN ('student', 'teacher', 'admin')),
    CONSTRAINT profiles_level_allowed CHECK (level IS NULL OR public.is_standard_student_level(level)
      OR (role = 'teacher' AND level = 'Teacher') OR (role = 'admin' AND level = 'Admin'))
  );
  CREATE TABLE public.teacher_permissions (teacher_id uuid, permission text, allowed boolean);
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.teacher_permissions TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN
    IF auth.uid() IS NOT NULL THEN
      IF NEW.role IS DISTINCT FROM OLD.role THEN RAISE EXCEPTION 'The role cannot be changed from the site.'; END IF;
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();
  -- Supabase default privileges: every new function is executable by everyone.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  CREATE FUNCTION public.admin_list_everything() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
  CREATE FUNCTION public.teacher_roster() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());
  CREATE POLICY profiles_self_update ON public.profiles FOR UPDATE TO authenticated
    USING (id = auth.uid()) WITH CHECK (id = auth.uid());
  CREATE POLICY profiles_admin_update_policy ON public.profiles FOR UPDATE TO authenticated
    USING (public.is_admin() AND deleted_at IS NULL) WITH CHECK (public.is_admin());

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.LEGACY}', 'ADMIN01', 'Legacy admin', 'admin', 'Admin'),
    ('${P.TEACHER_A}', 'TCH01', 'Teacher A', 'teacher', 'Teacher'),
    ('${P.STU_A1}', 'STU001', 'Asha', 'student', 'Level 1');
`;

// Centres and people, created as the database owner (no auth.uid()).
const SEED = `
  INSERT INTO public.centres (id, name, code, is_default, status) VALUES
    ('${C.A}', 'Baran Centre', 'BRN', true, 'active'),
    ('${C.B}', 'Kota Centre', 'KOT', false, 'active'),
    ('${C.C}', 'Closed Centre', 'CLS', false, 'suspended');
  UPDATE public.profiles SET centre_id = '${C.A}' WHERE id IN ('${P.TEACHER_A}', '${P.STU_A1}');
  INSERT INTO public.profiles (id, student_code, full_name, role, level, centre_id) VALUES
    ('${P.OWNER}', 'OWN01', 'Owner', 'owner', 'Admin', NULL),
    ('${P.OWNER2}', 'OWN02', 'Owner two', 'owner', 'Admin', NULL),
    ('${P.DIRECTOR}', 'DIR01', 'Director', 'director', 'Admin', NULL),
    ('${P.DIRECTOR2}', 'DIR02', 'Director two', 'director', 'Admin', NULL),
    ('${P.HEAD_A}', 'HDA01', 'Head A', 'centre_head', 'Admin', '${C.A}'),
    ('${P.VICE_A}', 'VCA01', 'Vice A', 'vice_centre_head', 'Admin', '${C.A}'),
    ('${P.STU_A2}', 'STU002', 'Ravi', 'student', 'Master', '${C.A}'),
    ('${P.HEAD_B}', 'HDB01', 'Head B', 'centre_head', 'Admin', '${C.B}'),
    ('${P.STU_B1}', 'STU101', 'Bina', 'student', 'Level 2', '${C.B}'),
    ('${P.HEAD_C}', 'HDC01', 'Head C', 'centre_head', 'Admin', '${C.C}'),
    ('${P.STU_C1}', 'STU201', 'Chetan', 'student', 'Level 3', '${C.C}');
  INSERT INTO public.centre_staff (centre_id, profile_id, role) VALUES
    ('${C.A}', '${P.HEAD_A}', 'centre_head'), ('${C.A}', '${P.VICE_A}', 'vice_centre_head'),
    ('${C.B}', '${P.HEAD_B}', 'centre_head'), ('${C.C}', '${P.HEAD_C}', 'centre_head');
`;

async function freshDb({ seed = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION);
  if (seed) await db.exec(SEED);
  return db;
}

async function as(db, uid, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec(`SET ROLE ${role}`);
}

async function attempt(db, sql, params = []) {
  try {
    const { rows } = await db.query(sql, params);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const setRole = (db, target, role, centre = null) =>
  attempt(db, 'SELECT public.set_person_role($1, $2, $3) AS r', [target, role, centre]);

async function profile(db, pid) {
  await db.exec('RESET ROLE');
  const { rows: [r] } = await db.query('SELECT role, centre_id, level, active FROM public.profiles WHERE id = $1', [pid]);
  return r;
}

async function scalar(db, sql) {
  const { rows: [r] } = await db.query(`SELECT ${sql} AS v`);
  return r.v;
}

describe('migration 30: role helpers', () => {
  it('ranks follow the hierarchy, and legacy admin ranks as owner', async () => {
    const db = await freshDb({ seed: false });
    const ranks = await scalar(db, "ARRAY[role_rank('owner'), role_rank('admin'), role_rank('director'), role_rank('centre_head'), role_rank('vice_centre_head'), role_rank('teacher'), role_rank('student'), role_rank('hacker')]");
    assert.deepEqual(ranks, [100, 100, 80, 60, 50, 30, 10, 0]);
  });

  it('is_admin() keeps legacy admin working and covers owner and director, but not heads', async () => {
    const db = await freshDb();
    for (const [who, want] of [[P.LEGACY, true], [P.OWNER, true], [P.DIRECTOR, true], [P.HEAD_A, false],
      [P.VICE_A, false], [P.TEACHER_A, false], [P.STU_A1, false], [null, false]]) {
      await as(db, who);
      assert.equal(await scalar(db, 'public.is_admin()'), want, `is_admin for ${who}`);
    }
  });

  it('a head is a centre admin of their own centre only; a suspended centre removes the role', async () => {
    const db = await freshDb();
    await as(db, P.HEAD_A);
    assert.equal(await scalar(db, `public.is_centre_admin('${C.A}')`), true);
    assert.equal(await scalar(db, `public.is_centre_admin('${C.B}')`), false);
    await as(db, P.VICE_A);
    assert.equal(await scalar(db, `public.is_centre_admin('${C.A}')`), true);
    assert.equal(await scalar(db, `public.is_centre_head('${C.A}')`), false, 'a vice head is not the head');
    await as(db, P.HEAD_C);
    assert.equal(await scalar(db, 'public.my_role()'), null);
    assert.equal(await scalar(db, `public.is_centre_admin('${C.C}')`), false);
  });

  it('an inactive or deleted director has no powers', async () => {
    const db = await freshDb();
    await db.exec(`UPDATE public.profiles SET active = false WHERE id = '${P.DIRECTOR}'`);
    await as(db, P.DIRECTOR);
    assert.equal(await scalar(db, 'public.is_admin()'), false);
    assert.equal((await setRole(db, P.STU_A1, 'teacher')).ok, false);
  });

  it('anon cannot call any role helper or staff RPC; is_admin() just says no', async () => {
    const db = await freshDb();
    await as(db, null, 'anon');
    assert.equal(await scalar(db, 'public.is_admin()'), false);
    for (const fn of ['public.my_role()', 'public.is_network_admin()',
      `public.set_person_role('${P.STU_A1}', 'owner', NULL)`, 'public.admin_list_everything()', 'public.teacher_roster()']) {
      const r = await attempt(db, `SELECT ${fn}`);
      assert.equal(r.ok, false, fn);
      assert.match(r.error, /permission denied/i, fn);
    }
  });
});

describe('migration 30: set_person_role escalation checks', () => {
  it('owner can make a director and a second owner', async () => {
    const db = await freshDb();
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.TEACHER_A, 'director')).ok, true);
    assert.deepEqual(await profile(db, P.TEACHER_A), { role: 'director', centre_id: null, level: 'Admin', active: true });
    await as(db, P.OWNER);
    assert.equal((await setRole(db, P.DIRECTOR, 'owner')).ok, true);
  });

  it('a director cannot create an owner or another director, or touch an owner', async () => {
    const db = await freshDb();
    await as(db, P.DIRECTOR);
    assert.match((await setRole(db, P.STU_A1, 'owner')).error, /below your own level/);
    assert.match((await setRole(db, P.STU_A1, 'director')).error, /below your own level/);
    assert.match((await setRole(db, P.OWNER, 'student', C.A)).error, /below your own level/);
    assert.match((await setRole(db, P.DIRECTOR2, 'teacher', C.A)).error, /below your own level/);
    const r = await attempt(db, `UPDATE public.profiles SET active = false WHERE id = '${P.OWNER}'`);
    assert.equal(r.ok, false, 'director cannot deactivate an owner');
    assert.match(r.error, /at or above your own level/);
    assert.equal((await profile(db, P.OWNER)).active, true);
  });

  it('a director can appoint heads in any centre and transfer people', async () => {
    const db = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.STU_B1, 'student', C.A)).ok, true);
    assert.equal((await profile(db, P.STU_B1)).centre_id, C.A);
    await as(db, P.DIRECTOR);
    assert.match((await setRole(db, P.TEACHER_A, 'centre_head', C.A)).error, /already has a head/);
    assert.match((await setRole(db, P.TEACHER_A, 'teacher', C.C)).error, /not active/);
    assert.match((await setRole(db, P.STU_A1, 'teacher')).ok ? 'ok' : 'fail', /ok/, 'keeps current centre');
  });

  it('a centre head can appoint a vice head and teachers in their centre, never a head', async () => {
    const db = await freshDb();
    await as(db, P.HEAD_A);
    assert.equal((await setRole(db, P.TEACHER_A, 'vice_centre_head')).ok, true);
    const p = await profile(db, P.TEACHER_A);
    assert.equal(p.role, 'vice_centre_head');
    assert.equal(p.centre_id, C.A);
    await as(db, P.HEAD_A);
    assert.equal((await setRole(db, P.STU_A2, 'teacher')).ok, true);
    assert.equal((await profile(db, P.STU_A2)).level, 'Teacher');
    await as(db, P.HEAD_A);
    assert.match((await setRole(db, P.STU_A1, 'centre_head')).error, /below your own level/);
    assert.match((await setRole(db, P.STU_A1, 'director')).error, /below your own level/);
  });

  it('a centre head cannot touch another centre or transfer anyone', async () => {
    const db = await freshDb();
    await as(db, P.HEAD_A);
    assert.match((await setRole(db, P.STU_B1, 'teacher')).error, /own centre/);
    assert.match((await setRole(db, P.STU_A1, 'student', C.B)).error, /own centre/);
    assert.equal((await profile(db, P.STU_A1)).centre_id, C.A);
    assert.match((await setRole(db, P.HEAD_B, 'student')).error, /below your own level|own centre/);
  });

  it('a vice head cannot appoint a vice head or touch the head', async () => {
    const db = await freshDb();
    await as(db, P.VICE_A);
    assert.match((await setRole(db, P.STU_A1, 'vice_centre_head')).error, /below your own level/);
    assert.match((await setRole(db, P.HEAD_A, 'student')).error, /below your own level/);
    assert.equal((await setRole(db, P.STU_A1, 'teacher')).ok, true, 'can still add teachers');
  });

  it('teachers and students cannot change roles at all', async () => {
    const db = await freshDb();
    for (const who of [P.TEACHER_A, P.STU_A1]) {
      await as(db, who);
      assert.match((await setRole(db, P.STU_A2, 'teacher')).error, /centre heads and above/);
    }
  });

  it('nobody can change their own role, not even an owner', async () => {
    const db = await freshDb();
    for (const who of [P.OWNER, P.DIRECTOR, P.HEAD_A]) {
      await as(db, who);
      assert.match((await setRole(db, who, 'student', C.A)).error, /your own role/);
    }
  });

  it('a suspended centre head cannot change anyone', async () => {
    const db = await freshDb();
    await as(db, P.HEAD_C);
    assert.match((await setRole(db, P.STU_C1, 'teacher')).error, /centre heads and above/);
  });

  it('unknown and legacy role names are refused', async () => {
    const db = await freshDb();
    await as(db, P.OWNER);
    assert.match((await setRole(db, P.STU_A1, 'admin')).error, /Unknown role/);
    assert.match((await setRole(db, P.STU_A1, 'superuser')).error, /Unknown role/);
  });

  it('changing a head to teacher ends their head post so a new head can be appointed', async () => {
    const db = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.HEAD_A, 'teacher')).ok, true);
    assert.equal((await setRole(db, P.VICE_A, 'centre_head')).ok, true);
    await db.exec('RESET ROLE');
    const { rows } = await db.query(`SELECT profile_id, role FROM public.centre_staff WHERE centre_id = '${C.A}' AND ended_at IS NULL`);
    assert.deepEqual(rows, [{ profile_id: P.VICE_A, role: 'centre_head' }]);
  });
});

describe('migration 30: direct table writes', () => {
  it('nobody can change a role or centre with a plain UPDATE', async () => {
    const db = await freshDb();
    for (const who of [P.OWNER, P.LEGACY, P.STU_A1]) {
      await as(db, who);
      const role = await attempt(db, `UPDATE public.profiles SET role = 'owner' WHERE id = '${P.STU_A1}'`);
      assert.equal(role.ok, false);
      assert.match(role.error, /role cannot be changed/);
      const centre = await attempt(db, `UPDATE public.profiles SET centre_id = '${C.B}' WHERE id = '${P.STU_A1}'`);
      assert.equal(centre.ok, false);
      assert.match(centre.error, /transfer/);
    }
  });

  it('nobody signed in can forge a role-change ticket or use a session setting', async () => {
    const db = await freshDb();
    for (const who of [P.STU_A1, P.DIRECTOR]) {
      await as(db, who);
      const t = await attempt(db, `INSERT INTO public.role_change_tickets VALUES ('${P.STU_A1}', txid_current(), 'owner', NULL)`);
      assert.match(t.error, /permission denied/);
      await db.query("SELECT set_config('trendz.role_change', 'on', false)");
      const r = await attempt(db, `UPDATE public.profiles SET role = 'owner' WHERE id = '${P.STU_A1}'`);
      assert.match(r.error, /role cannot be changed/);
    }
    assert.equal((await profile(db, P.STU_A1)).role, 'student');
  });

  it('the last active owner cannot be removed or deactivated', async () => {
    const db = await freshDb();
    await db.exec(`UPDATE public.profiles SET role = 'director', level = 'Admin' WHERE id IN ('${P.OWNER2}', '${P.LEGACY}')`);
    await as(db, P.OWNER);
    const r = await attempt(db, `UPDATE public.profiles SET active = false WHERE id = '${P.OWNER}'`);
    assert.match(r.error, /at least one active owner/);
    await db.exec('RESET ROLE');
    const d = await attempt(db, `DELETE FROM public.profiles WHERE id = '${P.OWNER}'`);
    assert.match(d.error, /at least one active owner/);
    await as(db, P.OWNER2);
    // OWNER2 is now a director: cannot demote the last owner either.
    assert.equal((await setRole(db, P.OWNER, 'director')).ok, false);
  });

  it('heads cannot write centre_staff, centres or role_audit directly', async () => {
    const db = await freshDb();
    await as(db, P.HEAD_A);
    assert.equal((await attempt(db, `INSERT INTO public.centre_staff (centre_id, profile_id, role) VALUES ('${C.A}', '${P.STU_A1}', 'centre_head')`)).ok, false);
    assert.equal((await attempt(db, "INSERT INTO public.centres (name, code) VALUES ('Mine', 'MINE')")).ok, false);
    assert.equal((await attempt(db, "INSERT INTO public.role_audit (action) VALUES ('fake')")).ok, false);
    const del = await attempt(db, 'DELETE FROM public.role_audit');
    assert.equal(del.ok, false);
  });

  it('a head reads only their own centre staff and audit; a director reads everything', async () => {
    const db = await freshDb();
    await as(db, P.DIRECTOR);
    assert.equal((await setRole(db, P.STU_B1, 'teacher')).ok, true);
    assert.equal((await setRole(db, P.STU_A2, 'teacher')).ok, true);
    await as(db, P.HEAD_A);
    const staff = (await db.query('SELECT DISTINCT centre_id FROM public.centre_staff')).rows.map((r) => r.centre_id);
    assert.deepEqual(staff, [C.A]);
    const audit = (await db.query('SELECT DISTINCT centre_id FROM public.role_audit')).rows.map((r) => r.centre_id);
    assert.deepEqual(audit, [C.A]);
    await as(db, P.VICE_A);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.role_audit')).rows[0].n, 0, 'vice heads do not read the audit');
    await as(db, P.STU_A1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.centre_staff')).rows[0].n, 0);
    await as(db, P.DIRECTOR);
    assert.ok((await db.query('SELECT count(DISTINCT centre_id)::int AS n FROM public.role_audit')).rows[0].n >= 2);
  });

  it('only network admins manage duel visibility between centres', async () => {
    const db = await freshDb();
    const sql = `INSERT INTO public.centre_visibility (source_centre_id, viewer_centre_id, mode, top_n) VALUES ('${C.A}', '${C.B}', 'top_n', 10)`;
    await as(db, P.HEAD_A);
    assert.equal((await attempt(db, sql)).ok, false);
    await as(db, P.DIRECTOR);
    assert.equal((await attempt(db, sql)).ok, true);
    await as(db, P.HEAD_B);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.centre_visibility')).rows[0].n, 1, 'viewer centre head sees it');
    assert.equal((await attempt(db, 'DELETE FROM public.centre_visibility')).rows?.length ?? 0, 0);
    await db.exec('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.centre_visibility')).rows[0].n, 1, 'head delete did nothing');
  });
});

describe('migration 30: audit', () => {
  it('role changes, transfers, deactivations and permission edits are logged with the actor', async () => {
    const db = await freshDb();
    await as(db, P.DIRECTOR);
    await setRole(db, P.STU_A1, 'teacher');
    await setRole(db, P.STU_A2, 'student', C.B);
    await db.exec(`UPDATE public.profiles SET active = false WHERE id = '${P.STU_B1}'`);
    await db.exec(`INSERT INTO public.teacher_permissions VALUES ('${P.TEACHER_A}', 'view_students', true)`);
    await db.exec('RESET ROLE');
    const { rows } = await db.query(`SELECT action, target_id FROM public.role_audit WHERE actor_id = '${P.DIRECTOR}' ORDER BY id`);
    assert.deepEqual(rows.map((r) => r.action), ['role_change', 'transfer', 'deactivate', 'teacher_permissions_insert']);
    const { rows: [rc] } = await db.query(`SELECT before->>'role' AS b, after->>'role' AS a, actor_role FROM public.role_audit WHERE action = 'role_change' AND actor_id = '${P.DIRECTOR}'`);
    assert.deepEqual(rc, { b: 'student', a: 'teacher', actor_role: 'director' });
  });
});

describe('migration 30: rollback', () => {
  it('rollback removes the new objects and restores the old guard and constraints', async () => {
    const db = new PGlite();
    await db.exec(BASE);
    await db.exec(MIGRATION);
    await db.exec(ROLLBACK);
    for (const t of ['centres', 'centre_staff', 'centre_visibility', 'role_audit']) {
      assert.equal(await scalar(db, `to_regclass('public.${t}') IS NULL`), true, t);
    }
    assert.equal(await scalar(db, "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'centre_id')"), false);
    assert.equal(await scalar(db, "to_regprocedure('public.set_person_role(uuid,text,uuid)') IS NULL"), true);
    await as(db, P.LEGACY);
    assert.equal(await scalar(db, 'public.is_admin()'), true, 'legacy admin still admin');
    const r = await attempt(db, `UPDATE public.profiles SET role = 'admin' WHERE id = '${P.STU_A1}'`);
    assert.match(r.error, /role cannot be changed/);
    await db.exec('RESET ROLE');
    assert.equal((await attempt(db, "INSERT INTO public.profiles (id, role) VALUES (gen_random_uuid(), 'owner')")).ok, false, 'old role check is back');
  });
});
