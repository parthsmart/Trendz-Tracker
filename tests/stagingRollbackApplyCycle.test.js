/**
 * Trendz Tracker — Local Apply → Rollback → Reapply Lifecycle Verification
 * File: tests/stagingRollbackApplyCycle.test.js
 *
 * PURPOSE:
 * Tests the exact owner-run staging patch and rollback files through a complete
 * cycle: apply → rollback → reapply against the authoritative staging baseline
 * captured in outputs/streak-review-2026-11-20/staging-prepatch-baseline.json.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const patchSqlPath = path.join(rootDir, 'supabase', 'staging_streak_consolidation_patch.sql');
const rollbackSqlPath = path.join(rootDir, 'supabase', 'staging_streak_consolidation_rollback.sql');
const prereqSqlPath = path.join(rootDir, 'supabase', 'staging_todo_streak_start_prerequisite.sql');

describe('Staging Apply → Rollback → Reapply Lifecycle Verification', () => {
  it('executes full apply → rollback → reapply cycle cleanly against captured baseline', async () => {
    const db = new PGlite();

    // 1. Install baseline captured from xhgzbbkvwojwfbexvcmh
    await db.exec(`
      DO $$
      BEGIN
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
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT,
        aud TEXT DEFAULT 'authenticated',
        role TEXT DEFAULT 'authenticated'
      );

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION public.today_ist() RETURNS DATE AS $$
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE;
      $$ LANGUAGE sql STABLE;

      CREATE TABLE IF NOT EXISTS public.profiles (
        id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        student_code TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin', 'teacher')),
        active BOOLEAN NOT NULL DEFAULT true,
        level TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS public.categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        section TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS public.competition_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by UUID REFERENCES public.profiles(id)
      );

      CREATE TABLE IF NOT EXISTS public.rollout_boundaries (
        feature TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        activated_at TIMESTAMPTZ
      );

      INSERT INTO public.rollout_boundaries (feature, status, activated_at)
      VALUES ('phase19_authoritative_todo', 'active', now())
      ON CONFLICT (feature) DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.daily_tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        section TEXT NOT NULL,
        category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
        level TEXT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        activity_key TEXT,
        required_count INT NOT NULL DEFAULT 1,
        flash_digits SMALLINT,
        flash_count INT,
        flash_speed_ms INT,
        flash_mode TEXT,
        created_by UUID REFERENCES public.profiles(id),
        target_scope TEXT NOT NULL DEFAULT 'all',
        duration_seconds INT NULL
      );

      CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
        task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, student_id)
      );

      CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id uuid, p_student_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.daily_task_recipients
          WHERE task_id = p_task_id AND student_id = p_student_id
        );
      $$;

      CREATE TABLE IF NOT EXISTS public.results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
        round_number INTEGER NULL,
        correct INTEGER NULL CHECK (correct >= 0),
        total INTEGER NULL CHECK (total >= 0),
        time_seconds INTEGER NULL CHECK (time_seconds >= 0),
        note TEXT NULL,
        entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
        verified BOOLEAN NOT NULL DEFAULT false,
        source TEXT NOT NULL DEFAULT 'practice',
        practice_mode TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );

      CREATE TABLE IF NOT EXISTS public.activity_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        correct INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        time_seconds INTEGER NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS public.drill_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        activity_type TEXT NOT NULL,
        activity_name TEXT NOT NULL,
        settings JSONB NOT NULL,
        questions JSONB NOT NULL,
        expected JSONB NOT NULL,
        min_seconds NUMERIC NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        submitted_at TIMESTAMPTZ,
        result_id UUID,
        result_row_id UUID
      );

      -- Baseline daily_todo_log: finalized_at is NOT NULL DEFAULT now(), plan_snapshot DOES NOT EXIST
      CREATE TABLE IF NOT EXISTS public.daily_todo_log (
        student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        tasks_total INTEGER NOT NULL DEFAULT 0,
        tasks_done INTEGER NOT NULL DEFAULT 0,
        all_done BOOLEAN NOT NULL DEFAULT false,
        finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (student_id, day)
      );

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE((SELECT role = 'admin' AND active = true FROM public.profiles WHERE id = auth.uid()), false);
      $$;

      CREATE OR REPLACE FUNCTION public.is_teacher(p_uid uuid DEFAULT auth.uid()) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT COALESCE((SELECT role = 'teacher' AND active = true FROM public.profiles WHERE id = p_uid), false);
      $$;

      CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT false;
      $$;

      CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id uuid, p_student_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT false;
      $$;
    `);

    // 2. Apply prerequisite: todo_streak_start
    const prereqSql = fs.readFileSync(prereqSqlPath, 'utf-8');
    await db.exec(prereqSql);

    const settingCheck = await db.query(
      "SELECT value FROM public.competition_settings WHERE key = 'todo_streak_start'"
    );
    assert.equal(settingCheck.rows[0].value, '2026-10-29', 'Prerequisite must set todo_streak_start = 2026-10-29');

    // 3. STEP 1: APPLY PATCH
    const patchSql = fs.readFileSync(patchSqlPath, 'utf-8');
    await db.exec(patchSql);

    // Verify post-apply state:
    // - todo_finalize exists
    // - streak_day_counts has 2 args
    // - plan_snapshot exists
    // - finalized_at is nullable without default
    const applyVerify = await Promise.all([
      db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'todo_finalize'"),
      db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'finalized_at'"),
      db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'plan_snapshot'"),
      db.query("SELECT count(*)::int AS cnt FROM pg_trigger WHERE tgname LIKE 'trg_sync_daily_todo_log_%'"),
    ]);

    assert.equal(applyVerify[0].rows.length, 1, 'todo_finalize must exist after patch apply');
    assert.equal(applyVerify[1].rows[0].is_nullable, 'YES', 'finalized_at must be nullable after patch apply');
    assert.equal(applyVerify[1].rows[0].column_default, null, 'finalized_at default must be dropped after patch apply');
    assert.equal(applyVerify[2].rows.length, 1, 'plan_snapshot must exist after patch apply');
    assert.equal(applyVerify[3].rows[0].cnt, 6, 'All 6 sync triggers must exist after patch apply');

    // 4. STEP 2: ROLLBACK
    const rollbackSql = fs.readFileSync(rollbackSqlPath, 'utf-8');
    await db.exec(rollbackSql);

    // Verify post-rollback state:
    // - todo_finalize DOES NOT exist
    // - streak_day_counts has 3 args returning boolean
    // - plan_snapshot column is dropped
    // - finalized_at is NOT NULL with default now()
    // - All 6 triggers are dropped
    const rollbackVerify = await Promise.all([
      db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'todo_finalize'"),
      db.query("SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS res FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'streak_day_counts'"),
      db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'finalized_at'"),
      db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'plan_snapshot'"),
      db.query("SELECT count(*)::int AS cnt FROM pg_trigger WHERE tgname LIKE 'trg_sync_daily_todo_log_%'"),
      db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('_todo_evaluate_plan', '_todo_plan_snapshot')"),
    ]);

    assert.equal(rollbackVerify[0].rows.length, 0, 'todo_finalize must NOT exist after rollback');
    assert.equal(rollbackVerify[1].rows[0].args, 'p_student uuid, p_day date, p_has_practice boolean', 'streak_day_counts must have 3 args after rollback');
    assert.equal(rollbackVerify[1].rows[0].res, 'boolean', 'streak_day_counts must return boolean after rollback');
    assert.equal(rollbackVerify[2].rows[0].is_nullable, 'NO', 'finalized_at must be NOT NULL after rollback');
    assert.equal(rollbackVerify[2].rows[0].column_default, 'now()', 'finalized_at default must be now() after rollback');
    assert.equal(rollbackVerify[3].rows.length, 0, 'plan_snapshot must be dropped after rollback');
    assert.equal(rollbackVerify[4].rows[0].cnt, 0, 'Zero sync triggers must remain after rollback');
    assert.equal(rollbackVerify[5].rows.length, 0, 'Patch helpers must be dropped after rollback');

    // 5. STEP 3: REAPPLY PATCH
    await db.exec(patchSql);

    // Verify reapply state:
    const reapplyVerify = await Promise.all([
      db.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'todo_finalize'"),
      db.query("SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'finalized_at'"),
      db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'plan_snapshot'"),
      db.query("SELECT count(*)::int AS cnt FROM pg_trigger WHERE tgname LIKE 'trg_sync_daily_todo_log_%'"),
    ]);

    assert.equal(reapplyVerify[0].rows.length, 1, 'todo_finalize must exist after reapply');
    assert.equal(reapplyVerify[1].rows[0].is_nullable, 'YES', 'finalized_at must be nullable after reapply');
    assert.equal(reapplyVerify[1].rows[0].column_default, null, 'finalized_at default must be dropped after reapply');
    assert.equal(reapplyVerify[2].rows.length, 1, 'plan_snapshot must exist after reapply');
    assert.equal(reapplyVerify[3].rows[0].cnt, 6, 'All 6 sync triggers must exist after reapply');

    await db.close();
  });
});
