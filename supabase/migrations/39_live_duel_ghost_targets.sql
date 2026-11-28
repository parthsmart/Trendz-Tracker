-- Phase 39: Ghost race targets on the Live Duel page.
--
--   * "Beat my best" and "Race a topper" ghost races (live_duels.ghost->>'target'
--     is 'best' or 'topper') are unrated: no rating change and no played/won count,
--     so nobody can farm rating off a weak old run. XP still comes from
--     live_duel_award_xp: the halved ghost bonus, at most 10 bonuses a day.
--   * live_duel_state also returns other.target and other.target_correct so the
--     results screen can say "New personal best!" and "Not rated".
--   * Quick-match ghosts (no target) keep the K 12 rating from phase 35.

CREATE OR REPLACE FUNCTION public.live_duel_settle(p_duel uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  d public.live_duels%ROWTYPE;
  v_ghost boolean;
  v_unrated boolean;
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
  v_unrated := v_ghost AND COALESCE(d.ghost->>'target', '') IN ('best', 'topper');
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
    IF NOT v_unrated THEN
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
    END IF;

    v_axp := public.live_duel_award_xp(d, 'a', v_result, v_day);
    IF NOT v_ghost THEN
      v_bxp := public.live_duel_award_xp(d, 'b', v_result, v_day);
    END IF;

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
      'timeline', CASE WHEN v_other IS NULL AND v_started THEN d.ghost->'timeline' END,
      'target', CASE WHEN v_other IS NULL THEN d.ghost->>'target' END,
      'target_correct', CASE WHEN v_other IS NULL THEN (d.ghost->>'target_correct')::int END),
    'result', CASE WHEN d.result IS NULL THEN NULL
                   WHEN d.status = 'expired' THEN 'none'  -- untouched ghost race: does not count
                   WHEN d.result IN ('draw', 'none') THEN d.result
                   WHEN d.result = v_side THEN 'won' ELSE 'lost' END,
    'rematch_id', d.rematch_id
  );
END;
$function$;
