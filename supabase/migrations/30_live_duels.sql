-- =============================================================================
-- Phase 30: live duels (real-time head-to-head races)
--
--   * Two students at the same level (and centre, once centres exist) race the
--     same seeded 60-second basics round at the same moment. Both see each
--     other's progress live through Supabase Realtime (private channels).
--   * Nobody free -> race a ghost: a replay of a real past run (or a practice bot).
--   * Every answer is graded here (live_duel_answer); the browser never sees
--     expected answers and its own counts are display only.
--   * Settling (live_duel_finish) decides the winner, awards round XP plus a
--     small duel bonus (first 10 duels a day) and moves the duel rating.
--   * No free text anywhere: only preset emotes.
--   * Staff: live_duels_staff() feed with flags, live_duel_set_enabled() switch.
--
-- Rules mirror shared/liveDuel.js (tests/liveDuel.test.js checks the constants).
-- Rows are written by SECURITY DEFINER functions and the service-role API only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. XP source for duel rounds
-- ---------------------------------------------------------------------------
ALTER TABLE public.student_xp_events DROP CONSTRAINT IF EXISTS student_xp_events_source_check;
ALTER TABLE public.student_xp_events ADD CONSTRAINT student_xp_events_source_check
  CHECK (source IN ('result', 'activity', 'jmcwc', 'duel'));

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.live_duel_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.live_duel_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.duel_ratings (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating integer NOT NULL DEFAULT 1000,
  played integer NOT NULL DEFAULT 0,
  won integer NOT NULL DEFAULT 0,
  drawn integer NOT NULL DEFAULT 0,
  lost integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_duel_queue (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  level text,
  centre_id uuid,
  rating integer NOT NULL DEFAULT 1000,
  joined_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.live_duels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('quick', 'challenge', 'ghost', 'rematch')),
  status text NOT NULL DEFAULT 'live'
    CHECK (status IN ('invited', 'live', 'done', 'declined', 'cancelled', 'expired')),
  a_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  b_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  ghost jsonb,                 -- { label, level, bot, source_duel, timeline: [[ms, 1|0], ...] }
  level text,
  centre_id uuid,              -- the centre the duel was played in (NULL until centres exist)
  category_id uuid NOT NULL,
  category_name text NOT NULL,
  seed bigint NOT NULL,
  seconds integer NOT NULL DEFAULT 60 CHECK (seconds BETWEEN 10 AND 300),
  questions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  invite_expires_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  a_correct integer NOT NULL DEFAULT 0,
  a_attempted integer NOT NULL DEFAULT 0,
  a_last_correct_ms integer,
  a_last_emote_at timestamptz,
  a_rematch boolean NOT NULL DEFAULT false,
  b_correct integer NOT NULL DEFAULT 0,
  b_attempted integer NOT NULL DEFAULT 0,
  b_last_correct_ms integer,
  b_last_emote_at timestamptz,
  b_rematch boolean NOT NULL DEFAULT false,
  result text CHECK (result IN ('a', 'b', 'draw', 'none')),
  winner_id uuid,
  a_xp integer,
  b_xp integer,
  a_rating_delta integer,
  b_rating_delta integer,
  rematch_of uuid REFERENCES public.live_duels(id) ON DELETE SET NULL,
  rematch_id uuid,
  flagged boolean NOT NULL DEFAULT false,
  finished_at timestamptz,
  CHECK (b_id IS NULL OR b_id <> a_id),
  CHECK (b_id IS NOT NULL OR kind = 'ghost')
);
CREATE INDEX IF NOT EXISTS live_duels_a_idx ON public.live_duels (a_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_duels_b_idx ON public.live_duels (b_id, created_at DESC);
CREATE INDEX IF NOT EXISTS live_duels_level_done_idx ON public.live_duels (level, finished_at DESC) WHERE status = 'done';

-- Expected answers live apart from the duel so no read path can leak them.
CREATE TABLE IF NOT EXISTS public.live_duel_keys (
  duel_id uuid PRIMARY KEY REFERENCES public.live_duels(id) ON DELETE CASCADE,
  expected jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.live_duel_answers (
  duel_id uuid NOT NULL REFERENCES public.live_duels(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  q_index integer NOT NULL,
  answer text,
  correct boolean NOT NULL,
  ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (duel_id, student_id, q_index)
);

ALTER TABLE public.live_duel_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_duel_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_duels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_duel_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_duel_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_duel_config, public.duel_ratings, public.live_duel_queue,
  public.live_duels, public.live_duel_keys, public.live_duel_answers FROM anon, authenticated;
GRANT ALL ON public.live_duel_config, public.duel_ratings, public.live_duel_queue,
  public.live_duels, public.live_duel_keys, public.live_duel_answers TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- The student's centre. Reads profiles.centre_id once the multi-centre work adds it;
-- NULL until then (everyone is one centre).
CREATE OR REPLACE FUNCTION public.live_duel_centre_of(p_student uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'centre_id') THEN
    EXECUTE 'SELECT centre_id FROM public.profiles WHERE id = $1' INTO v USING p_student;
  END IF;
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_enabled()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((SELECT enabled FROM public.live_duel_config WHERE id), true);
$function$;

-- Is p_uid a player in the duel named by a Realtime topic id? (used by Realtime policies)
CREATE OR REPLACE FUNCTION public.live_duel_is_player(p_duel text, p_uid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_uid IS NULL OR p_duel !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.live_duels d
                  WHERE d.id = p_duel::uuid AND (d.a_id = p_uid OR d.b_id = p_uid));
END;
$function$;

-- Broadcast to a private Realtime topic. Never lets a Realtime hiccup break a duel.
CREATE OR REPLACE FUNCTION public.live_duel_send(p_topic text, p_event text, p_payload jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM realtime.send(p_payload, p_event, p_topic, true);
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$function$;

-- Same rule as shared/liveDuel.js gradeLiveAnswer(): spaces/commas ignored, whole digits only.
CREATE OR REPLACE FUNCTION public.live_duel_grade(p_answer text, p_expected text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN regexp_replace(COALESCE(p_answer, ''), '[\s,]', '', 'g') ~ '^\d{1,16}$'
     AND COALESCE(p_expected, '') ~ '^\d{1,16}$'
    THEN regexp_replace(p_answer, '[\s,]', '', 'g')::numeric = p_expected::numeric
    ELSE false
  END;
$function$;

-- More correct wins; equal correct -> earlier last correct answer; else draw. 'none' = nobody played.
CREATE OR REPLACE FUNCTION public.live_duel_decide(
  p_ac integer, p_aa integer, p_at integer, p_bc integer, p_ba integer, p_bt integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN COALESCE(p_aa, 0) = 0 AND COALESCE(p_ba, 0) = 0 THEN 'none'
    WHEN COALESCE(p_ba, 0) = 0 THEN 'a'
    WHEN COALESCE(p_aa, 0) = 0 THEN 'b'
    WHEN COALESCE(p_ac, 0) > COALESCE(p_bc, 0) THEN 'a'
    WHEN COALESCE(p_bc, 0) > COALESCE(p_ac, 0) THEN 'b'
    WHEN COALESCE(p_ac, 0) = 0 THEN 'draw'
    WHEN COALESCE(p_at, 2147483647) < COALESCE(p_bt, 2147483647) THEN 'a'
    WHEN COALESCE(p_bt, 2147483647) < COALESCE(p_at, 2147483647) THEN 'b'
    ELSE 'draw'
  END;
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_elo(p_rating integer, p_other integer, p_score numeric, p_k numeric)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT round(p_k * (p_score - 1 / (1 + power(10::numeric, (p_other - p_rating)::numeric / 400))))::integer;
$function$;

-- Notify players when a duel row appears (matched, or an invite).
CREATE OR REPLACE FUNCTION public.trg_live_duel_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from text;
BEGIN
  IF NEW.status = 'invited' THEN
    SELECT public.display_name_for(p.full_name, p.student_code) INTO v_from FROM public.profiles p WHERE p.id = NEW.a_id;
    PERFORM public.live_duel_send('duel-user:' || NEW.b_id, 'invite',
      jsonb_build_object('duel_id', NEW.id, 'from_name', v_from, 'category_name', NEW.category_name,
                         'expires_at', NEW.invite_expires_at));
  ELSE
    PERFORM public.live_duel_send('duel-user:' || NEW.a_id, 'matched', jsonb_build_object('duel_id', NEW.id));
    IF NEW.b_id IS NOT NULL THEN
      PERFORM public.live_duel_send('duel-user:' || NEW.b_id, 'matched', jsonb_build_object('duel_id', NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_live_duel_created ON public.live_duels;
CREATE TRIGGER trg_live_duel_created AFTER INSERT ON public.live_duels
  FOR EACH ROW EXECUTE FUNCTION public.trg_live_duel_created();

-- ---------------------------------------------------------------------------
-- 3. Realtime authorization (private channels)
--    duel-user:<uid>  only that student;  duel:<id>  only its two players.
--    duel-lobby  any signed-in user: presence only (who is on the live duel page,
--    by profile id; names come from duel_options for the student's own level).
--    Players may track presence; nobody can broadcast from the browser.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS live_duel_rt_read ON realtime.messages;
CREATE POLICY live_duel_rt_read ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.topic() = 'duel-user:' || auth.uid()::text
    OR (realtime.topic() = 'duel-lobby' AND realtime.messages.extension = 'presence')
    OR (realtime.topic() LIKE 'duel:%' AND public.live_duel_is_player(substr(realtime.topic(), 6), auth.uid()))
  );
DROP POLICY IF EXISTS live_duel_rt_presence ON realtime.messages;
CREATE POLICY live_duel_rt_presence ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension = 'presence'
    AND (realtime.topic() = 'duel-lobby'
         OR (realtime.topic() LIKE 'duel:%' AND public.live_duel_is_player(substr(realtime.topic(), 6), auth.uid())))
  );

-- ---------------------------------------------------------------------------
-- 4. Playing
-- ---------------------------------------------------------------------------

-- Settles a duel once its time (plus grace) is over. Safe to call many times.
CREATE OR REPLACE FUNCTION public.live_duel_settle(p_duel uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d public.live_duels%ROWTYPE;
  v_ghost boolean;
  v_bc integer; v_ba integer; v_bt integer;
  v_result text;
  v_ar integer; v_br integer;
  v_ad integer; v_bd integer;
  v_day date := public.today_ist();
  v_axp integer; v_bxp integer;
  v_status text;
BEGIN
  SELECT * INTO d FROM public.live_duels WHERE id = p_duel FOR UPDATE;
  IF NOT FOUND OR d.status <> 'live' OR d.end_at IS NULL OR now() < d.end_at + interval '2 seconds' THEN
    RETURN;
  END IF;
  v_ghost := d.b_id IS NULL;
  IF v_ghost THEN
    SELECT count(*) FILTER (WHERE (t->>1)::int = 1), count(*), max((t->>0)::int) FILTER (WHERE (t->>1)::int = 1)
      INTO v_bc, v_ba, v_bt
      FROM jsonb_array_elements(COALESCE(d.ghost->'timeline', '[]'::jsonb)) t
     WHERE (t->>0)::int <= d.seconds * 1000;
    UPDATE public.live_duels SET b_correct = v_bc, b_attempted = v_ba, b_last_correct_ms = v_bt WHERE id = d.id;
  ELSE
    v_bc := d.b_correct; v_ba := d.b_attempted; v_bt := d.b_last_correct_ms;
  END IF;

  v_result := public.live_duel_decide(d.a_correct, d.a_attempted, d.a_last_correct_ms, v_bc, v_ba, v_bt);
  v_status := CASE WHEN v_result = 'none' OR (v_ghost AND d.a_attempted = 0) THEN 'expired' ELSE 'done' END;

  IF v_status = 'done' THEN
    INSERT INTO public.duel_ratings (student_id) VALUES (d.a_id) ON CONFLICT DO NOTHING;
    SELECT rating INTO v_ar FROM public.duel_ratings WHERE student_id = d.a_id;
    IF v_ghost THEN
      v_br := 1000;
    ELSE
      INSERT INTO public.duel_ratings (student_id) VALUES (d.b_id) ON CONFLICT DO NOTHING;
      SELECT rating INTO v_br FROM public.duel_ratings WHERE student_id = d.b_id;
    END IF;
    v_ad := public.live_duel_elo(v_ar, v_br, CASE v_result WHEN 'a' THEN 1 WHEN 'b' THEN 0 ELSE 0.5 END,
                                 CASE WHEN v_ghost THEN 12 ELSE 24 END);
    UPDATE public.duel_ratings
       SET rating = GREATEST(100, rating + v_ad), played = played + 1,
           won = won + (v_result = 'a')::int, drawn = drawn + (v_result = 'draw')::int,
           lost = lost + (v_result = 'b')::int, updated_at = now()
     WHERE student_id = d.a_id;
    IF NOT v_ghost THEN
      v_bd := public.live_duel_elo(v_br, v_ar, CASE v_result WHEN 'b' THEN 1 WHEN 'a' THEN 0 ELSE 0.5 END, 24);
      UPDATE public.duel_ratings
         SET rating = GREATEST(100, rating + v_bd), played = played + 1,
             won = won + (v_result = 'b')::int, drawn = drawn + (v_result = 'draw')::int,
             lost = lost + (v_result = 'a')::int, updated_at = now()
       WHERE student_id = d.b_id;
    END IF;

    v_axp := public.live_duel_award_xp(d, 'a', v_result, v_day);
    IF NOT v_ghost THEN
      v_bxp := public.live_duel_award_xp(d, 'b', v_result, v_day);
    END IF;

    -- Badges shared with classic duels.
    INSERT INTO public.student_badges (student_id, badge_key)
      SELECT s, 'duel_first' FROM unnest(ARRAY[
        CASE WHEN d.a_attempted > 0 THEN d.a_id END,
        CASE WHEN NOT v_ghost AND d.b_attempted > 0 THEN d.b_id END]) s
       WHERE s IS NOT NULL
      ON CONFLICT DO NOTHING;
    IF v_result IN ('a', 'b') AND NOT (v_ghost AND v_result = 'b') THEN
      INSERT INTO public.student_badges (student_id, badge_key)
        VALUES (CASE v_result WHEN 'a' THEN d.a_id ELSE d.b_id END, 'duel_win') ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  UPDATE public.live_duels
     SET status = v_status, result = v_result, finished_at = now(),
         winner_id = CASE v_result WHEN 'a' THEN d.a_id WHEN 'b' THEN d.b_id END,
         a_rating_delta = v_ad, b_rating_delta = v_bd, a_xp = v_axp, b_xp = v_bxp
   WHERE id = d.id;

  PERFORM public.live_duel_send('duel:' || d.id, 'finished', jsonb_build_object('result', v_result));
END;
$function$;

-- Round XP (normal rules, daily factor per activity) plus the duel bonus for the
-- first 10 duels a day (ghost duels: half). Returns the XP the round earned.
CREATE OR REPLACE FUNCTION public.live_duel_award_xp(d public.live_duels, p_side text, p_result text, p_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_student uuid := CASE p_side WHEN 'a' THEN d.a_id ELSE d.b_id END;
  v_correct integer := CASE p_side WHEN 'a' THEN d.a_correct ELSE d.b_correct END;
  v_attempted integer := CASE p_side WHEN 'a' THEN d.a_attempted ELSE d.b_attempted END;
  v_source_id text := d.id::text || ':' || p_side;
  v_outcome text;
  v_bonus integer;
  v_before integer;
  v_xp integer;
BEGIN
  IF v_student IS NULL OR v_attempted <= 0 THEN RETURN 0; END IF;
  PERFORM public.xp_award(v_student, 'duel', v_source_id, 'duel:' || d.category_id::text,
    'Live duel · ' || d.category_name, v_correct, v_attempted, d.seconds, p_day, false,
    NULL, v_correct || '/' || v_attempted, now());

  v_outcome := CASE WHEN p_result = 'draw' THEN 'draw' WHEN p_result = p_side THEN 'won' ELSE 'lost' END;
  SELECT count(*) INTO v_before FROM public.student_xp_events
   WHERE student_id = v_student AND source = 'duel' AND day = p_day AND bonus_xp > 0 AND source_id <> v_source_id;
  v_bonus := CASE WHEN v_before >= 10 THEN 0
                  ELSE CASE v_outcome WHEN 'won' THEN 15 WHEN 'draw' THEN 8 ELSE 5 END END;
  IF d.b_id IS NULL THEN v_bonus := ceil(v_bonus / 2.0)::integer; END IF;
  IF v_bonus > 0 THEN
    UPDATE public.student_xp_events SET bonus_xp = bonus_xp + v_bonus, xp = xp + v_bonus
     WHERE source = 'duel' AND source_id = v_source_id;
  END IF;
  SELECT xp INTO v_xp FROM public.student_xp_events WHERE source = 'duel' AND source_id = v_source_id;
  RETURN COALESCE(v_xp, 0);
END;
$function$;

-- One answer. Graded here; progress is broadcast to both players.
CREATE OR REPLACE FUNCTION public.live_duel_answer(p_duel uuid, p_index integer, p_answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  d public.live_duels%ROWTYPE;
  v_side text;
  v_attempted integer;
  v_ms integer;
  v_expected text;
  v_pool integer;
  v_ok boolean;
  v_correct integer;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO d FROM public.live_duels WHERE id = p_duel FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  v_side := CASE WHEN d.a_id = v_me THEN 'a' WHEN d.b_id = v_me THEN 'b' END;
  IF v_side IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  IF d.status <> 'live' OR d.start_at IS NULL OR now() < d.start_at THEN
    RETURN jsonb_build_object('ok', false, 'code', CASE WHEN d.status = 'live' THEN 'NOT_STARTED' ELSE 'TIME_UP' END);
  END IF;
  IF now() > d.end_at + interval '2 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TIME_UP');
  END IF;
  v_attempted := CASE v_side WHEN 'a' THEN d.a_attempted ELSE d.b_attempted END;
  IF p_index IS NULL OR p_index <> v_attempted THEN
    RETURN jsonb_build_object('ok', false, 'code', 'OUT_OF_ORDER', 'attempted', v_attempted);
  END IF;
  SELECT k.expected ->> p_index, jsonb_array_length(k.expected) INTO v_expected, v_pool
    FROM public.live_duel_keys k WHERE k.duel_id = d.id;
  IF v_pool IS NULL OR p_index >= v_pool THEN
    RETURN jsonb_build_object('ok', false, 'code', 'POOL_DONE');
  END IF;
  IF length(COALESCE(p_answer, '')) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_ANSWER');
  END IF;
  v_ms := LEAST(d.seconds * 1000, GREATEST(0, floor(extract(epoch FROM (now() - d.start_at)) * 1000)::integer));
  IF v_ms < (p_index + 1) * 250 THEN
    UPDATE public.live_duels SET flagged = true WHERE id = d.id;
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_FAST');
  END IF;

  v_ok := public.live_duel_grade(p_answer, v_expected);
  INSERT INTO public.live_duel_answers (duel_id, student_id, q_index, answer, correct, ms)
    VALUES (d.id, v_me, p_index, left(COALESCE(p_answer, ''), 20), v_ok, v_ms);
  IF v_side = 'a' THEN
    UPDATE public.live_duels
       SET a_attempted = a_attempted + 1, a_correct = a_correct + v_ok::int,
           a_last_correct_ms = CASE WHEN v_ok THEN v_ms ELSE a_last_correct_ms END
     WHERE id = d.id RETURNING a_correct INTO v_correct;
  ELSE
    UPDATE public.live_duels
       SET b_attempted = b_attempted + 1, b_correct = b_correct + v_ok::int,
           b_last_correct_ms = CASE WHEN v_ok THEN v_ms ELSE b_last_correct_ms END
     WHERE id = d.id RETURNING b_correct INTO v_correct;
  END IF;
  PERFORM public.live_duel_send('duel:' || d.id, 'progress',
    jsonb_build_object('side', v_side, 'correct', v_correct, 'attempted', v_attempted + 1));
  RETURN jsonb_build_object('ok', true, 'correct', v_ok, 'my_correct', v_correct, 'my_attempted', v_attempted + 1);
END;
$function$;

-- A preset emote, at most one every 3 seconds per player.
CREATE OR REPLACE FUNCTION public.live_duel_emote(p_duel uuid, p_emote text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  d public.live_duels%ROWTYPE;
  v_side text;
  v_last timestamptz;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_emote NOT IN ('thumbs', 'wow', 'fire', 'clap', 'phew', 'gg') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_EMOTE');
  END IF;
  SELECT * INTO d FROM public.live_duels WHERE id = p_duel FOR UPDATE;
  v_side := CASE WHEN d.a_id = v_me THEN 'a' WHEN d.b_id = v_me THEN 'b' END;
  IF v_side IS NULL OR d.b_id IS NULL OR d.status NOT IN ('live', 'done') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_ALLOWED');
  END IF;
  v_last := CASE v_side WHEN 'a' THEN d.a_last_emote_at ELSE d.b_last_emote_at END;
  IF v_last IS NOT NULL AND now() < v_last + interval '3 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOW_DOWN');
  END IF;
  IF v_side = 'a' THEN
    UPDATE public.live_duels SET a_last_emote_at = now() WHERE id = d.id;
  ELSE
    UPDATE public.live_duels SET b_last_emote_at = now() WHERE id = d.id;
  END IF;
  PERFORM public.live_duel_send('duel:' || d.id, 'emote', jsonb_build_object('side', v_side, 'emote', p_emote));
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- Accept or decline a live challenge (the invited player only).
CREATE OR REPLACE FUNCTION public.live_duel_respond(p_duel uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  d public.live_duels%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO d FROM public.live_duels WHERE id = p_duel FOR UPDATE;
  IF NOT FOUND OR d.b_id IS DISTINCT FROM v_me THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Challenge not found.');
  END IF;
  IF d.status <> 'invited' OR d.invite_expires_at < now() THEN
    IF d.status = 'invited' THEN
      UPDATE public.live_duels SET status = 'expired', finished_at = now() WHERE id = d.id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'This challenge has ended.');
  END IF;
  IF p_accept THEN
    UPDATE public.live_duels
       SET status = 'live', start_at = now() + interval '5 seconds',
           end_at = now() + interval '5 seconds' + make_interval(secs => d.seconds)
     WHERE id = d.id;
    PERFORM public.live_duel_send('duel-user:' || d.a_id, 'matched', jsonb_build_object('duel_id', d.id));
  ELSE
    UPDATE public.live_duels SET status = 'declined', finished_at = now() WHERE id = d.id;
    PERFORM public.live_duel_send('duel-user:' || d.a_id, 'declined', jsonb_build_object('duel_id', d.id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'duel_id', d.id);
END;
$function$;

-- The challenger withdraws an invite nobody has accepted.
CREATE OR REPLACE FUNCTION public.live_duel_cancel(p_duel uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_b uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.live_duels SET status = 'cancelled', finished_at = now()
   WHERE id = p_duel AND a_id = v_me AND status = 'invited'
   RETURNING b_id INTO v_b;
  IF v_b IS NOT NULL THEN
    PERFORM public.live_duel_send('duel-user:' || v_b, 'cancelled', jsonb_build_object('duel_id', p_duel));
  END IF;
  RETURN jsonb_build_object('ok', v_b IS NOT NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_leave_queue()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  DELETE FROM public.live_duel_queue WHERE student_id = auth.uid();
$function$;

-- Everything the page needs to show (or resume) a duel. Questions are only
-- handed out once the race has started, so nobody reads ahead in the countdown.
CREATE OR REPLACE FUNCTION public.live_duel_state(p_duel uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  d public.live_duels%ROWTYPE;
  v_side text;
  v_other uuid;
  o public.profiles%ROWTYPE;
  v_started boolean;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM public.live_duel_settle(p_duel);
  SELECT * INTO d FROM public.live_duels WHERE id = p_duel;
  v_side := CASE WHEN d.a_id = v_me THEN 'a' WHEN d.b_id = v_me THEN 'b' END;
  IF v_side IS NULL THEN RETURN NULL; END IF;
  IF d.status = 'invited' AND d.invite_expires_at < now() THEN
    UPDATE public.live_duels SET status = 'expired', finished_at = now() WHERE id = d.id RETURNING * INTO d;
  END IF;
  v_other := CASE v_side WHEN 'a' THEN d.b_id ELSE d.a_id END;
  IF v_other IS NOT NULL THEN
    SELECT * INTO o FROM public.profiles WHERE id = v_other;
  END IF;
  v_started := d.start_at IS NOT NULL AND now() >= d.start_at;

  RETURN jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'status', d.status, 'side', v_side,
    'server_now', now(), 'start_at', d.start_at, 'end_at', d.end_at,
    'invite_expires_at', d.invite_expires_at, 'seconds', d.seconds,
    'category_name', d.category_name, 'level', d.level,
    'questions', CASE WHEN v_started THEN d.questions END,
    'me', jsonb_build_object(
      'correct', CASE v_side WHEN 'a' THEN d.a_correct ELSE d.b_correct END,
      'attempted', CASE v_side WHEN 'a' THEN d.a_attempted ELSE d.b_attempted END,
      'xp', CASE v_side WHEN 'a' THEN d.a_xp ELSE d.b_xp END,
      'rating_delta', CASE v_side WHEN 'a' THEN d.a_rating_delta ELSE d.b_rating_delta END,
      'rating', (SELECT r.rating FROM public.duel_ratings r WHERE r.student_id = v_me),
      'rematch', CASE v_side WHEN 'a' THEN d.a_rematch ELSE d.b_rematch END),
    'other', jsonb_build_object(
      'ghost', v_other IS NULL,
      'name', CASE WHEN v_other IS NULL THEN COALESCE(d.ghost->>'label', 'Ghost runner')
                   ELSE public.display_name_for(o.full_name, o.student_code) END,
      'avatar', CASE WHEN v_other IS NOT NULL THEN public.avatar_visible(o.id, o.avatar_path) END,
      'rating', CASE WHEN v_other IS NOT NULL THEN COALESCE((SELECT r.rating FROM public.duel_ratings r WHERE r.student_id = v_other), 1000) END,
      'correct', CASE v_side WHEN 'a' THEN d.b_correct ELSE d.a_correct END,
      'attempted', CASE v_side WHEN 'a' THEN d.b_attempted ELSE d.a_attempted END,
      'rematch', CASE v_side WHEN 'a' THEN d.b_rematch ELSE d.a_rematch END,
      'timeline', CASE WHEN v_other IS NULL AND v_started THEN d.ghost->'timeline' END),
    'result', CASE WHEN d.result IS NULL THEN NULL
                   WHEN d.result IN ('draw', 'none') THEN d.result
                   WHEN d.result = v_side THEN 'won' ELSE 'lost' END,
    'rematch_id', d.rematch_id
  );
END;
$function$;

-- The caller's live duel home: rating, open invites to them, recent duels.
CREATE OR REPLACE FUNCTION public.my_live_duels()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.live_duels SET status = 'expired', finished_at = now()
   WHERE status = 'invited' AND invite_expires_at < now() AND (a_id = v_me OR b_id = v_me);
  RETURN jsonb_build_object(
    'enabled', public.live_duel_enabled(),
    'rating', COALESCE((SELECT to_jsonb(r) - 'student_id' FROM public.duel_ratings r WHERE r.student_id = v_me),
                       jsonb_build_object('rating', 1000, 'played', 0, 'won', 0, 'drawn', 0, 'lost', 0)),
    'active', (SELECT d.id FROM public.live_duels d
                WHERE (d.a_id = v_me OR d.b_id = v_me) AND d.status = 'live'
                  AND d.end_at + interval '2 seconds' > now()
                ORDER BY d.created_at DESC LIMIT 1),
    'invites', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'from_name', public.display_name_for(p.full_name, p.student_code),
                                          'category_name', d.category_name, 'expires_at', d.invite_expires_at)
                       ORDER BY d.created_at DESC)
        FROM public.live_duels d JOIN public.profiles p ON p.id = d.a_id
       WHERE d.b_id = v_me AND d.status = 'invited'), '[]'::jsonb),
    'sent', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', d.id, 'to_name', public.display_name_for(p.full_name, p.student_code),
                                          'expires_at', d.invite_expires_at))
        FROM public.live_duels d JOIN public.profiles p ON p.id = d.b_id
       WHERE d.a_id = v_me AND d.status = 'invited'), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.at DESC) FROM (
        SELECT d.finished_at AS at, jsonb_build_object(
          'id', d.id, 'kind', d.kind, 'finished_at', d.finished_at, 'category_name', d.category_name,
          'other_name', CASE WHEN d.b_id IS NULL THEN COALESCE(d.ghost->>'label', 'Ghost runner')
                             ELSE public.display_name_for(p.full_name, p.student_code) END,
          'my_correct', CASE WHEN d.a_id = v_me THEN d.a_correct ELSE d.b_correct END,
          'other_correct', CASE WHEN d.a_id = v_me THEN d.b_correct ELSE d.a_correct END,
          'xp', CASE WHEN d.a_id = v_me THEN d.a_xp ELSE d.b_xp END,
          'rating_delta', CASE WHEN d.a_id = v_me THEN d.a_rating_delta ELSE d.b_rating_delta END,
          'result', CASE WHEN d.result IN ('draw', 'none') THEN d.result
                         WHEN (d.result = 'a') = (d.a_id = v_me) THEN 'won' ELSE 'lost' END) AS j
          FROM public.live_duels d
          LEFT JOIN public.profiles p ON p.id = CASE WHEN d.a_id = v_me THEN d.b_id ELSE d.a_id END
         WHERE (d.a_id = v_me OR d.b_id = v_me) AND d.status = 'done'
         ORDER BY d.finished_at DESC LIMIT 15) x), '[]'::jsonb)
  );
END;
$function$;

-- Top duellists at the caller's level (and centre, once centres exist).
CREATE OR REPLACE FUNCTION public.live_duel_board()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_centre uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
  v_centre := public.live_duel_centre_of(v_me);
  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.rating DESC, x.won DESC) FROM (
      SELECT r.rating, r.won, jsonb_build_object(
        'id', p.id, 'me', p.id = v_me,
        'display_name', public.display_name_for(p.full_name, p.student_code),
        'avatar_path', public.avatar_visible(p.id, p.avatar_path),
        'rating', r.rating, 'played', r.played, 'won', r.won) AS j
        FROM public.duel_ratings r JOIN public.profiles p ON p.id = r.student_id
       WHERE p.role = 'student' AND p.active AND p.leaderboard_visible AND r.played > 0
         AND p.level IS NOT DISTINCT FROM v_level
         AND public.live_duel_centre_of(p.id) IS NOT DISTINCT FROM v_centre
       ORDER BY r.rating DESC, r.won DESC LIMIT 10) x), '[]'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Staff
-- ---------------------------------------------------------------------------

-- Recent live duels for admins (everyone) and teachers (their assigned students).
-- flagged = an answer came in faster than possible.
CREATE OR REPLACE FUNCTION public.live_duels_staff(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_admin boolean := public.is_admin();
BEGIN
  IF v_me IS NULL OR NOT (v_admin OR public.is_teacher(v_me)) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  RETURN jsonb_build_object(
    'enabled', public.live_duel_enabled(),
    'can_toggle', v_admin,
    'duels', COALESCE((
      SELECT jsonb_agg(x.j ORDER BY x.at DESC) FROM (
        SELECT d.created_at AS at, jsonb_build_object(
          'id', d.id, 'kind', d.kind, 'status', d.status, 'created_at', d.created_at,
          'level', d.level, 'category_name', d.category_name, 'flagged', d.flagged,
          'a_name', public.display_name_for(pa.full_name, pa.student_code),
          'b_name', CASE WHEN d.b_id IS NULL THEN COALESCE(d.ghost->>'label', 'Ghost runner')
                         ELSE public.display_name_for(pb.full_name, pb.student_code) END,
          'a_correct', d.a_correct, 'a_attempted', d.a_attempted,
          'b_correct', d.b_correct, 'b_attempted', d.b_attempted,
          'winner', CASE d.result WHEN 'a' THEN public.display_name_for(pa.full_name, pa.student_code)
                                  WHEN 'b' THEN CASE WHEN d.b_id IS NULL THEN COALESCE(d.ghost->>'label', 'Ghost runner')
                                                     ELSE public.display_name_for(pb.full_name, pb.student_code) END
                                  WHEN 'draw' THEN 'Draw' END) AS j
          FROM public.live_duels d
          JOIN public.profiles pa ON pa.id = d.a_id
          LEFT JOIN public.profiles pb ON pb.id = d.b_id
         WHERE d.created_at > now() - make_interval(days => GREATEST(1, LEAST(COALESCE(p_days, 7), 60)))
           AND d.status IN ('live', 'done', 'expired')
           AND (v_admin OR public.is_teacher_assigned_to_student(v_me, d.a_id)
                OR (d.b_id IS NOT NULL AND public.is_teacher_assigned_to_student(v_me, d.b_id)))
         ORDER BY d.created_at DESC LIMIT 200) x), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_set_enabled(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.live_duel_config SET enabled = COALESCE(p_enabled, true), updated_by = auth.uid(), updated_at = now()
   WHERE id;
  IF NOT COALESCE(p_enabled, true) THEN
    DELETE FROM public.live_duel_queue;
  END IF;
  RETURN COALESCE(p_enabled, true);
END;
$function$;

-- Service-role helper for the API: atomically takes both players out of the queue.
CREATE OR REPLACE FUNCTION public.live_duel_claim_pair(p_a uuid, p_b uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  PERFORM 1 FROM public.live_duel_queue WHERE student_id IN (p_a, p_b) ORDER BY student_id FOR UPDATE;
  IF (SELECT count(*) FROM public.live_duel_queue WHERE student_id IN (p_a, p_b)) <> 2 THEN
    RETURN false;
  END IF;
  DELETE FROM public.live_duel_queue WHERE student_id IN (p_a, p_b);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 2;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants (Supabase gives anon EXECUTE on new functions by default)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.live_duel_centre_of(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_enabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_is_player(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_send(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_grade(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_decide(integer, integer, integer, integer, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_elo(integer, integer, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.trg_live_duel_created() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_settle(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_award_xp(public.live_duels, text, text, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_answer(uuid, integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_emote(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_respond(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_cancel(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_leave_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_live_duels() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_board() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duels_staff(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_set_enabled(boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_claim_pair(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.live_duel_is_player(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_enabled() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_settle(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_answer(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_emote(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_respond(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_cancel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_leave_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_live_duels() TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_board() TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duels_staff(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_set_enabled(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_centre_of(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_send(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_claim_pair(uuid, uuid) TO service_role;
