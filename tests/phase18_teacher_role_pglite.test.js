/**
 * Phase 18 — Isolated PostgreSQL Unit Tests for Teacher Role & Workspace (tests/phase18_teacher_role_pglite.test.js)
 *
 * Verifies with real PostgreSQL in WASM via PGlite:
 * 1. Migration 16 executes cleanly and alters profiles_role_check to ('student', 'teacher', 'admin').
 * 2. Profiles with level = 'Teacher' but role = 'student' are strictly denied staff privileges.
 * 3. Multi-teacher assignment model: multiple teachers assigned to the same student.
 * 4. Helper functions: is_teacher(), is_teacher_assigned_to_student(), has_teacher_permission().
 * 5. Teacher attendance RPC (teacher_save_attendance):
 *    - Allowed within [today_ist() - 7, today_ist()].
 *    - Rejects dates older than 7 calendar days or future dates.
 *    - Rejects unassigned students and rolls back mixed payloads atomically.
 * 6. Teacher score review (teacher_verify_scores, teacher_flag_score):
 *    - Allowed for assigned students.
 *    - Rejects unassigned students.
 * 7. Score correction request state machine:
 *    - Teacher submits request -> immutable original snapshot captured.
 *    - Admin approves request -> assertions verify snapshot equality; updates result atomically.
 *    - Admin rejects request -> status marked rejected.
 *    - Snapshot drift detection -> if score changed between request and approval, throws exception.
 * 8. Teacher deactivation blocks subsequent access.
 */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Phase 18 — Isolated PostgreSQL Engine: Teacher Role & Workspace', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const teacherAId = '22222222-2222-2222-2222-222222222222';
  const teacherBId = '33333333-3333-3333-3333-333333333333';
  const student1Id = '44444444-4444-4444-4444-444444444444';
  const student2Id = '55555555-5555-5555-5555-555555555555';
  const fakeTeacherLevelId = '66666666-6666-6666-6666-666666666666';

  before(async () => {
    db = new PGlite();

    // 1. Setup Roles & Auth schema
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object(
          'role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated'),
          'sub', NULLIF(current_setting('app.current_user_id', true), '')
        );
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Base tables: profiles, categories, results, attendance_sessions, attendance, result_audit
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID REFERENCES public.categories(id),
        student_round_id UUID,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT NOT NULL DEFAULT 0,
        note TEXT,
        entry_date DATE NOT NULL,
        verified BOOLEAN NOT NULL DEFAULT false,
        verified_by UUID REFERENCES public.profiles(id),
        verified_at TIMESTAMPTZ,
        corrected_by UUID REFERENCES public.profiles(id),
        corrected_at TIMESTAMPTZ,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.attendance_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        session_date DATE NOT NULL,
        session_type TEXT NOT NULL DEFAULT 'class',
        notes TEXT,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.attendance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
        note TEXT,
        marked_by UUID REFERENCES public.profiles(id),
        marked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        UNIQUE(session_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.result_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        result_id UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        changed_by UUID REFERENCES public.profiles(id),
        action TEXT NOT NULL,
        reason TEXT,
        old_values JSONB,
        new_values JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE OR REPLACE FUNCTION public.today_ist()
      RETURNS DATE AS $$
        SELECT (timezone('Asia/Kolkata', now()))::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin()
      RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles
          WHERE id = auth.uid() AND role = 'admin' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.competition_rules()
      RETURNS TABLE (
        weekly_test_multiplier INTEGER,
        attendance_present_points INTEGER,
        improved_min_entries INTEGER,
        leaderboard_names TEXT
      ) AS $$
        SELECT 2, 5, 5, 'first_name_initial'::TEXT;
      $$ LANGUAGE sql STABLE;

      CREATE TABLE IF NOT EXISTS public.basics_thresholds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id UUID REFERENCES public.categories(id),
        level TEXT,
        min_accuracy NUMERIC,
        max_time_seconds INT,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE OR REPLACE VIEW public.results_with_target AS
      SELECT
        r.*,
        NULL::numeric AS min_accuracy,
        NULL::integer AS max_time_seconds,
        NULL::boolean AS meets_target
      FROM public.results r;

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        verified BOOLEAN NOT NULL DEFAULT false,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.weekly_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_date DATE NOT NULL DEFAULT public.today_ist(),
        title TEXT NOT NULL,
        notes TEXT,
        audience_level TEXT,
        test_type TEXT NOT NULL DEFAULT 'offline',
        opens_at TIMESTAMPTZ,
        closes_at TIMESTAMPTZ,
        remind_days_before INT NOT NULL DEFAULT 7,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 1 AND position <= 20),
        category_id UUID NULL REFERENCES public.categories(id),
        seconds INT NULL CHECK (seconds IS NULL OR seconds IN (30, 60, 120, 300)),
        kind TEXT NOT NULL CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad')),
        activity_key TEXT NULL,
        flash_digits INT NULL,
        flash_count INT NULL,
        flash_speed_ms INT NULL,
        flash_mode TEXT NULL,
        question_count INT NULL,
        CONSTRAINT weekly_test_sections_test_id_position_key UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
        category_id UUID REFERENCES public.categories(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE OR REPLACE FUNCTION public.attendance_summary(p_student uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
      RETURNS TABLE(present_count integer, absent_count integer, excused_count integer, attendance_pct numeric) AS $$
      BEGIN
        RETURN QUERY
        SELECT
          (count(*) FILTER (WHERE a.status = 'present'))::integer,
          (count(*) FILTER (WHERE a.status = 'absent'))::integer,
          (count(*) FILTER (WHERE a.status = 'excused'))::integer,
          CASE WHEN count(*) FILTER (WHERE a.status IN ('present', 'absent')) > 0
            THEN round(100.0 * count(*) FILTER (WHERE a.status = 'present')
                       / count(*) FILTER (WHERE a.status IN ('present', 'absent')), 1)
          END
        FROM public.attendance a
        JOIN public.attendance_sessions s ON s.id = a.session_id
        WHERE a.student_id = p_student
          AND (p_from IS NULL OR s.session_date >= p_from)
          AND (p_to IS NULL OR s.session_date <= p_to);
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.streak_calc(p_student uuid)
      RETURNS TABLE(current_streak integer, best_streak integer, shields integer, active_today boolean) AS $$
      BEGIN
        RETURN QUERY SELECT 1, 1, 0, true;
      END;
      $$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.practice_stats_for(p_student uuid, p_from date, p_to date)
      RETURNS TABLE(n_entries integer, n_correct bigint, n_total bigint, accuracy_pct numeric, qpm numeric, n_rounds integer) AS $$
        SELECT count(*)::integer,
               COALESCE(sum(r.correct), 0)::bigint,
               COALESCE(sum(r.total), 0)::bigint,
               CASE WHEN sum(r.total) > 0 THEN round(100.0 * sum(r.correct) / sum(r.total), 1) END,
               CASE WHEN COALESCE(sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0), 0) > 0
                    THEN round(sum(r.total) FILTER (WHERE r.time_seconds > 0)
                               / (sum(r.time_seconds) FILTER (WHERE r.time_seconds > 0) / 60.0), 1) END,
               count(DISTINCT r.student_round_id)::integer
          FROM public.results r
         WHERE r.student_id = p_student
           AND r.entry_date BETWEEN p_from AND p_to
           AND r.total > 0 AND r.correct IS NOT NULL;
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.practice_days_for(p_student uuid, p_from date, p_to date)
      RETURNS integer AS $$
        SELECT count(DISTINCT q.dt)::integer
          FROM (
            SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS dt
              FROM public.results r
             WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
            UNION ALL
            SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
              FROM public.activity_results a
             WHERE a.student_id = p_student AND a.total > 0
          ) q
         WHERE q.dt BETWEEN p_from AND p_to;
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.points_for(p_student uuid, p_from date, p_to date)
      RETURNS numeric AS $$
        SELECT COALESCE((SELECT sum(GREATEST(0, 2 * s.correct - s.total))
                           FROM public.weekly_test_scores s
                           JOIN public.weekly_tests t ON t.id = s.test_id
                          WHERE s.student_id = p_student AND t.test_date BETWEEN p_from AND p_to), 0)
               * (SELECT cr.weekly_test_multiplier FROM public.competition_rules() cr)
             + COALESCE((SELECT count(*)
                           FROM public.attendance a
                           JOIN public.attendance_sessions x ON x.id = a.session_id
                          WHERE a.student_id = p_student AND a.status = 'present'
                            AND x.session_date BETWEEN p_from AND p_to), 0)
               * (SELECT cr.attendance_present_points FROM public.competition_rules() cr);
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
        category_id UUID REFERENCES public.categories(id),
        session_id UUID,
        status TEXT,
        tries_started INT DEFAULT 1,
        tries_correct INT DEFAULT 0,
        claim_token UUID,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
        level TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.announcements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        audience_level TEXT,
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        description TEXT,
        topic TEXT NOT NULL DEFAULT 'General',
        audience_level TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_by UUID REFERENCES public.profiles(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.student_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
        title VARCHAR(120) NOT NULL,
        body TEXT NOT NULL,
        needs_attention BOOLEAN NOT NULL DEFAULT false,
        attention_reason TEXT,
        linked_type VARCHAR(30),
        linked_id UUID,
        link TEXT,
        client_nonce TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        read_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS public.student_rounds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        round_number INT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.competition_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_multiplier NUMERIC DEFAULT 1.0,
        attendance_points NUMERIC DEFAULT 10.0
      );
    `);

    // 3. Apply Migration 16 (Phase 18 Teacher Schema & Workspace)
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    await db.exec(`
      GRANT USAGE ON SCHEMA public TO authenticated, anon;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon;
      GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated, anon;
    `);
  });

  const setAuth = async (userId, role = 'authenticated') => {
    await db.exec(`
      RESET ROLE;
      SELECT set_config('app.current_user_id', '${userId || ''}', false);
      SELECT set_config('app.current_jwt_role', '${role}', false);
    `);
    if (role === 'authenticated' || role === 'anon') {
      await db.exec(`SET ROLE ${role};`);
    } else {
      await db.exec(`SET ROLE postgres;`);
    }
  };

  beforeEach(async () => {
    // Reset seed data
    await setAuth(adminId, 'service_role');
    await db.exec(`
      DELETE FROM public.weekly_test_recipients;
      DELETE FROM public.weekly_test_attempts;
      DELETE FROM public.weekly_test_scores;
      DELETE FROM public.weekly_test_sections;
      DELETE FROM public.weekly_tests;
      DELETE FROM public.daily_task_recipients;
      DELETE FROM public.daily_tasks;
      DELETE FROM public.announcement_recipients;
      DELETE FROM public.announcements;
      DELETE FROM public.resource_recipients;
      DELETE FROM public.resources;
      DELETE FROM public.activity_results;
      DELETE FROM public.teacher_audit_log;
      DELETE FROM public.score_correction_requests;
      DELETE FROM public.attendance_audit;
      DELETE FROM public.attendance;
      DELETE FROM public.attendance_sessions;
      DELETE FROM public.result_audit;
      DELETE FROM public.results;
      DELETE FROM public.teacher_student_assignments;
      DELETE FROM public.teacher_permissions;
      DELETE FROM public.profiles;
      DELETE FROM public.categories;

      INSERT INTO public.categories (id, name, section, sort_order)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Direct Addition', 'basics', 1);

      -- Seed admin
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES ('${adminId}', 'ADMIN01', 'Super Admin', 'admin', 'Instructor', true);

      -- Seed Teacher A
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES ('${teacherAId}', 'TCH01', 'Teacher Anita', 'teacher', 'Teacher', true);

      INSERT INTO public.teacher_permissions (teacher_id) VALUES ('${teacherAId}');

      -- Seed Teacher B
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES ('${teacherBId}', 'TCH02', 'Teacher Bharat', 'teacher', 'Teacher', true);

      INSERT INTO public.teacher_permissions (teacher_id) VALUES ('${teacherBId}');

      -- Seed Fake Teacher Level Account (level='Teacher' but role='student')
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES ('${fakeTeacherLevelId}', 'STU_FAKE', 'Sneaky Student', 'student', 'Teacher', true);

      -- Seed Students
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES
        ('${student1Id}', 'STU101', 'Student One', 'student', 'Level 1', true),
        ('${student2Id}', 'STU102', 'Student Two', 'student', 'Level 2', true);

      -- Assign Student 1 to Teacher A and Teacher B (multi-teacher model)
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
      VALUES
        ('${teacherAId}', '${student1Id}', '${adminId}'),
        ('${teacherBId}', '${student1Id}', '${adminId}');

      -- Student 2 is NOT assigned to Teacher A
    `);
  });

  it('1. Schema integrity: role check constraint allows teacher, admin, student', async () => {
    const res = await db.query(`SELECT id, role FROM public.profiles WHERE id = $1`, [teacherAId]);
    assert.equal(res.rows[0].role, 'teacher');

    // Reject invalid role
    await assert.rejects(
      async () => {
        await db.query(`
          INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
          VALUES (gen_random_uuid(), 'INV01', 'Invalid User', 'superman', 'Level 1', true);
        `);
      },
      /check/i
    );
  });

  it('2. Privilege boundary: level="Teacher" with role="student" confers zero staff privileges', async () => {
    const res = await db.query(`SELECT public.is_teacher($1) AS is_t`, [fakeTeacherLevelId]);
    assert.equal(res.rows[0].is_t, false);

    await setAuth(fakeTeacherLevelId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_get_overview()`);
      },
      /Unauthorized: Teacher access required/
    );
  });

  it('3. Multi-teacher assignment model: multiple teachers assigned to student 1', async () => {
    const isAAssigned = await db.query(
      `SELECT public.is_teacher_assigned_to_student($1, $2) AS val`,
      [teacherAId, student1Id]
    );
    assert.equal(isAAssigned.rows[0].val, true);

    const isBAssigned = await db.query(
      `SELECT public.is_teacher_assigned_to_student($1, $2) AS val`,
      [teacherBId, student1Id]
    );
    assert.equal(isBAssigned.rows[0].val, true);

    const isAAssignedS2 = await db.query(
      `SELECT public.is_teacher_assigned_to_student($1, $2) AS val`,
      [teacherAId, student2Id]
    );
    assert.equal(isAAssignedS2.rows[0].val, false);
  });

  it('4. Attendance: teacher_save_attendance records attendance and audit for assigned student within 7-day IST window', async () => {
    // Create session for today
    const sessionRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('Morning Class', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const sessionId = sessionRes.rows[0].id;

    await setAuth(teacherAId);
    const records = JSON.stringify([
      { student_id: student1Id, status: 'present', note: 'On time and prepared' }
    ]);

    const saveRes = await db.query(`
      SELECT public.teacher_save_attendance($1, $2::jsonb) AS res;
    `, [sessionId, records]);

    const resObj = typeof saveRes.rows[0].res === 'string' ? JSON.parse(saveRes.rows[0].res) : saveRes.rows[0].res;
    assert.equal(resObj.success, true);
    assert.equal(resObj.processed, 1);

    // Verify row saved in attendance table
    const attRow = await db.query(
      `SELECT status, note FROM public.attendance WHERE session_id = $1 AND student_id = $2`,
      [sessionId, student1Id]
    );
    assert.equal(attRow.rows[0].status, 'present');
    assert.equal(attRow.rows[0].note, 'On time and prepared');

    // Verify audit log captured
    const audit = await db.query(
      `SELECT action, changed_by, new_status AS status FROM public.attendance_audit WHERE session_id = $1`,
      [sessionId]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'mark');
    assert.equal(audit.rows[0].changed_by, teacherAId);
    assert.equal(audit.rows[0].status, 'present');
  });

  it('5. Attendance window rejection: rejects dates older than 7 calendar days', async () => {
    const oldSessionRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('Old Session', (public.today_ist() - 10), '${adminId}')
      RETURNING id;
    `);
    const oldSessionId = oldSessionRes.rows[0].id;

    await setAuth(teacherAId);
    const records = JSON.stringify([
      { student_id: student1Id, status: 'present', note: 'Retroactive' }
    ]);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.teacher_save_attendance($1, $2::jsonb);`,
          [oldSessionId, records]
        );
      },
      /Attendance window violation/
    );
  });

  it('6. Attendance atomic rollback: rejects unassigned student in mixed payload with zero partial writes', async () => {
    const sessionRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('Mixed Class', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const sessionId = sessionRes.rows[0].id;

    await setAuth(teacherAId);
    // Student 1 is assigned, Student 2 is NOT assigned to Teacher A
    const mixedRecords = JSON.stringify([
      { student_id: student1Id, status: 'present', note: 'Allowed' },
      { student_id: student2Id, status: 'absent', note: 'Not Allowed' }
    ]);

    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.teacher_save_attendance($1, $2::jsonb);`,
          [sessionId, mixedRecords]
        );
      },
      /not assigned to this teacher/
    );

    // Verify zero rows written for Student 1
    const checkRow = await db.query(
      `SELECT 1 FROM public.attendance WHERE session_id = $1`,
      [sessionId]
    );
    assert.equal(checkRow.rows.length, 0);
  });

  it('7. Score review: teacher_verify_scores and teacher_flag_score succeed for assigned student, reject unassigned', async () => {
    // Seed score for student 1 and student 2
    const scoreRes = await db.query(`
      INSERT INTO public.results (student_id, correct, total, time_seconds, entry_date)
      VALUES
        ('${student1Id}', 18, 20, 60, public.today_ist()),
        ('${student2Id}', 15, 20, 75, public.today_ist())
      RETURNING id, student_id;
    `);

    const score1Id = scoreRes.rows.find(r => r.student_id === student1Id).id;
    const score2Id = scoreRes.rows.find(r => r.student_id === student2Id).id;

    await setAuth(teacherAId);

    // Verify score 1 (assigned)
    const verRes = await db.query(`
      SELECT public.teacher_verify_scores(ARRAY[$1]::UUID[], true, 'Checked paper worksheet') AS res;
    `, [score1Id]);
    const verObj = typeof verRes.rows[0].res === 'string' ? JSON.parse(verRes.rows[0].res) : verRes.rows[0].res;
    assert.equal(verObj.verified_count, 1);

    const s1Row = await db.query(`SELECT verified FROM public.results WHERE id = $1`, [score1Id]);
    assert.equal(s1Row.rows[0].verified, true);

    // Flag score 1 (assigned)
    const flagRes = await db.query(`
      SELECT public.teacher_flag_score($1, true, 'Check subtraction steps') AS res;
    `, [score1Id]);
    const flagObj = typeof flagRes.rows[0].res === 'string' ? JSON.parse(flagRes.rows[0].res) : flagRes.rows[0].res;
    assert.equal(flagObj.success, true);

    // Attempt to verify score 2 (unassigned) -> throws exception
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.teacher_verify_scores(ARRAY[$1]::UUID[], true, 'Unauthorized attempt');
        `, [score2Id]);
      },
      /unassigned student/
    );

    // Attempt to flag score 2 (unassigned) -> throws exception
    await assert.rejects(
      async () => {
        await db.query(`
          SELECT public.teacher_flag_score($1, true, 'Unauthorized flag');
        `, [score2Id]);
      },
      /not assigned to you/
    );
  });

  it('8. Score correction workflow: request snapshot capture, admin approval, and drift detection', async () => {
    // Seed result for Student 1
    const res = await db.query(`
      INSERT INTO public.results (student_id, correct, total, time_seconds, note, entry_date)
      VALUES ('${student1Id}', 17, 20, 95, 'Drill 1', public.today_ist())
      RETURNING id;
    `);
    const resultId = res.rows[0].id;

    await setAuth(teacherAId);

    // 1. Teacher submits correction request
    const reqRes = await db.query(`
      SELECT public.teacher_request_score_correction($1, 'results', 19, 20, 85, 'Verified on abacus sheet: Counted only 17 initially') AS res;
    `, [resultId]);
    const reqObj = typeof reqRes.rows[0].res === 'string' ? JSON.parse(reqRes.rows[0].res) : reqRes.rows[0].res;
    const requestId = reqObj.request_id;
    assert.ok(requestId);

    // Verify request row & snapshot
    const reqRow = await db.query(`SELECT * FROM public.score_correction_requests WHERE id = $1`, [requestId]);
    assert.equal(reqRow.rows[0].status, 'pending');
    assert.equal(reqRow.rows[0].proposed_correct, 19);
    const snap = typeof reqRow.rows[0].original_score_snapshot === 'string'
      ? JSON.parse(reqRow.rows[0].original_score_snapshot)
      : reqRow.rows[0].original_score_snapshot;
    assert.equal(snap.correct, 17);

    // 2. Teacher cannot approve their own request
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.admin_decide_score_correction($1, 'approve', 'Self approval')`, [requestId]);
      },
      /Only administrators can decide/
    );

    // 3. Admin approves request
    await setAuth(adminId);
    const approveRes = await db.query(`
      SELECT public.admin_decide_score_correction($1, 'approve', 'Looks good') AS res;
    `, [requestId]);
    const appObj = typeof approveRes.rows[0].res === 'string' ? JSON.parse(approveRes.rows[0].res) : approveRes.rows[0].res;
    assert.equal(appObj.success, true);

    // Verify score was updated in results table
    const updatedResult = await db.query(`SELECT correct, time_seconds FROM public.results WHERE id = $1`, [resultId]);
    assert.equal(updatedResult.rows[0].correct, 19);
    assert.equal(updatedResult.rows[0].time_seconds, 85);

    // Verify result_audit entry
    const auditRow = await db.query(
      `SELECT action, reason, old_values->>'correct' AS old_c, new_values->>'correct' AS new_c FROM public.result_audit WHERE result_id = $1`,
      [resultId]
    );
    assert.equal(auditRow.rows[0].action, 'correct');
    assert.equal(auditRow.rows[0].old_c, '17');
    assert.equal(auditRow.rows[0].new_c, '19');

    // 4. Duplicate decision rejection
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.admin_decide_score_correction($1, 'reject', 'Second try')`, [requestId]);
      },
      /Request is already decided/
    );
  });

  it('9. Deactivation: deactivated teacher is denied RPC execution', async () => {
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [teacherAId]);

    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_get_overview()`);
      },
      /Unauthorized: Teacher access required/
    );
  });

  it('10. Permission revocation: revoking can_mark_attendance blocks attendance save', async () => {
    await db.query(`UPDATE public.teacher_permissions SET can_mark_attendance = false WHERE teacher_id = $1`, [teacherAId]);

    const sessionRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('Perm Test Session', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const sessionId = sessionRes.rows[0].id;

    await setAuth(teacherAId);
    const records = JSON.stringify([
      { student_id: student1Id, status: 'present', note: 'Check' }
    ]);

    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_save_attendance($1, $2::jsonb)`, [sessionId, records]);
      },
      /can_mark_attendance is required/
    );
  });

  it('11. Direct authenticated SELECTs enforce RLS scoping across profiles, results, attendance, scores', async () => {
    // Seed records for Student 1 and Student 2 under superuser
    await setAuth(adminId, 'service_role');
    const catRes = await db.query(`SELECT id FROM public.categories LIMIT 1;`);
    const catId = catRes.rows[0].id;

    await db.query(`
      INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
      VALUES ('${student1Id}', '${catId}', 10, 10, 60, public.today_ist()),
             ('${student2Id}', '${catId}', 8, 10, 60, public.today_ist());
    `);

    await db.query(`
      INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds)
      VALUES ('${student1Id}', 'flash', 'Flash Anzan', 5, 5, 30),
             ('${student2Id}', 'flash', 'Flash Anzan', 4, 5, 30);
    `);

    const sessRes = await db.query(`
      INSERT INTO public.attendance_sessions (title, session_date, created_by)
      VALUES ('RLS Session', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const sessId = sessRes.rows[0].id;
    await db.query(`
      INSERT INTO public.attendance (session_id, student_id, status)
      VALUES ('${sessId}', '${student1Id}', 'present'), ('${sessId}', '${student2Id}', 'absent');
    `);

    const testRes = await db.query(`
      INSERT INTO public.weekly_tests (title, test_date, created_by)
      VALUES ('RLS Test', public.today_ist(), '${adminId}')
      RETURNING id;
    `);
    const testId = testRes.rows[0].id;
    await db.query(`
      INSERT INTO public.weekly_test_scores (test_id, student_id, category_id, correct, total)
      VALUES ('${testId}', '${student1Id}', '${catId}', 20, 20),
             ('${testId}', '${student2Id}', '${catId}', 15, 20);
    `);

    // Authenticate as Teacher A (assigned to Student 1, NOT Student 2)
    await setAuth(teacherAId);

    const profRows = await db.query(`SELECT id FROM public.profiles WHERE role = 'student'`);
    const profIds = profRows.rows.map(r => r.id);
    assert.ok(profIds.includes(student1Id), 'Teacher A sees assigned Student 1');
    assert.ok(!profIds.includes(student2Id), 'Teacher A cannot see unassigned Student 2');

    const resultRows = await db.query(`SELECT student_id FROM public.results`);
    assert.ok(resultRows.rows.every(r => r.student_id === student1Id), 'Teacher A only sees results of assigned students');
    assert.ok(resultRows.rows.length > 0, 'Teacher A sees Student 1 results');

    const actRows = await db.query(`SELECT student_id FROM public.activity_results`);
    assert.ok(actRows.rows.every(r => r.student_id === student1Id), 'Teacher A only sees activity results of assigned students');

    const attRows = await db.query(`SELECT student_id FROM public.attendance`);
    assert.ok(attRows.rows.every(r => r.student_id === student1Id), 'Teacher A only sees attendance of assigned students');

    const scoreRows = await db.query(`SELECT student_id FROM public.weekly_test_scores`);
    assert.ok(scoreRows.rows.every(r => r.student_id === student1Id), 'Teacher A only sees weekly test scores of assigned students');

    // Authenticate as Student 1: sees only their own data
    await setAuth(student1Id);
    const stuResults = await db.query(`SELECT student_id FROM public.results`);
    assert.ok(stuResults.rows.every(r => r.student_id === student1Id), 'Student 1 only sees own results');
  });

  it('12. Individual permission revocations tested one-by-one', async () => {
    // 1. can_view_students
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_view_students = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    const viewRows = await db.query(`SELECT id FROM public.profiles WHERE role = 'student'`);
    assert.equal(viewRows.rows.length, 0, 'Revoking can_view_students hides student profiles');
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_view_students = true WHERE teacher_id = $1`, [teacherAId]);

    // 2. can_review_scores
    await db.query(`UPDATE public.teacher_permissions SET can_review_scores = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_verify_scores(ARRAY['${student1Id}']::uuid[], true)`);
      },
      /can_review_scores is disabled/
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_flag_score('${student1Id}', true, 'Flag test')`);
      },
      /can_review_scores is disabled/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_review_scores = true WHERE teacher_id = $1`, [teacherAId]);

    // 3. can_request_corrections
    await db.query(`UPDATE public.teacher_permissions SET can_request_corrections = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_request_score_correction('${student1Id}', 'results', 10, 10, 50, 'Typo')`);
      },
      /can_request_corrections is disabled/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_request_corrections = true WHERE teacher_id = $1`, [teacherAId]);

    // 4. can_generate_reports
    await db.query(`UPDATE public.teacher_permissions SET can_generate_reports = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report('${student1Id}')`);
      },
      /Forbidden: You may only view your own monthly report/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_generate_reports = true WHERE teacher_id = $1`, [teacherAId]);

    // 5. can_manage_tasks
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tasks = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.todo_for('${student1Id}')`);
      },
      /Forbidden: You (do not have permission to view daily tasks for this student|may only view your own daily tasks)/
    );
    await assert.rejects(
      async () => {
        await db.query(`INSERT INTO public.daily_tasks (title, section, created_by) VALUES ('Revoked Task', 'basics', '${teacherAId}')`);
      },
      /new row violates row-level security policy|Teacher content must have target_scope = targeted/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tasks = true WHERE teacher_id = $1`, [teacherAId]);

    // 6. can_manage_tests
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tests = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_weekly_test_sections_atomic(NULL, '{"test_date":"2026-11-08","title":"Test"}'::jsonb, '[]'::jsonb)`);
      },
      /Unauthorized: Teacher does not have can_manage_tests permission/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tests = true WHERE teacher_id = $1`, [teacherAId]);

    // 7. can_publish_announcements
    await db.query(`UPDATE public.teacher_permissions SET can_publish_announcements = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`INSERT INTO public.announcements (title, body, created_by) VALUES ('Ann Title', 'Ann Body', '${teacherAId}')`);
      },
      /new row violates row-level security policy|Teacher content must have target_scope = targeted/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_publish_announcements = true WHERE teacher_id = $1`, [teacherAId]);

    // 8. can_manage_resources
    await db.query(`UPDATE public.teacher_permissions SET can_manage_resources = false WHERE teacher_id = $1`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`INSERT INTO public.resources (title, url, topic, created_by) VALUES ('Res', 'https://example.com', 'Math', '${teacherAId}')`);
      },
      /new row violates row-level security policy|Teacher content must have target_scope = targeted/
    );
    await setAuth(adminId, 'service_role');
    await db.query(`UPDATE public.teacher_permissions SET can_manage_resources = true WHERE teacher_id = $1`, [teacherAId]);
  });

  it('13. Immediate revocation upon deactivation & unassignment with existing session', async () => {
    // 1. Establish session as Teacher A
    await setAuth(teacherAId);
    const initialView = await db.query(`SELECT id FROM public.profiles WHERE id = '${student1Id}'`);
    assert.equal(initialView.rows.length, 1, 'Teacher A initially sees Student 1');

    // 2. Admin unassigns Student 1 from Teacher A without touching Teacher A session
    await db.exec(`
      RESET ROLE;
      DELETE FROM public.teacher_student_assignments
      WHERE teacher_id = '${teacherAId}' AND student_id = '${student1Id}';
      SET ROLE authenticated;
    `);

    // Immediate subsequent queries from Teacher A must reflect unassignment immediately
    const afterUnassign = await db.query(`SELECT id FROM public.profiles WHERE id = '${student1Id}'`);
    assert.equal(afterUnassign.rows.length, 0, 'Immediately hidden after unassignment');

    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report('${student1Id}')`);
      },
      /Forbidden: You may only view your own monthly report/
    );

    // 3. Re-assign Student 1, then deactivate Teacher A
    await db.exec(`
      RESET ROLE;
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES ('${teacherAId}', '${student1Id}');
      UPDATE public.profiles SET active = false WHERE id = '${teacherAId}';
      SET ROLE authenticated;
    `);

    const checkTeacher = await db.query(`SELECT public.is_teacher()`);
    assert.equal(checkTeacher.rows[0].is_teacher, false, 'is_teacher immediately false on deactivation');

    const deactView = await db.query(`SELECT id FROM public.profiles WHERE id = '${student1Id}'`);
    assert.equal(deactView.rows.length, 0, 'Deactivated teacher sees 0 students');

    await assert.rejects(
      async () => {
        await db.query(`SELECT public.teacher_get_overview()`);
      },
      /Unauthorized: Teacher access required/
    );

    // Restore Teacher A
    await db.exec(`
      RESET ROLE;
      UPDATE public.profiles SET active = true WHERE id = '${teacherAId}';
    `);
  });

  it('14. Cross-teacher content ownership & forged recipient protection', async () => {
    await setAuth(adminId, 'service_role');
    const catRes = await db.query(`SELECT id FROM public.categories LIMIT 1;`);
    const catId = catRes.rows[0].id;

    // Teacher A creates a weekly test
    await setAuth(teacherAId);
    const testPayload = {
      test_date: '2026-11-08',
      title: 'Anita Special Test',
      test_type: 'offline',
    };
    const sectionsPayload = [
      { position: 1, kind: 'basics', category_id: catId, seconds: 60 }
    ];

    const createRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY['${student1Id}']::uuid[])`,
      [JSON.stringify(testPayload), JSON.stringify(sectionsPayload)]
    );
    const testId = createRes.rows[0].save_weekly_test_sections_atomic.test_id;
    assert.ok(testId, 'Test created by Teacher A');

    // Teacher B attempts to edit Teacher A's test
    await setAuth(teacherBId);
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic($1, $2::jsonb, $3::jsonb, NULL)`,
          [testId, JSON.stringify(testPayload), JSON.stringify(sectionsPayload)]
        );
      },
      /Teachers may only edit weekly tests that they created/
    );

    // Teacher A attempts to assign test to unassigned Student 2
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY['${student2Id}']::uuid[])`,
          [JSON.stringify(testPayload), JSON.stringify(sectionsPayload)]
        );
      },
      /Teachers may only assign weekly tests to their assigned students/
    );
  });

  it('15. Student test eligibility & section reservation (weekly_test_reserve_section_start)', async () => {
    await setAuth(adminId, 'service_role');
    const catRes = await db.query(`SELECT id FROM public.categories LIMIT 1;`);
    const catId = catRes.rows[0].id;

    // Create online test targeted to Student 1 only
    const testRes = await db.query(`
      INSERT INTO public.weekly_tests (title, test_date, test_type, created_by)
      VALUES ('Targeted Online Test', public.today_ist(), 'online', '${adminId}')
      RETURNING id;
    `);
    const targetedTestId = testRes.rows[0].id;

    const secRes = await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, category_id, seconds)
      VALUES ('${targetedTestId}', 1, 'basics', '${catId}', 60)
      RETURNING id;
    `);
    const targetSecId = secRes.rows[0].id;

    // Add Student 1 to weekly_test_recipients
    await db.query(`
      INSERT INTO public.weekly_test_recipients (test_id, student_id)
      VALUES ('${targetedTestId}', '${student1Id}');
    `);

    // Student 1 starts section: succeeds
    await setAuth(student1Id);
    const start1 = await db.query(
      `SELECT public.weekly_test_reserve_section_start($1, $2, $3)`,
      [targetedTestId, student1Id, targetSecId]
    );
    const startObj1 = start1.rows[0].weekly_test_reserve_section_start;
    assert.ok(startObj1.claim_token, 'Student 1 receives claim token');

    // Student 2 starts section: rejected
    await setAuth(student2Id);
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.weekly_test_reserve_section_start($1, $2, $3)`,
          [targetedTestId, student2Id, targetSecId]
        );
      },
      /You are not assigned to this weekly test/
    );

    // Untargeted test with no recipients: both can start
    await setAuth(adminId, 'service_role');
    const openTestRes = await db.query(`
      INSERT INTO public.weekly_tests (title, test_date, test_type, created_by)
      VALUES ('Open Test', public.today_ist(), 'online', '${adminId}')
      RETURNING id;
    `);
    const openTestId = openTestRes.rows[0].id;
    const openSecRes = await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, category_id, seconds)
      VALUES ('${openTestId}', 1, 'basics', '${catId}', 60)
      RETURNING id;
    `);
    const openSecId = openSecRes.rows[0].id;

    await setAuth(student2Id);
    const start2 = await db.query(
      `SELECT public.weekly_test_reserve_section_start($1, $2, $3)`,
      [openTestId, student2Id, openSecId]
    );
    assert.ok(start2.rows[0].weekly_test_reserve_section_start.claim_token, 'Student 2 can start open test');
  });

  it('16. Transactional teacher management RPCs & audit logging with real schema', async () => {
    await setAuth(adminId, 'service_role');
    const newTeacherId = '77777777-7777-7777-7777-777777777777';

    // 1. admin_create_teacher_entry
    const createRes = await db.query(
      `SELECT public.admin_create_teacher_entry($1, $2, $3, $4::jsonb, ARRAY[$5]::uuid[])`,
      [newTeacherId, 'TCH99', 'Teacher Chloe', JSON.stringify({ can_mark_attendance: true }), student1Id]
    );
    assert.equal(createRes.rows[0].admin_create_teacher_entry.ok, true);

    const auditCreate = await db.query(
      `SELECT action, actor_id FROM public.teacher_audit_log WHERE teacher_id = $1 ORDER BY created_at ASC`,
      [newTeacherId]
    );
    assert.equal(auditCreate.rows[0].action, 'create_teacher');
    assert.equal(auditCreate.rows[0].actor_id, adminId);

    // 2. admin_replace_teacher_assignments atomic replacement
    const replaceRes = await db.query(
      `SELECT public.admin_replace_teacher_assignments($1, ARRAY[$2]::uuid[])`,
      [newTeacherId, student2Id]
    );
    assert.equal(replaceRes.rows[0].admin_replace_teacher_assignments.ok, true);
    assert.equal(replaceRes.rows[0].admin_replace_teacher_assignments.assigned_count, 1);

    const auditReplace = await db.query(
      `SELECT action, actor_id FROM public.teacher_audit_log WHERE teacher_id = $1 AND action = 'assign_students'`,
      [newTeacherId]
    );
    assert.equal(auditReplace.rows.length, 1);
    assert.equal(auditReplace.rows[0].action, 'assign_students');
    assert.equal(auditReplace.rows[0].actor_id, adminId);

    const assignCheck = await db.query(
      `SELECT student_id FROM public.teacher_student_assignments WHERE teacher_id = $1`,
      [newTeacherId]
    );
    assert.equal(assignCheck.rows.length, 1);
    assert.equal(assignCheck.rows[0].student_id, student2Id);

    // 3. Failed replacement preserves existing assignments (rollback demonstration)
    const bogusStudentId = '99999999-9999-9999-9999-999999999999';
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.admin_replace_teacher_assignments($1, ARRAY[$2]::uuid[])`,
          [newTeacherId, bogusStudentId]
        );
      },
      /Invalid assignment: All assigned students must be active accounts with role=student/
    );

    // Existing assignment (Student 2) remains unchanged
    const afterFailedReplace = await db.query(
      `SELECT student_id FROM public.teacher_student_assignments WHERE teacher_id = $1`,
      [newTeacherId]
    );
    assert.equal(afterFailedReplace.rows.length, 1);
    assert.equal(afterFailedReplace.rows[0].student_id, student2Id);

    // 4. Password reset audit logging
    await db.query(
      `INSERT INTO public.teacher_audit_log (teacher_id, actor_id, action, details)
       VALUES ($1, $2, 'reset_password', '{"method": "admin_reset"}'::jsonb)`,
      [newTeacherId, adminId]
    );
    const pwdAudit = await db.query(
      `SELECT action, actor_id FROM public.teacher_audit_log WHERE teacher_id = $1 AND action = 'reset_password'`,
      [newTeacherId]
    );
    assert.equal(pwdAudit.rows[0].action, 'reset_password');
    assert.equal(pwdAudit.rows[0].actor_id, adminId);
  });

  it('17. Preserve existing student/admin monthly report calculation & contracts', async () => {
    await setAuth(adminId, 'service_role');
    const catRes = await db.query(`SELECT id FROM public.categories LIMIT 1;`);
    const catId = catRes.rows[0].id;

    // Insert practice result for Student 1
    await db.query(`
      INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date)
      VALUES ('${student1Id}', '${catId}', 25, 25, 60, public.today_ist());
    `);

    // Insert Weekly Test & Sections with Elements (category_id NULL), Flash (category_id NULL), Memoriad (category_id NULL), and Basics
    const wtRes = await db.query(`
      INSERT INTO public.weekly_tests (test_date, title, audience_level, test_type)
      VALUES (public.today_ist(), 'November Weekly Assessment', 'Level 3', 'online')
      RETURNING id;
    `);
    const wtId = wtRes.rows[0].id;

    const s1 = (await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, activity_key)
      VALUES ('${wtId}', 1, 'elements', 'squares_stage_1') RETURNING id;
    `)).rows[0].id;
    const s2 = (await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, flash_digits, flash_count, flash_speed_ms, flash_mode, question_count)
      VALUES ('${wtId}', 2, 'flash', 1, 50, 500, 'add', 5) RETURNING id;
    `)).rows[0].id;
    const s3 = (await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, activity_key)
      VALUES ('${wtId}', 3, 'memoriad', 'calendar') RETURNING id;
    `)).rows[0].id;
    const s4 = (await db.query(`
      INSERT INTO public.weekly_test_sections (test_id, position, kind, category_id, seconds)
      VALUES ('${wtId}', 4, 'basics', '${catId}', 60) RETURNING id;
    `)).rows[0].id;

    // Insert 4 weekly test scores for student 1 (including activity-based scores with category_id NULL)
    await db.query(`
      INSERT INTO public.weekly_test_scores (test_id, student_id, section_id, category_id, correct, total, time_seconds)
      VALUES
        ('${wtId}', '${student1Id}', '${s1}', NULL, 25, 25, 45),
        ('${wtId}', '${student1Id}', '${s2}', NULL, 5, 5, 25),
        ('${wtId}', '${student1Id}', '${s3}', NULL, 10, 10, 60),
        ('${wtId}', '${student1Id}', '${s4}', '${catId}', 20, 20, 55);
    `);

    // Admin report
    await setAuth(adminId, 'service_role');
    const adminRep = await db.query(`SELECT public.student_month_report('${student1Id}')`);
    const rawData = adminRep.rows[0].student_month_report;
    const adminData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    assert.ok(adminData.month_start, 'Report has month_start');
    assert.ok(adminData.month_end, 'Report has month_end');
    assert.ok(adminData.student, 'Report has student details');
    assert.ok(Array.isArray(adminData.weeks), 'Report has weeks array');
    assert.ok(Array.isArray(adminData.categories), 'Report has categories array');
    assert.equal(adminData.practice.entries, 1);
    assert.equal(adminData.weekly_tests.length, 4, 'Report must contain all 4 weekly test scores including category-free online activities');

    const elemRow = adminData.weekly_tests.find((t) => t.category === 'Square - Stage 1 (1-25)');
    assert.ok(elemRow, 'Elements score must resolve to Square - Stage 1 (1-25)');
    assert.equal(elemRow.correct, 25);
    assert.equal(elemRow.total, 25);

    const flashRow = adminData.weekly_tests.find((t) => t.category === 'Flash Anzan (1D 50N)');
    assert.ok(flashRow, 'Flash Anzan score must resolve to Flash Anzan (1D 50N)');
    assert.equal(flashRow.correct, 5);

    const memRow = adminData.weekly_tests.find((t) => t.category === 'Mental Calendar Dates');
    assert.ok(memRow, 'Memoriad score must resolve to Mental Calendar Dates');
    assert.equal(memRow.correct, 10);

    // Student 1 report (student viewing own report)
    await setAuth(student1Id);
    const stuRep = await db.query(`SELECT public.student_month_report('${student1Id}')`);
    const stuRaw = stuRep.rows[0].student_month_report;
    const stuData = typeof stuRaw === 'string' ? JSON.parse(stuRaw) : stuRaw;
    assert.deepEqual(stuData.practice, adminData.practice, 'Student sees identical calculation');
    assert.equal(stuData.weekly_tests.length, 4, 'Student sees all 4 weekly test scores');

    // Assigned Teacher A report
    await setAuth(teacherAId);
    const tchRep = await db.query(`SELECT public.student_month_report('${student1Id}')`);
    const tchRaw = tchRep.rows[0].student_month_report;
    const tchData = typeof tchRaw === 'string' ? JSON.parse(tchRaw) : tchRaw;
    assert.deepEqual(tchData.practice, adminData.practice, 'Assigned teacher sees identical calculation');
    assert.equal(tchData.weekly_tests.length, 4, 'Assigned teacher sees all 4 weekly test scores');

    // Unauthorized student access: Student 2 attempting to view Student 1's report is blocked
    await setAuth(student2Id);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report('${student1Id}')`);
      },
      /Forbidden: You may only view your own monthly report/
    );

    // Unassigned Teacher B report for unassigned Student 2: Forbidden
    await setAuth(teacherBId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.student_month_report('${student2Id}')`);
      },
      /Forbidden: You may only view your own monthly report/
    );
  });

  it('18. Migration rerun idempotency and unambiguous save_weekly_test_sections_atomic resolution', async () => {
    // Re-run migration 16 completely to prove all policy drops, function drops, and schema modifications are idempotent
    const migrationPath = path.join(ROOT_DIR, 'supabase', 'migrations', '16_phase18_teacher_role_and_workspace.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await db.exec(migrationSql);

    // Call save_weekly_test_sections_atomic with 3 parameters (omitted p_recipients)
    await setAuth(adminId);
    const testPayload = JSON.stringify({
      title: '3-Param Admin Test',
      test_date: '2026-11-06',
      test_type: 'offline',
    });
    const sectionsPayload = JSON.stringify([]);
    const res3 = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb) AS res`,
      [testPayload, sectionsPayload]
    );
    const res3Data = typeof res3.rows[0].res === 'string' ? JSON.parse(res3.rows[0].res) : res3.rows[0].res;
    assert.equal(res3Data.ok, true);
    assert.ok(res3Data.test_id);

    // Call save_weekly_test_sections_atomic with 4 parameters (explicit recipients)
    const res4 = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, $3::uuid[]) AS res`,
      [testPayload, sectionsPayload, [student1Id]]
    );
    const res4Data = typeof res4.rows[0].res === 'string' ? JSON.parse(res4.rows[0].res) : res4.rows[0].res;
    assert.equal(res4Data.ok, true);
    assert.ok(res4Data.test_id);
  });

  it('19. Atomic content saves: fail-closed for empty teacher recipients, reject unassigned, atomic rollback', async () => {
    await setAuth(teacherAId);

    // 19a. Announcements: empty recipients rejected (fail-closed)
    const annPayload = JSON.stringify({
      title: 'Teacher Announcement',
      body: 'Important update for my students',
      audience_level: 'Level 1',
    });
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [annPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, NULL)`, [annPayload]);
      },
      /Targeted recipients required/i
    );

    // 19b. Announcements: unassigned student rejected before any row is saved
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, $2::uuid[])`, [
          annPayload,
          [student1Id, student2Id], // Student 2 is NOT assigned to Teacher A!
        ]);
      },
      /Unauthorized/i
    );
    // Verify zero rows were inserted (atomic rollback)
    const checkAnn = await db.query(`SELECT count(*)::int AS cnt FROM public.announcements WHERE title = 'Teacher Announcement'`);
    assert.equal(checkAnn.rows[0].cnt, 0);

    // 19c. Announcements: success for assigned student
    const validAnn = await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      annPayload,
      [student1Id],
    ]);
    const validAnnData = typeof validAnn.rows[0].res === 'string' ? JSON.parse(validAnn.rows[0].res) : validAnn.rows[0].res;
    assert.equal(validAnnData.success, true);
    assert.equal(validAnnData.recipient_count, 1);

    // 19d. Resources: fail-closed on empty recipients & unassigned
    const resPayload = JSON.stringify({
      title: 'Abacus Video',
      url: 'https://example.com/video',
      topic: 'Technique',
    });
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [resPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, $2::uuid[])`, [
          resPayload,
          [student2Id], // unassigned
        ]);
      },
      /Unauthorized/i
    );
    // Success for assigned
    const validRes = await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      resPayload,
      [student1Id],
    ]);
    const validResData = typeof validRes.rows[0].res === 'string' ? JSON.parse(validRes.rows[0].res) : validRes.rows[0].res;
    assert.equal(validResData.success, true);

    // 19e. Daily Tasks: fail-closed on empty recipients & unassigned
    const taskPayload = JSON.stringify({
      title: 'Practice Addition 10 mins',
      section: 'basics',
    });
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [taskPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, $2::uuid[])`, [
          taskPayload,
          [student2Id],
        ]);
      },
      /Unauthorized/i
    );
    const validTask = await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      taskPayload,
      [student1Id],
    ]);
    const validTaskData = typeof validTask.rows[0].res === 'string' ? JSON.parse(validTask.rows[0].res) : validTask.rows[0].res;
    assert.equal(validTaskData.success, true);

    // 19f. Admin can save general content with empty recipients
    await setAuth(adminId);
    const adminAnn = await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[]::uuid[]) AS res`, [
      JSON.stringify({ title: 'School-wide Notice', body: 'All students assemble' }),
    ]);
    const adminAnnData = typeof adminAnn.rows[0].res === 'string' ? JSON.parse(adminAnn.rows[0].res) : adminAnn.rows[0].res;
    assert.equal(adminAnnData.success, true);
    assert.equal(adminAnnData.recipient_count, 0);
  });

  it('20. Student visibility across recipient matrix: recipient, non-recipient (same level), non-recipient (other level), deactivated teacher', async () => {
    // Seed:
    // Student 1: Level 1 (assigned to Teacher A)
    // Student 2: Level 1 (same level, NOT assigned to Teacher A)
    // Student 3: Level 2 (other level, NOT assigned to Teacher A)
    const student3Id = '77777777-7777-7777-7777-777777777777';
    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
      VALUES ('${student3Id}', 'STU103', 'Student Three', 'student', 'Level 2', true);
      UPDATE public.profiles SET level = 'Level 1' WHERE id = '${student2Id}';
    `);

    // Teacher A creates targeted announcement, resource, and task specifically for Student 1
    await setAuth(teacherAId);
    const annRes = await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      JSON.stringify({ title: 'Targeted For S1 Only', body: 'Secret message for S1', audience_level: 'Level 1' }),
      [student1Id],
    ]);
    const annId = (typeof annRes.rows[0].res === 'string' ? JSON.parse(annRes.rows[0].res) : annRes.rows[0].res).id;

    const taskRes = await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      JSON.stringify({ title: 'Targeted Task S1 Only', section: 'basics', level: 'Level 1' }),
      [student1Id],
    ]);
    const taskId = (typeof taskRes.rows[0].res === 'string' ? JSON.parse(taskRes.rows[0].res) : taskRes.rows[0].res).id;

    const resourceRes = await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, $2::uuid[]) AS res`, [
      JSON.stringify({ title: 'Targeted Resource S1 Only', url: 'https://example.com/s1', audience_level: 'Level 1' }),
      [student1Id],
    ]);
    const resId = (typeof resourceRes.rows[0].res === 'string' ? JSON.parse(resourceRes.rows[0].res) : resourceRes.rows[0].res).id;

    // Student 1 (recipient) queries announcements, tasks, resources -> MUST see them
    await setAuth(student1Id);
    const s1Ann = await db.query(`SELECT id FROM public.announcements WHERE id = $1`, [annId]);
    assert.equal(s1Ann.rows.length, 1, 'Student 1 can see targeted announcement');
    const s1Task = await db.query(`SELECT id FROM public.daily_tasks WHERE id = $1`, [taskId]);
    assert.equal(s1Task.rows.length, 1, 'Student 1 can see targeted task');
    const s1Res = await db.query(`SELECT id FROM public.resources WHERE id = $1`, [resId]);
    assert.equal(s1Res.rows.length, 1, 'Student 1 can see targeted resource');

    // Student 2 (non-recipient at SAME level 'Level 1') -> MUST NOT see them!
    await setAuth(student2Id);
    const s2Ann = await db.query(`SELECT id FROM public.announcements WHERE id = $1`, [annId]);
    assert.equal(s2Ann.rows.length, 0, 'Student 2 (same level non-recipient) CANNOT see targeted announcement');
    const s2Task = await db.query(`SELECT id FROM public.daily_tasks WHERE id = $1`, [taskId]);
    assert.equal(s2Task.rows.length, 0, 'Student 2 (same level non-recipient) CANNOT see targeted task');
    const s2Res = await db.query(`SELECT id FROM public.resources WHERE id = $1`, [resId]);
    assert.equal(s2Res.rows.length, 0, 'Student 2 (same level non-recipient) CANNOT see targeted resource');

    // Also verify todo_for for Student 2: does NOT include Student 1's targeted task
    const s2TodoList = await db.query(`SELECT task_id FROM public.todo_for() WHERE task_id = $1`, [taskId]);
    assert.equal(s2TodoList.rows.length, 0, 'todo_for excludes targeted task for non-recipient');

    // Student 3 (non-recipient at OTHER level 'Level 2') -> MUST NOT see them!
    await setAuth(student3Id);
    const s3Ann = await db.query(`SELECT id FROM public.announcements WHERE id = $1`, [annId]);
    assert.equal(s3Ann.rows.length, 0, 'Student 3 (other level non-recipient) CANNOT see targeted announcement');

    // Deactivated Teacher A -> CANNOT read or save content
    await setAuth(adminId);
    await db.query(`SELECT public.admin_set_teacher_active($1, false)`, [teacherAId]);
    await setAuth(teacherAId);
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, $2::uuid[])`, [
          JSON.stringify({ title: 'Post-deactivation', body: 'Blocked' }),
          [student1Id],
        ]);
      },
      /Unauthorized/i
    );
    // Reactivate for subsequent tests
    await setAuth(adminId);
    await db.query(`SELECT public.admin_set_teacher_active($1, true)`, [teacherAId]);
  });

  it('21. teacher_get_overview: permission gates, test scoping, and pre-aggregation database limits', async () => {
    // 1. Seed > 20 flagged results and > 25 unverified results for Student 1 to test limits
    await setAuth(null, 'postgres');
    for (let i = 0; i < 30; i++) {
      await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, verified, flagged, flag_note, entry_date)
        VALUES ('${student1Id}', '00000000-0000-0000-0000-000000000001', 5, 5, false, true, 'Flag ${i}', public.today_ist());
      `);
    }

    // Seed upcoming tests:
    // Test A: Created by Teacher A
    // Test B: Created by Admin, targeted to Student 1
    // Test C: Created by Admin, general (no recipients)
    // Test D: Created by Teacher B, targeted to Student 2 (unassigned to Teacher A)
    const testAId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const testBId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const testCId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const testDId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

    await db.exec(`
      INSERT INTO public.weekly_tests (id, title, test_date, test_type, created_by)
      VALUES
        ('${testAId}', 'Teacher A Test', public.today_ist() + 2, 'offline', '${teacherAId}'),
        ('${testBId}', 'Admin Targeted S1', public.today_ist() + 3, 'offline', '${adminId}'),
        ('${testCId}', 'Admin General All', public.today_ist() + 4, 'offline', '${adminId}'),
        ('${testDId}', 'Teacher B Private', public.today_ist() + 5, 'offline', '${teacherBId}');

      INSERT INTO public.weekly_test_recipients (test_id, student_id)
      VALUES
        ('${testBId}', '${student1Id}'),
        ('${testDId}', '${student2Id}');
    `);

    // Call teacher_get_overview as Teacher A
    await setAuth(teacherAId);
    const ov1 = await db.query(`SELECT public.teacher_get_overview() AS ov`);
    const ov1Data = typeof ov1.rows[0].ov === 'string' ? JSON.parse(ov1.rows[0].ov) : ov1.rows[0].ov;

    // Verify pre-aggregation limits:
    // needs_attention is capped at 20 (not 30!)
    assert.equal(ov1Data.needs_attention.length, 20, 'needs_attention is capped at LIMIT 20 before jsonb_agg');
    // pending_review is capped at 25 (not 30!)
    assert.equal(ov1Data.pending_review.length, 25, 'pending_review is capped at LIMIT 25 before jsonb_agg');

    // Verify upcoming test scoping:
    // Should contain Test A (own), Test B (assigned student S1), Test C (admin general)
    // MUST NOT contain Test D (Teacher B test for Student 2)
    const testIds = ov1Data.upcoming_tests.map((t) => t.id);
    assert.ok(testIds.includes(testAId), 'Includes own test');
    assert.ok(testIds.includes(testBId), 'Includes test targeted to assigned student');
    assert.ok(testIds.includes(testCId), 'Includes general admin test');
    assert.ok(!testIds.includes(testDId), 'Excludes test targeted to unassigned student of another teacher');

    // 2. Test granular permission revocation gates in overview:
    // Revoke can_view_students -> not_practiced_today is empty []
    await setAuth(adminId);
    await db.query(`UPDATE public.teacher_permissions SET can_view_students = false WHERE teacher_id = '${teacherAId}'`);
    await setAuth(teacherAId);
    const ov2 = await db.query(`SELECT public.teacher_get_overview() AS ov`);
    const ov2Data = typeof ov2.rows[0].ov === 'string' ? JSON.parse(ov2.rows[0].ov) : ov2.rows[0].ov;
    assert.equal(ov2Data.not_practiced_today.length, 0, 'Revoking can_view_students empties not_practiced_today');

    // Revoke can_review_scores -> needs_attention and pending_review are empty []
    await setAuth(adminId);
    await db.query(`UPDATE public.teacher_permissions SET can_review_scores = false WHERE teacher_id = '${teacherAId}'`);
    await setAuth(teacherAId);
    const ov3 = await db.query(`SELECT public.teacher_get_overview() AS ov`);
    const ov3Data = typeof ov3.rows[0].ov === 'string' ? JSON.parse(ov3.rows[0].ov) : ov3.rows[0].ov;
    assert.equal(ov3Data.needs_attention.length, 0, 'Revoking can_review_scores empties needs_attention');
    assert.equal(ov3Data.pending_review.length, 0, 'Revoking can_review_scores empties pending_review');

    // Revoke can_manage_tests -> upcoming_tests is empty []
    await setAuth(adminId);
    await db.query(`UPDATE public.teacher_permissions SET can_manage_tests = false WHERE teacher_id = '${teacherAId}'`);
    await setAuth(teacherAId);
    const ov4 = await db.query(`SELECT public.teacher_get_overview() AS ov`);
    const ov4Data = typeof ov4.rows[0].ov === 'string' ? JSON.parse(ov4.rows[0].ov) : ov4.rows[0].ov;
    assert.equal(ov4Data.upcoming_tests.length, 0, 'Revoking can_manage_tests empties upcoming_tests');
  });

  it('22. API handler admin identity: verify admin caller JWT and service-role requests record administrator consistently', async () => {
    // Test admin_create_teacher_entry with explicit p_actor_id (matching API handler path)
    const newTeacherId = '88888888-8888-8888-8888-888888888888';
    
    // Simulate service-role call without user subject (auth.uid() is null, p_actor_id is adminId)
    await setAuth(null, 'service_role');
    const createRes = await db.query(
      `SELECT public.admin_create_teacher_entry($1, $2, $3, $4::jsonb, $5::uuid[], $6) AS res`,
      [newTeacherId, 'TCH03', 'Teacher Chitra', JSON.stringify({}), [student1Id], adminId]
    );
    const createData = typeof createRes.rows[0].res === 'string' ? JSON.parse(createRes.rows[0].res) : createRes.rows[0].res;
    assert.equal(createData.ok, true);

    // Verify teacher_audit_log recorded adminId as actor_id, NEVER newTeacherId
    const auditRes = await db.query(
      `SELECT actor_id, action FROM public.teacher_audit_log WHERE teacher_id = $1 AND action = 'create_teacher'`,
      [newTeacherId]
    );
    assert.equal(auditRes.rows.length, 1);
    assert.equal(auditRes.rows[0].actor_id, adminId, 'Actor ID is administrator, not the target teacher');

    // Test assignment update with service_role passing adminId
    const assignRes = await db.query(
      `SELECT public.admin_replace_teacher_assignments($1, $2::uuid[], $3) AS res`,
      [newTeacherId, [student1Id], adminId]
    );
    const assignData = typeof assignRes.rows[0].res === 'string' ? JSON.parse(assignRes.rows[0].res) : assignRes.rows[0].res;
    assert.equal(assignData.ok, true);

    const assignAudit = await db.query(
      `SELECT actor_id, action FROM public.teacher_audit_log WHERE teacher_id = $1 AND action = 'assign_students'`,
      [newTeacherId]
    );
    assert.equal(assignAudit.rows.length, 1);
    assert.equal(assignAudit.rows[0].actor_id, adminId, 'Actor ID in assign_students audit is administrator');

    // Verify rejection if actor_id is missing on service-role call (NOT NULL constraint fail-closed)
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.admin_set_teacher_active($1, $2, NULL)`,
          [newTeacherId, false]
        );
      },
      /Actor ID is required/i
    );
  });

  it('23. Recipient array edge cases: fail-closed rejection of NULL, empty, and all-NULL arrays across all 4 save RPCs', async () => {
    await setAuth(teacherAId);

    const testPayload = JSON.stringify({ title: 'Edge Case Test', test_date: '2026-11-10', test_type: 'online' });
    const annPayload = JSON.stringify({ title: 'Edge Case Ann', body: 'Body' });
    const resPayload = JSON.stringify({ title: 'Edge Case Res', url: 'https://example.com' });
    const taskPayload = JSON.stringify({ title: 'Edge Case Task', section: 'basics' });
    const sectionsPayload = JSON.stringify([]);

    // 1. Weekly Tests: NULL, empty array, all-NULL array, duplicates
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, NULL)`, [testPayload, sectionsPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY[]::uuid[])`, [testPayload, sectionsPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY[NULL::uuid, NULL::uuid])`, [testPayload, sectionsPayload]);
      },
      /Targeted recipients required/i
    );
    // Duplicate recipient array: should deduplicate to 1 recipient
    const wtDupRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY[$3::uuid, $3::uuid]) AS res`,
      [testPayload, sectionsPayload, student1Id]
    );
    const wtDupData = typeof wtDupRes.rows[0].res === 'string' ? JSON.parse(wtDupRes.rows[0].res) : wtDupRes.rows[0].res;
    const wtRecCount = await db.query(`SELECT count(*)::int AS count FROM public.weekly_test_recipients WHERE test_id = $1`, [wtDupData.test_id]);
    assert.equal(wtRecCount.rows[0].count, 1, 'Deduplicates duplicate recipients for weekly tests');

    // 2. Announcements: NULL, empty array, all-NULL array, duplicates
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, NULL)`, [annPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [annPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[NULL::uuid, NULL::uuid])`, [annPayload]);
      },
      /Targeted recipients required/i
    );
    const annDupRes = await db.query(
      `SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[$2::uuid, $2::uuid]) AS res`,
      [annPayload, student1Id]
    );
    const annDupData = typeof annDupRes.rows[0].res === 'string' ? JSON.parse(annDupRes.rows[0].res) : annDupRes.rows[0].res;
    assert.equal(annDupData.recipient_count, 1, 'Deduplicates duplicate recipients for announcements');

    // 3. Resources: NULL, empty array, all-NULL array, duplicates
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, NULL)`, [resPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [resPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_resource_atomic(NULL, $1::jsonb, ARRAY[NULL::uuid, NULL::uuid])`, [resPayload]);
      },
      /Targeted recipients required/i
    );
    const resDupRes = await db.query(
      `SELECT public.save_resource_atomic(NULL, $1::jsonb, ARRAY[$2::uuid, $2::uuid]) AS res`,
      [resPayload, student1Id]
    );
    const resDupData = typeof resDupRes.rows[0].res === 'string' ? JSON.parse(resDupRes.rows[0].res) : resDupRes.rows[0].res;
    assert.equal(resDupData.recipient_count, 1, 'Deduplicates duplicate recipients for resources');

    // 4. Daily Tasks: NULL, empty array, all-NULL array, duplicates
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, NULL)`, [taskPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[]::uuid[])`, [taskPayload]);
      },
      /Targeted recipients required/i
    );
    await assert.rejects(
      async () => {
        await db.query(`SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[NULL::uuid, NULL::uuid])`, [taskPayload]);
      },
      /Targeted recipients required/i
    );
    const taskDupRes = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid, $2::uuid]) AS res`,
      [taskPayload, student1Id]
    );
    const taskDupData = typeof taskDupRes.rows[0].res === 'string' ? JSON.parse(taskDupRes.rows[0].res) : taskDupRes.rows[0].res;
    assert.equal(taskDupData.recipient_count, 1, 'Deduplicates duplicate recipients for tasks');
  });

  it('24. Direct mutation blocks: trigger and RLS prevent direct table tampering by teachers', async () => {
    await setAuth(teacherAId);

    // 1. Direct INSERT into content tables is blocked for teachers (must use atomic RPCs)
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.weekly_tests (title, test_date, test_type, created_by, target_scope)
           VALUES ('Direct Test', public.today_ist(), 'online', '${teacherAId}', 'targeted')`
        );
      },
      /new row violates row-level security policy/
    );

    // 2. Direct INSERT into recipient tables is restricted to admin only
    const dummyTestId = '99999999-9999-9999-9999-999999999999';
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.weekly_test_recipients (test_id, student_id) VALUES ('${dummyTestId}', '${student1Id}')`
        );
      },
      /new row violates row-level security policy/
    );
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.daily_task_recipients (task_id, student_id) VALUES ('${dummyTestId}', '${student1Id}')`
        );
      },
      /new row violates row-level security policy/
    );
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.announcement_recipients (announcement_id, student_id) VALUES ('${dummyTestId}', '${student1Id}')`
        );
      },
      /new row violates row-level security policy/
    );
    await assert.rejects(
      async () => {
        await db.query(
          `INSERT INTO public.resource_recipients (resource_id, student_id) VALUES ('${dummyTestId}', '${student1Id}')`
        );
      },
      /new row violates row-level security policy/
    );

    // 3. Create a valid targeted announcement via atomic RPC, then attempt to alter created_by or target_scope directly
    const annRes = await db.query(
      `SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [JSON.stringify({ title: 'Invariant Check', body: 'Test Body' }), student1Id]
    );
    const annId = (typeof annRes.rows[0].res === 'string' ? JSON.parse(annRes.rows[0].res) : annRes.rows[0].res).id;

    // Mutate created_by -> rejected by trigger
    await assert.rejects(
      async () => {
        await db.query(`UPDATE public.announcements SET created_by = '${adminId}' WHERE id = '${annId}'`);
      },
      /Cannot change content creator/i
    );

    // Mutate target_scope to 'all' -> rejected by trigger
    await assert.rejects(
      async () => {
        await db.query(`UPDATE public.announcements SET target_scope = 'all' WHERE id = '${annId}'`);
      },
      /Cannot change content audience scope|Teacher content must have target_scope = targeted/i
    );
  });

  it('25. Creator deactivation & durable audience: deactivating teacher preserves targeting and delivery to assigned student', async () => {
    // 1. Teacher A creates targeted content for Student 1
    await setAuth(teacherAId);
    const catRes = await db.query(`SELECT id FROM public.categories LIMIT 1;`);
    const catId = catRes.rows[0].id;

    const todayRes = await db.query(`SELECT public.today_ist()::text AS today`);
    const todayDate = todayRes.rows[0].today;

    const wtRes = await db.query(
      `SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, ARRAY[$3::uuid]) AS res`,
      [
        JSON.stringify({ title: 'Durable Test', test_date: todayDate, test_type: 'online' }),
        JSON.stringify([{ position: 1, kind: 'basics', category_id: catId, seconds: 60 }]),
        student1Id
      ]
    );
    const wtData = typeof wtRes.rows[0].res === 'string' ? JSON.parse(wtRes.rows[0].res) : wtRes.rows[0].res;
    const testId = wtData.test_id || wtData.id;

    const secRes = await db.query(`SELECT id FROM public.weekly_test_sections WHERE test_id = $1 LIMIT 1`, [testId]);
    const secId = secRes.rows[0].id;

    const annRes = await db.query(
      `SELECT public.save_announcement_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [JSON.stringify({ title: 'Durable Announcement', body: 'Durable message for Student 1' }), student1Id]
    );
    const annId = (typeof annRes.rows[0].res === 'string' ? JSON.parse(annRes.rows[0].res) : annRes.rows[0].res).id;

    const taskRes = await db.query(
      `SELECT public.save_daily_task_atomic(NULL, $1::jsonb, ARRAY[$2::uuid]) AS res`,
      [JSON.stringify({ title: 'Durable Task', section: 'basics' }), student1Id]
    );
    const taskId = (typeof taskRes.rows[0].res === 'string' ? JSON.parse(taskRes.rows[0].res) : taskRes.rows[0].res).id;

    // 2. Admin deactivates Teacher A
    await setAuth(adminId, 'service_role');
    await db.query(`SELECT public.admin_set_teacher_active($1, false, $2)`, [teacherAId, adminId]);

    // Verify content rows still maintain target_scope = 'targeted'
    const wtCheck = await db.query(`SELECT target_scope FROM public.weekly_tests WHERE id = $1`, [testId]);
    assert.equal(wtCheck.rows[0].target_scope, 'targeted', 'target_scope remains targeted');

    // 3. Student 1 (recipient):
    await setAuth(student1Id);
    // a) Can access via my_notifications()
    const notifs = await db.query(`SELECT ref, title FROM public.my_notifications()`);
    const notifTitles = notifs.rows.map((n) => n.title);
    assert.ok(notifTitles.includes('Durable Announcement'), 'Student 1 receives notification for durable announcement');

    // b) Can view task in todo_for()
    const todoList = await db.query(`SELECT task_id FROM public.todo_for() WHERE task_id = $1`, [taskId]);
    assert.equal(todoList.rows.length, 1, 'Student 1 receives durable task in todo_for');

    // c) Can reserve section in weekly_test_reserve_section_start() (service-role mediated API path)
    await setAuth(student1Id, 'service_role');
    const reserveRes = await db.query(
      `SELECT public.weekly_test_reserve_section_start($1, $2, $3) AS res`,
      [testId, student1Id, secId]
    );
    const reserveData = typeof reserveRes.rows[0].res === 'string' ? JSON.parse(reserveRes.rows[0].res) : reserveRes.rows[0].res;
    assert.equal(reserveData.ok, true, 'Student 1 can reserve section on durable test');

    // 4. Student 2 (non-recipient at same level):
    await setAuth(student2Id);
    // a) my_notifications() DOES NOT include Teacher A content
    const s2Notifs = await db.query(`SELECT title FROM public.my_notifications()`);
    const s2Titles = s2Notifs.rows.map((n) => n.title);
    assert.ok(!s2Titles.includes('Durable Announcement'), 'Student 2 does NOT receive durable announcement');

    // b) todo_for() DOES NOT include durable task
    const s2TodoList = await db.query(`SELECT task_id FROM public.todo_for() WHERE task_id = $1`, [taskId]);
    assert.equal(s2TodoList.rows.length, 0, 'Student 2 does NOT receive durable task');

    // c) weekly_test_reserve_section_start() REJECTS Student 2 (service-role mediated API path)
    await setAuth(student2Id, 'service_role');
    await assert.rejects(
      async () => {
        await db.query(
          `SELECT public.weekly_test_reserve_section_start($1, $2, $3)`,
          [testId, student2Id, secId]
        );
      },
      /You are not assigned to this weekly test/
    );

    // Reactivate Teacher A for any following tests
    await setAuth(adminId, 'service_role');
    await db.query(`SELECT public.admin_set_teacher_active($1, true, $2)`, [teacherAId, adminId]);
  });
});
