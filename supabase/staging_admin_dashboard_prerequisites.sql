-- =============================================================================
-- Trendz Tracker — Staging Admin Dashboard Prerequisites Setup
-- File: supabase/staging_admin_dashboard_prerequisites.sql
--
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
--   Provisions the missing Admin Dashboard contracts on the staging database:
--   1. RPC public.admin_overview() (from migration 05_phase3b_admin_overview.sql)
--   2. Table public.report_log with RLS and policies (from migration 11_phase5b_reports_and_milestones.sql)
--   3. RPC public.admin_milestones(p_days) (from migration 11_phase5b_reports_and_milestones.sql)
--
-- CAUSE OF STAGING ANOMALY:
--   The staging admin dashboard showed 0 students despite active student profiles
--   because adminOverview.js calls supabase.rpc('admin_overview'). When this function
--   was missing on staging, adminOverview.js caught the 404 error and fell back to
--   setting allOverviewData = [], rendering 0 students. Furthermore, admin_milestones
--   and report_log were also missing from the staging database.
--
-- DATABASE IDENTITY & OPERATOR CONFIRMATION:
--   PostgreSQL hosted within Supabase does not expose the hosted project reference
--   in any catalog or configuration table (current_database() = 'postgres').
--   No reliable SQL-level catalog check exists to verify project identity automatically.
--
--   Therefore, actual environment verification requires the operator to visually
--   confirm project xhgzbbkvwojwfbexvcmh in the Supabase Dashboard URL:
--     https://supabase.com/dashboard/project/xhgzbbkvwojwfbexvcmh/sql
--
--   To guard against accidental execution in another environment (e.g. production Mumbai),
--   this script requires an explicit operator confirmation variable:
--     SET app.confirm_staging_project = 'xhgzbbkvwojwfbexvcmh';
--   The script intentionally does NOT set this variable itself. If unset or mismatched,
--   execution immediately aborts.
--
-- DEPENDENCY VALIDATION:
--   - public.admin_overview() depends on:
--       public.today_ist(), public.is_admin(), public.streak_for(UUID),
--       public.profiles, public.results. All installed on staging.
--   - public.report_log depends on:
--       public.profiles(id), public.is_admin(). All installed on staging.
--   - public.admin_milestones(p_days) depends on:
--       public.is_admin(), public.profiles, public.streak_for(UUID). All installed on staging.
--
-- SCHEMA & TRANSACTION SAFETY:
--   - PURE SCHEMA ONLY: Zero student records, passwords, or secrets.
--   - TRANSACTIONAL: Wrapped in BEGIN; ... COMMIT;.
--   - IDEMPOTENT: Uses CREATE TABLE IF NOT EXISTS and CREATE OR REPLACE FUNCTION.
--   - PRESERVES EXISTING DATA: Never drops or truncates existing profiles, results,
--     categories, or teacher assignments.
--
-- HOW TO RUN:
--   1. In Supabase Dashboard, visually verify you are in project `xhgzbbkvwojwfbexvcmh`.
--   2. In the SQL Editor, execute the operator confirmation line:
--        SET app.confirm_staging_project = 'xhgzbbkvwojwfbexvcmh';
--   3. Run this script.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. PRE-FLIGHT CHECK: OPERATOR VISUAL CONFIRMATION LATCH
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_confirm TEXT := current_setting('app.confirm_staging_project', true);
BEGIN
  IF v_confirm IS DISTINCT FROM 'xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR CONFIRMATION REQUIRED:
This script must ONLY be executed on dedicated staging project xhgzbbkvwojwfbexvcmh.
PostgreSQL catalogs do not expose the hosted Supabase project reference.
Before running, you must visually verify project xhgzbbkvwojwfbexvcmh in your
Supabase dashboard, then execute:
  SET app.confirm_staging_project = ''xhgzbbkvwojwfbexvcmh'';
in your SQL editor session before (or alongside) this transaction block.'
      USING ERRCODE = '28000';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. RPC: public.admin_overview()
-- Source: supabase/migrations/05_phase3b_admin_overview.sql
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_overview()
RETURNS TABLE (
  student_id UUID,
  student_code TEXT,
  full_name TEXT,
  level TEXT,
  active BOOLEAN,
  current_streak INTEGER,
  best_streak INTEGER,
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
    COALESCE(st.best_streak, 0) AS best_streak,
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

REVOKE ALL ON FUNCTION public.admin_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_overview() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. TABLE: public.report_log
-- Source: supabase/migrations/11_phase5b_reports_and_milestones.sql
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.report_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cron', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  error TEXT NULL,
  to_email TEXT NULL,
  created_by UUID NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  finished_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_log_unique_cron_week
  ON public.report_log (week_start)
  WHERE kind = 'cron' AND status IN ('sending', 'sent');

ALTER TABLE public.report_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_log_admin_read" ON public.report_log;
CREATE POLICY "report_log_admin_read"
  ON public.report_log FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON TABLE public.report_log TO authenticated;
GRANT ALL ON TABLE public.report_log TO service_role;

-- -----------------------------------------------------------------------------
-- 3. RPC: public.admin_milestones(p_days)
-- Source: supabase/migrations/11_phase5b_reports_and_milestones.sql
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_milestones(p_days INTEGER DEFAULT 7)
RETURNS TABLE (
  student_id UUID,
  student_code TEXT,
  full_name TEXT,
  level TEXT,
  current_streak INTEGER,
  milestone INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  RETURN QUERY
  WITH active_streaks AS (
    SELECT
      p.id AS s_id,
      p.student_code AS s_code,
      p.full_name AS s_name,
      p.level AS s_level,
      COALESCE(st.current_streak, 0) AS cur_streak
    FROM public.profiles p
    LEFT JOIN LATERAL public.streak_for(p.id) st ON true
    WHERE p.role = 'student' AND p.active = true
  )
  SELECT
    a.s_id AS student_id,
    a.s_code AS student_code,
    a.s_name AS full_name,
    a.s_level AS level,
    a.cur_streak AS current_streak,
    m.m_val AS milestone
  FROM active_streaks a
  CROSS JOIN LATERAL (
    SELECT MAX(val) AS m_val
    FROM unnest(ARRAY[25, 50, 100, 200]) AS val
    WHERE a.cur_streak >= val AND a.cur_streak < val + GREATEST(COALESCE(p_days, 7), 1)
  ) m
  WHERE m.m_val IS NOT NULL
  ORDER BY m.m_val DESC, a.cur_streak DESC, a.s_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_milestones(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_milestones(INTEGER) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. POST-CHECK VALIDATION
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'report_log'
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: Table public.report_log was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'admin_overview' AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: Function public.admin_overview was not created.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'admin_milestones' AND pronamespace = 'public'::regnamespace
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: Function public.admin_milestones was not created.';
  END IF;
END $$;

COMMIT;
