-- Phase 34: live duel classmates carry their (privacy-checked) avatar so the student home
-- Live Duels card can show who is online as small avatars. Only my_live_duels() changes:
-- each 'mates' entry gains 'avatar_path' from avatar_visible(), which already hides
-- avatars the student chose not to show.

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
    'mates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id,
               'display_name', public.display_name_for(p.full_name, p.student_code),
               'avatar_path', public.avatar_visible(p.id, p.avatar_path))
             ORDER BY public.display_name_for(p.full_name, p.student_code))
        FROM public.profiles p
       WHERE p.role = 'student' AND p.active AND p.leaderboard_visible AND p.id <> v_me
         AND p.level IS NOT DISTINCT FROM (SELECT m.level FROM public.profiles m WHERE m.id = v_me)
         AND public.live_duel_centre_of(p.id) IS NOT DISTINCT FROM public.live_duel_centre_of(v_me)), '[]'::jsonb),
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

REVOKE ALL ON FUNCTION public.my_live_duels() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_live_duels() TO authenticated;
