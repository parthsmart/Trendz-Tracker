/**
 * Trendz Tracker — Comprehensive PGlite Integration Test Suite
 * (tests/homeworkPglite.test.js)
 *
 * Verifies:
 * 1. Staging isolation safety:
 *    - Rejects execution if app.target_environment latch is unset or mismatched.
 *    - Rejects execution if live Mumbai production data (STU101 / Riya) is present.
 * 2. SQL schema application & idempotency:
 *    - staging_homework_feature.sql and staging_practice_highest_records.sql apply cleanly and idempotently.
 * 3. Database RLS policies under authenticated roles:
 *    - Teacher cannot read assignments for students outside roster.
 *    - Teacher cannot create assignments for students outside roster.
 *    - Student cannot read unassigned work.
 *    - Student CANNOT directly insert into homework_completions (direct write blocked by RLS).
 *    - Student CANNOT directly update homework_completions (direct write blocked by RLS).
 * 4. Authoritative submit_homework_completion RPC:
 *    - Access control: rejects non-recipient students.
 *    - Online drill validation: requires valid submitted drill_session matching activity, category, duration.
 *    - Replay protection: rejects duplicate submission of the same session_id.
 *    - Required count: increments progress, transitions to 'completed' when required_count is satisfied.
 *    - Offline/paper: records honest 'pending_review' status.
 * 5. Authoritative verify_homework_completion RPC:
 *    - Teacher roster authorization: only assigned teacher or admin can verify.
 *    - Approving transitions status to 'completed' with verified_by and verified_at.
 * 6. Authoritative practice_highest_records RPC across all 4 branches:
 *    - Basics: category & duration match, correct DESC, wrong ASC, genuine ties.
 *    - Flash: fastest cleared flashing speed (MIN speed_ms with correct >= 1), genuine ties.
 *    - Elements: drill match, correct DESC, time_seconds ASC.
 *    - Memoriad: official score (settings->>'score') DESC, used_seconds ASC.
 *    - Global vs level visibility rules and private account exclusion (leaderboard_visible=false).
 * 7. Strict streak & daily task isolation:
 *    - Homework completions grant zero daily_tasks or daily_todo_log credit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { normalizeRecordForRenderer } from '../js/practiceRecords.js';
import { renderRecordCardHtml } from '../js/practiceRecordsCard.js';
import { resolveAndValidateHomework } from '../api/_homework.js';
import { createJmcwcServer } from '../api/_jmcwcServer.js';
import { JMCWC_PAPERS } from '../api/_jmcwcBlueprints.js';
import { generateQuestionsFromBlueprint } from '../api/_jmcwcGenerate.js';
import { buildHomeworkReleaseSql } from '../scripts/buildHomeworkReleaseSql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

describe('Homework & Highest Records PGlite Integration Suite', () => {
  const asUser = async (db, userId, role = 'authenticated', fn) => {
    await db.exec(`SET app.current_user_id = '${userId}'; SET app.current_jwt_role = '${role}'; SET ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec(`RESET ROLE; SET app.current_user_id = ''; SET app.current_jwt_role = '';`);
    }
  };

  const setupBaseStagingDb = async () => {
    const db = new PGlite();

    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role BYPASSRLS;
        ELSE
          ALTER ROLE service_role BYPASSRLS;
        END IF;
      END $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('app.current_user_id', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
        SELECT COALESCE(NULLIF(current_setting('app.current_jwt_role', true), ''), 'authenticated');
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB AS $$ SELECT '{}'::jsonb; $$ LANGUAGE sql STABLE;

      -- Base Tables
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
        student_code TEXT UNIQUE,
        full_name TEXT NOT NULL,
        level TEXT,
        active BOOLEAN NOT NULL DEFAULT true,
        leaderboard_visible BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.teacher_permissions (
        teacher_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        can_manage_tasks BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.teacher_student_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_tsa UNIQUE (teacher_id, student_id)
      );

      CREATE TABLE public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        sort_order INT NOT NULL DEFAULT 1,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL DEFAULT '',
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_seconds NUMERIC NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '1 hour',
        status TEXT NOT NULL DEFAULT 'open',
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID REFERENCES public.categories(id),
        student_round_id UUID,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT NOT NULL DEFAULT 0,
        note TEXT,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        verified BOOLEAN NOT NULL DEFAULT false,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flag_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT,
        correct INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        time_seconds INT,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.result_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        result_id UUID,
        student_id UUID,
        changed_by UUID,
        action TEXT,
        old_values JSONB,
        new_values JSONB,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE public.competition_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        required_count INT NOT NULL DEFAULT 1
      );

      CREATE TABLE public.daily_todo_log (
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        tasks_done INTEGER NOT NULL DEFAULT 0,
        all_done BOOLEAN NOT NULL DEFAULT false,
        finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (student_id, day)
      );

      CREATE TABLE IF NOT EXISTS public.jmcwc_categories (
        key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        workbook_sheet TEXT NOT NULL,
        position INTEGER NOT NULL UNIQUE,
        legacy_category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS public.jmcwc_papers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_key TEXT NOT NULL,
        version TEXT NOT NULL,
        spec JSONB NOT NULL DEFAULT '{}'::jsonb,
        published BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.jmcwc_assignments (
        student_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.jmcwc_targets (
        group_key TEXT NOT NULL,
        category_key TEXT NOT NULL,
        target_seconds INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (group_key, category_key)
      );

      CREATE TABLE public.jmcwc_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        request_id UUID NOT NULL DEFAULT gen_random_uuid(),
        paper_id UUID NULL,
        group_key TEXT NOT NULL DEFAULT 'group_a',
        mode TEXT NOT NULL DEFAULT 'flat',
        category_key TEXT NULL,
        status TEXT NOT NULL DEFAULT 'paused',
        active_ms BIGINT NOT NULL DEFAULT 0,
        target_seconds INTEGER NULL,
        last_seen_at TIMESTAMPTZ NULL,
        lease_id UUID NULL,
        save_seq BIGINT NOT NULL DEFAULT -1,
        revision BIGINT NOT NULL DEFAULT 0,
        answers JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ NULL,
        submitted_reason TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS public.jmcwc_payloads (
        attempt_id UUID PRIMARY KEY REFERENCES public.jmcwc_attempts(id) ON DELETE CASCADE,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb
      );

      CREATE OR REPLACE FUNCTION public.jmcwc_check_student(p_student uuid)
      RETURNS text LANGUAGE plpgsql AS $$
      DECLARE g text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id=p_student AND role='student' AND active) THEN
          RAISE EXCEPTION 'An active student account is required.';
        END IF;
        SELECT group_key INTO g FROM public.jmcwc_assignments WHERE student_id=p_student;
        IF g IS NULL THEN
          RAISE EXCEPTION 'Ask your teacher to assign your JMCWC group.';
        END IF;
        RETURN g;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.jmcwc_validate_marks(p_category text, p_slot jsonb, p_question_marks numeric DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        RETURN;
      END;
      $$;

      -- Baseline 6-argument jmcwc_create_attempt installed prior to homework migration
      CREATE OR REPLACE FUNCTION public.jmcwc_create_attempt(
        p_student uuid,
        p_request uuid,
        p_paper uuid,
        p_mode text,
        p_category text,
        p_questions jsonb
      )
      RETURNS uuid
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      DECLARE
        g text;
        p RECORD;
        a uuid;
        target integer;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended(p_student::text, 172026));
        g := public.jmcwc_check_student(p_student);
        SELECT id INTO a FROM public.jmcwc_attempts WHERE student_id = p_student AND request_id = p_request;
        IF FOUND THEN RETURN a; END IF;
        IF p_request IS NULL OR p_mode IS NULL OR p_mode NOT IN ('flat','category') THEN
          RAISE EXCEPTION 'Invalid request.';
        END IF;
        SELECT * INTO p FROM public.jmcwc_papers WHERE id = p_paper AND group_key = g AND published;
        IF NOT FOUND THEN RAISE EXCEPTION 'No published paper for your assigned group.'; END IF;
        SELECT target_seconds INTO target FROM public.jmcwc_targets WHERE group_key = g AND category_key = p_category;
        INSERT INTO public.jmcwc_attempts(student_id, request_id, paper_id, group_key, mode, category_key, target_seconds)
        VALUES (p_student, p_request, p_paper, g, p_mode, p_category, CASE WHEN p_mode = 'category' THEN target END)
        RETURNING id INTO a;
        INSERT INTO public.jmcwc_payloads(attempt_id, questions) VALUES (a, p_questions);
        RETURN a;
      END;
      $$;

      REVOKE ALL ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) TO postgres, service_role;

      CREATE TABLE public.student_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
        title VARCHAR(120) NOT NULL,
        body TEXT NOT NULL,
        needs_attention BOOLEAN NOT NULL DEFAULT false,
        attention_reason TEXT,
        linked_type VARCHAR(30) CHECK (linked_type IN ('score', 'weekly_test', 'attempt')),
        linked_id UUID,
        link TEXT,
        client_nonce VARCHAR(64),
        read_at TIMESTAMPTZ,
        dismissed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_student_messages_client_nonce
        ON public.student_messages(sender_id, client_nonce)
        WHERE client_nonce IS NOT NULL;

      -- Installed baseline format_leaderboard_name with p_code parameter to verify upgrade safety (no 42P13)
      CREATE OR REPLACE FUNCTION public.format_leaderboard_name(
        p_full_name TEXT,
        p_code TEXT,
        p_mode TEXT
      )
      RETURNS TEXT
      LANGUAGE plpgsql
      IMMUTABLE
      AS $$
      BEGIN
        IF p_mode = 'full_name' THEN
          RETURN COALESCE(NULLIF(p_full_name, ''), p_code);
        ELSIF p_mode = 'code_only' OR p_mode = 'student_code' THEN
          RETURN p_code;
        ELSE
          RETURN COALESCE(split_part(p_full_name, ' ', 1), p_code);
        END IF;
      END;
      $$;

      -- Seed settings
      INSERT INTO public.competition_settings (key, value) VALUES
        ('global_leaderboard', 'on'),
        ('leaderboard_names', 'first_name_initial');

      GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    `);

    return db;
  };

  it('1. Pre-flight checks: operator latch and production tripwire', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    const hwSqlWithoutLatch = hwSql.replace(/SET app\.target_environment[^;]+;/g, '');

    // 1a. Fail when latch is wrong
    await assert.rejects(async () => {
      await db.exec(`
        SET app.target_environment = 'wrong_env';
        ${hwSqlWithoutLatch}
      `);
    }, /OPERATOR SAFETY HALT/);

    // 1b. Fail when live Mumbai production student is present
    await db.exec('ROLLBACK;');
    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role)
      VALUES ('00000000-0000-0000-0000-000000000101', 'STU101', 'Riya Sen', 'student');
    `);

    await assert.rejects(async () => {
      await db.exec(`
        SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';
        ${hwSqlWithoutLatch}
      `);
    }, /SECONDARY SAFEGUARD TRIPWIRE/);
  });

  it('2. Clean application and idempotency for homework and records packages', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    const recSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_practice_highest_records.sql'), 'utf8');

    // Apply homework feature
    await db.exec(`
      SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';
      ${hwSql}
    `);

    // Apply practice highest records
    await db.exec(`
      SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';
      ${recSql}
    `);

    // Idempotent reapplication
    await db.exec(`
      SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';
      ${hwSql}
    `);
    await db.exec(`
      SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';
      ${recSql}
    `);

    // Verify tables exist
    const { rows: tRows } = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('homework_assignments', 'homework_completions')
      ORDER BY table_name;
    `);
    assert.equal(tRows.length, 2);
  });

  it('Production SQL requires an explicit latch and upgrades the existing Main Round signatures', async () => {
    const db = await setupBaseStagingDb();
    try {
      const sql = buildHomeworkReleaseSql();
      await assert.rejects(db.exec(sql), /Production release latch is missing or incorrect/);
      await db.exec('ROLLBACK;');

      const flashSource = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'owner_phase19_improvements_migration.sql'), 'utf8');
      const messageSource = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'migrations', '15_phase17_private_student_messages.sql'), 'utf8');
      const flashDefinition = flashSource.match(/CREATE OR REPLACE FUNCTION public\.flash_start\([\s\S]*?\$\$;/)[0];
      const messageDefinition = messageSource.match(/CREATE OR REPLACE FUNCTION public\.admin_send_student_message\([\s\S]*?\$\$;/)[0];
      await db.exec(`
        CREATE TABLE IF NOT EXISTS public.daily_task_recipients (task_id uuid, student_id uuid);
        DROP FUNCTION public.format_leaderboard_name(text, text, text);
        ${flashDefinition}
        ${messageDefinition}
        SET app.target_environment = 'production_kgzivhavpsvitwrscrrj';
        ${sql}
      `);
      await db.exec(`
        PREPARE ordinary_create(uuid, uuid, uuid, text, text, jsonb)
          AS SELECT public.jmcwc_create_attempt($1,$2,$3,$4,$5,$6);
        PREPARE homework_create(uuid, uuid, uuid, text, text, jsonb, uuid)
          AS SELECT public.jmcwc_create_attempt($1,$2,$3,$4,$5,$6,$7);
      `);
      assert.equal((await db.query(`
        SELECT has_table_privilege('authenticated', 'public.homework_bound_sessions', 'SELECT') AS client_can_read
      `)).rows[0].client_can_read, false);
    } finally {
      await db.close();
    }
  });

  it('3. RLS authorization: teacher roster scoping and student direct write blocking', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacherA = '11111111-1111-1111-1111-111111111111';
    const teacherB = '22222222-2222-2222-2222-222222222222';
    const student1 = '33333333-3333-3333-3333-333333333333';
    const student2 = '44444444-4444-4444-4444-444444444444';

    // Seed profiles & permissions
    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacherA}', 'TCH-A', 'Teacher Alpha', 'teacher', NULL, true),
        ('${teacherB}', 'TCH-B', 'Teacher Beta', 'teacher', NULL, true),
        ('${student1}', 'STU-01', 'Student One', 'student', 'Level 2', true),
        ('${student2}', 'STU-02', 'Student Two', 'student', 'Level 3', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES
        ('${teacherA}', true),
        ('${teacherB}', true);

      -- Teacher A teaches Student 1 only
      -- Teacher B teaches Student 2 only
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherA}', '${student1}'),
        ('${teacherB}', '${student2}');
    `);

    // 3a. Teacher A tries to assign homework to Student 2 (outside roster) -> BLOCKED by RLS
    await asUser(db, teacherA, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.exec(`
          INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type)
          VALUES ('Illegal Roster Homework', '${teacherA}', 'student', '${student2}', 'paper');
        `);
      }, /violates row-level security policy/);
    });

    // 3b. Teacher A assigns homework to Student 1 (in roster) -> SUCCESS
    let hw1Id = null;
    await asUser(db, teacherA, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type)
        VALUES ('Basics Drill Task', '${teacherA}', 'student', '${student1}', 'basics')
        RETURNING id;
      `);
      assert.equal(rows.length, 1);
      hw1Id = rows[0].id;
    });

    // 3c. Teacher B cannot read Teacher A's assignment for Student 1
    await asUser(db, teacherB, 'authenticated', async () => {
      const { rows } = await db.query(`SELECT * FROM public.homework_assignments WHERE id = '${hw1Id}';`);
      assert.equal(rows.length, 0, 'Teacher B must not read Teacher A private homework');
    });

    // 3d. Student 2 cannot read Student 1's assignment
    await asUser(db, student2, 'authenticated', async () => {
      const { rows } = await db.query(`SELECT * FROM public.homework_assignments WHERE id = '${hw1Id}';`);
      assert.equal(rows.length, 0, 'Student 2 must not see Student 1 private homework');
    });

    // 3e. Student 1 CAN read their assignment
    await asUser(db, student1, 'authenticated', async () => {
      const { rows } = await db.query(`SELECT * FROM public.homework_assignments WHERE id = '${hw1Id}';`);
      assert.equal(rows.length, 1, 'Student 1 can read assigned homework');
    });

    // 3f. Student 1 attempts DIRECT TABLE WRITE to homework_completions -> BLOCKED by RLS
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.exec(`
          INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status)
          VALUES ('${hw1Id}', '${student1}', 1, 'completed');
        `);
      }, /permission denied for table homework_completions/);
    });
  });

  it('4. Authoritative submit_homework_completion RPC and replay protection', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-1111-1111-1111-111111111111';
    const student = '33333333-3333-3333-3333-333333333333';
    const catId = '55555555-5555-5555-5555-555555555555';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-1', 'Teacher Alpha', 'teacher', NULL, true),
        ('${student}', 'STU-1', 'Student One', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacher}', '${student}');

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catId}', 'Addition 60s', 'basics', 1);
    `);

    // Create assignment: requires 2 completions of 60s Basics
    let assignId = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, category_id, duration_seconds, required_count)
        VALUES ('Do 2 rounds of 60s Addition', '${teacher}', 'student', '${student}', 'basics', '${catId}', 60, 2)
        RETURNING id;
      `);
      assignId = rows[0].id;
    });

    const sess1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const sess2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const res1 = '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const res2 = '22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

    // Seed results and submitted sessions with matching result_id
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${res1}', '${student}', '${catId}', 10, 10, 60, true),
        ('${res2}', '${student}', '${catId}', 12, 12, 60, true);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, min_seconds, started_at, result_id) VALUES
        ('${sess1}', '${student}', 'basics', 'submitted', '{"category_id": "${catId}", "duration_seconds": 60, "homework_id": "${assignId}"}'::jsonb, 60, now(), '${res1}'),
        ('${sess2}', '${student}', 'basics', 'submitted', '{"category_id": "${catId}", "duration_seconds": 60, "homework_id": "${assignId}"}'::jsonb, 60, now(), '${res2}');
    `);

    // 4a. Submit session 1: progress becomes 1 of 2, status remains in_progress
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${assignId}'::uuid, '${sess1}'::uuid) AS res;
      `);
      const res = rows[0].res;
      assert.equal(res.success, true);
      assert.equal(res.status, 'in_progress');
      assert.equal(res.progress_count, 1);
      assert.equal(res.required_count, 2);
    });

    // 4b. Replay protection: submitting session 1 again must abort with 23505
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${assignId}'::uuid, '${sess1}'::uuid);
        `);
      }, /already been submitted for this homework/);
    });

    // 4c. Submit session 2: progress becomes 2 of 2, status transitions to 'completed'
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${assignId}'::uuid, '${sess2}'::uuid) AS res;
      `);
      const res = rows[0].res;
      assert.equal(res.success, true);
      assert.equal(res.status, 'completed');
      assert.equal(res.progress_count, 2);
    });

    // Verify completion record in DB
    const { rows: compRows } = await db.query(`
      SELECT status, progress_count, completed_at, submission_history
      FROM public.homework_completions
      WHERE assignment_id = '${assignId}' AND student_id = '${student}';
    `);
    assert.equal(compRows[0].status, 'completed');
    assert.equal(compRows[0].progress_count, 2);
    assert.ok(compRows[0].completed_at);
    assert.equal(compRows[0].submission_history.length, 2);
  });

  it('5. Offline homework submission and teacher verification workflow', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacherA = '11111111-1111-1111-1111-111111111111';
    const teacherB = '22222222-2222-2222-2222-222222222222';
    const student = '33333333-3333-3333-3333-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacherA}', 'TCH-A', 'Teacher Alpha', 'teacher', NULL, true),
        ('${teacherB}', 'TCH-B', 'Teacher Beta', 'teacher', NULL, true),
        ('${student}', 'STU-1', 'Student One', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES
        ('${teacherA}', true), ('${teacherB}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherA}', '${student}');
    `);

    // Create paper assignment
    let paperHwId = null;
    await asUser(db, teacherA, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type)
        VALUES ('Abacus Page 25', '${teacherA}', 'student', '${student}', 'paper')
        RETURNING id;
      `);
      paperHwId = rows[0].id;
    });

    // 5a. Student submits paper homework -> status becomes 'pending_review'
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${paperHwId}'::uuid, NULL, NULL, NULL, 'Completed all 20 sums') AS res;
      `);
      assert.equal(rows[0].res.status, 'pending_review');
    });

    const { rows: compRows } = await db.query(`
      SELECT id, status, notes FROM public.homework_completions WHERE assignment_id = '${paperHwId}';
    `);
    const compId = compRows[0].id;
    assert.equal(compRows[0].status, 'pending_review');

    // 5b. Teacher B (not in roster) attempts to verify -> REJECTED
    await asUser(db, teacherB, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compId}'::uuid, 'approve', 'Looks great');
        `);
      }, /Access denied/);
    });

    // 5c. Teacher A verifies -> APPROVED and marked 'completed'
    await asUser(db, teacherA, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.verify_homework_completion('${compId}'::uuid, 'approve', 'Checked in class - 100% correct') AS res;
      `);
      assert.equal(rows[0].res.decision, 'approve');
    });

    const { rows: finalComp } = await db.query(`
      SELECT status, verified_by, notes FROM public.homework_completions WHERE id = '${compId}';
    `);
    assert.equal(finalComp[0].status, 'completed');
    assert.equal(finalComp[0].verified_by, teacherA);
    assert.ok(finalComp[0].notes.includes('100% correct'));
  });

  it('6. Authoritative practice_highest_records RPC across all 4 branches with Flash fastest speed', async () => {
    const db = await setupBaseStagingDb();
    const recSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_practice_highest_records.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${recSql}`);

    const stu1 = '11111111-0000-0000-0000-000000000001';
    const stu2 = '22222222-0000-0000-0000-000000000002';
    const stuPrivate = '99999999-0000-0000-0000-000000000009';
    const catAdd = 'aaaaaaaa-1111-0000-0000-000000000000';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active, leaderboard_visible) VALUES
        ('${stu1}', 'STU1', 'Aarav Sharma', 'student', 'Level 2', true, true),
        ('${stu2}', 'STU2', 'Diya Patel', 'student', 'Level 2', true, true),
        ('${stuPrivate}', 'STU9', 'Secret Student', 'student', 'Level 2', true, false);

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catAdd}', 'Addition 60s', 'basics', 1);
    `);

    // 6a. Basics: stu1 has 40 correct (1 wrong); stu2 has 45 correct (0 wrong). Private stu9 has 99 correct.
    const res1 = 'c1111111-1111-0000-0000-000000000001';
    const res2 = 'c2222222-2222-0000-0000-000000000002';
    const res9 = 'c9999999-9999-0000-0000-000000000009';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${res1}', '${stu1}', '${catAdd}', 40, 41, 60, true),
        ('${res2}', '${stu2}', '${catAdd}', 45, 45, 60, true),
        ('${res9}', '${stuPrivate}', '${catAdd}', 99, 99, 60, true);
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('basics', '{"durationSeconds": 60}'::jsonb) AS res;
      `);
      const basics = rows[0].res;
      assert.equal(basics.length, 1);
      assert.equal(basics[0].correct, 45); // stu2 wins
      assert.equal(basics[0].holders.length, 1);
      assert.equal(basics[0].holders[0].student_code, 'STU2');
      assert.equal(basics[0].holders[0].display_name, 'Diya P.');
    });

    // 6b. Flash Anzan: Workload (2 digits, 10 numbers, add)
    // stu1 cleared at 1000ms. stu2 cleared at 800ms. Both have 1 correct.
    // stu2 wins because 800ms is fastest flashing speed!
    const actF1 = 'f1111111-1111-0000-0000-000000000001';
    const actF2 = 'f2222222-2222-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, correct, total, settings) VALUES
        ('${actF1}', '${stu1}', 'flash_anzan', 1, 1, '{"digits": 2, "count": 10, "speed_ms": 1000, "mode": "add", "session_id": "sess-f1"}'::jsonb),
        ('${actF2}', '${stu2}', 'flash_anzan', 1, 1, '{"digits": 2, "count": 10, "speed_ms": 800, "mode": "add", "session_id": "sess-f2"}'::jsonb);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('d1111111-1111-0000-0000-000000000001', '${stu1}', 'flash_anzan', 'submitted', '{"digits": 2, "count": 10, "speed_ms": 1000, "mode": "add"}'::jsonb, now(), '${actF1}'),
        ('d2222222-2222-0000-0000-000000000002', '${stu2}', 'flash_anzan', 'submitted', '{"digits": 2, "count": 10, "speed_ms": 800, "mode": "add"}'::jsonb, now(), '${actF2}');
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('flash') AS res;
      `);
      const flash = rows[0].res;
      assert.equal(flash.length, 1);
      assert.equal(flash[0].digits, 2);
      assert.equal(flash[0].count, 10);
      assert.equal(flash[0].speed_ms, 800); // 800ms is fastest
      assert.equal(flash[0].holders.length, 1);
      assert.equal(flash[0].holders[0].student_code, 'STU2');
    });

    // 6c. Elements: Squares Stage 1
    const actE1 = 'e1111111-1111-0000-0000-000000000001';
    const actE2 = 'e2222222-2222-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings) VALUES
        ('${actE1}', '${stu1}', 'element', 'Squares Stage 1', 25, 25, 55, '{"drill": "squares_stage_1", "session_id": "sess-e1"}'::jsonb),
        ('${actE2}', '${stu2}', 'element', 'Squares Stage 1', 25, 25, 42, '{"drill": "squares_stage_1", "session_id": "sess-e2"}'::jsonb);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('d3333333-1111-0000-0000-000000000001', '${stu1}', 'element', 'submitted', '{"drill": "squares_stage_1"}'::jsonb, now(), '${actE1}'),
        ('d4444444-2222-0000-0000-000000000002', '${stu2}', 'element', 'submitted', '{"drill": "squares_stage_1"}'::jsonb, now(), '${actE2}');
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('element') AS res;
      `);
      const elem = rows[0].res;
      assert.equal(elem.length, 1);
      assert.equal(elem[0].drill_key, 'squares_stage_1');
      assert.equal(elem[0].correct, 25);
      assert.equal(elem[0].time_seconds, 42); // stu2 wins on time
      assert.equal(elem[0].holders[0].student_code, 'STU2');
    });

    // 6d. Memoriad: Calendar Dates with official scoring
    const actM1 = 'a1111111-1111-0000-0000-000000000001';
    const actM2 = 'a2222222-2222-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings) VALUES
        ('${actM1}', '${stu1}', 'memoriad', 'Calendar Dates', 45, 50, 280, '{"module": "calendar", "score": 45, "used_seconds": 280, "session_id": "sess-m1"}'::jsonb),
        ('${actM2}', '${stu2}', 'memoriad', 'Calendar Dates', 52, 60, 290, '{"module": "calendar", "score": 52, "used_seconds": 290, "session_id": "sess-m2"}'::jsonb);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('d5555555-1111-0000-0000-000000000001', '${stu1}', 'memoriad', 'submitted', '{"module": "calendar", "score": 45, "used_seconds": 280}'::jsonb, now(), '${actM1}'),
        ('d6666666-2222-0000-0000-000000000002', '${stu2}', 'memoriad', 'submitted', '{"module": "calendar", "score": 52, "used_seconds": 290}'::jsonb, now(), '${actM2}');
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('memoriad') AS res;
      `);
      const memo = rows[0].res;
      assert.equal(memo.length, 1);
      assert.equal(memo[0].module_key, 'calendar');
      assert.equal(Number(memo[0].score), 52); // stu2 wins with 52
      assert.equal(memo[0].holders[0].student_code, 'STU2');
    });
  });

  it('7. Strict streak & daily task isolation: zero impact on daily_tasks or daily_todo_log', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    // Insert 10 homework assignments and completions
    const teacher = '11111111-1111-1111-1111-111111111111';
    const student = '33333333-3333-3333-3333-333333333333';
    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, active) VALUES
        ('${teacher}', 'TCH1', 'Teacher Alpha', 'teacher', true),
        ('${student}', 'STU1', 'Student One', 'student', true);
      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacher}', '${student}');
    `);

    // Verify daily_tasks and daily_todo_log remain completely untouched
    const { rows: taskRowsBefore } = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.daily_tasks;`);
    const { rows: todoRowsBefore } = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.daily_todo_log;`);

    await asUser(db, teacher, 'authenticated', async () => {
      for (let i = 1; i <= 5; i++) {
        await db.query(`
          INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type)
          VALUES ('Homework ${i}', '${teacher}', 'student', '${student}', 'paper');
        `);
      }
    });

    const { rows: taskRowsAfter } = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.daily_tasks;`);
    const { rows: todoRowsAfter } = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.daily_todo_log;`);

    assert.equal(taskRowsBefore[0].cnt, taskRowsAfter[0].cnt, 'Homework must never insert into daily_tasks');
    assert.equal(todoRowsBefore[0].cnt, todoRowsAfter[0].cnt, 'Homework must never insert into daily_todo_log');
  });

  it('8. Teacher permissions & roster boundaries: can_manage_tasks, level change preservation, and verification capability', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacherNoPerm = '11111111-9999-9999-9999-111111111111';
    const teacherEmptyRoster = '22222222-9999-9999-9999-222222222222';
    const teacherValid = '33333333-9999-9999-9999-333333333333';
    const student = '44444444-9999-9999-9999-444444444444';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacherNoPerm}', 'TCH-NO-TASK', 'Teacher No Tasks', 'teacher', NULL, true),
        ('${teacherEmptyRoster}', 'TCH-EMPTY', 'Teacher Empty Roster', 'teacher', NULL, true),
        ('${teacherValid}', 'TCH-VALID', 'Teacher Valid', 'teacher', NULL, true),
        ('${student}', 'STU-LVL', 'Level Student', 'student', 'Level 1', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES
        ('${teacherNoPerm}', false),
        ('${teacherEmptyRoster}', true),
        ('${teacherValid}', true);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherNoPerm}', '${student}'),
        ('${teacherValid}', '${student}');
    `);

    // 8a. Teacher with can_manage_tasks = false is blocked by RLS from creating assignments
    await asUser(db, teacherNoPerm, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type)
          VALUES ('Disallowed', '${teacherNoPerm}', 'student', '${student}', 'paper');
        `);
      }, /violates row-level security policy/);
    });

    // 8b. Teacher with empty roster is blocked by RLS from creating 'all' or 'level' assignments
    await asUser(db, teacherEmptyRoster, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          INSERT INTO public.homework_assignments (title, assigned_by, target_type, activity_type)
          VALUES ('All Students HW', '${teacherEmptyRoster}', 'all', 'paper');
        `);
      }, /violates row-level security policy/);
    });

    // 8c. Valid teacher creates Level 1 targeted assignment -> trigger populates initial completion
    let lvlHwId = null;
    await asUser(db, teacherValid, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_level, activity_type)
        VALUES ('Level 1 Worksheet', '${teacherValid}', 'level', 'Level 1', 'paper')
        RETURNING id;
      `);
      lvlHwId = rows[0].id;
    });

    // Verify initial completion was snapshotted
    const { rows: initialComp } = await db.query(`
      SELECT id, status FROM public.homework_completions WHERE assignment_id = '${lvlHwId}' AND student_id = '${student}';
    `);
    assert.equal(initialComp.length, 1);
    assert.equal(initialComp[0].status, 'in_progress');

    // Student is now promoted to Level 2!
    await db.exec(`UPDATE public.profiles SET level = 'Level 2' WHERE id = '${student}';`);

    // Even though student's current level is Level 2, the homework recipient status is permanently preserved!
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.is_student_homework_recipient('${lvlHwId}'::uuid, '${student}'::uuid) AS is_rec;
      `);
      assert.equal(rows[0].is_rec, true);

      // Student can submit
      const { rows: subRes } = await db.query(`
        SELECT public.submit_homework_completion('${lvlHwId}'::uuid, NULL, NULL, NULL, 'Done before level promo') AS res;
      `);
      assert.equal(subRes[0].res.status, 'pending_review');
    });

    const compId = initialComp[0].id;

    // 8d. Teacher with can_manage_tasks = false attempts verification -> rejected by RPC with 42501
    await asUser(db, teacherNoPerm, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compId}'::uuid, 'approve', 'Approved by unpermitted teacher');
        `);
      }, /Teacher lacks task management permission/);
    });

    // 8e. Valid teacher verifies -> approved
    await asUser(db, teacherValid, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.verify_homework_completion('${compId}'::uuid, 'approve', 'Looks great!') AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.status, 'completed');
    });
  });

  it('9. Authoritative online homework validation: activity & workload mismatches, date guards, and missing results', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-aaaa-bbbb-cccc-111111111111';
    const student = '22222222-aaaa-bbbb-cccc-222222222222';
    const catAdd = '33333333-aaaa-bbbb-cccc-333333333333';
    const catSub = '44444444-aaaa-bbbb-cccc-444444444444';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-9', 'Teacher Nine', 'teacher', NULL, true),
        ('${student}', 'STU-9', 'Student Nine', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacher}', '${student}');

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catAdd}', 'Addition 60s', 'basics', 1),
        ('${catSub}', 'Subtraction 60s', 'basics', 2);
    `);

    // Create online Basics homework: Addition 60s
    let hwOnline = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, category_id, duration_seconds, required_count)
        VALUES ('Addition 60s Practice', '${teacher}', 'student', '${student}', 'basics', '${catAdd}', 60, 1)
        RETURNING id;
      `);
      hwOnline = rows[0].id;
    });

    // 9a. Teacher attempts to manually approve online homework -> strictly REJECTED (no self-certification/manual bypass)
    const { rows: compRows } = await db.query(`
      SELECT id FROM public.homework_completions WHERE assignment_id = '${hwOnline}' AND student_id = '${student}';
    `);
    const compOnlineId = compRows[0].id;

    await asUser(db, teacher, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compOnlineId}'::uuid, 'approve', 'Manual teacher pass');
        `);
      }, /Cannot manually verify online homework/);
    });

    // 9b. Student attempts to submit session with WRONG CATEGORY (Subtraction instead of Addition)
    const sessWrongCat = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';
    const resWrongCat = 'cccccccc-1111-1111-1111-cccccccccccc';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${resWrongCat}', '${student}', '${catSub}', 20, 20, 60, true);
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessWrongCat}', '${student}', 'basics', 'submitted', '{"category_id": "${catSub}", "duration_seconds": 60, "homework_id": "${hwOnline}"}'::jsonb, now(), '${resWrongCat}');
    `);

    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwOnline}'::uuid, '${sessWrongCat}'::uuid);
        `);
      }, /Practice session category does not match/);
    });

    // 9c. Student attempts to submit session with DURATION < ASSIGNED DURATION (30s < 60s)
    const sessShort = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
    const resShort = 'cccccccc-2222-2222-2222-cccccccccccc';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${resShort}', '${student}', '${catAdd}', 15, 15, 30, true);
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessShort}', '${student}', 'basics', 'submitted', '{"category_id": "${catAdd}", "duration_seconds": 30, "homework_id": "${hwOnline}"}'::jsonb, now(), '${resShort}');
    `);

    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwOnline}'::uuid, '${sessShort}'::uuid);
        `);
      }, /Drill session duration is less than assigned duration/);
    });

    // 9d. Student attempts to submit session started BEFORE assignment date
    const sessOld = 'bbbbbbbb-3333-3333-3333-bbbbbbbbbbbb';
    const resOld = 'cccccccc-3333-3333-3333-cccccccccccc';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${resOld}', '${student}', '${catAdd}', 20, 20, 60, true);
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessOld}', '${student}', 'basics', 'submitted', '{"category_id": "${catAdd}", "duration_seconds": 60, "homework_id": "${hwOnline}"}'::jsonb, now() - interval '2 days', '${resOld}');
    `);

    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwOnline}'::uuid, '${sessOld}'::uuid);
        `);
      }, /Session was started before the homework assignment date/);
    });

    // 9e. Student attempts to submit session with NO SAVED RESULT IN RESULTS TABLE
    const sessNoRes = 'bbbbbbbb-4444-4444-4444-bbbbbbbbbbbb';
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessNoRes}', '${student}', 'basics', 'submitted', '{"category_id": "${catAdd}", "duration_seconds": 60, "homework_id": "${hwOnline}"}'::jsonb, now(), '99999999-9999-9999-9999-999999999999'::uuid);
    `);

    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwOnline}'::uuid, '${sessNoRes}'::uuid);
        `);
      }, /No eligible saved practice result found for this session/);
    });
  });

  it('10. Authoritative admin_send_student_message: multi-source score linking, recipient check, and deep links', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const admin = 'aaaaaaaa-0000-0000-0000-000000000001';
    const studentA = 'aaaaaaaa-0000-0000-0000-000000000002';
    const studentB = 'aaaaaaaa-0000-0000-0000-000000000003';
    const catBasics = 'aaaaaaaa-0000-0000-0000-000000000004';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, active) VALUES
        ('${admin}', 'ADM-1', 'Admin Boss', 'admin', true),
        ('${studentA}', 'STU-A', 'Student A', 'student', true),
        ('${studentB}', 'STU-B', 'Student B', 'student', true);

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catBasics}', 'Addition Drill', 'basics', 1);
    `);

    const scoreBasics = '11111111-2222-3333-4444-555555555555';
    const scoreFlash = '22222222-2222-3333-4444-555555555555';
    const attemptJmcwc = '33333333-2222-3333-4444-555555555555';

    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds) VALUES
        ('${scoreBasics}', '${studentA}', '${catBasics}', 25, 25, 60);

      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings) VALUES
        ('${scoreFlash}', '${studentA}', 'flash_anzan', 'Flash 2d 10n', 1, 1, 8, '{"digits": 2, "count": 10, "speed_ms": 800}'::jsonb);

      INSERT INTO public.jmcwc_attempts (id, student_id, group_key) VALUES
        ('${attemptJmcwc}', '${studentA}', 'group_a');
    `);

    // 10a. Link score in results (Basics) -> deep link generated
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${studentA}'::uuid,
          'Review Basics Score',
          'Great accuracy on 60s addition!',
          false,
          NULL,
          'score',
          '${scoreBasics}'::uuid,
          'nonce-b1'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.link, `/pages/basics.html?resultId=${scoreBasics}`);
    });

    // 10b. Link score in activity_results (Flash) -> deep link generated
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${studentA}'::uuid,
          'Review Flash Score',
          'Fast speed at 800ms!',
          false,
          NULL,
          'score',
          '${scoreFlash}'::uuid,
          'nonce-f1'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.link, `/pages/flash.html?resultId=${scoreFlash}`);
    });

    // 10c. Link score in jmcwc_attempts (Main Round) -> deep link generated
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${studentA}'::uuid,
          'Review Main Round Attempt',
          'Solid JMCWC simulator trial.',
          false,
          NULL,
          'score',
          '${attemptJmcwc}'::uuid,
          'nonce-j1'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.link, `/pages/round-scores.html?attemptId=${attemptJmcwc}`);
    });

    // 10d. Link score in results with round category and student_round_id -> deep link and audit entry
    const catRound = 'aaaaaaaa-0000-0000-0000-000000000005';
    const scoreRound = '44444444-2222-3333-4444-555555555555';
    const studentRoundId = '55555555-2222-3333-4444-555555555555';
    await db.exec(`
      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catRound}', 'Round Scores', 'round', 2);
      INSERT INTO public.results (id, student_id, category_id, student_round_id, correct, total, time_seconds) VALUES
        ('${scoreRound}', '${studentA}', '${catRound}', '${studentRoundId}', 50, 50, 120);
    `);
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${studentA}'::uuid,
          'Review Round Score',
          'Please verify this manual round entry',
          true,
          'Suspiciously high score',
          'score',
          '${scoreRound}'::uuid,
          'nonce-r1'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.link, `/pages/round-scores.html?roundId=${studentRoundId}&resultId=${scoreRound}`);
    });
    const { rows: auditRows } = await db.query(`SELECT * FROM public.result_audit WHERE result_id = '${scoreRound}';`);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].action, 'flag');

    // 10e. Linking student A's score in a message addressed to student B -> strictly REJECTED (42501)
    await asUser(db, admin, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message(
            '${studentB}'::uuid,
            'Wrong Recipient',
            'This score does not belong to you.',
            false,
            NULL,
            'score',
            '${scoreBasics}'::uuid,
            'nonce-err'
          );
        `);
      }, /Linked score does not belong to the recipient student/);
    });
  });

  it('11. Practice highest records: RPC-to-Renderer contract, deduplicated ties, and Calendar 25/125 separation', async () => {
    const db = await setupBaseStagingDb();
    const recSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_practice_highest_records.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${recSql}`);

    const stu1 = '11111111-0000-0000-0000-000000000001';
    const stu2 = '22222222-0000-0000-0000-000000000002';
    const catAdd = 'aaaaaaaa-1111-0000-0000-000000000000';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active, leaderboard_visible) VALUES
        ('${stu1}', 'STU1', 'Aarav Sharma', 'student', 'Level 2', true, true),
        ('${stu2}', 'STU2', 'Diya Patel', 'student', 'Level 2', true, true);

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catAdd}', 'Addition 60s', 'basics', 1);
    `);

    // 11a. Student 1 records TWO identical top scores (45 correct, 0 wrong)
    // and Student 2 records ONE top score (45 correct, 0 wrong)
    const r1a = 'c1111111-1111-0000-0000-00000000001a';
    const r1b = 'c1111111-1111-0000-0000-00000000001b';
    const r2 = 'c2222222-2222-0000-0000-000000000002';

    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${r1a}', '${stu1}', '${catAdd}', 45, 45, 60, true),
        ('${r1b}', '${stu1}', '${catAdd}', 45, 45, 60, true),
        ('${r2}', '${stu2}', '${catAdd}', 45, 45, 60, true);
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('basics', '{"durationSeconds": 60}'::jsonb) AS res;
      `);
      const basics = rows[0].res;
      assert.equal(basics.length, 1);

      // Verify deduplication: stu1 must appear only once!
      const holders = basics[0].holders;
      assert.equal(holders.length, 2, 'Should have exactly 2 deduplicated holders, not 3');
      const stu1Holders = holders.filter((h) => h.student_code === 'STU1');
      assert.equal(stu1Holders.length, 1, 'Student 1 must appear only once despite multiple identical top scores');

      // Verify full renderer normalization & card HTML output
      const norm = normalizeRecordForRenderer(basics[0], 'basics', stu1);
      assert.equal(norm.hasRecord, true);
      assert.equal(norm.isHeldByMe, true);
      assert.equal(norm.attemptLabel, 'Defend record');

      const html = renderRecordCardHtml(norm);
      assert.ok(html.includes('Addition 60s'));
      assert.ok(html.includes('45 correct (0 wrong)'));
      assert.ok(html.includes('You share this record!'));
      assert.ok(html.includes('Defend record'));
    });

    // 11b. Memoriad: Separate Calendar 25 dates vs 125 dates into distinct workload cards
    const actM25 = 'c2525252-0000-0000-0000-000000000025';
    const actM125 = 'c1251251-0000-0000-0000-000000000125';

    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds, settings) VALUES
        ('${actM25}', '${stu1}', 'memoriad', 'Calendar Dates', 20, 25, 60, '{"module": "calendar", "dates": 25, "score": 20, "used_seconds": 55}'::jsonb),
        ('${actM125}', '${stu2}', 'memoriad', 'Calendar Dates', 80, 125, 300, '{"module": "calendar", "dates": 125, "score": 80, "used_seconds": 290}'::jsonb);

      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('a2525252-0000-0000-0000-000000000025', '${stu1}', 'memoriad', 'submitted', '{"module": "calendar", "dates": 25, "score": 20, "used_seconds": 55}'::jsonb, now(), '${actM25}'),
        ('a1251251-0000-0000-0000-000000000125', '${stu2}', 'memoriad', 'submitted', '{"module": "calendar", "dates": 125, "score": 80, "used_seconds": 290}'::jsonb, now(), '${actM125}');
    `);

    await asUser(db, stu1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.practice_highest_records('memoriad') AS res;
      `);
      const memo = rows[0].res;
      assert.equal(memo.length, 2, 'Should partition Calendar into 25-date and 125-date records');

      const card25 = memo.find((m) => m.dates_tier === 25);
      const card125 = memo.find((m) => m.dates_tier === 125);
      assert.ok(card25, '25 dates card exists');
      assert.ok(card125, '125 dates card exists');

      assert.equal(Number(card25.score), 20);
      assert.equal(card25.holders[0].student_code, 'STU1');

      assert.equal(Number(card125.score), 80);
      assert.equal(card125.holders[0].student_code, 'STU2');

      // Test renderer HTML output for both tiers
      const norm25 = normalizeRecordForRenderer(card25, 'memoriad', stu1);
      const html25 = renderRecordCardHtml(norm25);
      assert.ok(html25.includes('Calendar (25 Dates)'));
      assert.ok(html25.includes('20 pts'));
      assert.ok(html25.includes('25 dates'));

      const norm125 = normalizeRecordForRenderer(card125, 'memoriad', stu1);
      const html125 = renderRecordCardHtml(norm125);
      assert.ok(html125.includes('Calendar (125 Dates)'));
      assert.ok(html125.includes('80 pts'));
      assert.ok(html125.includes('125 dates'));
    });
  });

  it('12. Fail closed for missing/inactive profiles and capability revocation', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const adminActive = '10000000-0000-0000-0000-000000000001';
    const adminInactive = '10000000-0000-0000-0000-000000000002';
    const teacherActive = '20000000-0000-0000-0000-000000000001';
    const teacherInactive = '20000000-0000-0000-0000-000000000002';
    const teacherNoPerm = '20000000-0000-0000-0000-000000000003';
    const studentActive = '30000000-0000-0000-0000-000000000001';
    const studentInactive = '30000000-0000-0000-0000-000000000002';
    const missingUser = '90000000-0000-0000-0000-000000000000';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, active) VALUES
        ('${adminActive}', 'ADM-A', 'Admin Active', 'admin', true),
        ('${adminInactive}', 'ADM-I', 'Admin Inactive', 'admin', false),
        ('${teacherActive}', 'TCH-A', 'Teacher Active', 'teacher', true),
        ('${teacherInactive}', 'TCH-I', 'Teacher Inactive', 'teacher', false),
        ('${teacherNoPerm}', 'TCH-N', 'Teacher No Perm', 'teacher', true),
        ('${studentActive}', 'STU-A', 'Student Active', 'student', true),
        ('${studentInactive}', 'STU-I', 'Student Inactive', 'student', false);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES
        ('${teacherActive}', true),
        ('${teacherNoPerm}', false);

      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacherActive}', '${studentActive}'),
        ('${teacherActive}', '${studentInactive}');
    `);

    // 12a. Inactive admin sending message -> REJECTED (42501)
    await asUser(db, adminInactive, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message('${studentActive}'::uuid, 'Test', 'Body');
        `);
      }, /Access denied: Only active admins and teachers can send messages/);
    });

    // 12b. Missing profile sending message -> REJECTED (42501)
    await asUser(db, missingUser, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message('${studentActive}'::uuid, 'Test', 'Body');
        `);
      }, /Access denied: Only active admins and teachers can send messages/);
    });

    // 12c. Active admin sending message to inactive student -> REJECTED (P0002)
    await asUser(db, adminActive, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message('${studentInactive}'::uuid, 'Test', 'Body');
        `);
      }, /Recipient student not found or inactive/);
    });

    // Create assignment for studentActive and studentInactive
    let hwId = null;
    await asUser(db, adminActive, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, activity_type)
        VALUES ('Class Reading', '${adminActive}', 'all', 'paper')
        RETURNING id;
      `);
      hwId = rows[0].id;
    });

    // 12d. Inactive student attempting to submit homework -> REJECTED (42501)
    await asUser(db, studentInactive, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwId}'::uuid, NULL, NULL, NULL, 'Finished');
        `);
      }, /Student account is inactive or not found/);
    });

    // 12e. Active student submits homework
    await asUser(db, studentActive, 'authenticated', async () => {
      await db.query(`
        SELECT public.submit_homework_completion('${hwId}'::uuid, NULL, NULL, NULL, 'Finished');
      `);
    });

    const { rows: compRows } = await db.query(`
      SELECT id FROM public.homework_completions WHERE assignment_id = '${hwId}' AND student_id = '${studentActive}';
    `);
    const compId = compRows[0].id;

    // 12f. Inactive teacher verifying homework -> REJECTED (42501)
    await asUser(db, teacherInactive, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compId}'::uuid, 'approve');
        `);
      }, /Caller account is inactive or not found/);
    });

    // 12g. Teacher with revoked capability (can_manage_tasks = false) verifying homework -> REJECTED (42501)
    await asUser(db, teacherNoPerm, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compId}'::uuid, 'approve');
        `);
      }, /Teacher lacks task management permission/);
    });

    // 12h. Teacher verifying homework after student is reassigned away from roster -> REJECTED (42501)
    await db.query(`
      DELETE FROM public.teacher_student_assignments
      WHERE teacher_id = '${teacherActive}' AND student_id = '${studentActive}';
    `);
    await asUser(db, teacherActive, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.verify_homework_completion('${compId}'::uuid, 'approve');
        `);
      }, /You are not authorized to verify this student's homework/);
    });
  });

  it('13. Preserve message RPC guarantees: strict nonce comparison and advisory lock', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const admin = 'aaaaaaaa-0000-0000-0000-000000000001';
    const student1 = 'aaaaaaaa-0000-0000-0000-000000000002';
    const student2 = 'aaaaaaaa-0000-0000-0000-000000000003';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, active) VALUES
        ('${admin}', 'ADM-1', 'Admin Boss', 'admin', true),
        ('${student1}', 'STU-1', 'Student One', 'student', true),
        ('${student2}', 'STU-2', 'Student Two', 'student', true);
    `);

    // 13a. Send message with nonce 'nonce-xyz'
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${student1}'::uuid,
          'Original Title',
          'Original Body',
          false,
          NULL,
          NULL,
          NULL,
          'nonce-xyz'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
    });

    // 13b. Retry with IDENTICAL parameters -> returns existing message
    await asUser(db, admin, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.admin_send_student_message(
          '${student1}'::uuid,
          'Original Title',
          'Original Body',
          false,
          NULL,
          NULL,
          NULL,
          'nonce-xyz'
        ) AS res;
      `);
      assert.equal(rows[0].res.success, true);
    });

    // 13c. Reuse nonce with DIFFERENT recipient -> REJECTED with 23505
    await asUser(db, admin, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message(
            '${student2}'::uuid,
            'Original Title',
            'Original Body',
            false,
            NULL,
            NULL,
            NULL,
            'nonce-xyz'
          );
        `);
      }, /Nonce reuse detected/);
    });

    // 13d. Reuse nonce with DIFFERENT title/body -> REJECTED with 23505
    await asUser(db, admin, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.admin_send_student_message(
            '${student1}'::uuid,
            'Different Title',
            'Original Body',
            false,
            NULL,
            NULL,
            NULL,
            'nonce-xyz'
          );
        `);
      }, /Nonce reuse detected/);
    });
  });

  it('14. Authoritative session binding: unbound session, cross-assignment replay, result ownership, flash speed', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-aaaa-bbbb-cccc-111111111111';
    const student = '22222222-aaaa-bbbb-cccc-222222222222';
    const catAdd = '33333333-aaaa-bbbb-cccc-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-14', 'Teacher Fourteen', 'teacher', NULL, true),
        ('${student}', 'STU-14', 'Student Fourteen', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacher}', '${student}');

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catAdd}', 'Addition 60s', 'basics', 1);
    `);

    // Create Homework A (Basics) and Homework B (Basics)
    let hwA = null;
    let hwB = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows: rA } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, category_id, duration_seconds, required_count)
        VALUES ('Homework A', '${teacher}', 'student', '${student}', 'basics', '${catAdd}', 60, 1)
        RETURNING id;
      `);
      hwA = rA[0].id;
      const { rows: rB } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, category_id, duration_seconds, required_count)
        VALUES ('Homework B', '${teacher}', 'student', '${student}', 'basics', '${catAdd}', 60, 1)
        RETURNING id;
      `);
      hwB = rB[0].id;
    });

    const resValid = 'cccccccc-0000-0000-0000-000000000001';
    const resOther = 'cccccccc-0000-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified) VALUES
        ('${resValid}', '${student}', '${catAdd}', 20, 20, 60, true),
        ('${resOther}', '${student}', '${catAdd}', 18, 18, 60, true);
    `);

    // 14a. Unbound session (missing homework_id in settings) -> REJECTED (22023)
    const sessUnbound = 'bbbbbbbb-0000-0000-0000-000000000001';
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessUnbound}', '${student}', 'basics', 'submitted', '{"category_id": "${catAdd}", "duration_seconds": 60}'::jsonb, now(), '${resValid}');
    `);
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwA}'::uuid, '${sessUnbound}'::uuid);
        `);
      }, /Session is not bound to this homework assignment/);
    });

    // 14b. Cross-assignment replay: Session bound to Homework A submitted for Homework B -> REJECTED (22023)
    const sessBoundA = 'bbbbbbbb-0000-0000-0000-000000000002';
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessBoundA}', '${student}', 'basics', 'submitted', '{"category_id": "${catAdd}", "duration_seconds": 60, "homework_id": "${hwA}"}'::jsonb, now(), '${resValid}');
    `);
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwB}'::uuid, '${sessBoundA}'::uuid);
        `);
      }, /Session is not bound to this homework assignment/);
    });

    // 14c. Unrelated result ID: Passed result ID does not match session's result -> REJECTED
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwA}'::uuid, '${sessBoundA}'::uuid, '${resOther}'::uuid);
        `);
      }, /Result ID does not match the session result/);
    });

    // 14d. Flash homework with speed enforcement
    let hwFlash = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, settings)
        VALUES ('Flash 2d 5n 500ms', '${teacher}', 'student', '${student}', 'flash', '{"digits": 2, "count": 5, "mode": "add", "speed_ms": 500}'::jsonb)
        RETURNING id;
      `);
      hwFlash = rows[0].id;
    });

    // Session has speed_ms 1000 instead of 500
    const resFlash = 'cccccccc-0000-0000-0000-000000000003';
    const sessFlashSlow = 'bbbbbbbb-0000-0000-0000-000000000003';
    await db.exec(`
      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, time_seconds) VALUES
        ('${resFlash}', '${student}', 'flash_anzan', 'Flash 2d 5n', 1, 1, 5);
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at, result_id) VALUES
        ('${sessFlashSlow}', '${student}', 'flash_anzan', 'submitted',
         '{"digits": 2, "count": 5, "mode": "add", "speed_ms": 1000, "homework_id": "${hwFlash}"}'::jsonb, now(), '${resFlash}');
    `);
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwFlash}'::uuid, '${sessFlashSlow}'::uuid);
        `);
      }, /Flash speed does not match assigned homework/);
    });

    // 14e. Starting flash session with homework_id via flash_start freezes homework settings
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.flash_start('{"homework_id": "${hwFlash}", "speed_ms": 3000, "count": 20}'::jsonb) AS res;
      `);
      const res = rows[0].res;
      assert.ok(res.session_id);
      assert.equal(res.settings.speed_ms, 500, 'Freezes speed_ms from homework settings, ignoring client spoofing');
      assert.equal(res.settings.count, 5, 'Freezes count from homework settings, ignoring client spoofing');
      assert.equal(res.settings.homework_id, hwFlash);
    });
  });

  it('15. Main Round JMCWC attempt model: attempt validation, ownership, unsubmitted rejection, replay protection', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-aaaa-bbbb-cccc-111111111111';
    const student1 = '22222222-aaaa-bbbb-cccc-222222222222';
    const student2 = '33333333-aaaa-bbbb-cccc-333333333333';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-15', 'Teacher Fifteen', 'teacher', NULL, true),
        ('${student1}', 'STU-15A', 'Student 15A', 'student', 'Level 2', true),
        ('${student2}', 'STU-15B', 'Student 15B', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacher}', '${student1}'),
        ('${teacher}', '${student2}');
    `);

    // Create Main Round Homework requiring 2 competition attempts
    let hwRound = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, settings, required_count)
        VALUES ('Compete in JMCWC Simulator', '${teacher}', 'student', '${student1}', 'round', '{"group_key": "group_a"}'::jsonb, 2)
        RETURNING id;
      `);
      hwRound = rows[0].id;
    });

    const attValid1 = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
    const attValid2 = 'aaaaaaaa-1111-1111-1111-bbbbbbbbbbbb';
    const attUnbound = 'aaaaaaaa-1111-1111-1111-cccccccccccc';
    const attUnsubmitted = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
    const attStudent2 = 'aaaaaaaa-3333-3333-3333-aaaaaaaaaaaa';

    // Seed attempts with real bootstrap columns only: NO started_at, NO settings
    await db.exec(`
      INSERT INTO public.jmcwc_attempts (id, student_id, group_key, mode, category_key, status, active_ms, target_seconds, created_at) VALUES
        ('${attValid1}', '${student1}', 'group_a', 'flat', NULL, 'submitted', 3600000, NULL, now()),
        ('${attValid2}', '${student1}', 'group_a', 'flat', NULL, 'submitted', 3600000, NULL, now()),
        ('${attUnbound}', '${student1}', 'group_a', 'flat', NULL, 'submitted', 3600000, NULL, now()),
        ('${attUnsubmitted}', '${student1}', 'group_a', 'flat', NULL, 'running', 1000000, NULL, now()),
        ('${attStudent2}', '${student2}', 'group_a', 'flat', NULL, 'submitted', 3600000, NULL, now());
    `);

    // 15a. Unbound attempt -> REJECTED (22023) because it was not started for this homework
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attUnbound}'::uuid);
        `);
      }, /Competition attempt was not started for this homework assignment/);
    });

    // 15a-2. Reject student-created link directly
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwRound}'::uuid, '${attValid1}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // Server creates link when starting session for this assignment
    await db.query(`SELECT public.bind_homework_session('${hwRound}'::uuid, '${attValid1}'::uuid);`);
    await db.query(`SELECT public.bind_homework_session('${hwRound}'::uuid, '${attValid2}'::uuid);`);
    await db.query(`SELECT public.bind_homework_session('${hwRound}'::uuid, '${attUnsubmitted}'::uuid);`);

    // Valid start retry: Returns success if existing link matches
    const { rows: retryBind } = await db.query(`SELECT public.bind_homework_session('${hwRound}'::uuid, '${attValid1}'::uuid) AS res;`);
    assert.equal(retryBind[0].res.success, true);
    assert.equal(retryBind[0].res.is_retry, true);

    // 15b. Unsubmitted attempt -> REJECTED (22023)
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attUnsubmitted}'::uuid);
        `);
      }, /Cannot credit an unsubmitted competition attempt/);
    });

    // 15c. Attempt of another student -> REJECTED (42501)
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attStudent2}'::uuid);
        `);
      }, /Competition attempt belongs to another student/);
    });

    // 15d. Valid attempt 1 -> APPROVED, progress becomes 1 of 2, status remains in_progress
    await asUser(db, student1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attValid1}'::uuid) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.status, 'in_progress');
      assert.equal(rows[0].res.progress_count, 1);
    });

    // 15e. Replay attempt 1 on same assignment -> REJECTED (23505)
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attValid1}'::uuid);
        `);
      }, /already been submitted for this homework/);
    });

    // 15f. Cross-assignment reuse: crediting attValid1 to another assignment hwRound2 -> REJECTED (23505)
    let hwRound2 = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, settings, required_count)
        VALUES ('Another JMCWC Round', '${teacher}', 'student', '${student1}', 'round', '{"group_key": "group_a"}'::jsonb, 1)
        RETURNING id;
      `);
      hwRound2 = rows[0].id;
    });

    // Binding attempt 1 to second assignment is blocked by existing link mismatch
    await assert.rejects(async () => {
      await db.query(`SELECT public.bind_homework_session('${hwRound2}'::uuid, '${attValid1}'::uuid);`);
    }, /already bound to another homework assignment/);

    // Direct submit of attempt 1 to second assignment is blocked by cross-assignment replay check
    await asUser(db, student1, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwRound2}'::uuid, '${attValid1}'::uuid);
        `);
      }, /not started for this homework assignment|already been credited to another homework assignment/);
    });

    // 15g. Valid attempt 2 -> APPROVED, progress becomes 2 of 2, status transitions to completed
    await asUser(db, student1, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${hwRound}'::uuid, '${attValid2}'::uuid) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.status, 'completed');
      assert.equal(rows[0].res.progress_count, 2);
    });
  });

  it('16. Fail-closed resolveAndValidateHomework & Memoriad setting freezing', async () => {
    const studentObj = { id: '44444444-aaaa-bbbb-cccc-444444444444', level: 'Level 3' };
    const validHwId = '55555555-aaaa-bbbb-cccc-555555555555';

    // 16a. When RPC returns error -> strictly fails closed (500), NO fallback to target_type='all'
    const mockSupabaseError = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: validHwId,
                activity_type: 'basics',
                target_type: 'all',
                settings: {},
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: null, error: new Error('PostgreSQL RPC connection failure') }),
    };

    const resErr = await resolveAndValidateHomework(mockSupabaseError, validHwId, studentObj, 'basics');
    assert.equal(resErr.ok, false);
    assert.equal(resErr.statusCode, 500);
    assert.match(resErr.error, /Database error validating homework recipient/);

    // 16b. When RPC throws an exception -> strictly fails closed (500), NO fallback
    const mockSupabaseThrows = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: validHwId,
                activity_type: 'basics',
                target_type: 'all',
                settings: {},
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => { throw new Error('Network timeout in RPC execution'); },
    };

    const resThrow = await resolveAndValidateHomework(mockSupabaseThrows, validHwId, studentObj, 'basics');
    assert.equal(resThrow.ok, false);
    assert.equal(resThrow.statusCode, 500);

    // 16c. When RPC returns null / malformed -> strictly fails closed (500)
    const mockSupabaseMalformed = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: validHwId,
                activity_type: 'basics',
                target_type: 'all',
                settings: {},
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: null, error: null }),
    };

    const resMalformed = await resolveAndValidateHomework(mockSupabaseMalformed, validHwId, studentObj, 'basics');
    assert.equal(resMalformed.ok, false);
    assert.equal(resMalformed.statusCode, 500);
    assert.match(resMalformed.error, /Malformed response validating homework recipient/);

    // 16d. When RPC returns explicit false -> access denied (403), even if target_type='all'
    const mockSupabaseDenied = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: validHwId,
                activity_type: 'basics',
                target_type: 'all',
                settings: {},
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: false, error: null }),
    };

    const resDenied = await resolveAndValidateHomework(mockSupabaseDenied, validHwId, studentObj, 'basics');
    assert.equal(resDenied.ok, false);
    assert.equal(resDenied.statusCode, 403);
    assert.match(resDenied.error, /Access denied/);

    // 16e. When RPC returns true -> access granted
    const mockSupabaseGranted = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: validHwId,
                activity_type: 'basics',
                target_type: 'all',
                settings: {},
              },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async () => ({ data: true, error: null }),
    };

    const resGranted = await resolveAndValidateHomework(mockSupabaseGranted, validHwId, studentObj, 'basics');
    assert.equal(resGranted.ok, true);
    assert.equal(resGranted.homework.id, validHwId);

    // 16f. Memoriad settings freezing: Calendar 25 assignment with conflicting client request (125 dates)
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-aaaa-bbbb-cccc-111111111111';
    const student = '22222222-aaaa-bbbb-cccc-222222222222';
    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-16', 'Teacher 16', 'teacher', NULL, true),
        ('${student}', 'STU-16', 'Student 16', 'student', 'Level 2', true);
      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacher}', '${student}');
    `);

    let hwCal25 = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, settings, duration_seconds, required_count)
        VALUES ('Calendar 25 Sprint', '${teacher}', 'student', '${student}', 'memoriad', '{"module": "calendar", "dates": 25}'::jsonb, 60, 1)
        RETURNING id;
      `);
      hwCal25 = rows[0].id;
    });

    // Create session that attempts 125 dates (mismatch)
    const sess125 = '66666666-aaaa-bbbb-cccc-666666666666';
    const sess25 = '77777777-aaaa-bbbb-cccc-777777777777';
    const actRes25 = '88888888-aaaa-bbbb-cccc-888888888888';

    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, activity_name, settings, status, started_at) VALUES
        ('${sess125}', '${student}', 'memoriad', 'Calendar', '{"module": "calendar", "dates": 125, "homework_id": "${hwCal25}"}'::jsonb, 'submitted', now()),
        ('${sess25}', '${student}', 'memoriad', 'Calendar', '{"module": "calendar", "dates": 25, "homework_id": "${hwCal25}"}'::jsonb, 'submitted', now());

      INSERT INTO public.activity_results (id, student_id, activity_type, activity_name, correct, total, settings, created_at) VALUES
        ('${actRes25}', '${student}', 'memoriad', 'Calendar', 25, 25, '{"score": 25}'::jsonb, now());

      UPDATE public.drill_sessions SET result_id = '${actRes25}' WHERE id = '${sess25}';
    `);

    // Submitting sess125 with 125 dates fails because homework requires 25
    await asUser(db, student, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          SELECT public.submit_homework_completion('${hwCal25}'::uuid, '${sess125}'::uuid);
        `);
      }, /Memoriad calendar dates tier does not match assigned homework/);
    });

    // Submitting sess25 with 25 dates and matching result succeeds
    await asUser(db, student, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${hwCal25}'::uuid, '${sess25}'::uuid, NULL, '${actRes25}'::uuid) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.status, 'completed');
    });
  });

  it('17. Practice session homework linking: reject student-created links, zero bad records on failed link, exactly once credit on start and retry', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const teacher = '11111111-aaaa-bbbb-cccc-111111111111';
    const studentA = '22222222-aaaa-bbbb-cccc-222222222222';
    const studentB = '33333333-aaaa-bbbb-cccc-333333333333';
    const catId = '44444444-aaaa-bbbb-cccc-444444444444';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${teacher}', 'TCH-17', 'Teacher Seventeen', 'teacher', NULL, true),
        ('${studentA}', 'STU-17A', 'Student Seventeen A', 'student', 'Level 2', true),
        ('${studentB}', 'STU-17B', 'Student Seventeen B', 'student', 'Level 2', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacher}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES
        ('${teacher}', '${studentA}');

      INSERT INTO public.categories (id, name, section, sort_order) VALUES
        ('${catId}', 'Addition 60s', 'basics', 1);
    `);

    // Create Homework targeting studentA only
    let hwId = null;
    await asUser(db, teacher, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, category_id, duration_seconds, required_count)
        VALUES ('Basics Homework 17', '${teacher}', 'student', '${studentA}', 'basics', '${catId}', 60, 1)
        RETURNING id;
      `);
      hwId = rows[0].id;
    });

    const sessValid = 'aaaaaaaa-1717-1717-1717-aaaaaaaaaaaa';
    const sessUnauthorized = 'bbbbbbbb-1717-1717-1717-bbbbbbbbbbbb';
    const sessFreePractice = 'cccccccc-1717-1717-1717-cccccccccccc';

    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at) VALUES
        ('${sessValid}', '${studentA}', 'basics', 'open', '{"category_id": "${catId}", "duration_seconds": 60, "homework_id": "${hwId}"}'::jsonb, now()),
        ('${sessUnauthorized}', '${studentB}', 'basics', 'open', '{"category_id": "${catId}", "duration_seconds": 60, "homework_id": "${hwId}"}'::jsonb, now()),
        ('${sessFreePractice}', '${studentA}', 'basics', 'open', '{"category_id": "${catId}", "duration_seconds": 60}'::jsonb, now());
    `);

    // --- 17a. Reject student-created links ---
    await asUser(db, studentA, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessValid}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // Direct INSERT into homework_bound_sessions by authenticated student is blocked by RLS
    await asUser(db, studentA, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`
          INSERT INTO public.homework_bound_sessions (assignment_id, student_id, session_id)
          VALUES ('${hwId}', '${studentA}', '${sessValid}');
        `);
      }, /permission denied|violates row-level security policy/);
    });

    // --- 17b. Leaving no bad records after a failed link ---
    // 1. Non-existent session
    const nonExistentSession = '99999999-9999-9999-9999-999999999999';
    await assert.rejects(async () => {
      await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${nonExistentSession}'::uuid);`);
    }, /does not exist/);

    // 2. Unauthorized student's session (studentB is not recipient of hwId)
    await assert.rejects(async () => {
      await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessUnauthorized}'::uuid);`);
    }, /not an authorized recipient/);

    // 3. Free practice session not started for this exact homework
    await assert.rejects(async () => {
      await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessFreePractice}'::uuid);`);
    }, /Session was not started for this homework assignment/);

    // Simulate cleanup: clean up the unauthorized session as done in drill.js / memoriad.js / jmcwcServer.js
    await db.query(`DELETE FROM public.drill_sessions WHERE id = '${sessUnauthorized}';`);

    // Verify ZERO bad records remain in drill_sessions, homework_bound_sessions, or homework_completions
    const { rows: leftDrills } = await db.query(`SELECT * FROM public.drill_sessions WHERE id = '${sessUnauthorized}';`);
    assert.equal(leftDrills.length, 0, 'No orphaned drill_session record after failed link');

    const { rows: leftBounds } = await db.query(`SELECT * FROM public.homework_bound_sessions WHERE session_id IN ('${nonExistentSession}', '${sessUnauthorized}', '${sessFreePractice}');`);
    assert.equal(leftBounds.length, 0, 'No bad homework_bound_sessions records after failed links');

    const { rows: leftComps } = await db.query(`SELECT * FROM public.homework_completions WHERE student_id = '${studentB}';`);
    assert.equal(leftComps.length, 0, 'No completion records created for failed student');

    // --- 17c. Awarding credit exactly once after a valid start and retry ---
    // Initial start: server creates the link
    const { rows: startRows } = await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessValid}'::uuid) AS res;`);
    assert.equal(startRows[0].res.success, true);
    assert.equal(startRows[0].res.is_retry, false);

    // Server retries the start (idempotent replay): succeeds because existing link matches
    const { rows: retryRows } = await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessValid}'::uuid) AS res;`);
    assert.equal(retryRows[0].res.success, true);
    assert.equal(retryRows[0].res.is_retry, true);

    // Verify homework_bound_sessions has exactly 1 record (no duplicate rows)
    const { rows: boundRows } = await db.query(`SELECT * FROM public.homework_bound_sessions WHERE session_id = '${sessValid}';`);
    assert.equal(boundRows.length, 1);

    // Student completes the session
    const resId = '55555555-aaaa-aaaa-aaaa-555555555555';
    await db.exec(`
      INSERT INTO public.results (id, student_id, category_id, correct, total, time_seconds, verified)
      VALUES ('${resId}', '${studentA}', '${catId}', 25, 25, 60, true);

      UPDATE public.drill_sessions
      SET status = 'submitted', result_id = '${resId}'
      WHERE id = '${sessValid}';
    `);

    // Student submits homework completion: credit awarded (progress = 1)
    await asUser(db, studentA, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${hwId}'::uuid, '${sessValid}'::uuid) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.status, 'completed');
      assert.equal(rows[0].res.progress_count, 1);
    });

    // Student or client retries submission: returns already_completed and progress remains 1
    await asUser(db, studentA, 'authenticated', async () => {
      const { rows } = await db.query(`
        SELECT public.submit_homework_completion('${hwId}'::uuid, '${sessValid}'::uuid) AS res;
      `);
      assert.equal(rows[0].res.success, true);
      assert.equal(rows[0].res.already_completed, true);
      assert.equal(rows[0].res.progress_count, 1);
    });

    // Verify progress count in DB is still exactly 1 (credit awarded exactly once)
    const { rows: finalComp } = await db.query(`
      SELECT status, progress_count FROM public.homework_completions
      WHERE assignment_id = '${hwId}' AND student_id = '${studentA}';
    `);
    assert.equal(finalComp[0].status, 'completed');
    assert.equal(finalComp[0].progress_count, 1, 'Credit awarded exactly once after start and retry');
  });

  it('18. bind_homework_session permissions: callable only by trusted server role; reject authenticated students, staff, and accounts without profiles', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const adminId = '11111111-1818-1818-1818-111111111111';
    const teacherId = '22222222-1818-1818-1818-222222222222';
    const studentId = '33333333-1818-1818-1818-333333333333';
    const unknownUserId = '44444444-1818-1818-1818-444444444444'; // Authenticated JWT with no profile row

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${adminId}', 'ADM-18', 'Admin 18', 'admin', 'Grandmaster', true),
        ('${teacherId}', 'TCH-18', 'Teacher 18', 'teacher', NULL, true),
        ('${studentId}', 'STU-18', 'Student 18', 'student', 'Level 1', true);

      INSERT INTO public.teacher_permissions (teacher_id, can_manage_tasks) VALUES ('${teacherId}', true);
      INSERT INTO public.teacher_student_assignments (teacher_id, student_id) VALUES ('${teacherId}', '${studentId}');
    `);

    // Create an assignment
    let hwId = null;
    await asUser(db, adminId, 'authenticated', async () => {
      const { rows } = await db.query(`
        INSERT INTO public.homework_assignments (title, assigned_by, target_type, target_student_id, activity_type, settings, duration_seconds, required_count)
        VALUES ('Multiplication Drill', '${adminId}', 'student', '${studentId}', 'basics', '{"duration_seconds": 60}'::jsonb, 60, 1)
        RETURNING id;
      `);
      hwId = rows[0].id;
    });

    const sessId = '55555555-1818-1818-1818-555555555555';
    await db.exec(`
      INSERT INTO public.drill_sessions (id, student_id, activity_type, status, settings, started_at)
      VALUES ('${sessId}', '${studentId}', 'basics', 'open', '{"duration_seconds": 60, "homework_id": "${hwId}"}'::jsonb, now());
    `);

    // 18a. Authenticated student caller -> REJECTED
    await asUser(db, studentId, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // 18b. Authenticated staff caller (Teacher) -> REJECTED
    await asUser(db, teacherId, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // 18c. Authenticated staff caller (Admin) -> REJECTED
    await asUser(db, adminId, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // 18d. Authenticated account without profile -> REJECTED
    await asUser(db, unknownUserId, 'authenticated', async () => {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid);`);
      }, /permission denied for function bind_homework_session|Access denied: bind_homework_session can only be executed by the trusted server role/);
    });

    // 18e. Non-service-role caller executing directly with active auth.uid() -> REJECTED
    await db.exec(`SET app.current_user_id = '${adminId}'; SET app.current_jwt_role = 'authenticated';`);
    try {
      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid);`);
      }, /Access denied: bind_homework_session can only be executed by the trusted server role/);
    } finally {
      await db.exec(`SET app.current_user_id = ''; SET app.current_jwt_role = '';`);
    }

    // 18f. Trusted server role (service_role without user JWT) -> SUCCEEDS!
    await db.exec(`SET app.current_jwt_role = 'service_role'; SET ROLE service_role;`);
    try {
      const { rows } = await db.query(`SELECT public.bind_homework_session('${hwId}'::uuid, '${sessId}'::uuid) AS res;`);
      assert.equal(rows[0].res.success, true);

      // Verify row inserted in homework_bound_sessions
      const { rows: boundRows } = await db.query(`SELECT * FROM public.homework_bound_sessions WHERE session_id = '${sessId}';`);
      assert.equal(boundRows.length, 1);
      assert.equal(boundRows[0].assignment_id, hwId);
      assert.equal(boundRows[0].student_id, studentId);

      // Re-binding to a different assignment fails with unique constraint (23505)
      const otherHwId = '66666666-1818-1818-1818-666666666666';
      await db.exec(`
        INSERT INTO public.homework_assignments (id, title, assigned_by, target_type, target_student_id, activity_type, settings, duration_seconds, required_count)
        VALUES ('${otherHwId}', 'Another Drill', '${adminId}', 'student', '${studentId}', 'basics', '{"duration_seconds": 60}'::jsonb, 60, 1);
      `);

      await assert.rejects(async () => {
        await db.query(`SELECT public.bind_homework_session('${otherHwId}'::uuid, '${sessId}'::uuid);`);
      }, /Session was not started for this homework assignment|This session is already bound to another homework assignment|duplicate key value violates unique constraint/);
    } finally {
      await db.exec(`RESET ROLE; SET app.current_jwt_role = '';`);
    }
  });

  it('19. Main Round actual start endpoint: atomic attempt creation, idempotent matching retry, mismatched retry rejection, and binding failure leaving no partial records', async () => {
    const db = await setupBaseStagingDb();
    const hwSql = fs.readFileSync(path.join(ROOT_DIR, 'supabase', 'staging_homework_feature.sql'), 'utf8');
    await db.exec(`SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh'; ${hwSql}`);

    const adminId = '11111111-1919-1919-1919-111111111111';
    const student1 = '22222222-1919-1919-1919-222222222222';
    const student2 = '33333333-1919-1919-1919-333333333333';
    const paperId = '44444444-1919-1919-1919-444444444444';

    const tokenStudent1 = 'token-student-19-1';

    await db.exec(`
      INSERT INTO public.profiles (id, student_code, full_name, role, level, active) VALUES
        ('${adminId}', 'ADM-19', 'Admin 19', 'admin', 'Grandmaster', true),
        ('${student1}', 'STU-19-1', 'Student 19-1', 'student', 'Senior', true),
        ('${student2}', 'STU-19-2', 'Student 19-2', 'student', 'Senior', true);

      INSERT INTO public.jmcwc_assignments (student_id, group_key) VALUES
        ('${student1}', 'junior1'),
        ('${student2}', 'junior1');
    `);

    // Insert published paper for junior1
    const paperSpec = JMCWC_PAPERS.junior1.spec;
    await db.query(
      `INSERT INTO public.jmcwc_papers (id, group_key, version, spec, published) VALUES ($1, $2, $3, $4::jsonb, true);`,
      [paperId, 'junior1', '2026.1', JSON.stringify(paperSpec)]
    );

    // Homework 1 assigned to Student 1
    const hw1Id = 'aaaaaaaa-1919-1919-1919-aaaaaaaaaaaa';
    // Homework 2 assigned ONLY to Student 2 (Student 1 is NOT a recipient)
    const hw2Id = 'bbbbbbbb-1919-1919-1919-bbbbbbbbbbbb';
    // Homework 3 assigned to Student 1
    const hw3Id = 'cccccccc-1919-1919-1919-cccccccccccc';

    await db.exec(`
      INSERT INTO public.homework_assignments (id, title, assigned_by, target_type, target_student_id, activity_type, settings, duration_seconds, required_count) VALUES
        ('${hw1Id}', 'JMCWC Round 1', '${adminId}', 'student', '${student1}', 'round', '{"group_key": "junior1"}'::jsonb, NULL, 1),
        ('${hw2Id}', 'JMCWC Round 2 for Student 2', '${adminId}', 'student', '${student2}', 'round', '{"group_key": "junior1"}'::jsonb, NULL, 1),
        ('${hw3Id}', 'JMCWC Round 3', '${adminId}', 'student', '${student1}', 'round', '{"group_key": "junior1"}'::jsonb, NULL, 1);
    `);

    // Build PGlite-backed Supabase adapter for createJmcwcServer
    let simulateLookupError = false;
    const userTokens = new Map([[tokenStudent1, student1]]);
    const pgliteSupabase = {
      auth: {
        async getUser(token) {
          const uid = userTokens.get(token);
          if (!uid) return { data: { user: null }, error: new Error('Invalid token') };
          return { data: { user: { id: uid } }, error: null };
        },
      },
      async rpc(fnName, args = {}) {
        if (fnName === 'jmcwc_check_student') {
          try {
            const { rows } = await db.query(
              `SELECT public.jmcwc_check_student($1::uuid) AS res;`,
              [args.p_student]
            );
            return { data: rows[0]?.res ?? null, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        }
        if (fnName === 'jmcwc_create_attempt') {
          try {
            if ('p_homework_id' in args && args.p_homework_id !== undefined && args.p_homework_id !== null) {
              const { rows } = await db.query(
                `SELECT public.jmcwc_create_attempt($1, $2, $3, $4, $5, $6::jsonb, $7) AS id;`,
                [
                  args.p_student,
                  args.p_request,
                  args.p_paper,
                  args.p_mode,
                  args.p_category,
                  JSON.stringify(args.p_questions),
                  args.p_homework_id,
                ]
              );
              return { data: rows[0].id, error: null };
            } else {
              const { rows } = await db.query(
                `SELECT public.jmcwc_create_attempt($1, $2, $3, $4, $5, $6::jsonb) AS id;`,
                [
                  args.p_student,
                  args.p_request,
                  args.p_paper,
                  args.p_mode,
                  args.p_category,
                  JSON.stringify(args.p_questions),
                ]
              );
              return { data: rows[0].id, error: null };
            }
          } catch (err) {
            return { data: null, error: err };
          }
        }
        if (fnName === 'is_student_homework_recipient') {
          try {
            const { rows } = await db.query(
              `SELECT public.is_student_homework_recipient($1::uuid, $2::uuid) AS res;`,
              [args.p_assignment_id, args.p_student_id]
            );
            return { data: rows[0]?.res ?? false, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        }
        if (fnName === 'bind_homework_session') {
          try {
            const { rows } = await db.query(
              `SELECT public.bind_homework_session($1::uuid, $2::uuid) AS res;`,
              [args.p_assignment_id, args.p_session_id]
            );
            return { data: rows[0]?.res ?? true, error: null };
          } catch (err) {
            return { data: null, error: err };
          }
        }
        return { data: null, error: new Error(`Unknown rpc: ${fnName}`) };
      },
      from(tableName) {
        if (tableName === 'homework_bound_sessions' && simulateLookupError) {
          const errBuilder = {
            select() { return errBuilder; },
            eq() { return errBuilder; },
            order() { return errBuilder; },
            limit() { return errBuilder; },
            maybeSingle() {
              return Promise.resolve({ data: null, error: new Error('Simulated database connection failure during lookup') });
            },
            single() {
              return Promise.resolve({ data: null, error: new Error('Simulated database connection failure during lookup') });
            },
            then(resolve, reject) {
              const res = { data: null, error: new Error('Simulated database connection failure during lookup') };
              return resolve ? resolve(res) : (reject ? reject(res.error) : res);
            }
          };
          return errBuilder;
        }

        let selectedCols = '*';
        const filters = [];
        let orderClause = '';
        let limitCount = null;

        const builder = {
          select(cols = '*') {
            selectedCols = cols;
            return builder;
          },
          eq(col, val) {
            filters.push({ col, val });
            return builder;
          },
          order(col, { ascending = true } = {}) {
            orderClause = `ORDER BY ${col} ${ascending ? 'ASC' : 'DESC'}`;
            return builder;
          },
          limit(n) {
            limitCount = n;
            return builder;
          },
          async maybeSingle() {
            const { data, error } = await builder.then();
            if (error) return { data: null, error };
            return { data: (data && data.length > 0) ? data[0] : null, error: null };
          },
          async single() {
            const { data, error } = await builder.then();
            if (error) return { data: null, error };
            if (!data || data.length === 0) {
              const err = new Error('Row not found');
              err.code = 'PGRST116';
              return { data: null, error: err };
            }
            return { data: data[0], error: null };
          },
          then(resolve, reject) {
            let whereStr = '';
            const params = [];
            if (filters.length > 0) {
              whereStr = 'WHERE ' + filters.map((f, i) => {
                params.push(f.val);
                return `"${f.col}" = $${i + 1}`;
              }).join(' AND ');
            }
            let sql = `SELECT ${selectedCols} FROM public."${tableName}" ${whereStr}`;
            if (orderClause) sql += ` ${orderClause}`;
            if (limitCount != null) sql += ` LIMIT ${limitCount}`;

            return db.query(sql, params)
              .then(res => {
                if (res.rows) {
                  for (const r of res.rows) {
                    if (r.spec && typeof r.spec === 'string') {
                      try { r.spec = JSON.parse(r.spec); } catch {}
                    }
                    if (r.settings && typeof r.settings === 'string') {
                      try { r.settings = JSON.parse(r.settings); } catch {}
                    }
                    if (r.questions && typeof r.questions === 'string') {
                      try { r.questions = JSON.parse(r.questions); } catch {}
                    }
                  }
                }
                const result = { data: res.rows, error: null };
                return resolve ? resolve(result) : result;
              })
              .catch(err => {
                const result = { data: null, error: err };
                return resolve ? resolve(result) : (reject ? reject(err) : result);
              });
          },
          delete() {
            return {
              eq(col, val) {
                return db.query(`DELETE FROM public."${tableName}" WHERE "${col}" = $1;`, [val])
                  .then(res => ({ data: res.rows, error: null }))
                  .catch(err => ({ data: null, error: err }));
              }
            };
          }
        };
        return builder;
      }
    };

    const handler = createJmcwcServer({
      getSupabaseAdmin: () => pgliteSupabase,
      seedGenerator: () => 202611,
    });

    const callEndpoint = async ({ token = tokenStudent1, body = {} } = {}) => {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      let statusCode = 200;
      let jsonPayload = null;
      const req = { method: 'POST', url: '/api/jmcwc', headers, body };
      const res = {
        setHeader() { return this; },
        status(code) { statusCode = code; return this; },
        json(payload) { jsonPayload = payload; return this; },
        end() { return this; },
      };
      await handler(req, res);
      return { status: statusCode, body: jsonPayload };
    };

    // -------------------------------------------------------------------------
    // 19a. Ordinary Practice Start (no homework - exercises 6-arg jmcwc_create_attempt)
    // -------------------------------------------------------------------------
    const reqIdPractice = crypto.randomUUID();
    const resPractice = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqIdPractice,
      },
    });

    assert.equal(resPractice.status, 200);
    assert.equal(resPractice.body?.idempotent_replay, false);
    assert.ok(resPractice.body?.attempt?.id);
    const practiceAttemptId = resPractice.body.attempt.id;

    // Verify database state: exactly 1 attempt, 1 payload, and ZERO bound sessions
    const { rows: attPracticeRows } = await db.query(
      `SELECT id, student_id, request_id FROM public.jmcwc_attempts WHERE request_id = '${reqIdPractice}';`
    );
    assert.equal(attPracticeRows.length, 1);
    assert.equal(attPracticeRows[0].id, practiceAttemptId);

    const { rows: payPracticeRows } = await db.query(
      `SELECT attempt_id FROM public.jmcwc_payloads WHERE attempt_id = '${practiceAttemptId}';`
    );
    assert.equal(payPracticeRows.length, 1);

    const { rows: boundPracticeRows } = await db.query(
      `SELECT * FROM public.homework_bound_sessions WHERE session_id = '${practiceAttemptId}';`
    );
    assert.equal(boundPracticeRows.length, 0, 'Ordinary practice must not create a homework_bound_sessions entry');

    // Matching practice retry: returns 200 with idempotent_replay
    const resPracticeRetry = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqIdPractice,
      },
    });
    assert.equal(resPracticeRetry.status, 200);
    assert.equal(resPracticeRetry.body?.idempotent_replay, true);
    assert.equal(resPracticeRetry.body?.attempt?.id, practiceAttemptId);

    // Practice retry with homework attached: rejected with 409 HOMEWORK_LINK_FAILED
    const resPracticeMismatch = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqIdPractice,
        homework_id: hw1Id,
      },
    });
    assert.equal(resPracticeMismatch.status, 409);
    assert.equal(resPracticeMismatch.body?.code, 'HOMEWORK_LINK_FAILED');

    // -------------------------------------------------------------------------
    // 19b. Homework Start with assigned Homework 1 (exercises 7-arg jmcwc_create_attempt)
    // -------------------------------------------------------------------------
    const reqId1 = crypto.randomUUID();
    const resNormal = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqId1,
        homework_id: hw1Id,
      },
    });

    assert.equal(resNormal.status, 200);
    assert.equal(resNormal.body?.idempotent_replay, false);
    assert.ok(resNormal.body?.attempt?.id);
    const createdAttemptId = resNormal.body.attempt.id;

    // Verify database state: exactly 1 attempt, 1 payload, and 1 bound session
    const { rows: attRows1 } = await db.query(`SELECT id, student_id, request_id FROM public.jmcwc_attempts WHERE request_id = '${reqId1}';`);
    assert.equal(attRows1.length, 1);
    assert.equal(attRows1[0].id, createdAttemptId);

    const { rows: payRows1 } = await db.query(`SELECT attempt_id FROM public.jmcwc_payloads WHERE attempt_id = '${createdAttemptId}';`);
    assert.equal(payRows1.length, 1);

    const { rows: boundRows1 } = await db.query(`SELECT * FROM public.homework_bound_sessions WHERE session_id = '${createdAttemptId}';`);
    assert.equal(boundRows1.length, 1);
    assert.equal(boundRows1[0].assignment_id, hw1Id);
    assert.equal(boundRows1[0].student_id, student1);

    const savedLink = JSON.stringify(boundRows1[0]);
    await db.query('DELETE FROM public.homework_bound_sessions WHERE session_id = $1', [createdAttemptId]);
    await db.query(`
      INSERT INTO public.homework_bound_sessions
      SELECT * FROM jsonb_populate_record(NULL::public.homework_bound_sessions, $1::jsonb)
    `, [savedLink]);

    // Matching Homework retry (same request_id, same homework_id)
    const resRetryMatch = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqId1,
        homework_id: hw1Id,
      },
    });

    assert.equal(resRetryMatch.status, 200);
    assert.equal(resRetryMatch.body?.idempotent_replay, true);
    assert.equal(resRetryMatch.body?.attempt?.id, createdAttemptId);

    // Retry with Different Assignment (same request_id, different homework_id)
    const resRetryMismatch = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqId1,
        homework_id: hw3Id, // Attempt was created for hw1Id!
      },
    });

    assert.equal(resRetryMismatch.status, 409);
    assert.equal(resRetryMismatch.body?.code, 'HOMEWORK_LINK_FAILED');

    // -------------------------------------------------------------------------
    // 19c. Retry Failed Binding Lookup: reports error instead of treating as unbound
    // -------------------------------------------------------------------------
    simulateLookupError = true;
    const resLookupErr = await callEndpoint({
      body: {
        action: 'create',
        mode: 'flat',
        request_id: reqId1,
        homework_id: hw1Id,
      },
    });
    simulateLookupError = false;

    assert.equal(resLookupErr.status, 500);
    assert.equal(resLookupErr.body?.code, 'HOMEWORK_LINK_LOOKUP_FAILED');

    // -------------------------------------------------------------------------
    // 19d. Rollback Test: reaches create transaction and fails at the binding step.
    // Leaves ZERO new attempts, ZERO payloads, and ZERO homework links!
    // -------------------------------------------------------------------------
    const reqIdRollback = crypto.randomUUID();
    const { privateQuestions: rollbackQuestions } = generateQuestionsFromBlueprint(paperSpec, {
      mode: 'flat',
      seed: 202611,
    });
    const payloadCount = async () => (await db.query('SELECT count(*) AS total FROM public.jmcwc_payloads')).rows[0].total;
    const payloadsBeforeRollback = await payloadCount();

    await assert.rejects(async () => {
      // Direct call to 7-argument jmcwc_create_attempt as trusted service_role
      // Target homework hw2Id is assigned to student2, NOT student1!
      await db.query(
        `SELECT public.jmcwc_create_attempt($1, $2, $3, $4, $5, $6::jsonb, $7);`,
        [
          student1,
          reqIdRollback,
          paperId,
          'flat',
          null,
          JSON.stringify(rollbackQuestions),
          hw2Id, // unauthorized homework belonging to student2!
        ]
      );
    }, /Access denied: Student is not an authorized recipient/);

    // CRITICAL ATOMICITY ASSERTION:
    // In-transaction exception inside bind_homework_session aborts the function execution,
    // rolling back the attempt and payload inserts.
    const { rows: attRollbackRows } = await db.query(
      `SELECT * FROM public.jmcwc_attempts WHERE request_id = '${reqIdRollback}';`
    );
    assert.equal(attRollbackRows.length, 0, 'No partial jmcwc_attempts record should remain after binding failure');

    assert.equal(await payloadCount(), payloadsBeforeRollback, 'No partial jmcwc_payloads record should remain after binding failure');

    const { rows: boundRollbackRows } = await db.query(
      `SELECT * FROM public.homework_bound_sessions WHERE assignment_id = '${hw2Id}' AND student_id = '${student1}';`
    );
    assert.equal(boundRollbackRows.length, 0, 'No homework_bound_sessions record should remain after binding failure');
  });
});
