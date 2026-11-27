-- Phase 23: XP, personal bests and the weekly XP leaderboard (gamification phase 1).
--
-- 1. student_xp_events: one row per trusted practice round, written only by triggers.
--    Trusted rounds are verified results (site drills, or typed scores once a teacher
--    verifies them), activity_results (Flash Anzan, Elements, Memoriad: server-written)
--    and jmcwc_scores (main-round papers: server-written). Self-reported Simple practice
--    earns no XP.
-- 2. XP per round: 10 (5 below 50% accuracy) + accuracy x 10 + 10 for a perfect round of
--    5 or more + 1 per 3 correct (up to 10). Memoriad and main-round papers count double.
--    The same activity on the same day earns full XP for 5 rounds, half for the next 5,
--    then a quarter. Beating a personal best adds 25 XP (never reduced).
-- 3. Personal bests are kept per comparable activity (same category and duration, same
--    Flash settings, same Elements drill, same Memoriad module, same paper group) and need
--    at least 70% accuracy (Flash: every answer right).
-- 4. leaderboard() gets an 'xp' board; my_xp_summary() feeds the student progress card and
--    xp_round_summary_for() / xp_round_summary() the end-of-round card.
-- 5. Existing rounds are backfilled in date order.

CREATE TABLE IF NOT EXISTS public.student_xp_events (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('result', 'activity', 'jmcwc')),
  source_id text NOT NULL,
  activity_key text NOT NULL,
  label text NOT NULL,
  correct integer NOT NULL,
  total integer NOT NULL,
  time_seconds numeric,
  day date NOT NULL,
  base_xp integer NOT NULL,
  daily_factor numeric NOT NULL,
  bonus_xp integer NOT NULL DEFAULT 0,
  xp integer NOT NULL,
  pb_score numeric,
  score_label text,
  is_personal_best boolean NOT NULL DEFAULT false,
  first_best boolean NOT NULL DEFAULT false,
  prev_best_label text,
  last_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS student_xp_events_student_day_idx ON public.student_xp_events (student_id, day);
CREATE INDEX IF NOT EXISTS student_xp_events_student_key_idx ON public.student_xp_events (student_id, activity_key, pb_score DESC);
CREATE INDEX IF NOT EXISTS student_xp_events_student_created_idx ON public.student_xp_events (student_id, created_at DESC);

ALTER TABLE public.student_xp_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS student_xp_events_select ON public.student_xp_events;
CREATE POLICY student_xp_events_select ON public.student_xp_events
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR public.is_admin()
    OR (
      public.is_teacher(auth.uid())
      AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
      AND (public.has_teacher_permission(auth.uid(), 'view_students')
           OR public.has_teacher_permission(auth.uid(), 'generate_reports'))
    )
  );

REVOKE ALL ON public.student_xp_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.student_xp_events FROM authenticated;
GRANT SELECT ON public.student_xp_events TO authenticated;
GRANT ALL ON public.student_xp_events TO service_role;

-- Safe numeric read from jsonb text (NULL for anything that is not a plain number).
CREATE OR REPLACE FUNCTION public.xp_num(p text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p ~ '^-?[0-9]+(\.[0-9]+)?$' THEN p::numeric END;
$function$;

-- XP for one round, before the daily rule and personal-best bonus.
CREATE OR REPLACE FUNCTION public.xp_round_base(p_correct integer, p_total integer, p_long boolean)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH a AS (
    SELECT GREATEST(0, LEAST(1, p_correct::numeric / NULLIF(p_total, 0))) AS acc,
           GREATEST(0, COALESCE(p_correct, 0)) AS c
  )
  SELECT ((CASE WHEN a.acc >= 0.5 THEN 10 ELSE 5 END
          + floor(a.acc * 10)
          + CASE WHEN a.acc >= 1 AND p_total >= 5 THEN 10 ELSE 0 END
          + floor(LEAST(a.c, 30) / 3.0))
          * CASE WHEN p_long THEN 2 ELSE 1 END)::integer
    FROM a;
$function$;

CREATE OR REPLACE FUNCTION public.xp_daily_factor(p_rounds_before integer)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN p_rounds_before < 5 THEN 1.0 WHEN p_rounds_before < 10 THEN 0.5 ELSE 0.25 END;
$function$;

-- Records one round. p_pb_score is NULL when the round cannot set a personal best.
-- Higher p_pb_score is better; ties go to the lower p_time.
CREATE OR REPLACE FUNCTION public.xp_award(
  p_student uuid, p_source text, p_source_id text, p_key text, p_label text,
  p_correct integer, p_total integer, p_time numeric, p_day date, p_long boolean,
  p_pb_score numeric, p_score_label text, p_at timestamptz
)
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

  SELECT count(*) INTO v_before
    FROM public.student_xp_events
   WHERE student_id = p_student AND activity_key = p_key AND day = p_day;
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

-- ---------------------------------------------------------------------------
-- Per-source mapping
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.xp_from_result(r public.results, p_at timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text;
  v_key text;
  v_label text;
  v_time numeric := r.time_seconds;
  v_timed boolean := false;
BEGIN
  IF NOT COALESCE(r.verified, false) OR COALESCE(r.total, 0) <= 0 OR r.correct IS NULL THEN
    RETURN;
  END IF;
  SELECT c.name INTO v_name FROM public.categories c WHERE c.id = r.category_id;
  v_name := COALESCE(v_name, 'Practice');

  IF r.source = 'site' AND COALESCE(r.practice_mode, 'timed') = 'timed' AND v_time IS NOT NULL THEN
    v_timed := true;
    v_key := 'cat:' || r.category_id || ':t' || round(v_time)::integer;
    v_label := v_name || ' · ' || CASE WHEN round(v_time) % 60 = 0
                                       THEN (round(v_time) / 60)::integer || ' min'
                                       ELSE round(v_time)::integer || ' s' END;
  ELSIF r.source = 'site' THEN
    v_key := 'cat:' || r.category_id || ':unlimited';
    v_label := v_name || ' · practice';
  ELSE
    v_key := 'cat:' || r.category_id || ':typed';
    v_label := v_name;
  END IF;

  PERFORM public.xp_award(
    r.student_id, 'result', r.id::text, v_key, v_label, r.correct, r.total,
    CASE WHEN v_timed THEN NULL ELSE v_time END,
    COALESCE(r.entry_date, public.today_ist()), false,
    r.correct::numeric,
    r.correct || '/' || r.total || CASE WHEN v_time IS NOT NULL AND NOT v_timed
                                        THEN ' in ' || round(v_time)::integer || 's' ELSE '' END,
    p_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.xp_from_activity(a public.activity_results, p_at timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s jsonb := COALESCE(a.settings, '{}'::jsonb);
  v_key text;
  v_label text;
  v_score numeric;
  v_score_label text;
  v_time numeric := a.time_seconds;
  v_long boolean := false;
  v_speed numeric;
  v_mscore numeric;
BEGIN
  IF COALESCE(a.total, 0) <= 0 OR a.correct IS NULL THEN
    RETURN;
  END IF;

  IF a.activity_type = 'flash_anzan' THEN
    v_speed := public.xp_num(s->>'speed_ms');
    v_key := 'flash:' || COALESCE(s->>'digits', '?') || 'd:' || COALESCE(s->>'count', '?')
             || ':' || COALESCE(s->>'mode', 'add');
    v_label := 'Flash Anzan · ' || COALESCE(s->>'digits', '?') || ' digit × ' || COALESCE(s->>'count', '?');
    -- Faster cleared speed is better; only rounds with every answer right count.
    v_score := CASE WHEN a.correct >= a.total AND v_speed > 0 THEN -v_speed END;
    v_score_label := CASE WHEN v_speed > 0 THEN round(v_speed)::integer || ' ms · ' ELSE '' END
                     || a.correct || '/' || a.total;
    v_time := NULL;
  ELSIF a.activity_type = 'element' THEN
    v_key := 'el:' || COALESCE(s->>'drill', a.activity_name, '?') || ':' || COALESCE(s->>'time_limit_seconds', 'u');
    v_label := COALESCE(NULLIF(a.activity_name, ''), 'Elements');
    v_score := a.correct;
    v_score_label := a.correct || '/' || a.total
                     || CASE WHEN v_time IS NOT NULL THEN ' in ' || round(v_time)::integer || 's' ELSE '' END;
  ELSIF a.activity_type = 'memoriad' THEN
    v_long := true;
    v_mscore := public.xp_num(s->>'score');
    v_key := 'mem:' || COALESCE(s->>'module', a.activity_name, '?') || ':' || COALESCE(s->>'digits', '')
             || ':' || COALESCE(s->>'layout', '');
    v_label := 'Memoriad · ' || COALESCE(NULLIF(a.activity_name, ''), s->>'module', 'round');
    v_score := COALESCE(v_mscore, a.correct);
    v_time := COALESCE(public.xp_num(s->>'used_seconds'), v_time);
    v_score_label := CASE WHEN v_mscore IS NOT NULL THEN 'score ' || v_mscore || ' · ' ELSE '' END
                     || a.correct || '/' || a.total;
  ELSE
    v_key := 'act:' || a.activity_type || ':' || COALESCE(a.activity_name, '');
    v_label := COALESCE(NULLIF(a.activity_name, ''), a.activity_type);
    v_score := a.correct;
    v_score_label := a.correct || '/' || a.total;
  END IF;

  PERFORM public.xp_award(
    a.student_id, 'activity', a.id::text, v_key, v_label, a.correct, a.total, v_time,
    (COALESCE(a.created_at, now()) AT TIME ZONE 'Asia/Kolkata')::date, v_long,
    v_score, v_score_label, p_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.xp_from_jmcwc(sc public.jmcwc_scores, p_at timestamptz)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_att record;
  v_cat text;
  v_attempted integer;
BEGIN
  SELECT a.student_id, a.group_key, a.category_key, a.active_ms INTO v_att
    FROM public.jmcwc_attempts a WHERE a.id = sc.attempt_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_attempted := COALESCE(sc.correct, 0) + COALESCE(sc.partial, 0) + COALESCE(sc.wrong, 0);
  IF v_attempted <= 0 THEN RETURN; END IF;

  IF v_att.category_key IS NOT NULL THEN
    SELECT c.label INTO v_cat FROM public.jmcwc_categories c WHERE c.key = v_att.category_key;
  END IF;

  PERFORM public.xp_award(
    v_att.student_id, 'jmcwc', sc.attempt_id::text,
    'jm:' || COALESCE(v_att.group_key, '?') || ':' || COALESCE(v_att.category_key, 'all'),
    'Main round · ' || initcap(regexp_replace(COALESCE(v_att.group_key, ''), '([a-z])([0-9])', '\1 \2'))
      || COALESCE(' · ' || COALESCE(v_cat, v_att.category_key), ''),
    COALESCE(sc.correct, 0), v_attempted,
    CASE WHEN v_att.active_ms IS NOT NULL THEN round(v_att.active_ms / 1000.0) END,
    (COALESCE(sc.created_at, now()) AT TIME ZONE 'Asia/Kolkata')::date, true,
    sc.marks, COALESCE(sc.marks::text, '0') || ' marks', p_at
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_xp_results()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.student_xp_events WHERE source = 'result' AND source_id = OLD.id::text;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.verified IS NOT DISTINCT FROM OLD.verified
       AND NEW.correct IS NOT DISTINCT FROM OLD.correct
       AND NEW.total IS NOT DISTINCT FROM OLD.total
       AND NEW.time_seconds IS NOT DISTINCT FROM OLD.time_seconds
       AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
       AND NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date
       AND NEW.student_id IS NOT DISTINCT FROM OLD.student_id THEN
      RETURN NEW;
    END IF;
    DELETE FROM public.student_xp_events WHERE source = 'result' AND source_id = OLD.id::text;
  END IF;
  PERFORM public.xp_from_result(NEW, now());
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- XP must never block saving a score.
  RAISE WARNING 'xp award skipped for result %: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_xp_activity_results()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.student_xp_events WHERE source = 'activity' AND source_id = OLD.id::text;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.correct IS NOT DISTINCT FROM OLD.correct
       AND NEW.total IS NOT DISTINCT FROM OLD.total
       AND NEW.settings IS NOT DISTINCT FROM OLD.settings
       AND NEW.student_id IS NOT DISTINCT FROM OLD.student_id THEN
      RETURN NEW;
    END IF;
    DELETE FROM public.student_xp_events WHERE source = 'activity' AND source_id = OLD.id::text;
  END IF;
  PERFORM public.xp_from_activity(NEW, now());
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'xp award skipped for activity %: %', COALESCE(NEW.id, OLD.id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_xp_jmcwc_scores()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM public.student_xp_events WHERE source = 'jmcwc' AND source_id = OLD.attempt_id::text;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  END IF;
  PERFORM public.xp_from_jmcwc(NEW, now());
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'xp award skipped for paper %: %', COALESCE(NEW.attempt_id, OLD.attempt_id), SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_xp_results ON public.results;
CREATE TRIGGER trg_xp_results
  AFTER INSERT OR UPDATE OR DELETE ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.trg_xp_results();

DROP TRIGGER IF EXISTS trg_xp_activity_results ON public.activity_results;
CREATE TRIGGER trg_xp_activity_results
  AFTER INSERT OR UPDATE OR DELETE ON public.activity_results
  FOR EACH ROW EXECUTE FUNCTION public.trg_xp_activity_results();

DROP TRIGGER IF EXISTS trg_xp_jmcwc_scores ON public.jmcwc_scores;
CREATE TRIGGER trg_xp_jmcwc_scores
  AFTER INSERT OR UPDATE OR DELETE ON public.jmcwc_scores
  FOR EACH ROW EXECUTE FUNCTION public.trg_xp_jmcwc_scores();

-- ---------------------------------------------------------------------------
-- Tiers and summaries
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.xp_tier(p_total bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH t(name, floor_xp, ord) AS (
    VALUES ('Bronze', 0, 1), ('Silver', 1000, 2), ('Gold', 3000, 3),
           ('Platinum', 7500, 4), ('Diamond', 15000, 5), ('Master', 30000, 6), ('Legend', 75000, 7)
  ),
  cur AS (SELECT * FROM t WHERE floor_xp <= GREATEST(COALESCE(p_total, 0), 0) ORDER BY floor_xp DESC LIMIT 1),
  nxt AS (SELECT * FROM t WHERE floor_xp > GREATEST(COALESCE(p_total, 0), 0) ORDER BY floor_xp ASC LIMIT 1)
  SELECT jsonb_build_object(
    'name', cur.name, 'floor', cur.floor_xp, 'rank', cur.ord,
    'next_name', nxt.name, 'next_floor', nxt.floor_xp
  )
  FROM cur LEFT JOIN nxt ON true;
$function$;

CREATE OR REPLACE FUNCTION public.xp_can_view(p_student uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    auth.uid() = p_student
    OR public.is_admin()
    OR (
      public.is_teacher(auth.uid())
      AND public.is_teacher_assigned_to_student(auth.uid(), p_student)
      AND (public.has_teacher_permission(auth.uid(), 'view_students')
           OR public.has_teacher_permission(auth.uid(), 'generate_reports'))
    )
  );
$function$;

-- Totals, tier, streak and this week's level rank for one student.
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
  v_total bigint;
  v_week bigint;
  v_day bigint;
  v_rounds_today integer;
  v_streak record;
  v_level text;
  v_rank jsonb;
BEGIN
  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds('week') b;

  SELECT COALESCE(sum(xp), 0),
         COALESCE(sum(xp) FILTER (WHERE day BETWEEN v_from AND v_to), 0),
         COALESCE(sum(xp) FILTER (WHERE day = v_today), 0),
         count(*) FILTER (WHERE day = v_today)
    INTO v_total, v_week, v_day, v_rounds_today
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
           COALESCE((SELECT sum(x.xp) FROM public.student_xp_events x
                      WHERE x.student_id = e.id AND x.day BETWEEN v_from AND v_to), 0) AS v
      FROM elig e
  ),
  me AS (SELECT v FROM vals WHERE id = p_student),
  above AS (
    SELECT vv.dn, vv.v FROM vals vv, me
     WHERE vv.v > me.v AND vv.id <> p_student
     ORDER BY vv.v ASC, vv.dn LIMIT 1
  )
  SELECT jsonb_build_object(
    'rank', CASE WHEN (SELECT v FROM me) > 0 THEN 1 + (SELECT count(*) FROM vals, me WHERE vals.v > me.v) END,
    'of', (SELECT count(*) FROM vals WHERE v > 0),
    'level', v_level,
    'above_name', (SELECT dn FROM above),
    'gap', (SELECT above.v - me.v FROM above, me)
  ) INTO v_rank;

  RETURN jsonb_build_object(
    'total_xp', v_total,
    'week_xp', v_week,
    'today_xp', v_day,
    'rounds_today', v_rounds_today,
    'week_from', v_from,
    'week_to', v_to,
    'tier', public.xp_tier(v_total),
    'streak', jsonb_build_object(
      'current', COALESCE(v_streak.current_streak, 0),
      'best', COALESCE(v_streak.best_streak, 0),
      'shields', COALESCE(v_streak.shields, 0),
      'active_today', COALESCE(v_streak.active_today, false)
    ),
    'week_rank', v_rank
  );
END;
$function$;

-- The student progress card: totals plus personal bests and recent rounds.
CREATE OR REPLACE FUNCTION public.my_xp_summary(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_student, auth.uid());
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
    ), '[]'::jsonb)
  );
  RETURN v_out;
END;
$function$;

-- The end-of-round card: the caller's newest round saved since p_since.
CREATE OR REPLACE FUNCTION public.xp_round_summary(p_since timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_ev record;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ev
    FROM public.student_xp_events
   WHERE student_id = v_me
     AND created_at >= COALESCE(p_since, now() - interval '10 minutes') - interval '5 seconds'
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('round', NULL) || public.xp_totals(v_me);
  END IF;

  RETURN jsonb_build_object('round', jsonb_build_object(
    'label', v_ev.label,
    'xp', v_ev.xp,
    'base_xp', v_ev.base_xp,
    'daily_factor', v_ev.daily_factor,
    'bonus_xp', v_ev.bonus_xp,
    'score', v_ev.score_label,
    'personal_best', v_ev.is_personal_best AND NOT v_ev.first_best,
    'first_best', v_ev.first_best,
    'prev_best', v_ev.prev_best_label,
    'last_time', v_ev.last_label,
    'correct', v_ev.correct,
    'total', v_ev.total
  )) || public.xp_totals(v_me);
END;
$function$;

-- The end-of-round card for one saved round: p_source_id is the id the save returned
-- (results.id, activity_results.id or the main-round attempt id).
CREATE OR REPLACE FUNCTION public.xp_round_summary_for(p_source_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_ev record;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ev
    FROM public.student_xp_events
   WHERE student_id = v_me AND source_id = p_source_id
   ORDER BY id DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('round', NULL) || public.xp_totals(v_me);
  END IF;

  RETURN jsonb_build_object('round', jsonb_build_object(
    'label', v_ev.label,
    'xp', v_ev.xp,
    'base_xp', v_ev.base_xp,
    'daily_factor', v_ev.daily_factor,
    'bonus_xp', v_ev.bonus_xp,
    'score', v_ev.score_label,
    'personal_best', v_ev.is_personal_best AND NOT v_ev.first_best,
    'first_best', v_ev.first_best,
    'prev_best', v_ev.prev_best_label,
    'last_time', v_ev.last_label,
    'correct', v_ev.correct,
    'total', v_ev.total
  )) || public.xp_totals(v_me);
END;
$function$;

REVOKE ALL ON FUNCTION public.xp_round_summary_for(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.xp_round_summary_for(text) TO authenticated;

REVOKE ALL ON FUNCTION public.xp_award(uuid, text, text, text, text, integer, integer, numeric, date, boolean, numeric, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_from_result(public.results, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_from_activity(public.activity_results, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_from_jmcwc(public.jmcwc_scores, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_totals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_xp_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.xp_round_summary(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_xp_summary(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.xp_round_summary(timestamptz) TO authenticated;

-- ---------------------------------------------------------------------------
-- Leaderboard: add the 'xp' board (same eligibility and visibility as the others)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.leaderboard(p_board text, p_period text DEFAULT 'week'::text, p_level text DEFAULT NULL::text, p_limit integer DEFAULT 10, p_scope text DEFAULT 'level'::text)
 RETURNS TABLE(rank integer, student_id uuid, display_name text, value numeric, is_me boolean, level text)
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
    SELECT p.id, p.level AS lvl, public.display_name_for(p.full_name, p.student_code) AS dn
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND (v_all OR p.level IS NOT DISTINCT FROM v_level)
  ),
  vals AS (
    SELECT e.id, e.dn, e.lvl,
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
    SELECT (rank() OVER (ORDER BY vv.v DESC))::integer AS rk, vv.id, vv.dn, vv.lvl, vv.v
      FROM vals vv
     WHERE vv.v IS NOT NULL AND vv.v > 0
  )
  SELECT r.rk, CASE WHEN v_admin THEN r.id END, r.dn, r.v, (r.id = v_me), r.lvl
    FROM ranked r
   WHERE r.rk <= v_limit OR r.id = v_me
   ORDER BY r.rk, r.dn;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Backfill existing trusted rounds in date order (idempotent: ON CONFLICT DO NOTHING)
-- ---------------------------------------------------------------------------

DO $backfill$
DECLARE
  rec record;
  r public.results;
  a public.activity_results;
  s public.jmcwc_scores;
BEGIN
  FOR rec IN
    SELECT * FROM (
      SELECT 'result' AS kind, x.id::text AS id, x.entry_date AS day, x.created_at AS at
        FROM public.results x
       WHERE x.verified AND x.total > 0 AND x.correct IS NOT NULL
      UNION ALL
      SELECT 'activity', y.id::text, (y.created_at AT TIME ZONE 'Asia/Kolkata')::date, y.created_at
        FROM public.activity_results y
       WHERE y.total > 0 AND y.correct IS NOT NULL
      UNION ALL
      SELECT 'jmcwc', z.attempt_id::text, (z.created_at AT TIME ZONE 'Asia/Kolkata')::date, z.created_at
        FROM public.jmcwc_scores z
    ) q
    ORDER BY q.day, q.at, q.id
  LOOP
    IF rec.kind = 'result' THEN
      SELECT * INTO r FROM public.results WHERE id::text = rec.id;
      PERFORM public.xp_from_result(r, COALESCE(rec.at, now()));
    ELSIF rec.kind = 'activity' THEN
      SELECT * INTO a FROM public.activity_results WHERE id::text = rec.id;
      PERFORM public.xp_from_activity(a, COALESCE(rec.at, now()));
    ELSE
      SELECT * INTO s FROM public.jmcwc_scores WHERE attempt_id::text = rec.id;
      PERFORM public.xp_from_jmcwc(s, COALESCE(rec.at, now()));
    END IF;
  END LOOP;
END;
$backfill$;
