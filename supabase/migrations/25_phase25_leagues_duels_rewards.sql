-- =============================================================================
-- Phase 25: gamification phase 3
--   1. Weekly leagues (5 tiers, groups of up to 20; top 5 move up, bottom 5 down)
--   2. Duels: two classmates play the same seeded 1-minute basics round
--   3. Class vs class: average weekly XP per student for every level
--   4. Reward shop: trainers list small real-world rewards; students spend XP
--      (spending never lowers XP, tier or leaderboard position)
--   5. New badges for leagues and duels
-- XP, ranks and winners are decided here, never in the browser.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. New badges
-- ---------------------------------------------------------------------------
INSERT INTO public.badge_catalogue (key, name, icon, description, category, sort_order) VALUES
  ('league_up',   'Moving up',        '⬆️', 'Get promoted to a higher league.',            'league', 80),
  ('league_top',  'Galaxy league',    '🚀', 'Reach the top league.',                        'league', 81),
  ('league_win',  'League winner',    '🏁', 'Finish a week first in your league group.',    'league', 82),
  ('duel_first',  'Duellist',         '⚔️', 'Finish your first duel.',                      'duel',   90),
  ('duel_win',    'Duel winner',      '🤺', 'Win a duel.',                                  'duel',   91),
  ('duel_win_10', 'Duel champion',    '🛡️', 'Win 10 duels.',                                'duel',   92)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, icon = EXCLUDED.icon, description = EXCLUDED.description,
      category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- 1. Leagues
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.league_tiers (
  tier smallint PRIMARY KEY CHECK (tier BETWEEN 1 AND 5),
  name text NOT NULL,
  icon text NOT NULL
);
INSERT INTO public.league_tiers (tier, name, icon) VALUES
  (1, 'Sprout', '🌱'),
  (2, 'Sapling', '🌿'),
  (3, 'Oak', '🌳'),
  (4, 'Summit', '🏔️'),
  (5, 'Galaxy', '🚀')
ON CONFLICT (tier) DO UPDATE SET name = EXCLUDED.name, icon = EXCLUDED.icon;

CREATE TABLE IF NOT EXISTS public.student_leagues (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tier smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.league_weeks (
  week_start date PRIMARY KEY,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.league_results (
  week_start date NOT NULL,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tier_before smallint NOT NULL,
  tier_after smallint NOT NULL,
  group_no integer NOT NULL,
  rank integer NOT NULL,
  group_size integer NOT NULL,
  xp bigint NOT NULL,
  PRIMARY KEY (week_start, student_id)
);
CREATE INDEX IF NOT EXISTS league_results_student_idx ON public.league_results (student_id, week_start DESC);

ALTER TABLE public.league_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS league_tiers_select ON public.league_tiers;
CREATE POLICY league_tiers_select ON public.league_tiers FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS student_leagues_select ON public.student_leagues;
CREATE POLICY student_leagues_select ON public.student_leagues
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
DROP POLICY IF EXISTS league_results_select ON public.league_results;
CREATE POLICY league_results_select ON public.league_results
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
REVOKE ALL ON public.league_tiers, public.student_leagues, public.league_weeks, public.league_results FROM anon, authenticated;
GRANT SELECT ON public.league_tiers, public.student_leagues, public.league_results TO authenticated;

-- Everyone who takes part in a week's leagues, with their group and week XP.
-- Groups: same tier (and same level when the global leaderboard is switched off),
-- split into groups of up to 20 in a fixed order for the week.
CREATE OR REPLACE FUNCTION public.league_members(p_week date)
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

-- Which way a ranked member is heading: 'up', 'down' or ''.
CREATE OR REPLACE FUNCTION public.league_zone(p_tier smallint, p_rank integer, p_size integer, p_xp bigint)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_tier < 5 AND p_rank <= 5 AND p_xp > 0 THEN 'up'
    WHEN p_tier > 1 AND (p_xp = 0 OR (p_size >= 15 AND p_rank > p_size - 5)) THEN 'down'
    ELSE ''
  END;
$function$;

-- Settles one completed week: records results and moves students between tiers.
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

-- Settles the last two completed weeks (cheap once settled).
CREATE OR REPLACE FUNCTION public.league_settle()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_week date := date_trunc('week', public.today_ist())::date;
BEGIN
  PERFORM public.league_settle_week(v_week - 14);
  PERFORM public.league_settle_week(v_week - 7);
END;
$function$;

-- League board for the caller's group this week. Staff pass p_tier to see every group of a tier.
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
           'avatar_path', g.av, 'zone', public.league_zone(v_tier, g.rk, g.sz, g.xp),
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

-- ---------------------------------------------------------------------------
-- 2. Duels (rows written by /api/drill with the service role)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.duels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  opponent_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text,
  category_id uuid NOT NULL,
  category_name text NOT NULL,
  seed bigint NOT NULL,
  seconds integer NOT NULL DEFAULT 60 CHECK (seconds BETWEEN 10 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined', 'cancelled', 'expired')),
  created_day date NOT NULL DEFAULT public.today_ist(),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '3 days',
  c_session_id uuid, c_started_at timestamptz, c_correct integer, c_total integer, c_time numeric, c_done_at timestamptz,
  o_session_id uuid, o_started_at timestamptz, o_correct integer, o_total integer, o_time numeric, o_done_at timestamptz,
  winner_id uuid,
  forfeit boolean NOT NULL DEFAULT false,
  finished_at timestamptz,
  CHECK (challenger_id <> opponent_id)
);
CREATE INDEX IF NOT EXISTS duels_challenger_idx ON public.duels (challenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS duels_opponent_idx ON public.duels (opponent_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS duels_one_open_pair_idx
  ON public.duels (LEAST(challenger_id, opponent_id), GREATEST(challenger_id, opponent_id))
  WHERE status = 'open';

ALTER TABLE public.duels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.duels FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.duels TO service_role;

-- Winner of a finished duel: more correct answers, then less time; equal is a draw.
CREATE OR REPLACE FUNCTION public.duel_winner(p_c uuid, p_cc integer, p_ct numeric, p_o uuid, p_oc integer, p_ot numeric)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN COALESCE(p_cc, 0) > COALESCE(p_oc, 0) THEN p_c
    WHEN COALESCE(p_oc, 0) > COALESCE(p_cc, 0) THEN p_o
    WHEN p_ct IS NOT NULL AND p_ot IS NOT NULL AND p_ct < p_ot THEN p_c
    WHEN p_ct IS NOT NULL AND p_ot IS NOT NULL AND p_ot < p_ct THEN p_o
    ELSE NULL
  END;
$function$;

-- Closes duels past their deadline. One side played: that side wins. Nobody played: expired.
CREATE OR REPLACE FUNCTION public.duel_expire()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.duels d
     SET status = CASE WHEN d.c_done_at IS NULL AND d.o_done_at IS NULL THEN 'expired' ELSE 'done' END,
         winner_id = CASE WHEN d.c_done_at IS NOT NULL AND d.o_done_at IS NULL THEN d.challenger_id
                          WHEN d.o_done_at IS NOT NULL AND d.c_done_at IS NULL THEN d.opponent_id END,
         forfeit = (d.c_done_at IS NULL) <> (d.o_done_at IS NULL),
         finished_at = now()
   WHERE d.status = 'open' AND d.expires_at < now();
$function$;

-- Records one side's finished round; decides the duel when both have played.
CREATE OR REPLACE FUNCTION public.duel_record_result(
  p_duel uuid, p_student uuid, p_session uuid, p_correct integer, p_total integer, p_time numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d public.duels%ROWTYPE;
BEGIN
  SELECT * INTO d FROM public.duels WHERE id = p_duel FOR UPDATE;
  IF NOT FOUND OR d.status <> 'open' THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  IF d.challenger_id = p_student AND d.c_session_id = p_session AND d.c_done_at IS NULL THEN
    UPDATE public.duels SET c_correct = p_correct, c_total = p_total, c_time = p_time, c_done_at = now()
     WHERE id = p_duel RETURNING * INTO d;
  ELSIF d.opponent_id = p_student AND d.o_session_id = p_session AND d.o_done_at IS NULL THEN
    UPDATE public.duels SET o_correct = p_correct, o_total = p_total, o_time = p_time, o_done_at = now()
     WHERE id = p_duel RETURNING * INTO d;
  ELSE
    RETURN jsonb_build_object('recorded', false);
  END IF;

  IF d.c_done_at IS NOT NULL AND d.o_done_at IS NOT NULL THEN
    UPDATE public.duels
       SET status = 'done', finished_at = now(),
           winner_id = public.duel_winner(d.challenger_id, d.c_correct, d.c_time, d.opponent_id, d.o_correct, d.o_time)
     WHERE id = p_duel RETURNING * INTO d;
  END IF;
  RETURN jsonb_build_object('recorded', true, 'status', d.status, 'winner_id', d.winner_id);
END;
$function$;

-- Badges when a duel finishes.
CREATE OR REPLACE FUNCTION public.trg_duel_badges()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'done' AND OLD.status IS DISTINCT FROM 'done' THEN
    INSERT INTO public.student_badges (student_id, badge_key)
    SELECT s, 'duel_first' FROM unnest(ARRAY[
      CASE WHEN NEW.c_done_at IS NOT NULL THEN NEW.challenger_id END,
      CASE WHEN NEW.o_done_at IS NOT NULL THEN NEW.opponent_id END]) AS s
     WHERE s IS NOT NULL
    ON CONFLICT DO NOTHING;
    IF NEW.winner_id IS NOT NULL THEN
      INSERT INTO public.student_badges (student_id, badge_key)
      VALUES (NEW.winner_id, 'duel_win') ON CONFLICT DO NOTHING;
      IF (SELECT count(*) FROM public.duels WHERE winner_id = NEW.winner_id AND status = 'done') >= 10 THEN
        INSERT INTO public.student_badges (student_id, badge_key)
        VALUES (NEW.winner_id, 'duel_win_10') ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_duel_badges ON public.duels;
CREATE TRIGGER trg_duel_badges AFTER UPDATE OF status ON public.duels
  FOR EACH ROW EXECUTE FUNCTION public.trg_duel_badges();

-- Who the caller can challenge (same level) and which categories.
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

-- The caller's duels: open ones and the last 30 days. The other side's score stays hidden
-- until the caller has played.
CREATE OR REPLACE FUNCTION public.my_duels()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM public.duel_expire();
  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.open DESC, x.created_at DESC)
      FROM (
        SELECT d.status = 'open' AS open, d.created_at,
               jsonb_build_object(
                 'id', d.id,
                 'role', CASE WHEN d.challenger_id = v_me THEN 'challenger' ELSE 'opponent' END,
                 'other_name', public.display_name_for(o.full_name, o.student_code),
                 'other_avatar', public.avatar_visible(o.id, o.avatar_path),
                 'category_name', d.category_name,
                 'seconds', d.seconds,
                 'status', d.status,
                 'forfeit', d.forfeit,
                 'created_at', d.created_at,
                 'expires_at', d.expires_at,
                 'my_started', (CASE WHEN d.challenger_id = v_me THEN d.c_started_at ELSE d.o_started_at END) IS NOT NULL,
                 'my_done', (CASE WHEN d.challenger_id = v_me THEN d.c_done_at ELSE d.o_done_at END) IS NOT NULL,
                 'my_correct', CASE WHEN d.challenger_id = v_me THEN d.c_correct ELSE d.o_correct END,
                 'my_total', CASE WHEN d.challenger_id = v_me THEN d.c_total ELSE d.o_total END,
                 'my_time', CASE WHEN d.challenger_id = v_me THEN d.c_time ELSE d.o_time END,
                 'other_done', (CASE WHEN d.challenger_id = v_me THEN d.o_done_at ELSE d.c_done_at END) IS NOT NULL,
                 'other_correct', CASE WHEN (CASE WHEN d.challenger_id = v_me THEN d.c_done_at ELSE d.o_done_at END) IS NOT NULL
                                             OR d.status <> 'open'
                                       THEN CASE WHEN d.challenger_id = v_me THEN d.o_correct ELSE d.c_correct END END,
                 'other_total', CASE WHEN (CASE WHEN d.challenger_id = v_me THEN d.c_done_at ELSE d.o_done_at END) IS NOT NULL
                                           OR d.status <> 'open'
                                     THEN CASE WHEN d.challenger_id = v_me THEN d.o_total ELSE d.c_total END END,
                 'other_time', CASE WHEN (CASE WHEN d.challenger_id = v_me THEN d.c_done_at ELSE d.o_done_at END) IS NOT NULL
                                          OR d.status <> 'open'
                                    THEN CASE WHEN d.challenger_id = v_me THEN d.o_time ELSE d.c_time END END,
                 'result', CASE WHEN d.status <> 'done' THEN NULL
                                WHEN d.winner_id IS NULL THEN 'draw'
                                WHEN d.winner_id = v_me THEN 'won' ELSE 'lost' END
               ) AS j
          FROM public.duels d
          JOIN public.profiles o ON o.id = CASE WHEN d.challenger_id = v_me THEN d.opponent_id ELSE d.challenger_id END
         WHERE (d.challenger_id = v_me OR d.opponent_id = v_me)
           AND (d.status = 'open' OR d.created_at > now() - interval '30 days')
         ORDER BY d.created_at DESC
         LIMIT 40
      ) x
  ), '[]'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Class vs class: every level's average XP per student for a period
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.class_vs_class(p_period text DEFAULT 'week')
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

-- ---------------------------------------------------------------------------
-- 4. Reward shop
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reward_items (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  icon text NOT NULL DEFAULT '🎁' CHECK (char_length(icon) BETWEEN 1 AND 8),
  description text CHECK (description IS NULL OR char_length(description) <= 140),
  cost integer NOT NULL CHECK (cost BETWEEN 1 AND 1000000),
  stock integer CHECK (stock IS NULL OR stock >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id bigint REFERENCES public.reward_items(id) ON DELETE SET NULL,
  item_name text NOT NULL,
  item_icon text NOT NULL DEFAULT '🎁',
  cost integer NOT NULL CHECK (cost > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'given', 'rejected', 'cancelled')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 140)
);
CREATE INDEX IF NOT EXISTS reward_redemptions_student_idx ON public.reward_redemptions (student_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS reward_redemptions_status_idx ON public.reward_redemptions (status, requested_at);

ALTER TABLE public.reward_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reward_items_select ON public.reward_items;
CREATE POLICY reward_items_select ON public.reward_items FOR SELECT TO authenticated USING (active OR public.is_admin());
DROP POLICY IF EXISTS reward_redemptions_select ON public.reward_redemptions;
CREATE POLICY reward_redemptions_select ON public.reward_redemptions
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
REVOKE ALL ON public.reward_items, public.reward_redemptions FROM anon, authenticated;
GRANT SELECT ON public.reward_items, public.reward_redemptions TO authenticated;

-- XP earned, XP spent (requests waiting or rewards given) and what is left to spend.
CREATE OR REPLACE FUNCTION public.reward_balance(p_student uuid)
 RETURNS TABLE(earned bigint, spent bigint, balance bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.v, s.v, e.v - s.v
    FROM (SELECT COALESCE(sum(xp), 0)::bigint AS v FROM public.student_xp_events WHERE student_id = p_student) e,
         (SELECT COALESCE(sum(cost), 0)::bigint AS v FROM public.reward_redemptions
           WHERE student_id = p_student AND status IN ('requested', 'given')) s;
$function$;

CREATE OR REPLACE FUNCTION public.reward_shop(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_target uuid := COALESCE(p_student, auth.uid());
  b record;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT public.xp_can_view(v_target) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  SELECT * INTO b FROM public.reward_balance(v_target);
  RETURN jsonb_build_object(
    'can_request', v_target = v_me,
    'earned', b.earned, 'spent', b.spent, 'balance', b.balance,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'icon', i.icon,
                         'description', i.description, 'cost', i.cost, 'stock', i.stock) ORDER BY i.cost, i.name)
                         FROM public.reward_items i WHERE i.active), '[]'::jsonb),
    'redemptions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.item_name, 'icon', r.item_icon,
                               'cost', r.cost, 'status', r.status, 'requested_at', r.requested_at,
                               'decided_at', r.decided_at, 'note', r.note) ORDER BY r.requested_at DESC)
                               FROM (SELECT * FROM public.reward_redemptions WHERE student_id = v_target
                                      ORDER BY requested_at DESC LIMIT 20) r), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reward_request(p_item bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  i public.reward_items%ROWTYPE;
  b record;
  v_id bigint;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  -- One request at a time per student (the profile row is the lock).
  PERFORM 1 FROM public.profiles WHERE id = v_me AND role = 'student' AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only students can ask for rewards.'; END IF;
  SELECT * INTO i FROM public.reward_items WHERE id = p_item FOR UPDATE;
  IF NOT FOUND OR NOT i.active THEN RAISE EXCEPTION 'This reward is not available.'; END IF;
  IF i.stock IS NOT NULL AND i.stock <= 0 THEN RAISE EXCEPTION 'This reward is out of stock.'; END IF;
  IF (SELECT count(*) FROM public.reward_redemptions WHERE student_id = v_me AND status = 'requested') >= 3 THEN
    RAISE EXCEPTION 'You already have 3 requests waiting. Collect them from your trainer first.';
  END IF;
  SELECT * INTO b FROM public.reward_balance(v_me);
  IF b.balance < i.cost THEN RAISE EXCEPTION 'You need % more XP for this reward.', i.cost - b.balance; END IF;

  INSERT INTO public.reward_redemptions (student_id, item_id, item_name, item_icon, cost)
  VALUES (v_me, i.id, i.name, i.icon, i.cost) RETURNING id INTO v_id;
  IF i.stock IS NOT NULL THEN
    UPDATE public.reward_items SET stock = stock - 1, updated_at = now() WHERE id = i.id;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'balance', b.balance - i.cost);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reward_cancel(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item bigint;
BEGIN
  UPDATE public.reward_redemptions SET status = 'cancelled', decided_at = now(), decided_by = auth.uid()
   WHERE id = p_id AND student_id = auth.uid() AND status = 'requested'
  RETURNING item_id INTO v_item;
  IF NOT FOUND THEN RAISE EXCEPTION 'This request cannot be cancelled.'; END IF;
  UPDATE public.reward_items SET stock = stock + 1, updated_at = now() WHERE id = v_item AND stock IS NOT NULL;
END;
$function$;

-- Admin: every item and the latest requests.
CREATE OR REPLACE FUNCTION public.reward_admin()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'icon', i.icon,
                         'description', i.description, 'cost', i.cost, 'stock', i.stock, 'active', i.active,
                         'given', (SELECT count(*) FROM public.reward_redemptions r WHERE r.item_id = i.id AND r.status = 'given'))
                         ORDER BY i.active DESC, i.cost, i.name) FROM public.reward_items i), '[]'::jsonb),
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'student_id', r.student_id,
                            'student_name', p.full_name, 'student_code', p.student_code, 'level', p.level,
                            'name', r.item_name, 'icon', r.item_icon, 'cost', r.cost, 'status', r.status,
                            'requested_at', r.requested_at, 'decided_at', r.decided_at, 'note', r.note)
                            ORDER BY (r.status = 'requested') DESC, r.requested_at DESC)
                            FROM (SELECT * FROM public.reward_redemptions
                                   WHERE status = 'requested' OR requested_at > now() - interval '60 days'
                                   ORDER BY requested_at DESC LIMIT 200) r
                            JOIN public.profiles p ON p.id = r.student_id), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reward_item_save(
  p_id bigint, p_name text, p_icon text, p_description text, p_cost integer, p_stock integer, p_active boolean)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id bigint;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.reward_items (name, icon, description, cost, stock, active)
    VALUES (btrim(p_name), COALESCE(NULLIF(btrim(p_icon), ''), '🎁'), NULLIF(btrim(p_description), ''),
            p_cost, p_stock, COALESCE(p_active, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.reward_items
       SET name = btrim(p_name), icon = COALESCE(NULLIF(btrim(p_icon), ''), '🎁'),
           description = NULLIF(btrim(p_description), ''), cost = p_cost, stock = p_stock,
           active = COALESCE(p_active, true), updated_at = now()
     WHERE id = p_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Reward not found.'; END IF;
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reward_decide(p_id bigint, p_status text, p_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item bigint;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('given', 'rejected') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  UPDATE public.reward_redemptions
     SET status = p_status, decided_at = now(), decided_by = auth.uid(), note = NULLIF(btrim(p_note), '')
   WHERE id = p_id AND status = 'requested'
  RETURNING item_id INTO v_item;
  IF NOT FOUND THEN RAISE EXCEPTION 'This request was already handled.'; END IF;
  IF p_status = 'rejected' THEN
    UPDATE public.reward_items SET stock = stock + 1, updated_at = now() WHERE id = v_item AND stock IS NOT NULL;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. One call for the student home "Arena" card
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.arena_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_league jsonb;
  v_me_row jsonb;
  b record;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  v_league := public.league_board(NULL);
  SELECT r INTO v_me_row FROM jsonb_array_elements(COALESCE(v_league -> 'rows', '[]'::jsonb)) r
   WHERE (r ->> 'is_me')::boolean LIMIT 1;
  SELECT * INTO b FROM public.reward_balance(v_me);
  RETURN jsonb_build_object(
    'league', CASE WHEN COALESCE((v_league ->> 'member')::boolean, false) THEN jsonb_build_object(
                'tier', v_league -> 'tier',
                'name', (SELECT t.name FROM public.league_tiers t WHERE t.tier = (v_league ->> 'tier')::smallint),
                'icon', (SELECT t.icon FROM public.league_tiers t WHERE t.tier = (v_league ->> 'tier')::smallint),
                'rank', v_me_row -> 'rank',
                'zone', v_me_row -> 'zone',
                'size', jsonb_array_length(COALESCE(v_league -> 'rows', '[]'::jsonb)),
                'last', v_league -> 'last') END,
    'duels_to_play', (SELECT count(*) FROM public.duels d
                       WHERE d.status = 'open' AND d.expires_at > now()
                         AND ((d.challenger_id = v_me AND d.c_started_at IS NULL)
                           OR (d.opponent_id = v_me AND d.o_started_at IS NULL))),
    'reward_balance', b.balance,
    'rewards_available', (SELECT count(*) FROM public.reward_items i WHERE i.active AND (i.stock IS NULL OR i.stock > 0))
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.league_members(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.league_settle_week(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.league_settle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.duel_expire() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.duel_record_result(uuid, uuid, uuid, integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_duel_badges() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reward_balance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.duel_record_result(uuid, uuid, uuid, integer, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.duel_expire() TO service_role;

REVOKE ALL ON FUNCTION public.league_board(smallint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.duel_options() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_duels() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.class_vs_class(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_shop(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_request(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_cancel(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_item_save(bigint, text, text, text, integer, integer, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reward_decide(bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.arena_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.league_board(smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.duel_options() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_duels() TO authenticated;
GRANT EXECUTE ON FUNCTION public.class_vs_class(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_shop(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_request(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_cancel(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_item_save(bigint, text, text, text, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reward_decide(bigint, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.arena_summary() TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reward_items, public.reward_redemptions,
  public.student_leagues, public.league_results, public.league_weeks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.reward_items_id_seq, public.reward_redemptions_id_seq TO service_role;
