-- Phase 40: Battle royale on the Live Duel page.
--
--   * Up to 20 students at one level, from any centre. The API (action
--     'royale_join') creates the game with 12 rounds of questions and the answer
--     key, and adds players. A game starts 20 seconds after 4 are waiting, or at
--     its scheduled half-hour slot with 2 or more (otherwise it moves to the next
--     slot).
--   * Rounds of 30 seconds with the same questions for everyone. Answers go to
--     royale_answer, which grades them on the server, keeps them in order and
--     refuses answers faster than 250 ms each (the player is flagged).
--   * After each round the players still in are ranked by correct answers, then by
--     who got there first; the bottom quarter (at least 1, and everyone who did not
--     answer) is out. Mirrors shared/royale.js. The last one standing wins.
--   * The game moves on lazily: royale_state, my_royale and royale_answer call
--     royale_tick, like live_duel_settle for duels.
--   * XP by place (30 / 20 / 15, top half 10, others 5) on top of the usual answer
--     XP, and a 'royale_win' badge for the winner. Unrated.
--   * Tables are reached only through these SECURITY DEFINER functions and the API.

CREATE TABLE IF NOT EXISTS public.royale_games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'live', 'done')),
  category_id uuid,
  category_name text NOT NULL,
  seed bigint NOT NULL,
  round_seconds integer NOT NULL DEFAULT 30,
  break_seconds integer NOT NULL DEFAULT 6,
  max_players integer NOT NULL DEFAULT 20,
  rounds jsonb NOT NULL DEFAULT '[]'::jsonb,
  round integer NOT NULL DEFAULT 0,
  round_start_at timestamptz,
  round_end_at timestamptz,
  start_at timestamptz NOT NULL,
  winner_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS royale_games_one_waiting ON public.royale_games (level) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS royale_games_status_idx ON public.royale_games (status, level);

CREATE TABLE IF NOT EXISTS public.royale_keys (
  game_id uuid PRIMARY KEY REFERENCES public.royale_games (id) ON DELETE CASCADE,
  expected jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.royale_players (
  game_id uuid NOT NULL REFERENCES public.royale_games (id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  alive boolean NOT NULL DEFAULT true,
  out_round integer,
  place integer,
  round_correct integer NOT NULL DEFAULT 0,
  round_attempted integer NOT NULL DEFAULT 0,
  round_last_ms integer,
  last_round_correct integer,
  total_correct integer NOT NULL DEFAULT 0,
  total_attempted integer NOT NULL DEFAULT 0,
  flagged boolean NOT NULL DEFAULT false,
  xp integer,
  PRIMARY KEY (game_id, student_id)
);
CREATE INDEX IF NOT EXISTS royale_players_student_idx ON public.royale_players (student_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS public.royale_answers (
  game_id uuid NOT NULL REFERENCES public.royale_games (id) ON DELETE CASCADE,
  round integer NOT NULL,
  student_id uuid NOT NULL,
  q_index integer NOT NULL,
  answer text,
  correct boolean NOT NULL,
  ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, round, student_id, q_index)
);

ALTER TABLE public.royale_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royale_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royale_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royale_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.royale_games, public.royale_keys, public.royale_players, public.royale_answers FROM anon, authenticated;
GRANT ALL ON public.royale_games, public.royale_keys, public.royale_players, public.royale_answers TO service_role;

DO $badge$
BEGIN
  IF to_regclass('public.badge_catalogue') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.badge_catalogue (key, name, icon, description, category, sort_order) VALUES
        ('royale_win', 'Royale winner', '👑', 'Be the last one standing in a battle royale.', 'duel', 93)
      ON CONFLICT (key) DO UPDATE
        SET name = EXCLUDED.name, icon = EXCLUDED.icon, description = EXCLUDED.description,
            category = EXCLUDED.category, sort_order = EXCLUDED.sort_order
    $sql$;
  END IF;
END
$badge$;

-- Next scheduled start: every 30 minutes on the half hour.
CREATE OR REPLACE FUNCTION public.royale_next_slot(p_at timestamptz)
 RETURNS timestamptz
 LANGUAGE sql
 IMMUTABLE
AS $$ SELECT to_timestamp(ceil(extract(epoch FROM p_at) / 1800) * 1800) $$;

-- How many go out: a quarter, at least 1 and every idle player, never the last one.
CREATE OR REPLACE FUNCTION public.royale_out_count(p_alive integer, p_idle integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $$
  SELECT CASE WHEN COALESCE(p_alive, 0) <= 1 THEN 0
              ELSE LEAST(p_alive - 1, GREATEST(1, floor(p_alive * 0.25)::integer, COALESCE(p_idle, 0))) END
$$;

CREATE OR REPLACE FUNCTION public.royale_place_xp(p_place integer, p_size integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $$
  SELECT CASE WHEN p_place = 1 THEN 30 WHEN p_place = 2 THEN 20 WHEN p_place = 3 THEN 15
              WHEN p_place > 0 AND p_place <= ceil(p_size / 2.0) THEN 10 ELSE 5 END
$$;

-- Ends the game: places for whoever is still in, XP for everyone who answered, the winner badge.
CREATE OR REPLACE FUNCTION public.royale_finish(p_game uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g public.royale_games%ROWTYPE;
  p record;
  v_size integer;
  v_day date := public.today_ist();
  v_src text;
  v_xp integer;
  v_winner uuid;
BEGIN
  SELECT * INTO g FROM public.royale_games WHERE id = p_game;
  WITH r AS (
    SELECT student_id, row_number() OVER (
             ORDER BY last_round_correct DESC NULLS LAST, total_correct DESC, total_attempted ASC, joined_at ASC) AS rn
      FROM public.royale_players WHERE game_id = p_game AND alive)
  UPDATE public.royale_players pl
     SET place = r.rn, alive = (r.rn = 1), out_round = CASE WHEN r.rn = 1 THEN NULL ELSE g.round END
    FROM r
   WHERE pl.game_id = p_game AND pl.student_id = r.student_id;
  SELECT count(*) INTO v_size FROM public.royale_players WHERE game_id = p_game;
  SELECT student_id INTO v_winner FROM public.royale_players WHERE game_id = p_game AND place = 1;

  FOR p IN SELECT * FROM public.royale_players WHERE game_id = p_game LOOP
    v_xp := 0;
    IF p.total_attempted > 0 THEN
      v_src := 'royale:' || p_game::text || ':' || p.student_id::text;
      PERFORM public.xp_award(p.student_id, 'duel', v_src, 'duel:' || COALESCE(g.category_id::text, 'royale'),
        'Battle royale · ' || g.category_name, p.total_correct, p.total_attempted,
        g.round_seconds * GREATEST(g.round, 1), v_day, false, NULL,
        '#' || p.place || ' of ' || v_size, now());
      UPDATE public.student_xp_events
         SET bonus_xp = bonus_xp + public.royale_place_xp(p.place, v_size),
             xp = xp + public.royale_place_xp(p.place, v_size)
       WHERE source = 'duel' AND source_id = v_src;
      SELECT xp INTO v_xp FROM public.student_xp_events WHERE source = 'duel' AND source_id = v_src;
    END IF;
    UPDATE public.royale_players SET xp = COALESCE(v_xp, 0) WHERE game_id = p_game AND student_id = p.student_id;
  END LOOP;

  IF v_winner IS NOT NULL THEN
    INSERT INTO public.student_badges (student_id, badge_key) VALUES (v_winner, 'royale_win') ON CONFLICT DO NOTHING;
  END IF;
  UPDATE public.royale_games
     SET status = 'done', winner_id = v_winner, finished_at = now(), round_end_at = LEAST(round_end_at, now())
   WHERE id = p_game;
END;
$function$;

-- Closes the current round: the bottom quarter goes out, then the next round or the end.
CREATE OR REPLACE FUNCTION public.royale_settle_round(p_game uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g public.royale_games%ROWTYPE;
  v_alive integer;
  v_idle integer;
  v_out integer;
  v_rounds integer;
BEGIN
  SELECT * INTO g FROM public.royale_games WHERE id = p_game;
  SELECT count(*), count(*) FILTER (WHERE round_attempted = 0) INTO v_alive, v_idle
    FROM public.royale_players WHERE game_id = p_game AND alive;
  v_out := public.royale_out_count(v_alive, v_idle);
  WITH ranked AS (
    SELECT student_id, row_number() OVER (
             ORDER BY round_correct DESC, round_last_ms ASC NULLS LAST, (round_attempted = 0) ASC, round_attempted ASC,
                      total_correct DESC, joined_at ASC) AS rn
      FROM public.royale_players WHERE game_id = p_game AND alive)
  UPDATE public.royale_players pl
     SET alive = false, out_round = g.round, place = ranked.rn
    FROM ranked
   WHERE pl.game_id = p_game AND pl.student_id = ranked.student_id AND ranked.rn > v_alive - v_out;
  UPDATE public.royale_players
     SET last_round_correct = CASE WHEN alive OR out_round = g.round THEN round_correct ELSE last_round_correct END,
         round_correct = 0, round_attempted = 0, round_last_ms = NULL
   WHERE game_id = p_game;

  SELECT jsonb_array_length(expected) INTO v_rounds FROM public.royale_keys WHERE game_id = p_game;
  IF v_alive - v_out <= 1 OR g.round >= COALESCE(v_rounds, 0) THEN
    PERFORM public.royale_finish(p_game);
  ELSE
    UPDATE public.royale_games
       SET round = round + 1,
           round_start_at = now() + make_interval(secs => break_seconds),
           round_end_at = now() + make_interval(secs => break_seconds + round_seconds)
     WHERE id = p_game;
  END IF;
END;
$function$;

-- Moves a game along: start it, close a finished round.
CREATE OR REPLACE FUNCTION public.royale_tick(p_game uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g public.royale_games%ROWTYPE;
  v_n integer;
BEGIN
  SELECT * INTO g FROM public.royale_games WHERE id = p_game FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF g.status = 'waiting' AND now() >= g.start_at THEN
    SELECT count(*) INTO v_n FROM public.royale_players WHERE game_id = g.id;
    IF v_n >= 2 THEN
      UPDATE public.royale_games
         SET status = 'live', round = 1,
             round_start_at = now() + interval '5 seconds',
             round_end_at = now() + interval '5 seconds' + make_interval(secs => round_seconds)
       WHERE id = g.id;
    ELSE
      UPDATE public.royale_games SET start_at = public.royale_next_slot(now() + interval '1 second') WHERE id = g.id;
    END IF;
  ELSIF g.status = 'live' AND now() >= g.round_end_at + interval '2 seconds' THEN
    PERFORM public.royale_settle_round(g.id);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.royale_answer(p_game uuid, p_index integer, p_answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  g public.royale_games%ROWTYPE;
  pl public.royale_players%ROWTYPE;
  v_expected text;
  v_pool integer;
  v_ms integer;
  v_ok boolean;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM public.royale_tick(p_game);
  SELECT * INTO g FROM public.royale_games WHERE id = p_game;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  SELECT * INTO pl FROM public.royale_players WHERE game_id = p_game AND student_id = v_me FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  IF NOT pl.alive THEN RETURN jsonb_build_object('ok', false, 'code', 'OUT'); END IF;
  IF g.status <> 'live' OR now() < g.round_start_at THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_STARTED');
  END IF;
  IF now() > g.round_end_at + interval '2 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TIME_UP');
  END IF;
  IF p_index IS NULL OR p_index <> pl.round_attempted THEN
    RETURN jsonb_build_object('ok', false, 'code', 'OUT_OF_ORDER', 'attempted', pl.round_attempted);
  END IF;
  SELECT k.expected -> (g.round - 1) ->> p_index, jsonb_array_length(k.expected -> (g.round - 1))
    INTO v_expected, v_pool FROM public.royale_keys k WHERE k.game_id = g.id;
  IF v_pool IS NULL OR p_index >= v_pool THEN RETURN jsonb_build_object('ok', false, 'code', 'POOL_DONE'); END IF;
  IF length(COALESCE(p_answer, '')) > 20 THEN RETURN jsonb_build_object('ok', false, 'code', 'BAD_ANSWER'); END IF;
  v_ms := LEAST(g.round_seconds * 1000, GREATEST(0, floor(extract(epoch FROM (now() - g.round_start_at)) * 1000)::integer));
  IF v_ms < (p_index + 1) * 250 THEN
    UPDATE public.royale_players SET flagged = true WHERE game_id = g.id AND student_id = v_me;
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_FAST');
  END IF;
  v_ok := public.live_duel_grade(p_answer, v_expected);
  INSERT INTO public.royale_answers (game_id, round, student_id, q_index, answer, correct, ms)
    VALUES (g.id, g.round, v_me, p_index, left(COALESCE(p_answer, ''), 20), v_ok, v_ms);
  UPDATE public.royale_players
     SET round_attempted = round_attempted + 1, round_correct = round_correct + v_ok::int,
         round_last_ms = CASE WHEN v_ok THEN v_ms ELSE round_last_ms END,
         total_attempted = total_attempted + 1, total_correct = total_correct + v_ok::int
   WHERE game_id = g.id AND student_id = v_me
   RETURNING * INTO pl;
  RETURN jsonb_build_object('ok', true, 'correct', v_ok, 'round_correct', pl.round_correct, 'round_attempted', pl.round_attempted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.royale_state(p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  g public.royale_games%ROWTYPE;
  pl public.royale_players%ROWTYPE;
  v_started boolean;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM public.royale_tick(p_game);
  SELECT * INTO g FROM public.royale_games WHERE id = p_game;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO pl FROM public.royale_players WHERE game_id = p_game AND student_id = v_me;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_started := g.status = 'live' AND now() >= g.round_start_at;
  RETURN jsonb_build_object(
    'id', g.id, 'status', g.status, 'level', g.level, 'category_name', g.category_name,
    'server_now', now(), 'start_at', g.start_at, 'round', g.round,
    'round_start_at', g.round_start_at, 'round_end_at', g.round_end_at,
    'round_seconds', g.round_seconds, 'max_players', g.max_players,
    'questions', CASE WHEN v_started AND pl.alive THEN g.rounds -> (g.round - 1) END,
    'me', jsonb_build_object(
      'alive', pl.alive, 'place', pl.place, 'out_round', pl.out_round,
      'round_correct', pl.round_correct, 'round_attempted', pl.round_attempted,
      'last_round_correct', pl.last_round_correct, 'total_correct', pl.total_correct, 'xp', pl.xp),
    'players', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.student_id, 'me', p.student_id = v_me,
               'name', public.display_name_for(pr.full_name, pr.student_code),
               'avatar', public.avatar_visible(pr.id, pr.avatar_path),
               'alive', p.alive, 'out_round', p.out_round, 'place', p.place,
               'correct', p.round_correct, 'last', p.last_round_correct)
             ORDER BY p.alive DESC, p.place ASC NULLS FIRST, p.joined_at)
        FROM public.royale_players p JOIN public.profiles pr ON pr.id = p.student_id
       WHERE p.game_id = g.id), '[]'::jsonb),
    'winner', (SELECT public.display_name_for(pr.full_name, pr.student_code) FROM public.profiles pr WHERE pr.id = g.winner_id)
  );
END;
$function$;

-- The Battle royale tab: my game in progress, the waiting game at my level, recent places.
CREATE OR REPLACE FUNCTION public.my_royale()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_wait uuid;
  v_active uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT level INTO v_level FROM public.profiles WHERE id = v_me;
  SELECT id INTO v_wait FROM public.royale_games WHERE status = 'waiting' AND level = v_level LIMIT 1;
  IF v_wait IS NOT NULL THEN PERFORM public.royale_tick(v_wait); END IF;
  SELECT g.id INTO v_active
    FROM public.royale_players p JOIN public.royale_games g ON g.id = p.game_id
   WHERE p.student_id = v_me AND g.status IN ('waiting', 'live')
   ORDER BY p.joined_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'active', v_active,
    'level', v_level,
    'next_slot', public.royale_next_slot(now()),
    'waiting', (SELECT jsonb_build_object('start_at', g.start_at,
                  'count', (SELECT count(*) FROM public.royale_players p WHERE p.game_id = g.id))
                  FROM public.royale_games g WHERE g.status = 'waiting' AND g.level = v_level LIMIT 1),
    'wins', (SELECT count(*) FROM public.royale_games WHERE winner_id = v_me),
    'recent', COALESCE((
      SELECT jsonb_agg(r ORDER BY r.finished_at DESC) FROM (
        SELECT g.finished_at, p.place, p.xp, g.category_name,
               (SELECT count(*) FROM public.royale_players q WHERE q.game_id = g.id) AS size
          FROM public.royale_players p JOIN public.royale_games g ON g.id = p.game_id
         WHERE p.student_id = v_me AND g.status = 'done'
         ORDER BY g.finished_at DESC LIMIT 5) r), '[]'::jsonb)
  );
END;
$function$;

-- Leave a game that has not started yet.
CREATE OR REPLACE FUNCTION public.royale_leave(p_game uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  DELETE FROM public.royale_players p
   USING public.royale_games g
   WHERE p.game_id = p_game AND p.student_id = v_me AND g.id = p.game_id AND g.status = 'waiting';
  RETURN jsonb_build_object('ok', FOUND);
END;
$function$;

REVOKE ALL ON FUNCTION public.royale_finish(uuid), public.royale_settle_round(uuid), public.royale_tick(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royale_answer(uuid, integer, text), public.royale_state(uuid), public.my_royale(), public.royale_leave(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.royale_answer(uuid, integer, text), public.royale_state(uuid), public.my_royale(), public.royale_leave(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.royale_tick(uuid) TO service_role;
