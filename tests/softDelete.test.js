/**
 * Student and teacher soft delete (migration 22, DemoDB, Students/Teachers page wiring).
 *
 * Deleting a student or teacher keeps every row in the database but hides them from the
 * whole website: normal profile reads (admins included) skip them, they become inactive
 * so every leaderboard / roster that skips inactive students skips them too, and only the
 * admin RPCs can list or restore them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const { DemoDB } = await import('../js/demoDb.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readFileSync(path.join(root, 'supabase/migrations/22_soft_delete_students_teachers.sql'), 'utf8');

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const TEACHER = '00000000-0000-0000-0000-0000000000b1';
const STU1 = '00000000-0000-0000-0000-000000000001';
const STU2 = '00000000-0000-0000-0000-000000000002';

async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;

    CREATE TABLE public.profiles (
      id uuid PRIMARY KEY,
      student_code text UNIQUE,
      full_name text,
      role text NOT NULL,
      level text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz DEFAULT now(),
      leaderboard_visible boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.teacher_student_assignments (teacher_id uuid, student_id uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

    -- Same helpers as production (security definer, so they read past RLS).
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active) $$;
    CREATE FUNCTION public.is_teacher(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = p AND role = 'teacher' AND active) $$;
    CREATE FUNCTION public.has_teacher_permission(p uuid, perm text) RETURNS boolean LANGUAGE sql STABLE
      AS $$ SELECT true $$;
    CREATE FUNCTION public.is_teacher_assigned_to_student(t uuid, s uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = t AND student_id = s) $$;

    -- Policies as they are live before migration 22.
    CREATE POLICY profiles_select_policy ON public.profiles FOR SELECT TO authenticated
      USING ((id = auth.uid()) OR is_admin() OR (is_teacher(auth.uid())
        AND has_teacher_permission(auth.uid(), 'view_students')
        AND is_teacher_assigned_to_student(auth.uid(), id)));
    CREATE POLICY profiles_admin_write_policy ON public.profiles FOR ALL TO authenticated
      USING (is_admin()) WITH CHECK (is_admin());

    INSERT INTO public.profiles (id, student_code, full_name, role, level) VALUES
      ('${ADMIN}', 'ADMIN01', 'Admin', 'admin', NULL),
      ('${TEACHER}', 'TCH01', 'Teacher', 'teacher', 'Teacher'),
      ('${STU1}', 'STU001', 'Asha', 'student', 'Level 1'),
      ('${STU2}', 'STU002', 'Ravi', 'student', 'Master');
    INSERT INTO public.teacher_student_assignments VALUES ('${TEACHER}', '${STU1}'), ('${TEACHER}', '${STU2}');
  `);
  await db.exec(MIGRATION);
  await db.exec('SET ROLE authenticated');
  return db;
}

async function as(db, uid) {
  await db.query('SELECT set_config($1, $2, false)', ['request.jwt.claim.sub', uid]);
}

async function visibleCodes(db) {
  const { rows } = await db.query("SELECT student_code FROM public.profiles WHERE role = 'student' ORDER BY student_code");
  return rows.map((r) => r.student_code);
}

describe('migration 22: soft delete students', () => {
  it('deleting hides the student from admins, teachers and the student, but keeps the row', async () => {
    const db = await freshDb();
    await as(db, ADMIN);
    assert.deepEqual(await visibleCodes(db), ['STU001', 'STU002']);

    const { rows: [del] } = await db.query('SELECT public.admin_soft_delete_profile($1) AS r', [STU1]);
    assert.equal(del.r.student_code, 'STU001');
    assert.ok(del.r.deleted_at);

    assert.deepEqual(await visibleCodes(db), ['STU002'], 'admin roster drops the deleted student');
    await as(db, TEACHER);
    assert.deepEqual(await visibleCodes(db), ['STU002'], 'teacher roster drops the deleted student');
    await as(db, STU1);
    assert.deepEqual(await visibleCodes(db), [], 'the deleted student cannot read their own profile (sign-in fails)');

    await as(db, ADMIN);
    const { rows: deleted } = await db.query("SELECT student_code, active, deleted_by FROM public.admin_deleted_profiles('student')");
    assert.deepEqual(deleted, [{ student_code: 'STU001', active: false, deleted_by: ADMIN }]);

    await db.exec('RESET ROLE');
    const { rows: [raw] } = await db.query('SELECT active, deleted_at FROM public.profiles WHERE id = $1', [STU1]);
    assert.equal(raw.active, false, 'deleted students are inactive, so every inactive filter skips them');
    assert.ok(raw.deleted_at, 'the row is still in the database');
    await db.close();
  });

  it('restore brings the student back as active everywhere', async () => {
    const db = await freshDb();
    await as(db, ADMIN);
    await db.query('SELECT public.admin_soft_delete_profile($1)', [STU2]);
    const { rows: [res] } = await db.query('SELECT public.admin_restore_profile($1) AS r', [STU2]);
    assert.equal(res.r.active, true);
    assert.deepEqual(await visibleCodes(db), ['STU001', 'STU002']);
    assert.equal((await db.query("SELECT * FROM public.admin_deleted_profiles('student')")).rows.length, 0);
    await as(db, TEACHER);
    assert.deepEqual(await visibleCodes(db), ['STU001', 'STU002']);
    await db.close();
  });

  it('only admins can delete, list or restore, and admin accounts cannot be deleted', async () => {
    const db = await freshDb();
    await as(db, TEACHER);
    await assert.rejects(db.query('SELECT public.admin_soft_delete_profile($1)', [STU1]), /Admins only/);
    await assert.rejects(db.query("SELECT * FROM public.admin_deleted_profiles('student')"), /Admins only/);
    await as(db, STU1);
    await assert.rejects(db.query('SELECT public.admin_restore_profile($1)', [STU1]), /Admins only/);
    await as(db, ADMIN);
    await assert.rejects(db.query('SELECT public.admin_soft_delete_profile($1)', [ADMIN]), /Student or teacher not found/);
    await db.close();
  });

  it('plain updates cannot delete, undelete or edit a deleted student', async () => {
    const db = await freshDb();
    await as(db, ADMIN);
    await assert.rejects(
      db.query('UPDATE public.profiles SET deleted_at = now(), active = false WHERE id = $1', [STU1]),
      /row-level security/
    );
    await db.query('SELECT public.admin_soft_delete_profile($1)', [STU1]);
    const upd = await db.query('UPDATE public.profiles SET active = true, deleted_at = NULL WHERE id = $1', [STU1]);
    assert.equal(upd.affectedRows, 0, 'deleted rows are not reachable by plain updates');
    await db.exec('RESET ROLE');
    await assert.rejects(
      db.query('UPDATE public.profiles SET active = true WHERE id = $1', [STU1]),
      /profiles_deleted_inactive/,
      'even the service role cannot make a deleted student active without restoring'
    );
    await db.close();
  });

  it('deleting a teacher hides them, cuts access to their students, and restore gives it back', async () => {
    const db = await freshDb();
    await as(db, ADMIN);
    await db.query('SELECT public.admin_soft_delete_profile($1)', [TEACHER]);
    const { rows: teachers } = await db.query("SELECT student_code FROM public.profiles WHERE role = 'teacher'");
    assert.deepEqual(teachers, [], 'teacher list drops the deleted teacher');
    assert.deepEqual(
      (await db.query("SELECT student_code FROM public.admin_deleted_profiles('teacher')")).rows,
      [{ student_code: 'TCH01' }]
    );
    assert.deepEqual((await db.query("SELECT * FROM public.admin_deleted_profiles('student')")).rows, []);
    assert.equal((await db.query('SELECT * FROM public.admin_deleted_profiles()')).rows.length, 1);

    await as(db, TEACHER);
    assert.deepEqual(await visibleCodes(db), [], 'a deleted teacher no longer sees their students');

    await as(db, ADMIN);
    await db.query('SELECT public.admin_restore_profile($1)', [TEACHER]);
    await as(db, TEACHER);
    assert.deepEqual(await visibleCodes(db), ['STU001', 'STU002'], 'assignments were kept and work again');
    await db.close();
  });

  it('deleting twice keeps the first deletion time', async () => {
    const db = await freshDb();
    await as(db, ADMIN);
    const first = (await db.query('SELECT public.admin_soft_delete_profile($1) AS r', [STU1])).rows[0].r.deleted_at;
    const second = (await db.query('SELECT public.admin_soft_delete_profile($1) AS r', [STU1])).rows[0].r.deleted_at;
    assert.equal(second, first);
    await db.close();
  });
});

describe('DemoDB soft delete', () => {
  it('hides deleted students from getStudents and keeps them through saves', () => {
    const before = DemoDB.getStudents();
    const target = before.find((s) => s.role === 'student');
    assert.ok(target, 'demo data has students');

    DemoDB.deleteStudent(target.id);
    assert.ok(!DemoDB.getStudents().some((s) => s.id === target.id));
    assert.equal(DemoDB.getDeletedStudents()[0].id, target.id);
    assert.equal(DemoDB.getDeletedStudents()[0].active, false);

    // Any other write goes through getStudents()/saveStudents(): the deleted row must survive.
    const other = DemoDB.getStudents().find((s) => s.role === 'student');
    DemoDB.toggleStudentLeaderboardVisible(other.id, false);
    assert.ok(DemoDB.getAllStudentRows().some((s) => s.id === target.id && s.deleted_at));

    DemoDB.restoreStudent(target.id);
    const back = DemoDB.getStudents().find((s) => s.id === target.id);
    assert.ok(back);
    assert.equal(back.active, true);
    assert.equal(DemoDB.getDeletedStudents().length, 0);
  });
});

describe('DemoDB teacher soft delete', () => {
  it('keeps a deleted demo teacher so it can be restored', () => {
    const teacher = { id: 'demo-teacher-x', student_code: 'TCHX', full_name: 'Demo T', role: 'teacher', active: true };
    DemoDB.deleteDemoTeacher(teacher);
    assert.ok(DemoDB.isDemoTeacherDeleted('demo-teacher-x'));
    assert.equal(DemoDB.getDeletedDemoTeachers()[0].active, false);
    const back = DemoDB.restoreDemoTeacher('demo-teacher-x');
    assert.equal(back.active, true);
    assert.ok(!DemoDB.isDemoTeacherDeleted('demo-teacher-x'));
  });
});

describe('Teachers page wiring', () => {
  it('has Delete and the Deleted teachers list', () => {
    const html = fs.readFileSync(path.join(root, 'pages/teachers.html'), 'utf8');
    assert.match(html, /id="btn-open-deleted-teachers"/);
    assert.match(html, /id="deleted-teachers-body"/);
    const js = fs.readFileSync(path.join(root, 'js/teachers.js'), 'utf8');
    assert.match(js, /btn-delete-teacher/);
    assert.match(js, /btn-restore-teacher/);
    assert.match(js, /teacher_student_assignments_student_id_fkey!inner/);
  });
});

describe('Students page wiring', () => {
  it('has Delete, the confirmation dialog and the Deleted students list', () => {
    const html = fs.readFileSync(path.join(root, 'pages/students.html'), 'utf8');
    for (const id of ['btn-open-deleted-students', 'delete-student-modal', 'btn-confirm-delete-student', 'deleted-students-body']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    const js = fs.readFileSync(path.join(root, 'js/admin.js'), 'utf8');
    assert.match(js, /btn-delete-student/);
    assert.match(js, /btn-restore-student/);
  });

  it('student embeds use inner joins so results of deleted students drop out', () => {
    const files = {
      'js/review.js': ['student:profiles!results_student_id_fkey!inner(', 'profiles!score_correction_requests_student_id_fkey!inner('],
      'js/teacherOverview.js': ['profiles!results_student_id_fkey!inner('],
      'js/homework.js': ['student:profiles!student_id!inner ('],
    };
    for (const [file, needles] of Object.entries(files)) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      for (const needle of needles) assert.ok(src.includes(needle), `${file}: ${needle}`);
      assert.doesNotMatch(src, /student:profiles!student_id \(/, file);
    }
  });
});
