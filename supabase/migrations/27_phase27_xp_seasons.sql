-- Phase 27: monthly XP seasons
--   * A season is one calendar month (IST). Season XP resets on the 1st; it decides the tier
--     shown everywhere. Lifetime ("career") XP is kept and still shown, but no longer ranks anyone.
--   * Finished seasons are written once to xp_season_results (lazily, like week/month awards)
--     so every student keeps a season history forever.
--   * Rank badges (tier_*) are now earned by reaching that tier in any one season.
--     Badges already earned are never removed.
--   * The daily XP curve counts all practice in a day: full XP for the first 20 rounds,
--     half up to 40, then a quarter. Past rounds keep the XP they earned.
--   * The reward shop wallet counts XP earned from 1 Nov 2026 (when the shop opened),
--     not the history imported from before.

-- 1. Season tiers --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.xp_season_tier(p_xp bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH t(name, floor_xp, ord) AS (
    VALUES ('Bronze', 0, 1), ('Silver', 300, 2), ('Gold', 1000, 3),
           ('Platinum', 2500, 4), ('Diamond', 5000, 5), ('Master', 9000, 6), ('Legend', 15000, 7)
  ),
  cur AS (SELECT * FROM t WHERE floor_xp <= GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp DESC LIMIT 1),
  nxt AS (SELECT * FROM t WHERE floor_xp > GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp ASC LIMIT 1)
  SELECT jsonb_build_object(
    'name', cur.name, 'floor', cur.floor_xp, 'rank', cur.ord,
    'next_name', nxt.name, 'next_floor', nxt.floor_xp
  )
  FROM cur LEFT JOIN nxt ON true;
$function$;

-- 2. Daily curve across all practice --------------------------------------------------------

CREATE OR REPLACE FUNCTION public.xp_daily_factor(p_rounds_before integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_rounds_before < 20 THEN 1.0 WHEN p_rounds_before < 40 THEN 0.5 ELSE 0.25 END;
$function$;

CREATE OR REPLACE FUNCTION public.xp_award(p_student uuid, p_source text, p_source_id text, p_key text, p_label text, p_correct integer, p_total integer, p_time numeric, p_day date, p_long boolean, p_pb_score numeric, p_score_label text, p_at timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_base integer;
  v_before integer;
  v_factor numeric;
  v_prev_score numeric;
  v_prev_time numeric;
  v_prev_label text;
  v_last text;
  v_is_pb boolean := false;
  v_first boolean := false;
  v_bonus integer := 0;
  v_acc numeric;
BEGIN
  IF p_student IS NULL OR COALESCE(p_total, 0) <= 0 OR p_correct IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_student AND role = 'student') THEN
    RETURN;
  END IF;

  v_acc := GREATEST(0, p_correct)::numeric / p_total;
  v_base := public.xp_round_base(p_correct, p_total, p_long);

  -- Every round that day counts, whatever the practice (phase 27).
  SELECT count(*) INTO v_before
    FROM public.student_xp_events
   WHERE student_id = p_student AND day = p_day;
  v_factor := public.xp_daily_factor(v_before);

  SELECT e.score_label INTO v_last
    FROM public.student_xp_events e
   WHERE e.student_id = p_student AND e.activity_key = p_key
   ORDER BY e.day DESC, e.created_at DESC, e.id DESC
   LIMIT 1;

  IF p_pb_score IS NOT NULL AND v_acc >= 0.7 THEN
    SELECT e.pb_score, e.time_seconds, e.score_label INTO v_prev_score, v_prev_time, v_prev_label
      FROM public.student_xp_events e
     WHERE e.student_id = p_student AND e.activity_key = p_key AND e.pb_score IS NOT NULL
     ORDER BY e.pb_score DESC, e.time_seconds ASC NULLS LAST
     LIMIT 1;
    IF NOT FOUND THEN
      v_is_pb := true;
      v_first := true;
    ELSIF p_pb_score > v_prev_score
       OR (p_pb_score = v_prev_score AND p_time IS NOT NULL AND v_prev_time IS NOT NULL
           AND p_time < v_prev_time) THEN
      v_is_pb := true;
      v_bonus := 25;
    END IF;
  END IF;

  INSERT INTO public.student_xp_events (
    student_id, source, source_id, activity_key, label, correct, total, time_seconds, day,
    base_xp, daily_factor, bonus_xp, xp, pb_score, score_label, is_personal_best, first_best,
    prev_best_label, last_label, created_at
  ) VALUES (
    p_student, p_source, p_source_id, p_key, COALESCE(NULLIF(p_label, ''), 'Practice'),
    p_correct, p_total, p_time, p_day,
    v_base, v_factor, v_bonus, GREATEST(1, round(v_base * v_factor))::integer + v_bonus,
    CASE WHEN v_acc >= 0.7 THEN p_pb_score END, p_score_label, v_is_pb, v_first,
    CASE WHEN v_is_pb AND NOT v_first THEN v_prev_label END, v_last, COALESCE(p_at, now())
  )
  ON CONFLICT (source, source_id) DO NOTHING;
END;
$function$;

-- 3. Season records -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.xp_seasons (
  season date PRIMARY KEY,
  settled_at timestamptz NOT NULL DEFAULT now(),
  players integer NOT NULL DEFAULT 0,
  CONSTRAINT xp_seasons_first_day CHECK (extract(day FROM season) = 1)
);

CREATE TABLE IF NOT EXISTS public.xp_season_results (
  season date NOT NULL REFERENCES public.xp_seasons(season) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text,
  xp bigint NOT NULL,
  tier text NOT NULL,
  tier_rank smallint NOT NULL,
  level_rank integer,
  level_size integer,
  rounds integer NOT NULL DEFAULT 0,
  practice_days integer NOT NULL DEFAULT 0,
  new_bests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (season, student_id)
);
CREATE INDEX IF NOT EXISTS xp_season_results_student_idx ON public.xp_season_results (student_id, season DESC);

ALTER TABLE public.xp_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_season_results ENABLE ROW LEVEL SECURITY;
-- No policies: students and staff read these through SECURITY DEFINER RPCs only.

-- Writes every finished month that is not settled yet. Safe to call often and concurrently:
-- the xp_seasons row is the lock. Rank within level uses the student's current level.
CREATE OR REPLACE FUNCTION public.xp_settle_seasons()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cur date := date_trunc('month', public.today_ist())::date;
  v_first date;
  m date;
  v_n integer := 0;
  v_players integer;
BEGIN
  SELECT date_trunc('month', min(day))::date INTO v_first FROM public.student_xp_events;
  IF v_first IS NULL OR v_first >= v_cur THEN RETURN 0; END IF;

  FOR m IN
    SELECT g::date FROM generate_series(v_first, (v_cur - interval '1 month')::date, interval '1 month') g
     WHERE NOT EXISTS (SELECT 1 FROM public.xp_seasons s WHERE s.season = g::date)
     ORDER BY 1
  LOOP
    INSERT INTO public.xp_seasons (season) VALUES (m) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN CONTINUE; END IF;

    WITH agg AS (
      SELECT e.student_id,
             sum(e.xp)::bigint AS xp,
             count(*)::integer AS rounds,
             count(DISTINCT e.day)::integer AS days,
             count(*) FILTER (WHERE e.is_personal_best AND NOT e.first_best)::integer AS pbs
        FROM public.student_xp_events e
       WHERE e.day >= m AND e.day < (m + interval '1 month')::date
       GROUP BY e.student_id
      HAVING sum(e.xp) > 0
    ),
    ranked AS (
      SELECT a.*, p.level,
             rank() OVER (PARTITION BY p.level ORDER BY a.xp DESC)::integer AS lr,
             count(*) OVER (PARTITION BY p.level)::integer AS ls
        FROM agg a JOIN public.profiles p ON p.id = a.student_id AND p.role = 'student'
    )
    INSERT INTO public.xp_season_results
      (season, student_id, level, xp, tier, tier_rank, level_rank, level_size, rounds, practice_days, new_bests)
    SELECT m, r.student_id, r.level, r.xp,
           public.xp_season_tier(r.xp)->>'name', (public.xp_season_tier(r.xp)->>'rank')::smallint,
           r.lr, r.ls, r.rounds, r.days, r.pbs
      FROM ranked r
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_players = ROW_COUNT;

    UPDATE public.xp_seasons SET players = v_players WHERE season = m;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- One student's numbers for one season, computed live (used for the recap card of the month
-- that just ended, which may not be settled yet).
CREATE OR REPLACE FUNCTION public.xp_season_live(p_student uuid, p_season date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from date := date_trunc('month', p_season)::date;
  v_to date := (date_trunc('month', p_season) + interval '1 month')::date - 1;
  v_level text;
  s record;
  v_rank integer;
  v_of integer;
BEGIN
  SELECT COALESCE(sum(xp), 0)::bigint AS xp, count(*)::integer AS rounds,
         count(DISTINCT day)::integer AS days,
         count(*) FILTER (WHERE is_personal_best AND NOT first_best)::integer AS pbs
    INTO s
    FROM public.student_xp_events
   WHERE student_id = p_student AND day BETWEEN v_from AND v_to;

  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = p_student;

  IF s.xp > 0 THEN
    WITH vals AS (
      SELECT e.student_id, sum(e.xp) AS v
        FROM public.student_xp_events e
        JOIN public.profiles p ON p.id = e.student_id AND p.role = 'student'
       WHERE e.day BETWEEN v_from AND v_to AND p.level IS NOT DISTINCT FROM v_level
       GROUP BY e.student_id
      HAVING sum(e.xp) > 0
    )
    SELECT 1 + count(*) FILTER (WHERE v > s.xp), count(*) INTO v_rank, v_of FROM vals;
  END IF;

  RETURN jsonb_build_object(
    'season', v_from,
    'to', v_to,
    'xp', s.xp,
    'tier', public.xp_season_tier(s.xp),
    'rounds', s.rounds,
    'practice_days', s.days,
    'new_bests', s.pbs,
    'level', v_level,
    'level_rank', v_rank,
    'level_size', v_of,
    'badges', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', c.name, 'icon', c.icon) ORDER BY b.earned_at)
        FROM public.student_badges b JOIN public.badge_catalogue c ON c.key = b.badge_key
       WHERE b.student_id = p_student
         AND (b.earned_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN v_from AND v_to
    ), '[]'::jsonb)
  );
END;
$function$;

-- Settle seasons together with the week / month champions.
CREATE OR REPLACE FUNCTION public.xp_settle_awards()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := public.today_ist();
  v_week date := date_trunc('week', v_today)::date;
  v_month date := date_trunc('month', v_today)::date;
  i integer;
BEGIN
  FOR i IN 1..2 LOOP
    PERFORM public.xp_settle_period('week', v_week - 7 * i, v_week - 7 * i + 6);
    PERFORM public.xp_settle_period('month', (v_month - make_interval(months => i))::date,
                                    (v_month - make_interval(months => i - 1))::date - 1);
  END LOOP;
  PERFORM public.xp_settle_seasons();
END;
$function$;

-- 4. Totals: season XP leads, lifetime is the career number --------------------------------

CREATE OR REPLACE FUNCTION public.xp_totals(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := public.today_ist();
  v_from date;
  v_to date;
  v_s_from date := date_trunc('month', public.today_ist())::date;
  v_s_to date := (date_trunc('month', public.today_ist()) + interval '1 month')::date - 1;
  v_total bigint;
  v_season bigint;
  v_week bigint;
  v_day bigint;
  v_rounds_today integer;
  v_streak record;
  v_level text;
  v_rank jsonb;
  v_srank jsonb;
BEGIN
  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds('week') b;

  SELECT COALESCE(sum(xp), 0),
         COALESCE(sum(xp) FILTER (WHERE day BETWEEN v_s_from AND v_s_to), 0),
         COALESCE(sum(xp) FILTER (WHERE day BETWEEN v_from AND v_to), 0),
         COALESCE(sum(xp) FILTER (WHERE day = v_today), 0),
         count(*) FILTER (WHERE day = v_today)
    INTO v_total, v_season, v_week, v_day, v_rounds_today
    FROM public.student_xp_events WHERE student_id = p_student;

  SELECT * INTO v_streak FROM public.streak_calc(p_student);
  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = p_student;

  WITH elig AS (
    SELECT p.id, public.display_name_for(p.full_name, p.student_code) AS dn
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active
       AND p.level IS NOT DISTINCT FROM v_level
       AND (p.leaderboard_visible OR p.id = p_student)
  ),
  vals AS (
    SELECT e.id, e.dn,
           COALESCE(x.wk, 0) AS v,
           COALESCE(x.ss, 0) AS sv
      FROM elig e
      LEFT JOIN LATERAL (
        SELECT sum(xp) FILTER (WHERE day BETWEEN v_from AND v_to) AS wk,
               sum(xp) FILTER (WHERE day BETWEEN v_s_from AND v_s_to) AS ss
          FROM public.student_xp_events
         WHERE student_id = e.id
           AND (day BETWEEN v_s_from AND v_s_to OR day BETWEEN v_from AND v_to)
      ) x ON true
  ),
  me AS (SELECT v, sv FROM vals WHERE id = p_student),
  above AS (
    SELECT vv.dn, vv.v FROM vals vv, me
     WHERE vv.v > me.v AND vv.id <> p_student
     ORDER BY vv.v ASC, vv.dn LIMIT 1
  ),
  s_above AS (
    SELECT vv.dn, vv.sv FROM vals vv, me
     WHERE vv.sv > me.sv AND vv.id <> p_student
     ORDER BY vv.sv ASC, vv.dn LIMIT 1
  )
  SELECT jsonb_build_object(
    'rank', CASE WHEN (SELECT v FROM me) > 0 THEN 1 + (SELECT count(*) FROM vals, me WHERE vals.v > me.v) END,
    'of', (SELECT count(*) FROM vals WHERE v > 0),
    'level', v_level,
    'above_name', (SELECT dn FROM above),
    'gap', (SELECT above.v - me.v FROM above, me)
  ),
  jsonb_build_object(
    'rank', CASE WHEN (SELECT sv FROM me) > 0 THEN 1 + (SELECT count(*) FROM vals, me WHERE vals.sv > me.sv) END,
    'of', (SELECT count(*) FROM vals WHERE sv > 0),
    'level', v_level,
    'above_name', (SELECT dn FROM s_above),
    'gap', (SELECT s_above.sv - me.sv FROM s_above, me)
  )
  INTO v_rank, v_srank;

  RETURN jsonb_build_object(
    'total_xp', v_total,
    'lifetime_xp', v_total,
    'season_xp', v_season,
    'season', jsonb_build_object(
      'from', v_s_from,
      'to', v_s_to,
      'days_left', v_s_to - v_today + 1
    ),
    'week_xp', v_week,
    'today_xp', v_day,
    'rounds_today', v_rounds_today,
    'week_from', v_from,
    'week_to', v_to,
    'tier', public.xp_season_tier(v_season),
    'streak', jsonb_build_object(
      'current', COALESCE(v_streak.current_streak, 0),
      'best', COALESCE(v_streak.best_streak, 0),
      'shields', COALESCE(v_streak.shields, 0),
      'active_today', COALESCE(v_streak.active_today, false)
    ),
    'week_rank', v_rank,
    'season_rank', v_srank
  );
END;
$function$;

-- Season history and the recap of the month that just ended (first 7 days of a month).
CREATE OR REPLACE FUNCTION public.my_xp_summary(p_student uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_student, auth.uid());
  v_today date := public.today_ist();
  v_last date := (date_trunc('month', public.today_ist()) - interval '1 month')::date;
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.xp_can_view(v_target) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  v_out := public.xp_totals(v_target);

  v_out := v_out || jsonb_build_object(
    'bests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'label', b.label, 'score', b.score_label, 'day', b.day, 'rounds', b.rounds
             ) ORDER BY b.day DESC, b.label)
        FROM (
          SELECT * FROM (
            SELECT DISTINCT ON (e.activity_key)
                   e.activity_key, e.label, e.score_label, e.day,
                   count(*) OVER (PARTITION BY e.activity_key) AS rounds
              FROM public.student_xp_events e
             WHERE e.student_id = v_target AND e.pb_score IS NOT NULL
             ORDER BY e.activity_key, e.pb_score DESC, e.time_seconds ASC NULLS LAST, e.day DESC
          ) d
          ORDER BY d.day DESC, d.label
          LIMIT 12
        ) b
    ), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'label', r.label, 'xp', r.xp, 'score', r.score_label, 'day', r.day,
               'personal_best', r.is_personal_best AND NOT r.first_best
             ) ORDER BY r.created_at DESC)
        FROM (
          SELECT * FROM public.student_xp_events
           WHERE student_id = v_target
           ORDER BY created_at DESC, id DESC
           LIMIT 6
        ) r
    ), '[]'::jsonb),
    'seasons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'season', r.season, 'xp', r.xp, 'tier', r.tier, 'tier_rank', r.tier_rank,
               'level', r.level, 'level_rank', r.level_rank, 'level_size', r.level_size,
               'rounds', r.rounds, 'practice_days', r.practice_days, 'new_bests', r.new_bests
             ) ORDER BY r.season DESC)
        FROM (SELECT * FROM public.xp_season_results
               WHERE student_id = v_target ORDER BY season DESC LIMIT 24) r
    ), '[]'::jsonb),
    'best_season', (
      SELECT jsonb_build_object('season', r.season, 'xp', r.xp, 'tier', r.tier)
        FROM public.xp_season_results r
       WHERE r.student_id = v_target
       ORDER BY r.xp DESC, r.season DESC LIMIT 1
    ),
    'season_recap', CASE
      WHEN extract(day FROM v_today) <= 7 THEN public.xp_season_live(v_target, v_last)
    END
  );
  RETURN v_out;
END;
$function$;

-- 5. Rank badges from the best season ------------------------------------------------------

CREATE OR REPLACE FUNCTION public.badges_award(p_student uuid, p_full boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s record;
  v_best_day bigint;
  v_best_season bigint;
  v_keys text[] := ARRAY[]::text[];
  v_best_streak integer := 0;
  v_played integer := 0;
  v_wins integer := 0;
  v_n integer;
BEGIN
  IF p_student IS NULL THEN RETURN 0; END IF;

  SELECT count(*) AS rounds,
         count(*) FILTER (WHERE is_personal_best AND NOT first_best) AS pbs,
         count(*) FILTER (WHERE total >= 10 AND correct = total) AS perfects,
         count(*) FILTER (WHERE activity_key LIKE 'flash:%' AND total > 0 AND correct = total) AS flash_perfect,
         count(DISTINCT split_part(activity_key, ':', 2)) FILTER (WHERE activity_key LIKE 'mem:%') AS mem_modules,
         count(DISTINCT split_part(activity_key, ':', 1)) AS kinds
    INTO s
    FROM public.student_xp_events
   WHERE student_id = p_student;

  SELECT max(d.x) INTO v_best_day
    FROM (SELECT sum(xp) AS x FROM public.student_xp_events WHERE student_id = p_student GROUP BY day) d;

  -- Best single season (calendar month, IST), including the one in progress.
  SELECT max(m.x) INTO v_best_season
    FROM (SELECT sum(xp) AS x FROM public.student_xp_events WHERE student_id = p_student
           GROUP BY date_trunc('month', day)) m;
  v_best_season := COALESCE(v_best_season, 0);

  IF s.rounds >= 1 THEN v_keys := array_append(v_keys, 'first_round'); END IF;
  IF s.rounds >= 10 THEN v_keys := array_append(v_keys, 'rounds_10'); END IF;
  IF s.rounds >= 100 THEN v_keys := array_append(v_keys, 'rounds_100'); END IF;
  IF s.rounds >= 500 THEN v_keys := array_append(v_keys, 'rounds_500'); END IF;
  IF s.rounds >= 1000 THEN v_keys := array_append(v_keys, 'rounds_1000'); END IF;
  IF COALESCE(v_best_day, 0) >= 500 THEN v_keys := array_append(v_keys, 'big_day'); END IF;
  IF s.kinds >= 4 THEN v_keys := array_append(v_keys, 'explorer'); END IF;
  IF s.perfects >= 1 THEN v_keys := array_append(v_keys, 'perfect_first'); END IF;
  IF s.perfects >= 25 THEN v_keys := array_append(v_keys, 'perfect_25'); END IF;
  IF s.flash_perfect >= 1 THEN v_keys := array_append(v_keys, 'flash_perfect'); END IF;
  IF s.mem_modules >= 4 THEN v_keys := array_append(v_keys, 'memoriad_all'); END IF;
  IF s.pbs >= 1 THEN v_keys := array_append(v_keys, 'pb_first'); END IF;
  IF s.pbs >= 10 THEN v_keys := array_append(v_keys, 'pb_10'); END IF;
  IF s.pbs >= 50 THEN v_keys := array_append(v_keys, 'pb_50'); END IF;
  IF v_best_season >= 300 THEN v_keys := array_append(v_keys, 'tier_silver'); END IF;
  IF v_best_season >= 1000 THEN v_keys := array_append(v_keys, 'tier_gold'); END IF;
  IF v_best_season >= 2500 THEN v_keys := array_append(v_keys, 'tier_platinum'); END IF;
  IF v_best_season >= 5000 THEN v_keys := array_append(v_keys, 'tier_diamond'); END IF;
  IF v_best_season >= 9000 THEN v_keys := array_append(v_keys, 'tier_master'); END IF;
  IF v_best_season >= 15000 THEN v_keys := array_append(v_keys, 'tier_legend'); END IF;

  IF p_full THEN
    BEGIN
      SELECT GREATEST(COALESCE(sc.best_streak, 0), COALESCE(sc.current_streak, 0))
        INTO v_best_streak FROM public.streak_calc(p_student) sc;
    EXCEPTION WHEN OTHERS THEN
      v_best_streak := 0;
    END;
    IF v_best_streak >= 3 THEN v_keys := array_append(v_keys, 'streak_3'); END IF;
    IF v_best_streak >= 7 THEN v_keys := array_append(v_keys, 'streak_7'); END IF;
    IF v_best_streak >= 30 THEN v_keys := array_append(v_keys, 'streak_30'); END IF;
    IF v_best_streak >= 100 THEN v_keys := array_append(v_keys, 'streak_100'); END IF;

    SELECT count(*) INTO v_played
      FROM public.daily_challenge_attempts WHERE student_id = p_student AND submitted_at IS NOT NULL;
    IF v_played >= 1 THEN v_keys := array_append(v_keys, 'challenge_first'); END IF;
    IF v_played >= 7 THEN v_keys := array_append(v_keys, 'challenge_7'); END IF;
    IF v_played >= 30 THEN v_keys := array_append(v_keys, 'challenge_30'); END IF;

    SELECT count(*) INTO v_wins FROM (
      SELECT a.day
        FROM public.daily_challenge_attempts a
       WHERE a.student_id = p_student AND a.submitted_at IS NOT NULL AND a.day < public.today_ist()
         AND (SELECT count(*) FROM public.daily_challenge_attempts o
               WHERE o.day = a.day AND o.level IS NOT DISTINCT FROM a.level AND o.submitted_at IS NOT NULL) >= 2
         AND NOT EXISTS (
           SELECT 1 FROM public.daily_challenge_attempts o
            WHERE o.day = a.day AND o.level IS NOT DISTINCT FROM a.level AND o.submitted_at IS NOT NULL
              AND o.student_id <> a.student_id
              AND (COALESCE(o.correct, 0) > COALESCE(a.correct, 0)
                   OR (COALESCE(o.correct, 0) = COALESCE(a.correct, 0)
                       AND COALESCE(o.time_seconds, 1e9) < COALESCE(a.time_seconds, 1e9))))
    ) w;
    IF v_wins >= 1 THEN v_keys := array_append(v_keys, 'challenge_win'); END IF;

    IF EXISTS (SELECT 1 FROM public.xp_awards WHERE student_id = p_student AND kind = 'week') THEN
      v_keys := array_append(v_keys, 'week_champion');
    END IF;
    IF EXISTS (SELECT 1 FROM public.xp_awards WHERE student_id = p_student AND kind = 'month') THEN
      v_keys := array_append(v_keys, 'star_month');
    END IF;
  END IF;

  INSERT INTO public.student_badges (student_id, badge_key)
  SELECT p_student, k FROM unnest(v_keys) AS k
   WHERE EXISTS (SELECT 1 FROM public.badge_catalogue c WHERE c.key = k)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

UPDATE public.badge_catalogue SET description = v.d
  FROM (VALUES
    ('tier_silver', 'Reach Silver in a season (300 XP in one month).'),
    ('tier_gold', 'Reach Gold in a season (1,000 XP in one month).'),
    ('tier_platinum', 'Reach Platinum in a season (2,500 XP in one month).'),
    ('tier_diamond', 'Reach Diamond in a season (5,000 XP in one month).'),
    ('tier_master', 'Reach Master in a season (9,000 XP in one month).'),
    ('tier_legend', 'Reach Legend in a season (15,000 XP in one month).')
  ) AS v(k, d)
 WHERE key = v.k;

-- 6. Reward wallet counts XP from the shop's start ---------------------------------------

CREATE OR REPLACE FUNCTION public.reward_balance(p_student uuid)
 RETURNS TABLE(earned bigint, spent bigint, balance bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.v, s.v, e.v - s.v
    FROM (SELECT COALESCE(sum(xp), 0)::bigint AS v FROM public.student_xp_events
           WHERE student_id = p_student AND day >= date '2026-11-01') e,
         (SELECT COALESCE(sum(cost), 0)::bigint AS v FROM public.reward_redemptions
           WHERE student_id = p_student AND status IN ('requested', 'given')) s;
$function$;

-- Internal helpers: not callable from the client.
REVOKE EXECUTE ON FUNCTION public.xp_settle_seasons() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.xp_season_live(uuid, date) FROM PUBLIC, anon, authenticated;
