-- Phase 25b: league tuning
--   * Leagues start this week: earlier weeks are marked settled without results.
--   * Promotion/demotion counts scale with group size (a quarter of the group, 1..5),
--     so tiny groups do not move almost everyone.
--   * The "down" marker is shown only to the student themselves and to staff.

INSERT INTO public.league_weeks (week_start)
SELECT d::date FROM generate_series(date '2026-10-26', date '2026-11-16', interval '7 days') d
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.league_zone(p_tier smallint, p_rank integer, p_size integer, p_xp bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_tier < 5 AND p_xp > 0 AND p_rank <= LEAST(5, GREATEST(1, ceil(p_size / 4.0)::integer)) THEN 'up'
    WHEN p_tier > 1 AND (p_xp = 0 OR (p_size >= 8 AND p_rank > p_size - LEAST(5, p_size / 4))) THEN 'down'
    ELSE ''
  END;
$function$;

CREATE OR REPLACE FUNCTION public.league_board(p_tier smallint DEFAULT NULL)
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
