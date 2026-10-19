-- ==============================================================================
-- 05_phase3b_admin_overview.sql
-- Phase 3b: Admin Overview RPC (admin_overview)
-- Run Order: 5 of 12
-- ==============================================================================

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
