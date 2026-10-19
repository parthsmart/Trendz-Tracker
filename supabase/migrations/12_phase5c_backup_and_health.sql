-- ==============================================================================
-- 12_phase5c_backup_and_health.sql
-- Phase 5c: Nightly Google Sheet Backup, Manual ZIP Export & Schema Health
-- Run Order: 12 of 12
-- ==============================================================================

-- 1. Ensure updated_at exists on results, activity_results, and attendance
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.activity_results
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_results_updated_at ON public.results;
CREATE TRIGGER trg_results_updated_at
  BEFORE UPDATE ON public.results
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_activity_results_updated_at ON public.activity_results;
CREATE TRIGGER trg_activity_results_updated_at
  BEFORE UPDATE ON public.activity_results
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_attendance_updated_at ON public.attendance;
CREATE TRIGGER trg_attendance_updated_at
  BEFORE UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- 2. Table: backup_state (1 row per backed-up table)
CREATE TABLE IF NOT EXISTS public.backup_state (
  table_name TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append')),
  cursor_column TEXT,
  cursor_value TEXT,
  cursor_id UUID,
  rows_written INTEGER NOT NULL DEFAULT 0,
  cells_written INTEGER NOT NULL DEFAULT 0,
  header TEXT[],
  last_run_at TIMESTAMPTZ,
  last_error TEXT
);

ALTER TABLE public.backup_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_state_admin_select ON public.backup_state;
CREATE POLICY backup_state_admin_select ON public.backup_state
  FOR SELECT TO authenticated
  USING (public.is_admin());

INSERT INTO public.backup_state (table_name, mode, cursor_column)
VALUES
  ('profiles', 'snapshot', NULL),
  ('round_series', 'snapshot', NULL),
  ('categories', 'snapshot', NULL),
  ('category_series', 'snapshot', NULL),
  ('basics_thresholds', 'snapshot', NULL),
  ('daily_tasks', 'snapshot', NULL),
  ('resources', 'snapshot', NULL),
  ('competition_settings', 'snapshot', NULL),
  ('category_aliases', 'snapshot', NULL),
  ('attendance_sessions', 'snapshot', NULL),
  ('weekly_tests', 'snapshot', NULL),
  ('import_batches', 'snapshot', NULL),
  ('student_rounds', 'append', 'updated_at'),
  ('results', 'append', 'updated_at'),
  ('weekly_test_scores', 'append', 'updated_at'),
  ('attendance', 'append', 'updated_at'),
  ('activity_results', 'append', 'updated_at'),
  ('result_audit', 'append', 'changed_at')
ON CONFLICT (table_name) DO NOTHING;

-- 3. Table: backup_runs (execution log for cron, manual sheet runs, and ZIP exports)
CREATE TABLE IF NOT EXISTS public.backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('cron', 'manual', 'export')),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'partial', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  rows_written INTEGER NOT NULL DEFAULT 0,
  tables JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_runs_single_running
  ON public.backup_runs ((status))
  WHERE status = 'running';

ALTER TABLE public.backup_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backup_runs_admin_select ON public.backup_runs;
CREATE POLICY backup_runs_admin_select ON public.backup_runs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- 4. RPC: admin_log_export(p_rows integer, p_tables jsonb)
CREATE OR REPLACE FUNCTION public.admin_log_export(
  p_rows INTEGER,
  p_tables JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  INSERT INTO public.backup_runs (
    kind,
    status,
    started_at,
    finished_at,
    rows_written,
    tables,
    created_by
  )
  VALUES (
    'export',
    'done',
    now(),
    now(),
    COALESCE(p_rows, 0),
    COALESCE(p_tables, '{}'::jsonb),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_log_export(INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_log_export(INTEGER, JSONB) TO authenticated;

-- 5. RPC: admin_schema_health()
CREATE OR REPLACE FUNCTION public.admin_schema_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  RETURN jsonb_build_object(
    'checked_on_ist', public.today_ist(),
    'tables', jsonb_build_object(
      'profiles', (SELECT COUNT(*)::INTEGER FROM public.profiles),
      'categories', (SELECT COUNT(*)::INTEGER FROM public.categories),
      'round_series', (SELECT COUNT(*)::INTEGER FROM public.round_series),
      'category_series', (SELECT COUNT(*)::INTEGER FROM public.category_series),
      'student_rounds', (SELECT COUNT(*)::INTEGER FROM public.student_rounds),
      'results', (SELECT COUNT(*)::INTEGER FROM public.results),
      'result_audit', (SELECT COUNT(*)::INTEGER FROM public.result_audit),
      'attendance_sessions', (SELECT COUNT(*)::INTEGER FROM public.attendance_sessions),
      'attendance', (SELECT COUNT(*)::INTEGER FROM public.attendance),
      'basics_thresholds', (SELECT COUNT(*)::INTEGER FROM public.basics_thresholds),
      'weekly_tests', (SELECT COUNT(*)::INTEGER FROM public.weekly_tests),
      'weekly_test_scores', (SELECT COUNT(*)::INTEGER FROM public.weekly_test_scores),
      'competition_settings', (SELECT COUNT(*)::INTEGER FROM public.competition_settings),
      'report_log', (SELECT COUNT(*)::INTEGER FROM public.report_log),
      'backup_state', (SELECT COUNT(*)::INTEGER FROM public.backup_state),
      'backup_runs', (SELECT COUNT(*)::INTEGER FROM public.backup_runs)
    )
  );
END;
$$;
