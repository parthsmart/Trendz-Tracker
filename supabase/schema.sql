-- ==============================================================================
-- TRENDZ TRACKER - PHASE 1 DATABASE SCHEMA & ROW LEVEL SECURITY (RLS)
-- Abacus Institute: Trendz Abacus
-- Purpose: Foundation for Junior Mental Calculation World Championship tracking
-- Instructions: Run this entire script in your Supabase SQL Editor (top to bottom).
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 2. TABLES DEFINITION (Created FIRST so all table references exist)
-- ------------------------------------------------------------------------------

-- Table: profiles (id matches auth.users.id)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  student_code TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  level TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: categories
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: rounds
CREATE TABLE IF NOT EXISTS public.rounds (
  round_number INTEGER PRIMARY KEY,
  round_date DATE NOT NULL DEFAULT CURRENT_DATE,
  round_type TEXT NOT NULL DEFAULT 'Category wise',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: results (One unified table for all manually entered practice scores)
CREATE TABLE IF NOT EXISTS public.results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  round_number INTEGER NULL REFERENCES public.rounds(round_number) ON DELETE SET NULL,
  correct INTEGER NULL CHECK (correct >= 0),
  total INTEGER NULL CHECK (total >= 0),
  time_seconds INTEGER NULL CHECK (time_seconds >= 0),
  note TEXT NULL, -- specifically for Surprise Task or notes
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: activity_results (Pre-created for Phase 2: Flash Anzan and digital drills)
CREATE TABLE IF NOT EXISTS public.activity_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('flash_anzan', 'element')),
  activity_name TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  time_seconds INTEGER NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: daily_tasks
CREATE TABLE IF NOT EXISTS public.daily_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  level TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ------------------------------------------------------------------------------
-- 3. HELPER FUNCTION: is_admin() (SECURITY DEFINER)
-- Prevents RLS recursion when policies inspect the profiles table.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT role = 'admin' AND active = true 
     FROM public.profiles 
     WHERE id = auth.uid()),
    false
  );
$$;

-- ------------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- Enabled and updated after tables exist
-- ------------------------------------------------------------------------------

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;

-- Clean existing policies so script can be safely re-run at any time
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
DROP POLICY IF EXISTS "profiles_admin_write_policy" ON public.profiles;

DROP POLICY IF EXISTS "categories_read_policy" ON public.categories;
DROP POLICY IF EXISTS "categories_admin_write_policy" ON public.categories;

DROP POLICY IF EXISTS "rounds_read_policy" ON public.rounds;
DROP POLICY IF EXISTS "rounds_admin_write_policy" ON public.rounds;

DROP POLICY IF EXISTS "daily_tasks_read_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_admin_write_policy" ON public.daily_tasks;

DROP POLICY IF EXISTS "results_select_policy" ON public.results;
DROP POLICY IF EXISTS "results_insert_policy" ON public.results;
DROP POLICY IF EXISTS "results_update_policy" ON public.results;
DROP POLICY IF EXISTS "results_delete_policy" ON public.results;

DROP POLICY IF EXISTS "activity_results_select_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_insert_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_update_policy" ON public.activity_results;
DROP POLICY IF EXISTS "activity_results_delete_policy" ON public.activity_results;

-- Profiles Policies:
-- 1. A user can read their own profile, or an admin can read all profiles.
CREATE POLICY "profiles_select_policy"
ON public.profiles FOR SELECT
TO authenticated
USING (id = auth.uid() OR public.is_admin());

-- 2. Only admins can insert, update, or delete profiles.
CREATE POLICY "profiles_admin_write_policy"
ON public.profiles FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Categories Policies:
-- 1. Every authenticated user can read categories.
CREATE POLICY "categories_read_policy"
ON public.categories FOR SELECT
TO authenticated
USING (true);

-- 2. Only admins can insert, update, or delete categories.
CREATE POLICY "categories_admin_write_policy"
ON public.categories FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Rounds Policies:
-- 1. Every authenticated user can read rounds.
CREATE POLICY "rounds_read_policy"
ON public.rounds FOR SELECT
TO authenticated
USING (true);

-- 2. Only admins can manage rounds.
CREATE POLICY "rounds_admin_write_policy"
ON public.rounds FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Daily Tasks Policies:
-- 1. Every authenticated user can read active tasks.
CREATE POLICY "daily_tasks_read_policy"
ON public.daily_tasks FOR SELECT
TO authenticated
USING (true);

-- 2. Only admins can manage daily tasks.
CREATE POLICY "daily_tasks_admin_write_policy"
ON public.daily_tasks FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Results Policies:
-- Students can only read and manage their own scores. Students CANNOT alter the verified flag.
-- Admins can read, edit, delete everything and set verified = true.

CREATE POLICY "results_select_policy"
ON public.results FOR SELECT
TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "results_insert_policy"
ON public.results FOR INSERT
TO authenticated
WITH CHECK (
  (student_id = auth.uid() AND verified = false) OR public.is_admin()
);

CREATE POLICY "results_update_policy"
ON public.results FOR UPDATE
TO authenticated
USING (
  (student_id = auth.uid() AND verified = false) OR public.is_admin()
)
WITH CHECK (
  (student_id = auth.uid() AND verified = false) OR public.is_admin()
);

CREATE POLICY "results_delete_policy"
ON public.results FOR DELETE
TO authenticated
USING (
  (student_id = auth.uid() AND verified = false) OR public.is_admin()
);

-- Activity Results Policies:
CREATE POLICY "activity_results_select_policy"
ON public.activity_results FOR SELECT
TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_insert_policy"
ON public.activity_results FOR INSERT
TO authenticated
WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_update_policy"
ON public.activity_results FOR UPDATE
TO authenticated
USING (student_id = auth.uid() OR public.is_admin())
WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_delete_policy"
ON public.activity_results FOR DELETE
TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

-- ------------------------------------------------------------------------------
-- 5. INDEXES
-- ------------------------------------------------------------------------------

-- Partial unique index: A student can only have 1 entry per category per round
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique_round 
ON public.results(student_id, round_number, category_id) 
WHERE round_number IS NOT NULL;

-- Query performance indexes for score history & reports
CREATE INDEX IF NOT EXISTS idx_results_student_entry_date 
ON public.results(student_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_results_student_category 
ON public.results(student_id, category_id);

CREATE INDEX IF NOT EXISTS idx_profiles_student_code 
ON public.profiles(student_code);

CREATE INDEX IF NOT EXISTS idx_categories_section_sort 
ON public.categories(section, sort_order ASC);

-- ------------------------------------------------------------------------------
-- 6. SEED DATA: 24 ROUND CATEGORIES + 2 BASICS CATEGORIES
-- ------------------------------------------------------------------------------

-- Seed the 24 championship categories in exact competition sequence:
INSERT INTO public.categories (name, section, sort_order, active)
VALUES
  ('ADD', 'round', 1, true),
  ('SUB', 'round', 2, true),
  ('MIX', 'round', 3, true),
  ('MULT', 'round', 4, true),
  ('DIV', 'round', 5, true),
  ('BRAC', 'round', 6, true),
  ('PRIME FACTORS', 'round', 7, true),
  ('HCF and LCM', 'round', 8, true),
  ('FRAC +', 'round', 9, true),
  ('FRAC -', 'round', 10, true),
  ('FRAC *', 'round', 11, true),
  ('FRAC ÷', 'round', 12, true),
  ('Approximation', 'round', 13, true),
  ('Remainder', 'round', 14, true),
  ('Ratio', 'round', 15, true),
  ('Square Root', 'round', 16, true),
  ('D.P', 'round', 17, true),
  ('Next Square', 'round', 18, true),
  ('Cube root', 'round', 19, true),
  ('Next cube', 'round', 20, true),
  ('Calendar', 'round', 21, true),
  ('Time Elapsed', 'round', 22, true),
  ('Sum of Squares', 'round', 23, true),
  ('Surprise Task', 'round', 24, true)
ON CONFLICT DO NOTHING;

-- Seed two initial basics drill categories (digits and rows):
INSERT INTO public.categories (name, section, sort_order, active)
VALUES
  ('1d4r', 'basics', 1, true),
  ('2d2r', 'basics', 2, true)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------------------
-- 7. AUTOMATIC PROFILE SYNC TRIGGER
-- Automatically creates a profile row when a new user is created in Supabase Auth.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, student_code, full_name, role, level, active)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'student_code', UPPER(split_part(NEW.email, '@', 1))),
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'Student User'),
    COALESCE(NEW.raw_user_meta_data->>'role', 'student'),
    NEW.raw_user_meta_data->>'level',
    COALESCE((NEW.raw_user_meta_data->>'active')::boolean, true)
  )
  ON CONFLICT (id) DO UPDATE SET
    student_code = EXCLUDED.student_code,
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    level = EXCLUDED.level;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ==============================================================================
-- ONE-TIME ADMIN PROMOTION SNIPPET
-- After signing up your initial admin account in Supabase Auth (e.g., student code 'ADMIN01'
-- or email 'admin01@trendz.local'), run this snippet to promote yourself:
--
-- UPDATE public.profiles
-- SET role = 'admin', active = true
-- WHERE student_code = 'ADMIN01';
-- ==============================================================================

-- ==============================================================================
-- PHASE 4b: BASICS TARGETS & WEEKLY TESTS
-- ==============================================================================

-- Function: today_ist() - returns current date in Indian Standard Time (Asia/Kolkata)
CREATE OR REPLACE FUNCTION public.today_ist()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT (timezone('Asia/Kolkata', now()))::date;
$$;

-- Table: basics_thresholds
-- Enforces: only basics categories allowed, at most one default rule per category (level NULL)
-- and at most one rule per (category_id, level).
CREATE TABLE IF NOT EXISTS public.basics_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  level TEXT NULL,
  min_accuracy INTEGER NOT NULL CHECK (min_accuracy >= 0 AND min_accuracy <= 100),
  max_time_seconds INTEGER NULL CHECK (max_time_seconds IS NULL OR max_time_seconds > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Constraint: Only basics categories are allowed in basics_thresholds
CREATE OR REPLACE FUNCTION public.check_basics_threshold_category()
RETURNS TRIGGER AS $$
DECLARE
  cat_section TEXT;
BEGIN
  SELECT section INTO cat_section FROM public.categories WHERE id = NEW.category_id;
  IF cat_section IS DISTINCT FROM 'basics' THEN
    RAISE EXCEPTION 'Only categories in the basics section can have target thresholds (category % has section %)', NEW.category_id, cat_section;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_basics_threshold_category ON public.basics_thresholds;
CREATE TRIGGER trg_check_basics_threshold_category
  BEFORE INSERT OR UPDATE ON public.basics_thresholds
  FOR EACH ROW EXECUTE FUNCTION public.check_basics_threshold_category();

-- Unique rule constraints:
CREATE UNIQUE INDEX IF NOT EXISTS idx_basics_thresholds_cat_level
  ON public.basics_thresholds (category_id, level)
  WHERE level IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_basics_thresholds_cat_default
  ON public.basics_thresholds (category_id)
  WHERE level IS NULL;

-- Table: weekly_tests
CREATE TABLE IF NOT EXISTS public.weekly_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_date DATE NOT NULL DEFAULT public.today_ist(),
  title TEXT NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Table: weekly_test_scores
CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  correct INTEGER NOT NULL CHECK (correct >= 0),
  total INTEGER NOT NULL CHECK (total > 0),
  time_seconds INTEGER NULL CHECK (time_seconds IS NULL OR time_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT chk_test_score_correct_lte_total CHECK (correct <= total),
  CONSTRAINT uq_weekly_test_scores_test_student_cat UNIQUE (test_id, student_id, category_id)
);

-- View: results_with_target
-- All columns of results plus min_accuracy, max_time_seconds and meets_target
-- A level-specific rule beats the default rule.
-- If a maximum time is set, an entry without a time does not meet the target.
CREATE OR REPLACE VIEW public.results_with_target AS
WITH effective_targets AS (
  SELECT
    r.id AS result_id,
    COALESCE(lvl_t.min_accuracy, def_t.min_accuracy) AS min_accuracy,
    COALESCE(lvl_t.max_time_seconds, def_t.max_time_seconds) AS max_time_seconds
  FROM public.results r
  JOIN public.profiles p ON p.id = r.student_id
  LEFT JOIN public.basics_thresholds lvl_t 
    ON lvl_t.category_id = r.category_id 
    AND lvl_t.active = true 
    AND lvl_t.level IS NOT NULL 
    AND LOWER(TRIM(lvl_t.level)) = LOWER(TRIM(COALESCE(p.level, '')))
  LEFT JOIN public.basics_thresholds def_t 
    ON def_t.category_id = r.category_id 
    AND def_t.active = true 
    AND def_t.level IS NULL
)
SELECT
  r.*,
  t.min_accuracy,
  t.max_time_seconds,
  CASE
    -- When no target exists for this category/student, meets_target is null
    WHEN t.min_accuracy IS NULL AND t.max_time_seconds IS NULL THEN NULL
    -- If max_time_seconds is set, an entry without a time does not meet the target
    WHEN t.max_time_seconds IS NOT NULL AND (r.time_seconds IS NULL OR r.time_seconds > t.max_time_seconds) THEN false
    -- Check accuracy if total > 0
    WHEN r.total IS NULL OR r.total <= 0 THEN false
    WHEN ((r.correct::numeric / r.total::numeric) * 100.0) < COALESCE(t.min_accuracy, 0) THEN false
    ELSE true
  END AS meets_target
FROM public.results r
LEFT JOIN effective_targets t ON t.result_id = r.id;

-- Enable RLS
ALTER TABLE public.basics_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_test_scores ENABLE ROW LEVEL SECURITY;

-- Policies for basics_thresholds: Everyone can read active thresholds; Admins full control
CREATE POLICY "Anyone can read active basics thresholds" ON public.basics_thresholds
  FOR SELECT TO authenticated USING (active = true OR public.is_admin());

CREATE POLICY "Admins full access to basics thresholds" ON public.basics_thresholds
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Policies for weekly_tests: Authenticated users can read tests; Admins full control
CREATE POLICY "Authenticated users can read weekly tests" ON public.weekly_tests
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins full access to weekly tests" ON public.weekly_tests
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Policies for weekly_test_scores:
-- Students can only read their own scores; Admins can read and write all scores.
CREATE POLICY "Students read own weekly test scores" ON public.weekly_test_scores
  FOR SELECT TO authenticated USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "Admins manage weekly test scores" ON public.weekly_test_scores
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
