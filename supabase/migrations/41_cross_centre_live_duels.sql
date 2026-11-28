-- Multi-centre step 5c: live duels across centres follow the directors' duel grants.
--
-- Before this, the live duel lobby listed online students of every centre at your
-- level, and a live challenge or quick match could pair any two centres. Now a
-- student of another centre is listed, challenged, matched or accepted only when
-- BOTH centres have opened that student to the other in centre_visibility
-- (written by owners and directors only; purpose 'duels'):
--
--   live_duel_visible_to(student, viewer_centre)
--       true for the student's own centre; for another centre, true only when the
--       student is active, shown on leaderboards, their centre is active, and an
--       unexpired grant from their centre covers the viewer centre (or every
--       centre) with mode 'all', 'students' (they are listed) or 'top_n' (they are
--       in the centre's top N by total XP).
--   live_duel_pairable(a, b)         same centre, or each visible to the other's centre.
--   live_duel_pairable_ids(me, ids)  the ids that are pairable with me (for the API).
--   live_duel_online_players(ids)    lists only pairable students.
--   live_duel_respond(duel, accept)  an accept is refused once the pair is no longer
--                                    pairable (a grant was removed after the invite).
--   live_duel_claim_pair(a, b)       quick match never pairs students who are not pairable.
--
-- Students of the same centre duel exactly as before. Async duels stay inside a
-- centre (migration 37). Ghost runs stay inside a centre (api/_liveDuels.js).
-- No table changes and no data changes.
-- Rollback: supabase/rollbacks/41_cross_centre_live_duels_rollback.sql

-- 1. Visibility helpers (service role and SECURITY DEFINER callers only) -----------

CREATE OR REPLACE FUNCTION public.live_duel_visible_to(p_student uuid, p_viewer_centre uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = p_student
       AND (
         p.centre_id IS NOT DISTINCT FROM p_viewer_centre
         OR (
           p_viewer_centre IS NOT NULL AND p.centre_id IS NOT NULL
           AND p.role = 'student' AND p.active AND p.leaderboard_visible
           AND EXISTS (SELECT 1 FROM public.centres c WHERE c.id = p.centre_id AND c.status = 'active')
           AND EXISTS (SELECT 1 FROM public.centres c WHERE c.id = p_viewer_centre AND c.status = 'active')
           AND EXISTS (
             SELECT 1 FROM public.centre_visibility v
              WHERE v.source_centre_id = p.centre_id
                AND v.purpose = 'duels'
                AND (v.viewer_centre_id IS NULL OR v.viewer_centre_id = p_viewer_centre)
                AND (v.expires_at IS NULL OR v.expires_at > now())
                AND (v.mode = 'all'
                     OR (v.mode = 'students' AND p.id = ANY (v.student_ids))
                     OR (v.mode = 'top_n' AND p.id IN (
                           SELECT q.id
                             FROM public.profiles q
                            WHERE q.centre_id = p.centre_id AND q.role = 'student'
                              AND q.active AND q.leaderboard_visible
                            ORDER BY (SELECT COALESCE(sum(x.xp), 0) FROM public.student_xp_events x
                                       WHERE x.student_id = q.id) DESC, q.id
                            LIMIT v.top_n))))
         )
       )
  );
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_pairable(p_a uuid, p_b uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_a IS NOT NULL AND p_b IS NOT NULL AND p_a <> p_b
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_a)
     AND EXISTS (SELECT 1 FROM public.profiles WHERE id = p_b)
     AND public.live_duel_visible_to(p_b, (SELECT centre_id FROM public.profiles WHERE id = p_a))
     AND public.live_duel_visible_to(p_a, (SELECT centre_id FROM public.profiles WHERE id = p_b));
$function$;

CREATE OR REPLACE FUNCTION public.live_duel_pairable_ids(p_me uuid, p_ids uuid[])
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(array_agg(o.id ORDER BY o.id), '{}'::uuid[])
    FROM (SELECT DISTINCT u AS id FROM unnest(p_ids[1:300]) AS u) o
   WHERE public.live_duel_pairable(p_me, o.id);
$function$;

REVOKE ALL ON FUNCTION public.live_duel_visible_to(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_pairable(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.live_duel_pairable_ids(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_duel_visible_to(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_pairable(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.live_duel_pairable_ids(uuid, uuid[]) TO service_role;

-- 2. Lobby: only pairable students ----------------------------------------------------

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
           AND p.level IS NOT DISTINCT FROM v_level
           AND public.live_duel_pairable(v_me, p.id)) x), '[]'::jsonb);
END;
$function$;

-- 3. Accepting a challenge re-checks the grant ------------------------------------------

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
  IF p_accept AND NOT public.live_duel_pairable(d.a_id, d.b_id) THEN
    UPDATE public.live_duels SET status = 'expired', finished_at = now() WHERE id = d.id;
    PERFORM public.live_duel_send('duel-user:' || d.a_id, 'declined', jsonb_build_object('duel_id', d.id));
    RETURN jsonb_build_object('ok', false, 'error', 'Duels between your centres are closed now.');
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

-- 4. Quick match never pairs two centres that are not open to each other ----------------

CREATE OR REPLACE FUNCTION public.live_duel_claim_pair(p_a uuid, p_b uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF NOT public.live_duel_pairable(p_a, p_b) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.live_duel_queue WHERE student_id IN (p_a, p_b) ORDER BY student_id FOR UPDATE;
  IF (SELECT count(*) FROM public.live_duel_queue WHERE student_id IN (p_a, p_b)) <> 2 THEN
    RETURN false;
  END IF;
  DELETE FROM public.live_duel_queue WHERE student_id IN (p_a, p_b);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 2;
END;
$function$;
