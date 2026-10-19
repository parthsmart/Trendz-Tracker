-- ==============================================================================
-- 10_phase5a_competition_and_leaderboard.sql
-- Phase 5a: Leaderboard Visibility, competition_settings, competition_rules(),
-- and Role-Scoped leaderboard() RPC
-- Run Order: 10 of 12
-- ==============================================================================

-- 1. Add leaderboard_visible toggle to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT true;

-- 2. Table: competition_settings
CREATE TABLE IF NOT EXISTS public.competition_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

INSERT INTO public.competition_settings (key, value)
VALUES
  ('weekly_test_multiplier', '2'),
  ('attendance_present_points', '5'),
  ('improved_min_entries', '5'),
  ('leaderboard_names', 'first_name_initial')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.competition_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "competition_settings_admin_all" ON public.competition_settings;
CREATE POLICY "competition_settings_admin_all" ON public.competition_settings
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 3. RPC: competition_rules()
CREATE OR REPLACE FUNCTION public.competition_rules()
RETURNS TABLE (
  weekly_test_multiplier INTEGER,
  attendance_present_points INTEGER,
  improved_min_entries INTEGER,
  leaderboard_names TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    COALESCE((SELECT value::integer FROM public.competition_settings WHERE key = 'weekly_test_multiplier'), 2),
    COALESCE((SELECT value::integer FROM public.competition_settings WHERE key = 'attendance_present_points'), 5),
    COALESCE((SELECT value::integer FROM public.competition_settings WHERE key = 'improved_min_entries'), 5),
    COALESCE((SELECT value FROM public.competition_settings WHERE key = 'leaderboard_names'), 'first_name_initial');
$$;

-- 4. Helper to format display name according to leaderboard_names rule
CREATE OR REPLACE FUNCTION public.format_leaderboard_name(p_full_name TEXT, p_code TEXT, p_mode TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_parts TEXT[];
  v_first TEXT;
  v_last_init TEXT := '';
BEGIN
  IF p_mode = 'student_code' THEN
    RETURN p_code;
  END IF;

  v_parts := regexp_split_to_array(TRIM(COALESCE(p_full_name, p_code)), '\s+');
  v_first := v_parts[1];
  IF array_length(v_parts, 1) >= 2 THEN
    v_last_init := ' ' || UPPER(LEFT(v_parts[array_length(v_parts, 1)], 1)) || '.';
  END IF;
  RETURN v_first || v_last_init;
END;
$$;

-- 5. RPC: leaderboard(p_board, p_period, p_level, p_limit)
CREATE OR REPLACE FUNCTION public.leaderboard(
  p_board TEXT DEFAULT 'points',
  p_period TEXT DEFAULT 'week',
  p_level TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  rank INTEGER,
  student_id UUID,
  display_name TEXT,
  value NUMERIC,
  is_me BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_is_admin BOOLEAN := public.is_admin();
  v_caller_id UUID := auth.uid();
  v_caller_level TEXT;
  v_effective_level TEXT;
  v_effective_limit INTEGER;
  v_today DATE := public.today_ist();
  v_start_date DATE;
  v_prev_start DATE;
  v_prev_end DATE;
  v_test_mult INTEGER;
  v_att_pts INTEGER;
  v_min_entries INTEGER;
  v_name_mode TEXT;
BEGIN
  SELECT weekly_test_multiplier, attendance_present_points, improved_min_entries, leaderboard_names
  INTO v_test_mult, v_att_pts, v_min_entries, v_name_mode
  FROM public.competition_rules();

  IF v_is_admin THEN
    v_effective_level := CASE WHEN p_level IS NULL OR LOWER(TRIM(p_level)) IN ('', 'all') THEN NULL ELSE TRIM(p_level) END;
    v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 200);
  ELSE
    SELECT level INTO v_caller_level FROM public.profiles WHERE id = v_caller_id;
    v_effective_level := v_caller_level;
    v_effective_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  END IF;

  IF p_period = 'week' THEN
    v_start_date := date_trunc('week', v_today::timestamp)::date;
  ELSIF p_period = 'month' THEN
    v_start_date := date_trunc('month', v_today::timestamp)::date;
  ELSE
    v_start_date := DATE '2020-01-01';
  END IF;

  v_prev_start := (date_trunc('week', v_today::timestamp)::date - 7);
  v_prev_end := (date_trunc('week', v_today::timestamp)::date - 1);

  RETURN QUERY
  WITH eligible_students AS (
    SELECT p.id, p.student_code, p.full_name, p.level
    FROM public.profiles p
    WHERE p.role = 'student'
      AND p.active = true
      AND p.leaderboard_visible = true
      AND (v_effective_level IS NULL OR LOWER(TRIM(COALESCE(p.level, ''))) = LOWER(TRIM(v_effective_level)))
  ),
  scored AS (
    SELECT
      es.id AS s_id,
      public.format_leaderboard_name(es.full_name, es.student_code, v_name_mode) AS d_name,
      CASE
        WHEN p_board = 'streak' THEN (
          SELECT st.current_streak::numeric FROM public.streak_for(es.id) st
        )
        WHEN p_board = 'practice_days' THEN (
          SELECT COUNT(DISTINCT r.entry_date)::numeric
          FROM public.results r
          WHERE r.student_id = es.id AND r.entry_date BETWEEN v_start_date AND v_today
        )
        WHEN p_board = 'improved' THEN (
          SELECT
            CASE
              WHEN cur_w.cnt >= v_min_entries AND prev_w.cnt >= v_min_entries AND (cur_w.acc - prev_w.acc) > 0
              THEN ROUND(cur_w.acc - prev_w.acc, 1)
              ELSE 0
            END
          FROM (
            SELECT COUNT(*) AS cnt, COALESCE((SUM(correct)::numeric / NULLIF(SUM(total), 0)::numeric) * 100.0, 0) AS acc
            FROM public.results
            WHERE student_id = es.id AND entry_date BETWEEN date_trunc('week', v_today::timestamp)::date AND v_today AND total > 0
          ) cur_w,
          (
            SELECT COUNT(*) AS cnt, COALESCE((SUM(correct)::numeric / NULLIF(SUM(total), 0)::numeric) * 100.0, 0) AS acc
            FROM public.results
            WHERE student_id = es.id AND entry_date BETWEEN v_prev_start AND v_prev_end AND total > 0
          ) prev_w
        )
        ELSE (
          -- 'points' board: practice net points + weekly test net points * multiplier + attendance present * points
          COALESCE((
            SELECT SUM(GREATEST(COALESCE(r.correct, 0) - GREATEST(COALESCE(r.total, 0) - COALESCE(r.correct, 0), 0), 0))
            FROM public.results r
            WHERE r.student_id = es.id AND r.entry_date BETWEEN v_start_date AND v_today
          ), 0)
          + COALESCE((
            SELECT SUM(GREATEST(wts.correct - (wts.total - wts.correct), 0)) * v_test_mult
            FROM public.weekly_test_scores wts
            JOIN public.weekly_tests wt ON wt.id = wts.test_id
            WHERE wts.student_id = es.id AND wt.test_date BETWEEN v_start_date AND v_today
          ), 0)
          + COALESCE((
            SELECT COUNT(*) * v_att_pts
            FROM public.attendance a
            JOIN public.attendance_sessions s ON s.id = a.session_id
            WHERE a.student_id = es.id AND a.status = 'present' AND s.session_date BETWEEN v_start_date AND v_today
          ), 0)
        )::numeric
      END AS metric_val
    FROM eligible_students es
  ),
  ranked AS (
    SELECT
      RANK() OVER (ORDER BY metric_val DESC, d_name ASC)::INTEGER AS rnk,
      s_id,
      d_name,
      metric_val,
      (s_id = v_caller_id) AS me_flag
    FROM scored
    WHERE metric_val > 0
  )
  SELECT
    rk.rnk AS rank,
    CASE WHEN v_is_admin THEN rk.s_id ELSE NULL END AS student_id,
    rk.d_name AS display_name,
    rk.metric_val AS value,
    CASE WHEN v_is_admin THEN false ELSE rk.me_flag END AS is_me
  FROM ranked rk
  WHERE rk.rnk <= v_effective_limit OR (NOT v_is_admin AND rk.me_flag = true)
  ORDER BY rk.rnk ASC, rk.d_name ASC;
END;
$$;
