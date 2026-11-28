-- Rollback of migration 40 (step 5b): leagues and awards network-wide again.
--
-- Restores the production definitions from before migration 40 (2026-11-28).
-- xp_awards.centre_id and its index are kept so no data is lost; the old
-- functions simply ignore the column.

DROP FUNCTION IF EXISTS public.league_members(date);
CREATE FUNCTION public.league_members(p_week date)
 RETURNS TABLE(student_id uuid, tier smallint, lvl text, group_no integer, xp bigint, dn text, av text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH base AS (
    SELECT p.id, COALESCE(sl.tier, 1)::smallint AS tier,
           CASE WHEN public.global_leaderboard_enabled() THEN '' ELSE COALESCE(p.level, '') END AS lvl,
           public.display_name_for(p.full_name, p.student_code) AS dn,
           public.avatar_visible(p.id, p.avatar_path) AS av,
           COALESCE((SELECT sum(x.xp) FROM public.student_xp_events x
                      WHERE x.student_id = p.id AND x.day BETWEEN p_week AND p_week + 6), 0)::bigint AS xp
      FROM public.profiles p
      LEFT JOIN public.student_leagues sl ON sl.student_id = p.id
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
  )
  SELECT b.id, b.tier, b.lvl,
         ((row_number() OVER (PARTITION BY b.tier, b.lvl ORDER BY md5(b.id::text || p_week::text)) - 1) / 20)::integer,
         b.xp, b.dn, b.av
    FROM base b;
$function$;
REVOKE ALL ON FUNCTION public.league_members(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.league_members(date) TO service_role;

CREATE OR REPLACE FUNCTION public.league_settle_week(p_week date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_week + 6 >= public.today_ist() THEN
    RETURN;
  END IF;
  INSERT INTO public.league_weeks (week_start) VALUES (p_week) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  WITH m AS (
    SELECT lm.*,
           (rank() OVER (PARTITION BY lm.tier, lm.lvl, lm.group_no ORDER BY lm.xp DESC))::integer AS rk,
           (count(*) OVER (PARTITION BY lm.tier, lm.lvl, lm.group_no))::integer AS sz
      FROM public.league_members(p_week) lm
  )
  INSERT INTO public.league_results (week_start, student_id, tier_before, tier_after, group_no, rank, group_size, xp)
  SELECT p_week, m.student_id, m.tier,
         (m.tier + CASE public.league_zone(m.tier, m.rk, m.sz, m.xp) WHEN 'up' THEN 1 WHEN 'down' THEN -1 ELSE 0 END)::smallint,
         m.group_no, m.rk, m.sz, m.xp
    FROM m
  ON CONFLICT DO NOTHING;

  INSERT INTO public.student_leagues (student_id, tier, updated_at)
  SELECT r.student_id, r.tier_after, now()
    FROM public.league_results r
   WHERE r.week_start = p_week
  ON CONFLICT (student_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = now();

  INSERT INTO public.student_badges (student_id, badge_key)
  SELECT r.student_id, 'league_up' FROM public.league_results r
   WHERE r.week_start = p_week AND r.tier_after > r.tier_before
  UNION
  SELECT r.student_id, 'league_top' FROM public.league_results r
   WHERE r.week_start = p_week AND r.tier_after = 5
  UNION
  SELECT r.student_id, 'league_win' FROM public.league_results r
   WHERE r.week_start = p_week AND r.rank = 1 AND r.xp > 0 AND r.group_size >= 3
  ON CONFLICT DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.league_board(p_tier smallint DEFAULT NULL::smallint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_staff boolean;
  v_week date := date_trunc('week', public.today_ist())::date;
  v_mine record;
  v_tier smallint;
  v_rows jsonb;
  v_last jsonb;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  v_staff := public.is_admin() OR public.is_teacher(v_me);

  BEGIN
    PERFORM public.league_settle();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'league settle failed: %', SQLERRM;
  END;

  CREATE TEMP TABLE IF NOT EXISTS _league_m ON COMMIT DROP AS
    SELECT * FROM public.league_members(v_week) WITH NO DATA;
  TRUNCATE _league_m;
  INSERT INTO _league_m SELECT * FROM public.league_members(v_week);

  SELECT * INTO v_mine FROM _league_m WHERE student_id = v_me;

  IF v_staff THEN
    v_tier := COALESCE(p_tier, 1);
  ELSIF v_mine.student_id IS NULL THEN
    RETURN jsonb_build_object('member', false);
  ELSE
    v_tier := v_mine.tier;
  END IF;

  WITH g AS (
    SELECT m.*,
           (rank() OVER (PARTITION BY m.lvl, m.group_no ORDER BY m.xp DESC))::integer AS rk,
           (count(*) OVER (PARTITION BY m.lvl, m.group_no))::integer AS sz
      FROM _league_m m
     WHERE m.tier = v_tier
       AND (v_staff OR (m.lvl = v_mine.lvl AND m.group_no = v_mine.group_no))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rank', g.rk, 'display_name', g.dn, 'xp', g.xp, 'is_me', g.student_id = v_me,
           'avatar_path', g.av,
           'zone', CASE WHEN public.league_zone(v_tier, g.rk, g.sz, g.xp) = 'down' AND NOT v_staff AND g.student_id <> v_me
                        THEN '' ELSE public.league_zone(v_tier, g.rk, g.sz, g.xp) END,
           'group', CASE WHEN v_staff THEN NULLIF(g.lvl, '') || ' ' ELSE '' END || 'Group ' || (g.group_no + 1)
         ) ORDER BY g.lvl, g.group_no, g.rk, g.dn), '[]'::jsonb)
    INTO v_rows FROM g;

  SELECT jsonb_build_object('week_start', r.week_start, 'tier_before', r.tier_before, 'tier_after', r.tier_after,
                            'rank', r.rank, 'group_size', r.group_size, 'xp', r.xp)
    INTO v_last
    FROM public.league_results r
   WHERE r.student_id = v_me
   ORDER BY r.week_start DESC LIMIT 1;

  RETURN jsonb_build_object(
    'member', true,
    'staff', v_staff,
    'tier', v_tier,
    'week', jsonb_build_object('from', v_week, 'to', v_week + 6),
    'tiers', (SELECT jsonb_agg(jsonb_build_object('tier', t.tier, 'name', t.name, 'icon', t.icon,
                     'students', (SELECT count(*) FROM _league_m m WHERE m.tier = t.tier)) ORDER BY t.tier)
                FROM public.league_tiers t),
    'rows', v_rows,
    'last', v_last
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.xp_settle_period(p_kind text, p_from date, p_to date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_to >= public.today_ist() THEN
    RETURN;
  END IF;
  INSERT INTO public.xp_award_periods (kind, period_start, period_end)
  VALUES (p_kind, p_from, p_to)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.xp_awards (kind, period_start, period_end, level, student_id, xp)
  SELECT p_kind, p_from, p_to, r.level, r.student_id, r.xp
    FROM (
      SELECT v.*, rank() OVER (PARTITION BY v.level ORDER BY v.xp DESC) AS rk
        FROM (
          SELECT p.level, x.student_id, sum(x.xp) AS xp
            FROM public.student_xp_events x
            JOIN public.profiles p ON p.id = x.student_id
           WHERE x.day BETWEEN p_from AND p_to
             AND p.role = 'student' AND p.active AND p.leaderboard_visible
           GROUP BY p.level, x.student_id
        ) v
       WHERE v.xp > 0
    ) r
   WHERE r.rk = 1
  ON CONFLICT DO NOTHING;

  INSERT INTO public.student_badges (student_id, badge_key)
  SELECT DISTINCT a.student_id, CASE p_kind WHEN 'week' THEN 'week_champion' ELSE 'star_month' END
    FROM public.xp_awards a
   WHERE a.kind = p_kind AND a.period_start = p_from
  ON CONFLICT DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.star_of_month(p_level text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_today date := public.today_ist();
  v_month date := (date_trunc('month', v_today) - interval '1 month')::date;
  v_week date := date_trunc('week', v_today)::date - 7;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  BEGIN
    PERFORM public.xp_settle_awards();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'xp_settle_awards failed: %', SQLERRM;
  END;

  IF public.is_admin() OR public.is_teacher(v_me) THEN
    v_level := p_level;
  ELSE
    SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
  END IF;

  RETURN jsonb_build_object(
    'level', v_level,
    'month', jsonb_build_object(
      'from', v_month,
      'to', (v_month + interval '1 month')::date - 1,
      'label', to_char(v_month, 'FMMonth YYYY'),
      'winners', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'display_name', public.display_name_for(p.full_name, p.student_code),
                 'xp', a.xp, 'is_me', a.student_id = v_me,
                 'avatar_path', public.avatar_visible(p.id, p.avatar_path)) ORDER BY p.full_name)
          FROM public.xp_awards a JOIN public.profiles p ON p.id = a.student_id
         WHERE a.kind = 'month' AND a.period_start = v_month
           AND a.level IS NOT DISTINCT FROM v_level AND p.active), '[]'::jsonb)
    ),
    'week', jsonb_build_object(
      'from', v_week,
      'to', v_week + 6,
      'winners', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'display_name', public.display_name_for(p.full_name, p.student_code),
                 'xp', a.xp, 'is_me', a.student_id = v_me,
                 'avatar_path', public.avatar_visible(p.id, p.avatar_path)) ORDER BY p.full_name)
          FROM public.xp_awards a JOIN public.profiles p ON p.id = a.student_id
         WHERE a.kind = 'week' AND a.period_start = v_week
           AND a.level IS NOT DISTINCT FROM v_level AND p.active), '[]'::jsonb)
    )
  );
END;
$function$;
