/**
 * Migration 31: Baran Centre, the centre backfill, admin -> owner, and the
 * rewrite of inline `role = 'admin'` checks. Runs migrations 30 and 31 (and the
 * 31 rollback) on PGlite against the production shape of `profiles`, with
 * policies and functions written the way production writes them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { normalizeProfileRole, effectiveRole, roleLabel, isNetworkRole } from '../js/roles.js';
import { sanitizeCachedProfile } from '../js/profileCache.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_31 = read('supabase/migrations/31_multi_centre_data.sql');
const ROLLBACK_31 = read('supabase/rollbacks/31_multi_centre_data_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = { ADMIN: id(1), TEACHER: id(2), STU1: id(3), STU2: id(4), DIRECTOR: id(5), NEW_STU: id(6) };

// Production before migration 30, plus tables, policies and functions that
// check role = 'admin' inline the way production does.
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
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());

  -- Inline admin checks, as on homework_assignments and live_classes.
  CREATE TABLE public.homework_assignments (id serial PRIMARY KEY, title text);
  GRANT SELECT, INSERT ON public.homework_assignments TO authenticated;
  GRANT USAGE ON SEQUENCE public.homework_assignments_id_seq TO authenticated;
  ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
  CREATE POLICY hw_admin_select ON public.homework_assignments FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
  CREATE POLICY hw_admin_insert ON public.homework_assignments FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));

  CREATE FUNCTION public.admin_send_student_message(p_text text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  DECLARE v_role text;
  BEGIN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role = 'admin' THEN RETURN true; END IF;
    RETURN false;
  END $$;
  CREATE FUNCTION public.verify_homework_completion() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT role IN ('admin', 'teacher') FROM public.profiles WHERE id = auth.uid()), false)
  $$;
  GRANT EXECUTE ON FUNCTION public.admin_send_student_message(text), public.verify_homework_completion() TO authenticated;

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.ADMIN}', 'ADMIN01', 'Legacy admin', 'admin', 'Admin'),
    ('${P.TEACHER}', 'TCH01', 'Teacher', 'teacher', 'Teacher'),
    ('${P.STU1}', 'STU001', 'Asha', 'student', 'Level 1'),
    ('${P.STU2}', 'STU002', 'Ravi', 'student', NULL);
  INSERT INTO public.homework_assignments (title) VALUES ('Week 1');
`;

async function freshDb({ apply31 = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  if (apply31) await db.exec(MIGRATION_31);
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

async function execAttempt(db, sql) {
  try {
    await db.exec(sql);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function rows(db, sql, params = []) {
  await db.exec('RESET ROLE');
  return (await db.query(sql, params)).rows;
}

async function scalar(db, sql) {
  const { rows: [r] } = await db.query(`SELECT ${sql} AS v`);
  return r.v;
}

const BRN = (db) => rows(db, "SELECT id FROM public.centres WHERE code = 'BRN'").then((r) => r[0]?.id);

/** Owner makes a director through set_person_role (the only way in). */
async function makeDirector(db) {
  await db.exec('RESET ROLE');
  await db.query(`INSERT INTO public.profiles (id, student_code, full_name, role, level)
    VALUES ('${P.DIRECTOR}', 'DIR01', 'Director', 'student', NULL)`);
  await as(db, P.ADMIN);
  const r = await attempt(db, 'SELECT public.set_person_role($1, $2, NULL)', [P.DIRECTOR, 'director']);
  assert.equal(r.ok, true, r.error);
}

describe('migration 31: data', () => {
  it('creates Baran Centre, puts students and teachers in it, and makes the admin the owner', async () => {
    const db = await freshDb();
    const [centre] = await rows(db, "SELECT name, code, is_default, status FROM public.centres");
    assert.deepEqual(centre, { name: 'Baran Centre', code: 'BRN', is_default: true, status: 'active' });
    const brn = await BRN(db);
    const people = await rows(db, 'SELECT id, role, centre_id, full_name, level FROM public.profiles ORDER BY student_code');
    assert.deepEqual(people.map((p) => [p.full_name, p.role, p.centre_id === brn ? 'BRN' : p.centre_id, p.level]), [
      ['Legacy admin', 'owner', null, 'Admin'],
      ['Asha', 'student', 'BRN', 'Level 1'],
      ['Ravi', 'student', 'BRN', null],
      ['Teacher', 'teacher', 'BRN', 'Teacher'],
    ]);
  });

  it('keeps every row; nothing else changes', async () => {
    const db = await freshDb();
    assert.equal((await rows(db, 'SELECT count(*)::int n FROM public.profiles'))[0].n, 4);
    assert.equal((await rows(db, 'SELECT count(*)::int n FROM public.homework_assignments'))[0].n, 1);
  });

  it('records the admin -> owner change and the centre moves in the audit log', async () => {
    const db = await freshDb();
    const audit = await rows(db, `SELECT count(*)::int n FROM public.role_audit WHERE target_id = '${P.ADMIN}'`);
    assert.ok(audit[0].n >= 1);
  });

  it('can be run twice without changing anything the second time', async () => {
    const db = await freshDb();
    const before = await rows(db, "SELECT pg_get_functiondef('public.admin_send_student_message(text)'::regprocedure) d");
    await db.exec(MIGRATION_31);
    const after = await rows(db, "SELECT pg_get_functiondef('public.admin_send_student_message(text)'::regprocedure) d");
    assert.equal(after[0].d, before[0].d);
    assert.equal((await rows(db, 'SELECT count(*)::int n FROM public.centres'))[0].n, 1);
  });
});

describe('migration 31: new accounts and the centre rule', () => {
  it('a new student or teacher with no centre lands in Baran Centre', async () => {
    const db = await freshDb();
    await db.query(`INSERT INTO public.profiles (id, student_code, role, level) VALUES ('${P.NEW_STU}', 'STU099', 'student', 'Level 2')`);
    const [p] = await rows(db, `SELECT centre_id FROM public.profiles WHERE id = '${P.NEW_STU}'`);
    assert.equal(p.centre_id, await BRN(db));
  });

  it('a network role never keeps a centre, and a student cannot lose theirs', async () => {
    const db = await freshDb();
    const brn = await BRN(db);
    await db.query(`INSERT INTO public.profiles (id, student_code, role, level, centre_id)
      VALUES ('${P.NEW_STU}', 'OWN02', 'owner', 'Admin', '${brn}')`);
    assert.equal((await rows(db, `SELECT centre_id FROM public.profiles WHERE id = '${P.NEW_STU}'`))[0].centre_id, null);
    const r = await attempt(db, `UPDATE public.profiles SET centre_id = NULL WHERE id = '${P.STU1}'`);
    assert.equal(r.ok, false);
    assert.match(r.error, /profiles_centre_matches_role/);
  });

  it('set_person_role still works: owner makes a director (no centre) and a teacher (in BRN)', async () => {
    const db = await freshDb();
    await makeDirector(db);
    await as(db, P.ADMIN);
    assert.equal((await attempt(db, 'SELECT public.set_person_role($1, $2, NULL)', [P.STU2, 'teacher'])).ok, true);
    const brn = await BRN(db);
    const got = await rows(db, `SELECT id, role, centre_id FROM public.profiles WHERE id IN ('${P.DIRECTOR}', '${P.STU2}') ORDER BY id`);
    assert.deepEqual(got.map((p) => [p.role, p.centre_id]), [['teacher', brn], ['director', null]]);
  });

  it('students still cannot call default_centre() as anon', async () => {
    const db = await freshDb();
    await as(db, null, 'anon');
    const r = await attempt(db, 'SELECT public.default_centre()');
    assert.equal(r.ok, false);
    assert.match(r.error, /permission denied/i);
  });
});

describe('migration 31: inline admin checks', () => {
  it('policies let the owner and a director through and still block teachers and students', async () => {
    const db = await freshDb();
    await makeDirector(db);
    for (const [who, want] of [[P.ADMIN, 1], [P.DIRECTOR, 1], [P.TEACHER, 0], [P.STU1, 0]]) {
      await as(db, who);
      const { rows: r } = await db.query('SELECT count(*)::int n FROM public.homework_assignments');
      assert.equal(r[0].n > 0, want === 1, `select as ${who}`);
      const ins = await attempt(db, "INSERT INTO public.homework_assignments (title) VALUES ('x')");
      assert.equal(ins.ok, want === 1, `insert as ${who}`);
    }
  });

  it('functions treat owner and director as admin', async () => {
    const db = await freshDb();
    await makeDirector(db);
    for (const [who, send, verify] of [[P.ADMIN, true, true], [P.DIRECTOR, true, true],
      [P.TEACHER, false, true], [P.STU1, false, false]]) {
      await as(db, who);
      assert.equal(await scalar(db, "public.admin_send_student_message('hi')"), send, `send as ${who}`);
      assert.equal(await scalar(db, 'public.verify_homework_completion()'), verify, `verify as ${who}`);
    }
  });

  it('a centre head is not an admin in rewritten checks', async () => {
    const db = await freshDb();
    const brn = await BRN(db);
    await as(db, P.ADMIN);
    assert.equal((await attempt(db, 'SELECT public.set_person_role($1, $2, $3)', [P.TEACHER, 'centre_head', brn])).ok, true);
    await as(db, P.TEACHER);
    assert.equal(await scalar(db, "public.admin_send_student_message('hi')"), false);
    assert.equal((await db.query('SELECT count(*)::int n FROM public.homework_assignments')).rows[0].n, 0);
  });

  it('fails, changing nothing, when a function checks admin in a form it does not know', async () => {
    const db = await freshDb({ apply31: false });
    await db.exec(`CREATE FUNCTION public.odd_check() RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS (SELECT 1 FROM public.profiles WHERE role <> 'admin') $$`);
    const r = await execAttempt(db, `BEGIN; ${MIGRATION_31}; COMMIT;`);
    await db.exec('ROLLBACK').catch(() => {});
    assert.equal(r.ok, false);
    assert.match(r.error, /odd_check/);
    assert.equal((await rows(db, "SELECT role FROM public.profiles WHERE id = $1", [P.ADMIN]))[0].role, 'admin');
    assert.equal((await rows(db, 'SELECT count(*)::int n FROM public.centres'))[0].n, 0);
  });
});

describe('migration 31: rollback', () => {
  it('puts the admin, the checks and the centres back as they were', async () => {
    const db = await freshDb();
    await db.exec(ROLLBACK_31);
    const people = await rows(db, 'SELECT role, centre_id FROM public.profiles ORDER BY student_code');
    assert.deepEqual(people.map((p) => [p.role, p.centre_id]),
      [['admin', null], ['student', null], ['student', null], ['teacher', null]]);
    assert.equal((await rows(db, 'SELECT count(*)::int n FROM public.centres'))[0].n, 0);
    const fn = (await rows(db, "SELECT prosrc FROM pg_proc WHERE proname = 'admin_send_student_message'"))[0].prosrc;
    assert.match(fn, /v_role = 'admin'/);
    const pol = await rows(db, "SELECT qual FROM pg_policies WHERE policyname = 'hw_admin_select'");
    assert.match(pol[0].qual, /role = 'admin'::text/);
    await as(db, P.ADMIN);
    assert.equal(await scalar(db, "public.admin_send_student_message('hi')"), true);
  });

  it('refuses while a director exists', async () => {
    const db = await freshDb();
    await makeDirector(db);
    await db.exec('RESET ROLE');
    const r = await execAttempt(db, ROLLBACK_31);
    assert.equal(r.ok, false);
    assert.match(r.error, /Rollback refused/);
  });
});

describe('roles.js', () => {
  it('owners and directors act as admin on the existing pages; the real role is kept', () => {
    assert.deepEqual(normalizeProfileRole({ id: 1, role: 'owner' }), { id: 1, role: 'admin', network_role: 'owner' });
    assert.deepEqual(normalizeProfileRole({ id: 1, role: 'director' }), { id: 1, role: 'admin', network_role: 'director' });
    assert.deepEqual(normalizeProfileRole({ id: 1, role: 'admin' }), { id: 1, role: 'admin', network_role: 'admin' });
    for (const role of ['centre_head', 'vice_centre_head', 'teacher', 'student']) {
      assert.equal(normalizeProfileRole({ role }).role, role, `${role} is not widened`);
    }
  });

  it('is safe to call twice and with nothing', () => {
    const once = normalizeProfileRole({ role: 'director' });
    assert.deepEqual(normalizeProfileRole(once), once);
    assert.equal(normalizeProfileRole(null), null);
    assert.equal(normalizeProfileRole(undefined), undefined);
  });

  it('a forged network_role on a cached profile cannot widen its role', () => {
    assert.equal(normalizeProfileRole({ role: 'student', network_role: 'owner' }).role, 'student');
    assert.equal(normalizeProfileRole({ role: 'teacher', network_role: 'director' }).network_role, 'teacher');
    assert.equal(normalizeProfileRole({ role: 'admin', network_role: 'student' }).network_role, 'admin');
    assert.equal(effectiveRole('centre_head'), 'centre_head');
    assert.equal(isNetworkRole('centre_head'), false);
  });

  it('the profile cache keeps owners and directors on the admin pages, even when re-read', () => {
    const owner = sanitizeCachedProfile({ id: 'o', role: 'owner', centre_id: null });
    assert.equal(owner.role, 'admin');
    assert.equal(owner.network_role, 'owner');
    assert.deepEqual(sanitizeCachedProfile(owner), owner);
    const student = sanitizeCachedProfile({ id: 's', role: 'student', network_role: 'owner', centre_id: 'c1' });
    assert.equal(student.role, 'student');
    assert.equal(student.network_role, 'student');
    assert.equal(student.centre_id, 'c1');
  });

  it('labels the real role', () => {
    assert.equal(roleLabel(normalizeProfileRole({ role: 'director' })), 'Director');
    assert.equal(roleLabel({ role: 'admin' }), 'Owner');
    assert.equal(roleLabel({ role: 'vice_centre_head' }), 'Vice centre head');
  });
});
