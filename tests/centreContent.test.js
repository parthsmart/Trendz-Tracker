/**
 * Multi-centre step 5d: content belongs to a centre.
 *
 *  - migration 45 on PGlite after migrations 30, 32 and 33, centres BRN (default) and KTA:
 *    existing rows land in the default centre; teachers and heads always write their
 *    own centre and cannot move a row; owners and directors may pick a centre or
 *    "every centre"; the API (service role) gets the author's centre;
 *  - read policies, student functions, recipients, homework, live classes, the store,
 *    weekly test attempts and teacher_bulk_apply_level_access stay inside the centre;
 *  - escalation attempts (forging centre_id, adding another centre's student,
 *    calling the service-only helper) are refused; the rollback restores the
 *    pre-45 behaviour without dropping the column;
 *  - API helpers: isStudentInAudience and isTaskInStudentCentre.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { isStudentInAudience } from '../api/_liveClass.js';
import { isTaskInStudentCentre } from '../api/_dailyTasks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const MIGRATION_30 = read('supabase/migrations/30_multi_centre_schema.sql');
const MIGRATION_32 = read('supabase/migrations/32_multi_centre_data.sql');
const MIGRATION_33 = read('supabase/migrations/33_centres_guard.sql');
const MIGRATION_45 = read('supabase/migrations/45_centre_content.sql');
const ROLLBACK_45 = read('supabase/rollbacks/45_centre_content_rollback.sql');

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const P = {
  OWNER: id(1), DIRECTOR: id(2),
  HEAD_B: id(10), TCH_B: id(12), STU_B1: id(13), STU_B2: id(14),
  HEAD_K: id(20), TCH_K: id(21), STU_K: id(22),
};
const LEGACY = { ANN: id(900), TEST: id(901), HW: id(902), CLASS: id(903) };

const CONTENT_POLICIES = [
  ['announcements', 'announcements_read_policy'],
  ['daily_tasks', 'daily_tasks_read_policy'],
  ['resources', 'resources_read_policy'],
  ['weekly_tests', 'weekly_tests_select_scoped'],
];

const BASE = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

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
  CREATE TABLE public.teacher_student_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    UNIQUE (teacher_id, student_id)
  );
  CREATE TABLE public.teacher_permissions (
    teacher_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    can_view_students boolean NOT NULL DEFAULT true,
    can_manage_tasks boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid
  );
  CREATE TABLE public.categories (id uuid PRIMARY KEY, name text);

  CREATE TABLE public.announcements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, audience_level text,
    created_by uuid, target_scope text NOT NULL DEFAULT 'all');
  CREATE TABLE public.daily_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, level text, active boolean DEFAULT true,
    created_by uuid, target_scope text NOT NULL DEFAULT 'all');
  CREATE TABLE public.resources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, audience_level text, active boolean DEFAULT true,
    created_by uuid, target_scope text NOT NULL DEFAULT 'all');
  CREATE TABLE public.weekly_tests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, notes text, test_date date DEFAULT current_date,
    audience_level text, test_type text DEFAULT 'online', opens_at timestamptz, closes_at timestamptz,
    created_by uuid, target_scope text NOT NULL DEFAULT 'all');
  CREATE TABLE public.weekly_test_sections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_id uuid, kind text, category_id uuid, activity_key text,
    seconds int, position int, flash_digits int, flash_count int, flash_speed_ms int, flash_mode text, question_count int);
  CREATE TABLE public.weekly_test_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_id uuid, student_id uuid, section_id uuid,
    status text, tries_started int, tries_correct int);
  CREATE TABLE public.weekly_test_practice_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_id uuid, student_id uuid);
  CREATE TABLE public.weekly_test_scores (
    test_id uuid, student_id uuid, section_id uuid, category_id uuid,
    correct int, total int, time_seconds int, source text);
  CREATE TABLE public.announcement_recipients (announcement_id uuid, student_id uuid);
  CREATE TABLE public.daily_task_recipients (task_id uuid, student_id uuid);
  CREATE TABLE public.resource_recipients (resource_id uuid, student_id uuid);
  CREATE TABLE public.weekly_test_recipients (test_id uuid, student_id uuid);
  CREATE TABLE public.homework_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, assigned_by uuid,
    target_type text, target_level text, target_student_id uuid);
  CREATE TABLE public.homework_completions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id uuid, student_id uuid);
  CREATE TABLE public.live_classes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, teacher_id uuid, invited_teacher_ids jsonb,
    target_level text, target_student_ids jsonb, created_by uuid, status text DEFAULT 'scheduled',
    provider_status text, scheduled_start_time timestamptz DEFAULT now(), duration_minutes int DEFAULT 60);
  CREATE TABLE public.reward_items (
    id bigserial PRIMARY KEY, name text, icon text, description text, cost int, stock int,
    active boolean DEFAULT true, updated_at timestamptz);
  CREATE TABLE public.reward_redemptions (
    id bigserial PRIMARY KEY, student_id uuid, item_id bigint, item_name text, item_icon text, cost int,
    status text DEFAULT 'requested', requested_at timestamptz DEFAULT now(), decided_at timestamptz, note text);
  CREATE TABLE public.student_practice_access (
    id bigserial PRIMARY KEY, scope text, level text, student_id uuid, settings jsonb,
    updated_at timestamptz, updated_by uuid);
  CREATE UNIQUE INDEX student_practice_access_student ON public.student_practice_access (student_id)
    WHERE scope = 'student';

  CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'admin' AND active FROM public.profiles WHERE id = auth.uid()), false) $$;
  CREATE FUNCTION public.is_teacher(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT COALESCE((SELECT role = 'teacher' AND active FROM public.profiles WHERE id = u), false) $$;
  CREATE FUNCTION public.today_ist() RETURNS date LANGUAGE sql STABLE AS $$ SELECT current_date $$;
  CREATE FUNCTION public.student_level(u uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT level FROM public.profiles WHERE id = u $$;
  CREATE FUNCTION public.is_announcement_recipient(a uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.announcement_recipients WHERE announcement_id = a AND student_id = u) $$;
  CREATE FUNCTION public.is_daily_task_recipient(a uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.daily_task_recipients WHERE task_id = a AND student_id = u) $$;
  CREATE FUNCTION public.is_resource_recipient(a uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.resource_recipients WHERE resource_id = a AND student_id = u) $$;
  CREATE FUNCTION public.is_weekly_test_recipient(a uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.weekly_test_recipients WHERE test_id = a AND student_id = u) $$;
  CREATE FUNCTION public.has_weekly_test_recipients(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.weekly_test_recipients WHERE test_id = a) $$;
  CREATE FUNCTION public.has_teacher_permission(u uuid, p text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
  CREATE FUNCTION public.is_teacher_assigned_to_student(t uuid, s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = t AND student_id = s) $$;
  CREATE FUNCTION public.xp_can_view(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public AS $$ SELECT u = auth.uid() OR public.is_admin() $$;
  CREATE FUNCTION public.reward_balance(u uuid) RETURNS TABLE(earned int, spent int, balance int)
    LANGUAGE sql STABLE AS $$ SELECT 1000, 0, 1000 $$;
  CREATE FUNCTION public.profiles_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
  BEGIN RETURN NEW; END $$;
  CREATE TRIGGER profiles_guard BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_guard();
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  GRANT SELECT, UPDATE ON public.profiles TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role, authenticated;
  GRANT SELECT, INSERT, UPDATE ON public.announcements, public.daily_tasks, public.resources, public.weekly_tests,
    public.homework_assignments, public.live_classes, public.reward_items, public.announcement_recipients
    TO authenticated;
  GRANT SELECT ON public.teacher_student_assignments, public.categories TO authenticated;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin());
  ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.live_classes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.reward_items ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.announcement_recipients ENABLE ROW LEVEL SECURITY;
  CREATE POLICY announcements_read_policy ON public.announcements FOR SELECT USING (true);
  CREATE POLICY daily_tasks_read_policy ON public.daily_tasks FOR SELECT USING (true);
  CREATE POLICY resources_read_policy ON public.resources FOR SELECT USING (true);
  CREATE POLICY weekly_tests_select_scoped ON public.weekly_tests FOR SELECT USING (true);
  CREATE POLICY "Students can view eligible live_classes" ON public.live_classes FOR SELECT USING (true);
  CREATE POLICY "Teachers can view assigned live_classes" ON public.live_classes FOR SELECT USING (true);
  CREATE POLICY reward_items_select ON public.reward_items FOR SELECT USING (true);
  CREATE POLICY t_insert ON public.announcements FOR INSERT WITH CHECK (true);
  CREATE POLICY t_update ON public.announcements FOR UPDATE USING (true) WITH CHECK (true);
  CREATE POLICY t_write ON public.daily_tasks FOR INSERT WITH CHECK (true);
  CREATE POLICY t_write ON public.homework_assignments FOR ALL USING (true) WITH CHECK (true);
  CREATE POLICY t_write ON public.live_classes FOR INSERT WITH CHECK (true);
  CREATE POLICY t_write ON public.announcement_recipients FOR ALL USING (true) WITH CHECK (true);

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

  -- Content that exists before migration 45 (made by the Baran teacher and the owner).
  INSERT INTO public.announcements (id, title, created_by) VALUES ('${LEGACY.ANN}', 'Legacy notice', '${P.OWNER}');
  INSERT INTO public.weekly_tests (id, title, created_by, test_date, closes_at)
    VALUES ('${LEGACY.TEST}', 'Legacy test', '${P.TCH_B}', current_date - 3, now() - interval '1 day');
  INSERT INTO public.homework_assignments (id, title, assigned_by, target_type)
    VALUES ('${LEGACY.HW}', 'Legacy homework', '${P.OWNER}', 'all');
  INSERT INTO public.live_classes (id, title, teacher_id, created_by) VALUES ('${LEGACY.CLASS}', 'Legacy class', '${P.TCH_B}', '${P.OWNER}');
  INSERT INTO public.reward_items (name, cost) VALUES ('Legacy sticker', 10);
`;

async function as(db, uid, role = 'authenticated') {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.query("SELECT set_config('request.jwt.claim.role', $1, false)", [role === 'service_role' ? 'service_role' : '']);
  await db.exec(`SET ROLE ${role}`);
}

async function rows(db, sql, params = []) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', '', false)");
  await db.query("SELECT set_config('request.jwt.claim.role', '', false)");
  return (await db.query(sql, params)).rows;
}

async function q(db, uid, sql, params = [], role = 'authenticated') {
  await as(db, uid, role);
  try {
    return { ok: true, rows: (await db.query(sql, params)).rows };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await db.exec('RESET ROLE');
  }
}

const service = (db, sql, params = []) => q(db, '', sql, params, 'service_role');
const one = async (p) => {
  const r = await p;
  assert.ok(r.ok, r.error);
  return r.rows[0];
};

async function freshDb({ with45 = true } = {}) {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_30);
  await db.exec(MIGRATION_32);
  await db.exec(MIGRATION_33);
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
  await rows(db, `INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
    ('${P.TCH_K}', '${P.STU_K}'), ('${P.TCH_K}', '${P.STU_B1}'), ('${P.TCH_B}', '${P.STU_B1}')`);
  if (with45) {
    await rows(db, "SELECT 1");
    await db.exec(MIGRATION_45);
  }
  return { db, brn, kta };
}

async function insertAnnouncement(db, uid, centre, extra = {}) {
  return q(db, uid,
    `INSERT INTO public.announcements (title, created_by, centre_id, target_scope)
     VALUES ($1, $2, $3, $4) RETURNING id, centre_id`,
    [extra.title || 'Notice', uid, centre, extra.scope || 'all']);
}

const visibleTitles = async (db, uid, table) => {
  const r = await q(db, uid, `SELECT title FROM public.${table} ORDER BY title`);
  assert.ok(r.ok, r.error);
  return r.rows.map((x) => x.title);
};

describe('migration 45: content belongs to a centre', () => {
  it('puts existing content in the default centre without touching store items', async () => {
    const { db, brn } = await freshDb();
    const [ann] = await rows(db, `SELECT centre_id FROM public.announcements WHERE id = '${LEGACY.ANN}'`);
    const [test] = await rows(db, `SELECT centre_id FROM public.weekly_tests WHERE id = '${LEGACY.TEST}'`);
    const [hw] = await rows(db, `SELECT centre_id FROM public.homework_assignments WHERE id = '${LEGACY.HW}'`);
    const [cls] = await rows(db, `SELECT centre_id FROM public.live_classes WHERE id = '${LEGACY.CLASS}'`);
    const [item] = await rows(db, 'SELECT centre_id FROM public.reward_items');
    assert.equal(ann.centre_id, brn);
    assert.equal(test.centre_id, brn);
    assert.equal(hw.centre_id, brn);
    assert.equal(cls.centre_id, brn);
    assert.equal(item.centre_id, null);
    const [{ d }] = await rows(db, `SELECT count(*)::int AS d FROM information_schema.columns
      WHERE table_name = 'announcements' AND column_name = 'centre_id' AND column_default IS NOT NULL`);
    assert.equal(d, 0, 'the temporary default is dropped');
  });

  it('a teacher or head always writes their own centre, even when they ask for another', async () => {
    const { db, brn, kta } = await freshDb();
    const forged = await one(insertAnnouncement(db, P.TCH_K, brn));
    assert.equal(forged.centre_id, kta);
    const empty = await one(insertAnnouncement(db, P.TCH_K, null));
    assert.equal(empty.centre_id, kta, 'a teacher cannot make an every-centre notice');
    const head = await one(q(db, P.HEAD_K,
      "INSERT INTO public.daily_tasks (title, created_by, centre_id) VALUES ('Head task', $1, $2) RETURNING centre_id",
      [P.HEAD_K, brn]));
    assert.equal(head.centre_id, kta);

    const moved = await one(q(db, P.TCH_K,
      'UPDATE public.announcements SET centre_id = $1, title = $2 WHERE id = $3 RETURNING centre_id, title',
      [brn, 'Renamed', forged.id]));
    assert.equal(moved.centre_id, kta, 'an update never moves the row');
    assert.equal(moved.title, 'Renamed');
    const unset = await one(q(db, P.TCH_K,
      'UPDATE public.announcements SET centre_id = NULL WHERE id = $1 RETURNING centre_id', [forged.id]));
    assert.equal(unset.centre_id, kta);
  });

  it('owners and directors choose a centre or every centre; the API gets the author centre', async () => {
    const { db, brn, kta } = await freshDb();
    assert.equal((await one(insertAnnouncement(db, P.OWNER, null))).centre_id, null);
    assert.equal((await one(insertAnnouncement(db, P.DIRECTOR, kta))).centre_id, kta);
    const row = await one(insertAnnouncement(db, P.DIRECTOR, kta));
    const moved = await one(q(db, P.DIRECTOR,
      'UPDATE public.announcements SET centre_id = $1 WHERE id = $2 RETURNING centre_id', [brn, row.id]));
    assert.equal(moved.centre_id, brn);

    const byTeacher = await one(service(db,
      "INSERT INTO public.live_classes (title, teacher_id, created_by) VALUES ('Api', $1, $1) RETURNING centre_id",
      [P.TCH_K]));
    assert.equal(byTeacher.centre_id, kta);
    const byOwner = await one(service(db,
      "INSERT INTO public.live_classes (title, teacher_id, created_by) VALUES ('Api', $1, $2) RETURNING centre_id",
      [P.TCH_K, P.OWNER]));
    assert.equal(byOwner.centre_id, null);
    const chosen = await one(service(db,
      "INSERT INTO public.live_classes (title, teacher_id, created_by, centre_id) VALUES ('Api', $1, $2, $3) RETURNING centre_id",
      [P.TCH_K, P.OWNER, kta]));
    assert.equal(chosen.centre_id, kta);
    const item = await one(service(db, "INSERT INTO public.reward_items (name, cost) VALUES ('Pen', 5) RETURNING centre_id"));
    assert.equal(item.centre_id, null, 'store items without an author stay shared');
  });

  it('read policies hide other centres content for students and teachers', async () => {
    const { db, brn, kta } = await freshDb();
    for (const [table] of CONTENT_POLICIES) {
      await rows(db, `INSERT INTO public.${table} (title, created_by, centre_id) VALUES
        ('Kota only', '${P.OWNER}', '${kta}'), ('Baran only', '${P.OWNER}', '${brn}'), ('Everyone', '${P.OWNER}', NULL)`);
      const own = (await visibleTitles(db, P.STU_K, table)).filter((t) => !t.startsWith('Legacy'));
      assert.deepEqual(own, ['Everyone', 'Kota only'], `${table}: Kota student`);
      const other = (await visibleTitles(db, P.STU_B1, table)).filter((t) => !t.startsWith('Legacy'));
      assert.deepEqual(other, ['Baran only', 'Everyone'], `${table}: Baran student`);
      const teacher = (await visibleTitles(db, P.TCH_B, table)).filter((t) => !t.startsWith('Legacy'));
      assert.ok(!teacher.includes('Kota only'), `${table}: Baran teacher`);
      const owner = await visibleTitles(db, P.OWNER, table);
      assert.ok(owner.includes('Kota only') && owner.includes('Baran only'), `${table}: owner sees all`);
      const director = await visibleTitles(db, P.DIRECTOR, table);
      assert.ok(director.includes('Kota only') && director.includes('Baran only'), `${table}: director sees all`);
    }
    const legacy = await visibleTitles(db, P.STU_K, 'announcements');
    assert.ok(!legacy.includes('Legacy notice'), 'legacy Baran content stays in Baran');
  });

  it('a recipient from another centre is refused', async () => {
    const { db } = await freshDb();
    const ann = await one(insertAnnouncement(db, P.TCH_K, null, { scope: 'targeted' }));
    const bad = await q(db, P.TCH_K,
      'INSERT INTO public.announcement_recipients (announcement_id, student_id) VALUES ($1, $2)', [ann.id, P.STU_B1]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /another centre/);
    const viaApi = await service(db,
      'INSERT INTO public.announcement_recipients (announcement_id, student_id) VALUES ($1, $2)', [ann.id, P.STU_B1]);
    assert.equal(viaApi.ok, false, 'the service role cannot bypass it either');
    const good = await q(db, P.TCH_K,
      'INSERT INTO public.announcement_recipients (announcement_id, student_id) VALUES ($1, $2)', [ann.id, P.STU_K]);
    assert.ok(good.ok, good.error);
    const moved = await q(db, P.TCH_K,
      'UPDATE public.announcement_recipients SET student_id = $1 WHERE announcement_id = $2', [P.STU_B1, ann.id]);
    assert.equal(moved.ok, false, 'an update cannot swap in another centre student');
  });

  it('homework stays inside its centre', async () => {
    const { db, kta } = await freshDb();
    const bad = await q(db, P.TCH_K,
      "INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id) VALUES ('X', $1, 'student', $2)",
      [P.TCH_K, P.STU_B1]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /another centre/);

    const hw = await one(service(db,
      "INSERT INTO public.homework_assignments (title, assigned_by, target_type, centre_id) VALUES ('All Kota', $1, 'all', $2) RETURNING id",
      [P.OWNER, kta]));
    const recip = async (s) => (await rows(db, 'SELECT public.is_student_homework_recipient($1, $2) AS ok', [hw.id, s]))[0].ok;
    assert.equal(await recip(P.STU_K), true);
    assert.equal(await recip(P.STU_B1), false);
    assert.equal(await recip(P.STU_B2), false);

    // A bulk fill of completions simply leaves other centres' students out.
    await rows(db, `INSERT INTO public.homework_completions (assignment_id, student_id)
      SELECT $1, id FROM public.profiles WHERE role = 'student' AND level IS NOT NULL`, [hw.id]);
    const done = await rows(db, 'SELECT student_id FROM public.homework_completions WHERE assignment_id = $1', [hw.id]);
    assert.deepEqual(done.map((r) => r.student_id), [P.STU_K]);

    const legacy = await rows(db, 'SELECT public.is_student_homework_recipient($1, $2) AS ok', [LEGACY.HW, P.STU_B1]);
    assert.equal(legacy[0].ok, true, 'existing Baran homework still reaches Baran students');
  });

  it('live classes stay inside their centre', async () => {
    const { db, brn, kta } = await freshDb();
    const bad = await service(db,
      `INSERT INTO public.live_classes (title, teacher_id, created_by, centre_id, target_student_ids)
       VALUES ('Mixed', $1, $2, $3, $4::jsonb)`, [P.TCH_K, P.OWNER, kta, JSON.stringify([P.STU_K, P.STU_B1])]);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /another centre/);

    const cls = await one(service(db,
      `INSERT INTO public.live_classes (title, teacher_id, created_by, centre_id, target_student_ids)
       VALUES ('Kota class', $1, $2, $3, $4::jsonb) RETURNING id`, [P.TCH_K, P.OWNER, kta, JSON.stringify([P.STU_K])]));
    await service(db, "INSERT INTO public.live_classes (title, teacher_id, created_by, centre_id) VALUES ('Kota open', $1, $2, $3)",
      [P.TCH_K, P.OWNER, kta]);

    assert.deepEqual((await visibleTitles(db, P.STU_K, 'live_classes')).sort(), ['Kota class', 'Kota open']);
    assert.deepEqual(await visibleTitles(db, P.STU_B1, 'live_classes'), ['Legacy class']);
    const eligible = await one(q(db, P.STU_B1,
      'SELECT count(*)::int AS n FROM public.get_eligible_live_classes_for_student($1) WHERE title LIKE $2', [P.STU_B1, 'Kota%']));
    assert.equal(eligible.n, 0);
    const mine = await one(q(db, P.STU_K,
      'SELECT count(*)::int AS n FROM public.get_eligible_live_classes_for_student($1)', [P.STU_K]));
    assert.equal(mine.n, 2);

    // A student who later moves centre never blocks ending the class.
    await rows(db, 'UPDATE public.profiles SET centre_id = $1 WHERE id = $2', [brn, P.STU_K]);
    const ended = await service(db, "UPDATE public.live_classes SET status = 'ended' WHERE id = $1", [cls.id]);
    assert.ok(ended.ok, ended.error);
  });

  it('the store shows and sells only shared items and the student centre items', async () => {
    const { db, kta } = await freshDb();
    const item = await one(service(db,
      "INSERT INTO public.reward_items (name, cost, centre_id, stock) VALUES ('Kota badge', 5, $1, 3) RETURNING id", [kta]));
    const shopNames = async (uid) => (await one(q(db, uid, 'SELECT public.reward_shop() AS s'))).s.items.map((i) => i.name).sort();
    assert.deepEqual(await shopNames(P.STU_K), ['Kota badge', 'Legacy sticker']);
    assert.deepEqual(await shopNames(P.STU_B1), ['Legacy sticker']);
    const refused = await q(db, P.STU_B1, 'SELECT public.reward_request($1)', [item.id]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not available/);
    const forged = await service(db,
      "INSERT INTO public.reward_redemptions (student_id, item_id, item_name, cost) VALUES ($1, $2, 'x', 5)", [P.STU_B1, item.id]);
    assert.equal(forged.ok, false);
    const ok = await q(db, P.STU_K, 'SELECT public.reward_request($1) AS r', [item.id]);
    assert.ok(ok.ok, ok.error);
    const [{ stock, centre_id: c }] = await rows(db, 'SELECT stock, centre_id FROM public.reward_items WHERE id = $1', [item.id]);
    assert.equal(stock, 2);
    assert.equal(c, kta, 'the stock update by a student keeps the centre');
    assert.deepEqual((await visibleTitlesStore(db, P.STU_B1)), ['Legacy sticker']);
  });

  it('weekly tests: list, attempts and practice stay inside the centre', async () => {
    const { db, kta } = await freshDb();
    const test = await one(service(db,
      `INSERT INTO public.weekly_tests (title, created_by, centre_id, test_date, closes_at)
       VALUES ('Kota test', $1, $2, current_date - 2, now() - interval '1 day') RETURNING id`, [P.OWNER, kta]));
    const list = async (uid) => ((await one(q(db, uid, 'SELECT public.my_weekly_tests() AS t'))).t || []).map((t) => t.title).sort();
    assert.deepEqual(await list(P.STU_K), ['Kota test']);
    assert.deepEqual(await list(P.STU_B1), ['Legacy test']);
    const attempt = await service(db, 'INSERT INTO public.weekly_test_attempts (test_id, student_id) VALUES ($1, $2)', [test.id, P.STU_B1]);
    assert.equal(attempt.ok, false);
    const practice = await service(db, 'INSERT INTO public.weekly_test_practice_runs (test_id, student_id) VALUES ($1, $2)', [test.id, P.STU_B1]);
    assert.equal(practice.ok, false);
    const reason = await rows(db, 'SELECT public.weekly_test_practice_block_reason($1, $2) AS r', [test.id, P.STU_B1]);
    assert.match(reason[0].r, /another centre/);
    const fine = await rows(db, 'SELECT public.weekly_test_practice_block_reason($1, $2) AS r', [test.id, P.STU_K]);
    assert.equal(fine[0].r, null);
    const shared = await one(service(db,
      `INSERT INTO public.weekly_tests (title, created_by, test_date, closes_at)
       VALUES ('Network test', $1, current_date - 2, now() - interval '1 day') RETURNING id, centre_id`, [P.OWNER]));
    assert.equal(shared.centre_id, null);
    const anyone = await rows(db, 'SELECT public.weekly_test_practice_block_reason($1, $2) AS r', [shared.id, P.STU_B1]);
    assert.equal(anyone[0].r, null, 'an every-centre test made by an owner is open to every centre');
  });

  it('teacher_bulk_apply_level_access reaches only the teacher centre', async () => {
    const { db } = await freshDb();
    const res = await one(q(db, P.TCH_K, "SELECT public.teacher_bulk_apply_level_access('Level 1', '{}'::jsonb) AS r"));
    assert.deepEqual(res.r.student_ids, [P.STU_K], 'a stale assignment to a Baran student is ignored');
    const owner = await one(q(db, P.OWNER, "SELECT public.teacher_bulk_apply_level_access('Level 1', '{}'::jsonb) AS r"));
    assert.equal(owner.r.count, 3);
  });

  it('refuses escalation through the helpers', async () => {
    const { db, brn } = await freshDb();
    const direct = await q(db, P.TCH_K, 'SELECT public.content_centre_ok($1, $2)', [brn, P.TCH_K]);
    assert.equal(direct.ok, false, 'content_centre_ok is for the service role only');
    const anon = await q(db, '', 'SELECT public.content_centre_visible($1)', [brn], 'anon');
    assert.equal(anon.ok, false);
    const visible = await one(q(db, P.TCH_K, 'SELECT public.content_centre_visible($1) AS v', [brn]));
    assert.equal(visible.v, false);
    const head = await one(q(db, P.HEAD_K, 'SELECT public.content_centre_visible($1) AS v', [brn]));
    assert.equal(head.v, false, 'a centre head is not a network admin');
    const stamp = await q(db, P.TCH_K, 'SELECT public.content_centre_stamp()');
    assert.equal(stamp.ok, false);
  });
});

async function visibleTitlesStore(db, uid) {
  const r = await q(db, uid, 'SELECT name FROM public.reward_items ORDER BY name');
  assert.ok(r.ok, r.error);
  return r.rows.map((x) => x.name);
}

describe('migration 45 rollback', () => {
  it('restores the pre-45 policies and functions and keeps the column', async () => {
    const { db, kta } = await freshDb();
    await rows(db, `INSERT INTO public.announcements (title, created_by, centre_id) VALUES ('Kota only', '${P.OWNER}', '${kta}')`);
    assert.ok(!(await visibleTitles(db, P.STU_B1, 'announcements')).includes('Kota only'));
    await db.exec(ROLLBACK_45);
    assert.ok((await visibleTitles(db, P.STU_B1, 'announcements')).includes('Kota only'));
    const [{ n }] = await rows(db, "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'content_%'");
    assert.equal(n, 0);
    const [{ c }] = await rows(db, `SELECT count(*)::int AS c FROM public.announcements WHERE centre_id IS NOT NULL`);
    assert.ok(c >= 2, 'centre_id values are kept');
    const forged = await one(insertAnnouncement(db, P.TCH_K, null));
    assert.equal(forged.centre_id, null, 'no stamping after the rollback');
    await db.exec(MIGRATION_45);
    assert.ok(!(await visibleTitles(db, P.STU_B1, 'announcements')).includes('Kota only'), 'migration 45 can run again');
  });
});

describe('API centre checks', () => {
  it('isStudentInAudience refuses a class of another centre', () => {
    const cls = { centre_id: 'k', target_level: null, target_student_ids: null };
    assert.equal(isStudentInAudience({ id: 's', role: 'student', centreId: 'k' }, cls), true);
    assert.equal(isStudentInAudience({ id: 's', role: 'student', centreId: 'b' }, cls), false);
    assert.equal(isStudentInAudience({ id: 's', role: 'student', centreId: null }, cls), false);
    assert.equal(isStudentInAudience({ id: 's', role: 'student', centreId: 'b' }, { ...cls, centre_id: null }), true);
    assert.equal(isStudentInAudience({ id: 's', role: 'student', centreId: 'b' },
      { ...cls, target_student_ids: ['s'] }), false, 'a forged target list cannot cross centres');
  });

  it('isTaskInStudentCentre refuses a task of another centre', () => {
    assert.equal(isTaskInStudentCentre({ centre_id: null }, { role: 'student', centre_id: 'b' }), true);
    assert.equal(isTaskInStudentCentre({ centre_id: 'k' }, { role: 'student', centre_id: 'k' }), true);
    assert.equal(isTaskInStudentCentre({ centre_id: 'k' }, { role: 'student', centre_id: 'b' }), false);
    assert.equal(isTaskInStudentCentre({ centre_id: 'k' }, { role: 'student' }), false);
    assert.equal(isTaskInStudentCentre({ centre_id: 'k' }, { role: 'admin', centre_id: null }), true);
  });
});
