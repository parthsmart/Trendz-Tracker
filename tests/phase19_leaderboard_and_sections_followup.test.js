/**
 * Phase 19 Follow-up Verification Tests:
 * 1. Student Leaderboard Authorization Failure & Trusted Internal Calculation Engine
 * 2. Weekly-Test Section Creation Failure & wt_sections_shape_check Compliance
 * 3. Migration Idempotency & Staging Isolation Latch Verification
 *
 * Uses real PostgreSQL engine (PGlite WebAssembly) to verify exact schema constraints,
 * security-definer execution semantics, caller authorization gates, and atomic rollbacks.
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

describe('Phase 19 Follow-up: Leaderboard Auth & Weekly Sections Shape Check', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const student1Id = '22222222-2222-2222-2222-222222222221';
  const student2Id = '22222222-2222-2222-2222-222222222222';
  const student3Id = '22222222-2222-2222-2222-222222222223';
  const teacher1Id = '33333333-3333-3333-3333-333333333331';
  const teacher2Id = '33333333-3333-3333-3333-333333333332';

  const catBasicsId = '44444444-4444-4444-4444-444444444441';
  const catRoundId = '44444444-4444-4444-4444-444444444442';

  before(async () => {
    db = new PGlite();

    // 1. Roles and session auth mocks
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

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$
        SELECT jsonb_build_object('role', COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated'));
      $$ LANGUAGE sql STABLE;
    `);

    // 2. Base tables matching Mumbai & Staging
    await db.exec(`
      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student',
        level TEXT NULL,
        full_name TEXT NULL,
        student_code TEXT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.teacher_student_assignments (
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (teacher_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.teacher_permissions (
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        PRIMARY KEY (teacher_id, permission)
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
        level TEXT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        required_count INTEGER NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true,
        activity_key TEXT NULL,
        flash_digits SMALLINT NULL,
        flash_count INTEGER NULL,
        flash_speed_ms INTEGER NULL,
        flash_mode TEXT NULL,
        target_scope TEXT NOT NULL DEFAULT 'all',
        duration_seconds INT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id),
        student_round_id UUID NULL,
        correct INTEGER NULL,
        total INTEGER NULL,
        time_seconds INTEGER NULL,
        entry_date DATE NOT NULL,
        source TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL DEFAULT '',
        correct INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        time_seconds INTEGER NOT NULL DEFAULT 0,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL DEFAULT '',
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds NUMERIC NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        submitted_at TIMESTAMPTZ NULL,
        status TEXT NOT NULL DEFAULT 'open',
        result_id UUID NULL,
        result_row_id UUID NULL
      );

      CREATE TABLE IF NOT EXISTS public.daily_todo_log (
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        all_done BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (student_id, day)
      );

      CREATE TABLE IF NOT EXISTS public.competition_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS public.rollout_boundaries (
        feature TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'installed',
        activated_at TIMESTAMPTZ NULL
      );

      CREATE TABLE IF NOT EXISTS public.weekly_tests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        test_date DATE NOT NULL,
        test_type TEXT NOT NULL DEFAULT 'offline' CHECK (test_type IN ('offline', 'online')),
        audience_level TEXT NULL,
        notes TEXT NULL,
        opens_at TIMESTAMPTZ NULL,
        closes_at TIMESTAMPTZ NULL,
        remind_days_before INT NOT NULL DEFAULT 7,
        created_by UUID NULL REFERENCES public.profiles(id),
        target_scope TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_recipients (
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (test_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        position INT NOT NULL,
        kind TEXT NOT NULL,
        category_id UUID NULL REFERENCES public.categories(id),
        seconds INT NULL,
        activity_key TEXT NULL,
        flash_digits INT NULL,
        flash_count INT NULL,
        flash_speed_ms INT NULL,
        flash_mode TEXT NULL,
        question_count INT NULL,
        CONSTRAINT weekly_test_sections_position_check CHECK (position >= 1 AND position <= 20),
        CONSTRAINT weekly_test_sections_seconds_check CHECK (seconds IS NULL OR seconds = ANY (ARRAY[30, 60, 120, 300])),
        CONSTRAINT wt_sections_kind_check CHECK (kind = ANY (ARRAY['basics'::text, 'round'::text, 'flash'::text, 'elements'::text, 'memoriad'::text])),
        CONSTRAINT wt_sections_shape_check CHECK (
          (
            (kind = ANY (ARRAY['basics'::text, 'round'::text]))
            AND (category_id IS NOT NULL)
            AND (activity_key IS NULL)
            AND (flash_digits IS NULL)
            AND (flash_count IS NULL)
            AND (flash_speed_ms IS NULL)
            AND (flash_mode IS NULL)
            AND (question_count IS NULL)
          )
          OR
          (
            (kind = ANY (ARRAY['elements'::text, 'memoriad'::text]))
            AND (category_id IS NULL)
            AND (seconds IS NULL)
            AND (activity_key IS NOT NULL)
            AND (activity_key ~ '^[a-z0-9_]{2,40}$'::text)
            AND (flash_digits IS NULL)
            AND (flash_count IS NULL)
            AND (flash_speed_ms IS NULL)
            AND (flash_mode IS NULL)
            AND (question_count IS NULL)
          )
          OR
          (
            (kind = 'flash'::text)
            AND (category_id IS NULL)
            AND (activity_key IS NULL)
            AND (seconds IS NULL)
            AND (flash_digits IS NOT NULL) AND (flash_digits >= 1 AND flash_digits <= 5)
            AND (flash_count IS NOT NULL) AND (flash_count >= 2 AND flash_count <= 1000)
            AND (flash_speed_ms IS NOT NULL) AND (flash_speed_ms >= 200 AND flash_speed_ms <= 5000)
            AND (flash_mode IS NOT NULL) AND (flash_mode = ANY (ARRAY['add'::text, 'add_sub'::text]))
            AND (question_count IS NOT NULL) AND (question_count >= 1 AND question_count <= 10)
          )
        )
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID NULL REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
        category_id UUID NULL REFERENCES public.categories(id),
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        section_id UUID NOT NULL REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
        category_id UUID NULL REFERENCES public.categories(id),
        session_id UUID NULL,
        status TEXT NOT NULL DEFAULT 'open',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ NULL
      );

      CREATE TABLE IF NOT EXISTS public.attendance (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        session_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'present'
      );

      CREATE TABLE IF NOT EXISTS public.attendance_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_date DATE NOT NULL
      );
    `);

    // 3. Helper functions
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.profiles WHERE id = p_uid AND role = 'teacher' AND active = true
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id UUID, p_permission TEXT) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_permissions WHERE teacher_id = p_teacher_id AND permission = p_permission
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_student_assignments WHERE teacher_id = p_teacher_id AND student_id = p_student_id
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id UUID, p_student_id UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.daily_task_recipients WHERE task_id = p_task_id AND student_id = p_student_id
        );
      $$ LANGUAGE sql STABLE SECURITY DEFINER;

      CREATE OR REPLACE FUNCTION public.global_leaderboard_enabled() RETURNS BOOLEAN AS $$
        SELECT COALESCE((SELECT value = 'true' FROM public.competition_settings WHERE key = 'global_leaderboard_enabled'), true);
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.period_bounds(p_period TEXT)
      RETURNS TABLE(d_from DATE, d_to DATE) AS $$
        SELECT public.today_ist() - 7, public.today_ist() + 1;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.competition_rules()
      RETURNS TABLE(weekly_test_multiplier NUMERIC, attendance_present_points NUMERIC, improved_min_entries INTEGER) AS $$
        SELECT 1.0::NUMERIC, 10.0::NUMERIC, 3::INTEGER;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.display_name_for(p_full_name TEXT, p_student_code TEXT)
      RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(p_full_name, ''), p_student_code, 'Student');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.practice_days_for(p_student UUID, p_from DATE, p_to DATE)
      RETURNS NUMERIC AS $$
        SELECT 5::NUMERIC;
      $$ LANGUAGE sql STABLE;
    `);

    // 4. Seed baseline users and categories
    await db.exec(`
      INSERT INTO public.profiles (id, role, level, full_name, student_code, active, leaderboard_visible)
      VALUES
        ('${adminId}', 'admin', 'Grandmaster', 'System Admin', 'ADM-001', true, true),
        ('${student1Id}', 'student', 'Level 1', 'Student Alpha', 'STU-001', true, true),
        ('${student2Id}', 'student', 'Level 1', 'Student Beta', 'STU-002', true, true),
        ('${student3Id}', 'student', 'Level 2', 'Student Gamma', 'STU-003', true, false), -- hidden
        ('${teacher1Id}', 'teacher', 'Grandmaster', 'Teacher One', 'TCH-001', true, true),
        ('${teacher2Id}', 'teacher', 'Grandmaster', 'Teacher Two', 'TCH-002', true, true);

      INSERT INTO public.teacher_permissions (teacher_id, permission)
      VALUES
        ('${teacher1Id}', 'manage_tests'),
        ('${teacher1Id}', 'view_students'),
        ('${teacher1Id}', 'manage_tasks');

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id)
      VALUES
        ('${teacher1Id}', '${student1Id}');

      INSERT INTO public.categories (id, name, section, sort_order, active)
      VALUES
        ('${catBasicsId}', '1d10r', 'basics', 1, true),
        ('${catRoundId}', 'ADD', 'round', 1, true);

      INSERT INTO public.competition_settings (key, value)
      VALUES
        ('global_leaderboard_enabled', 'true'),
        ('todo_streak_start', '2026-01-01');

      INSERT INTO public.rollout_boundaries (feature, status, activated_at)
      VALUES ('phase19_authoritative_todo', 'installed', NULL);
    `);

    // 5. Apply the owner follow-up upgrade script
    const upgradeSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase19_followup_fixes.sql'), 'utf8');
    await db.exec(upgradeSql);
  });

  const setCaller = async (uid, role = 'authenticated') => {
    await db.exec(`
      SET app.current_user_id = '${uid || ''}';
      SET app.current_jwt_role = '${role}';
    `);
  };

  describe('1. Student Leaderboard Authorization Failure & Trusted Internal Calculation', () => {
    let task1Id;
    let task2Id;

    beforeEach(async () => {
      await db.exec(`DELETE FROM public.daily_tasks; DELETE FROM public.results; DELETE FROM public.activity_results;`);

      // Seed daily tasks for Level 1: Basics and Flash
      const taskRes = await db.query(`
        INSERT INTO public.daily_tasks (title, section, category_id, level, required_count, active, target_scope)
        VALUES
          ('Basics Task', 'basics', '${catBasicsId}', 'Level 1', 1, true, 'all'),
          ('Flash Task', 'flash', NULL, 'Level 1', 1, true, 'all')
        RETURNING id;
      `);
      task1Id = taskRes.rows[0].id;
      task2Id = taskRes.rows[1].id;

      // Seed student results so Student 1 and Student 2 have practice
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date, source)
        VALUES
          ('${student1Id}', '${catBasicsId}', 10, 10, 60, public.today_ist(), 'practice'),
          ('${student2Id}', '${catBasicsId}', 8, 10, 60, public.today_ist(), 'practice');

        INSERT INTO public.activity_results (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
        VALUES
          ('${student1Id}', 'flash_anzan', 'Flash anzan', 1, 1, 5, '{"mode": "add"}'::jsonb),
          ('${student2Id}', 'flash_anzan', 'Flash anzan', 1, 1, 5, '{"mode": "add"}'::jsonb);
      `);
    });

    it('1.1. Direct task detail access: Student A calling todo_status_on(Student B) is strictly rejected with 42501', async () => {
      // Student 1 viewing own tasks: SUCCEEDS
      await setCaller(student1Id);
      const ownTasks = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}')`);
      assert.equal(ownTasks.rows.length, 2);

      // Student 1 viewing Student 2's tasks: FAILS WITH 42501
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.todo_status_on('${student2Id}')`);
        },
        (err) => {
          assert.match(err.message, /Forbidden: You may only view your own daily tasks/);
          return true;
        }
      );

      // Student 1 calling todo_for(Student 2): FAILS WITH 42501
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.todo_for('${student2Id}')`);
        },
        (err) => {
          assert.match(err.message, /Forbidden: You may only view your own daily tasks/);
          return true;
        }
      );
    });

    it('1.2. Direct task detail access: Unassigned teachers & anonymous callers are strictly blocked', async () => {
      // Unassigned Teacher 2 attempting to view Student 1's tasks: FAILS WITH 42501
      await setCaller(teacher2Id);
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.todo_status_on('${student1Id}')`);
        },
        (err) => {
          assert.match(err.message, /Forbidden: You do not have permission to view daily tasks for this student/);
          return true;
        }
      );

      // Assigned Teacher 1 viewing assigned Student 1's tasks: SUCCEEDS
      await setCaller(teacher1Id);
      const teacherRes = await db.query(`SELECT * FROM public.todo_status_on('${student1Id}')`);
      assert.equal(teacherRes.rows.length, 2);

      // Anonymous caller (null uid, role anon): FAILS WITH 42501
      await setCaller(null, 'anon');
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.todo_status_on('${student1Id}')`);
        },
        (err) => {
          assert.match(err.message, /Unauthorized: Authentication required/);
          return true;
        }
      );
    });

    it('1.3. Student caller loads streak and todo leaderboards cleanly without 42501 error', async () => {
      // Set caller to regular Student 1
      await setCaller(student1Id);

      // Test all 5 boards as student caller in 'level' scope:
      // 1. points
      const pointsBoard = await db.query(`SELECT * FROM public.leaderboard('points', 'week', NULL, 10, 'level')`);
      assert.ok(Array.isArray(pointsBoard.rows));

      // 2. streak — THIS FORMERLY FAILED WITH 42501 BEFORE OUR FIX!
      const streakBoard = await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'level')`);
      assert.ok(Array.isArray(streakBoard.rows));
      assert.ok(streakBoard.rows.length > 0, 'Streak leaderboard should return eligible students');

      // 3. practice_days
      const practiceBoard = await db.query(`SELECT * FROM public.leaderboard('practice_days', 'week', NULL, 10, 'level')`);
      assert.ok(Array.isArray(practiceBoard.rows));

      // 4. improved
      const improvedBoard = await db.query(`SELECT * FROM public.leaderboard('improved', 'week', NULL, 10, 'level')`);
      assert.ok(Array.isArray(improvedBoard.rows));

      // 5. todo — THIS FORMERLY FAILED WITH 42501 BEFORE OUR FIX!
      const todoBoard = await db.query(`SELECT * FROM public.leaderboard('todo', 'week', NULL, 10, 'level')`);
      assert.ok(Array.isArray(todoBoard.rows));
      assert.ok(todoBoard.rows.length > 0, 'Todo leaderboard should return eligible students');
    });

    it('1.4. Leaderboard privacy & filtering: masks student IDs for students, reveals for admin, excludes hidden/inactive', async () => {
      // Student caller
      await setCaller(student1Id);
      const studentStreak = await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'level')`);
      for (const row of studentStreak.rows) {
        // Other students' student_id MUST be null (masked)
        assert.equal(row.student_id, null, 'Student caller should not receive student_id of competitors');
      }

      // Admin caller
      await setCaller(adminId);
      const adminStreak = await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'level')`);
      const returnedIds = adminStreak.rows.map(r => r.student_id).filter(Boolean);
      assert.ok(returnedIds.length > 0, 'Admin caller should receive actual student IDs');

      // Student 3 has leaderboard_visible = false: MUST NOT appear on leaderboard
      assert.ok(!returnedIds.includes(student3Id), 'Hidden student should be excluded from leaderboard');

      // Inactive student MUST NOT appear
      await db.exec(`UPDATE public.profiles SET active = false WHERE id = '${student2Id}'`);
      const filteredStreak = await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'level')`);
      const filteredIds = filteredStreak.rows.map(r => r.student_id).filter(Boolean);
      assert.ok(!filteredIds.includes(student2Id), 'Inactive student should be excluded');
      await db.exec(`UPDATE public.profiles SET active = true WHERE id = '${student2Id}'`);
    });

    it('1.5. Leaderboard global scope respect & switch-off exception', async () => {
      await setCaller(student1Id);

      // Global scope with global leaderboard enabled: SUCCEEDS
      const globalBoard = await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'global')`);
      assert.ok(Array.isArray(globalBoard.rows));

      // Switch off global leaderboard
      await db.exec(`UPDATE public.competition_settings SET value = 'false' WHERE key = 'global_leaderboard_enabled'`);

      // Student attempting global scope: throws expected error
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM public.leaderboard('streak', 'week', NULL, 10, 'global')`);
        },
        (err) => {
          assert.match(err.message, /The global leaderboard is switched off/);
          return true;
        }
      );

      // Restore setting
      await db.exec(`UPDATE public.competition_settings SET value = 'true' WHERE key = 'global_leaderboard_enabled'`);
    });

    it('1.6. Internal helper execution is blocked from direct unauthorized execution', async () => {
      // Authenticated student cannot call _todo_status_on_internal directly if grants are revoked
      // In PostgreSQL, execute permission check:
      await db.exec(`RESET ROLE;`);
      const permCheck = await db.query(`
        SELECT has_function_privilege('anon', 'public._todo_status_on_internal(uuid, date)', 'execute') AS anon_can,
               has_function_privilege('authenticated', 'public._todo_status_on_internal(uuid, date)', 'execute') AS auth_can,
               has_function_privilege('service_role', 'public._todo_status_on_internal(uuid, date)', 'execute') AS service_can;
      `);
      assert.equal(permCheck.rows[0].anon_can, false, 'anon must not have execute on _todo_status_on_internal');
      assert.equal(permCheck.rows[0].auth_can, false, 'authenticated must not have execute on _todo_status_on_internal');
      assert.equal(permCheck.rows[0].service_can, true, 'service_role must have execute on _todo_status_on_internal');
    });

    it('1.7. Installed vs Active Phase 19 credit policy reflects in streaks and to-do', async () => {
      // Part A: Installed (unactivated)
      await db.exec(`UPDATE public.rollout_boundaries SET status = 'installed', activated_at = NULL WHERE feature = 'phase19_authoritative_todo'`);

      // Unlinked online result in unactivated state earns credit
      const unlinkedRes = await db.query(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date, source)
        VALUES ('${student1Id}', '${catBasicsId}', 5, 5, 20, public.today_ist(), 'online')
        RETURNING id;
      `);

      let todoDone = await db.query(`SELECT public.todo_all_done_on('${student1Id}', public.today_ist()) AS done`);
      assert.equal(todoDone.rows[0].done, true, 'In unactivated state, online practice earns credit');

      // Part B: Active Phase 19 policy
      const activationTimestamp = new Date(Date.now() - 60000).toISOString();
      await db.exec(`UPDATE public.rollout_boundaries SET status = 'active', activated_at = '${activationTimestamp}'::TIMESTAMPTZ WHERE feature = 'phase19_authoritative_todo'`);

      // New online submission without drill_sessions todo_credit earns 0 credit
      await db.exec(`DELETE FROM public.results WHERE id = '${unlinkedRes.rows[0].id}'`);
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, time_seconds, entry_date, source, created_at)
        VALUES ('${student1Id}', '${catBasicsId}', 5, 5, 20, public.today_ist(), 'online', now())
      `);

      todoDone = await db.query(`SELECT public.todo_all_done_on('${student1Id}', public.today_ist()) AS done`);
      assert.equal(todoDone.rows[0].done, false, 'In active Phase 19 state, unlinked online session does NOT earn task credit');
    });
  });

  describe('2. Weekly-Test Section Creation & wt_sections_shape_check Compliance', () => {
    beforeEach(async () => {
      await db.exec(`DELETE FROM public.weekly_test_sections; DELETE FROM public.weekly_test_recipients; DELETE FROM public.weekly_tests;`);
    });

    it('2.1. Elements section creation: normalizes flash fields to NULL and complies with wt_sections_shape_check', async () => {
      await setCaller(adminId);

      const testPayload = {
        title: 'Weekly Test with Elements',
        test_date: '2026-11-15',
        test_type: 'online'
      };

      const sectionsPayload = [
        {
          kind: 'elements',
          activity_key: 'elements_square_stage_1',
          // Client or old code might send flash or category fields
          flash_digits: 1,
          flash_count: 20,
          flash_speed_ms: 800,
          flash_mode: 'add',
          question_count: 5,
          category_id: catBasicsId,
          seconds: 60
        }
      ];

      // Call save_weekly_test_sections_atomic — FORMERLY FAILED WITH 23514 wt_sections_shape_check!
      const saveRes = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(testPayload), JSON.stringify(sectionsPayload)]);

      assert.equal(saveRes.rows[0].res.ok, true);
      const testId = saveRes.rows[0].res.test_id;

      // Inspect persisted section row: unrelated columns MUST BE NULL
      const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = '${testId}'`);
      assert.equal(secRows.rows.length, 1);
      const sec = secRows.rows[0];
      assert.equal(sec.kind, 'elements');
      assert.equal(sec.activity_key, 'elements_square_stage_1');
      assert.equal(sec.category_id, null, 'category_id must be null for elements');
      assert.equal(sec.seconds, null, 'seconds must be null for elements');
      assert.equal(sec.flash_digits, null, 'flash_digits must be null for elements');
      assert.equal(sec.flash_count, null, 'flash_count must be null for elements');
      assert.equal(sec.flash_speed_ms, null, 'flash_speed_ms must be null for elements');
      assert.equal(sec.flash_mode, null, 'flash_mode must be null for elements');
      assert.equal(sec.question_count, null, 'question_count must be null for elements');
    });

    it('2.2. Memoriad section creation: activity_key populated, unrelated fields null', async () => {
      await setCaller(adminId);

      const testPayload = {
        title: 'Weekly Test with Memoriad',
        test_date: '2026-11-15',
        test_type: 'online'
      };

      const sectionsPayload = [
        {
          kind: 'memoriad',
          activity_key: 'calendar'
        }
      ];

      const saveRes = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(testPayload), JSON.stringify(sectionsPayload)]);

      assert.equal(saveRes.rows[0].res.ok, true);
      const testId = saveRes.rows[0].res.test_id;

      const secRows = await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = '${testId}'`);
      const sec = secRows.rows[0];
      assert.equal(sec.kind, 'memoriad');
      assert.equal(sec.activity_key, 'calendar');
      assert.equal(sec.category_id, null);
      assert.equal(sec.seconds, null);
      assert.equal(sec.flash_digits, null);
      assert.equal(sec.flash_count, null);
      assert.equal(sec.flash_speed_ms, null);
      assert.equal(sec.flash_mode, null);
      assert.equal(sec.question_count, null);
    });

    it('2.3. Basics and Round section creation: category fields populated, unrelated fields null', async () => {
      await setCaller(adminId);

      // Online test with Basics section
      const onlineBasicsPayload = {
        title: 'Online Basics Test',
        test_date: '2026-11-15',
        test_type: 'online'
      };
      const onlineBasicsSections = [
        {
          kind: 'basics',
          category_id: catBasicsId,
          seconds: 60,
          activity_key: 'unrelated_key' // should be stripped
        }
      ];

      const resOnline = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(onlineBasicsPayload), JSON.stringify(onlineBasicsSections)]);
      assert.equal(resOnline.rows[0].res.ok, true);
      const onlineTestId = resOnline.rows[0].res.test_id;

      const basicsSec = (await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = '${onlineTestId}'`)).rows[0];
      assert.equal(basicsSec.kind, 'basics');
      assert.equal(basicsSec.category_id, catBasicsId);
      assert.equal(basicsSec.seconds, 60);
      assert.equal(basicsSec.activity_key, null, 'activity_key must be null for basics');
      assert.equal(basicsSec.flash_digits, null);

      // Offline test with Round section
      const offlineRoundPayload = {
        title: 'Offline Round Test',
        test_date: '2026-11-15',
        test_type: 'offline'
      };
      const offlineRoundSections = [
        {
          kind: 'round',
          category_id: catRoundId,
          seconds: 60 // round should null seconds
        }
      ];

      const resOffline = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(offlineRoundPayload), JSON.stringify(offlineRoundSections)]);
      assert.equal(resOffline.rows[0].res.ok, true);
      const roundSec = (await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = '${resOffline.rows[0].res.test_id}'`)).rows[0];
      assert.equal(roundSec.kind, 'round');
      assert.equal(roundSec.category_id, catRoundId);
      assert.equal(roundSec.seconds, null, 'seconds must be null for round');
      assert.equal(roundSec.activity_key, null);
      assert.equal(roundSec.flash_digits, null);
    });

    it('2.4. Flash section creation: validates Flash bounds and nulls category/seconds/activity_key', async () => {
      await setCaller(adminId);

      const testPayload = {
        title: 'Flash Test',
        test_date: '2026-11-15',
        test_type: 'online'
      };

      const validFlash = [
        {
          kind: 'flash',
          flash_digits: 3,
          flash_count: 15,
          flash_speed_ms: 600,
          flash_mode: 'add_sub',
          question_count: 5,
          activity_key: 'foo', // should be nulled
          category_id: catBasicsId // should be nulled
        }
      ];

      const res = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(testPayload), JSON.stringify(validFlash)]);
      assert.equal(res.rows[0].res.ok, true);
      const flashSec = (await db.query(`SELECT * FROM public.weekly_test_sections WHERE test_id = '${res.rows[0].res.test_id}'`)).rows[0];
      assert.equal(flashSec.kind, 'flash');
      assert.equal(flashSec.flash_digits, 3);
      assert.equal(flashSec.flash_count, 15);
      assert.equal(flashSec.flash_speed_ms, 600);
      assert.equal(flashSec.flash_mode, 'add_sub');
      assert.equal(flashSec.question_count, 5);
      assert.equal(flashSec.category_id, null);
      assert.equal(flashSec.seconds, null);
      assert.equal(flashSec.activity_key, null);

      // Rejects invalid speed (< 200)
      const invalidSpeed = [{ kind: 'flash', flash_digits: 2, flash_count: 10, flash_speed_ms: 100, flash_mode: 'add', question_count: 5 }];
      await assert.rejects(
        async () => {
          await db.query(`SELECT public.save_weekly_test_sections_atomic(NULL, $1::jsonb, $2::jsonb, NULL)`,
            [JSON.stringify(testPayload), JSON.stringify(invalidSpeed)]);
        },
        (err) => {
          assert.match(err.message, /Flash speed must be between 200 and 5000/);
          return true;
        }
      );
    });

    it('2.5. Mixed test with all 4 section kinds saves atomically and reorders safely', async () => {
      await setCaller(adminId);

      const mixedPayload = {
        title: 'Championship All-Round Test',
        test_date: '2026-11-20',
        test_type: 'online'
      };

      const mixedSections = [
        { kind: 'basics', category_id: catBasicsId, seconds: 60 },
        { kind: 'elements', activity_key: 'day_codes' },
        { kind: 'flash', flash_digits: 2, flash_count: 10, flash_speed_ms: 1000, flash_mode: 'add', question_count: 5 },
        { kind: 'memoriad', activity_key: 'calendar' }
      ];

      const saveRes = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(mixedPayload), JSON.stringify(mixedSections)]);
      assert.equal(saveRes.rows[0].res.ok, true);
      const testId = saveRes.rows[0].res.test_id;

      // Verify 4 sections saved with positions 1, 2, 3, 4
      const savedSections = (await db.query(`SELECT id, position, kind FROM public.weekly_test_sections WHERE test_id = '${testId}' ORDER BY position ASC`)).rows;
      assert.equal(savedSections.length, 4);
      assert.equal(savedSections[0].kind, 'basics');
      assert.equal(savedSections[1].kind, 'elements');
      assert.equal(savedSections[2].kind, 'flash');
      assert.equal(savedSections[3].kind, 'memoriad');

      // Reorder: swap positions 1 and 2
      const reorderedPayload = [
        { id: savedSections[1].id, kind: 'elements', activity_key: 'day_codes' },
        { id: savedSections[0].id, kind: 'basics', category_id: catBasicsId, seconds: 60 },
        { id: savedSections[2].id, kind: 'flash', flash_digits: 2, flash_count: 10, flash_speed_ms: 1000, flash_mode: 'add', question_count: 5 },
        { id: savedSections[3].id, kind: 'memoriad', activity_key: 'calendar' }
      ];

      const reorderRes = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          '${testId}',
          $1::jsonb,
          $2::jsonb,
          NULL
        ) AS res
      `, [JSON.stringify(mixedPayload), JSON.stringify(reorderedPayload)]);
      assert.equal(reorderRes.rows[0].res.ok, true);

      const afterReorder = (await db.query(`SELECT id, position, kind FROM public.weekly_test_sections WHERE test_id = '${testId}' ORDER BY position ASC`)).rows;
      assert.equal(afterReorder[0].id, savedSections[1].id);
      assert.equal(afterReorder[0].position, 1);
      assert.equal(afterReorder[1].id, savedSections[0].id);
      assert.equal(afterReorder[1].position, 2);
    });

    it('2.6. Enforces teacher targeting: teacher can assign to assigned student, blocked for unassigned', async () => {
      // Teacher 1 is assigned to Student 1 only
      await setCaller(teacher1Id);

      const teacherTest = {
        title: 'Teacher Test',
        test_date: '2026-11-20',
        test_type: 'online'
      };
      const sections = [{ kind: 'elements', activity_key: 'day_codes' }];

      // Valid: assigned to Student 1
      const validRes = await db.query(`
        SELECT public.save_weekly_test_sections_atomic(
          NULL,
          $1::jsonb,
          $2::jsonb,
          ARRAY['${student1Id}']::UUID[]
        ) AS res
      `, [JSON.stringify(teacherTest), JSON.stringify(sections)]);
      assert.equal(validRes.rows[0].res.ok, true);

      // Blocked: assigning to unassigned Student 2
      await assert.rejects(
        async () => {
          await db.query(`
            SELECT public.save_weekly_test_sections_atomic(
              NULL,
              $1::jsonb,
              $2::jsonb,
              ARRAY['${student2Id}']::UUID[]
            ) AS res
          `, [JSON.stringify(teacherTest), JSON.stringify(sections)]);
        },
        (err) => {
          assert.match(err.message, /Teachers may only assign weekly tests to their assigned students/);
          return true;
        }
      );
    });
  });

  describe('3. Migration Idempotency & Staging Isolation Latch', () => {
    it('3.1. owner_phase19_followup_fixes.sql is strictly idempotent on repeated executions', async () => {
      await db.exec(`RESET ROLE;`);
      const upgradeSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase19_followup_fixes.sql'), 'utf8');

      // Second execution: must succeed cleanly without errors or dropping constraints
      await db.exec(upgradeSql);

      // Third execution:
      await db.exec(upgradeSql);
    });

    it('3.2. staging_phase19_followup_fixes.sql enforces operator latch and trips on live Mumbai student data', async () => {
      const stagingSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_phase19_followup_fixes.sql'), 'utf8');

      // Test 3.2a: trips on live Mumbai production student data (STU101 / Riya)
      await db.exec(`
        INSERT INTO public.profiles (id, role, student_code, full_name, active)
        VALUES ('99999999-9999-9999-9999-999999999999', 'student', 'STU101', 'Riya Sharma', true)
        ON CONFLICT (id) DO UPDATE SET student_code = 'STU101', full_name = 'Riya Sharma';
      `);

      await assert.rejects(
        async () => {
          await db.exec(stagingSql);
        },
        (err) => {
          assert.match(err.message, /SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected/);
          return true;
        }
      );

      // Rollback aborted transaction and cleanup production tripwire row
      await db.exec('ROLLBACK;');
      await db.exec(`DELETE FROM public.profiles WHERE id = '99999999-9999-9999-9999-999999999999';`);

      // Test 3.2b: runs cleanly on staging baseline once tripwire is absent
      await db.exec(stagingSql);
    });
  });
});
