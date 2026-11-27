-- Phase 35: fairer live duel ratings, and live duels open to every centre.
--
--   * Rating moves with the winning margin. The winner scores 0.5 + margin/16
--     (a full win from an 8-answer margin; a win on time with equal answers counts
--     as a 0.5-answer margin), then the usual Elo with K 24 (12 against ghosts).
--     Winners never lose rating and losers never gain it. Losing 14-16 to an equal
--     player now costs 3, not 12. Mirrors shared/liveDuel.js liveDuelRatingDelta().
--   * live_duel_online_players(ids): the lobby shows only students who are online
--     (Realtime presence, tracked on every signed-in student page). This returns
--     names, visible avatars and centre names for those ids: same level, any centre,
--     active and shown on leaderboards. Nobody else is listed.
--   * Live challenges and quick match work across centres (api/_liveDuels.js).

CREATE OR REPLACE FUNCTION public.live_duel_rating_delta(
  p_rating integer, p_other integer, p_outcome text, p_margin integer, p_k numeric)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH s AS (
    SELECT CASE p_outcome
             WHEN 'draw' THEN 0.5
             WHEN 'win' THEN 0.5 + LEAST(0.5, GREATEST(0.5, abs(COALESCE(p_margin, 0)))::numeric / 16)
             ELSE 0.5 - LEAST(0.5, GREATEST(0.5, abs(COALESCE(p_margin, 0)))::numeric / 16)
           END AS score
  ), d AS (
    SELECT round(p_k * (s.score - 1 / (1 + power(10::numeric, (p_other - p_rating)::numeric / 400))))::integer AS v FROM s
  )
  SELECT CASE p_outcome WHEN 'win' THEN GREATEST(1, d.v) WHEN 'loss' THEN LEAST(0, d.v) ELSE d.v END FROM d;
$function$;

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
  v_margin integer;
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
    v_margin := abs(COALESCE(d.a_correct, 0) - COALESCE(v_bc, 0));
    v_ad := public.live_duel_rating_delta(v_ar, v_br,
              CASE v_result WHEN 'a' THEN 'win' WHEN 'b' THEN 'loss' ELSE 'draw' END, v_margin,
              CASE WHEN v_ghost THEN 12 ELSE 24 END);
    UPDATE public.duel_ratings
       SET rating = GREATEST(100, rating + v_ad), played = played + 1,
           won = won + (v_result = 'a')::int, drawn = drawn + (v_result = 'draw')::int,
           lost = lost + (v_result = 'b')::int, updated_at = now()
     WHERE student_id = d.a_id;
    IF NOT v_ghost THEN
      v_bd := public.live_duel_rating_delta(v_br, v_ar,
                CASE v_result WHEN 'b' THEN 'win' WHEN 'a' THEN 'loss' ELSE 'draw' END, v_margin, 24);
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

-- A centre's name, once the multi-centre tables exist (NULL before that).
CREATE OR REPLACE FUNCTION public.live_duel_centre_name(p_centre uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v text;
BEGIN
  IF p_centre IS NULL OR to_regclass('public.centres') IS NULL THEN RETURN NULL; END IF;
  EXECUTE 'SELECT name FROM public.centres WHERE id = $1' INTO v USING p_centre;
  RETURN v;
END;
$function$;

-- Who these online ids are, for the live duel lobby: students at my level, any centre.
CREATE OR REPLACE FUNCTION public.live_duel_online_players(p_ids uuid[])
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
  SELECT level INTO v_level FROM public.profiles WHERE id = v_me AND role = 'student';
  IF v_level IS NULL OR p_ids IS NULL THEN RETURN '[]'::jsonb; END IF;
  v_centre := public.live_duel_centre_of(v_me);
  RETURN COALESCE((
    SELECT jsonb_agg(x.j ORDER BY x.mate DESC, x.name)
      FROM (
        SELECT public.display_name_for(p.full_name, p.student_code) AS name,
               public.live_duel_centre_of(p.id) IS NOT DISTINCT FROM v_centre AS mate,
               jsonb_build_object(
                 'id', p.id,
                 'display_name', public.display_name_for(p.full_name, p.student_code),
                 'avatar_path', public.avatar_visible(p.id, p.avatar_path),
                 'centre_name', public.live_duel_centre_name(public.live_duel_centre_of(p.id)),
                 'classmate', public.live_duel_centre_of(p.id) IS NOT DISTINCT FROM v_centre,
                 'rating', COALESCE((SELECT r.rating FROM public.duel_ratings r WHERE r.student_id = p.id), 1000)) AS j
          FROM public.profiles p
         WHERE p.id = ANY (p_ids[1:300]) AND p.id <> v_me
           AND p.role = 'student' AND p.active AND p.leaderboard_visible
           AND p.level IS NOT DISTINCT FROM v_level) x), '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.live_duel_rating_delta(integer, integer, text, integer, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.live_duel_centre_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_online_players(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.live_duel_online_players(uuid[]) TO authenticated;
