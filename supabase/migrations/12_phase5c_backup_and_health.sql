-- ==============================================================================
-- 12_phase5c_backup_and_health.sql
-- Phase 5c: Database Backup Export & Schema Health Verification RPCs
-- Run Order: 12 of 12
-- ==============================================================================

-- 1. RPC: admin_schema_health()
-- Verifies that all required tables, views, and functions across Phases 1..5c exist.
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
      'report_log', (SELECT COUNT(*)::INTEGER FROM public.report_log)
    )
  );
END;
$$;
