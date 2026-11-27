-- =============================================================================
-- Phase 24: gamification phase 2 - profiles with photos, badges, daily challenge,
-- Star of the Month and Champion of the week.
--
--   * profiles.avatar_path / motto / favourite_practice, changed only through RPCs.
--     Photos live in the private 'avatars' storage bucket (<user id>/<file>), 512 KB max.
--   * badge_catalogue + student_badges, awarded by the database (badges_award) when a
--     round earns XP, and on profile load for streak / challenge / award badges.
--   * xp_awards: top weekly and monthly XP per level, settled for completed periods.
--   * daily_challenge_attempts: one attempt per student per day, written by /api/drill
--     with the service role; daily_challenge_board ranks the caller's level.
--   * leaderboard() also returns avatar_path (hidden when names are shown as codes).
--   * xp_round_summary_for() also returns the badges a round unlocked.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Profile fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS motto text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS favourite_practice text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_avatar_path_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_avatar_path_check
  CHECK (avatar_path IS NULL OR avatar_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$');
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_motto_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_motto_check
  CHECK (motto IS NULL OR char_length(motto) <= 60);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_favourite_practice_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_favourite_practice_check
  CHECK (favourite_practice IS NULL OR favourite_practice IN ('basics', 'flash', 'elements', 'memoriad', 'main_round', 'oral'));

-- ---------------------------------------------------------------------------
-- 2. Avatar storage: private bucket, own folder only, admins may delete any photo
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 524288, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS avatars_select_signed_in ON storage.objects;
CREATE POLICY avatars_select_signed_in ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars');

DROP POLICY IF EXISTS avatars_insert_own ON storage.objects;
CREATE POLICY avatars_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS avatars_delete_own_or_admin ON storage.objects;
CREATE POLICY avatars_delete_own_or_admin ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_admin()));

-- Who may see a student's photo next to their name: staff, the student, and other
-- students unless the leaderboard shows codes instead of names.
CREATE OR REPLACE FUNCTION public.avatar_visible(p_student uuid, p_path text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_path IS NULL OR auth.uid() IS NULL THEN NULL
    WHEN p_student = auth.uid() OR public.is_admin() OR public.is_teacher(auth.uid()) THEN p_path
    WHEN (SELECT r.leaderboard_names FROM public.competition_rules() r) = 'student_code' THEN NULL
    ELSE p_path
  END;
$function$;

-- Staff who look after a student's profile (remove a photo).
CREATE OR REPLACE FUNCTION public.profile_can_moderate(p_student uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
    public.is_admin()
    OR (
      public.is_teacher(auth.uid())
      AND public.is_teacher_assigned_to_student(auth.uid(), p_student)
      AND public.has_teacher_permission(auth.uid(), 'view_students')
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.set_my_profile(p_motto text, p_favourite text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_motto text := NULLIF(btrim(regexp_replace(COALESCE(p_motto, ''), '[[:cntrl:]]', ' ', 'g')), '');
  v_fav text := NULLIF(btrim(COALESCE(p_favourite, '')), '');
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_motto IS NOT NULL AND char_length(v_motto) > 60 THEN
    RAISE EXCEPTION 'Keep your motto to 60 characters or fewer.';
  END IF;
  IF v_fav IS NOT NULL AND v_fav NOT IN ('basics', 'flash', 'elements', 'memoriad', 'main_round', 'oral') THEN
    RAISE EXCEPTION 'Unknown practice.';
  END IF;
  UPDATE public.profiles SET motto = v_motto, favourite_practice = v_fav WHERE id = v_me;
  RETURN jsonb_build_object('motto', v_motto, 'favourite_practice', v_fav);
END;
$function$;

-- Points the caller's profile at a photo already uploaded to avatars/<uid>/...
-- Returns the previous path so the browser can delete the old file.
CREATE OR REPLACE FUNCTION public.set_my_avatar(p_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_old text;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_path IS NULL OR p_path !~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$'
     OR split_part(p_path, '/', 1) <> v_me::text THEN
    RAISE EXCEPTION 'Invalid photo.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'avatars' AND o.name = p_path) THEN
    RAISE EXCEPTION 'Photo upload not found. Please try again.';
  END IF;
  SELECT avatar_path INTO v_old FROM public.profiles WHERE id = v_me;
  UPDATE public.profiles SET avatar_path = p_path, avatar_updated_at = now() WHERE id = v_me;
  RETURN jsonb_build_object('avatar_path', p_path, 'old_path', NULLIF(v_old, p_path));
END;
$function$;

-- Removes a photo: the student themself, an admin, or their teacher (View students).
CREATE OR REPLACE FUNCTION public.clear_avatar(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target uuid := COALESCE(p_student, auth.uid());
  v_old text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_target <> auth.uid() AND NOT public.profile_can_moderate(v_target) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT avatar_path INTO v_old FROM public.profiles WHERE id = v_target;
  UPDATE public.profiles SET avatar_path = NULL, avatar_updated_at = now() WHERE id = v_target;
  RETURN jsonb_build_object('old_path', v_old);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Badges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.badge_catalogue (
  key text PRIMARY KEY,
  name text NOT NULL,
  icon text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE public.badge_catalogue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS badge_catalogue_select ON public.badge_catalogue;
CREATE POLICY badge_catalogue_select ON public.badge_catalogue FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.badge_catalogue FROM anon, authenticated;
GRANT SELECT ON public.badge_catalogue TO authenticated;

INSERT INTO public.badge_catalogue (key, name, icon, description, category, sort_order) VALUES
  ('first_round',     'First steps',          '👣', 'Finish your first round.',                                  'practice', 10),
  ('rounds_10',       'Warming up',           '🔟', 'Finish 10 rounds.',                                         'practice', 11),
  ('rounds_100',      'Century',              '💯', 'Finish 100 rounds.',                                        'practice', 12),
  ('rounds_500',      'Practice machine',     '⚙️', 'Finish 500 rounds.',                                        'practice', 13),
  ('rounds_1000',     'Thousand club',        '🏛️', 'Finish 1,000 rounds.',                                      'practice', 14),
  ('big_day',         'Big day',              '☀️', 'Earn 500 XP in one day.',                                   'practice', 15),
  ('explorer',        'Explorer',             '🧭', 'Practise 4 kinds of event: basics, Flash, elements, Memoriad or main round.', 'practice', 16),
  ('perfect_first',   'Perfect!',             '🎯', 'Get every answer right in a round of 10 or more.',          'accuracy', 20),
  ('perfect_25',      'Sharpshooter',         '🏹', 'Get 25 perfect rounds of 10 or more.',                      'accuracy', 21),
  ('flash_perfect',   'Flash perfect',        '⚡', 'Answer every Flash Anzan sum correctly.',                   'accuracy', 22),
  ('memoriad_all',    'Memoriad all-rounder', '🧠', 'Practise all 4 Memoriad events.',                           'accuracy', 23),
  ('pb_first',        'New record',           '📈', 'Beat one of your personal bests.',                          'improvement', 30),
  ('pb_10',           'Record breaker',       '🚀', 'Beat your personal bests 10 times.',                        'improvement', 31),
  ('pb_50',           'Unstoppable',          '🌋', 'Beat your personal bests 50 times.',                        'improvement', 32),
  ('streak_3',        'On a roll',            '🔥', 'Reach a 3-day streak.',                                     'streak', 40),
  ('streak_7',        'One-week streak',      '📅', 'Reach a 7-day streak.',                                     'streak', 41),
  ('streak_30',       'Monthly habit',        '🗓️', 'Reach a 30-day streak.',                                    'streak', 42),
  ('streak_100',      'Hundred days',         '💎', 'Reach a 100-day streak.',                                   'streak', 43),
  ('challenge_first', 'Challenger',           '🎲', 'Play your first daily challenge.',                          'challenge', 50),
  ('challenge_7',     'Challenge regular',    '🎟️', 'Play 7 daily challenges.',                                  'challenge', 51),
  ('challenge_30',    'Challenge master',     '🏅', 'Play 30 daily challenges.',                                 'challenge', 52),
  ('challenge_win',   'Challenge winner',     '🥇', 'Top your level in a daily challenge with 2 or more players.', 'challenge', 53),
  ('tier_silver',     'Silver rank',          '🥈', 'Reach 1,000 XP.',                                           'rank', 60),
  ('tier_gold',       'Gold rank',            '🥇', 'Reach 3,000 XP.',                                           'rank', 61),
  ('tier_platinum',   'Platinum rank',        '💠', 'Reach 7,500 XP.',                                           'rank', 62),
  ('tier_diamond',    'Diamond rank',         '💎', 'Reach 15,000 XP.',                                          'rank', 63),
  ('tier_master',     'Master rank',          '👑', 'Reach 30,000 XP.',                                          'rank', 64),
  ('tier_legend',     'Legend rank',          '🌟', 'Reach 75,000 XP.',                                          'rank', 65),
  ('week_champion',   'Champion of the week', '🏆', 'Earn the most XP in your level in a week.',                 'award', 70),
  ('star_month',      'Star of the Month',    '⭐', 'Earn the most XP in your level in a month.',                'award', 71)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, icon = EXCLUDED.icon, description = EXCLUDED.description,
      category = EXCLUDED.category, sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS public.student_badges (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  badge_key text NOT NULL REFERENCES public.badge_catalogue(key) ON DELETE CASCADE,
  earned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, badge_key)
);
CREATE INDEX IF NOT EXISTS student_badges_earned_idx ON public.student_badges (student_id, earned_at DESC);

ALTER TABLE public.student_badges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS student_badges_select ON public.student_badges;
CREATE POLICY student_badges_select ON public.student_badges
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
REVOKE ALL ON public.student_badges FROM anon, authenticated;
GRANT SELECT ON public.student_badges TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Weekly and monthly XP awards (Champion of the week, Star of the Month)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.xp_award_periods (
  kind text NOT NULL CHECK (kind IN ('week', 'month')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period_start)
);

CREATE TABLE IF NOT EXISTS public.xp_awards (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('week', 'month')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  level text,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  xp bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS xp_awards_unique_idx
  ON public.xp_awards (kind, period_start, COALESCE(level, ''), student_id);
CREATE INDEX IF NOT EXISTS xp_awards_student_idx ON public.xp_awards (student_id);

ALTER TABLE public.xp_award_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xp_awards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS xp_awards_select ON public.xp_awards;
CREATE POLICY xp_awards_select ON public.xp_awards
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
REVOKE ALL ON public.xp_award_periods FROM anon, authenticated;
REVOKE ALL ON public.xp_awards FROM anon, authenticated;
GRANT SELECT ON public.xp_awards TO authenticated;

-- Records the top XP student(s) of every level for one completed period.
CREATE OR REPLACE FUNCTION public.xp_settle_period(p_kind text, p_from date, p_to date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_to >= public.today_ist() THEN
    RETURN; -- only completed periods
  END IF;
  INSERT INTO public.xp_award_periods (kind, period_start, period_end)
  VALUES (p_kind, p_from, p_to)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN; -- already settled
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

-- Settles the last two completed weeks and months (cheap once settled).
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
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Daily challenge attempts (written by /api/drill with the service role)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_challenge_attempts (
  id bigserial PRIMARY KEY,
  day date NOT NULL,
  level text,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  category_name text NOT NULL,
  seconds integer NOT NULL,
  session_id uuid,
  result_id uuid,
  correct integer,
  total integer,
  time_seconds numeric,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  UNIQUE (day, student_id)
);
CREATE INDEX IF NOT EXISTS daily_challenge_attempts_board_idx
  ON public.daily_challenge_attempts (day, level) WHERE submitted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS daily_challenge_attempts_student_idx
  ON public.daily_challenge_attempts (student_id, day DESC);

ALTER TABLE public.daily_challenge_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS daily_challenge_attempts_select ON public.daily_challenge_attempts;
CREATE POLICY daily_challenge_attempts_select ON public.daily_challenge_attempts
  FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
REVOKE ALL ON public.daily_challenge_attempts FROM anon, authenticated;
GRANT SELECT ON public.daily_challenge_attempts TO authenticated;

-- Online basics categories this level has practised recently (the API picks one per day).
CREATE OR REPLACE FUNCTION public.daily_challenge_candidates(p_level text)
 RETURNS TABLE(category_id uuid, name text, students bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.name, count(DISTINCT r.student_id)
    FROM public.results r
    JOIN public.profiles p ON p.id = r.student_id
    JOIN public.categories c ON c.id = r.category_id
   WHERE c.section = 'basics' AND c.active
     AND r.source = 'site' AND r.total > 0
     AND r.entry_date > public.today_ist() - 60
     AND p.role = 'student' AND p.active
     AND p.level IS NOT DISTINCT FROM p_level
   GROUP BY c.id, c.name
   ORDER BY c.id;
$function$;

-- The caller's level board for one day (default today). Admins pass p_level.
CREATE OR REPLACE FUNCTION public.daily_challenge_board(p_day date DEFAULT NULL, p_level text DEFAULT NULL)
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

-- ---------------------------------------------------------------------------
-- 6. Awarding badges
-- ---------------------------------------------------------------------------
-- p_full also checks the slower sources: streaks, daily challenges and XP awards.
CREATE OR REPLACE FUNCTION public.badges_award(p_student uuid, p_full boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s record;
  v_best_day bigint;
  v_keys text[] := ARRAY[]::text[];
  v_best_streak integer := 0;
  v_played integer := 0;
  v_wins integer := 0;
  v_n integer;
BEGIN
  IF p_student IS NULL THEN RETURN 0; END IF;

  SELECT count(*) AS rounds,
         COALESCE(sum(xp), 0) AS total_xp,
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
  IF s.total_xp >= 1000 THEN v_keys := array_append(v_keys, 'tier_silver'); END IF;
  IF s.total_xp >= 3000 THEN v_keys := array_append(v_keys, 'tier_gold'); END IF;
  IF s.total_xp >= 7500 THEN v_keys := array_append(v_keys, 'tier_platinum'); END IF;
  IF s.total_xp >= 15000 THEN v_keys := array_append(v_keys, 'tier_diamond'); END IF;
  IF s.total_xp >= 30000 THEN v_keys := array_append(v_keys, 'tier_master'); END IF;
  IF s.total_xp >= 75000 THEN v_keys := array_append(v_keys, 'tier_legend'); END IF;

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

-- Every new XP event checks the quick badges. Never blocks saving a score.
CREATE OR REPLACE FUNCTION public.trg_badges_on_xp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  BEGIN
    PERFORM public.badges_award(NEW.student_id, false);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'badges_award failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_badges_on_xp ON public.student_xp_events;
CREATE TRIGGER trg_badges_on_xp
  AFTER INSERT ON public.student_xp_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_badges_on_xp();

-- ---------------------------------------------------------------------------
-- 7. Star of the Month / Champion of the week for the caller's level
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.star_of_month(p_level text DEFAULT NULL)
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

-- ---------------------------------------------------------------------------
-- 8. The profile page: who, XP, badges, awards, challenge record and this week
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_profile(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_target uuid := COALESCE(p_student, auth.uid());
  v_p record;
  v_from date;
  v_to date;
  v_out jsonb;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.xp_can_view(v_target) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  SELECT id, full_name, student_code, level, role, created_at, motto, favourite_practice, avatar_path
    INTO v_p FROM public.profiles WHERE id = v_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  BEGIN
    PERFORM public.xp_settle_awards();
    PERFORM public.badges_award(v_target, true);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'profile awards failed: %', SQLERRM;
  END;

  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds('week') b;

  v_out := public.my_xp_summary(v_target);

  RETURN v_out || jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_p.id,
      'full_name', v_p.full_name,
      'student_code', v_p.student_code,
      'level', v_p.level,
      'role', v_p.role,
      'joined', v_p.created_at,
      'motto', v_p.motto,
      'favourite_practice', v_p.favourite_practice,
      'avatar_path', v_p.avatar_path
    ),
    'can_edit', v_target = v_me,
    'can_moderate', v_target <> v_me AND public.profile_can_moderate(v_target),
    'rounds_total', (SELECT count(*) FROM public.student_xp_events WHERE student_id = v_target),
    'pb_total', (SELECT count(*) FROM public.student_xp_events
                  WHERE student_id = v_target AND is_personal_best AND NOT first_best),
    'badges', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.key, 'name', c.name, 'icon', c.icon, 'description', c.description,
               'category', c.category, 'earned_at', b.earned_at) ORDER BY c.sort_order)
        FROM public.badge_catalogue c
        LEFT JOIN public.student_badges b ON b.badge_key = c.key AND b.student_id = v_target
    ), '[]'::jsonb),
    'awards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'kind', a.kind, 'from', a.period_start, 'to', a.period_end, 'level', a.level, 'xp', a.xp)
               ORDER BY a.period_start DESC, a.kind)
        FROM public.xp_awards a WHERE a.student_id = v_target
    ), '[]'::jsonb),
    'challenge', jsonb_build_object(
      'played', (SELECT count(*) FROM public.daily_challenge_attempts
                  WHERE student_id = v_target AND submitted_at IS NOT NULL),
      'recent', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'day', a.day, 'name', a.category_name, 'correct', a.correct, 'total', a.total,
                 'time_seconds', a.time_seconds) ORDER BY a.day DESC)
          FROM (SELECT * FROM public.daily_challenge_attempts
                 WHERE student_id = v_target AND submitted_at IS NOT NULL
                 ORDER BY day DESC LIMIT 5) a
      ), '[]'::jsonb)
    ),
    'week', jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'rounds', (SELECT count(*) FROM public.student_xp_events
                  WHERE student_id = v_target AND day BETWEEN v_from AND v_to),
      'practice_days', (SELECT count(DISTINCT day) FROM public.student_xp_events
                         WHERE student_id = v_target AND day BETWEEN v_from AND v_to),
      'correct', (SELECT COALESCE(sum(correct), 0) FROM public.student_xp_events
                   WHERE student_id = v_target AND day BETWEEN v_from AND v_to),
      'total', (SELECT COALESCE(sum(total), 0) FROM public.student_xp_events
                 WHERE student_id = v_target AND day BETWEEN v_from AND v_to),
      'new_bests', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('label', e.label, 'score', e.score_label) ORDER BY e.created_at DESC)
          FROM (SELECT * FROM public.student_xp_events
                 WHERE student_id = v_target AND day BETWEEN v_from AND v_to
                   AND is_personal_best AND NOT first_best
                 ORDER BY created_at DESC LIMIT 5) e
      ), '[]'::jsonb),
      'new_badges', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', c.name, 'icon', c.icon) ORDER BY b.earned_at DESC)
          FROM public.student_badges b JOIN public.badge_catalogue c ON c.key = b.badge_key
         WHERE b.student_id = v_target
           AND (b.earned_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN v_from AND v_to
      ), '[]'::jsonb)
    )
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. End-of-round card: also list the badges this round unlocked
-- ---------------------------------------------------------------------------
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
  ), 'new_badges', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name', c.name, 'icon', c.icon, 'description', c.description)
                     ORDER BY c.sort_order)
      FROM public.student_badges b JOIN public.badge_catalogue c ON c.key = b.badge_key
     WHERE b.student_id = v_me
       AND b.earned_at BETWEEN v_ev.created_at - interval '1 second' AND v_ev.created_at + interval '5 seconds'
  ), '[]'::jsonb)) || public.xp_totals(v_me);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Leaderboard rows also carry the student's photo (when allowed)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.leaderboard(text, text, text, integer, text);

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

-- ---------------------------------------------------------------------------
-- 11. Grants: internal helpers stay private; page RPCs for signed-in users
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.leaderboard(text, text, text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard(text, text, text, integer, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.avatar_visible(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profile_can_moderate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_settle_period(text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.xp_settle_awards() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.badges_award(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_badges_on_xp() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_challenge_candidates(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_challenge_candidates(text) TO service_role;

REVOKE ALL ON FUNCTION public.set_my_profile(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_my_avatar(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_avatar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.daily_challenge_board(date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.star_of_month(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_profile(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_avatar(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_avatar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_challenge_board(date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.star_of_month(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_profile(uuid) TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.daily_challenge_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.daily_challenge_attempts_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 12. Backfill: settle every completed week and month, then award badges
-- ---------------------------------------------------------------------------
DO $backfill24$
DECLARE
  v_first date;
  v_today date := public.today_ist();
  d date;
  s record;
BEGIN
  SELECT min(day) INTO v_first FROM public.student_xp_events;
  IF v_first IS NOT NULL THEN
    d := date_trunc('week', v_first)::date;
    WHILE d + 6 < v_today LOOP
      PERFORM public.xp_settle_period('week', d, d + 6);
      d := d + 7;
    END LOOP;
    d := date_trunc('month', v_first)::date;
    WHILE (d + interval '1 month')::date - 1 < v_today LOOP
      PERFORM public.xp_settle_period('month', d, (d + interval '1 month')::date - 1);
      d := (d + interval '1 month')::date;
    END LOOP;
  END IF;

  FOR s IN SELECT id FROM public.profiles WHERE role = 'student' LOOP
    PERFORM public.badges_award(s.id, true);
  END LOOP;
END;
$backfill24$;

-- Date backfilled badges to the round that earned them (so "new this week" stays honest).
WITH ev AS (
  SELECT x.student_id, x.created_at,
         row_number() OVER w AS n,
         sum(x.xp) OVER w AS cum_xp,
         count(*) FILTER (WHERE x.is_personal_best AND NOT x.first_best) OVER w AS pbs,
         count(*) FILTER (WHERE x.total >= 10 AND x.correct = x.total) OVER w AS perfects,
         count(*) FILTER (WHERE x.activity_key LIKE 'flash:%' AND x.total > 0 AND x.correct = x.total) OVER w AS flash_perfect
    FROM public.student_xp_events x
  WINDOW w AS (PARTITION BY x.student_id ORDER BY x.created_at, x.id)
),
days AS (
  SELECT student_id, day, max(created_at) AS at, sum(xp) AS xp
    FROM public.student_xp_events GROUP BY 1, 2
),
kinds AS (
  SELECT student_id, split_part(activity_key, ':', 1) AS kind, min(created_at) AS at
    FROM public.student_xp_events GROUP BY 1, 2
),
mods AS (
  SELECT student_id, split_part(activity_key, ':', 2) AS m, min(created_at) AS at
    FROM public.student_xp_events WHERE activity_key LIKE 'mem:%' GROUP BY 1, 2
),
firsts AS (
  SELECT student_id, 'big_day' AS k, min(at) FILTER (WHERE xp >= 500) AS at FROM days GROUP BY 1
  UNION ALL SELECT student_id, 'explorer', (array_agg(at ORDER BY at))[4] FROM kinds GROUP BY 1
  UNION ALL SELECT student_id, 'memoriad_all', (array_agg(at ORDER BY at))[4] FROM mods GROUP BY 1
  UNION ALL SELECT student_id, 'first_round', min(created_at) FILTER (WHERE n >= 1) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'rounds_10', min(created_at) FILTER (WHERE n >= 10) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'rounds_100', min(created_at) FILTER (WHERE n >= 100) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'rounds_500', min(created_at) FILTER (WHERE n >= 500) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'rounds_1000', min(created_at) FILTER (WHERE n >= 1000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_silver', min(created_at) FILTER (WHERE cum_xp >= 1000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_gold', min(created_at) FILTER (WHERE cum_xp >= 3000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_platinum', min(created_at) FILTER (WHERE cum_xp >= 7500) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_diamond', min(created_at) FILTER (WHERE cum_xp >= 15000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_master', min(created_at) FILTER (WHERE cum_xp >= 30000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'tier_legend', min(created_at) FILTER (WHERE cum_xp >= 75000) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'pb_first', min(created_at) FILTER (WHERE pbs >= 1) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'pb_10', min(created_at) FILTER (WHERE pbs >= 10) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'pb_50', min(created_at) FILTER (WHERE pbs >= 50) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'perfect_first', min(created_at) FILTER (WHERE perfects >= 1) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'perfect_25', min(created_at) FILTER (WHERE perfects >= 25) FROM ev GROUP BY 1
  UNION ALL SELECT student_id, 'flash_perfect', min(created_at) FILTER (WHERE flash_perfect >= 1) FROM ev GROUP BY 1
  UNION ALL SELECT a.student_id, CASE a.kind WHEN 'week' THEN 'week_champion' ELSE 'star_month' END,
                   ((min(a.period_end) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
              FROM public.xp_awards a GROUP BY 1, 2
  UNION ALL SELECT student_id, k, max(created_at) FROM ev
             CROSS JOIN unnest(ARRAY['streak_3', 'streak_7', 'streak_30', 'streak_100']) AS k
             GROUP BY 1, 2
)
UPDATE public.student_badges b
   SET earned_at = f.at
  FROM firsts f
 WHERE f.student_id = b.student_id AND f.k = b.badge_key AND f.at IS NOT NULL
   AND f.at < b.earned_at;
