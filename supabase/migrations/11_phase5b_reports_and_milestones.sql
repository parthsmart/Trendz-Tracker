-- ==============================================================================
-- 11_phase5b_reports_and_milestones.sql
-- Phase 5b: Weekly Report Email Log (report_log), weekly_report_data(),
-- student_month_report(p_student, p_month), and admin_milestones(p_days)
-- Run Order: 11 of 12
-- ==============================================================================

-- 1. Table: report_log
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

-- Unique index: allow only one 'cron' report per week_start while status is 'sending' or 'sent'
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_log_unique_cron_week
  ON public.report_log (week_start)
  WHERE kind = 'cron' AND status IN ('sending', 'sent');

ALTER TABLE public.report_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "report_log_admin_read" ON public.report_log;
CREATE POLICY "report_log_admin_read"
  ON public.report_log FOR SELECT TO authenticated
  USING (public.is_admin());

-- 2. RPC: admin_milestones(p_days default 7)
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

-- 3. RPC: student_month_report(p_student, p_month)
CREATE OR REPLACE FUNCTION public.student_month_report(
  p_student UUID DEFAULT NULL,
  p_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_today DATE := public.today_ist();
  v_ref_date DATE := COALESCE(p_month, v_today);
  v_month_start DATE := date_trunc('month', v_ref_date::timestamp)::date;
  v_month_end DATE := (date_trunc('month', v_ref_date::timestamp) + INTERVAL '1 month - 1 day')::date;
  v_prev_start DATE := (date_trunc('month', v_ref_date::timestamp) - INTERVAL '1 month')::date;
  v_prev_end DATE := (v_month_start - 1);
  v_days_elapsed INTEGER;
  v_student RECORD;
  v_practice JSONB;
  v_previous JSONB;
  v_streak RECORD;
  v_att RECORD;
  v_points INTEGER := 0;
  v_weeks JSONB;
  v_categories JSONB;
  v_targets JSONB;
  v_tests JSONB;
  v_test_mult INTEGER;
  v_att_pts INTEGER;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own monthly report.';
  END IF;

  SELECT id, full_name, student_code, level
  INTO v_student
  FROM public.profiles
  WHERE id = v_target;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found.';
  END IF;

  v_days_elapsed := CASE
    WHEN v_today < v_month_start THEN 0
    WHEN v_today > v_month_end THEN (v_month_end - v_month_start + 1)
    ELSE (v_today - v_month_start + 1)
  END;

  -- Current month practice
  SELECT jsonb_build_object(
    'entries', COUNT(*)::INTEGER,
    'correct', COALESCE(SUM(r.correct), 0)::INTEGER,
    'total', COALESCE(SUM(r.total), 0)::INTEGER,
    'accuracy', CASE WHEN SUM(r.total) > 0 THEN ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ELSE NULL END,
    'qpm', CASE WHEN SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0) > 0
                THEN ROUND((SUM(r.total) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric * 60.0) / SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric, 1)
                ELSE NULL END,
    'rounds', COUNT(DISTINCT r.student_round_id) FILTER (WHERE r.student_round_id IS NOT NULL)::INTEGER,
    'practice_days', COUNT(DISTINCT r.entry_date)::INTEGER
  ) INTO v_practice
  FROM public.results r
  WHERE r.student_id = v_target AND r.entry_date BETWEEN v_month_start AND v_month_end;

  -- Previous month practice
  SELECT jsonb_build_object(
    'entries', COUNT(*)::INTEGER,
    'accuracy', CASE WHEN SUM(r.total) > 0 THEN ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ELSE NULL END,
    'qpm', CASE WHEN SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0) > 0
                THEN ROUND((SUM(r.total) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric * 60.0) / SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric, 1)
                ELSE NULL END,
    'practice_days', COUNT(DISTINCT r.entry_date)::INTEGER
  ) INTO v_previous
  FROM public.results r
  WHERE r.student_id = v_target AND r.entry_date BETWEEN v_prev_start AND v_prev_end;

  SELECT * INTO v_streak FROM public.streak_for(v_target);
  SELECT * INTO v_att FROM public.attendance_summary(v_target, v_month_start, v_month_end);
  SELECT weekly_test_multiplier, attendance_present_points INTO v_test_mult, v_att_pts FROM public.competition_rules();

  SELECT
    COALESCE((
      SELECT SUM(GREATEST(COALESCE(r.correct, 0) - GREATEST(COALESCE(r.total, 0) - COALESCE(r.correct, 0), 0), 0))
      FROM public.results r
      WHERE r.student_id = v_target AND r.entry_date BETWEEN v_month_start AND v_month_end
    ), 0)
    + COALESCE((
      SELECT SUM(GREATEST(wts.correct - (wts.total - wts.correct), 0)) * v_test_mult
      FROM public.weekly_test_scores wts
      JOIN public.weekly_tests wt ON wt.id = wts.test_id
      WHERE wts.student_id = v_target AND wt.test_date BETWEEN v_month_start AND v_month_end
    ), 0)
    + (COALESCE(v_att.present_count, 0) * v_att_pts)
  INTO v_points;

  -- Weekly breakdown inside month
  SELECT COALESCE(jsonb_agg(w_row ORDER BY w_row->>'week_start' ASC), '[]'::jsonb)
  INTO v_weeks
  FROM (
    SELECT jsonb_build_object(
      'week_start', gs::date,
      'entries', COUNT(r.id)::INTEGER,
      'accuracy', CASE WHEN SUM(r.total) > 0 THEN ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ELSE NULL END
    ) AS w_row
    FROM generate_series(
      date_trunc('week', v_month_start::timestamp)::date,
      v_month_end,
      INTERVAL '7 days'
    ) gs
    LEFT JOIN public.results r
      ON r.student_id = v_target
      AND r.entry_date BETWEEN GREATEST(gs::date, v_month_start) AND LEAST((gs::date + 6), v_month_end)
    GROUP BY gs
  ) sub_w;

  -- Categories with >= 3 entries sorted by accuracy ascending
  SELECT COALESCE(jsonb_agg(c_row), '[]'::jsonb)
  INTO v_categories
  FROM (
    SELECT jsonb_build_object(
      'name', c.name,
      'section', c.section,
      'entries', COUNT(r.id)::INTEGER,
      'accuracy', ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1),
      'wrong', SUM(GREATEST(r.total - r.correct, 0))::INTEGER
    ) AS c_row
    FROM public.results r
    JOIN public.categories c ON c.id = r.category_id
    WHERE r.student_id = v_target
      AND r.entry_date BETWEEN v_month_start AND v_month_end
      AND r.total > 0
    GROUP BY c.id, c.name, c.section
    HAVING COUNT(r.id) >= 3 AND SUM(r.total) > 0
    ORDER BY ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ASC, COUNT(r.id) DESC
  ) sub_c;

  -- Basics targets measured & met
  SELECT jsonb_build_object(
    'measured', COUNT(*) FILTER (WHERE rwt.meets_target IS NOT NULL)::INTEGER,
    'met', COUNT(*) FILTER (WHERE rwt.meets_target = true)::INTEGER
  ) INTO v_targets
  FROM public.results_with_target rwt
  WHERE rwt.student_id = v_target AND rwt.entry_date BETWEEN v_month_start AND v_month_end;

  -- Weekly test scores in month
  SELECT COALESCE(jsonb_agg(t_row), '[]'::jsonb)
  INTO v_tests
  FROM (
    SELECT jsonb_build_object(
      'title', wt.title,
      'date', wt.test_date,
      'category', c.name,
      'correct', wts.correct,
      'total', wts.total,
      'time_seconds', wts.time_seconds
    ) AS t_row
    FROM public.weekly_test_scores wts
    JOIN public.weekly_tests wt ON wt.id = wts.test_id
    JOIN public.categories c ON c.id = wts.category_id
    WHERE wts.student_id = v_target
      AND wt.test_date BETWEEN v_month_start AND v_month_end
    ORDER BY wt.test_date DESC, c.sort_order ASC
  ) sub_t;

  RETURN jsonb_build_object(
    'student', jsonb_build_object('name', v_student.full_name, 'code', v_student.student_code, 'level', v_student.level),
    'month_start', v_month_start,
    'month_end', v_month_end,
    'days_elapsed', v_days_elapsed,
    'practice', v_practice,
    'previous', v_previous,
    'streak', jsonb_build_object('current', COALESCE(v_streak.current_streak, 0), 'best', COALESCE(v_streak.best_streak, 0)),
    'attendance', jsonb_build_object(
      'present', COALESCE(v_att.present_count, 0),
      'absent', COALESCE(v_att.absent_count, 0),
      'excused', COALESCE(v_att.excused_count, 0),
      'percent', v_att.attendance_pct
    ),
    'points', COALESCE(v_points, 0),
    'weeks', v_weeks,
    'categories', v_categories,
    'targets', v_targets,
    'weekly_tests', v_tests
  );
END;
$$;

-- 4. RPC: weekly_report_data() (Service role only)
CREATE OR REPLACE FUNCTION public.weekly_report_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_today DATE := public.today_ist();
  v_week_start DATE := (v_today - 6);
  v_week_end DATE := v_today;
  v_active_count INTEGER := 0;
  v_practised_count INTEGER := 0;
  v_avg_acc NUMERIC := NULL;
  v_students JSONB;
  v_attention JSONB;
  v_milestones JSONB;
  v_sessions JSONB;
  v_tests JSONB;
BEGIN
  IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role'
     AND session_user NOT IN ('postgres', 'service_role') THEN
    RAISE EXCEPTION 'permission denied for function weekly_report_data' USING ERRCODE = '42501';
  END IF;

  SELECT COUNT(*)::INTEGER INTO v_active_count
  FROM public.profiles WHERE role = 'student' AND active = true;

  SELECT
    COUNT(DISTINCT r.student_id)::INTEGER,
    CASE WHEN SUM(r.total) > 0 THEN ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ELSE NULL END
  INTO v_practised_count, v_avg_acc
  FROM public.results r
  JOIN public.profiles p ON p.id = r.student_id
  WHERE p.role = 'student' AND p.active = true
    AND r.entry_date BETWEEN v_week_start AND v_week_end;

  SELECT COALESCE(jsonb_agg(s_obj), '[]'::jsonb)
  INTO v_students
  FROM (
    SELECT jsonb_build_object(
      'code', p.student_code,
      'name', p.full_name,
      'level', p.level,
      'practice_days', (
        SELECT COUNT(DISTINCT r.entry_date)::INTEGER
        FROM public.results r
        WHERE r.student_id = p.id AND r.entry_date BETWEEN v_week_start AND v_week_end
      ),
      'entries', (
        SELECT COUNT(*)::INTEGER
        FROM public.results r
        WHERE r.student_id = p.id AND r.entry_date BETWEEN v_week_start AND v_week_end
      ),
      'accuracy', (
        SELECT CASE WHEN SUM(r.total) > 0 THEN ROUND((SUM(r.correct)::numeric / SUM(r.total)::numeric) * 100.0, 1) ELSE NULL END
        FROM public.results r
        WHERE r.student_id = p.id AND r.entry_date BETWEEN v_week_start AND v_week_end AND r.total > 0
      ),
      'qpm', (
        SELECT CASE WHEN SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0) > 0
                    THEN ROUND((SUM(r.total) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric * 60.0) / SUM(r.time_seconds) FILTER (WHERE r.time_seconds > 0 AND r.total > 0)::numeric, 1)
                    ELSE NULL END
        FROM public.results r
        WHERE r.student_id = p.id AND r.entry_date BETWEEN v_week_start AND v_week_end
      ),
      'streak', COALESCE(st.current_streak, 0),
      'points', COALESCE((
        SELECT SUM(GREATEST(COALESCE(r.correct, 0) - GREATEST(COALESCE(r.total, 0) - COALESCE(r.correct, 0), 0), 0))
        FROM public.results r
        WHERE r.student_id = p.id AND r.entry_date BETWEEN v_week_start AND v_week_end
      ), 0)
    ) AS s_obj
    FROM public.profiles p
    LEFT JOIN LATERAL public.streak_for(p.id) st ON true
    WHERE p.role = 'student' AND p.active = true
    ORDER BY COALESCE(p.level, 'ZZZ') ASC, p.full_name ASC
  ) sub_s;

  SELECT COALESCE(jsonb_agg(att_obj), '[]'::jsonb)
  INTO v_attention
  FROM (
    SELECT jsonb_build_object(
      'code', p.student_code,
      'name', p.full_name,
      'level', p.level,
      'last_entry', last_r.max_d,
      'days_ago', CASE WHEN last_r.max_d IS NOT NULL THEN (v_today - last_r.max_d) ELSE NULL END
    ) AS att_obj
    FROM public.profiles p
    LEFT JOIN LATERAL (
      SELECT MAX(r.entry_date) AS max_d FROM public.results r WHERE r.student_id = p.id
    ) last_r ON true
    WHERE p.role = 'student' AND p.active = true
      AND (last_r.max_d IS NULL OR (v_today - last_r.max_d) >= 3)
    ORDER BY last_r.max_d ASC NULLS FIRST, p.full_name ASC
  ) sub_att;

  SELECT COALESCE(jsonb_agg(m_obj), '[]'::jsonb)
  INTO v_milestones
  FROM (
    SELECT jsonb_build_object(
      'code', p.student_code,
      'name', p.full_name,
      'level', p.level,
      'milestone', m_val,
      'streak', COALESCE(st.current_streak, 0)
    ) AS m_obj
    FROM public.profiles p
    LEFT JOIN LATERAL public.streak_for(p.id) st ON true
    CROSS JOIN LATERAL (
      SELECT MAX(val) AS m_val
      FROM unnest(ARRAY[25, 50, 100, 200]) AS val
      WHERE COALESCE(st.current_streak, 0) >= val AND COALESCE(st.current_streak, 0) < val + 7
    ) m
    WHERE p.role = 'student' AND p.active = true AND m.m_val IS NOT NULL
    ORDER BY m.m_val DESC, st.current_streak DESC
  ) sub_m;

  SELECT COALESCE(jsonb_agg(sess_obj), '[]'::jsonb)
  INTO v_sessions
  FROM (
    SELECT jsonb_build_object(
      'date', s.session_date,
      'title', s.title,
      'type', s.session_type,
      'present', COUNT(*) FILTER (WHERE a.status = 'present')::INTEGER,
      'absent', COUNT(*) FILTER (WHERE a.status = 'absent')::INTEGER,
      'excused', COUNT(*) FILTER (WHERE a.status = 'excused')::INTEGER
    ) AS sess_obj
    FROM public.attendance_sessions s
    LEFT JOIN public.attendance a ON a.session_id = s.id
    WHERE s.session_date BETWEEN v_week_start AND v_week_end
    GROUP BY s.id, s.session_date, s.title, s.session_type
    ORDER BY s.session_date ASC
  ) sub_sess;

  SELECT COALESCE(jsonb_agg(wt_obj), '[]'::jsonb)
  INTO v_tests
  FROM (
    SELECT jsonb_build_object(
      'date', wt.test_date,
      'title', wt.title,
      'scores', COUNT(wts.id)::INTEGER
    ) AS wt_obj
    FROM public.weekly_tests wt
    LEFT JOIN public.weekly_test_scores wts ON wts.test_id = wt.id
    WHERE wt.test_date BETWEEN v_week_start AND v_week_end
    GROUP BY wt.id, wt.test_date, wt.title
    ORDER BY wt.test_date ASC
  ) sub_wt;

  RETURN jsonb_build_object(
    'week_start', v_week_start,
    'week_end', v_week_end,
    'generated_on', v_today,
    'summary', jsonb_build_object(
      'active_students', v_active_count,
      'students_with_entries', v_practised_count,
      'accuracy', v_avg_acc
    ),
    'students', v_students,
    'needs_attention', v_attention,
    'milestones', v_milestones,
    'sessions', v_sessions,
    'weekly_tests', v_tests
  );
END;
$$;

REVOKE ALL ON FUNCTION public.weekly_report_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_report_data() TO service_role;
