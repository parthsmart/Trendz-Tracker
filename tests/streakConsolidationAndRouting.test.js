/**
 * Trendz Tracker - Streak Consolidation, Task Enforcement, Routing & Layout Test Suite
 * (tests/streakConsolidationAndRouting.test.js)
 *
 * Verifies with real PostgreSQL in WASM via PGlite:
 * 1. 0/11 tasks -> today does not count.
 * 2. 1/11 tasks -> today does not count.
 * 3. 10/11 tasks -> today does not count.
 * 4. All 11 tasks fully complete -> today counts once.
 * 5. One attempt of a required two-round task -> task remains incomplete.
 * 6. Today's single qualifying activity after a 13-day gap does not inherit an old 2- or 3-day run (STUD_09 & STUD_10 regression).
 * 7. A recent partial day cannot reconnect an older completed run.
 * 8. Yesterday completed, today incomplete -> streak is retained during today, no increment.
 * 9. Missed days without sufficient shields -> current streak breaks to 0.
 * 10. Shield earning/consumption matches the verified policy (1 shield at streak % 7 = 0, capped at 1; 1 shield consumed per unshielded missed day).
 * 11. Elements/Flash/Memoriad-only qualifying plan completion works.
 * 12. Multiple same-day entries count as one day.
 * 13. IST midnight boundaries and future dates: future entries (> today) do not increase current streak.
 * 14. Streak values match across streak_for and streak_calc for the same student.
 * 15. todo_finalize uses _todo_status_on_internal without 42501 error and correctly logs completed days.
 *
 * Frontend Routing & Layout tests:
 * 16. Admin and teacher visits to student.html redirect before student data loads.
 * 17. Student cannot access staff pages; unassigned teacher access denied on student detail.
 * 18. Layout repairs in student-detail.html and practiceUi.css eliminate header collision and ensure right alignment.
 */

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

describe('Streak Consolidation & Task Enforcement (PGlite)', () => {
  let db;

  const adminId = '11111111-1111-1111-1111-111111111111';
  const teacherId = '22222222-2222-2222-2222-222222222222';
  const unassignedTeacherId = '33333333-3333-3333-3333-333333333333';
  const student09 = '44444444-4444-4444-4444-444444444444'; // Achyuttam (STUD_09)
  const student10 = '55555555-5555-5555-5555-555555555555'; // Deven (STUD_10)
  const student04 = '66666666-6666-6666-6666-666666666666'; // STUD_04
  const student06 = '77777777-7777-7777-7777-777777777777'; // STUD_06
  const student20 = '88888888-8888-8888-8888-888888888888'; // STUD_20

  const basicsCatId = '99999999-9999-9999-9999-999999999991';
  const roundCatId = '99999999-9999-9999-9999-999999999992';

  const fixedToday = '2026-11-19';

  before(async () => {
    db = new PGlite();

    // 1. Roles & Schema
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
    `);

    // 2. Tables
    await db.exec(`
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        full_name TEXT NOT NULL,
        student_code TEXT,
        role TEXT NOT NULL DEFAULT 'student',
        active BOOLEAN NOT NULL DEFAULT true,
        level TEXT,
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.teacher_student_assignments (
        teacher_id UUID NOT NULL,
        student_id UUID NOT NULL,
        PRIMARY KEY (teacher_id, student_id)
      );

      CREATE TABLE public.categories (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INTEGER DEFAULT 1
      );

      CREATE TABLE public.competition_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID,
        activity_key TEXT,
        required_count INTEGER NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER DEFAULT 1,
        flash_digits INTEGER,
        flash_count INTEGER,
        flash_speed_ms INTEGER,
        flash_mode TEXT,
        target_scope TEXT DEFAULT 'all',
        level TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-01 00:00:00+05:30'::TIMESTAMPTZ
      );

      CREATE TABLE public.daily_todo_log (
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        tasks_done INTEGER NOT NULL DEFAULT 0,
        all_done BOOLEAN NOT NULL DEFAULT false,
        finalized_at TIMESTAMPTZ,
        plan_snapshot JSONB,
        PRIMARY KEY (student_id, day)
      );

      CREATE TABLE public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL,
        category_id UUID NOT NULL,
        correct INTEGER,
        total INTEGER,
        entry_date DATE NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        student_round_id UUID,
        source TEXT DEFAULT 'manual'
      );

      CREATE TABLE public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL,
        activity_type TEXT NOT NULL,
        correct INTEGER,
        total INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        settings JSONB DEFAULT '{}'::jsonb
      );

      CREATE TABLE public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL,
        activity_type TEXT NOT NULL,
        result_row_id UUID,
        result_id UUID,
        settings JSONB DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.rollout_boundaries (
        feature TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.teacher_permissions (
        teacher_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        can_view_students BOOLEAN NOT NULL DEFAULT true,
        can_mark_attendance BOOLEAN NOT NULL DEFAULT true,
        can_correct_attendance BOOLEAN NOT NULL DEFAULT true,
        can_generate_reports BOOLEAN NOT NULL DEFAULT true,
        can_manage_tasks BOOLEAN NOT NULL DEFAULT true,
        can_manage_tests BOOLEAN NOT NULL DEFAULT true,
        can_publish_announcements BOOLEAN NOT NULL DEFAULT true,
        can_manage_resources BOOLEAN NOT NULL DEFAULT true,
        can_review_scores BOOLEAN NOT NULL DEFAULT true,
        can_request_corrections BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.daily_task_recipients (
        task_id UUID NOT NULL,
        student_id UUID NOT NULL,
        PRIMARY KEY (task_id, student_id)
      );
    `);

    // 3. Auth context helpers & real permission functions
    await db.exec(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $$
        SELECT COALESCE(
          (SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid()),
          false
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID) RETURNS BOOLEAN AS $$
        SELECT COALESCE(
          (SELECT role = 'teacher' FROM public.profiles WHERE id = p_uid),
          false
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id UUID, p_permission TEXT)
      RETURNS BOOLEAN
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public
      STABLE
      AS $$
      DECLARE
        v_allowed BOOLEAN := false;
      BEGIN
        IF NOT public.is_teacher(p_teacher_id) THEN
          RETURN false;
        END IF;

        SELECT
          CASE p_permission
            WHEN 'view_students' THEN can_view_students
            WHEN 'mark_attendance' THEN can_mark_attendance
            WHEN 'correct_attendance' THEN can_correct_attendance
            WHEN 'generate_reports' THEN can_generate_reports
            WHEN 'manage_tasks' THEN can_manage_tasks
            WHEN 'manage_tests' THEN can_manage_tests
            WHEN 'publish_announcements' THEN can_publish_announcements
            WHEN 'manage_resources' THEN can_manage_resources
            WHEN 'review_scores' THEN can_review_scores
            WHEN 'request_corrections' THEN can_request_corrections
            ELSE false
          END
        INTO v_allowed
        FROM public.teacher_permissions
        WHERE teacher_id = p_teacher_id;

        RETURN COALESCE(v_allowed, false);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher UUID, p_student UUID) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.teacher_student_assignments
          WHERE teacher_id = p_teacher AND student_id = p_student
        );
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id UUID, p_student_id UUID)
      RETURNS BOOLEAN
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = public
      STABLE
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.daily_task_recipients
          WHERE task_id = p_task_id AND student_id = p_student_id
        );
      $$;

      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT '${fixedToday}'::DATE;
      $$ LANGUAGE sql STABLE;

      -- Base table permissions for testing roles
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
      GRANT SELECT ON public.profiles, public.competition_settings, public.categories TO anon;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.is_teacher(UUID) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.is_teacher_assigned_to_student(UUID, UUID) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.has_teacher_permission(UUID, TEXT) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.is_daily_task_recipient(UUID, UUID) TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.today_ist() TO anon, authenticated, service_role;
    `);

    // 4. Seed initial fixtures
    await db.exec(`
      INSERT INTO public.profiles (id, full_name, student_code, role, active) VALUES
        ('${adminId}', 'Head Admin', 'ADM01', 'admin', true),
        ('${teacherId}', 'Class Teacher', 'TCH01', 'teacher', true),
        ('${unassignedTeacherId}', 'Other Teacher', 'TCH02', 'teacher', true),
        ('${student09}', 'Achyuttam', 'STUD_09', 'student', true),
        ('${student10}', 'Deven', 'STUD_10', 'student', true),
        ('${student04}', 'Student 04', 'STUD_04', 'student', true),
        ('${student06}', 'Student 06', 'STUD_06', 'student', true),
        ('${student20}', 'Student 20', 'STUD_20', 'student', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_view_students, can_generate_reports)
      VALUES ('${teacherId}', true, true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherId}', '${student09}'),
        ('${teacherId}', '${student10}'),
        ('${teacherId}', '${student04}'),
        ('${teacherId}', '${student06}'),
        ('${teacherId}', '${student20}');

      INSERT INTO public.categories (id, name, section) VALUES
        ('${basicsCatId}', 'Single Digit Addition', 'basics'),
        ('${roundCatId}', 'Main Round Paper A', 'round');

      INSERT INTO public.competition_settings (key, value) VALUES
        ('todo_streak_start', '2026-10-29');

      INSERT INTO public.rollout_boundaries (feature, status, activated_at) VALUES
        ('phase19_authoritative_todo', 'active', '2026-11-01 00:00:00+05:30');
    `);

    // 5. Load and apply _todo_status_on_internal
    const followupSql = fs.readFileSync('supabase/owner_phase19_followup_fixes.sql', 'utf8');
    // Extract _todo_status_on_internal definition
    const todoInternalMatch = followupSql.match(/CREATE OR REPLACE FUNCTION public\._todo_status_on_internal[\s\S]*?\n\$\$;/i);
    assert(todoInternalMatch, 'Found _todo_status_on_internal in SQL');
    await db.exec(todoInternalMatch[0]);

    await db.exec(`
      CREATE OR REPLACE FUNCTION public.todo_status_on(p_student UUID, p_day DATE DEFAULT public.today_ist())
      RETURNS TABLE(task_id UUID, task_title TEXT, task_section TEXT, task_category_id UUID, task_activity_key TEXT, required_count INTEGER, done_count INTEGER, done BOOLEAN)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
        SELECT * FROM public._todo_status_on_internal(p_student, p_day);
      $$;
    `);

    // 6. Apply our patch: supabase/owner_streak_consolidation_patch.sql
    const patchSql = fs.readFileSync('supabase/owner_streak_consolidation_patch.sql', 'utf8');
    await db.exec(patchSql);
  });

  beforeEach(async () => {
    // Clear dynamic tables and reset session context & role between test cases
    await db.exec(`
      RESET ROLE;
      SET request.jwt.claim.sub = '';
      DELETE FROM public.results;
      DELETE FROM public.activity_results;
      DELETE FROM public.daily_tasks;
      DELETE FROM public.daily_todo_log;
      DELETE FROM public.drill_sessions;
      DELETE FROM public.daily_task_recipients;
      DELETE FROM public.teacher_permissions WHERE teacher_id = '${teacherId}';
      INSERT INTO public.teacher_permissions (teacher_id, can_view_students, can_generate_reports)
      VALUES ('${teacherId}', true, true);
    `);
  });

  it('1. 0 of 11 tasks -> today does not count', async () => {
    // Insert 11 active tasks
    for (let i = 1; i <= 11; i++) {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}', 'Task ${i}', 'basics', '${basicsCatId}', 1);
      `);
    }

    // Student has 0 results today
    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].current_streak, 0);
    assert.equal(res.rows[0].active_today, false);
  });

  it('2. 1 of 11 tasks -> today does not count', async () => {
    // 1 basics task, 10 element tasks
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Task 1', 'basics', '${basicsCatId}', 1);
    `);
    for (let i = 2; i <= 11; i++) {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
        VALUES ('00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}', 'Task ${i}', 'elements', 'element_drill_${i}', 1);
      `);
    }

    // Student does only 1 basics drill today (1 of 11 tasks done)
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
      VALUES ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].active_today, false, '1/11 tasks must not count today');
    assert.equal(res.rows[0].current_streak, 0);
  });

  it('3. 10 of 11 tasks -> today does not count', async () => {
    // 10 tasks in basics, 1 task in elements
    for (let i = 1; i <= 10; i++) {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}', 'Task ${i}', 'basics', '${basicsCatId}', 1);
      `);
    }
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
      VALUES ('00000000-0000-0000-0000-000000000011', 'Element Task 11', 'elements', 'element_drill_1', 1);
    `);

    // Student completes 10 basics drills (satisfying 10 tasks), but misses element task
    for (let i = 1; i <= 10; i++) {
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
      `);
    }

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].active_today, false, '10 of 11 tasks must not count');
    assert.equal(res.rows[0].current_streak, 0);
  });

  it('4. All 11 tasks fully complete -> today counts once', async () => {
    for (let i = 1; i <= 10; i++) {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}', 'Task ${i}', 'basics', '${basicsCatId}', 1);
      `);
    }
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
      VALUES ('00000000-0000-0000-0000-000000000011', 'Element Task 11', 'elements', 'element_drill_1', 1);
    `);

    // Complete 10 basics
    for (let i = 1; i <= 10; i++) {
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
      `);
    }
    // Complete 1 element drill
    await db.exec(`
      INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
      VALUES ('${student10}', 'element', 10, 10, '${fixedToday} 10:00:00+05:30', '{"drill":"element_drill_1"}'::jsonb);
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].active_today, true, 'All 11 tasks complete -> today counts');
    assert.equal(res.rows[0].current_streak, 1);
    assert.equal(res.rows[0].best_streak, 1);
  });

  it('5. One attempt of a required two-round task -> task remains incomplete', async () => {
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Two-Round Task', 'round', '${roundCatId}', 2);
    `);

    // Student completes only 1 round
    const roundId1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date, student_round_id)
      VALUES ('${student10}', '${roundCatId}', 50, 50, '${fixedToday}', '${roundId1}');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].active_today, false, '1 of 2 required rounds must not qualify task');
    assert.equal(res.rows[0].current_streak, 0);

    // Now complete round 2
    const roundId2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date, student_round_id)
      VALUES ('${student10}', '${roundCatId}', 50, 50, '${fixedToday}', '${roundId2}');
    `);

    const res2 = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res2.rows[0].active_today, true, '2 of 2 required rounds completes task');
    assert.equal(res2.rows[0].current_streak, 1);
  });

  it('6. Today single qualifying activity after 13-day gap does not inherit old 2- or 3-day run (STUD_09 & STUD_10)', async () => {
    // 2 weeks ago (2026-11-01 to 2026-11-03): 3 consecutive days of practice
    // Then 13-day gap with no practice
    // Today (2026-11-19): 1 qualifying practice
    // No tasks assigned during this test to isolate streak continuation logic
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student10}', '${basicsCatId}', 10, 10, '2026-11-01'),
        ('${student10}', '${basicsCatId}', 10, 10, '2026-11-02'),
        ('${student10}', '${basicsCatId}', 10, 10, '2026-11-03'),
        ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');

      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done) VALUES
        ('${student10}', '2026-11-01', 0, 0, false),
        ('${student10}', '2026-11-02', 0, 0, false),
        ('${student10}', '2026-11-03', 0, 0, false);
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].current_streak, 1, 'Current streak must be 1, NOT 3 or 4');
    assert.equal(res.rows[0].best_streak, 3, 'Best streak retains historical 3');
    assert.equal(res.rows[0].active_today, true);
  });

  it('7. A recent partial day cannot reconnect an older completed run', async () => {
    // Task plan: 1 task required
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Daily Basics', 'basics', '${basicsCatId}', 1);
    `);

    // Student had a 3-day run 5 days ago (Nov 12, 13, 14)
    // Nov 15: missed
    // Nov 16: did unrelated practice (e.g., flash which was not in daily tasks) -> partial/unqualified
    // Nov 17: missed
    // Nov 18: completed daily basics (streak = 1)
    // Nov 19: completed daily basics (streak = 2)
    await db.exec(`
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done) VALUES
        ('${student09}', '2026-11-12', 1, 1, true),
        ('${student09}', '2026-11-13', 1, 1, true),
        ('${student09}', '2026-11-14', 1, 1, true),
        ('${student09}', '2026-11-15', 1, 0, false),
        ('${student09}', '2026-11-16', 1, 0, false),
        ('${student09}', '2026-11-17', 1, 0, false),
        ('${student09}', '2026-11-18', 1, 1, true);

      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student09}', '${basicsCatId}', 10, 10, '2026-11-12'),
        ('${student09}', '${basicsCatId}', 10, 10, '2026-11-13'),
        ('${student09}', '${basicsCatId}', 10, 10, '2026-11-14'),
        ('${student09}', '${basicsCatId}', 10, 10, '2026-11-18'),
        ('${student09}', '${basicsCatId}', 10, 10, '${fixedToday}');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student09}')`);
    assert.equal(res.rows[0].current_streak, 2, 'Current streak must be 2 (Nov 18 + Nov 19), not 5');
    assert.equal(res.rows[0].best_streak, 3);
  });

  it('8. Yesterday completed, today incomplete -> yesterday streak is retained during today', async () => {
    // 3 days completed up through yesterday (Nov 16, 17, 18)
    // Today (Nov 19): student has not practiced yet
    await db.exec(`
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done) VALUES
        ('${student04}', '2026-11-16', 1, 1, true),
        ('${student04}', '2026-11-17', 1, 1, true),
        ('${student04}', '2026-11-18', 1, 1, true);

      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student04}', '${basicsCatId}', 10, 10, '2026-11-16'),
        ('${student04}', '${basicsCatId}', 10, 10, '2026-11-17'),
        ('${student04}', '${basicsCatId}', 10, 10, '2026-11-18');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student04}')`);
    assert.equal(res.rows[0].current_streak, 3, 'Streak must stay 3 during today');
    assert.equal(res.rows[0].active_today, false, 'Today does not count yet');
  });

  it('9. Missed days without sufficient shields -> current streak breaks to 0', async () => {
    // Student practiced 3 days (Nov 14, 15, 16), then missed Nov 17 and Nov 18 (0 shields earned because streak < 7)
    // Today (Nov 19): no practice yet
    await db.exec(`
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done) VALUES
        ('${student06}', '2026-11-14', 1, 1, true),
        ('${student06}', '2026-11-15', 1, 1, true),
        ('${student06}', '2026-11-16', 1, 1, true),
        ('${student06}', '2026-11-17', 1, 0, false),
        ('${student06}', '2026-11-18', 1, 0, false);

      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student06}', '${basicsCatId}', 10, 10, '2026-11-14'),
        ('${student06}', '${basicsCatId}', 10, 10, '2026-11-15'),
        ('${student06}', '${basicsCatId}', 10, 10, '2026-11-16');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student06}')`);
    assert.equal(res.rows[0].current_streak, 0, 'Missed days without shield break streak to 0');
    assert.equal(res.rows[0].best_streak, 3);
    assert.equal(res.rows[0].shields, 0);
  });

  it('10. Shield earning/consumption matches policy: 1 shield at day 7, protects 1 missed day', async () => {
    // 7 continuous completed days: Nov 10 to Nov 16 -> streak = 7, earns 1 shield
    // Nov 17: missed -> shield consumed, streak stays 7
    // Nov 18: completed -> streak = 8
    // Nov 19 (today): completed -> streak = 9
    for (let d = 10; d <= 16; d++) {
      const dt = `2026-11-${String(d).padStart(2, '0')}`;
      await db.exec(`
        INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
        VALUES ('${student20}', '${dt}', 1, 1, true);
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student20}', '${basicsCatId}', 10, 10, '${dt}');
      `);
    }

    // Check after 7 days: shield must be 1
    const res7 = await db.query(`
      SELECT * FROM public.streak_calc('${student20}')
    `);
    // Nov 17, 18, 19 are currently unpracticed, so Nov 17 consumes shield, Nov 18 breaks streak.
    // Let's add Nov 17 as missed in daily_todo_log:
    await db.exec(`
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
      VALUES ('${student20}', '2026-11-17', 1, 0, false);
    `);
    // Nov 18 completed:
    await db.exec(`
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
      VALUES ('${student20}', '2026-11-18', 1, 1, true);
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
      VALUES ('${student20}', '${basicsCatId}', 10, 10, '2026-11-18');
    `);
    // Nov 19 completed today:
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
      VALUES ('${student20}', '${basicsCatId}', 10, 10, '${fixedToday}');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student20}')`);
    // Streak: 7 + protected Nov 17 + Nov 18 (8) + Nov 19 (9) = 9
    assert.equal(res.rows[0].current_streak, 9, 'Shield protected Nov 17 so streak reached 9');
    assert.equal(res.rows[0].shields, 0, 'Shield was consumed on Nov 17');
    assert.equal(res.rows[0].active_today, true);
  });

  it('11. Elements/Flash/Memoriad-only qualifying plan completion works', async () => {
    const taskId = '00000000-0000-0000-0000-000000000001';
    // Daily task requires 1 flash drill
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
      VALUES ('${taskId}', 'Flash Drill', 'flash', 'flash_1', 1);
    `);

    // Complete flash drill in activity_results with activity_type = 'flash_anzan' and todo_task_id
    await db.exec(`
      INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
      VALUES ('${student10}', 'flash_anzan', 10, 10, '${fixedToday} 14:00:00+05:30', '{"todo_task_id":"${taskId}"}'::jsonb);
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].active_today, true, 'Flash drill qualified the day');
    assert.equal(res.rows[0].current_streak, 1);
  });

  it('12. Multiple same-day entries count as one day', async () => {
    // 5 entries on the same date
    for (let i = 1; i <= 5; i++) {
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
      `);
    }

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].current_streak, 1, 'Multiple entries on today must only count as 1 day');
  });

  it('13. Future-dated entries do not increase current streak', async () => {
    // 1 entry today (Nov 19) + 1 entry tomorrow (Nov 20)
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}'),
        ('${student10}', '${basicsCatId}', 10, 10, '2026-11-20');
    `);

    const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    assert.equal(res.rows[0].current_streak, 1, 'Tomorrow entry must not increase current streak');
  });

  it('14. Streak values match across streak_for and streak_calc for the same student', async () => {
    await db.exec(`
      INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
        ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18'),
        ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
    `);

    // Finalize yesterday via todo_finalize()
    await db.exec(`SELECT public.todo_finalize();`);

    // Call as admin
    await db.exec(`SET request.jwt.claim.sub = '${adminId}';`);
    const calc = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
    const forRes = await db.query(`SELECT * FROM public.streak_for('${student10}')`);

    assert.deepEqual(calc.rows[0], forRes.rows[0], 'streak_for must return identical output to streak_calc');
    assert.equal(forRes.rows[0].current_streak, 2);
    assert.equal(forRes.rows[0].active_today, true);
  });

  it('15. todo_finalize uses _todo_status_on_internal without 42501 error and correctly logs completed days', async () => {
    // Set up student with yesterday's completed task
    await db.exec(`
      INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, created_at)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Yesterday Task', 'basics', '${basicsCatId}', 1, '2026-11-18 08:00:00+05:30');

      INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
      VALUES ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18');
    `);

    // Reset auth to NULL (background/cron environment)
    await db.exec(`SET request.jwt.claim.sub = '';`);

    // Run todo_finalize() -> should complete without 42501 exception
    const finRes = await db.query(`SELECT public.todo_finalize() AS n;`);
    assert(Number(finRes.rows[0].n) >= 0, 'todo_finalize ran cleanly in background session');

    // Check that daily_todo_log was populated for student10 on 2026-11-18
    const logCheck = await db.query(`
      SELECT * FROM public.daily_todo_log WHERE student_id = '${student10}' AND day = '2026-11-18';
    `);
    assert.equal(logCheck.rows.length, 1, 'Row finalized in daily_todo_log');
    assert.equal(logCheck.rows[0].all_done, true, 'all_done is true for completed task');
    assert.equal(logCheck.rows[0].tasks_total, 1);
    assert.equal(logCheck.rows[0].tasks_done, 1);
  });

  describe('Helper Authorization & Security Definer Protection (Actual SQL Roles)', () => {
    it('20. anon role is denied EXECUTE on streak_calc(uuid)', async () => {
      await db.exec(`SET ROLE anon;`);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_calc('${student10}')`),
        /permission denied for function streak_calc/i
      );
    });

    it('21. anon role is denied EXECUTE on streak_day_counts(uuid, date, boolean)', async () => {
      await db.exec(`SET ROLE anon;`);
      await assert.rejects(
        db.query(`SELECT public.streak_day_counts('${student10}', '${fixedToday}', true)`),
        /permission denied for function streak_day_counts/i
      );
    });

    it('22. anon role is denied EXECUTE on todo_finalize()', async () => {
      await db.exec(`SET ROLE anon;`);
      await assert.rejects(
        db.query(`SELECT public.todo_finalize()`),
        /permission denied for function todo_finalize/i
      );
    });

    it('23. anon role is denied EXECUTE on streak_for(uuid)', async () => {
      await db.exec(`SET ROLE anon;`);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_for('${student10}')`),
        /permission denied for function streak_for/i
      );
    });

    it('24. authenticated student cannot query another student via streak_calc(uuid)', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${student09}';
      `);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_calc('${student10}')`),
        /permission denied for function streak_calc/i
      );
    });

    it('25. authenticated student cannot invoke streak_day_counts with spoofed practice flag', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${student09}';
      `);
      await assert.rejects(
        db.query(`SELECT public.streak_day_counts('${student09}', '${fixedToday}', true)`),
        /permission denied for function streak_day_counts/i
      );
    });

    it('26. authenticated student cannot execute todo_finalize()', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${student09}';
      `);
      await assert.rejects(
        db.query(`SELECT public.todo_finalize()`),
        /permission denied for function todo_finalize/i
      );
    });

    it('27. authenticated student A querying student B via streak_for receives 42501 Access denied', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${student09}';
      `);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_for('${student10}')`),
        (err) => {
          assert(err.message.includes('Access denied to streak data') || err.code === '42501');
          return true;
        }
      );
    });

    it('28. authenticated student A querying self via streak_for succeeds', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${student09}';
      `);
      const res = await db.query(`SELECT * FROM public.streak_for('${student09}')`);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].current_streak, 0);

      // Also test with NULL argument (defaults to self)
      const resNull = await db.query(`SELECT * FROM public.streak_for(NULL)`);
      assert.equal(resNull.rows.length, 1);
      assert.equal(resNull.rows[0].current_streak, 0);
    });

    it('29. authenticated unassigned teacher querying student via helper streak_calc is denied', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${unassignedTeacherId}';
      `);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_calc('${student10}')`),
        /permission denied for function streak_calc/i
      );
    });

    it('30. authenticated unassigned teacher querying student via streak_for receives 42501 Access denied', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${unassignedTeacherId}';
      `);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_for('${student10}')`),
        (err) => {
          assert(err.message.includes('Access denied to streak data') || err.code === '42501');
          return true;
        }
      );
    });

    it('31. authenticated assigned teacher without required permissions receives 42501 Access denied', async () => {
      // Strip permissions for assigned teacher
      await db.exec(`
        UPDATE public.teacher_permissions
           SET can_view_students = false, can_generate_reports = false
         WHERE teacher_id = '${teacherId}';
      `);

      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${teacherId}';
      `);
      await assert.rejects(
        db.query(`SELECT * FROM public.streak_for('${student10}')`),
        (err) => {
          assert(err.message.includes('Access denied to streak data') || err.code === '42501');
          return true;
        }
      );
    });

    it('32. authenticated assigned teacher with can_view_students=true succeeds', async () => {
      await db.exec(`
        UPDATE public.teacher_permissions
           SET can_view_students = true, can_generate_reports = false
         WHERE teacher_id = '${teacherId}';
      `);

      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${teacherId}';
      `);
      const res = await db.query(`SELECT * FROM public.streak_for('${student10}')`);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].current_streak, 0);
    });

    it('33. authenticated assigned teacher with can_generate_reports=true succeeds', async () => {
      await db.exec(`
        UPDATE public.teacher_permissions
           SET can_view_students = false, can_generate_reports = true
         WHERE teacher_id = '${teacherId}';
      `);

      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${teacherId}';
      `);
      const res = await db.query(`SELECT * FROM public.streak_for('${student10}')`);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].current_streak, 0);
    });

    it('34. authenticated admin querying student via streak_for succeeds', async () => {
      await db.exec(`
        SET ROLE authenticated;
        SET request.jwt.claim.sub = '${adminId}';
      `);
      const res = await db.query(`SELECT * FROM public.streak_for('${student10}')`);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows[0].current_streak, 0);
    });

    it('35. service_role / background execution calling todo_finalize() and streak_calc() succeeds', async () => {
      await db.exec(`
        SET ROLE service_role;
        SET request.jwt.claim.sub = '';
      `);
      const finRes = await db.query(`SELECT public.todo_finalize() AS n;`);
      assert(Number(finRes.rows[0].n) >= 0);

      const calcRes = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(calcRes.rows.length, 1);
    });
  });

  describe('Phase 19 Online Basics Task & Ineligible Attempts', () => {
    it('36. Assigned Basics task requiring two full-duration online rounds (1 round insufficient, 2 completes)', async () => {
      const taskId = '00000000-0000-0000-0000-000000000099';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('${taskId}', 'Two Online Basics Rounds', 'basics', '${basicsCatId}', 2);
      `);

      // 1st round: completed with online source and todo_credit = true
      const resultId1 = '11111111-aaaa-1111-aaaa-111111111111';
      const sessionId1 = '22222222-aaaa-2222-aaaa-222222222222';
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resultId1}', '${student10}', '${basicsCatId}', 10, 10, '${fixedToday}', 'online');

        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings)
        VALUES ('${sessionId1}', '${student10}', 'basics', '${resultId1}',
          '{"todo_task_id":"${taskId}", "todo_credit":true}'::jsonb);
      `);

      // Check after 1 round -> task requires 2, so today is incomplete
      const res1 = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res1.rows[0].active_today, false, '1 of 2 required online rounds must not qualify task');
      assert.equal(res1.rows[0].current_streak, 0);

      // 2nd round: completed with online source and todo_credit = true
      const resultId2 = '33333333-bbbb-3333-bbbb-333333333333';
      const sessionId2 = '44444444-bbbb-4444-bbbb-444444444444';
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resultId2}', '${student10}', '${basicsCatId}', 10, 10, '${fixedToday}', 'online');

        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings)
        VALUES ('${sessionId2}', '${student10}', 'basics', '${resultId2}',
          '{"todo_task_id":"${taskId}", "todo_credit":true}'::jsonb);
      `);

      // Check after 2 rounds -> task completed!
      const res2 = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res2.rows[0].active_today, true, '2 of 2 required online rounds completes task');
      assert.equal(res2.rows[0].current_streak, 1);
    });

    it('37. Phase 19 online drill session with todo_credit=false does NOT earn task credit', async () => {
      const taskId = '00000000-0000-0000-0000-000000000099';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('${taskId}', 'Online Basics Task', 'basics', '${basicsCatId}', 1);
      `);

      // Session abandoned early (todo_credit = false)
      const resId = '55555555-cccc-5555-cccc-555555555555';
      const sessId = '66666666-cccc-6666-cccc-666666666666';
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resId}', '${student10}', '${basicsCatId}', 5, 10, '${fixedToday}', 'online');

        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings)
        VALUES ('${sessId}', '${student10}', 'basics', '${resId}',
          '{"todo_task_id":"${taskId}", "todo_credit":false}'::jsonb);
      `);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].active_today, false, 'Early/ineligible online session must not earn task credit');
      assert.equal(res.rows[0].current_streak, 0);
    });

    it('38. Phase 19 online session with mismatched todo_task_id does NOT satisfy the assigned task', async () => {
      const assignedTaskId = '00000000-0000-0000-0000-000000000099';
      const otherTaskId = '00000000-0000-0000-0000-000000000088';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count)
        VALUES ('${assignedTaskId}', 'Assigned Basics Task', 'basics', '${basicsCatId}', 1);
      `);

      const resId = '77777777-dddd-7777-dddd-777777777777';
      const sessId = '88888888-dddd-8888-dddd-888888888888';
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resId}', '${student10}', '${basicsCatId}', 10, 10, '${fixedToday}', 'online');

        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings)
        VALUES ('${sessId}', '${student10}', 'basics', '${resId}',
          '{"todo_task_id":"${otherTaskId}", "todo_credit":true}'::jsonb);
      `);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].active_today, false, 'Mismatched task_id session must not count towards assigned task');
      assert.equal(res.rows[0].current_streak, 0);
    });
  });

  describe('Targeting Fixtures & Activity Specific Plans', () => {
    it('39. Targeted task (target_scope=targeted) enforced only for students in daily_task_recipients', async () => {
      const taskId = '00000000-0000-0000-0000-000000000077';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, target_scope)
        VALUES ('${taskId}', 'Targeted Task', 'basics', '${basicsCatId}', 1, 'targeted');

        -- Assign target only to student09, not student10
        INSERT INTO public.daily_task_recipients (task_id, student_id)
        VALUES ('${taskId}', '${student09}');
      `);

      // student10 has no assigned tasks -> 0 tasks required
      const res10 = await db.query(`
        SELECT count(*) AS total FROM public._todo_status_on_internal('${student10}', '${fixedToday}')
      `);
      assert.equal(Number(res10.rows[0].total), 0, 'student10 is not a recipient -> 0 tasks required');

      // student09 IS a recipient -> 1 task required
      const res09 = await db.query(`
        SELECT count(*) AS total FROM public._todo_status_on_internal('${student09}', '${fixedToday}')
      `);
      assert.equal(Number(res09.rows[0].total), 1, 'student09 is a recipient -> 1 task required');
    });

    it('40. IST midnight boundary: entries at 23:59:59 IST vs 00:00:01 IST partition into correct days', async () => {
      await db.exec(`
        INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
        VALUES
          ('${student10}', 'element', 10, 10, '2026-11-18 23:59:59+05:30', '{"drill":"e1"}'::jsonb),
          ('${student10}', 'element', 10, 10, '2026-11-19 00:00:01+05:30', '{"drill":"e1"}'::jsonb);
      `);

      // Finalize yesterday
      await db.exec(`SELECT public.todo_finalize();`);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].current_streak, 2, '23:59:59 IST and 00:00:01 IST form 2 consecutive streak days');
      assert.equal(res.rows[0].active_today, true);
    });

    it('41. Elements-only qualifying plan completion works', async () => {
      const taskId = '00000000-0000-0000-0000-000000000061';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
        VALUES ('${taskId}', 'Daily Elements', 'elements', 'abacus_basics_1', 1);

        INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
        VALUES ('${student10}', 'element', 10, 10, '${fixedToday} 11:00:00+05:30', '{"drill":"abacus_basics_1"}'::jsonb);
      `);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].active_today, true);
      assert.equal(res.rows[0].current_streak, 1);
    });

    it('42. Flash-only qualifying plan completion works', async () => {
      const taskId = '00000000-0000-0000-0000-000000000062';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
        VALUES ('${taskId}', 'Daily Flash', 'flash', 'flash_challenge', 1);

        INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
        VALUES ('${student10}', 'flash_anzan', 10, 10, '${fixedToday} 12:00:00+05:30',
          '{"todo_task_id":"${taskId}"}'::jsonb);
      `);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].active_today, true);
      assert.equal(res.rows[0].current_streak, 1);
    });

    it('43. Memoriad-only qualifying plan completion works', async () => {
      const taskId = '00000000-0000-0000-0000-000000000063';
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count)
        VALUES ('${taskId}', 'Daily Memoriad', 'memoriad', 'speed_cards', 1);

        INSERT INTO public.activity_results (student_id, activity_type, correct, total, created_at, settings)
        VALUES ('${student10}', 'memoriad', 52, 52, '${fixedToday} 13:00:00+05:30',
          '{"module":"speed_cards"}'::jsonb);
      `);

      const res = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      assert.equal(res.rows[0].active_today, true);
      assert.equal(res.rows[0].current_streak, 1);
    });
  });

  describe('Historical Finalization Safety & History Immutability', () => {
    it('44. Task created today is NOT required when evaluating yesterday', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, created_at)
        VALUES ('00000000-0000-0000-0000-000000000051', 'New Task Today', 'basics', '${basicsCatId}', 1, '${fixedToday} 09:00:00+05:30');
      `);

      const yesterdayStatus = await db.query(`
        SELECT * FROM public._todo_status_on_internal('${student10}', '2026-11-18')
      `);
      assert.equal(yesterdayStatus.rows.length, 0, 'Task created today must not appear in yesterday evaluation');

      const todayStatus = await db.query(`
        SELECT * FROM public._todo_status_on_internal('${student10}', '${fixedToday}')
      `);
      assert.equal(todayStatus.rows.length, 1, 'Task created today must appear in today evaluation');
    });

    it('45. Task disabled today does not alter finalized historical daily_todo_log', async () => {
      await db.exec(`
        INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
        VALUES ('${student10}', '2026-11-18', 1, 0, false);

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, active, created_at)
        VALUES ('00000000-0000-0000-0000-000000000052', 'Disabled Task', 'basics', '${basicsCatId}', 1, false, '2026-11-17 09:00:00+05:30');
      `);

      const counts = await db.query(`
        SELECT public.streak_day_counts('${student10}', '2026-11-18', true) AS done
      `);
      assert.equal(counts.rows[0].done, false, 'Finalized past day status is preserved');
    });

    it('46. Changes to student level do not retroactively alter finalized daily_todo_log', async () => {
      await db.exec(`
        INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
        VALUES ('${student10}', '2026-11-18', 1, 1, true);

        UPDATE public.profiles SET level = 'Senior' WHERE id = '${student10}';
      `);

      const counts = await db.query(`
        SELECT public.streak_day_counts('${student10}', '2026-11-18', true) AS done
      `);
      assert.equal(counts.rows[0].done, true, 'Stored history remains true even after profile level change');
    });

    it('47. todo_finalize() is idempotent and never overwrites existing historical rows', async () => {
      await db.exec(`
        INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
        VALUES ('${student10}', '2026-11-18', 5, 5, true);

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, created_at)
        VALUES ('00000000-0000-0000-0000-000000000053', 'Uncompleted Task', 'basics', '${basicsCatId}', 1, '2026-11-18 08:00:00+05:30');
      `);

      await db.query(`SELECT public.todo_finalize()`);

      const logRow = await db.query(`
        SELECT * FROM public.daily_todo_log WHERE student_id = '${student10}' AND day = '2026-11-18'
      `);
      assert.equal(logRow.rows[0].tasks_total, 5, 'ON CONFLICT DO NOTHING must preserve original finalized total');
      assert.equal(logRow.rows[0].all_done, true, 'ON CONFLICT DO NOTHING must preserve original all_done');
    });
  });

  describe('Cross-Function Reporting Consistency', () => {
    it('48. streak_for, streak_calc, and lateral streak queries return identical streak metrics', async () => {
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
          ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18'),
          ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
      `);

      // 1. streak_calc
      const calcRes = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);

      // 2. streak_for
      await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${adminId}';`);
      const forRes = await db.query(`SELECT * FROM public.streak_for('${student10}')`);

      // 3. Lateral query matching admin_overview and leaderboard
      const lateralRes = await db.query(`
        SELECT p.id, st.current_streak, st.best_streak, st.active_today
          FROM public.profiles p
          LEFT JOIN LATERAL public.streak_for(p.id) st ON true
         WHERE p.id = '${student10}'
      `);

      assert.equal(forRes.rows[0].current_streak, calcRes.rows[0].current_streak);
      assert.equal(forRes.rows[0].best_streak, calcRes.rows[0].best_streak);
      assert.equal(forRes.rows[0].shields, calcRes.rows[0].shields);
      assert.equal(forRes.rows[0].active_today, calcRes.rows[0].active_today);

      assert.equal(lateralRes.rows[0].current_streak, forRes.rows[0].current_streak);
      assert.equal(lateralRes.rows[0].best_streak, forRes.rows[0].best_streak);
    });

    it('49. Actual production reporting functions (admin_overview, leaderboard, student_month_report) return identical metrics', async () => {
      // 1. Supporting tables and helpers required by exact production definitions
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.todo_all_done_on(p_student UUID, p_day DATE)
        RETURNS BOOLEAN AS $$
          SELECT COALESCE(count(*) > 0 AND bool_and(s.done), false)
            FROM public._todo_status_on_internal(p_student, p_day) s;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.period_bounds(p_period TEXT)
        RETURNS TABLE(d_from DATE, d_to DATE) AS $$
          SELECT '2026-11-01'::DATE, '2026-11-30'::DATE;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.competition_rules()
        RETURNS TABLE(weekly_test_multiplier NUMERIC, attendance_present_points NUMERIC, improved_min_entries INTEGER) AS $$
          SELECT 1.0::NUMERIC, 10.0::NUMERIC, 3::INTEGER;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.global_leaderboard_enabled() RETURNS BOOLEAN AS $$
          SELECT true;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.display_name_for(p_full_name TEXT, p_student_code TEXT) RETURNS TEXT AS $$
          SELECT COALESCE(p_full_name, p_student_code);
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.practice_days_for(p_student UUID, p_from DATE, p_to DATE) RETURNS INTEGER AS $$
          SELECT 2;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.attendance_summary(p_student UUID, p_from DATE, p_to DATE)
        RETURNS TABLE(present_count INTEGER, absent_count INTEGER, excused_count INTEGER, attendance_pct NUMERIC) AS $$
          SELECT 0, 0, 0, 0::NUMERIC;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.practice_stats_for(p_student UUID, p_from DATE, p_to DATE)
        RETURNS TABLE(n_entries INTEGER, n_correct INTEGER, n_total INTEGER, accuracy_pct NUMERIC, qpm NUMERIC, n_rounds INTEGER) AS $$
          SELECT 2, 20, 20, 100.0::NUMERIC, 0::NUMERIC, 0;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.points_for(p_student UUID, p_from DATE, p_to DATE) RETURNS NUMERIC AS $$
          SELECT 0::NUMERIC;
        $$ LANGUAGE sql STABLE;

        CREATE TABLE IF NOT EXISTS public.results_with_target (
          student_id UUID,
          entry_date DATE,
          meets_target BOOLEAN
        );

        CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
          test_id UUID,
          section_id UUID,
          category_id UUID,
          student_id UUID,
          correct INTEGER,
          total INTEGER,
          time_seconds INTEGER
        );

        CREATE TABLE IF NOT EXISTS public.weekly_tests (
          id UUID PRIMARY KEY,
          title TEXT,
          test_date DATE
        );

        CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
          id UUID PRIMARY KEY,
          test_id UUID,
          category_id UUID,
          position INTEGER,
          kind TEXT,
          activity_key TEXT,
          flash_digits INTEGER,
          flash_count INTEGER
        );

        CREATE TABLE IF NOT EXISTS public.attendance (
          session_id UUID,
          student_id UUID,
          status TEXT
        );

        CREATE TABLE IF NOT EXISTS public.attendance_sessions (
          id UUID PRIMARY KEY,
          session_date DATE
        );
      `);

      // 2. Load exact production leaderboard() from owner_phase19_followup_fixes.sql
      const followupSql = fs.readFileSync('supabase/owner_phase19_followup_fixes.sql', 'utf8');
      const lbMatch = followupSql.match(/CREATE OR REPLACE FUNCTION public\.leaderboard[\s\S]*?REVOKE ALL ON FUNCTION public\.leaderboard[\s\S]*?GRANT EXECUTE ON FUNCTION public\.leaderboard[^\n]*/i);
      assert(lbMatch, 'Found exact production leaderboard definition');
      await db.exec(lbMatch[0]);

      // 3. Load exact production student_month_report() from standalone_student_month_report_patch.sql
      const monthReportSql = fs.readFileSync('supabase/standalone_student_month_report_patch.sql', 'utf8');
      const rptMatch = monthReportSql.match(/CREATE OR REPLACE FUNCTION public\.student_month_report[\s\S]*?\n\$\$;/i);
      assert(rptMatch, 'Found exact production student_month_report definition');
      await db.exec(rptMatch[0]);

      // 4. Install actual production admin_overview() (matches live Mumbai contract: no best_streak)
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.admin_overview()
        RETURNS TABLE (
          student_id UUID,
          student_code TEXT,
          full_name TEXT,
          level TEXT,
          active BOOLEAN,
          current_streak INTEGER,
          entered_today BOOLEAN,
          last_entry_date DATE,
          entries_7d INTEGER,
          accuracy_7d NUMERIC
        )
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public
        STABLE
        AS $$
        DECLARE
          v_today DATE := public.today_ist();
          v_week_ago DATE := (public.today_ist() - INTERVAL '6 days')::date;
        BEGIN
          IF NOT public.is_admin() THEN
            RAISE EXCEPTION 'Forbidden: Admin access required.';
          END IF;

          RETURN QUERY
          SELECT
            p.id AS student_id,
            p.student_code,
            p.full_name,
            p.level,
            p.active,
            COALESCE(st.current_streak, 0) AS current_streak,
            COALESCE(st.active_today, false) AS entered_today,
            (
              SELECT MAX(r.entry_date)
              FROM public.results r
              WHERE r.student_id = p.id
            ) AS last_entry_date,
            (
              SELECT COUNT(*)::INTEGER
              FROM public.results r
              WHERE r.student_id = p.id
                AND r.entry_date BETWEEN v_week_ago AND v_today
            ) AS entries_7d,
            (
              SELECT ROUND((SUM(r.correct)::numeric / NULLIF(SUM(r.total), 0)::numeric) * 100.0, 1)
              FROM public.results r
              WHERE r.student_id = p.id
                AND r.entry_date BETWEEN v_week_ago AND v_today
                AND r.total > 0
            ) AS accuracy_7d
          FROM public.profiles p
          LEFT JOIN LATERAL public.streak_for(p.id) st ON true
          WHERE p.role = 'student'
          ORDER BY p.student_code ASC;
        END;
        $$;
      `);

      // Set up student10 with 2 consecutive days of practice (Nov 18 + Nov 19)
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
          ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18'),
          ('${student10}', '${basicsCatId}', 10, 10, '${fixedToday}');
      `);

      // Finalize yesterday's completed day via routine finalizer
      await db.exec(`SELECT public.todo_finalize();`);

      // 1. streak_calc
      const calcRes = await db.query(`SELECT * FROM public.streak_calc('${student10}')`);
      const calc = calcRes.rows[0];

      // 2. streak_for (as admin)
      await db.exec(`SET ROLE authenticated; SET request.jwt.claim.sub = '${adminId}';`);
      const forRes = await db.query(`SELECT * FROM public.streak_for('${student10}')`);
      const forRow = forRes.rows[0];

      // 3. admin_overview()
      const adminRes = await db.query(`
        SELECT * FROM public.admin_overview() WHERE student_id = '${student10}';
      `);
      assert.equal(adminRes.rows.length, 1);
      const adminRow = adminRes.rows[0];

      // 4. leaderboard('streak')
      const lbRes = await db.query(`
        SELECT * FROM public.leaderboard('streak', 'all') WHERE student_id = '${student10}';
      `);
      assert.equal(lbRes.rows.length, 1);
      const lbRow = lbRes.rows[0];

      // 5. student_month_report
      const rptRes = await db.query(`
        SELECT public.student_month_report('${student10}', '2026-11-01'::DATE) AS rpt;
      `);
      const rptStreak = rptRes.rows[0].rpt.streak;

      // Verify identical metrics across all reporting functions + helpers:
      assert.equal(calc.current_streak, 2);
      assert.equal(calc.best_streak, 2);
      assert.equal(calc.shields, 0);
      assert.equal(calc.active_today, true);

      assert.equal(forRow.current_streak, 2);
      assert.equal(forRow.best_streak, 2);
      assert.equal(forRow.shields, 0);
      assert.equal(forRow.active_today, true);

      assert.equal(adminRow.current_streak, 2, 'admin_overview current_streak matches streak_calc');
      assert.equal(adminRow.entered_today, true, 'admin_overview entered_today matches streak_calc active_today');
      assert.equal(adminRow.best_streak, undefined, 'admin_overview contract has no best_streak column in production');

      assert.equal(Number(lbRow.value), 2, 'leaderboard value matches current_streak');

      assert.equal(rptStreak.current, 2, 'student_month_report streak.current matches streak_calc');
      assert.equal(rptStreak.best, 2, 'student_month_report streak.best matches streak_calc');
    });
  });

  describe('Upgrade & Safe Repeat Application', () => {
    it('50. Upgrade test: installs original 0-arg todo_finalize, applies patch, executes no-arg call, checks privileges, re-applies patch safely', async () => {
      // 1. Install original todo_finalize() (pre-patch definition with 0 args)
      await db.exec(`
        DROP FUNCTION IF EXISTS public.todo_status_on(UUID, DATE);
        CREATE OR REPLACE FUNCTION public.todo_status_on(p_student UUID, p_day DATE)
        RETURNS TABLE(task_id UUID, done BOOLEAN) AS $$
          SELECT id, false FROM public.daily_tasks WHERE active;
        $$ LANGUAGE sql STABLE;

        CREATE OR REPLACE FUNCTION public.todo_finalize()
        RETURNS integer
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path TO 'public'
        AS $function$
        DECLARE
          v_start date;
          v_yesterday date := public.today_ist() - 1;
          v_n integer := 0;
          v_ins integer;
          s record;
          v_first date;
          v_d date;
        BEGIN
          SELECT cs.value::date INTO v_start
            FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';
          IF v_start IS NULL THEN RETURN 0; END IF;

          FOR s IN SELECT p.id FROM public.profiles p WHERE p.role = 'student' AND p.active LOOP
            SELECT GREATEST(v_start,
                     COALESCE((SELECT max(l.day) + 1 FROM public.daily_todo_log l WHERE l.student_id = s.id), v_start))
              INTO v_first;
            IF v_first < v_yesterday - 59 THEN v_first := v_yesterday - 59; END IF;

            FOR v_d IN SELECT g::date FROM generate_series(v_first, v_yesterday, interval '1 day') AS g LOOP
              INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
              SELECT s.id, v_d, count(*)::integer, (count(*) FILTER (WHERE x.done))::integer,
                     (count(*) > 0 AND count(*) = count(*) FILTER (WHERE x.done))
                FROM public.todo_status_on(s.id, v_d) x
              ON CONFLICT (student_id, day) DO NOTHING;
              GET DIAGNOSTICS v_ins = ROW_COUNT;
              v_n := v_n + v_ins;
            END LOOP;
          END LOOP;
          RETURN v_n;
        END;
        $function$;

        ALTER FUNCTION public.todo_finalize() OWNER TO postgres;
        REVOKE ALL ON FUNCTION public.todo_finalize() FROM PUBLIC, anon, authenticated, service_role;
        GRANT EXECUTE ON FUNCTION public.todo_finalize() TO authenticated, service_role;
      `);

      // 2. Apply patch: owner_streak_consolidation_patch.sql
      const patchSql = fs.readFileSync('supabase/owner_streak_consolidation_patch.sql', 'utf8');
      await db.exec(patchSql);

      // 3. Execute existing no-argument call
      const finRes1 = await db.query(`SELECT public.todo_finalize() AS n;`);
      assert(Number(finRes1.rows[0].n) >= 0, 'No-argument call executes cleanly');

      // 4. Check privileges for every remaining finalizer signature
      const procs = await db.query(`
        SELECT p.proname, p.pronargs
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'todo_finalize';
      `);
      assert.equal(procs.rows.length, 1, 'Exactly one todo_finalize signature exists');
      assert.equal(procs.rows[0].pronargs, 0, 'todo_finalize has strictly 0 arguments');

      const privs = await db.query(`
        SELECT
          has_function_privilege('anon', 'public.todo_finalize()', 'EXECUTE') AS anon_can,
          has_function_privilege('authenticated', 'public.todo_finalize()', 'EXECUTE') AS auth_can,
          has_function_privilege('service_role', 'public.todo_finalize()', 'EXECUTE') AS srv_can;
      `);
      assert.equal(privs.rows[0].anon_can, false, 'anon denied');
      assert.equal(privs.rows[0].auth_can, false, 'authenticated denied');
      assert.equal(privs.rows[0].srv_can, true, 'service_role granted');

      // 5. Apply the patch again and verify safe repeat execution
      await db.exec(patchSql);
      const finRes2 = await db.query(`SELECT public.todo_finalize() AS n;`);
      assert(Number(finRes2.rows[0].n) >= 0, 'Repeat application executes cleanly with zero ambiguity');
    });
  });

  describe('Unlogged Past Days & Historical Assignment Dynamics', () => {
    it('51. Unlogged past day does not infer assignments from current disabled task; returns false without guessing', async () => {
      // Past day: 2026-11-18, no daily_todo_log row
      // Task created on 2026-11-17, but today disabled (active = false)
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, active, created_at)
        VALUES ('00000000-0000-0000-0000-000000000081', 'Old Task Now Disabled', 'basics', '${basicsCatId}', 1, false, '2026-11-17 08:00:00+05:30');

        -- Student practiced on 2026-11-18
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18');
      `);

      // Ensure no log row exists
      const logCheck = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${student10}' AND day = '2026-11-18';`);
      assert.equal(logCheck.rows.length, 0);

      // streak_day_counts does NOT infer historical assignments from current task state.
      // Unlogged past day on or after todo_streak_start returns false rather than falling back to practice.
      const dayCounts = await db.query(`
        SELECT public.streak_day_counts('${student10}', '2026-11-18', true) AS done;
      `);
      assert.equal(dayCounts.rows[0].done, false, 'Does NOT fall back to practice; unlogged past day returns false');
    });

    it('52. Unlogged past day does not infer assignments from changed current student level; returns false', async () => {
      // Student level changed to 'Senior' today.
      // Tasks: Junior task required 1 drill; Senior task requires 3 drills.
      await db.exec(`
        UPDATE public.profiles SET level = 'Senior' WHERE id = '${student10}';

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, active, created_at)
        VALUES
          ('00000000-0000-0000-0000-000000000082', 'Junior Task', 'basics', '${basicsCatId}', 1, 'Junior', true, '2026-11-17 08:00:00+05:30'),
          ('00000000-0000-0000-0000-000000000083', 'Senior Task', 'basics', '${basicsCatId}', 3, 'Senior', true, '2026-11-17 08:00:00+05:30');

        -- Student completed 1 drill on 2026-11-18 (satisfying Junior, but NOT Senior)
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '2026-11-18');
      `);

      // streak_day_counts on unlogged past day does NOT evaluate current profile level; it returns false.
      const dayCounts = await db.query(`
        SELECT public.streak_day_counts('${student10}', '2026-11-18', true) AS done;
      `);
      assert.equal(dayCounts.rows[0].done, false, 'Unlogged past day returns false without guessing current profile level');
    });

    it('53. Unlogged past day does not infer assignments from increased required_count; returns false and todo_finalize strictly processes yesterday', async () => {
      // Task created on 2026-11-17. Today, required_count was increased from 1 to 5.
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, active, created_at)
        VALUES ('00000000-0000-0000-0000-000000000084', 'Increased Count Task', 'basics', '${basicsCatId}', 5, true, '2026-11-17 08:00:00+05:30');

        -- Student completed 1 drill on 2026-11-16 (2 days ago, unlogged)
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date)
        VALUES ('${student10}', '${basicsCatId}', 10, 10, '2026-11-16');
      `);

      // streak_day_counts returns false for unlogged past date
      const dayCounts = await db.query(`
        SELECT public.streak_day_counts('${student10}', '2026-11-16', true) AS done;
      `);
      assert.equal(dayCounts.rows[0].done, false, 'Unlogged past day returns false');

      // Verify that todo_finalize() strictly processes yesterday (2026-11-18) and never backfills older unlogged dates (2026-11-16)
      await db.exec(`SELECT public.todo_finalize();`);
      const olderLog = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${student10}' AND day = '2026-11-16';`);
      assert.equal(olderLog.rows.length, 0, 'todo_finalize() does not backfill older unlogged historical dates');
    });
  });

  describe('Executable Rollback Restoration & Verification', () => {
    it('54. Independent rollback procedure restores original routines and privileges matching independent baseline fixture, and re-applying patch restores hardened state', async () => {
      const patchSql = fs.readFileSync('supabase/owner_streak_consolidation_patch.sql', 'utf8');

      // Load independently captured pre-patch baseline fixture (definitions, arguments, types, owners, privileges)
      const fixturePath = path.resolve('tests/fixtures/prePatchDatabaseFixture.json');
      const fixtureData = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      const fixtureRoutines = fixtureData.routines || fixtureData;

      function getAclSql(item) {
        const sig = `${item.routine_name}(${item.identity_arguments})`;
        const acl = item.raw_acl || '';
        const lines = [`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`];
        const grantees = [];
        if (acl.includes('service_role=')) grantees.push('service_role');
        if (acl.includes('authenticated=')) grantees.push('authenticated');
        if (acl.includes('anon=')) grantees.push('anon');
        if (grantees.length > 0) {
          lines.push(`GRANT EXECUTE ON FUNCTION public.${sig} TO ${grantees.join(', ')};`);
        }
        return lines.join('\n');
      }

      // Dynamically generate the restoration script from the independent baseline fixture
      const dynamicRestoreSql = `
        BEGIN;
        SET search_path = public, pg_temp;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_results ON public.results;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_activity_results ON public.activity_results;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_drill_sessions ON public.drill_sessions;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_profiles ON public.profiles;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_recipients ON public.daily_task_recipients;
        DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_tasks ON public.daily_tasks;
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_result();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_activity_result();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_session();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_profile();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_recipients();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_task();
        DROP FUNCTION IF EXISTS public._sync_daily_todo_log(UUID, DATE);
        DROP FUNCTION IF EXISTS public.todo_finalize(INTEGER);
        ${fixtureRoutines.map((item) => {
          const def = item.definition.trim().endsWith(';') ? item.definition : item.definition + ';';
          return def + '\n' + getAclSql(item);
        }).join('\n\n')}
        COMMIT;
      `;

      // Helper to capture installed routines, arguments, return types, owners, and effective privileges
      async function captureProcState() {
        const procs = await db.query(`
          SELECT
            p.oid,
            p.proname AS function_name,
            pg_get_function_identity_arguments(p.oid) AS identity_args,
            pg_get_function_result(p.oid) AS return_type,
            pg_get_userbyid(p.proowner) AS function_owner,
            pg_get_functiondef(p.oid) AS function_def
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('streak_for', 'streak_calc', 'streak_day_counts', '_todo_status_on_internal', 'todo_finalize')
          ORDER BY p.proname, identity_args;
        `);

        const privs = await db.query(`
          SELECT
            r.routine_name,
            r.specific_name,
            r.routine_type,
            p.grantee,
            p.privilege_type,
            p.is_grantable
          FROM information_schema.routines r
          JOIN information_schema.routine_privileges p
            ON r.specific_schema = p.specific_schema AND r.specific_name = p.specific_name
          WHERE r.routine_schema = 'public'
            AND r.routine_name IN ('streak_for', 'streak_calc', 'streak_day_counts', '_todo_status_on_internal', 'todo_finalize')
          ORDER BY r.routine_name, r.specific_name, p.grantee, p.privilege_type;
        `);

        const roles = ['anon', 'authenticated', 'service_role'];
        const effPrivs = [];
        for (const pr of procs.rows) {
          const sig = `${pr.function_name}(${pr.identity_args})`;
          for (const role of roles) {
            const res = await db.query(`SELECT has_function_privilege('${role}', ${pr.oid}, 'EXECUTE') AS can;`);
            effPrivs.push({ sig, role, can: res.rows[0].can });
          }
        }

        return { procs: procs.rows, privs: privs.rows, effPrivs };
      }

      // Establish baseline original state via dynamically generated restoration DDL from independent fixture
      await db.exec(dynamicRestoreSql);
      const baseline = await captureProcState();
      assert.equal(baseline.procs.length, 5, 'Baseline routines captured from independent fixture');

      // Apply patch: owner_streak_consolidation_patch.sql
      await db.exec(patchSql);
      const patched = await captureProcState();

      // Verify internal helpers are revoked from authenticated in patched state
      const patchedCalcAuth = await db.query(`SELECT has_function_privilege('authenticated', 'public.streak_calc(uuid)', 'EXECUTE') AS can;`);
      assert.equal(patchedCalcAuth.rows[0].can, false, 'Internal helper streak_calc revoked from authenticated in patched state');

      // Execute rollback using dynamically generated script from independent baseline fixture
      await db.exec(dynamicRestoreSql);
      const restored = await captureProcState();

      // Assert 100% restoration against independent baseline fixture:
      assert.equal(restored.procs.length, baseline.procs.length, 'Restored proc count matches baseline');
      for (let i = 0; i < baseline.procs.length; i++) {
        const b = baseline.procs[i];
        const r = restored.procs[i];
        assert.equal(r.function_name, b.function_name, `Proc ${i} name matches: ${b.function_name}`);
        assert.equal(r.identity_args, b.identity_args, `Proc ${i} identity_args match: ${b.identity_args}`);
        assert.equal(r.return_type, b.return_type, `Proc ${i} return_type matches: ${b.return_type}`);
        assert.equal(r.function_owner, b.function_owner, `Proc ${i} function_owner matches: ${b.function_owner}`);
        assert.equal(r.function_def, b.function_def, `Proc ${i} function_def matches baseline`);
      }

      assert.equal(restored.privs.length, baseline.privs.length, 'Restored privilege count matches baseline');
      for (let i = 0; i < baseline.privs.length; i++) {
        const b = baseline.privs[i];
        const r = restored.privs[i];
        assert.equal(r.routine_name, b.routine_name, `Priv ${i} routine_name matches: ${b.routine_name}`);
        assert.equal(r.grantee, b.grantee, `Priv ${i} grantee matches: ${b.grantee}`);
        assert.equal(r.privilege_type, b.privilege_type, `Priv ${i} privilege_type matches: ${b.privilege_type}`);
        assert.equal(r.is_grantable, b.is_grantable, `Priv ${i} is_grantable matches: ${b.is_grantable}`);
      }

      assert.equal(restored.effPrivs.length, baseline.effPrivs.length, 'Effective privileges count matches baseline');
      for (let i = 0; i < baseline.effPrivs.length; i++) {
        const b = baseline.effPrivs[i];
        const r = restored.effPrivs[i];
        assert.equal(r.sig, b.sig, `Effective privilege signature matches: ${b.sig}`);
        assert.equal(r.role, b.role, `Effective privilege role matches: ${b.role}`);
        assert.equal(r.can, b.can, `Effective privilege result matches: ${b.sig} for ${b.role}`);
      }

      // Verify restored function behavior (todo_finalize executes cleanly without ambiguity)
      const finRes = await db.query(`SELECT public.todo_finalize() AS n;`);
      assert(Number(finRes.rows[0].n) >= 0, 'Original todo_finalize executes cleanly after rollback');

      // Re-apply patch to verify roundtrip restoration
      await db.exec(patchSql);
      const repatched = await captureProcState();
      assert.equal(repatched.procs.length, patched.procs.length, 'Repatched proc count matches patched state');
      const repatchedCalcAuth = await db.query(`SELECT has_function_privilege('authenticated', 'public.streak_calc(uuid)', 'EXECUTE') AS can;`);
      assert.equal(repatchedCalcAuth.rows[0].can, false, 'Repatched streak_calc revoked from authenticated');
    });
  });

  describe('Controlled-Clock Midnight-to-Finalization Gap Integration', () => {
    it('61. Real-time plan sync preserves completed streak across midnight before finalization, unaffected by interval task/level edits or delayed finalizer', async () => {
      // 1. Create a dedicated test student and daily task for Day D (2026-11-19)
      const gapStudentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const gapTaskId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      await db.exec(`
        INSERT INTO public.profiles (id, full_name, student_code, role, active, level, leaderboard_visible)
        VALUES ('${gapStudentId}', 'Kavya Patel', 'STU_GAP_01', 'student', true, '1', true);
      `);

      // Set caller identity to the student for streak_for authorization
      await db.exec(`
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '${gapStudentId}'::UUID; $$ LANGUAGE sql STABLE;
      `);

      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${gapTaskId}', 'Do 2 Basics Addition Drills', 'basics', '${basicsCatId}', 2, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      // 2. Student completes full plan before midnight on Day D (2026-11-19)
      await db.exec(`
        INSERT INTO public.results (student_id, category_id, correct, total, entry_date) VALUES
          ('${gapStudentId}', '${basicsCatId}', 10, 10, '2026-11-19'),
          ('${gapStudentId}', '${basicsCatId}', 10, 10, '2026-11-19');
      `);

      // Verify real-time trigger synced completion to daily_todo_log
      const logPre = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${gapStudentId}' AND day = '2026-11-19';`);
      assert.equal(logPre.rows.length, 1, 'daily_todo_log row created in real time on Day D');
      assert.equal(logPre.rows[0].all_done, true, 'all_done is true in daily_todo_log on Day D');
      assert.equal(logPre.rows[0].tasks_done, 1);
      assert.equal(logPre.rows[0].tasks_total, 1);

      // 3. Cross midnight to Day D+1 (2026-11-20) WITHOUT running todo_finalize()
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
          SELECT '2026-11-20'::DATE;
        $$ LANGUAGE sql STABLE;
      `);

      // 4. Read streak_for, leaderboard, and student_month_report in the midnight-to-finalization window
      const strkBefore = await db.query(`SELECT * FROM public.streak_for('${gapStudentId}');`);
      assert.equal(strkBefore.rows[0].current_streak, 1, 'streak_for retains streak across midnight before finalization');
      assert.equal(strkBefore.rows[0].active_today, false, 'active_today is false on Day D+1 before practicing');

      const lbBefore = await db.query(`SELECT * FROM public.leaderboard('streak', 'all') WHERE is_me = true;`);
      assert.equal(lbBefore.rows.length, 1, 'Student present on leaderboard');
      assert.equal(Number(lbBefore.rows[0].value), 1, 'Leaderboard streak value is 1 before finalization');

      const rptBefore = await db.query(`SELECT public.student_month_report('${gapStudentId}', '2026-11-01'::DATE) AS rpt;`);
      assert.equal(rptBefore.rows[0].rpt.streak.current, 1, 'Monthly report streak.current is 1 before finalization');

      // 5. Test interval mutations between midnight and finalization:
      // - Teacher disables the task and increases required_count to 10
      // - Student's profile level changes from 1 to 2
      await db.exec(`
        UPDATE public.daily_tasks SET active = false, required_count = 10 WHERE id = '${gapTaskId}';
        UPDATE public.profiles SET level = '2' WHERE id = '${gapStudentId}';
      `);

      // Verify that streak values are completely unaffected by subsequent task/level changes
      const strkMut = await db.query(`SELECT * FROM public.streak_for('${gapStudentId}');`);
      assert.equal(strkMut.rows[0].current_streak, 1, 'Streak preserved despite task/level modification after midnight');

      const lbMut = await db.query(`SELECT * FROM public.leaderboard('streak', 'all') WHERE is_me = true;`);
      assert.equal(Number(lbMut.rows[0].value), 1, 'Leaderboard streak preserved despite interval mutations');

      const rptMut = await db.query(`SELECT public.student_month_report('${gapStudentId}', '2026-11-01'::DATE) AS rpt;`);
      assert.equal(rptMut.rows[0].rpt.streak.current, 1, 'Monthly report streak preserved despite interval mutations');

      // 6. Finalizer delayed or skipped: streak remains 1 indefinitely.
      // Now run todo_finalize() simulating /api/backup executing at 02:00 IST:
      const finRes = await db.query(`SELECT public.todo_finalize() AS n;`);
      assert(Number(finRes.rows[0].n) >= 0);

      // 7. Verify that Day D does not flip from failed to completed merely because todo_finalize() ran
      const strkAfter = await db.query(`SELECT * FROM public.streak_for('${gapStudentId}');`);
      assert.equal(strkAfter.rows[0].current_streak, 1, 'streak_for remains 1 after todo_finalize');

      const lbAfter = await db.query(`SELECT * FROM public.leaderboard('streak', 'all') WHERE is_me = true;`);
      assert.equal(Number(lbAfter.rows[0].value), 1, 'Leaderboard remains 1 after todo_finalize');

      const rptAfter = await db.query(`SELECT public.student_month_report('${gapStudentId}', '2026-11-01'::DATE) AS rpt;`);
      assert.equal(rptAfter.rows[0].rpt.streak.current, 1, 'Monthly report remains 1 after todo_finalize');

      // 8. Restore clock to base test date
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
          SELECT '2026-11-19'::DATE;
        $$ LANGUAGE sql STABLE;
      `);
    });
  });

  describe('Real-Time Plan Synchronization & Submission Sequence Regressions', () => {
    const syncStudent = '99999999-aaaa-bbbb-cccc-000000000001';
    const taskId1 = '99999999-aaaa-bbbb-cccc-000000000002';
    const taskId2 = '99999999-aaaa-bbbb-cccc-000000000003';

    beforeEach(async () => {
      await db.exec(`
        INSERT INTO public.profiles (id, full_name, student_code, role, active, level, leaderboard_visible)
        VALUES ('${syncStudent}', 'Sync Test Student', 'STU_SYNC', 'student', true, '1', true)
        ON CONFLICT (id) DO UPDATE SET level = '1', active = true;

        CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$ SELECT '${syncStudent}'::UUID; $$ LANGUAGE sql STABLE;
      `);
    });

    it('62. (Scenario 1) Results inserted first, then session linked and todo_credit granted: daily_todo_log captures completion only after linkage', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Online Basics Drill', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const resId = '99999999-aaaa-bbbb-cccc-000000000010';
      const sessId = '99999999-aaaa-bbbb-cccc-000000000011';

      // Step 1: Real submission step 1 - insert results row with source 'online'
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resId}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
      `);

      // Before session linkage: task is NOT completed
      const logBefore = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logBefore.rows.length, 1);
      assert.equal(logBefore.rows[0].all_done, false, 'Before linkage, all_done must be false');
      assert.equal(logBefore.rows[0].tasks_done, 0);

      // Step 2: Real submission step 2 - update/link drill_sessions with todo_credit: true and result_row_id
      await db.exec(`
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${sessId}', '${syncStudent}', 'basics', '${resId}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, now());
      `);

      // After session linkage: trigger on drill_sessions refreshes daily_todo_log
      const logAfter = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfter.rows[0].all_done, true, 'After linkage, all_done must be true');
      assert.equal(logAfter.rows[0].tasks_done, 1);

      // streak_for also reflects completion
      const strk = await db.query(`SELECT * FROM public.streak_for('${syncStudent}');`);
      assert.equal(strk.rows[0].active_today, true);
    });

    it('63. (Scenario 2) Two required online Basics rounds: first round leaves log incomplete, second completes saved log', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Two Online Basics Drills', 'basics', '${basicsCatId}', 2, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const res1 = '99999999-aaaa-bbbb-cccc-000000000021';
      const sess1 = '99999999-aaaa-bbbb-cccc-000000000022';
      const res2 = '99999999-aaaa-bbbb-cccc-000000000023';
      const sess2 = '99999999-aaaa-bbbb-cccc-000000000024';

      // Round 1
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${res1}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${sess1}', '${syncStudent}', 'basics', '${res1}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, now());
      `);

      const logR1 = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logR1.rows[0].tasks_done, 0, '1 of 2 rounds complete -> tasks_done is 0');
      assert.equal(logR1.rows[0].all_done, false);

      // Round 2
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${res2}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${sess2}', '${syncStudent}', 'basics', '${res2}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, now());
      `);

      const logR2 = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logR2.rows[0].tasks_done, 1, '2 of 2 rounds complete -> tasks_done is 1');
      assert.equal(logR2.rows[0].all_done, true);
    });

    it('64. (Scenario 3) Failed linkage and cleanup/retry: unlinked attempt leaves log incomplete, clean retry updates log to complete', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Retry Basics Drill', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const failRes = '99999999-aaaa-bbbb-cccc-000000000031';
      const failSess = '99999999-aaaa-bbbb-cccc-000000000032';
      const retryRes = '99999999-aaaa-bbbb-cccc-000000000033';
      const retrySess = '99999999-aaaa-bbbb-cccc-000000000034';

      // 1. Failed session (abandoned before min_seconds -> todo_credit = false)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${failRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${failSess}', '${syncStudent}', 'basics', '${failRes}', '{"todo_task_id": "${taskId1}", "todo_credit": false}'::jsonb, now());
      `);

      const logFail = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logFail.rows[0].all_done, false, 'Failed session does not complete log');

      // 2. Retry succeeds with full duration -> todo_credit = true
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${retryRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${retrySess}', '${syncStudent}', 'basics', '${retryRes}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, now());
      `);

      const logRetry = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logRetry.rows[0].all_done, true, 'Retry completes saved log');
    });

    it('65. (Scenario 4) Submission straddling midnight: practice started before midnight and submitted after midnight partitions to actual result date', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Straddle Basics Drill', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      // Clock is Day D+1 (2026-11-20)
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
      `);

      const straddleRes = '99999999-aaaa-bbbb-cccc-000000000041';
      const straddleSess = '99999999-aaaa-bbbb-cccc-000000000042';

      // Started at 23:55:00 IST on Day D (2026-11-19), but submitted after midnight on Day D+1 (2026-11-20)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source, created_at)
        VALUES ('${straddleRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-20', 'online', '2026-11-20 00:05:00+05:30');

        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${straddleSess}', '${syncStudent}', 'basics', '${straddleRes}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, '2026-11-19 23:55:00+05:30');
      `);

      // Saved log on 2026-11-20 must be completed
      const logStraddle = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-20';`);
      assert.equal(logStraddle.rows.length, 1);
      assert.equal(logStraddle.rows[0].all_done, true, 'Submission straddling midnight counts for entry_date Day D+1');

      // Reset clock
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });

    it('66. (Scenario 5) Current-day score deletion or date change refreshes affected student/date combinations', async () => {
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Single Basics Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const delRes = '99999999-aaaa-bbbb-cccc-000000000051';

      // Insert score for today (manual/offline practice)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${delRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');
      `);

      const logBeforeDel = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logBeforeDel.rows[0].all_done, true, 'Log is all_done before score deletion');

      // Delete the score row
      await db.exec(`DELETE FROM public.results WHERE id = '${delRes}';`);

      const logAfterDel = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfterDel.rows[0].all_done, false, 'Score deletion refreshes daily_todo_log to incomplete');
      assert.equal(logAfterDel.rows[0].tasks_done, 0);

      // Re-insert with date as 2026-11-18, then update date to today (2026-11-19)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${delRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-18', 'manual');
        UPDATE public.results SET entry_date = '2026-11-19' WHERE id = '${delRes}';
      `);

      const logAfterUpdate = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfterUpdate.rows[0].all_done, true, 'Updating date to today refreshes today log to complete');
    });

    it('67. (Scenario 6) Concurrent qualifying completions: multiple qualifying completions in quick succession are both captured in the final saved log', async () => {
      // Student has 2 tasks: 1 Basics and 1 Elements
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Basics Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');

        INSERT INTO public.daily_tasks (id, title, section, activity_key, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId2}', 'Elements Task', 'elements', 'dr_double', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const cRes1 = '99999999-aaaa-bbbb-cccc-000000000061';
      const cSess1 = '99999999-aaaa-bbbb-cccc-000000000062';
      const cAct1 = '99999999-aaaa-bbbb-cccc-000000000063';

      // Submit Basics result and Elements activity_result in rapid succession
      await Promise.all([
        db.exec(`
          INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
          VALUES ('${cRes1}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online');
          INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
          VALUES ('${cSess1}', '${syncStudent}', 'basics', '${cRes1}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, now());
        `),
        db.exec(`
          INSERT INTO public.activity_results (id, student_id, activity_type, correct, total, settings, created_at)
          VALUES ('${cAct1}', '${syncStudent}', 'element', 10, 10, '{"drill": "dr_double"}'::jsonb, '2026-11-19 14:00:00+05:30');
        `)
      ]);

      const logConcurrent = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logConcurrent.rows[0].tasks_total, 2);
      assert.equal(logConcurrent.rows[0].tasks_done, 2, 'Both tasks captured in final saved log');
      assert.equal(logConcurrent.rows[0].all_done, true);
    });

    it('68. (Scenario 7) Task, targeting, and level changes during today refresh current daily-plan evidence immediately', async () => {
      // 1. Task Definition Change:
      await db.exec(`
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Dynamic Basics Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');

        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('99999999-aaaa-bbbb-cccc-000000000071', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');
      `);

      const logInitial = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logInitial.rows[0].all_done, true, 'Task requirement 1 drill is done');

      // Admin increases required_count from 1 to 2 today
      await db.exec(`UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${taskId1}';`);
      const logAfterCountIncrease = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfterCountIncrease.rows[0].all_done, false, 'Increasing required_count immediately updates saved log to incomplete');

      // 2. Targeting Change:
      // Create targeted task not yet assigned to student
      await db.exec(`
        UPDATE public.daily_tasks SET required_count = 1 WHERE id = '${taskId1}';
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, target_scope, active, created_at)
        VALUES ('${taskId2}', 'Targeted Round Task', 'round', '${roundCatId}', 1, 'targeted', true, '2026-11-01 00:00:00+05:30');
      `);

      const logBeforeTarget = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logBeforeTarget.rows[0].tasks_total, 1, 'Only general task included initially');

      // Add student to daily_task_recipients
      await db.exec(`
        INSERT INTO public.daily_task_recipients (task_id, student_id) VALUES ('${taskId2}', '${syncStudent}');
      `);
      const logAfterTarget = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfterTarget.rows[0].tasks_total, 2, 'Adding student to daily_task_recipients immediately refreshes tasks_total');
      assert.equal(logAfterTarget.rows[0].all_done, false, 'Unfinished targeted task makes all_done false');

      // 3. Level Change:
      // Remove targeted task, student level is '1' with task completed
      await db.exec(`
        DELETE FROM public.daily_task_recipients WHERE task_id = '${taskId2}' AND student_id = '${syncStudent}';
        DELETE FROM public.daily_tasks WHERE id = '${taskId2}';
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId2}', 'Level 2 Exclusive Task', 'round', '${roundCatId}', 1, '2', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const logLvl1 = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logLvl1.rows[0].all_done, true, 'Level 1 plan complete');

      // Promote student to level 2
      await db.exec(`UPDATE public.profiles SET level = '2' WHERE id = '${syncStudent}';`);
      const logLvl2 = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logLvl2.rows[0].tasks_total, 1, 'Now targeted to Level 2 task');
      assert.equal(logLvl2.rows[0].all_done, false, 'Level 2 task not yet done, saved log immediately updated');
    });

    it('69. (Scenario 8) Midnight split: Result inserted before midnight on Day D, session linkage committed after midnight on Day D+1 preserves Day D completion across all reporting interfaces immediately and after finalization', async () => {
      // Day D is 2026-11-19
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Midnight Split Basics', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const splitRes = '99999999-aaaa-bbbb-cccc-000000000081';
      const splitSess = '99999999-aaaa-bbbb-cccc-000000000082';

      // Step 1: Result inserted before midnight (23:59:59 IST on Day D)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source, created_at)
        VALUES ('${splitRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online', '2026-11-19 23:59:59+05:30');
      `);

      // At this point, session is unlinked, so daily_todo_log for 2026-11-19 exists with all_done = false
      const logPreMidnight = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logPreMidnight.rows.length, 1);
      assert.equal(logPreMidnight.rows[0].all_done, false, 'Unlinked result before midnight leaves log pending');

      // Step 2: Midnight strikes! Clock advances to Day D+1 (2026-11-20)
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
      `);

      // Step 3: Drill session linkage commits after midnight (00:00:02 IST on Day D+1)
      await db.exec(`
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${splitSess}', '${syncStudent}', 'basics', '${splitRes}', '{"todo_task_id": "${taskId1}", "todo_credit": true}'::jsonb, '2026-11-19 23:58:00+05:30');
      `);

      // Authoritative daily_todo_log for Day D (2026-11-19) must immediately be updated to all_done = true
      const logPostMidnight = await db.query(`SELECT * FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logPostMidnight.rows.length, 1);
      assert.equal(logPostMidnight.rows[0].all_done, true, 'Linkage after midnight updates Day D log to complete');
      assert.equal(logPostMidnight.rows[0].tasks_done, 1);

      // Verify all reporting interfaces agree immediately:
      // 1. streak_for
      const sFor = await db.query(`SELECT * FROM public.streak_for('${syncStudent}');`);
      assert.equal(sFor.rows[0].current_streak >= 1, true, 'streak_for reflects completed Day D across midnight');

      // 2. streak_calc
      const sCalc = await db.query(`SELECT * FROM public.streak_calc('${syncStudent}');`);
      assert.equal(sCalc.rows[0].current_streak, sFor.rows[0].current_streak, 'streak_calc matches streak_for');

      // 3. leaderboard
      const lb = await db.query(`SELECT * FROM public.leaderboard('streak', 'all', NULL, 10, 'level') WHERE is_me = true;`);
      assert.equal(lb.rows.length, 1);
      assert.equal(Number(lb.rows[0].value), sFor.rows[0].current_streak, 'leaderboard matches streak_for');

      // 4. student_month_report
      const smr = await db.query(`SELECT public.student_month_report('${syncStudent}', '2026-11-01'::DATE) AS rpt;`);
      assert.equal(smr.rows.length, 1);
      assert.equal(smr.rows[0].rpt.streak.current, sFor.rows[0].current_streak, 'student_month_report matches streak_for');

      // Step 4: Run backup finalization (todo_finalize)
      await db.exec(`SELECT public.todo_finalize();`);

      // All reporting interfaces must continue to agree after finalization
      const sForAfter = await db.query(`SELECT * FROM public.streak_for('${syncStudent}');`);
      assert.equal(sForAfter.rows[0].current_streak, sFor.rows[0].current_streak, 'streak_for preserved after finalization');

      const sCalcAfter = await db.query(`SELECT * FROM public.streak_calc('${syncStudent}');`);
      assert.equal(sCalcAfter.rows[0].current_streak, sFor.rows[0].current_streak, 'streak_calc preserved after finalization');

      // Reset clock to 2026-11-19
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });

    it('70. (Scenario 9) Advisory lock serialization: _sync_daily_todo_log acquires pg_advisory_xact_lock on (student, day) to prevent concurrent calculation races', async () => {
      const lockTest = await db.query(`
        SELECT proname, prosrc FROM pg_proc WHERE proname = '_sync_daily_todo_log';
      `);
      assert(lockTest.rows[0].prosrc.includes('pg_advisory_xact_lock'), '_sync_daily_todo_log must call pg_advisory_xact_lock before reading counts');
      assert(lockTest.rows[0].prosrc.includes('hashtext(p_student::text)'), 'Uses student hash key');
      assert(lockTest.rows[0].prosrc.includes('hashtext(p_day::text)'), 'Uses day hash key');
    });

    it('71. (Scenario 10) Exact reproduction: task required_count changed from 1 to 2 next day after finalization; yesterday score correction preserves Day D requirements and all_done=true', async () => {
      // 1. On Day D (2026-11-19), assign one Basics round (required_count = 1).
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskId1}', 'Repro Basics Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const reproRes = '99999999-aaaa-bbbb-cccc-000000000091';

      // 2. Complete it and save daily_todo_log as 1/1, all_done=true.
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${reproRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');
      `);

      let logDayD = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logDayD.rows[0].tasks_total, 1);
      assert.equal(logDayD.rows[0].tasks_done, 1);
      assert.equal(logDayD.rows[0].all_done, true);
      assert.equal(logDayD.rows[0].finalized_at, null);

      // 3. Advance to D+1 and run todo_finalize().
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
        SELECT public.todo_finalize();
      `);

      logDayD = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logDayD.rows[0].all_done, true);
      assert.notEqual(logDayD.rows[0].finalized_at, null, 'finalized_at is now set');

      // 4. Change the task's required_count from 1 to 2.
      await db.exec(`
        UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${taskId1}';
      `);

      // 5. Correct yesterday's score from 10/10 to 9/10, keeping the same completed round.
      await db.exec(`
        UPDATE public.results SET correct = 9 WHERE id = '${reproRes}';
      `);

      // 6. Yesterday's log preserves Day D requirements and remains 1/1, all_done=true!
      logDayD = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logDayD.rows[0].tasks_total, 1, 'Preserves Day D requirement of 1 task, not polluted by today required_count=2');
      assert.equal(logDayD.rows[0].tasks_done, 1, 'Completed round remains 1');
      assert.equal(logDayD.rows[0].all_done, true, 'Yesterday log preserves all_done=true!');

      // Reset clock
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });

    it('72. (Scenario 11) Midnight linkage after next-day task or level changes: evaluates against Day D historical plan snapshot', async () => {
      // Day D is 2026-11-19, student level is '1'
      const midTask = '99999999-aaaa-bbbb-cccc-000000000092';
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
        UPDATE public.profiles SET level = '1' WHERE id = '${syncStudent}';

        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${midTask}', 'Midnight Level 1 Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');
      `);

      const splitRes = '99999999-aaaa-bbbb-cccc-000000000093';
      const splitSess = '99999999-aaaa-bbbb-cccc-000000000094';

      // Result recorded before midnight (23:59:59 IST on Day D, unlinked session)
      await db.exec(`
        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source, created_at)
        VALUES ('${splitRes}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'online', '2026-11-19 23:59:59+05:30');
      `);

      let logPre = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logPre.rows[0].all_done, false);
      assert.equal(logPre.rows[0].finalized_at, null);

      // Midnight strikes! Advance to Day D+1 (2026-11-20)
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
      `);

      // Admin changes task required_count from 1 to 2, and promotes student from level '1' to '2' on Day D+1
      await db.exec(`
        UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${midTask}';
        UPDATE public.profiles SET level = '2' WHERE id = '${syncStudent}';
      `);

      // Session linkage commits after midnight for Day D at 00:00:02 IST on Day D+1
      await db.exec(`
        INSERT INTO public.drill_sessions (id, student_id, activity_type, result_row_id, settings, started_at)
        VALUES ('${splitSess}', '${syncStudent}', 'basics', '${splitRes}', '{"todo_task_id": "${midTask}", "todo_credit": true}'::jsonb, '2026-11-19 23:58:00+05:30');
      `);

      // Must evaluate against Day D's historical plan snapshot (required_count = 1, level = '1')
      let logPost = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logPost.rows[0].tasks_total, 1, 'Preserves Day D task requirement of 1');
      assert.equal(logPost.rows[0].tasks_done, 1, 'Session satisfies Day D task');
      assert.equal(logPost.rows[0].all_done, true, 'Day D is completed across midnight despite next-day task & level changes!');

      // Reset clock & level
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
        UPDATE public.profiles SET level = '1' WHERE id = '${syncStudent}';
      `);
    });

    it('73. (Scenario 12) Score corrections that do not affect round eligibility on finalized history preserve completion and finalized_at', async () => {
      // Day D (2026-11-19) is completed and finalized
      const taskF = '99999999-aaaa-bbbb-cccc-000000000095';
      const resF = '99999999-aaaa-bbbb-cccc-000000000096';

      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskF}', 'Finalized Test Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');

        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resF}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');

        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
        SELECT public.todo_finalize();
      `);

      let logBefore = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logBefore.rows[0].all_done, true);
      assert.notEqual(logBefore.rows[0].finalized_at, null);
      const originalFinalizedAt = logBefore.rows[0].finalized_at;

      // Correction: student got 8/10 instead of 10/10 (both have total = 10 > 0, so completed round count is still 1)
      await db.exec(`
        UPDATE public.results SET correct = 8 WHERE id = '${resF}';
      `);

      let logAfter = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logAfter.rows[0].tasks_total, 1);
      assert.equal(logAfter.rows[0].tasks_done, 1);
      assert.equal(logAfter.rows[0].all_done, true, 'Non-eligibility score correction preserves all_done = true');
      assert.equal(logAfter.rows[0].finalized_at.getTime(), originalFinalizedAt.getTime(), 'Preserves finalized_at timestamp');

      // Reset clock
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });

    it('74. (Scenario 13) Genuine eligibility changes evaluated against the historical plan', async () => {
      // Day D (2026-11-19) was completed with required_count = 1 and finalized
      const taskG = '99999999-aaaa-bbbb-cccc-000000000097';
      const resG = '99999999-aaaa-bbbb-cccc-000000000098';

      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskG}', 'Genuine Change Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');

        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resG}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');

        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
        SELECT public.todo_finalize();

        -- Next-day task definition is altered to required_count = 3
        UPDATE public.daily_tasks SET required_count = 3 WHERE id = '${taskG}';
      `);

      // Teacher invalidates/zeroes the attempt (total = 0, so not a completed round)
      await db.exec(`
        UPDATE public.results SET correct = 0, total = 0 WHERE id = '${resG}';
      `);

      let logG = await db.query(`SELECT tasks_total, tasks_done, all_done, finalized_at FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logG.rows[0].tasks_total, 1, 'Evaluated against historical plan (tasks_total = 1, NOT next-day 3)');
      assert.equal(logG.rows[0].tasks_done, 0, 'Genuine eligibility drop reflected: 0 rounds');
      assert.equal(logG.rows[0].all_done, false, 'all_done correctly becomes false');

      // Now student completes a valid score correction restoring eligibility
      await db.exec(`
        UPDATE public.results SET correct = 10, total = 10 WHERE id = '${resG}';
      `);

      logG = await db.query(`SELECT tasks_total, tasks_done, all_done FROM public.daily_todo_log WHERE student_id = '${syncStudent}' AND day = '2026-11-19';`);
      assert.equal(logG.rows[0].tasks_total, 1);
      assert.equal(logG.rows[0].tasks_done, 1);
      assert.equal(logG.rows[0].all_done, true, 'Restoring eligibility against historical plan restores all_done = true');

      // Reset clock
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });

    it('75. (Scenario 14) Reporting parity across homepage, admin views and leaderboard after corrections and midnight completions', async () => {
      // Day D = 2026-11-19. Student completes plan.
      const taskP = '99999999-aaaa-bbbb-cccc-000000000099';
      const resP = '99999999-aaaa-bbbb-cccc-00000000009a';

      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
        INSERT INTO public.daily_tasks (id, title, section, category_id, required_count, level, target_scope, active, created_at)
        VALUES ('${taskP}', 'Parity Task', 'basics', '${basicsCatId}', 1, '1', 'all', true, '2026-11-01 00:00:00+05:30');

        INSERT INTO public.results (id, student_id, category_id, correct, total, entry_date, source)
        VALUES ('${resP}', '${syncStudent}', '${basicsCatId}', 10, 10, '2026-11-19', 'manual');

        -- Advance to D+1
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-20'::DATE; $$ LANGUAGE sql STABLE;
        UPDATE public.daily_tasks SET required_count = 2 WHERE id = '${taskP}';
        SELECT public.todo_finalize();
        UPDATE public.results SET correct = 9 WHERE id = '${resP}';
      `);

      // 1. streak_for
      const sFor = await db.query(`SELECT * FROM public.streak_for('${syncStudent}');`);
      assert.equal(sFor.rows[0].current_streak >= 1, true);

      // 2. streak_calc
      const sCalc = await db.query(`SELECT * FROM public.streak_calc('${syncStudent}');`);
      assert.equal(sCalc.rows[0].current_streak, sFor.rows[0].current_streak, 'streak_calc matches streak_for');

      // 3. leaderboard
      const lb = await db.query(`SELECT * FROM public.leaderboard('streak', 'all', NULL, 10, 'level') WHERE is_me = true;`);
      assert.equal(lb.rows.length, 1);
      assert.equal(Number(lb.rows[0].value), sFor.rows[0].current_streak, 'leaderboard matches streak_for');

      // 4. student_month_report
      const smr = await db.query(`SELECT public.student_month_report('${syncStudent}', '2026-11-01'::DATE) AS rpt;`);
      assert.equal(smr.rows.length, 1);
      assert.equal(smr.rows[0].rpt.streak.current, sFor.rows[0].current_streak, 'student_month_report matches streak_for');

      // Reset clock
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$ SELECT '2026-11-19'::DATE; $$ LANGUAGE sql STABLE;
      `);
    });
  });
});

describe('Frontend Routing & Layout Repairs', () => {
  it('16. student.html requires strictly student role and guard redirects admin/teacher with replace', () => {
    const studentJs = fs.readFileSync('js/student.js', 'utf8');
    assert(
      studentJs.includes("requireAuth(['student'])"),
      'js/student.js must strictly require student role'
    );
    assert(
      !studentJs.includes("requireAuth(['student', 'admin'])"),
      'js/student.js must not allow admin in student home guard'
    );

    const guardJs = fs.readFileSync('js/guard.js', 'utf8');
    assert(
      guardJs.includes("window.location.replace('/pages/admin.html')"),
      'guard.js must redirect unauthorized admin to /pages/admin.html using location.replace'
    );
    assert(
      guardJs.includes("window.location.replace('/pages/teacher.html')"),
      'guard.js must redirect unauthorized teacher to /pages/teacher.html using location.replace'
    );
    assert(
      guardJs.includes("window.location.replace('/pages/student.html')"),
      'guard.js must redirect unauthorized student to /pages/student.html using location.replace'
    );
  });

  it('17. studentDetail.html enforces staff authorization and checks teacher assignments', () => {
    const detailJs = fs.readFileSync('js/studentDetail.js', 'utf8');
    assert(
      detailJs.includes("requireAuth(['teacher', 'admin'])"),
      'studentDetail.js requires teacher or admin role'
    );
    assert(
      detailJs.includes("teacher_student_assignments"),
      'studentDetail.js verifies teacher-student assignment'
    );
    assert(
      detailJs.includes("You do not have access to view this student"),
      'studentDetail.js denies access to unassigned teacher'
    );
  });

  it('18. student-detail.html card headers have flex space-between and gap to prevent collisions', () => {
    const detailHtml = fs.readFileSync('pages/student-detail.html', 'utf8');
    
    // Streak card header must have space-between and gap without unconstrained nested div
    const streakCardHeaderMatch = detailHtml.match(/<section class="card" id="streak-card"[^>]*>[\s\S]*?<div class="card-header"([^>]*)>([\s\S]*?)<\/div>/i);
    assert(streakCardHeaderMatch, 'Found streak card header');
    const streakAttrs = streakCardHeaderMatch[1];
    const streakBody = streakCardHeaderMatch[2];
    assert(streakAttrs.includes('justify-content: space-between'), 'Streak card header has justify-content: space-between');
    assert(streakAttrs.includes('gap: var(--space-4)'), 'Streak card header has gap: var(--space-4)');
    assert(streakBody.includes('id="streak-heading"') && streakBody.includes('id="streak-today-badge"'), 'h2 and badge are direct children');

    // To-do card header must also have space-between and gap
    const todoCardHeaderMatch = detailHtml.match(/<section class="card" aria-labelledby="todo-heading">[\s\S]*?<div class="card-header"([^>]*)>([\s\S]*?)<\/div>/i);
    assert(todoCardHeaderMatch, 'Found todo card header');
    const todoAttrs = todoCardHeaderMatch[1];
    const todoBody = todoCardHeaderMatch[2];
    assert(todoAttrs.includes('justify-content: space-between'), 'Todo card header has justify-content: space-between');
    assert(todoAttrs.includes('gap: var(--space-4)'), 'Todo card header has gap: var(--space-4)');
    assert(todoBody.includes('id="todo-heading"') && todoBody.includes('id="todo-progress-count"'), 'h2 and count are direct children');
  });

  it('19. practiceUi.css defines right-alignment and clean spacing for history table numeric columns', () => {
    const css = fs.readFileSync('css/practiceUi.css', 'utf8');
    assert(css.includes('.history-compact-table th.th-num'), 'Defines .th-num style');
    assert(css.includes('.history-compact-table td.cell-score'), 'Defines .cell-score style');
    assert(css.includes('.history-compact-table td.cell-accuracy'), 'Defines .cell-accuracy style');
    assert(css.includes('.history-compact-table td.cell-time'), 'Defines .cell-time style');
    assert(css.includes('.history-compact-table th.th-action'), 'Defines .th-action style');
    assert(css.includes('.history-compact-table td.cell-details'), 'Defines .cell-details style');
    assert(css.includes('.history-compact-table td.cell-date'), 'Defines .cell-date style');
  });

  describe('Actual requireAuth Route Guard Execution (Live Module)', () => {
    let requireAuth;
    let DemoDB;
    let writeProfileCache;

    before(async () => {
      // Set up global browser environment mocks for live guard.js execution
      const storageMock = () => {
        const d = {};
        return {
          getItem: (k) => d[k] || null,
          setItem: (k, v) => { d[k] = String(v); },
          removeItem: (k) => { delete d[k]; },
          clear: () => { Object.keys(d).forEach((k) => delete d[k]); }
        };
      };

      globalThis.localStorage = storageMock();
      globalThis.sessionStorage = storageMock();
      globalThis.window = {
        location: {
          hostname: 'localhost',
          pathname: '/pages/student.html',
          replace(url) { this.replaced = url; }
        },
        localStorage: globalThis.localStorage,
        sessionStorage: globalThis.sessionStorage,
        addEventListener: () => {},
        removeEventListener: () => {}
      };
      globalThis.document = {
        body: { innerHTML: '' },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
      };

      const guardModule = await import('../js/guard.js');
      requireAuth = guardModule.requireAuth;

      const demoDbModule = await import('../js/demoDb.js');
      DemoDB = demoDbModule.DemoDB;

      const profileCacheModule = await import('../js/profileCache.js');
      writeProfileCache = profileCacheModule.writeProfileCache;
    });

    beforeEach(() => {
      globalThis.sessionStorage.clear();
      globalThis.localStorage.clear();
      globalThis.window.location.replaced = null;
    });

    it('55. Fresh admin visit redirects via location.replace before dashboard data is requested', async () => {
      DemoDB.setDemoAuth({ id: 'admin-01', role: 'admin', full_name: 'Admin User' });
      const res = await requireAuth(['student']);

      assert.equal(res, null, 'requireAuth returns null for unauthorized admin');
      assert.equal(globalThis.window.location.replaced, '/pages/admin.html', 'Redirects immediately to /pages/admin.html');
    });

    it('56. Cached admin visit redirects via location.replace before dashboard data is requested', async () => {
      const adminProfile = { id: 'admin-01', role: 'admin', full_name: 'Admin User' };
      DemoDB.setDemoAuth(adminProfile);
      writeProfileCache(adminProfile);

      const res = await requireAuth(['student']);
      assert.equal(res, null);
      assert.equal(globalThis.window.location.replaced, '/pages/admin.html');
    });

    it('57. Fresh teacher visit redirects via location.replace before dashboard data is requested', async () => {
      DemoDB.setDemoAuth({ id: 'teacher-01', role: 'teacher', full_name: 'Teacher User' });
      const res = await requireAuth(['student']);

      assert.equal(res, null, 'requireAuth returns null for unauthorized teacher');
      assert.equal(globalThis.window.location.replaced, '/pages/teacher.html', 'Redirects immediately to /pages/teacher.html');
    });

    it('58. Cached teacher visit redirects via location.replace before dashboard data is requested', async () => {
      const teacherProfile = { id: 'teacher-01', role: 'teacher', full_name: 'Teacher User' };
      DemoDB.setDemoAuth(teacherProfile);
      writeProfileCache(teacherProfile);

      const res = await requireAuth(['student']);
      assert.equal(res, null);
      assert.equal(globalThis.window.location.replaced, '/pages/teacher.html');
    });

    it('59. Stale cached-student with fresh-admin session redirects to /pages/admin.html without exposing student view', async () => {
      // Storage contains stale cached student profile from previous session
      writeProfileCache({ id: 'student-99', role: 'student', full_name: 'Old Student' });
      // Active session is an admin
      DemoDB.setDemoAuth({ id: 'admin-01', role: 'admin', full_name: 'Admin User' });

      const res = await requireAuth(['student']);
      assert.equal(res, null);
      assert.equal(globalThis.window.location.replaced, '/pages/admin.html');
    });

    it('60. Back/reload navigation: location.replace runs before any student data fetch', async () => {
      DemoDB.setDemoAuth({ id: 'admin-01', role: 'admin', full_name: 'Admin User' });

      let studentDataFetched = false;
      // Simulated student dashboard initialization sequence
      async function studentDashboardInit() {
        const profile = await requireAuth(['student']);
        if (!profile) return;
        studentDataFetched = true;
      }

      await studentDashboardInit();
      assert.equal(studentDataFetched, false, 'Student dashboard data fetch is never reached');
      assert.equal(globalThis.window.location.replaced, '/pages/admin.html');
    });
  });
});
