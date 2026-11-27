-- Copy of the production definition of public.weekly_test_leaderboard
-- (read from kgzivhavpsvitwrscrrj on 2026-11-28). Used by
-- tests/weeklyTestPractice.test.js to prove practice never changes the
-- official board. Keep in sync if the official board changes.
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
