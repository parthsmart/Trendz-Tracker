-- =============================================================================
-- Trendz Tracker — JMCWC Staging Application & UI Prerequisites SQL
-- File: supabase/tests/jmcwc_staging_app_prerequisites.sql
--
-- TARGET ENVIRONMENT: ISOLATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
-- PURPOSE:
--   Upgrades the minimal staging database (which only has SQL-regression stubs)
--   with the minimum additional columns, helper functions, and dependent tables
--   required to allow real Supabase Auth login, student navigation (round-scores.html),
--   and admin JMCWC simulator configuration (rounds.html) without runtime errors.
--
-- DOES NOT TOUCH PRODUCTION. Owner runs this in Supabase SQL Editor.
-- =============================================================================

BEGIN;

-- 1. Extend public.profiles with columns required by js/auth.js and navigation
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS level text NULL,
  ADD COLUMN IF NOT EXISTS leaderboard_visible boolean NOT NULL DEFAULT true;

-- 2. Create is_admin() helper function required by RLS policies
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT coalesce(
    (SELECT role = 'admin' AND active = true
     FROM public.profiles
     WHERE id = auth.uid()),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon, service_role;

-- 3. Configure RLS on public.profiles for authenticated browser access
-- Allows users to load their own profile on login; allows admins to load all profiles
GRANT SELECT ON public.profiles TO authenticated;

DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "profiles_admin_write_policy" ON public.profiles;
CREATE POLICY "profiles_admin_write_policy"
  ON public.profiles FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 4. Configure RLS on public.categories for authenticated browser access
GRANT SELECT ON public.categories TO authenticated;

DROP POLICY IF EXISTS "categories_read_policy" ON public.categories;
CREATE POLICY "categories_read_policy"
  ON public.categories FOR SELECT TO authenticated
  USING (true);

-- 5. Create today_ist() RPC (consumed by roundScores.js and rounds.js)
CREATE OR REPLACE FUNCTION public.today_ist()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

GRANT EXECUTE ON FUNCTION public.today_ist() TO authenticated, anon, service_role;

-- 6. Dependent legacy tables queried on pages/round-scores.html and pages/rounds.html
CREATE TABLE IF NOT EXISTS public.round_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.round_series ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.round_series TO authenticated;
DROP POLICY IF EXISTS "round_series_read_policy" ON public.round_series;
CREATE POLICY "round_series_read_policy" ON public.round_series FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.category_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id uuid NOT NULL REFERENCES public.round_series(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0
);
ALTER TABLE public.category_series ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.category_series TO authenticated;
DROP POLICY IF EXISTS "category_series_read_policy" ON public.category_series;
CREATE POLICY "category_series_read_policy" ON public.category_series FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.student_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  round_type text NOT NULL DEFAULT 'Category wise',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.student_rounds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.student_rounds TO authenticated;
DROP POLICY IF EXISTS "student_rounds_policy" ON public.student_rounds;
CREATE POLICY "student_rounds_policy" ON public.student_rounds FOR ALL TO authenticated
  USING (student_id = auth.uid() OR public.is_admin())
  WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE TABLE IF NOT EXISTS public.results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  student_round_id uuid NULL REFERENCES public.student_rounds(id) ON DELETE SET NULL,
  correct integer NULL CHECK (correct >= 0),
  total integer NULL CHECK (total >= 0),
  time_seconds integer NULL CHECK (time_seconds >= 0),
  note text NULL,
  entry_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.results TO authenticated;
DROP POLICY IF EXISTS "results_policy" ON public.results;
CREATE POLICY "results_policy" ON public.results FOR ALL TO authenticated
  USING (student_id = auth.uid() OR public.is_admin())
  WITH CHECK (student_id = auth.uid() OR public.is_admin());

-- 7. Seed one baseline current round_series if none exists so round-scores.html header renders cleanly
INSERT INTO public.round_series (name, is_current, sort_order)
SELECT 'Series 1 (Staging Preview)', true, 1
WHERE NOT EXISTS (SELECT 1 FROM public.round_series);

COMMIT;
