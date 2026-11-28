-- Rollback for migration 43 (multi-centre step 5c, cross-centre live duels).
-- Puts back the definitions that were live before 43 (from migrations 31 and 35:
-- the lobby lists every centre and any two centres can be paired), then removes
-- the three helper functions. No data is touched. Safe to run more than once.

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

DROP FUNCTION IF EXISTS public.live_duel_pairable_ids(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.live_duel_pairable(uuid, uuid);
DROP FUNCTION IF EXISTS public.live_duel_visible_to(uuid, uuid);
