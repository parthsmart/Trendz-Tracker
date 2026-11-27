/**
 * Multi-centre step 4: the centre head panel.
 *
 *  - migration 36 (centre_* functions) on PGlite after migrations 30, 32 and 33,
 *    including escalation attempts by heads, vice heads, teachers and students;
 *  - the centre checks the service-role API routes use (api/_centreScope.js);
 *  - the page logic in js/centreModel.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  assertStudentsInCentre,
  canManageTarget,
  resolveCreateCentre,
} from '../api/_centreScope.js';
import {
  backupFileName,
  backupSheets,
  canOpenCentrePanel,
  filterStudents,
  panelCapabilities,
  splitPeople,
  teacherPermissions,
  validateNewPerson,
  validatePersonEdit,
  validateSettings,
  viceCandidates,
} from '../js/centreModel.js';
import { describeAudit } from '../js/networkModel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const MIGRATION_36 = read('supabase/migrations/36_centre_head_panel.sql');
const ROLLBACK_36 = read('supabase/rollbacks/36_centre_head_panel_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1), DIRECTOR: id(2),
  HEAD_B: id(10), VICE_B: id(11), TCH_B: id(12), STU_B1: id(13), STU_B2: id(14),
  HEAD_K: id(20), TCH_K: id(21), STU_K: id(22),
};

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
  CREATE TABLE public.teacher_permissions (
    teacher_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    can_view_students boolean NOT NULL DEFAULT true,
    can_mark_attendance boolean NOT NULL DEFAULT true,
    can_correct_attendance boolean NOT NULL DEFAULT true,
    can_generate_reports boolean NOT NULL DEFAULT true,
    can_manage_tasks boolean NOT NULL DEFAULT true,
    can_manage_tests boolean NOT NULL DEFAULT true,
    can_publish_announcements boolean NOT NULL DEFAULT true,
    can_manage_resources boolean NOT NULL DEFAULT true,
    can_review_scores boolean NOT NULL DEFAULT true,
    can_request_corrections boolean NOT NULL DEFAULT true,
    can_schedule_live_classes boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );
  CREATE TABLE public.teacher_student_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    assigned_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (teacher_id, student_id)
  );
  CREATE TABLE public.teacher_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    actor_id uuid NOT NULL REFERENCES public.profiles(id),
    action text NOT NULL CHECK (action IN ('create_teacher', 'update_permissions', 'assign_students',
      'unassign_students', 'activate', 'deactivate', 'reset_password')),
    details jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE public.results (id serial PRIMARY KEY, student_id uuid, score int);
  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON public.profiles TO service_role;

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN RETURN NEW; END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());
  CREATE POLICY profiles_admin_update ON public.profiles FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

  INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
    ('${P.OWNER}', 'ADMIN01', 'Owner', 'admin', 'Admin'),
    ('${P.DIRECTOR}', 'DIR01', 'Director', 'student', NULL),
    ('${P.HEAD_B}', 'HEADB', 'Head Baran', 'student', NULL),
    ('${P.VICE_B}', 'VICEB', 'Vice Baran', 'teacher', 'Teacher'),
    ('${P.TCH_B}', 'TCHB', 'Teacher Baran', 'teacher', 'Teacher'),
    ('${P.STU_B1}', 'STUB1', 'Asha', 'student', 'Level 1'),
    ('${P.STU_B2}', 'STUB2', 'Ravi', 'student', NULL),
    ('${P.HEAD_K}', 'HEADK', 'Head Kota', 'student', NULL),
    ('${P.TCH_K}', 'TCHK', 'Teacher Kota', 'teacher', 'Teacher'),
    ('${P.STU_K}', 'STUK', 'Kiran', 'student', 'Level 2');
  INSERT INTO public.results (student_id, score) VALUES
    ('${P.STU_B1}', 10), ('${P.STU_B2}', 20), ('${P.STU_K}', 30);
`;

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

/** Runs as the database owner with no signed-in person (like the service role). */
async function rows(db, sql, params = []) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  return (await db.query(sql, params)).rows;
}

const call = (db, fn, args) => {
  const list = args.map((_, i) => `$${i + 1}`).join(', ');
  return attempt(db, `SELECT public.${fn}(${list}) AS r`, args);
};

/**
 * Migrations 30, 32, 33, 35; centres BRN (default) and KTA.
 * BRN: head HEAD_B, teachers VICE_B and TCH_B, students STU_B1 / STU_B2.
 * KTA: head HEAD_K, teacher TCH_K, student STU_K.
 */
async function freshDb() {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
  await db.exec(MIGRATION_36);
  await as(db, P.OWNER);
  const k = await attempt(db, "INSERT INTO public.centres (name, code) VALUES ('Kota Centre', 'KTA') RETURNING id");
  assert.equal(k.ok, true, k.error);
  const kta = k.rows[0].id;
  const [{ id: brn }] = await rows(db, "SELECT id FROM public.centres WHERE code = 'BRN'");
  await rows(db, 'UPDATE public.profiles SET centre_id = $1 WHERE id = ANY ($2::uuid[])', [kta, [P.TCH_K, P.STU_K]]);
  await as(db, P.OWNER);
  for (const [target, role, centre] of [
    [P.DIRECTOR, 'director', null],
    [P.HEAD_B, 'centre_head', brn],
    [P.HEAD_K, 'centre_head', kta],
  ]) {
    const r = await call(db, 'set_person_role', [target, role, centre]);
    assert.equal(r.ok, true, r.error);
  }
  return { db, brn, kta };
}

async function withVice(ctx) {
  await as(ctx.db, P.HEAD_B);
  const r = await call(ctx.db, 'set_person_role', [P.VICE_B, 'vice_centre_head', ctx.brn]);
  assert.equal(r.ok, true, r.error);
  return ctx;
}

describe('migration 36: centre_panel', () => {
  it('a head reads their own centre, people, assignments and can_head', async () => {
    const { db, brn } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_panel', [null]);
    assert.equal(r.ok, true, r.error);
    const panel = r.rows[0].r;
    assert.equal(panel.centre.id, brn);
    assert.equal(panel.centre.code, 'BRN');
    assert.equal(panel.my_role, 'centre_head');
    assert.equal(panel.can_head, true);
    const ids = panel.people.map((p) => p.id);
    assert.ok(ids.includes(P.STU_B1) && ids.includes(P.TCH_B));
    assert.ok(!ids.includes(P.STU_K), 'no Kota students');
    assert.ok(!ids.includes(P.OWNER), 'network staff are not centre people');
  });

  it("a head cannot read another centre's panel", async () => {
    const { db, kta } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_panel', [kta]);
    assert.equal(r.ok, false);
    assert.match(r.error, /own centre/);
  });

  it('owners and directors read any centre; can_head is true for them', async () => {
    const { db, kta } = await freshDb();
    for (const who of [P.OWNER, P.DIRECTOR]) {
      await as(db, who);
      const r = await call(db, 'centre_panel', [kta]);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.rows[0].r.can_head, true);
      assert.ok(r.rows[0].r.people.some((p) => p.id === P.STU_K));
    }
  });

  it('teachers, students and signed-out callers are refused', async () => {
    const { db, brn } = await freshDb();
    for (const who of [P.TCH_B, P.STU_B1]) {
      await as(db, who);
      const r = await call(db, 'centre_panel', [brn]);
      assert.equal(r.ok, false, `${who} must be refused`);
    }
    await as(db, '', 'anon');
    const anon = await call(db, 'centre_panel', [brn]);
    assert.equal(anon.ok, false);
    assert.match(anon.error, /permission denied/);
  });

  it("a suspended centre's head is refused", async () => {
    const { db, kta } = await freshDb();
    await rows(db, "UPDATE public.centres SET status = 'suspended' WHERE id = $1", [kta]);
    await as(db, P.HEAD_K);
    const r = await call(db, 'centre_panel', [null]);
    assert.equal(r.ok, false);
    const edit = await call(db, 'centre_update_person', [P.STU_K, 'Kiran K', null]);
    assert.equal(edit.ok, false);
  });

  it('the internal helpers cannot be called from the site', async () => {
    const { db } = await freshDb();
    await as(db, P.HEAD_B);
    const a = await attempt(db, 'SELECT public.centre_panel_centre(NULL, false)');
    assert.equal(a.ok, false);
    assert.match(a.error, /permission denied/);
    const b = await attempt(db, 'SELECT public.centre_panel_person($1, false, ARRAY[\'student\'])', [P.STU_B1]);
    assert.equal(b.ok, false);
    assert.match(b.error, /permission denied/);
  });
});

describe('migration 36: people', () => {
  it('a head and a vice head edit names and levels of their own students', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.HEAD_B);
    const a = await call(db, 'centre_update_person', [P.STU_B1, 'Asha Rao', 'Level 2']);
    assert.equal(a.ok, true, a.error);
    await as(db, P.VICE_B);
    const b = await call(db, 'centre_update_person', [P.STU_B2, 'Ravi Kumar', 'Master']);
    assert.equal(b.ok, true, b.error);
    const got = await rows(db, 'SELECT id, full_name, level FROM public.profiles WHERE id = ANY ($1::uuid[]) ORDER BY student_code', [[P.STU_B1, P.STU_B2]]);
    assert.deepEqual(got.map((r) => [r.full_name, r.level]), [['Asha Rao', 'Level 2'], ['Ravi Kumar', 'Master']]);
  });

  it('bad names and levels are refused', async () => {
    const { db } = await freshDb();
    await as(db, P.HEAD_B);
    assert.equal((await call(db, 'centre_update_person', [P.STU_B1, 'A', null])).ok, false);
    assert.equal((await call(db, 'centre_update_person', [P.STU_B1, 'Asha', 'Level 99'])).ok, false);
  });

  it("a head cannot edit, deactivate, delete or reset another centre's people", async () => {
    const { db } = await freshDb();
    await as(db, P.HEAD_B);
    for (const [fn, args] of [
      ['centre_update_person', [P.STU_K, 'Hacked', null]],
      ['centre_set_active', [P.STU_K, false]],
      ['centre_soft_delete', [P.STU_K]],
      ['centre_set_active', [P.TCH_K, false]],
    ]) {
      const r = await call(db, fn, args);
      assert.equal(r.ok, false, `${fn} on Kota must fail`);
      assert.match(r.error, /own centre/);
    }
    const [k] = await rows(db, 'SELECT full_name, active, deleted_at FROM public.profiles WHERE id = $1', [P.STU_K]);
    assert.deepEqual([k.full_name, k.active, k.deleted_at], ['Kiran', true, null]);
  });

  it('heads cannot touch heads, vice heads, network staff or themselves', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.HEAD_B);
    for (const target of [P.VICE_B, P.HEAD_B, P.OWNER, P.DIRECTOR, P.HEAD_K]) {
      const r = await call(db, 'centre_set_active', [target, false]);
      assert.equal(r.ok, false, `${target} must be refused`);
    }
    await as(db, P.VICE_B);
    assert.equal((await call(db, 'centre_set_active', [P.HEAD_B, false])).ok, false, 'vice cannot deactivate head');
    assert.equal((await call(db, 'centre_update_person', [P.HEAD_B, 'Renamed', null])).ok, false);
  });

  it('vice heads can activate and deactivate; teacher changes are written to the teacher log', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.VICE_B);
    const r = await call(db, 'centre_set_active', [P.TCH_B, false]);
    assert.equal(r.ok, true, r.error);
    const [log] = await rows(db, "SELECT actor_id, action, details FROM public.teacher_audit_log WHERE teacher_id = $1", [P.TCH_B]);
    assert.equal(log.actor_id, P.VICE_B);
    assert.equal(log.action, 'deactivate');
    assert.equal(log.details.via, 'centre_panel');
    await as(db, P.VICE_B);
    const back = await call(db, 'centre_set_active', [P.TCH_B, true]);
    assert.equal(back.ok, true, back.error);
  });

  it('only the head deletes and restores; the record is kept', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.VICE_B);
    const v = await call(db, 'centre_soft_delete', [P.STU_B1]);
    assert.equal(v.ok, false);
    assert.match(v.error, /Only the centre head/);

    await as(db, P.HEAD_B);
    const d = await call(db, 'centre_soft_delete', [P.STU_B1]);
    assert.equal(d.ok, true, d.error);
    let [s] = await rows(db, 'SELECT active, deleted_at, deleted_by FROM public.profiles WHERE id = $1', [P.STU_B1]);
    assert.equal(s.active, false);
    assert.ok(s.deleted_at);
    assert.equal(s.deleted_by, P.HEAD_B);
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM public.results WHERE student_id = $1', [P.STU_B1]))[0].n, 1);

    await as(db, P.HEAD_B);
    assert.equal((await call(db, 'centre_update_person', [P.STU_B1, 'Asha', null])).ok, false, 'deleted people are not edited');
    await as(db, P.VICE_B);
    assert.equal((await call(db, 'centre_restore', [P.STU_B1])).ok, false);
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_restore', [P.STU_B1]);
    assert.equal(r.ok, true, r.error);
    [s] = await rows(db, 'SELECT active, deleted_at FROM public.profiles WHERE id = $1', [P.STU_B1]);
    assert.deepEqual([s.active, s.deleted_at], [true, null]);
  });

  it('teachers and students cannot use the centre functions', async () => {
    const { db } = await freshDb();
    for (const who of [P.TCH_B, P.STU_B1]) {
      await as(db, who);
      assert.equal((await call(db, 'centre_update_person', [P.STU_B2, 'Hacked', null])).ok, false);
      assert.equal((await call(db, 'centre_set_active', [P.STU_B2, false])).ok, false);
      assert.equal((await call(db, 'centre_set_teacher_assignments', [P.TCH_B, [P.STU_B2]])).ok, false);
    }
  });
});

describe('migration 36: teachers', () => {
  it('a head assigns students of the same centre and the old list is replaced', async () => {
    const { db } = await freshDb();
    await as(db, P.HEAD_B);
    let r = await call(db, 'centre_set_teacher_assignments', [P.TCH_B, [P.STU_B1, P.STU_B2, P.STU_B1]]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.rows[0].r.assigned_count, 2);
    r = await call(db, 'centre_set_teacher_assignments', [P.TCH_B, [P.STU_B2]]);
    assert.equal(r.ok, true, r.error);
    const got = await rows(db, 'SELECT student_id FROM public.teacher_student_assignments WHERE teacher_id = $1', [P.TCH_B]);
    assert.deepEqual(got.map((g) => g.student_id), [P.STU_B2]);
  });

  it('students of another centre cannot be assigned', async () => {
    const { db } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_set_teacher_assignments', [P.TCH_B, [P.STU_B1, P.STU_K]]);
    assert.equal(r.ok, false);
    assert.match(r.error, /Only active students of this centre/);
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM public.teacher_student_assignments'))[0].n, 0);
    await as(db, P.HEAD_B);
    const other = await call(db, 'centre_set_teacher_assignments', [P.TCH_K, [P.STU_K]]);
    assert.equal(other.ok, false, "another centre's teacher");
  });

  it('a vice head changes teacher permissions; only known switches change', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.VICE_B);
    const r = await call(db, 'centre_update_teacher_permissions', [P.TCH_B, JSON.stringify({
      can_manage_tests: false, can_schedule_live_classes: true, is_admin: true,
    })]);
    assert.equal(r.ok, true, r.error);
    const [p] = await rows(db, 'SELECT * FROM public.teacher_permissions WHERE teacher_id = $1', [P.TCH_B]);
    assert.equal(p.can_manage_tests, false);
    assert.equal(p.can_schedule_live_classes, true);
    assert.equal(p.can_view_students, true);
    assert.equal(p.updated_by, P.VICE_B);
    const [prof] = await rows(db, 'SELECT role FROM public.profiles WHERE id = $1', [P.TCH_B]);
    assert.equal(prof.role, 'teacher', 'no escalation through permissions');
  });

  it('permissions cannot be set on a student or a vice head', async () => {
    const ctx = await withVice(await freshDb());
    const { db } = ctx;
    await as(db, P.HEAD_B);
    assert.equal((await call(db, 'centre_update_teacher_permissions', [P.STU_B1, '{}'])).ok, false);
    assert.equal((await call(db, 'centre_update_teacher_permissions', [P.VICE_B, '{}'])).ok, false);
  });
});

describe('migration 36: vice heads (set_person_role)', () => {
  it('a head appoints and removes a vice head of their own centre', async () => {
    const ctx = await withVice(await freshDb());
    const { db, brn } = ctx;
    let [v] = await rows(db, 'SELECT role FROM public.profiles WHERE id = $1', [P.VICE_B]);
    assert.equal(v.role, 'vice_centre_head');
    await as(db, P.HEAD_B);
    const r = await call(db, 'set_person_role', [P.VICE_B, 'teacher', brn]);
    assert.equal(r.ok, true, r.error);
    [v] = await rows(db, 'SELECT role FROM public.profiles WHERE id = $1', [P.VICE_B]);
    assert.equal(v.role, 'teacher');
  });

  it('a vice head cannot appoint another vice head or a head', async () => {
    const ctx = await withVice(await freshDb());
    const { db, brn } = ctx;
    await as(db, P.VICE_B);
    assert.equal((await call(db, 'set_person_role', [P.TCH_B, 'vice_centre_head', brn])).ok, false);
    assert.equal((await call(db, 'set_person_role', [P.TCH_B, 'centre_head', brn])).ok, false);
    assert.equal((await call(db, 'set_person_role', [P.VICE_B, 'centre_head', brn])).ok, false, 'not themselves');
  });

  it('a head cannot appoint in another centre or promote to head or director', async () => {
    const { db, brn, kta } = await freshDb();
    await as(db, P.HEAD_B);
    assert.equal((await call(db, 'set_person_role', [P.TCH_K, 'vice_centre_head', kta])).ok, false);
    assert.equal((await call(db, 'set_person_role', [P.TCH_B, 'vice_centre_head', kta])).ok, false);
    assert.equal((await call(db, 'set_person_role', [P.TCH_B, 'centre_head', brn])).ok, false);
    assert.equal((await call(db, 'set_person_role', [P.TCH_B, 'director', null])).ok, false);
  });
});

describe('migration 36: settings and backup', () => {
  it('a head updates name, city and the allowed settings only', async () => {
    const { db, brn } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_update_settings', [brn, 'Baran Main', 'Baran', JSON.stringify({
      phone: '98765', address: 'Main road', status: 'archived', code: 'XXX',
    })]);
    assert.equal(r.ok, true, r.error);
    const [c] = await rows(db, 'SELECT name, city, code, status, settings FROM public.centres WHERE id = $1', [brn]);
    assert.equal(c.name, 'Baran Main');
    assert.equal(c.city, 'Baran');
    assert.equal(c.code, 'BRN');
    assert.equal(c.status, 'active');
    assert.equal(c.settings.phone, '98765');
    assert.equal(c.settings.status, undefined);
    assert.equal(c.settings.code, undefined);
  });

  it('a vice head and another centre head cannot change settings', async () => {
    const ctx = await withVice(await freshDb());
    const { db, brn } = ctx;
    await as(db, P.VICE_B);
    const v = await call(db, 'centre_update_settings', [brn, 'Vice name', null, '{}']);
    assert.equal(v.ok, false);
    assert.match(v.error, /Only the centre head/);
    await as(db, P.HEAD_K);
    assert.equal((await call(db, 'centre_update_settings', [brn, 'Kota took it', null, '{}'])).ok, false);
  });

  it("a duplicate name gives a clear message", async () => {
    const { db, brn } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_update_settings', [brn, 'Kota Centre', null, '{}']);
    assert.equal(r.ok, false);
    assert.match(r.error, /already has that name/);
  });

  it("the backup holds only the centre's people and their records, and is audited", async () => {
    const { db, brn } = await freshDb();
    await as(db, P.HEAD_B);
    const r = await call(db, 'centre_backup', [null]);
    assert.equal(r.ok, true, r.error);
    const b = r.rows[0].r;
    assert.equal(b.centre.code, 'BRN');
    const codes = b.tables.profiles.map((p) => p.student_code).sort();
    assert.ok(codes.includes('STUB1') && codes.includes('TCHB'));
    assert.ok(!codes.includes('STUK'));
    assert.deepEqual(b.tables.results.map((x) => x.score).sort(), [10, 20]);
    assert.equal(b.counts.results, 2);
    const audit = await rows(db, "SELECT actor_id, centre_id FROM public.role_audit WHERE action = 'centre_backup'");
    assert.deepEqual(audit, [{ actor_id: P.HEAD_B, centre_id: brn }]);
  });

  it('a vice head and another centre head cannot download the backup', async () => {
    const ctx = await withVice(await freshDb());
    const { db, brn } = ctx;
    await as(db, P.VICE_B);
    assert.equal((await call(db, 'centre_backup', [null])).ok, false);
    await as(db, P.HEAD_K);
    assert.equal((await call(db, 'centre_backup', [brn])).ok, false);
  });

  it('heads read their own centre audit rows only', async () => {
    const { db, brn } = await freshDb();
    await as(db, P.HEAD_B);
    await call(db, 'centre_backup', [null]);
    await as(db, P.HEAD_K);
    await call(db, 'centre_backup', [null]);
    await as(db, P.HEAD_B);
    const r = await attempt(db, "SELECT centre_id FROM public.role_audit WHERE action = 'centre_backup'");
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.rows.map((x) => x.centre_id), [brn]);
  });
});

describe('rollback 36', () => {
  it('drops every centre panel function and leaves the data', async () => {
    const { db } = await freshDb();
    await db.exec('RESET ROLE');
    await db.exec(ROLLBACK_36);
    const left = await rows(db, "SELECT proname FROM pg_proc WHERE proname LIKE 'centre\\_%'");
    assert.deepEqual(left, []);
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM public.profiles'))[0].n, 10);
    await db.exec(MIGRATION_36);
  });
});

// ---------------------------------------------------------------------------
// API centre checks
// ---------------------------------------------------------------------------

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

function fakeAdmin({ centres = {}, profiles = [] } = {}) {
  return {
    from(table) {
      const q = { filters: [] };
      const api = {
        select() { return api; },
        eq(col, val) { q.filters.push((r) => r[col] === val); return api; },
        in(col, vals) { q.filters.push((r) => vals.includes(r[col])); return api; },
        async maybeSingle() {
          const list = table === 'centres' ? Object.values(centres) : profiles;
          return { data: list.find((r) => q.filters.every((f) => f(r))) || null, error: null };
        },
        then(resolve) {
          const list = table === 'centres' ? Object.values(centres) : profiles;
          resolve({ data: list.filter((r) => q.filters.every((f) => f(r))), error: null });
        },
      };
      return api;
    },
  };
}

describe('api/_centreScope.js', () => {
  const admin = fakeAdmin({ centres: { [C1]: { id: C1, status: 'active' }, [C2]: { id: C2, status: 'suspended' } } });
  const head = { id: 'h', role: 'centre_head', network_role: 'centre_head', centre_id: C1 };
  const owner = { id: 'o', role: 'admin', network_role: 'owner', centre_id: null };

  it('heads always create in their own centre; another centre is refused', async () => {
    assert.equal(await resolveCreateCentre(head, undefined, admin), C1);
    assert.equal(await resolveCreateCentre(head, C1, admin), C1);
    await assert.rejects(resolveCreateCentre(head, C2, admin), (e) => e.statusCode === 403 && /own centre/.test(e.message));
    await assert.rejects(resolveCreateCentre({ ...head, centre_id: null }, undefined, admin), (e) => e.statusCode === 403);
    await assert.rejects(resolveCreateCentre(head, 'not-a-uuid', admin), (e) => e.statusCode === 400);
  });

  it("a suspended centre's head cannot create people", async () => {
    await assert.rejects(resolveCreateCentre({ ...head, centre_id: C2 }, undefined, admin),
      (e) => e.statusCode === 403 && /not active/.test(e.message));
  });

  it('network callers choose any active centre, or the default', async () => {
    assert.equal(await resolveCreateCentre(owner, undefined, admin), null);
    assert.equal(await resolveCreateCentre(owner, C1, admin), C1);
    await assert.rejects(resolveCreateCentre(owner, C2, admin), (e) => e.statusCode === 400);
  });

  it('canManageTarget mirrors rank and centre', () => {
    const vice = { id: 'v', network_role: 'vice_centre_head', role: 'vice_centre_head', centre_id: C1 };
    const director = { id: 'd', network_role: 'director', role: 'admin' };
    assert.equal(canManageTarget(head, { id: 's', role: 'student', centre_id: C1 }), true);
    assert.equal(canManageTarget(head, { id: 't', role: 'teacher', centre_id: C1 }), true);
    assert.equal(canManageTarget(head, { id: 's', role: 'student', centre_id: C2 }), false);
    assert.equal(canManageTarget(head, { id: 'v', role: 'vice_centre_head', centre_id: C1 }), false);
    assert.equal(canManageTarget(head, { id: 'h', role: 'centre_head', centre_id: C1 }), false, 'not self');
    assert.equal(canManageTarget(vice, { id: 'h2', role: 'centre_head', centre_id: C1 }), false);
    assert.equal(canManageTarget(director, { id: 'o', role: 'owner' }), false, 'director cannot reset owners');
    assert.equal(canManageTarget(director, { id: 'x', role: 'student', centre_id: C2 }), true);
    assert.equal(canManageTarget(owner, { id: 'o2', role: 'owner' }), true);
  });

  it('assertStudentsInCentre refuses students of other centres or deleted ones', async () => {
    const db = fakeAdmin({ profiles: [
      { id: 'a', role: 'student', active: true, deleted_at: null, centre_id: C1 },
      { id: 'b', role: 'student', active: true, deleted_at: null, centre_id: C2 },
      { id: 'c', role: 'student', active: true, deleted_at: '2026-01-01', centre_id: C1 },
    ] });
    assert.deepEqual(await assertStudentsInCentre(db, ['a', 'a'], C1), ['a']);
    await assert.rejects(assertStudentsInCentre(db, ['a', 'b'], C1), (e) => e.statusCode === 400);
    await assert.rejects(assertStudentsInCentre(db, ['c'], C1), (e) => e.statusCode === 400);
  });

  it('the routes use the staff check and the centre scope', () => {
    const student = read('api/create-student.js');
    assert.match(student, /verifyStaffCaller\(req, \{ minRole: 'vice_centre_head' \}\)/);
    assert.match(student, /resolveCreateCentre/);
    const reset = read('api/reset-password.js');
    assert.match(reset, /canManageTarget/);
    const teacher = read('api/_teacherAdmin.js');
    assert.match(teacher, /centre_set_teacher_assignments/);
    assert.match(teacher, /canManageTarget/);
  });
});

// ---------------------------------------------------------------------------
// Page logic
// ---------------------------------------------------------------------------

describe('js/centreModel.js', () => {
  it('who opens the panel and what they may do', () => {
    assert.equal(canOpenCentrePanel({ role: 'centre_head' }), true);
    assert.equal(canOpenCentrePanel({ role: 'vice_centre_head' }), true);
    assert.equal(canOpenCentrePanel({ role: 'admin', network_role: 'director' }), true);
    assert.equal(canOpenCentrePanel({ role: 'teacher' }), false);
    assert.equal(canOpenCentrePanel({ role: 'student' }), false);
    const vice = panelCapabilities('vice_centre_head', false);
    assert.equal(vice.editPeople, true);
    assert.equal(vice.setActive, true);
    assert.equal(vice.deleteRestore, false);
    assert.equal(vice.settings, false);
    assert.equal(vice.backup, false);
    assert.equal(vice.viceHeads, false);
    const head = panelCapabilities('centre_head', true);
    assert.equal(head.backup && head.settings && head.viceHeads && head.deleteRestore, true);
    assert.equal(panelCapabilities('owner', true).backup, true);
    assert.equal(panelCapabilities('teacher', false).view, false);
  });

  it('splits and filters people', () => {
    const people = [
      { id: 1, role: 'centre_head', full_name: 'H', active: true },
      { id: 2, role: 'vice_centre_head', full_name: 'V', active: true },
      { id: 3, role: 'teacher', full_name: 'T', active: true },
      { id: 4, role: 'teacher', full_name: 'T2', active: false },
      { id: 5, role: 'student', full_name: 'Asha', student_code: 'S1', active: true },
      { id: 6, role: 'student', full_name: 'Ravi', student_code: 'S2', active: false },
      { id: 7, role: 'student', full_name: 'Gone', active: false, deleted_at: '2026-01-01' },
    ];
    const s = splitPeople(people);
    assert.equal(s.head.id, 1);
    assert.equal(s.vices.length, 1);
    assert.equal(s.students.length, 2);
    assert.equal(s.deleted.length, 1);
    assert.deepEqual(filterStudents(s.students, { status: 'active' }).map((p) => p.id), [5]);
    assert.deepEqual(filterStudents(s.students, { query: 's2' }).map((p) => p.id), [6]);
    assert.deepEqual(viceCandidates(people).map((p) => p.id), [3]);
  });

  it('validates forms', () => {
    assert.ok(validateNewPerson({ code: 'stu9', name: 'Asha', password: 'secret1', role: 'student' }).value);
    assert.equal(validateNewPerson({ code: 'stu9', name: 'Asha', password: 'secret1' }).value.code, 'STU9');
    assert.ok(validateNewPerson({ code: 'x', name: 'Asha', password: 'secret1' }).error);
    assert.ok(validateNewPerson({ code: 'STU9', name: 'Asha', password: '123' }).error);
    assert.ok(validateNewPerson({ code: 'STU9', name: 'Asha', password: 'secret1', level: 'Level 99' }).error);
    assert.equal(validatePersonEdit({ name: 'Anita', level: 'Level 1', role: 'teacher' }).value.level, null);
    assert.ok(validateSettings({ name: 'Baran', settings: { email: 'bad' } }).error);
    assert.ok(validateSettings({ name: 'Baran', settings: { phone: 'x'.repeat(31) } }).error);
    assert.deepEqual(validateSettings({ name: ' Baran ', city: '', settings: { email: 'a@b.in' } }).value,
      { name: 'Baran', city: '', settings: { address: '', phone: '', email: 'a@b.in', notes: '' } });
  });

  it('teacher permission defaults match the database', () => {
    const p = teacherPermissions([], 't');
    assert.equal(p.can_view_students, true);
    assert.equal(p.can_schedule_live_classes, false);
    assert.equal(teacherPermissions([{ teacher_id: 't', can_view_students: false }], 't').can_view_students, false);
  });

  it('turns a backup into sheets and names the file', () => {
    const sheets = backupSheets({
      centre: { name: 'Baran', code: 'BRN' }, generated_at: 'now', row_limit: 50000,
      tables: { profiles: [{ id: 1, settings: { a: 1 } }, { id: 2, extra: 'x' }], results: [] },
    });
    assert.equal(sheets[0].name, 'Summary');
    assert.deepEqual(sheets[1].header, ['id', 'settings', 'extra']);
    assert.deepEqual(sheets[1].rows[0], [1, '{"a":1}', '']);
    assert.deepEqual(sheets[2].header, ['(no rows)']);
    assert.equal(backupFileName({ code: 'BR/N' }, new Date('2026-11-28T10:00:00Z')), 'trendz-centre-BRN-2026-11-28.xlsx');
  });

  it('describes a centre backup in the audit list', () => {
    const text = describeAudit({ action: 'centre_backup', actor_id: 'a', centre_id: 'c' },
      new Map([['a', 'Meena']]), new Map([['c', { name: 'Baran Centre' }]]));
    assert.match(text, /Meena downloaded the backup of Baran Centre/);
  });
});
