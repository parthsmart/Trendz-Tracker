-- ==============================================================================
-- TRENDZ TRACKER - STANDALONE HOTFIX: student_month_report Weekly Test Preserves
-- Scope: Retain valid Elements, Flash, and Memoriad weekly test scores (category_id IS NULL)
-- Pre-Phase-18 Compatible: Uses exact deployed report implementation and helpers.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.student_month_report(
  p_student UUID,
  p_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from date := date_trunc('month', COALESCE(p_month, public.today_ist()))::date;
  v_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) + interval '1 month' - interval '1 day')::date;
  v_prev_from date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 month')::date;
  v_prev_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 day')::date;
  v_name text;
  v_code text;
  v_level text;
  v_att record;
  v_streak record;
  v_ps record;
  v_pp record;
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT p.full_name, p.student_code, p.level INTO v_name, v_code, v_level
    FROM public.profiles p WHERE p.id = p_student AND p.role = 'student';
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found'; END IF;

  SELECT * INTO v_att FROM public.attendance_summary(p_student, v_from, v_to);
  SELECT * INTO v_streak FROM public.streak_calc(p_student);
  SELECT * INTO v_ps FROM public.practice_stats_for(p_student, v_from, v_to);
  SELECT * INTO v_pp FROM public.practice_stats_for(p_student, v_prev_from, v_prev_to);

  RETURN jsonb_build_object(
    'student', jsonb_build_object('name', v_name, 'code', v_code, 'level', v_level),
    'month_start', v_from,
    'month_end', v_to,
    'days_elapsed', GREATEST(0, LEAST(v_to, public.today_ist()) - v_from + 1),
    'practice', jsonb_build_object(
      'entries', v_ps.n_entries, 'correct', v_ps.n_correct, 'total', v_ps.n_total,
      'accuracy', v_ps.accuracy_pct, 'qpm', v_ps.qpm, 'rounds', v_ps.n_rounds,
      'practice_days', public.practice_days_for(p_student, v_from, v_to)),
    'previous', jsonb_build_object(
      'entries', v_pp.n_entries, 'accuracy', v_pp.accuracy_pct, 'qpm', v_pp.qpm,
      'practice_days', public.practice_days_for(p_student, v_prev_from, v_prev_to)),
    'streak', jsonb_build_object('current', v_streak.current_streak, 'best', v_streak.best_streak),
    'attendance', jsonb_build_object(
      'present', v_att.present_count, 'absent', v_att.absent_count,
      'excused', v_att.excused_count, 'percent', v_att.attendance_pct),
    'points', public.points_for(p_student, v_from, v_to),
    'weeks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('week_start', w.ws, 'entries', w.n, 'accuracy', w.acc) ORDER BY w.ws)
        FROM (
          SELECT date_trunc('week', r.entry_date)::date AS ws,
                 count(*) AS n,
                 round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc
            FROM public.results r
           WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
             AND r.total > 0 AND r.correct IS NOT NULL
           GROUP BY 1
        ) w), '[]'::jsonb),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', c.name, 'section', c.section, 'entries', x.n,
                                          'accuracy', x.acc, 'wrong', x.wrong) ORDER BY x.acc, c.name)
        FROM (
          SELECT r.category_id,
                 count(*) AS n,
                 round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc,
                 sum(r.total - r.correct) AS wrong
            FROM public.results r
           WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
             AND r.total > 0 AND r.correct IS NOT NULL
           GROUP BY r.category_id
          HAVING count(*) >= 3
        ) x
        JOIN public.categories c ON c.id = x.category_id), '[]'::jsonb),
    'targets', (
      SELECT jsonb_build_object(
               'measured', count(*) FILTER (WHERE t.meets_target IS NOT NULL),
               'met', count(*) FILTER (WHERE t.meets_target IS TRUE))
        FROM public.results_with_target t
       WHERE t.student_id = p_student AND t.entry_date BETWEEN v_from AND v_to),
    'weekly_tests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'title', t.title,
        'date', t.test_date,
        'category', COALESCE(
          c.name,
          CASE sec.kind
            WHEN 'elements' THEN
              CASE sec.activity_key
                WHEN 'squares_stage_1' THEN 'Square - Stage 1 (1-25)'
                WHEN 'squares_stage_2' THEN 'Square - Stage 2 (26-50)'
                WHEN 'squares_stage_3' THEN 'Square - Stage 3 (51-75)'
                WHEN 'squares_stage_4' THEN 'Square - Stage 4 (76-100)'
                WHEN 'squares_combined' THEN 'Square - Combined (1-100)'
                WHEN 'cubes_stage_1' THEN 'Cube - Stage 1 (1-25)'
                WHEN 'cubes_stage_2' THEN 'Cube - Stage 2 (26-50)'
                WHEN 'cubes_stage_3' THEN 'Cube - Stage 3 (51-75)'
                WHEN 'cubes_stage_4' THEN 'Cube - Stage 4 (76-100)'
                WHEN 'cubes_combined' THEN 'Cube - Combined (1-100)'
                WHEN 'day_codes' THEN 'Day Codes'
                WHEN 'month_codes' THEN 'Month Codes'
                WHEN 'century_codes' THEN 'Century Codes'
                WHEN 'time_conversion' THEN 'Conversion in Seconds'
                WHEN 'divide_by_4' THEN 'Division by 4'
                WHEN 'divide_by_7' THEN 'Division by 7'
                WHEN 'prime_factors' THEN 'Prime Factor'
                WHEN 'modulo' THEN 'Modulo Calculation'
                WHEN 'ratio' THEN 'Ratio'
                WHEN 'days_to_seconds' THEN 'Days --> Seconds'
                WHEN 'hours_to_seconds' THEN 'Hours --> Seconds'
                WHEN 'minutes_to_seconds' THEN 'Minutes --> Seconds'
                WHEN 'number_to_be_squared' THEN 'Number To Be Squared'
                WHEN 'squares_3d_4d' THEN '3D - 4D Square'
                ELSE COALESCE(INITCAP(REPLACE(sec.activity_key, '_', ' ')), 'Elements')
              END
            WHEN 'memoriad' THEN
              CASE sec.activity_key
                WHEN 'calendar' THEN 'Mental Calendar Dates'
                WHEN 'additions' THEN 'Mental Additions'
                WHEN 'multiplications' THEN 'Mental Multiplications'
                WHEN 'square_roots' THEN 'Mental Square Roots'
                ELSE COALESCE(INITCAP(REPLACE(sec.activity_key, '_', ' ')), 'Memoriad')
              END
            WHEN 'flash' THEN
              CASE
                WHEN sec.flash_digits IS NOT NULL AND sec.flash_count IS NOT NULL
                  THEN 'Flash Anzan (' || sec.flash_digits || 'D ' || sec.flash_count || 'N)'
                ELSE 'Flash Anzan'
              END
            ELSE COALESCE(INITCAP(sec.kind), 'General')
          END
        ),
        'correct', s.correct,
        'total', s.total,
        'time_seconds', s.time_seconds
      ) ORDER BY t.test_date, COALESCE(c.sort_order, sec.position, 999), COALESCE(c.name, sec.activity_key, t.title))
        FROM public.weekly_test_scores s
        JOIN public.weekly_tests t ON t.id = s.test_id
        LEFT JOIN public.weekly_test_sections sec ON sec.id = s.section_id
        LEFT JOIN public.categories c ON c.id = COALESCE(s.category_id, sec.category_id)
       WHERE s.student_id = p_student AND t.test_date BETWEEN v_from AND v_to), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.student_month_report(UUID, DATE) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.student_month_report(UUID, DATE) TO authenticated;
GRANT ALL ON FUNCTION public.student_month_report(UUID, DATE) TO service_role;
