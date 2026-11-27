-- World and story layer: mascots, the level journey with boss rounds, and themed seasons.
--
--   * Mascots: each student picks an owl, a robot or a dragon. Its look follows the
--     student's level (drawn in the browser); the choice is the only thing stored.
--   * Journey: one island per standard level. Stages count REAL practice that is already
--     validated on the server (student_xp_events rows, written only by triggers), counted
--     from the day the student first opened that level's island. Oral sets and boss
--     rounds are generated and marked by /api/journey and stored in journey_sessions.
--     A passed boss round flags the student "ready for level-up" for a teacher. It NEVER
--     changes profiles.level.
--   * Themed seasons replace monthly seasons. A season is an 8-week window an owner or
--     director schedules (e.g. "Space Season"). Days outside any themed season fall back to
--     the calendar month, clipped so windows never overlap. Season XP, tiers, the season
--     history (xp_seasons / xp_season_results), the "This season" XP board and the recap all
--     follow the window; there is still one meaning of "season".
--     A themed season's tier floors scale with its length (8 weeks = 56/30 of a month).
--     When a themed season ends: its season badge and mascot outfit go to everyone who
--     reached the badge XP, and the top 3 of each level in each centre get a podium place.
--
-- No data is dropped. The only constraint removed is xp_seasons_first_day (a window may now
-- start on any day); every existing row still starts on the 1st.
-- Rollback: supabase/rollbacks/38_world_journey_seasons_rollback.sql

-- 1. Mascots --------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.student_mascots (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('owl', 'bot', 'dragon')),
  equipped_item text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.world_mascot_items (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  season date,
  earned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, item_key)
);

ALTER TABLE public.student_mascots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.world_mascot_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_mascots, public.world_mascot_items FROM anon, authenticated;
GRANT ALL ON public.student_mascots, public.world_mascot_items TO service_role;
-- No policies: read and written through the SECURITY DEFINER functions below.

-- 2. Themed seasons -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.themed_seasons (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  theme text NOT NULL CHECK (theme IN ('space', 'ocean', 'jungle', 'arctic', 'desert', 'volcano')),
  description text,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  badge_key text,
  badge_xp integer NOT NULL DEFAULT 500 CHECK (badge_xp BETWEEN 0 AND 100000),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT themed_seasons_eight_weeks CHECK (ends_on = starts_on + 55)
);
CREATE INDEX IF NOT EXISTS themed_seasons_dates_idx ON public.themed_seasons (starts_on, ends_on) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS public.season_podiums (
  season date NOT NULL,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text,
  centre_id uuid,
  place smallint NOT NULL CHECK (place BETWEEN 1 AND 3),
  xp bigint NOT NULL,
  PRIMARY KEY (season, student_id)
);

ALTER TABLE public.themed_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_podiums ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.themed_seasons, public.season_podiums FROM anon, authenticated;
GRANT ALL ON public.themed_seasons, public.season_podiums TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.themed_seasons_id_seq TO service_role;

-- The season window for a day (see the header). Mirrored by seasonBounds() in shared/world.js.
CREATE OR REPLACE FUNCTION public.season_bounds(p_day date)
 RETURNS TABLE(s_from date, s_to date, themed_id bigint, name text, theme text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH t AS (SELECT * FROM public.themed_seasons WHERE status = 'scheduled'),
  hit AS (
    SELECT t.id, t.starts_on, t.ends_on, t.name, t.theme FROM t
     WHERE p_day BETWEEN t.starts_on AND t.ends_on
     ORDER BY t.starts_on LIMIT 1
  ),
  m AS (
    SELECT date_trunc('month', p_day)::date AS mf,
           ((date_trunc('month', p_day) + interval '1 month')::date - 1) AS mt
  )
  SELECT h.starts_on, h.ends_on, h.id, h.name, h.theme FROM hit h
  UNION ALL
  SELECT GREATEST(m.mf, COALESCE((SELECT max(t.ends_on) + 1 FROM t WHERE t.ends_on < p_day AND t.ends_on >= m.mf), m.mf)),
         LEAST(m.mt, COALESCE((SELECT min(t.starts_on) - 1 FROM t WHERE t.starts_on > p_day AND t.starts_on <= m.mt), m.mt)),
         NULL::bigint, NULL::text, NULL::text
    FROM m
   WHERE NOT EXISTS (SELECT 1 FROM hit);
$function$;

-- Tier for a season window: themed seasons scale the monthly floors by their length.
CREATE OR REPLACE FUNCTION public.xp_season_tier_for(p_xp bigint, p_days integer, p_themed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  f numeric := CASE WHEN p_themed AND p_days > 0 THEN p_days / 30.0 ELSE 1 END;
  t jsonb;
BEGIN
  t := public.xp_season_tier(floor(GREATEST(COALESCE(p_xp, 0), 0) / f)::bigint);
  IF f = 1 THEN RETURN t; END IF;
  RETURN t || jsonb_build_object(
    'floor', round((t->>'floor')::numeric * f / 10) * 10,
    'next_floor', CASE WHEN t->>'next_floor' IS NOT NULL THEN round((t->>'next_floor')::numeric * f / 10) * 10 END
  );
END;
$function$;

-- 3. Season history accepts any window start ----------------------------------------------

ALTER TABLE public.xp_seasons DROP CONSTRAINT IF EXISTS xp_seasons_first_day;
ALTER TABLE public.xp_seasons ADD COLUMN IF NOT EXISTS ends_on date;
ALTER TABLE public.xp_seasons ADD COLUMN IF NOT EXISTS themed_id bigint REFERENCES public.themed_seasons(id) ON DELETE SET NULL;
UPDATE public.xp_seasons SET ends_on = (season + interval '1 month')::date - 1 WHERE ends_on IS NULL;

-- Writes every finished season window that is not settled yet (safe to call often).
CREATE OR REPLACE FUNCTION public.xp_settle_seasons()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := public.today_ist();
  d date;
  w record;
  ts record;
  v_n integer := 0;
  v_players integer;
  v_days integer;
BEGIN
  SELECT min(day) INTO d FROM public.student_xp_events;
  IF d IS NULL THEN RETURN 0; END IF;

  LOOP
    SELECT * INTO w FROM public.season_bounds(d);
    EXIT WHEN w.s_to >= v_today;

    IF NOT EXISTS (SELECT 1 FROM public.xp_seasons s WHERE s.season = w.s_from) THEN
      INSERT INTO public.xp_seasons (season, ends_on, themed_id) VALUES (w.s_from, w.s_to, w.themed_id)
      ON CONFLICT DO NOTHING;
      IF FOUND THEN
        v_days := w.s_to - w.s_from + 1;
        WITH agg AS (
          SELECT e.student_id,
                 sum(e.xp)::bigint AS xp,
                 count(*)::integer AS rounds,
                 count(DISTINCT e.day)::integer AS days,
                 count(*) FILTER (WHERE e.is_personal_best AND NOT e.first_best)::integer AS pbs
            FROM public.student_xp_events e
           WHERE e.day BETWEEN w.s_from AND w.s_to
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
        SELECT w.s_from, r.student_id, r.level, r.xp,
               public.xp_season_tier_for(r.xp, v_days, w.themed_id IS NOT NULL)->>'name',
               (public.xp_season_tier_for(r.xp, v_days, w.themed_id IS NOT NULL)->>'rank')::smallint,
               r.lr, r.ls, r.rounds, r.days, r.pbs
          FROM ranked r
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_players = ROW_COUNT;
        UPDATE public.xp_seasons SET players = v_players WHERE season = w.s_from;

        -- Themed season rewards: badge + mascot outfit, and the podium of each level in each centre.
        IF w.themed_id IS NOT NULL THEN
          SELECT * INTO ts FROM public.themed_seasons WHERE id = w.themed_id;
          IF ts.badge_key IS NOT NULL THEN
            INSERT INTO public.student_badges (student_id, badge_key)
            SELECT r.student_id, ts.badge_key FROM public.xp_season_results r
             WHERE r.season = w.s_from AND r.xp >= ts.badge_xp
            ON CONFLICT DO NOTHING;
          END IF;
          INSERT INTO public.world_mascot_items (student_id, item_key, season)
          SELECT r.student_id, ts.theme, w.s_from FROM public.xp_season_results r
           WHERE r.season = w.s_from AND r.xp >= ts.badge_xp
          ON CONFLICT DO NOTHING;
          INSERT INTO public.season_podiums (season, student_id, level, centre_id, place, xp)
          SELECT w.s_from, x.student_id, x.level, x.centre_id, x.place, x.xp
            FROM (
              SELECT r.student_id, r.level, p.centre_id, r.xp,
                     rank() OVER (PARTITION BY r.level, p.centre_id ORDER BY r.xp DESC)::smallint AS place
                FROM public.xp_season_results r JOIN public.profiles p ON p.id = r.student_id
               WHERE r.season = w.s_from
            ) x
           WHERE x.place <= 3
          ON CONFLICT DO NOTHING;
          UPDATE public.themed_seasons SET settled_at = now() WHERE id = w.themed_id;
        END IF;
        v_n := v_n + 1;
      END IF;
    END IF;
    d := w.s_to + 1;
  END LOOP;
  RETURN v_n;
END;
$function$;

-- One student's numbers for one season window (p_season = any day in it, usually its start).
CREATE OR REPLACE FUNCTION public.xp_season_live(p_student uuid, p_season date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  w record;
  v_level text;
  s record;
  v_rank integer;
  v_of integer;
BEGIN
  SELECT * INTO w FROM public.season_bounds(p_season);

  SELECT COALESCE(sum(xp), 0)::bigint AS xp, count(*)::integer AS rounds,
         count(DISTINCT day)::integer AS days,
         count(*) FILTER (WHERE is_personal_best AND NOT first_best)::integer AS pbs
    INTO s
    FROM public.student_xp_events
   WHERE student_id = p_student AND day BETWEEN w.s_from AND w.s_to;

  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = p_student;

  IF s.xp > 0 THEN
    WITH vals AS (
      SELECT e.student_id, sum(e.xp) AS v
        FROM public.student_xp_events e
        JOIN public.profiles p ON p.id = e.student_id AND p.role = 'student'
       WHERE e.day BETWEEN w.s_from AND w.s_to AND p.level IS NOT DISTINCT FROM v_level
       GROUP BY e.student_id
      HAVING sum(e.xp) > 0
    )
    SELECT 1 + count(*) FILTER (WHERE v > s.xp), count(*) INTO v_rank, v_of FROM vals;
  END IF;

  RETURN jsonb_build_object(
    'season', w.s_from,
    'to', w.s_to,
    'name', w.name,
    'theme', w.theme,
    'themed', w.themed_id IS NOT NULL,
    'xp', s.xp,
    'tier', public.xp_season_tier_for(s.xp, w.s_to - w.s_from + 1, w.themed_id IS NOT NULL),
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
         AND (b.earned_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN w.s_from AND w.s_to
    ), '[]'::jsonb)
  );
END;
$function$;

-- 4. Totals follow the season window (ranks unchanged: within the student's level) --------

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
  w record;
  v_s_from date;
  v_s_to date;
  v_total bigint;
  v_season bigint;
  v_week bigint;
  v_day bigint;
  v_rounds_today integer;
  v_streak record;
  v_level text;
  v_rank jsonb;
  v_srank jsonb;
  v_mascot jsonb;
BEGIN
  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds('week') b;
  SELECT * INTO w FROM public.season_bounds(v_today);
  v_s_from := w.s_from;
  v_s_to := w.s_to;

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

  SELECT jsonb_build_object('kind', m.kind, 'equipped', m.equipped_item) INTO v_mascot
    FROM public.student_mascots m WHERE m.student_id = p_student;

  RETURN jsonb_build_object(
    'total_xp', v_total,
    'lifetime_xp', v_total,
    'season_xp', v_season,
    'season', jsonb_build_object(
      'from', v_s_from,
      'to', v_s_to,
      'days_left', v_s_to - v_today + 1,
      'name', w.name,
      'theme', w.theme,
      'themed', w.themed_id IS NOT NULL
    ),
    'week_xp', v_week,
    'today_xp', v_day,
    'rounds_today', v_rounds_today,
    'week_from', v_from,
    'week_to', v_to,
    'tier', public.xp_season_tier_for(v_season, v_s_to - v_s_from + 1, w.themed_id IS NOT NULL),
    'streak', jsonb_build_object(
      'current', COALESCE(v_streak.current_streak, 0),
      'best', COALESCE(v_streak.best_streak, 0),
      'shields', COALESCE(v_streak.shields, 0),
      'active_today', COALESCE(v_streak.active_today, false)
    ),
    'week_rank', v_rank,
    'season_rank', v_srank,
    'level', v_level,
    'mascot', v_mascot
  );
END;
$function$;

-- Season history and the recap of the season that just ended (first 7 days of a new one).
CREATE OR REPLACE FUNCTION public.my_xp_summary(p_student uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_student, auth.uid());
  v_today date := public.today_ist();
  v_cur date;
  v_last date;
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.xp_can_view(v_target) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  SELECT s_from INTO v_cur FROM public.season_bounds(v_today);
  SELECT s_from INTO v_last FROM public.season_bounds(v_cur - 1);

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
               'rounds', r.rounds, 'practice_days', r.practice_days, 'new_bests', r.new_bests,
               'name', ts.name, 'theme', ts.theme
             ) ORDER BY r.season DESC)
        FROM (SELECT * FROM public.xp_season_results
               WHERE student_id = v_target ORDER BY season DESC LIMIT 24) r
        LEFT JOIN public.xp_seasons xs ON xs.season = r.season
        LEFT JOIN public.themed_seasons ts ON ts.id = xs.themed_id
    ), '[]'::jsonb),
    'best_season', (
      SELECT jsonb_build_object('season', r.season, 'xp', r.xp, 'tier', r.tier)
        FROM public.xp_season_results r
       WHERE r.student_id = v_target
       ORDER BY r.xp DESC, r.season DESC LIMIT 1
    ),
    'season_recap', CASE
      WHEN v_today - v_cur < 7 THEN public.xp_season_live(v_target, v_last)
    END
  );
  RETURN v_out;
END;
$function$;

-- 5. The "This season" XP board follows the season window ---------------------------------
-- Patches the live leaderboard() text (whichever version is installed, e.g. the centre-scoped
-- one) so only the XP board's month period changes. Stops if the expected text is missing.
DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.leaderboard(text,text,text,integer,text)'::regprocedure);
  v_old text := 'x.day BETWEEN v_from AND v_to';
  v_new text := 'x.day BETWEEN (SELECT CASE WHEN COALESCE(p_period, ''week'') = ''month'' THEN sb.s_from ELSE v_from END FROM public.season_bounds(v_today) sb)'
             || ' AND (SELECT CASE WHEN COALESCE(p_period, ''week'') = ''month'' THEN sb.s_to ELSE v_to END FROM public.season_bounds(v_today) sb)';
BEGIN
  IF position('public.season_bounds(v_today)' IN v_def) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'leaderboard(): expected exactly one XP date filter to patch';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$patch$;

-- 6. Season management and the season leaderboard ------------------------------------------

CREATE OR REPLACE FUNCTION public.season_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_today date := public.today_ist();
  w record;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO w FROM public.season_bounds(v_today);
  RETURN jsonb_build_object(
    'today', v_today,
    'can_manage', public.is_network_admin(),
    'current', jsonb_build_object('from', w.s_from, 'to', w.s_to, 'themed_id', w.themed_id,
                                  'name', w.name, 'theme', w.theme, 'days_left', w.s_to - v_today + 1),
    'seasons', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'theme', s.theme, 'description', s.description,
               'starts_on', s.starts_on, 'ends_on', s.ends_on, 'status', s.status,
               'badge_xp', s.badge_xp, 'settled', s.settled_at IS NOT NULL,
               'badge', (SELECT jsonb_build_object('name', c.name, 'icon', c.icon)
                           FROM public.badge_catalogue c WHERE c.key = s.badge_key)
             ) ORDER BY s.starts_on DESC)
        FROM public.themed_seasons s
       WHERE s.status = 'scheduled' OR public.is_network_admin()
    ), '[]'::jsonb),
    'my_podiums', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('season', p.season, 'place', p.place, 'xp', p.xp, 'level', p.level,
                                          'name', ts.name, 'theme', ts.theme) ORDER BY p.season DESC)
        FROM public.season_podiums p
        LEFT JOIN public.xp_seasons xs ON xs.season = p.season
        LEFT JOIN public.themed_seasons ts ON ts.id = xs.themed_id
       WHERE p.student_id = v_me
    ), '[]'::jsonb)
  );
END;
$function$;

-- Owners and directors schedule a season. It must start tomorrow or later and never overlap.
CREATE OR REPLACE FUNCTION public.season_save(p_name text, p_theme text, p_starts_on date,
                                              p_description text DEFAULT NULL, p_badge_xp integer DEFAULT 500)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id bigint;
  v_end date := p_starts_on + 55;
  v_icon text;
BEGIN
  IF NOT public.is_network_admin() THEN
    RAISE EXCEPTION 'Only owners and directors can schedule seasons' USING ERRCODE = '42501';
  END IF;
  IF p_starts_on IS NULL OR p_starts_on <= public.today_ist() THEN
    RAISE EXCEPTION 'A season must start tomorrow or later';
  END IF;
  IF length(btrim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Give the season a name (up to 60 characters)';
  END IF;
  v_icon := CASE p_theme WHEN 'space' THEN '🚀' WHEN 'ocean' THEN '🌊' WHEN 'jungle' THEN '🌴'
                         WHEN 'arctic' THEN '❄️' WHEN 'desert' THEN '🏜️' WHEN 'volcano' THEN '🌋' END;
  IF v_icon IS NULL THEN
    RAISE EXCEPTION 'Unknown season theme';
  END IF;

  LOCK TABLE public.themed_seasons IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.themed_seasons s
              WHERE s.status = 'scheduled' AND s.starts_on <= v_end AND p_starts_on <= s.ends_on) THEN
    RAISE EXCEPTION 'This season overlaps another scheduled season';
  END IF;

  INSERT INTO public.themed_seasons (name, theme, description, starts_on, ends_on, badge_xp, created_by)
  VALUES (btrim(p_name), p_theme, NULLIF(btrim(COALESCE(p_description, '')), ''), p_starts_on, v_end,
          GREATEST(0, LEAST(COALESCE(p_badge_xp, 500), 100000)), auth.uid())
  RETURNING id INTO v_id;

  INSERT INTO public.badge_catalogue (key, name, icon, description, category, sort_order)
  VALUES ('season_' || v_id, btrim(p_name), v_icon,
          format('Earn %s XP in %s.', GREATEST(0, LEAST(COALESCE(p_badge_xp, 500), 100000)), btrim(p_name)),
          'season', 80)
  ON CONFLICT (key) DO NOTHING;
  UPDATE public.themed_seasons SET badge_key = 'season_' || v_id WHERE id = v_id;
  RETURN v_id;
END;
$function$;

-- A season can be cancelled only before it starts (nothing has been earned yet).
CREATE OR REPLACE FUNCTION public.season_cancel(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_network_admin() THEN
    RAISE EXCEPTION 'Only owners and directors can cancel seasons' USING ERRCODE = '42501';
  END IF;
  UPDATE public.themed_seasons SET status = 'cancelled'
   WHERE id = p_id AND status = 'scheduled' AND starts_on > public.today_ist();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a season that has not started yet can be cancelled';
  END IF;
END;
$function$;

-- The season leaderboard for one level in one centre. Students always see their own level
-- and centre; teachers their centre; owners and directors any centre.
CREATE OR REPLACE FUNCTION public.season_board(p_level text DEFAULT NULL, p_centre uuid DEFAULT NULL, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_role text;
  v_level text;
  v_centre uuid;
  w record;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 50));
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT p.role, p.level, p.centre_id INTO v_role, v_level, v_centre FROM public.profiles p WHERE p.id = v_me;
  IF v_role <> 'student' THEN
    v_level := p_level;
    IF public.is_network_admin() THEN v_centre := COALESCE(p_centre, v_centre); END IF;
  END IF;
  SELECT * INTO w FROM public.season_bounds(public.today_ist());

  RETURN jsonb_build_object(
    'from', w.s_from, 'to', w.s_to, 'name', w.name, 'theme', w.theme, 'level', v_level, 'centre_id', v_centre,
    'rows', COALESCE((
      SELECT jsonb_agg(row_to_json(b) ORDER BY b.rank, b.display_name)
        FROM (
          SELECT rank() OVER (ORDER BY v.xp DESC)::integer AS rank, v.display_name, v.xp, v.student_id = v_me AS is_me
            FROM (
              SELECT p.id AS student_id, public.display_name_for(p.full_name, p.student_code) AS display_name,
                     sum(e.xp)::bigint AS xp
                FROM public.profiles p
                JOIN public.student_xp_events e ON e.student_id = p.id AND e.day BETWEEN w.s_from AND w.s_to
               WHERE p.role = 'student' AND p.active
                 AND p.level IS NOT DISTINCT FROM v_level
                 AND p.centre_id IS NOT DISTINCT FROM v_centre
                 AND (p.leaderboard_visible OR p.id = v_me)
               GROUP BY p.id
              HAVING sum(e.xp) > 0
            ) v
           ORDER BY v.xp DESC
           LIMIT v_limit
        ) b
    ), '[]'::jsonb)
  );
END;
$function$;

-- 7. Journey --------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.journey_stages (
  level text NOT NULL,
  ord smallint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rounds', 'basics', 'flash', 'excel', 'memoriad', 'oral')),
  title text NOT NULL,
  rounds_needed integer NOT NULL CHECK (rounds_needed > 0),
  min_accuracy integer NOT NULL CHECK (min_accuracy BETWEEN 0 AND 100),
  PRIMARY KEY (level, ord)
);

-- Same list as journeyStages() in shared/world.js.
INSERT INTO public.journey_stages (level, ord, kind, title, rounds_needed, min_accuracy)
SELECT l.level, s.ord, s.kind, s.title,
       COALESCE(s.fixed, CASE WHEN l.idx <= 2 THEN 3 WHEN l.idx <= 5 THEN 4 WHEN l.idx <= 8 THEN 5 ELSE 6 END),
       s.acc
  FROM (VALUES ('KA-1', 0), ('KA-2', 1), ('KA-3', 2), ('Level 1', 3), ('Level 2', 4), ('Level 3', 5),
               ('Level 4', 6), ('Level 5', 7), ('Level 6', 8), ('Graduate', 9), ('Master', 10), ('Grandmaster', 11)
       ) AS l(level, idx)
 CROSS JOIN (VALUES (1, 'rounds', 'Abacus rounds', NULL::integer, 70),
                    (2, 'basics', 'Basics', NULL, 70),
                    (3, 'flash', 'Flash Anzan', NULL, 60),
                    (4, 'excel', 'Excel-style main round', 1, 50),
                    (5, 'memoriad', 'Memoriad', 2, 50),
                    (6, 'oral', 'Oral set (checked)', 2, 70)
       ) AS s(ord, kind, title, fixed, acc)
ON CONFLICT (level, ord) DO NOTHING;

-- When the student first opened each level's island (stages count practice from then on).
CREATE TABLE IF NOT EXISTS public.journey_level_starts (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, level)
);

-- Boss rounds and checked oral sets. `questions` holds the answers: service role only.
CREATE TABLE IF NOT EXISTS public.journey_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('boss', 'oral')),
  level text NOT NULL,
  questions jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted')),
  submitted_at timestamptz,
  answers jsonb,
  correct integer,
  total integer,
  percent numeric(5, 1),
  passed boolean,
  by_type jsonb
);
CREATE INDEX IF NOT EXISTS journey_sessions_student_idx ON public.journey_sessions (student_id, kind, started_at DESC);

-- "Ready for level-up" flags for teachers. A teacher's decision never changes profiles.level.
CREATE TABLE IF NOT EXISTS public.journey_levelup_flags (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text NOT NULL,
  session_id uuid REFERENCES public.journey_sessions(id) ON DELETE SET NULL,
  percent numeric(5, 1),
  flagged_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'agreed', 'not_yet')),
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  note text,
  PRIMARY KEY (student_id, level)
);

ALTER TABLE public.journey_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_level_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journey_levelup_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS journey_stages_select ON public.journey_stages;
CREATE POLICY journey_stages_select ON public.journey_stages FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.journey_stages, public.journey_level_starts, public.journey_sessions, public.journey_levelup_flags
  FROM anon, authenticated;
GRANT SELECT ON public.journey_stages TO authenticated;
GRANT ALL ON public.journey_stages, public.journey_level_starts, public.journey_sessions, public.journey_levelup_flags
  TO service_role;

-- Stage counts for one student at their current level. Internal (no caller check).
CREATE OR REPLACE FUNCTION public.journey_progress_for(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_level text;
  v_since timestamptz;
  v_today date := public.today_ist();
  v_stages jsonb;
BEGIN
  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = p_student AND p.role = 'student';
  IF v_level IS NULL OR NOT public.is_standard_student_level(v_level) THEN
    RETURN jsonb_build_object('level', v_level, 'stages', '[]'::jsonb);
  END IF;

  INSERT INTO public.journey_level_starts (student_id, level) VALUES (p_student, v_level)
  ON CONFLICT DO NOTHING;
  SELECT started_at INTO v_since FROM public.journey_level_starts WHERE student_id = p_student AND level = v_level;

  SELECT jsonb_agg(jsonb_build_object(
           'ord', s.ord, 'kind', s.kind, 'title', s.title,
           'rounds_needed', s.rounds_needed, 'min_accuracy', s.min_accuracy,
           'done', CASE s.kind
             WHEN 'oral' THEN (
               SELECT count(*) FROM public.journey_sessions j
                WHERE j.student_id = p_student AND j.kind = 'oral' AND j.level = v_level
                  AND j.status = 'submitted' AND j.started_at >= v_since AND j.percent >= s.min_accuracy)
             ELSE (
               SELECT count(*) FROM public.student_xp_events e
                WHERE e.student_id = p_student AND e.created_at >= v_since
                  AND e.total > 0 AND e.correct * 100 >= s.min_accuracy * e.total
                  AND CASE s.kind
                        WHEN 'flash' THEN e.activity_key LIKE 'flash:%'
                        WHEN 'excel' THEN e.activity_key LIKE 'jm:%'
                        WHEN 'memoriad' THEN e.activity_key LIKE 'mem:%'
                        ELSE e.source = 'result' AND EXISTS (
                          SELECT 1 FROM public.results r JOIN public.categories c ON c.id = r.category_id
                           WHERE r.id::text = e.source_id
                             AND c.section = CASE s.kind WHEN 'rounds' THEN 'round' ELSE 'basics' END)
                      END)
           END
         ) ORDER BY s.ord)
    INTO v_stages
    FROM public.journey_stages s WHERE s.level = v_level;

  RETURN jsonb_build_object(
    'level', v_level,
    'since', v_since,
    'stages', COALESCE(v_stages, '[]'::jsonb),
    'boss_attempts_today', (
      SELECT count(*) FROM public.journey_sessions j
       WHERE j.student_id = p_student AND j.kind = 'boss' AND j.level = v_level
         AND (j.started_at AT TIME ZONE 'Asia/Kolkata')::date = v_today),
    'boss_best', (
      SELECT jsonb_build_object('percent', j.percent, 'passed', j.passed, 'at', j.submitted_at)
        FROM public.journey_sessions j
       WHERE j.student_id = p_student AND j.kind = 'boss' AND j.level = v_level AND j.status = 'submitted'
       ORDER BY j.percent DESC, j.submitted_at DESC LIMIT 1),
    'flag', (
      SELECT jsonb_build_object('status', f.status, 'flagged_at', f.flagged_at, 'note', f.note)
        FROM public.journey_levelup_flags f WHERE f.student_id = p_student AND f.level = v_level)
  );
END;
$function$;

-- The journey page: progress, mascot and earned outfits.
CREATE OR REPLACE FUNCTION public.my_world(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_student, auth.uid());
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.xp_can_view(v_target) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  RETURN public.journey_progress_for(v_target) || jsonb_build_object(
    'mascot', (SELECT jsonb_build_object('kind', m.kind, 'equipped', m.equipped_item)
                 FROM public.student_mascots m WHERE m.student_id = v_target),
    'items', COALESCE((SELECT jsonb_agg(i.item_key ORDER BY i.earned_at)
                         FROM public.world_mascot_items i WHERE i.student_id = v_target), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_my_mascot(p_kind text, p_equipped text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_me AND role = 'student') THEN
    RAISE EXCEPTION 'Only students choose a mascot' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('owl', 'bot', 'dragon') THEN
    RAISE EXCEPTION 'Unknown mascot';
  END IF;
  IF p_equipped IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.world_mascot_items WHERE student_id = v_me AND item_key = p_equipped) THEN
    RAISE EXCEPTION 'You have not earned that outfit yet';
  END IF;
  INSERT INTO public.student_mascots (student_id, kind, equipped_item, updated_at)
  VALUES (v_me, p_kind, p_equipped, now())
  ON CONFLICT (student_id) DO UPDATE SET kind = EXCLUDED.kind, equipped_item = EXCLUDED.equipped_item, updated_at = now();
  RETURN jsonb_build_object('kind', p_kind, 'equipped', p_equipped);
END;
$function$;

-- Called by /api/journey (service role) before a boss round starts.
CREATE OR REPLACE FUNCTION public.journey_boss_check(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v jsonb := public.journey_progress_for(p_student);
  v_cleared integer;
  v_total integer;
BEGIN
  IF jsonb_array_length(v->'stages') = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Your teacher needs to set your level first.');
  END IF;
  SELECT count(*) FILTER (WHERE (s->>'done')::integer >= (s->>'rounds_needed')::integer), count(*)
    INTO v_cleared, v_total FROM jsonb_array_elements(v->'stages') s;
  IF v_cleared < LEAST(5, v_total) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Clear 5 stages on this island first.', 'level', v->>'level');
  END IF;
  IF (v->>'boss_attempts_today')::integer >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'You have tried the boss round 3 times today. Practise and come back tomorrow.', 'level', v->>'level');
  END IF;
  RETURN jsonb_build_object('ok', true, 'level', v->>'level');
END;
$function$;

-- Called by /api/journey (service role) to save a marked paper exactly once.
-- A passed boss round flags the student for a teacher (again, if a teacher said "not yet").
CREATE OR REPLACE FUNCTION public.journey_finish_session(p_session uuid, p_student uuid, p_answers jsonb,
                                                         p_correct integer, p_total integer, p_percent numeric,
                                                         p_passed boolean, p_by_type jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  j record;
BEGIN
  UPDATE public.journey_sessions
     SET status = 'submitted', submitted_at = now(), answers = p_answers, correct = p_correct,
         total = p_total, percent = p_percent, passed = p_passed, by_type = p_by_type
   WHERE id = p_session AND student_id = p_student AND status = 'open'
     AND now() <= expires_at + interval '2 minutes'
  RETURNING * INTO j;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'This round was already handed in or has run out of time.');
  END IF;
  IF j.kind = 'boss' AND j.passed THEN
    INSERT INTO public.journey_levelup_flags (student_id, level, session_id, percent)
    VALUES (j.student_id, j.level, j.id, j.percent)
    ON CONFLICT (student_id, level) DO UPDATE
      SET session_id = EXCLUDED.session_id, percent = GREATEST(journey_levelup_flags.percent, EXCLUDED.percent),
          flagged_at = now(), status = 'pending', reviewed_by = NULL, reviewed_at = NULL
      WHERE journey_levelup_flags.status = 'not_yet';
  END IF;
  RETURN jsonb_build_object('ok', true, 'kind', j.kind, 'level', j.level);
END;
$function$;

-- Teachers, centre heads, owners and directors: boss results and level-up flags of the students they can see.
CREATE OR REPLACE FUNCTION public.journey_staff_board(p_level text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'student') THEN
    RAISE EXCEPTION 'Staff only' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'flags', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'student_id', f.student_id, 'name', p.full_name, 'code', p.student_code,
               'level', f.level, 'current_level', p.level, 'percent', f.percent,
               'flagged_at', f.flagged_at, 'status', f.status, 'note', f.note, 'reviewed_at', f.reviewed_at
             ) ORDER BY (f.status = 'pending') DESC, f.flagged_at DESC)
        FROM public.journey_levelup_flags f JOIN public.profiles p ON p.id = f.student_id
       WHERE (p_level IS NULL OR f.level = p_level)
         AND (public.xp_can_view(f.student_id) OR public.is_centre_admin(p.centre_id))
    ), '[]'::jsonb),
    'attempts', COALESCE((
      SELECT jsonb_agg(a ORDER BY a.submitted_at DESC) FROM (
        SELECT j.student_id, p.full_name AS name, p.student_code AS code, j.level, j.percent, j.passed,
               j.correct, j.total, j.by_type, j.submitted_at
          FROM public.journey_sessions j JOIN public.profiles p ON p.id = j.student_id
         WHERE j.kind = 'boss' AND j.status = 'submitted'
           AND j.submitted_at > now() - interval '60 days'
           AND (p_level IS NULL OR j.level = p_level)
           AND (public.xp_can_view(j.student_id) OR public.is_centre_admin(p.centre_id))
         ORDER BY j.submitted_at DESC LIMIT 200
      ) a
    ), '[]'::jsonb)
  );
END;
$function$;

-- A teacher records a decision. Changing the official level is still done on the Students page.
CREATE OR REPLACE FUNCTION public.journey_levelup_review(p_student uuid, p_level text, p_status text, p_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_centre uuid;
BEGIN
  IF p_status NOT IN ('agreed', 'not_yet') THEN
    RAISE EXCEPTION 'Choose agreed or not yet';
  END IF;
  SELECT centre_id INTO v_centre FROM public.profiles WHERE id = p_student;
  IF auth.uid() IS NULL OR auth.uid() = p_student
     OR NOT (public.xp_can_view(p_student) OR public.is_centre_admin(v_centre)) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  UPDATE public.journey_levelup_flags
     SET status = p_status, note = NULLIF(btrim(COALESCE(p_note, '')), ''), reviewed_by = auth.uid(), reviewed_at = now()
   WHERE student_id = p_student AND level = p_level;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No level-up flag for this student';
  END IF;
END;
$function$;

-- 8. Grants ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.season_bounds(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.season_bounds(date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.xp_season_tier_for(bigint, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.xp_season_tier_for(bigint, integer, boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.xp_settle_seasons() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.xp_season_live(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_totals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_xp_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_xp_summary(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.season_list() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.season_save(text, text, date, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.season_cancel(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.season_board(text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.season_list(), public.season_save(text, text, date, text, integer),
  public.season_cancel(bigint), public.season_board(text, uuid, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.journey_progress_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.journey_boss_check(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.journey_finish_session(uuid, uuid, jsonb, integer, integer, numeric, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.journey_progress_for(uuid), public.journey_boss_check(uuid),
  public.journey_finish_session(uuid, uuid, jsonb, integer, integer, numeric, boolean, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.my_world(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_my_mascot(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.journey_staff_board(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.journey_levelup_review(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_world(uuid), public.set_my_mascot(text, text),
  public.journey_staff_board(text), public.journey_levelup_review(uuid, text, text, text) TO authenticated;
