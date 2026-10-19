-- ==============================================================================
-- 01_phase1_schema.sql
-- Phase 1: Core Tables, Helper Functions, Row Level Security (RLS), Indexes & Seeds
-- Run Order: 1 of 12
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Table: profiles (id matches auth.users.id)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  student_code TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  level TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Table: categories
CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  section TEXT NOT NULL CHECK (section IN ('round', 'basics', 'elements', 'flash')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Table: rounds (Legacy Phase 1 table; superseded in Phase 4c-0 by student_rounds)
CREATE TABLE IF NOT EXISTS public.rounds (
  round_number INTEGER PRIMARY KEY,
  round_date DATE NOT NULL DEFAULT CURRENT_DATE,
  round_type TEXT NOT NULL DEFAULT 'Category wise',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Table: results
CREATE TABLE IF NOT EXISTS public.results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  round_number INTEGER NULL REFERENCES public.rounds(round_number) ON DELETE SET NULL,
  correct INTEGER NULL CHECK (correct >= 0),
  total INTEGER NULL CHECK (total >= 0),
  time_seconds INTEGER NULL CHECK (time_seconds >= 0),
  note TEXT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 5. Table: activity_results
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

-- 6. Table: daily_tasks
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

-- Helper Function: is_admin() (SECURITY DEFINER)
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

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;

-- Clean existing policies
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

-- Profiles Policies
CREATE POLICY "profiles_select_policy"
ON public.profiles FOR SELECT TO authenticated
USING (id = auth.uid() OR public.is_admin());

CREATE POLICY "profiles_admin_write_policy"
ON public.profiles FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Categories Policies
CREATE POLICY "categories_read_policy"
ON public.categories FOR SELECT TO authenticated USING (true);

CREATE POLICY "categories_admin_write_policy"
ON public.categories FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Rounds Policies
CREATE POLICY "rounds_read_policy"
ON public.rounds FOR SELECT TO authenticated USING (true);

CREATE POLICY "rounds_admin_write_policy"
ON public.rounds FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Daily Tasks Policies
CREATE POLICY "daily_tasks_read_policy"
ON public.daily_tasks FOR SELECT TO authenticated USING (true);

CREATE POLICY "daily_tasks_admin_write_policy"
ON public.daily_tasks FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Results Policies
CREATE POLICY "results_select_policy"
ON public.results FOR SELECT TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "results_insert_policy"
ON public.results FOR INSERT TO authenticated
WITH CHECK ((student_id = auth.uid() AND verified = false) OR public.is_admin());

CREATE POLICY "results_update_policy"
ON public.results FOR UPDATE TO authenticated
USING ((student_id = auth.uid() AND verified = false) OR public.is_admin())
WITH CHECK ((student_id = auth.uid() AND verified = false) OR public.is_admin());

CREATE POLICY "results_delete_policy"
ON public.results FOR DELETE TO authenticated
USING ((student_id = auth.uid() AND verified = false) OR public.is_admin());

-- Activity Results Policies
CREATE POLICY "activity_results_select_policy"
ON public.activity_results FOR SELECT TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_insert_policy"
ON public.activity_results FOR INSERT TO authenticated
WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_update_policy"
ON public.activity_results FOR UPDATE TO authenticated
USING (student_id = auth.uid() OR public.is_admin())
WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "activity_results_delete_policy"
ON public.activity_results FOR DELETE TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique_round
ON public.results(student_id, round_number, category_id)
WHERE round_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_results_student_entry_date
ON public.results(student_id, entry_date DESC);

CREATE INDEX IF NOT EXISTS idx_results_student_category
ON public.results(student_id, category_id);

CREATE INDEX IF NOT EXISTS idx_profiles_student_code
ON public.profiles(student_code);

CREATE INDEX IF NOT EXISTS idx_categories_section_sort
ON public.categories(section, sort_order ASC);

-- Seed 24 Round Categories
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

-- Seed Initial Basics Categories
INSERT INTO public.categories (name, section, sort_order, active)
VALUES
  ('1d4r', 'basics', 1, true),
  ('2d2r', 'basics', 2, true)
ON CONFLICT DO NOTHING;
