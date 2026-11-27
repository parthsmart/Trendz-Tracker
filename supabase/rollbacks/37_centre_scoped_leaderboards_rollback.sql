-- Rollback for 37_centre_scoped_leaderboards.sql.
--
-- Puts back the six functions exactly as they were before migration 37, without
-- the centre filter, so every leaderboard covers the whole network again.
-- No data changes. Safe to run at any time.

CREATE OR REPLACE FUNCTION public.leaderboard(p_board text, p_period text DEFAULT 'week'::text, p_level text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_scope text DEFAULT 'level'::text)
 RETURNS TABLE(rank integer, student_id uuid, display_name text, value numeric, is_me boolean, level text, avatar_path text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_admin BOOLEAN := public.is_admin();
  v_me UUID := auth.uid();
  v_all BOOLEAN;
  v_level TEXT;
  v_from DATE;
  v_to DATE;
  v_wt_mult NUMERIC;
  v_att_pts NUMERIC;
  v_min_entries INTEGER;
  v_limit INTEGER;
  v_today DATE := public.today_ist();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_board NOT IN ('points', 'streak', 'practice_days', 'improved', 'todo', 'xp') THEN
    RAISE EXCEPTION 'Unknown board';
  END IF;
  IF COALESCE(p_scope, 'level') NOT IN ('level', 'global') THEN
    RAISE EXCEPTION 'Unknown scope';
  END IF;

  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds(COALESCE(p_period, 'week')) b;
  SELECT r.weekly_test_multiplier, r.attendance_present_points, r.improved_min_entries
    INTO v_wt_mult, v_att_pts, v_min_entries
    FROM public.competition_rules() r;

  IF v_admin THEN
    v_all := (p_level IS NULL OR lower(p_level) = 'all' OR COALESCE(p_scope, 'level') = 'global');
    v_level := CASE WHEN v_all THEN NULL ELSE p_level END;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  ELSE
    IF COALESCE(p_scope, 'level') = 'global' THEN
      IF NOT public.global_leaderboard_enabled() THEN
        RAISE EXCEPTION 'The global leaderboard is switched off.';
      END IF;
      v_all := true;
      v_level := NULL;
    ELSE
      v_all := false;
      SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
    END IF;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  END IF;

  RETURN QUERY
  WITH elig AS (
    SELECT p.id, p.level AS lvl, public.display_name_for(p.full_name, p.student_code) AS dn,
           public.avatar_visible(p.id, p.avatar_path) AS av
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND (v_all OR p.level IS NOT DISTINCT FROM v_level)
  ),
  vals AS (
    SELECT e.id, e.dn, e.lvl, e.av,
      (CASE p_board
        WHEN 'points' THEN
          COALESCE((SELECT sum(GREATEST(0, 2 * s.correct - s.total))
                      FROM public.weekly_test_scores s
                      JOIN public.weekly_tests t ON t.id = s.test_id
                     WHERE s.student_id = e.id AND t.test_date BETWEEN v_from AND v_to), 0) * v_wt_mult
          + COALESCE((SELECT count(*)
                        FROM public.attendance a
                        JOIN public.attendance_sessions x ON x.id = a.session_id
                       WHERE a.student_id = e.id AND a.status = 'present'
                         AND x.session_date BETWEEN v_from AND v_to), 0) * v_att_pts
        WHEN 'streak' THEN
          (SELECT sc.current_streak FROM public.streak_calc(e.id) sc)
        WHEN 'practice_days' THEN
          public.practice_days_for(e.id, v_from, v_to)
        WHEN 'improved' THEN
          (SELECT CASE WHEN w.n1 >= v_min_entries AND w.n0 >= v_min_entries AND w.t1 > 0 AND w.t0 > 0
                       THEN round(100.0 * w.c1 / w.t1 - 100.0 * w.c0 / w.t0, 1) END
             FROM (
               SELECT
                 count(*) FILTER (WHERE r.entry_date > v_today - 7) AS n1,
                 sum(r.correct) FILTER (WHERE r.entry_date > v_today - 7) AS c1,
                 sum(r.total) FILTER (WHERE r.entry_date > v_today - 7) AS t1,
                 count(*) FILTER (WHERE r.entry_date <= v_today - 7) AS n0,
                 sum(r.correct) FILTER (WHERE r.entry_date <= v_today - 7) AS c0,
                 sum(r.total) FILTER (WHERE r.entry_date <= v_today - 7) AS t0
               FROM public.results r
              WHERE r.student_id = e.id AND r.total > 0 AND r.correct IS NOT NULL
                AND r.entry_date > v_today - 14 AND r.entry_date <= v_today
             ) w)
        WHEN 'todo' THEN
          COALESCE((SELECT count(*) FROM public.daily_todo_log l
                     WHERE l.student_id = e.id AND l.day BETWEEN v_from AND v_to
                       AND l.tasks_total > 0 AND l.all_done), 0)
          + CASE WHEN v_today BETWEEN v_from AND v_to
                      AND public.todo_all_done_on(e.id, v_today) THEN 1 ELSE 0 END
        WHEN 'xp' THEN
          COALESCE((SELECT sum(x.xp) FROM public.student_xp_events x
                     WHERE x.student_id = e.id AND x.day BETWEEN v_from AND v_to), 0)
      END)::numeric AS v
    FROM elig e
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY vv.v DESC))::integer AS rk, vv.id, vv.dn, vv.lvl, vv.v, vv.av
      FROM vals vv
     WHERE vv.v IS NOT NULL AND vv.v > 0
  )
  SELECT r.rk, CASE WHEN v_admin THEN r.id END, r.dn, r.v, (r.id = v_me), r.lvl, r.av
    FROM ranked r
   WHERE r.rk <= v_limit OR r.id = v_me
   ORDER BY r.rk, r.dn;
END;
$function$;

CREATE OR REPLACE FUNCTION public.todo_task_leaderboard(p_task uuid, p_period text DEFAULT 'week'::text, p_level text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_scope text DEFAULT 'level'::text)
 RETURNS TABLE(rank integer, student_id uuid, display_name text, level text, best_per_minute numeric, correct integer, attempted integer, seconds integer, attempts integer, is_me boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_admin boolean := public.is_admin();
  v_me uuid := auth.uid();
  v_all boolean;
  v_level text;
  v_from date;
  v_to date;
  v_limit integer;
  t public.daily_tasks;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF COALESCE(p_scope, 'level') NOT IN ('level', 'global') THEN
    RAISE EXCEPTION 'Unknown scope';
  END IF;

  SELECT * INTO t FROM public.daily_tasks WHERE id = p_task AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'This task was not found.'; END IF;
  IF t.section <> 'basics' OR t.category_id IS NULL THEN
    RAISE EXCEPTION 'Speed ranking is available for basics tasks with a category only.';
  END IF;

  SELECT b.d_from, b.d_to INTO v_from, v_to
    FROM public.period_bounds(COALESCE(p_period, 'week')) b;

  IF v_admin THEN
    v_all := (p_level IS NULL OR lower(p_level) = 'all' OR COALESCE(p_scope, 'level') = 'global');
    v_level := CASE WHEN v_all THEN NULL ELSE p_level END;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  ELSE
    IF COALESCE(p_scope, 'level') = 'global' THEN
      IF NOT public.global_leaderboard_enabled() THEN
        RAISE EXCEPTION 'The global leaderboard is switched off.';
      END IF;
      v_all := true;
      v_level := NULL;
    ELSE
      v_all := false;
      SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
    END IF;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  END IF;

  RETURN QUERY
  WITH elig AS (
    SELECT p.id, p.level AS lvl, public.display_name_for(p.full_name, p.student_code) AS dn
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND (v_all OR p.level IS NOT DISTINCT FROM v_level)
  ),
  best AS (
    SELECT e.id, e.dn, e.lvl, b.correct, b.total, b.time_seconds, b.cpm, b.n
      FROM elig e
      JOIN LATERAL (
        SELECT r.correct, r.total, r.time_seconds,
               round(r.correct / (r.time_seconds / 60.0), 1) AS cpm,
               count(*) OVER () AS n
          FROM public.results r
         WHERE r.student_id = e.id AND r.category_id = t.category_id
           AND r.source = 'site'
           AND r.entry_date BETWEEN v_from AND v_to
           AND r.correct IS NOT NULL AND r.total >= 10 AND r.time_seconds >= 20
         ORDER BY r.correct / (r.time_seconds / 60.0) DESC,
                  r.correct::numeric / r.total DESC, r.total DESC
         LIMIT 1
      ) b ON true
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY bb.cpm DESC, bb.correct DESC))::integer AS rk, bb.*
      FROM best bb
     WHERE bb.cpm > 0
  )
  SELECT r.rk, CASE WHEN v_admin THEN r.id END, r.dn, r.lvl, r.cpm,
         r.correct::integer, r.total::integer, r.time_seconds::integer, r.n::integer,
         (r.id = v_me)
    FROM ranked r
   WHERE r.rk <= v_limit OR r.id = v_me
   ORDER BY r.rk, r.dn;
END;
$function$;

CREATE OR REPLACE FUNCTION public.weekly_test_leaderboard(p_test uuid DEFAULT NULL::uuid, p_period text DEFAULT 'month'::text, p_level text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_scope text DEFAULT 'level'::text)
 RETURNS TABLE(rank integer, student_id uuid, display_name text, level text, points numeric, correct integer, attempted integer, seconds integer, tests integer, is_me boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_admin boolean := public.is_admin();
  v_me uuid := auth.uid();
  v_my_level text;
  v_all boolean;
  v_level text;
  v_from date;
  v_to date;
  v_limit integer;
  v_mult numeric;
  tt public.weekly_tests;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF COALESCE(p_scope, 'level') NOT IN ('level', 'global') THEN
    RAISE EXCEPTION 'Unknown scope';
  END IF;

  SELECT p.level INTO v_my_level FROM public.profiles p WHERE p.id = v_me;
  SELECT r.weekly_test_multiplier INTO v_mult FROM public.competition_rules() r;

  IF p_test IS NOT NULL THEN
    SELECT * INTO tt FROM public.weekly_tests WHERE id = p_test;
    IF NOT FOUND THEN RAISE EXCEPTION 'This test was not found.'; END IF;
    IF NOT v_admin THEN
      IF tt.audience_level IS NOT NULL AND tt.audience_level IS DISTINCT FROM v_my_level THEN
        RAISE EXCEPTION 'This test is not for your level.';
      END IF;
      IF tt.test_type = 'online'
         AND now() < COALESCE(tt.closes_at, ((tt.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) THEN
        RAISE EXCEPTION 'The leaderboard of an online test appears after the test closes.';
      END IF;
    END IF;
  ELSE
    SELECT b.d_from, b.d_to INTO v_from, v_to
      FROM public.period_bounds(COALESCE(p_period, 'month')) b;
  END IF;

  IF v_admin THEN
    v_all := (p_level IS NULL OR lower(p_level) = 'all' OR COALESCE(p_scope, 'level') = 'global');
    v_level := CASE WHEN v_all THEN NULL ELSE p_level END;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  ELSE
    IF COALESCE(p_scope, 'level') = 'global' THEN
      IF NOT public.global_leaderboard_enabled() THEN
        RAISE EXCEPTION 'The global leaderboard is switched off.';
      END IF;
      v_all := true;
      v_level := NULL;
    ELSE
      v_all := false;
      v_level := v_my_level;
    END IF;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  END IF;

  RETURN QUERY
  WITH elig AS (
    SELECT p.id, p.level AS lvl, public.display_name_for(p.full_name, p.student_code) AS dn
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND (v_all OR p.level IS NOT DISTINCT FROM v_level)
  ),
  agg AS (
    SELECT e.id, e.dn, e.lvl,
           sum(GREATEST(0, 2 * s.correct - s.total)) AS pts,
           sum(s.correct) AS c,
           sum(s.total) AS t,
           COALESCE(sum(s.time_seconds), 0) AS secs,
           count(DISTINCT s.test_id) AS n
      FROM elig e
      JOIN public.weekly_test_scores s ON s.student_id = e.id
      JOIN public.weekly_tests w ON w.id = s.test_id
     WHERE (p_test IS NOT NULL AND w.id = p_test)
        OR (p_test IS NULL
            AND w.test_date BETWEEN v_from AND v_to
            AND (v_admin OR w.audience_level IS NULL OR w.audience_level IS NOT DISTINCT FROM v_my_level)
            AND (v_admin OR w.test_type = 'offline'
                 OR now() >= COALESCE(w.closes_at, ((w.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))))
     GROUP BY e.id, e.dn, e.lvl
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY a.pts DESC, a.c DESC, a.secs ASC))::integer AS rk, a.*
      FROM agg a
     WHERE a.pts > 0
  )
  SELECT r.rk, CASE WHEN v_admin THEN r.id END, r.dn, r.lvl, round(r.pts * v_mult, 1),
         r.c::integer, r.t::integer, r.secs::integer, r.n::integer, (r.id = v_me)
    FROM ranked r
   WHERE r.rk <= v_limit OR r.id = v_me
   ORDER BY r.rk, r.dn;
END;
$function$;

CREATE OR REPLACE FUNCTION public.class_vs_class(p_period text DEFAULT 'week'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_from date;
  v_to date;
  v_my_level text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF COALESCE(p_period, 'week') NOT IN ('week', 'month') THEN RAISE EXCEPTION 'Unknown period'; END IF;
  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds(COALESCE(p_period, 'week')) b;
  SELECT p.level INTO v_my_level FROM public.profiles p WHERE p.id = v_me AND p.role = 'student';

  RETURN jsonb_build_object(
    'period', COALESCE(p_period, 'week'),
    'from', v_from,
    'to', v_to,
    'my_level', v_my_level,
    'classes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'rank', c.rk, 'level', c.level, 'students', c.students, 'active', c.active,
               'xp', c.xp, 'avg_xp', c.avg_xp, 'is_mine', c.level IS NOT DISTINCT FROM v_my_level)
             ORDER BY c.rk, c.level)
        FROM (
          SELECT s.*, (rank() OVER (ORDER BY s.avg_xp DESC))::integer AS rk
            FROM (
              SELECT p.level, count(*)::integer AS students,
                     count(*) FILTER (WHERE COALESCE(x.xp, 0) > 0)::integer AS active,
                     COALESCE(sum(x.xp), 0)::bigint AS xp,
                     round(COALESCE(sum(x.xp), 0)::numeric / count(*), 1) AS avg_xp
                FROM public.profiles p
                LEFT JOIN (SELECT e.student_id, sum(e.xp) AS xp FROM public.student_xp_events e
                            WHERE e.day BETWEEN v_from AND v_to GROUP BY e.student_id) x ON x.student_id = p.id
               WHERE p.role = 'student' AND p.active AND p.level IS NOT NULL AND btrim(p.level) <> ''
               GROUP BY p.level
            ) s
        ) c
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.daily_challenge_board(p_day date DEFAULT NULL::date, p_level text DEFAULT NULL::text)
 RETURNS TABLE(rank integer, display_name text, correct integer, total integer, time_seconds numeric, is_me boolean, avatar_path text, players integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_me uuid := auth.uid();
  v_day date := COALESCE(p_day, public.today_ist());
  v_level text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF public.is_admin() OR public.is_teacher(v_me) THEN
    v_level := p_level;
  ELSE
    SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
  END IF;

  RETURN QUERY
  WITH att AS (
    SELECT a.student_id, a.correct, a.total, a.time_seconds,
           public.display_name_for(p.full_name, p.student_code) AS dn,
           public.avatar_visible(p.id, p.avatar_path) AS av
      FROM public.daily_challenge_attempts a
      JOIN public.profiles p ON p.id = a.student_id
     WHERE a.day = v_day
       AND a.level IS NOT DISTINCT FROM v_level
       AND a.submitted_at IS NOT NULL
       AND p.role = 'student' AND p.active
       AND (p.leaderboard_visible OR p.id = v_me)
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY r.correct DESC NULLS LAST,
                                  (r.correct::numeric / NULLIF(r.total, 0)) DESC NULLS LAST,
                                  r.time_seconds ASC NULLS LAST))::integer AS rk,
           r.*, (count(*) OVER ())::integer AS n
      FROM att r
  )
  SELECT k.rk, k.dn, k.correct, k.total, k.time_seconds, (k.student_id = v_me), k.av, k.n
    FROM ranked k
   WHERE k.rk <= 10 OR k.student_id = v_me
   ORDER BY k.rk, k.dn;
END;
$function$;

CREATE OR REPLACE FUNCTION public.duel_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_cats jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me AND p.role = 'student';
  IF NOT FOUND THEN RETURN jsonb_build_object('opponents', '[]'::jsonb, 'categories', '[]'::jsonb); END IF;

  SELECT jsonb_agg(jsonb_build_object('id', c.category_id, 'name', c.name) ORDER BY c.students DESC, c.name)
    INTO v_cats FROM public.daily_challenge_candidates(v_level) c;
  IF v_cats IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
      INTO v_cats FROM public.categories c WHERE c.section = 'basics' AND c.active;
  END IF;

  RETURN jsonb_build_object(
    'level', v_level,
    'opponents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id,
               'display_name', public.display_name_for(p.full_name, p.student_code),
               'avatar_path', public.avatar_visible(p.id, p.avatar_path),
               'busy', EXISTS (SELECT 1 FROM public.duels d WHERE d.status = 'open'
                                AND ((d.challenger_id = v_me AND d.opponent_id = p.id)
                                  OR (d.opponent_id = v_me AND d.challenger_id = p.id))))
             ORDER BY public.display_name_for(p.full_name, p.student_code))
        FROM public.profiles p
       WHERE p.role = 'student' AND p.active AND p.leaderboard_visible AND p.id <> v_me
         AND p.level IS NOT DISTINCT FROM v_level
    ), '[]'::jsonb),
    'categories', COALESCE(v_cats, '[]'::jsonb),
    'created_today', (SELECT count(*) FROM public.duels d WHERE d.challenger_id = v_me AND d.created_day = public.today_ist()),
    'daily_limit', 3
  );
END;
$function$;
