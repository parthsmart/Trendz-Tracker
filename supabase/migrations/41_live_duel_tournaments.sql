-- Phase 41: Live duel tournaments.
--
--   * Admins, directors and centre heads create a tournament: name, level, 8 / 16 / 32
--     players, one centre (centre heads: their own) or all centres (owner / director /
--     admin only), a sign-up window, a start time and the minutes between rounds.
--   * At the start time the entries are seeded by duel rating (high first, then who signed up
--     first). The bracket is the smallest of 4 / 8 / 16 / 32 that holds everyone; the top
--     seeds get byes. Fewer than 4 sign-ups and it is cancelled.
--   * Round r opens at start_at + (r - 1) * round_minutes (or as soon as both players are
--     known, if later). Both players then have 3 minutes to check in. When both are in, the
--     API (api/_tournaments.js) creates a normal 60-second live duel, kind 'tournament',
--     rated and with XP and emotes as usual. One player in: they win by forfeit. Neither:
--     the higher seed goes through. A drawn duel also goes to the higher seed.
--   * Champion, finalist and semi-finalists get a badge and store balance (500 / 250 / 100
--     "XP to spend"). Store balance comes from the new reward_credits table, which
--     reward_balance() now adds in. It is NOT XP: leaderboards and leagues are unchanged.
--   * Everything moves lazily in tournament_tick(), called from the state RPCs.
--   * The rules live in shared/tournament.js; tests check the two agree.
--
-- No data is deleted. Rollback: supabase/rollbacks/41_live_duel_tournaments_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Live duels can be tournament matches
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.live_duels'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%''rematch''%'
  LOOP
    EXECUTE format('ALTER TABLE public.live_duels DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.live_duels ADD CONSTRAINT live_duels_kind_check
    CHECK (kind IN ('quick', 'challenge', 'ghost', 'rematch', 'tournament'));
END $$;

-- ---------------------------------------------------------------------------
-- 2. Store balance credits (prizes that are not XP)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reward_credits (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  source_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reward_credits_student_idx ON public.reward_credits (student_id);

CREATE OR REPLACE FUNCTION public.reward_balance(p_student uuid)
 RETURNS TABLE(earned bigint, spent bigint, balance bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.v + c.v, s.v, e.v + c.v - s.v
    FROM (SELECT COALESCE(sum(xp), 0)::bigint AS v FROM public.student_xp_events
           WHERE student_id = p_student AND day >= date '2026-11-01') e,
         (SELECT COALESCE(sum(amount), 0)::bigint AS v FROM public.reward_credits
           WHERE student_id = p_student) c,
         (SELECT COALESCE(sum(cost), 0)::bigint AS v FROM public.reward_redemptions
           WHERE student_id = p_student AND status IN ('requested', 'given')) s;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournaments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 60),
  level text NOT NULL,
  max_players integer NOT NULL CHECK (max_players IN (8, 16, 32)),
  centre_id uuid,                -- NULL = every centre
  signup_opens_at timestamptz NOT NULL,
  signup_closes_at timestamptz NOT NULL,
  start_at timestamptz NOT NULL,
  round_minutes integer NOT NULL DEFAULT 10 CHECK (round_minutes BETWEEN 5 AND 60),
  status text NOT NULL DEFAULT 'signup' CHECK (status IN ('signup', 'running', 'done', 'cancelled')),
  bracket_size integer,
  rounds integer,
  champion_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  note text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (signup_opens_at < signup_closes_at AND signup_closes_at <= start_at)
);
CREATE INDEX IF NOT EXISTS tournaments_open_idx ON public.tournaments (level, start_at) WHERE status IN ('signup', 'running');

CREATE TABLE IF NOT EXISTS public.tournament_entries (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rating integer,
  seed integer,
  out_round integer,             -- the round they lost in; NULL while still in (and for the champion)
  finish text CHECK (finish IN ('champion', 'finalist', 'semi')),
  PRIMARY KEY (tournament_id, student_id)
);
CREATE INDEX IF NOT EXISTS tournament_entries_student_idx ON public.tournament_entries (student_id);

CREATE TABLE IF NOT EXISTS public.tournament_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  round integer NOT NULL CHECK (round >= 1),
  slot integer NOT NULL CHECK (slot >= 0),
  a_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  b_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  a_seed integer,
  b_seed integer,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'live', 'done')),
  ready_at timestamptz,          -- check-in opens
  checkin_until timestamptz,     -- ready_at + 3 minutes
  a_checked_in_at timestamptz,
  b_checked_in_at timestamptz,
  start_claim_at timestamptz,    -- the API call that is creating the duel
  duel_id uuid REFERENCES public.live_duels(id) ON DELETE SET NULL,
  winner_id uuid,
  how text CHECK (how IN ('duel', 'bye', 'forfeit', 'no_show', 'seed')),
  finished_at timestamptz,
  UNIQUE (tournament_id, round, slot)
);
CREATE INDEX IF NOT EXISTS tournament_matches_open_idx ON public.tournament_matches (tournament_id, status) WHERE status IN ('ready', 'live');
CREATE INDEX IF NOT EXISTS tournament_matches_duel_idx ON public.tournament_matches (duel_id) WHERE duel_id IS NOT NULL;

ALTER TABLE public.reward_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reward_credits, public.tournaments, public.tournament_entries, public.tournament_matches FROM anon, authenticated;
GRANT ALL ON public.reward_credits, public.tournaments, public.tournament_entries, public.tournament_matches TO service_role;
DO $$
BEGIN
  IF to_regclass('public.reward_credits_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SEQUENCE public.reward_credits_id_seq TO service_role';
  END IF;
END $$;

-- Badges
DO $$
BEGIN
  IF to_regclass('public.badge_catalogue') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.badge_catalogue (key, name, icon, description, category, sort_order) VALUES
        ('tourney_champion', 'Tournament champion', '🏆', 'Win a live duel tournament.', 'duel', 94),
        ('tourney_finalist', 'Tournament finalist', '🥈', 'Reach the final of a live duel tournament.', 'duel', 95),
        ('tourney_semi', 'Tournament semi-finalist', '🥉', 'Reach the semi-finals of a live duel tournament.', 'duel', 96)
      ON CONFLICT (key) DO UPDATE
        SET name = EXCLUDED.name, icon = EXCLUDED.icon, description = EXCLUDED.description,
            category = EXCLUDED.category, sort_order = EXCLUDED.sort_order
    $sql$;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Rules (mirrors shared/tournament.js)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tournament_bracket_size(p_count integer, p_cap integer)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v integer := 4;
BEGIN
  WHILE v < p_count AND v < p_cap LOOP v := v * 2; END LOOP;
  RETURN v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_seed_order(p_size integer)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  o integer[] := ARRAY[1, 2];
  nxt integer[];
  s integer;
  len integer;
BEGIN
  IF p_size < 2 THEN RETURN ARRAY[1]; END IF;
  WHILE array_length(o, 1) < p_size LOOP
    len := array_length(o, 1) * 2;
    nxt := '{}';
    FOREACH s IN ARRAY o LOOP
      nxt := nxt || s || (len + 1 - s);
    END LOOP;
    o := nxt;
  END LOOP;
  RETURN o;
END;
$function$;

-- Owner / director / admin: any tournament. Centre head: their own centre's.
CREATE OR REPLACE FUNCTION public.tournament_can_manage(p_centre uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(public.is_network_admin() OR (p_centre IS NOT NULL AND public.is_centre_head(p_centre)), false)
$function$;

-- A student sees tournaments at their level, for their centre or for every centre.
CREATE OR REPLACE FUNCTION public.tournament_visible(t public.tournaments, p_student uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id = p_student AND p.role = 'student' AND p.level = t.level
       AND (t.centre_id IS NULL OR p.centre_id = t.centre_id))
$function$;

-- ---------------------------------------------------------------------------
-- 5. Moving the bracket along (internal)
-- ---------------------------------------------------------------------------

-- Puts a player into a side of a match; when both are known the match is ready.
CREATE OR REPLACE FUNCTION public.tournament_place(p_tournament uuid, p_round integer, p_slot integer,
  p_side text, p_student uuid, p_seed integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tournaments%ROWTYPE;
  m public.tournament_matches%ROWTYPE;
  v_ready timestamptz;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament;
  IF p_side = 'a' THEN
    UPDATE public.tournament_matches SET a_id = p_student, a_seed = p_seed
     WHERE tournament_id = p_tournament AND round = p_round AND slot = p_slot RETURNING * INTO m;
  ELSE
    UPDATE public.tournament_matches SET b_id = p_student, b_seed = p_seed
     WHERE tournament_id = p_tournament AND round = p_round AND slot = p_slot RETURNING * INTO m;
  END IF;
  IF m.status = 'pending' AND m.a_id IS NOT NULL AND m.b_id IS NOT NULL THEN
    v_ready := GREATEST(t.start_at + make_interval(mins => (p_round - 1) * t.round_minutes), now());
    UPDATE public.tournament_matches
       SET status = 'ready', ready_at = v_ready, checkin_until = v_ready + interval '180 seconds'
     WHERE id = m.id;
    PERFORM public.live_duel_send('duel-user:' || m.a_id, 'tournament_ready',
      jsonb_build_object('tournament_id', p_tournament, 'match_id', m.id, 'ready_at', v_ready));
    PERFORM public.live_duel_send('duel-user:' || m.b_id, 'tournament_ready',
      jsonb_build_object('tournament_id', p_tournament, 'match_id', m.id, 'ready_at', v_ready));
  END IF;
END;
$function$;

-- Badge and store balance for a finish (once per tournament and student).
CREATE OR REPLACE FUNCTION public.tournament_award(p_tournament uuid, p_student uuid, p_finish text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_name text;
  v_amount integer := CASE p_finish WHEN 'champion' THEN 500 WHEN 'finalist' THEN 250 ELSE 100 END;
BEGIN
  IF p_student IS NULL THEN RETURN; END IF;
  SELECT name INTO v_name FROM public.tournaments WHERE id = p_tournament;
  UPDATE public.tournament_entries SET finish = p_finish
   WHERE tournament_id = p_tournament AND student_id = p_student;
  INSERT INTO public.student_badges (student_id, badge_key)
    VALUES (p_student, CASE p_finish WHEN 'champion' THEN 'tourney_champion'
                                     WHEN 'finalist' THEN 'tourney_finalist' ELSE 'tourney_semi' END)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.reward_credits (student_id, amount, reason, source_id)
    VALUES (p_student, v_amount,
            CASE p_finish WHEN 'champion' THEN 'Champion' WHEN 'finalist' THEN 'Finalist' ELSE 'Semi-finalist' END
              || ' · ' || COALESCE(v_name, 'Tournament'),
            'tournament:' || p_tournament || ':' || p_student)
  ON CONFLICT (source_id) DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_finish_match(p_match uuid, p_winner uuid, p_how text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m public.tournament_matches%ROWTYPE;
  t public.tournaments%ROWTYPE;
  v_loser uuid;
  v_seed integer;
BEGIN
  UPDATE public.tournament_matches
     SET status = 'done', winner_id = p_winner, how = p_how, finished_at = now()
   WHERE id = p_match AND status <> 'done'
  RETURNING * INTO m;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO t FROM public.tournaments WHERE id = m.tournament_id;
  v_loser := CASE WHEN p_winner = m.a_id THEN m.b_id ELSE m.a_id END;
  v_seed := CASE WHEN p_winner = m.a_id THEN m.a_seed ELSE m.b_seed END;
  IF v_loser IS NOT NULL THEN
    UPDATE public.tournament_entries SET out_round = m.round
     WHERE tournament_id = t.id AND student_id = v_loser;
  END IF;

  IF m.round = t.rounds THEN
    PERFORM public.tournament_award(t.id, p_winner, 'champion');
    PERFORM public.tournament_award(t.id, v_loser, 'finalist');
    UPDATE public.tournaments SET status = 'done', champion_id = p_winner, finished_at = now() WHERE id = t.id;
    RETURN;
  END IF;
  IF m.round = t.rounds - 1 THEN
    PERFORM public.tournament_award(t.id, v_loser, 'semi');
  END IF;
  PERFORM public.tournament_place(t.id, m.round + 1, m.slot / 2,
    CASE WHEN m.slot % 2 = 0 THEN 'a' ELSE 'b' END, p_winner, v_seed);
END;
$function$;

-- Start at the start time, settle finished duels and missed check-ins. Safe to call often.
CREATE OR REPLACE FUNCTION public.tournament_tick(p_tournament uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tournaments%ROWTYPE;
  m public.tournament_matches%ROWTYPE;
  v_count integer;
  v_size integer;
  v_rounds integer;
  v_order integer[];
  v_a uuid; v_b uuid;
  v_status text; v_winner uuid;
  r integer; s integer;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament FOR UPDATE;
  IF NOT FOUND OR t.status IN ('done', 'cancelled') THEN RETURN; END IF;

  IF t.status = 'signup' THEN
    IF now() < t.start_at THEN RETURN; END IF;
    SELECT count(*) INTO v_count FROM public.tournament_entries WHERE tournament_id = t.id;
    IF v_count < 4 THEN
      UPDATE public.tournaments SET status = 'cancelled', finished_at = now(),
             note = 'Fewer than 4 players signed up.'
       WHERE id = t.id;
      RETURN;
    END IF;
    v_size := public.tournament_bracket_size(v_count, t.max_players);
    v_rounds := 0;
    r := v_size;
    WHILE r > 1 LOOP v_rounds := v_rounds + 1; r := r / 2; END LOOP;

    UPDATE public.tournament_entries e
       SET seed = x.rn, rating = x.rating
      FROM (SELECT e2.student_id, COALESCE(dr.rating, 1000) AS rating,
                   row_number() OVER (ORDER BY COALESCE(dr.rating, 1000) DESC, e2.joined_at, e2.student_id) AS rn
              FROM public.tournament_entries e2
              LEFT JOIN public.duel_ratings dr ON dr.student_id = e2.student_id
             WHERE e2.tournament_id = t.id) x
     WHERE e.tournament_id = t.id AND e.student_id = x.student_id;

    UPDATE public.tournaments SET status = 'running', bracket_size = v_size, rounds = v_rounds WHERE id = t.id;
    FOR r IN 1..v_rounds LOOP
      FOR s IN 0..(v_size / (2 ^ r)::integer) - 1 LOOP
        INSERT INTO public.tournament_matches (tournament_id, round, slot) VALUES (t.id, r, s)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;

    v_order := public.tournament_seed_order(v_size);
    FOR s IN 0..(v_size / 2) - 1 LOOP
      SELECT student_id INTO v_a FROM public.tournament_entries WHERE tournament_id = t.id AND seed = v_order[2 * s + 1];
      SELECT student_id INTO v_b FROM public.tournament_entries WHERE tournament_id = t.id AND seed = v_order[2 * s + 2];
      UPDATE public.tournament_matches
         SET a_id = v_a, a_seed = CASE WHEN v_a IS NOT NULL THEN v_order[2 * s + 1] END,
             b_id = v_b, b_seed = CASE WHEN v_b IS NOT NULL THEN v_order[2 * s + 2] END
       WHERE tournament_id = t.id AND round = 1 AND slot = s;
    END LOOP;
    SELECT * INTO t FROM public.tournaments WHERE id = t.id;

    FOR m IN SELECT * FROM public.tournament_matches WHERE tournament_id = t.id AND round = 1 ORDER BY slot LOOP
      IF m.a_id IS NULL OR m.b_id IS NULL THEN
        PERFORM public.tournament_finish_match(m.id, COALESCE(m.a_id, m.b_id), 'bye');
      ELSE
        -- Both known: re-place side b so the match becomes ready.
        UPDATE public.tournament_matches SET b_id = NULL WHERE id = m.id;
        PERFORM public.tournament_place(t.id, 1, m.slot, 'b', m.b_id, m.b_seed);
      END IF;
    END LOOP;
  END IF;

  FOR m IN SELECT * FROM public.tournament_matches
            WHERE tournament_id = t.id AND status IN ('ready', 'live') ORDER BY round, slot LOOP
    IF m.status = 'live' THEN
      IF m.duel_id IS NOT NULL THEN
        PERFORM public.live_duel_settle(m.duel_id);
      END IF;
      v_status := NULL; v_winner := NULL;
      SELECT d.status, d.winner_id INTO v_status, v_winner FROM public.live_duels d WHERE d.id = m.duel_id;
      IF v_status IS NULL OR v_status IN ('done', 'expired', 'cancelled', 'declined') THEN
        IF v_winner IS NOT NULL AND v_winner IN (m.a_id, m.b_id) THEN
          PERFORM public.tournament_finish_match(m.id, v_winner, 'duel');
        ELSE
          PERFORM public.tournament_finish_match(m.id,
            CASE WHEN COALESCE(m.a_seed, 99) <= COALESCE(m.b_seed, 99) THEN m.a_id ELSE m.b_id END, 'seed');
        END IF;
      END IF;
    ELSIF now() >= m.checkin_until THEN
      IF m.a_checked_in_at IS NOT NULL AND m.b_checked_in_at IS NULL THEN
        PERFORM public.tournament_finish_match(m.id, m.a_id, 'forfeit');
      ELSIF m.b_checked_in_at IS NOT NULL AND m.a_checked_in_at IS NULL THEN
        PERFORM public.tournament_finish_match(m.id, m.b_id, 'forfeit');
      ELSIF m.a_checked_in_at IS NULL OR now() >= m.checkin_until + interval '2 minutes' THEN
        -- Nobody came (or the duel never started): the higher seed goes through.
        PERFORM public.tournament_finish_match(m.id,
          CASE WHEN COALESCE(m.a_seed, 99) <= COALESCE(m.b_seed, 99) THEN m.a_id ELSE m.b_id END,
          CASE WHEN m.a_checked_in_at IS NULL THEN 'no_show' ELSE 'seed' END);
      END IF;
    END IF;
  END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Check-in (service role: the API creates the duel)
-- ---------------------------------------------------------------------------

-- Marks the student checked in. Returns start = true to exactly one caller once both are in.
CREATE OR REPLACE FUNCTION public.tournament_check_in(p_match uuid, p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m public.tournament_matches%ROWTYPE;
  t public.tournaments%ROWTYPE;
BEGIN
  SELECT tournament_id INTO m.tournament_id FROM public.tournament_matches WHERE id = p_match;
  IF m.tournament_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  PERFORM public.tournament_tick(m.tournament_id);
  SELECT * INTO m FROM public.tournament_matches WHERE id = p_match FOR UPDATE;
  SELECT * INTO t FROM public.tournaments WHERE id = m.tournament_id;
  IF p_student IS NULL OR p_student NOT IN (m.a_id, m.b_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_YOURS');
  END IF;
  IF m.status = 'live' THEN RETURN jsonb_build_object('ok', true, 'duel_id', m.duel_id); END IF;
  IF m.status <> 'ready' THEN RETURN jsonb_build_object('ok', false, 'code', 'CLOSED'); END IF;
  IF now() < m.ready_at THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_YET', 'ready_at', m.ready_at); END IF;
  IF now() >= m.checkin_until AND (m.a_checked_in_at IS NULL OR m.b_checked_in_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_LATE');
  END IF;

  UPDATE public.tournament_matches
     SET a_checked_in_at = CASE WHEN p_student = a_id THEN COALESCE(a_checked_in_at, now()) ELSE a_checked_in_at END,
         b_checked_in_at = CASE WHEN p_student = b_id THEN COALESCE(b_checked_in_at, now()) ELSE b_checked_in_at END
   WHERE id = m.id
  RETURNING * INTO m;

  IF m.a_checked_in_at IS NOT NULL AND m.b_checked_in_at IS NOT NULL AND m.duel_id IS NULL
     AND (m.start_claim_at IS NULL OR m.start_claim_at < now() - interval '20 seconds') THEN
    UPDATE public.tournament_matches SET start_claim_at = now() WHERE id = m.id;
    RETURN jsonb_build_object('ok', true, 'start', true, 'match_id', m.id,
      'a_id', m.a_id, 'b_id', m.b_id, 'level', t.level, 'centre_id', t.centre_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'start', false,
    'waiting', m.a_checked_in_at IS NULL OR m.b_checked_in_at IS NULL);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_attach_duel(p_match uuid, p_duel uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.tournament_matches SET status = 'live', duel_id = p_duel
   WHERE id = p_match AND status = 'ready' AND duel_id IS NULL;
  RETURN FOUND;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Student and staff RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tournament_card(t public.tournaments, p_me uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'id', t.id, 'name', t.name, 'level', t.level, 'status', t.status, 'max_players', t.max_players,
    'centre_id', t.centre_id,
    'centre_name', (SELECT c.name FROM public.centres c WHERE c.id = t.centre_id),
    'signup_opens_at', t.signup_opens_at, 'signup_closes_at', t.signup_closes_at,
    'start_at', t.start_at, 'round_minutes', t.round_minutes, 'rounds', t.rounds, 'note', t.note,
    'count', (SELECT count(*) FROM public.tournament_entries e WHERE e.tournament_id = t.id),
    'joined', EXISTS (SELECT 1 FROM public.tournament_entries e WHERE e.tournament_id = t.id AND e.student_id = p_me),
    'champion', (SELECT public.display_name_for(p.full_name, p.student_code) FROM public.profiles p WHERE p.id = t.champion_id),
    'my_match', (SELECT jsonb_build_object('id', m.id, 'round', m.round, 'status', m.status,
                   'ready_at', m.ready_at, 'checkin_until', m.checkin_until, 'duel_id', m.duel_id)
                   FROM public.tournament_matches m
                  WHERE m.tournament_id = t.id AND m.status IN ('ready', 'live') AND p_me IN (m.a_id, m.b_id)
                  ORDER BY m.round LIMIT 1)
  )
$function$;

-- The Tournaments tab: what I can sign up for, what I am in, recent results.
CREATE OR REPLACE FUNCTION public.my_tournaments()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  FOR v_id IN
    SELECT t.id FROM public.tournaments t
     WHERE (t.status = 'running' OR (t.status = 'signup' AND now() >= t.start_at))
       AND (public.tournament_visible(t, v_me)
            OR EXISTS (SELECT 1 FROM public.tournament_entries e WHERE e.tournament_id = t.id AND e.student_id = v_me))
  LOOP
    PERFORM public.tournament_tick(v_id);
  END LOOP;
  RETURN jsonb_build_object(
    'tournaments', COALESCE((
      SELECT jsonb_agg(public.tournament_card(t, v_me) ORDER BY
               CASE t.status WHEN 'running' THEN 0 WHEN 'signup' THEN 1 ELSE 2 END, t.start_at DESC)
        FROM public.tournaments t
       WHERE (public.tournament_visible(t, v_me)
              OR EXISTS (SELECT 1 FROM public.tournament_entries e WHERE e.tournament_id = t.id AND e.student_id = v_me))
         AND (t.status IN ('signup', 'running') OR t.finished_at > now() - interval '14 days')), '[]'::jsonb),
    'titles', (SELECT count(*) FROM public.tournaments t WHERE t.champion_id = v_me)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_join(p_tournament uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  t public.tournaments%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament FOR UPDATE;
  IF NOT FOUND OR NOT public.tournament_visible(t, v_me) THEN
    RAISE EXCEPTION 'This tournament is not open to you.';
  END IF;
  IF t.status <> 'signup' OR now() < t.signup_opens_at OR now() >= t.signup_closes_at THEN
    RAISE EXCEPTION 'Sign-up for this tournament is closed.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_entries WHERE tournament_id = t.id AND student_id = v_me) THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF (SELECT count(*) FROM public.tournament_entries WHERE tournament_id = t.id) >= t.max_players THEN
    RAISE EXCEPTION 'This tournament is full.';
  END IF;
  INSERT INTO public.tournament_entries (tournament_id, student_id) VALUES (t.id, v_me);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_leave(p_tournament uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  DELETE FROM public.tournament_entries e
   USING public.tournaments t
   WHERE t.id = e.tournament_id AND e.tournament_id = p_tournament AND e.student_id = v_me
     AND t.status = 'signup' AND now() < t.start_at;
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

-- The bracket. Entrants, students who can see the tournament, and its managers.
CREATE OR REPLACE FUNCTION public.tournament_state(p_tournament uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  t public.tournaments%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM public.tournament_tick(p_tournament);
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT (public.tournament_visible(t, v_me)
          OR EXISTS (SELECT 1 FROM public.tournament_entries e WHERE e.tournament_id = t.id AND e.student_id = v_me)
          OR public.tournament_can_manage(t.centre_id)
          OR (public.is_teacher(v_me) AND (t.centre_id IS NULL OR t.centre_id = public.my_centre()))) THEN
    RETURN NULL;
  END IF;
  RETURN public.tournament_card(t, v_me) || jsonb_build_object(
    'server_now', now(),
    'bracket_size', t.bracket_size,
    'can_manage', public.tournament_can_manage(t.centre_id),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', e.student_id, 'me', e.student_id = v_me, 'seed', e.seed, 'rating', e.rating,
               'name', public.display_name_for(p.full_name, p.student_code),
               'avatar', public.avatar_visible(p.id, p.avatar_path),
               'out_round', e.out_round, 'finish', e.finish)
             ORDER BY e.seed NULLS LAST, e.joined_at)
        FROM public.tournament_entries e JOIN public.profiles p ON p.id = e.student_id
       WHERE e.tournament_id = t.id), '[]'::jsonb),
    'matches', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id, 'round', m.round, 'slot', m.slot, 'status', m.status,
               'a_id', m.a_id, 'b_id', m.b_id, 'a_seed', m.a_seed, 'b_seed', m.b_seed,
               'ready_at', m.ready_at, 'checkin_until', m.checkin_until,
               'a_in', m.a_checked_in_at IS NOT NULL, 'b_in', m.b_checked_in_at IS NOT NULL,
               'duel_id', m.duel_id, 'winner_id', m.winner_id, 'how', m.how,
               'a_correct', d.a_correct, 'b_correct', d.b_correct)
             ORDER BY m.round, m.slot)
        FROM public.tournament_matches m
        LEFT JOIN public.live_duels d ON d.id = m.duel_id
       WHERE m.tournament_id = t.id), '[]'::jsonb)
  );
END;
$function$;

-- Staff: tournaments I can see or manage, and what I may create.
CREATE OR REPLACE FUNCTION public.tournaments_staff()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_net boolean := public.is_network_admin();
  v_centre uuid := public.my_centre();
  v_head boolean := v_centre IS NOT NULL AND public.is_centre_head(v_centre);
  v_id uuid;
BEGIN
  IF v_me IS NULL OR NOT (v_net OR v_head OR public.is_teacher(v_me)) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  FOR v_id IN
    SELECT t.id FROM public.tournaments t
     WHERE (t.status = 'running' OR (t.status = 'signup' AND now() >= t.start_at))
       AND (v_net OR t.centre_id IS NULL OR t.centre_id = v_centre)
  LOOP
    PERFORM public.tournament_tick(v_id);
  END LOOP;
  RETURN jsonb_build_object(
    'can_create', v_net OR v_head,
    'all_centres', v_net,
    'centres', CASE WHEN v_net THEN COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name)
          FROM public.centres c WHERE c.status = 'active'), '[]'::jsonb)
      WHEN v_head THEN COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)) FROM public.centres c WHERE c.id = v_centre), '[]'::jsonb)
      ELSE '[]'::jsonb END,
    'levels', COALESCE((
      SELECT jsonb_agg(l ORDER BY l) FROM (
        SELECT DISTINCT p.level AS l FROM public.profiles p
         WHERE p.role = 'student' AND p.level IS NOT NULL AND btrim(p.level) <> ''
           AND (v_net OR p.centre_id = v_centre)) x), '[]'::jsonb),
    'tournaments', COALESCE((
      SELECT jsonb_agg(public.tournament_card(t, v_me)
               || jsonb_build_object('can_manage', public.tournament_can_manage(t.centre_id))
             ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'signup' THEN 1 ELSE 2 END, t.start_at DESC)
        FROM public.tournaments t
       WHERE (v_net OR t.centre_id IS NULL OR t.centre_id = v_centre)
         AND (t.status IN ('signup', 'running') OR t.created_at > now() - interval '60 days')), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_create(p_name text, p_level text, p_max_players integer,
  p_centre uuid, p_signup_opens_at timestamptz, p_signup_closes_at timestamptz, p_start_at timestamptz,
  p_round_minutes integer DEFAULT 10)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_centre IS NULL AND NOT public.is_network_admin() THEN
    RAISE EXCEPTION 'Only owners and directors can run a tournament for every centre.';
  END IF;
  IF NOT public.tournament_can_manage(p_centre) THEN
    RAISE EXCEPTION 'Only admins, directors and centre heads can create tournaments.';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 3 AND 60 THEN
    RAISE EXCEPTION 'Give the tournament a name of 3 to 60 characters.';
  END IF;
  IF p_level IS NULL OR btrim(p_level) = '' THEN RAISE EXCEPTION 'Choose a level.'; END IF;
  IF p_max_players IS NULL OR p_max_players NOT IN (8, 16, 32) THEN RAISE EXCEPTION 'Choose 8, 16 or 32 players.'; END IF;
  IF p_signup_opens_at IS NULL OR p_signup_closes_at IS NULL OR p_start_at IS NULL
     OR p_signup_opens_at >= p_signup_closes_at OR p_signup_closes_at > p_start_at THEN
    RAISE EXCEPTION 'Sign-up must open before it closes, and close by the start time.';
  END IF;
  IF p_start_at < now() THEN RAISE EXCEPTION 'The start time is in the past.'; END IF;
  IF COALESCE(p_round_minutes, 10) NOT BETWEEN 5 AND 60 THEN RAISE EXCEPTION 'Rounds must be 5 to 60 minutes apart.'; END IF;
  INSERT INTO public.tournaments (name, level, max_players, centre_id, signup_opens_at, signup_closes_at,
                                  start_at, round_minutes, created_by)
  VALUES (btrim(p_name), btrim(p_level), p_max_players, p_centre, p_signup_opens_at, p_signup_closes_at,
          p_start_at, COALESCE(p_round_minutes, 10), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tournament_cancel(p_tournament uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.tournaments%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament FOR UPDATE;
  IF NOT FOUND OR NOT public.tournament_can_manage(t.centre_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF t.status NOT IN ('signup', 'running') THEN RAISE EXCEPTION 'This tournament has already finished.'; END IF;
  UPDATE public.tournaments SET status = 'cancelled', finished_at = now(), note = 'Cancelled by staff.' WHERE id = t.id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.tournament_place(uuid, integer, integer, text, uuid, integer),
  public.tournament_award(uuid, uuid, text), public.tournament_finish_match(uuid, uuid, text),
  public.tournament_tick(uuid), public.tournament_check_in(uuid, uuid), public.tournament_attach_duel(uuid, uuid),
  public.tournament_card(public.tournaments, uuid), public.tournament_visible(public.tournaments, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tournament_tick(uuid), public.tournament_check_in(uuid, uuid),
  public.tournament_attach_duel(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.my_tournaments(), public.tournament_join(uuid), public.tournament_leave(uuid),
  public.tournament_state(uuid), public.tournaments_staff(),
  public.tournament_create(text, text, integer, uuid, timestamptz, timestamptz, timestamptz, integer),
  public.tournament_cancel(uuid), public.tournament_can_manage(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_tournaments(), public.tournament_join(uuid), public.tournament_leave(uuid),
  public.tournament_state(uuid), public.tournaments_staff(),
  public.tournament_create(text, text, integer, uuid, timestamptz, timestamptz, timestamptz, integer),
  public.tournament_cancel(uuid), public.tournament_can_manage(uuid)
  TO authenticated;
