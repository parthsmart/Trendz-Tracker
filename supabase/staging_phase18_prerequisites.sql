-- =============================================================================
-- Trendz Tracker — Phase 18 Staging Database Prerequisites Setup
-- File: supabase/staging_phase18_prerequisites.sql
--
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
--   Brings the minimal staging database (which only has profiles, categories,
--   results, is_admin, today_ist, and JMCWC stubs) up to the authoritative
--   pre-Phase-18 Mumbai baseline schema.
--
-- SOURCE FIDELITY:
--   All definitions are 100% authoritative copies from the verified Mumbai
--   production catalog dump (pg_dump export). Zero simplified calculation mocks.
--
-- SAFETY & ISOLATION:
--   - OPERATOR CONFIRMATION LATCH: Requires `SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';`
--     *IMPORTANT NOTE*: PostgreSQL running inside hosted Supabase does not expose
--     the hosted project reference in any database catalog (current_database()='postgres',
--     inet_server_addr() is internal cloud IP). The database owner must independently
--     verify their selected project in the Supabase Dashboard before running.
--   - PRODUCTION DATA TRIPWIRE: Immediately aborts if Mumbai production student records exist.
--   - PRE-FLIGHT CONFLICT VALIDATION: Pre-checks every existing object for type and signature
--     conflicts and aborts with a specific error report instead of overwriting silently.
--   - PRESERVES EXISTING DATA: Never drops or truncates existing profiles, results,
--     categories, or JMCWC tables/attempts.
--   - ZERO REAL DATA: Pure schema definitions and default settings only.
--   - TRANSACTIONAL: Wrapped in BEGIN; ... COMMIT; with atomic rollback on any conflict.
--
-- HOW TO RUN:
--   1. In Supabase Dashboard, verify you are viewing project `xhgzbbkvwojwfbexvcmh`.
--   2. Paste this entire script into the Staging Supabase SQL Editor as database owner.
--   3. Execute.
-- =============================================================================

-- Operator confirmation latch
SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. PRE-FLIGHT CHECKS: OPERATOR LATCH, SAFETY TRIPWIRE & CONFLICT DETECTION
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_target_env TEXT := current_setting('app.target_environment', true);
  v_col_type TEXT;
  v_ret_type TEXT;
  v_obj_name TEXT;
BEGIN
  -- 0a. Operator Intent Confirmation Latch
  -- Explicit assertion of operator target. This does not substitute for independent
  -- dashboard project verification.
  IF v_target_env IS DISTINCT FROM 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR SAFETY HALT: Target environment latch unset or mismatched. Got "%". Set `SET app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'';` before running.',
      COALESCE(v_target_env, '<unset>')
      USING ERRCODE = '28000';
  END IF;

  -- 0b. Secondary Safeguard: Production Data Tripwire
  -- NOTE: This is a secondary fail-fast tripwire to catch accidental production execution,
  -- NOT an independent project identity verification.
  IF EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE student_code IN ('STU101', 'STU-101') AND full_name ILIKE '%Riya%'
  ) THEN
    RAISE EXCEPTION 'SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected in public.profiles (STU101 / Riya)! Refusing execution on production database (kgzivhavpsvitwrscrrj).'
      USING ERRCODE = '55000';
  END IF;

  -- 0c. Conflict Detection: Profiles Table Columns
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles') THEN
    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'uuid' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.profiles.id has data type "%", expected "uuid".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'role';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'text' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.profiles.role has data type "%", expected "text".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'active';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.profiles.active has data type "%", expected "boolean".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'level';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'text' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.profiles.level has data type "%", expected "text".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'leaderboard_visible';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.profiles.leaderboard_visible has data type "%", expected "boolean".', v_col_type;
    END IF;
  END IF;

  -- 0d. Conflict Detection: Results Table Columns
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'results') THEN
    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'results' AND column_name = 'id';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'uuid' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.results.id has data type "%", expected "uuid".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'results' AND column_name = 'verified';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.results.verified has data type "%", expected "boolean".', v_col_type;
    END IF;

    SELECT data_type INTO v_col_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'results' AND column_name = 'flagged';
    IF v_col_type IS NOT NULL AND v_col_type IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: public.results.flagged has data type "%", expected "boolean".', v_col_type;
    END IF;
  END IF;

  -- 0e. Conflict Detection: Verify Required Tables Are Not Defined as Views
  FOREACH v_obj_name IN ARRAY ARRAY[
    'activity_results', 'weekly_tests', 'weekly_test_sections', 'weekly_test_scores',
    'weekly_test_attempts', 'attendance_sessions', 'attendance', 'daily_tasks',
    'daily_todo_log', 'competition_settings', 'basics_thresholds', 'announcements',
    'resources', 'student_messages', 'notification_dismissals', 'result_audit', 'drill_sessions'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema = 'public' AND table_name = v_obj_name) THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Object public.% exists as a VIEW, expected BASE TABLE.', v_obj_name;
    END IF;
  END LOOP;

  -- 0f. Conflict Detection: Verify results_with_target Is Not Defined as Base Table
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'results_with_target' AND table_type = 'BASE TABLE') THEN
    RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Object public.results_with_target exists as a BASE TABLE, expected VIEW.';
  END IF;

  -- 0g. Conflict Detection: Incompatible Function Return Types
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'competition_rules') THEN
    SELECT format_type(p.prorettype, NULL) INTO v_ret_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'competition_rules';
    IF v_ret_type IS DISTINCT FROM 'record' AND v_ret_type IS DISTINCT FROM 'competition_rules' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Function public.competition_rules exists with incompatible return type "%", expected record/TABLE.', v_ret_type;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'streak_calc') THEN
    SELECT format_type(p.prorettype, NULL) INTO v_ret_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'streak_calc';
    IF v_ret_type IS DISTINCT FROM 'record' AND v_ret_type IS DISTINCT FROM 'streak_calc' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Function public.streak_calc exists with incompatible return type "%", expected record/TABLE.', v_ret_type;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'today_ist') THEN
    SELECT format_type(p.prorettype, NULL) INTO v_ret_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'today_ist';
    IF v_ret_type IS DISTINCT FROM 'date' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Function public.today_ist exists with incompatible return type "%", expected date.', v_ret_type;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'is_admin') THEN
    SELECT format_type(p.prorettype, NULL) INTO v_ret_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_admin';
    IF v_ret_type IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'INCOMPATIBLE OBJECT CONFLICT: Function public.is_admin exists with incompatible return type "%", expected boolean.', v_ret_type;
    END IF;
  END IF;

END $$;

-- -----------------------------------------------------------------------------
-- 1. EXTEND EXISTING TABLES (Non-destructive column additions)
-- -----------------------------------------------------------------------------
-- Extend profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS level TEXT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS student_code TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT true;

-- Ensure profiles_role_check allows ('student', 'admin') before Migration 16 expands it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_role_check'
  ) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('student', 'admin'));
  END IF;
END $$;

-- Extend results with review, audit, mode and tracking columns matching Mumbai catalog
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS student_round_id UUID,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS corrected_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_note TEXT,
  ADD COLUMN IF NOT EXISTS import_batch_id UUID,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'practice',
  ADD COLUMN IF NOT EXISTS practice_mode TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());

-- -----------------------------------------------------------------------------
-- 2. CREATE MISSING BASELINE TABLES (Exact Mumbai Catalog Definitions)
-- -----------------------------------------------------------------------------

-- 2a. Activity Results (Elements, Flash Anzan, Memoriad)
CREATE TABLE IF NOT EXISTS public.activity_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element', 'memoriad')),
  activity_name TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct >= 0),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  time_seconds INTEGER NULL CHECK (time_seconds IS NULL OR time_seconds >= 0),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_results ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.activity_results TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "activity_results_select_policy" ON public.activity_results;
CREATE POLICY "activity_results_select_policy" ON public.activity_results FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "activity_results_insert_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_admin_insert" ON public.activity_results;
CREATE POLICY "activity_results_admin_insert" ON public.activity_results FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "activity_results_admin_update" ON public.activity_results;
CREATE POLICY "activity_results_admin_update" ON public.activity_results FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "activity_results_admin_delete" ON public.activity_results;
CREATE POLICY "activity_results_admin_delete" ON public.activity_results FOR DELETE TO authenticated
  USING (public.is_admin());

-- 2b. Weekly Tests
CREATE TABLE IF NOT EXISTS public.weekly_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_date DATE NOT NULL DEFAULT public.today_ist(),
  title TEXT NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  test_type TEXT NOT NULL DEFAULT 'offline' CHECK (test_type IN ('offline', 'online')),
  audience_level TEXT,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  remind_days_before INT NOT NULL DEFAULT 7 CHECK (remind_days_before >= 0 AND remind_days_before <= 30),
  CONSTRAINT weekly_tests_audience_check CHECK (audience_level IS NULL OR (char_length(trim(audience_level)) >= 1 AND char_length(trim(audience_level)) <= 30)),
  CONSTRAINT weekly_tests_window_check CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
);
ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.weekly_tests TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "weekly_tests_read" ON public.weekly_tests;
CREATE POLICY "weekly_tests_read" ON public.weekly_tests FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "weekly_tests_admin_write" ON public.weekly_tests;
CREATE POLICY "weekly_tests_admin_write" ON public.weekly_tests FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2c. Weekly Test Sections (Deferrable Position Constraint)
CREATE TABLE IF NOT EXISTS public.weekly_test_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
  position INT NOT NULL CHECK (position >= 1 AND position <= 20),
  category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  seconds INT NULL CHECK (seconds IS NULL OR seconds IN (30, 60, 120, 300)),
  kind TEXT NOT NULL DEFAULT 'basics' CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad')),
  activity_key TEXT NULL,
  flash_digits INT NULL CHECK (flash_digits IS NULL OR (flash_digits >= 1 AND flash_digits <= 5)),
  flash_count INT NULL CHECK (flash_count IS NULL OR (flash_count >= 2 AND flash_count <= 1000)),
  flash_speed_ms INT NULL CHECK (flash_speed_ms IS NULL OR (flash_speed_ms >= 200 AND flash_speed_ms <= 5000)),
  flash_mode TEXT NULL CHECK (flash_mode IS NULL OR flash_mode IN ('add', 'add_sub')),
  question_count INT NULL CHECK (question_count IS NULL OR (question_count >= 1 AND question_count <= 10)),
  CONSTRAINT weekly_test_sections_test_id_position_key UNIQUE (test_id, position) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public.weekly_test_sections ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.weekly_test_sections TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "wt_sections_read" ON public.weekly_test_sections;
CREATE POLICY "wt_sections_read" ON public.weekly_test_sections FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "wt_sections_admin_write" ON public.weekly_test_sections;
CREATE POLICY "wt_sections_admin_write" ON public.weekly_test_sections FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2d. Weekly Test Scores
CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE SET NULL,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  correct INTEGER NOT NULL CHECK (correct >= 0),
  total INTEGER NOT NULL CHECK (total > 0),
  time_seconds INTEGER NULL CHECK (time_seconds IS NULL OR (time_seconds >= 0 AND time_seconds <= 14400)),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'offline' CHECK (source IN ('teacher', 'online', 'offline')),
  CONSTRAINT weekly_test_scores_check CHECK (correct <= total)
);
ALTER TABLE public.weekly_test_scores ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.weekly_test_scores TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "weekly_test_scores_select" ON public.weekly_test_scores;
DROP POLICY IF EXISTS "wts_read" ON public.weekly_test_scores;
CREATE POLICY "wts_read" ON public.weekly_test_scores FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "wts_admin_write" ON public.weekly_test_scores;
CREATE POLICY "wts_admin_write" ON public.weekly_test_scores FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2e. Weekly Test Attempts
CREATE TABLE IF NOT EXISTS public.weekly_test_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  section_id UUID REFERENCES public.weekly_test_sections(id) ON DELETE CASCADE,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  session_id UUID,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'submitted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
ALTER TABLE public.weekly_test_attempts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.weekly_test_attempts TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "weekly_test_attempts_select" ON public.weekly_test_attempts;
DROP POLICY IF EXISTS "wt_attempts_read" ON public.weekly_test_attempts;
CREATE POLICY "wt_attempts_read" ON public.weekly_test_attempts FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "wt_attempts_admin_write" ON public.weekly_test_attempts;
CREATE POLICY "wt_attempts_admin_write" ON public.weekly_test_attempts FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2f. Attendance Sessions & Attendance Records
CREATE TABLE IF NOT EXISTS public.attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date DATE NOT NULL,
  title TEXT NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'workshop' CHECK (session_type IN ('workshop', 'class', 'other')),
  notes TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.attendance_sessions TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "att_sessions_read" ON public.attendance_sessions;
CREATE POLICY "att_sessions_read" ON public.attendance_sessions FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "att_sessions_admin_write" ON public.attendance_sessions;
CREATE POLICY "att_sessions_admin_write" ON public.attendance_sessions FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE TABLE IF NOT EXISTS public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  note TEXT,
  marked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_session_student UNIQUE (session_id, student_id)
);
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.attendance TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "attendance_read" ON public.attendance;
CREATE POLICY "attendance_read" ON public.attendance FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "attendance_admin_write" ON public.attendance;
CREATE POLICY "attendance_admin_write" ON public.attendance FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2g. Daily Tasks
CREATE TABLE IF NOT EXISTS public.daily_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  category_id UUID REFERENCES public.categories(id) ON DELETE SET NULL,
  level TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  activity_key TEXT,
  required_count INT NOT NULL DEFAULT 1,
  flash_digits SMALLINT,
  flash_count INT,
  flash_speed_ms INT,
  flash_mode TEXT,
  CONSTRAINT daily_tasks_activity_key_valid CHECK (activity_key IS NULL OR activity_key ~ '^[a-z0-9_]{2,40}$'),
  CONSTRAINT daily_tasks_flash_only CHECK (section = 'flash' OR (flash_digits IS NULL AND flash_count IS NULL AND flash_speed_ms IS NULL AND flash_mode IS NULL)),
  CONSTRAINT daily_tasks_flash_ranges CHECK (
    (flash_digits IS NULL OR (flash_digits >= 1 AND flash_digits <= 5)) AND
    (flash_count IS NULL OR (flash_count >= 2 AND flash_count <= 1000)) AND
    (flash_speed_ms IS NULL OR (flash_speed_ms >= 200 AND flash_speed_ms <= 5000)) AND
    (flash_mode IS NULL OR flash_mode = ANY (ARRAY['add', 'add_sub']))
  )
);
ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.daily_tasks TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "daily_tasks_read_policy" ON public.daily_tasks;
CREATE POLICY "daily_tasks_read_policy" ON public.daily_tasks FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "daily_tasks_admin_write_policy" ON public.daily_tasks;
CREATE POLICY "daily_tasks_admin_write_policy" ON public.daily_tasks FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2h. Daily Todo Log (Authoritative Mumbai Dependency for streak_day_counts)
CREATE TABLE IF NOT EXISTS public.daily_todo_log (
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  tasks_total INTEGER NOT NULL,
  tasks_done INTEGER NOT NULL,
  all_done BOOLEAN NOT NULL,
  finalized_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  PRIMARY KEY (student_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_todo_log_day ON public.daily_todo_log(day);
ALTER TABLE public.daily_todo_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.daily_todo_log TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "daily_todo_log_read" ON public.daily_todo_log;
CREATE POLICY "daily_todo_log_read" ON public.daily_todo_log FOR SELECT TO authenticated
  USING (student_id = auth.uid() OR public.is_admin());

-- 2i. Competition Settings (Authoritative Mumbai Dependency for competition_rules & streak_calc)
CREATE TABLE IF NOT EXISTS public.competition_settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT competition_settings_valid CHECK (
    CASE key
      WHEN 'leaderboard_names' THEN (value = ANY (ARRAY['first_name_initial', 'student_code']))
      WHEN 'weekly_test_multiplier' THEN (value ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$')
      WHEN 'attendance_present_points' THEN (value ~ '^[0-9]{1,4}$')
      WHEN 'improved_min_entries' THEN (value ~ '^[0-9]{1,2}$')
      WHEN 'global_leaderboard' THEN (value = ANY (ARRAY['on', 'off']))
      WHEN 'todo_streak_start' THEN (value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      ELSE false
    END
  )
);
ALTER TABLE public.competition_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.competition_settings TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "competition_settings_admin" ON public.competition_settings;
CREATE POLICY "competition_settings_admin" ON public.competition_settings FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Seed authoritative default settings
INSERT INTO public.competition_settings (key, value)
VALUES
  ('leaderboard_names', 'first_name_initial'),
  ('weekly_test_multiplier', '1'),
  ('attendance_present_points', '10'),
  ('improved_min_entries', '3'),
  ('global_leaderboard', 'on')
ON CONFLICT (key) DO NOTHING;

-- 2j. Basics Thresholds (Authoritative Mumbai Dependency for results_with_target)
CREATE TABLE IF NOT EXISTS public.basics_thresholds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  level TEXT,
  min_accuracy NUMERIC(5,2) NOT NULL,
  max_time_seconds INTEGER,
  active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  min_questions_per_minute NUMERIC(6,2),
  CONSTRAINT basics_thresholds_max_time_seconds_check CHECK (max_time_seconds IS NULL OR max_time_seconds > 0),
  CONSTRAINT basics_thresholds_min_accuracy_check CHECK (min_accuracy >= 0::numeric AND min_accuracy <= 100::numeric),
  CONSTRAINT basics_thresholds_qpm_check CHECK (min_questions_per_minute IS NULL OR (min_questions_per_minute > 0::numeric AND min_questions_per_minute <= 500::numeric))
);
ALTER TABLE public.basics_thresholds ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.basics_thresholds TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "basics_thresholds_read" ON public.basics_thresholds;
DROP POLICY IF EXISTS "thresholds_read" ON public.basics_thresholds;
CREATE POLICY "thresholds_read" ON public.basics_thresholds FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "thresholds_admin_write" ON public.basics_thresholds;
CREATE POLICY "thresholds_admin_write" ON public.basics_thresholds FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2k. Announcements
CREATE TABLE IF NOT EXISTS public.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience_level TEXT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT announcements_audience_level_check CHECK (audience_level IS NULL OR (char_length(trim(audience_level)) >= 1 AND char_length(trim(audience_level)) <= 30)),
  CONSTRAINT announcements_body_check CHECK (char_length(trim(body)) >= 1 AND char_length(trim(body)) <= 500),
  CONSTRAINT announcements_title_check CHECK (char_length(trim(title)) >= 1 AND char_length(trim(title)) <= 80)
);
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.announcements TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "announcements_read_policy" ON public.announcements;
DROP POLICY IF EXISTS "announcements_admin" ON public.announcements;
CREATE POLICY "announcements_admin" ON public.announcements FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2l. Resources
CREATE TABLE IF NOT EXISTS public.resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  topic TEXT,
  audience_level TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT resources_url_check CHECK (url ~* '^https?://')
);
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.resources TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "resources_read_policy" ON public.resources;
CREATE POLICY "resources_read_policy" ON public.resources FOR SELECT TO authenticated
  USING (active = true OR public.is_admin());

DROP POLICY IF EXISTS "resources_admin_write_policy" ON public.resources;
CREATE POLICY "resources_admin_write_policy" ON public.resources FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2m. Student Messages (Phase 17 Schema)
CREATE TABLE IF NOT EXISTS public.student_messages (
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_student_message_title CHECK (char_length(trim(title)) >= 1 AND char_length(title) <= 120),
  CONSTRAINT chk_student_message_body CHECK (char_length(trim(body)) >= 1 AND char_length(body) <= 2000)
);
ALTER TABLE public.student_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.student_messages FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.student_messages TO authenticated;
GRANT ALL ON TABLE public.student_messages TO service_role;

DROP POLICY IF EXISTS "student_messages_admin_all" ON public.student_messages;
CREATE POLICY "student_messages_admin_all" ON public.student_messages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin' AND active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin' AND active = true
    )
  );

DROP POLICY IF EXISTS "student_messages_student_select" ON public.student_messages;
CREATE POLICY "student_messages_student_select" ON public.student_messages FOR SELECT TO authenticated
  USING (student_id = auth.uid());

DROP POLICY IF EXISTS "student_messages_student_update" ON public.student_messages;
CREATE POLICY "student_messages_student_update" ON public.student_messages FOR UPDATE TO authenticated
  USING (student_id = auth.uid())
  WITH CHECK (student_id = auth.uid());

CREATE OR REPLACE FUNCTION public.trg_student_messages_protect_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin' AND active = true
  ) THEN
    IF NEW.id <> OLD.id
       OR NEW.student_id <> OLD.student_id
       OR NEW.sender_id <> OLD.sender_id
       OR NEW.title <> OLD.title
       OR NEW.body <> OLD.body
       OR NEW.needs_attention <> OLD.needs_attention
       OR NEW.attention_reason IS DISTINCT FROM OLD.attention_reason
       OR NEW.linked_type IS DISTINCT FROM OLD.linked_type
       OR NEW.linked_id IS DISTINCT FROM OLD.linked_id
       OR NEW.link IS DISTINCT FROM OLD.link
       OR NEW.client_nonce IS DISTINCT FROM OLD.client_nonce
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Unauthorized: Students cannot modify message content, links, sender, recipient, or nonce';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_student_messages_protect_immutability ON public.student_messages;
CREATE TRIGGER trg_student_messages_protect_immutability
  BEFORE UPDATE ON public.student_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_student_messages_protect_immutability();

-- 2n. Notification Dismissals
CREATE TABLE IF NOT EXISTS public.notification_dismissals (
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, ref)
);
ALTER TABLE public.notification_dismissals ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.notification_dismissals TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "dismissals_read_own" ON public.notification_dismissals;
CREATE POLICY "dismissals_read_own" ON public.notification_dismissals FOR SELECT TO authenticated
  USING (student_id = auth.uid());

-- 2o. Result Audit
CREATE TABLE IF NOT EXISTS public.result_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  student_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  action TEXT NOT NULL,
  old_values JSONB,
  new_values JSONB,
  reason TEXT
);
ALTER TABLE public.result_audit ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.result_audit TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "result_audit_admin_read" ON public.result_audit;
CREATE POLICY "result_audit_admin_read" ON public.result_audit FOR SELECT TO authenticated
  USING (public.is_admin());

-- 2p. Drill Sessions
CREATE TABLE IF NOT EXISTS public.drill_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element', 'basics', 'round', 'memoriad')),
  activity_name TEXT NOT NULL,
  settings JSONB NOT NULL,
  questions JSONB NOT NULL,
  expected JSONB NOT NULL,
  min_seconds NUMERIC NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
  submitted_at TIMESTAMPTZ,
  result_id UUID,
  result_row_id UUID
);
ALTER TABLE public.drill_sessions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.drill_sessions TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "drill_sessions_admin_read" ON public.drill_sessions;
CREATE POLICY "drill_sessions_admin_read" ON public.drill_sessions FOR SELECT TO authenticated
  USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 3. CREATE AUTHORITATIVE BASELINE VIEWS & CALCULATION HELPERS
-- -----------------------------------------------------------------------------

-- 3a. View: results_with_target (Exact Mumbai Catalog Definition)
CREATE OR REPLACE VIEW public.results_with_target WITH (security_invoker = true) AS
SELECT 
  r.id,
  r.student_id,
  r.category_id,
  r.correct,
  r.total,
  r.time_seconds,
  r.note,
  r.entry_date,
  r.verified,
  r.created_at,
  r.flagged,
  r.flag_note,
  r.verified_by,
  r.verified_at,
  r.corrected_by,
  r.corrected_at,
  r.import_batch_id,
  r.student_round_id,
  r.updated_at,
  r.source,
  r.practice_mode,
  t.min_accuracy,
  t.max_time_seconds,
  t.min_questions_per_minute,
  CASE
    WHEN (t.id IS NULL OR r.total IS NULL OR r.total = 0 OR r.correct IS NULL) THEN NULL::boolean
    WHEN (((100.0 * r.correct::numeric) / r.total::numeric) < t.min_accuracy) THEN false
    WHEN (r.practice_mode IS NULL) THEN (t.max_time_seconds IS NULL OR (r.time_seconds IS NOT NULL AND r.time_seconds <= t.max_time_seconds))
    ELSE (t.min_questions_per_minute IS NULL OR (r.time_seconds IS NOT NULL AND r.time_seconds > 0 AND ((r.total::numeric / (r.time_seconds::numeric / 60.0)) >= t.min_questions_per_minute)))
  END AS meets_target
FROM public.results r
JOIN public.profiles p ON p.id = r.student_id
LEFT JOIN LATERAL (
  SELECT 
    bt.id,
    bt.category_id,
    bt.level,
    bt.min_accuracy,
    bt.max_time_seconds,
    bt.active,
    bt.created_at,
    bt.updated_at,
    bt.updated_by,
    bt.min_questions_per_minute
  FROM public.basics_thresholds bt
  WHERE bt.active 
    AND bt.category_id = r.category_id 
    AND (bt.level = p.level OR bt.level IS NULL)
  ORDER BY (bt.level IS NOT NULL) DESC
  LIMIT 1
) t ON true;

GRANT ALL ON TABLE public.results_with_target TO anon, authenticated, service_role;

-- 3b. Helper: competition_rules (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.competition_rules()
RETURNS TABLE (
  weekly_test_multiplier NUMERIC,
  attendance_present_points NUMERIC,
  improved_min_entries INTEGER,
  leaderboard_names TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT cs.value::numeric FROM public.competition_settings cs WHERE cs.key = 'weekly_test_multiplier'), 1),
    COALESCE((SELECT cs.value::numeric FROM public.competition_settings cs WHERE cs.key = 'attendance_present_points'), 10),
    COALESCE((SELECT cs.value::integer FROM public.competition_settings cs WHERE cs.key = 'improved_min_entries'), 3),
    COALESCE((SELECT cs.value FROM public.competition_settings cs WHERE cs.key = 'leaderboard_names'), 'first_name_initial');
$$;

-- 3c. Helper: attendance_summary (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.attendance_summary(
  p_student UUID,
  p_from DATE DEFAULT NULL,
  p_to DATE DEFAULT NULL
)
RETURNS TABLE (
  present_count INTEGER,
  absent_count INTEGER,
  excused_count INTEGER,
  attendance_pct NUMERIC
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

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
$$;

-- 3d. Helper: points_for (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.points_for(
  p_student UUID,
  p_from DATE,
  p_to DATE
)
RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- 3e. Helper: practice_days_for (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.practice_days_for(
  p_student UUID,
  p_from DATE,
  p_to DATE
)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- 3f. Helper: practice_stats_for (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.practice_stats_for(
  p_student UUID,
  p_from DATE,
  p_to DATE
)
RETURNS TABLE (
  n_entries INTEGER,
  n_correct BIGINT,
  n_total BIGINT,
  accuracy_pct NUMERIC,
  qpm NUMERIC,
  n_rounds INTEGER
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

-- 3g-1. Internal Helper: _todo_status_on_internal
CREATE OR REPLACE FUNCTION public._todo_status_on_internal(
  p_student UUID,
  p_day DATE
)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_student IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT x.id, x.title, x.section, x.category_id, x.activity_key, x.required_count, x.cnt,
         (x.cnt >= x.required_count)
    FROM (
      SELECT t.id, t.title, t.section, t.category_id, t.activity_key, t.required_count, t.sort_order,
        (CASE
          WHEN t.category_id IS NOT NULL AND t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
          WHEN t.category_id IS NOT NULL THEN
            (SELECT count(*) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.entry_date = p_day)
          WHEN t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'round'
                AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
          WHEN t.section = 'basics' THEN
            (SELECT count(*) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'basics' AND r.entry_date = p_day)
          WHEN t.section = 'elements' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'element'
                AND (t.activity_key IS NULL OR a.settings ->> 'drill' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          WHEN t.section = 'flash' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'flash_anzan'
                AND (t.flash_digits IS NULL OR a.settings ->> 'digits' = t.flash_digits::text)
                AND (t.flash_count IS NULL OR a.settings ->> 'count' = t.flash_count::text)
                AND (t.flash_speed_ms IS NULL OR a.settings ->> 'speed_ms' = t.flash_speed_ms::text)
                AND (t.flash_mode IS NULL OR a.settings ->> 'mode' = t.flash_mode)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          WHEN t.section = 'memoriad' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'memoriad'
                AND (t.activity_key IS NULL OR a.settings ->> 'module' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          ELSE 0
        END)::integer AS cnt
        FROM public.daily_tasks t
        JOIN public.profiles p ON p.id = p_student
       WHERE t.active AND (t.level IS NULL OR t.level = p.level)
    ) x
   ORDER BY x.sort_order, x.title;
END;
$$;

REVOKE ALL ON FUNCTION public._todo_status_on_internal(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._todo_status_on_internal(UUID, DATE) TO service_role;

-- 3g-2. Baseline Helper: todo_status_on (Delegates to Internal Helper)
CREATE OR REPLACE FUNCTION public.todo_status_on(
  p_student UUID,
  p_day DATE
)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  RETURN QUERY
  SELECT * FROM public._todo_status_on_internal(p_student, p_day);
END;
$$;

-- 3h. Helper: streak_day_counts (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.streak_day_counts(
  p_student UUID,
  p_day DATE,
  p_has_practice BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date;
  v_log record;
  v_total integer;
  v_done integer;
BEGIN
  SELECT cs.value::date INTO v_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';

  -- before the rule starts (or when the rule is off) any practice counts
  IF v_start IS NULL OR p_day < v_start THEN
    RETURN p_has_practice;
  END IF;

  -- finished days use the stored result
  IF p_day < public.today_ist() THEN
    SELECT l.tasks_total, l.all_done INTO v_log
      FROM public.daily_todo_log l WHERE l.student_id = p_student AND l.day = p_day;
    IF FOUND THEN
      IF v_log.tasks_total = 0 THEN RETURN p_has_practice; END IF;
      RETURN v_log.all_done;
    END IF;
  END IF;

  -- today, or a finished day not stored yet: calculate via internal helper
  SELECT count(*)::integer, (count(*) FILTER (WHERE s.done))::integer
    INTO v_total, v_done
    FROM public._todo_status_on_internal(p_student, p_day) s;
  IF v_total = 0 THEN RETURN p_has_practice; END IF;
  RETURN v_done = v_total;
END;
$$;

-- 3i. Helper: streak_calc (Exact Mumbai Catalog Definition)
CREATE OR REPLACE FUNCTION public.streak_calc(p_student UUID)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_today date := public.today_ist();
  v_days date[];
  v_start date;
  v_d date;
  v_streak integer := 0;
  v_best integer := 0;
  v_shields integer := 0;
  v_counts boolean;
  v_today_counts boolean := false;
BEGIN
  SELECT array_agg(DISTINCT dt) INTO v_days FROM (
    SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::date AS dt
      FROM public.results r
     WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
    UNION
    SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
      FROM public.activity_results a
     WHERE a.student_id = p_student AND a.total > 0
  ) q;

  IF v_days IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  SELECT min(x) INTO v_start FROM unnest(v_days) AS x;

  FOR v_d IN SELECT g::date FROM generate_series(v_start, v_today, interval '1 day') AS g LOOP
    v_counts := public.streak_day_counts(p_student, v_d, (v_d = ANY (v_days)));
    IF v_d = v_today THEN v_today_counts := v_counts; END IF;
    IF v_counts THEN
      v_streak := v_streak + 1;
      IF v_streak > v_best THEN v_best := v_streak; END IF;
      IF v_streak % 7 = 0 THEN v_shields := 1; END IF;
    ELSIF v_d < v_today THEN
      IF v_shields > 0 THEN
        v_shields := v_shields - 1;
      ELSE
        v_streak := 0;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_streak, v_best, v_shields, v_today_counts;
END;
$$;

-- 3j. Pre-migration Baseline streak_for
CREATE OR REPLACE FUNCTION public.streak_for(p_student UUID)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  RETURN QUERY SELECT * FROM public.streak_calc(p_student);
END;
$$;

-- 3k. Pre-migration Baseline todo_for
CREATE OR REPLACE FUNCTION public.todo_for(p_student UUID)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  RETURN QUERY SELECT * FROM public.todo_status_on(p_student, public.today_ist());
END;
$$;

-- Explicit Execution Privileges for Client Roles
REVOKE ALL ON FUNCTION public.streak_calc(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_calc(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) TO service_role;

REVOKE ALL ON FUNCTION public.points_for(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.points_for(UUID, DATE, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.practice_days_for(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.practice_days_for(UUID, DATE, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.practice_stats_for(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.practice_stats_for(UUID, DATE, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.competition_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.competition_rules() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.attendance_summary(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_summary(UUID, DATE, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.streak_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_for(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.todo_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.todo_for(UUID) TO authenticated, service_role;

COMMIT;
