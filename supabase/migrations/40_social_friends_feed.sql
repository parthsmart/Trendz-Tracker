-- Child-safe social: friends, preset reactions, class feed, block / report, moderation.
--
-- Rules (all enforced here, not only in the UI):
--   * Everything social stays inside one centre (profiles.centre_id).
--   * A friendship needs three yeses: the asking student, the other student,
--     then an adult (assigned teacher of either student with view_students,
--     the centre head / vice head, or an owner / director).
--   * No free text from students anywhere. Reactions and report reasons are
--     fixed lists checked by CHECK constraints.
--   * The class feed is written only by triggers (and a service-role hook), and
--     only for positive events. Students can hide their own items and turn
--     auto-posting off; staff can remove items.
--   * Blocks are silent and end friendships and pending requests.
--   * Students have no direct INSERT / UPDATE / DELETE on any table here; they
--     use the SECURITY DEFINER functions below, which check auth.uid(), the
--     centre, blocks, status and rate limits. anon executes nothing.
--
-- Depends on migration 30 (centres, my_centre, is_centre_admin, ...).
-- No existing table, policy or function is changed. No data changes.
-- Rollback: supabase/rollbacks/40_social_friends_feed_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.social_settings (
  centre_id uuid PRIMARY KEY REFERENCES public.centres(id) ON DELETE CASCADE,
  friends_enabled boolean NOT NULL DEFAULT true,
  feed_enabled boolean NOT NULL DEFAULT true,
  reactions_enabled boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_prefs (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  auto_post boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  centre_id uuid NOT NULL REFERENCES public.centres(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending_student' CHECK (status IN (
    'pending_student', 'pending_staff', 'approved', 'declined_student', 'declined_staff', 'cancelled', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_one_open_pair_idx
  ON public.friend_requests (LEAST(from_id, to_id), GREATEST(from_id, to_id))
  WHERE status IN ('pending_student', 'pending_staff');
CREATE INDEX IF NOT EXISTS friend_requests_to_idx ON public.friend_requests (to_id, status);
CREATE INDEX IF NOT EXISTS friend_requests_from_idx ON public.friend_requests (from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_centre_idx ON public.friend_requests (centre_id, status);

CREATE TABLE IF NOT EXISTS public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  b_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  centre_id uuid NOT NULL REFERENCES public.centres(id) ON DELETE CASCADE,
  request_id uuid REFERENCES public.friend_requests(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  CHECK (a_id < b_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS friendships_active_pair_idx
  ON public.friendships (a_id, b_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS friendships_b_idx ON public.friendships (b_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS public.student_blocks (
  blocker_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS student_blocks_blocked_idx ON public.student_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS public.feed_items (
  id bigserial PRIMARY KEY,
  centre_id uuid NOT NULL REFERENCES public.centres(id) ON DELETE CASCADE,
  level text,
  student_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('level_up', 'badge', 'personal_best', 'batch_goal')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  day date NOT NULL DEFAULT public.today_ist(),
  created_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  removed_at timestamptz,
  removed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Positive events only: never scores, ranks, times or accuracy.
  CONSTRAINT feed_items_no_scores CHECK (NOT (payload ?| ARRAY[
    'correct', 'total', 'score', 'rank', 'time', 'time_seconds', 'accuracy', 'xp', 'wrong', 'lost'])),
  CONSTRAINT feed_items_student_or_batch CHECK ((kind = 'batch_goal') = (student_id IS NULL))
);
CREATE INDEX IF NOT EXISTS feed_items_centre_idx ON public.feed_items (centre_id, id DESC);
CREATE INDEX IF NOT EXISTS feed_items_student_idx ON public.feed_items (student_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feed_items_one_pb_per_day_idx
  ON public.feed_items (student_id, day) WHERE kind = 'personal_best';

CREATE TABLE IF NOT EXISTS public.social_reactions (
  id bigserial PRIMARY KEY,
  reactor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('feed', 'duel', 'live_duel')),
  target_id text NOT NULL,
  reaction text NOT NULL CHECK (reaction IN ('clap', 'fire', 'gg', 'star', 'muscle', 'party')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reactor_id, target_kind, target_id, reaction)
);
CREATE INDEX IF NOT EXISTS social_reactions_target_idx ON public.social_reactions (target_kind, target_id);

CREATE TABLE IF NOT EXISTS public.safety_reports (
  id bigserial PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  centre_id uuid REFERENCES public.centres(id) ON DELETE SET NULL,
  context text NOT NULL CHECK (context IN ('student', 'feed_item', 'reaction', 'friend_request', 'duel')),
  context_id text,
  reason text NOT NULL CHECK (reason IN ('unkind', 'uncomfortable', 'spam', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'actioned')),
  action text CHECK (action IS NULL OR action IN ('none', 'removed_item', 'ended_friendship', 'talked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  handled_at timestamptz,
  CHECK (reporter_id <> target_id)
);
CREATE INDEX IF NOT EXISTS safety_reports_open_idx ON public.safety_reports (centre_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.social_rate_events (
  id bigserial PRIMARY KEY,
  uid uuid NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_rate_events_idx ON public.social_rate_events (uid, kind, at DESC);

-- Row level security: on everywhere. Staff can read their scope; students read
-- nothing directly (they get curated rows from the functions below). No write
-- policies at all: only SECURITY DEFINER functions and the service role write.
ALTER TABLE public.social_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friend_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_rate_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.social_settings, public.social_prefs, public.friend_requests, public.friendships,
  public.student_blocks, public.feed_items, public.social_reactions, public.safety_reports,
  public.social_rate_events FROM anon, authenticated;
GRANT SELECT ON public.social_settings, public.friend_requests, public.friendships,
  public.feed_items, public.safety_reports TO authenticated;
GRANT ALL ON public.social_settings, public.social_prefs, public.friend_requests, public.friendships,
  public.student_blocks, public.feed_items, public.social_reactions, public.safety_reports,
  public.social_rate_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.feed_items_id_seq, public.social_reactions_id_seq,
  public.safety_reports_id_seq, public.social_rate_events_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- An active, not deleted student's centre and level (NULL row otherwise).
CREATE OR REPLACE FUNCTION public.social_student(p_id uuid)
RETURNS TABLE (id uuid, centre_id uuid, level text, visible boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.centre_id, p.level, COALESCE(p.leaderboard_visible, true)
    FROM public.profiles p
    LEFT JOIN public.centres c ON c.id = p.centre_id
   WHERE p.id = p_id AND p.role = 'student' AND p.active AND p.deleted_at IS NULL
     AND p.centre_id IS NOT NULL AND c.status = 'active'
$$;

CREATE OR REPLACE FUNCTION public.social_blocked(p_a uuid, p_b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.student_blocks
                  WHERE (blocker_id = p_a AND blocked_id = p_b) OR (blocker_id = p_b AND blocked_id = p_a))
$$;

CREATE OR REPLACE FUNCTION public.social_are_friends(p_a uuid, p_b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.friendships
                  WHERE a_id = LEAST(p_a, p_b) AND b_id = GREATEST(p_a, p_b) AND ended_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.social_enabled(p_centre uuid, p_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT CASE p_feature
                            WHEN 'friends' THEN s.friends_enabled
                            WHEN 'feed' THEN s.feed_enabled
                            WHEN 'reactions' THEN s.reactions_enabled END
                     FROM public.social_settings s WHERE s.centre_id = p_centre), true)
$$;

-- Can the signed-in adult moderate this student's social activity?
CREATE OR REPLACE FUNCTION public.social_can_moderate(p_student uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND public.my_role() IS NOT NULL AND (
    public.is_network_admin()
    OR public.is_centre_admin(public.profile_centre(p_student))
    OR (public.my_role() = 'teacher'
        AND public.is_teacher_assigned_to_student(auth.uid(), p_student)
        AND public.has_teacher_permission(auth.uid(), 'view_students')
        AND public.my_centre() IS NOT DISTINCT FROM public.profile_centre(p_student))
  )
$$;

-- Takes one unit from a rolling-window budget. false = over the limit.
CREATE OR REPLACE FUNCTION public.social_rate_take(p_uid uuid, p_kind text, p_max integer, p_window interval)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM public.social_rate_events
       WHERE uid = p_uid AND kind = p_kind AND at > now() - p_window) >= p_max THEN
    RETURN false;
  END IF;
  INSERT INTO public.social_rate_events (uid, kind) VALUES (p_uid, p_kind);
  DELETE FROM public.social_rate_events WHERE uid = p_uid AND at < now() - interval '2 days';
  RETURN true;
END;
$$;

-- Level order for "reached a new level" (only upward moves are posted).
CREATE OR REPLACE FUNCTION public.social_level_rank(p_level text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(ARRAY['KA-1', 'KA-2', 'KA-3', 'Level 1', 'Level 2', 'Level 3', 'Level 4',
                              'Level 5', 'Level 6', 'Graduate', 'Master', 'Grandmaster'], p_level)
$$;

-- Internal: posts one positive event for a student, if allowed.
CREATE OR REPLACE FUNCTION public.feed_post(p_student uuid, p_kind text, p_payload jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s record;
  v_id bigint;
BEGIN
  SELECT * INTO s FROM public.social_student(p_student);
  IF NOT FOUND OR NOT s.visible OR NOT public.social_enabled(s.centre_id, 'feed') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.social_prefs WHERE student_id = p_student AND NOT auto_post) THEN RETURN NULL; END IF;
  -- At most 4 posts per student per day, so a burst of badges can't flood the feed.
  IF (SELECT count(*) FROM public.feed_items
       WHERE student_id = p_student AND day = public.today_ist()) >= 4 THEN RETURN NULL; END IF;
  INSERT INTO public.feed_items (centre_id, level, student_id, kind, payload)
  VALUES (s.centre_id, s.level, p_student, p_kind, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Service-role hook for group events, e.g. "Level 2 completed the weekly boss!".
CREATE OR REPLACE FUNCTION public.feed_post_batch_event(p_centre uuid, p_level text, p_title text, p_icon text DEFAULT '🏆')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_centre IS NULL OR NOT public.social_enabled(p_centre, 'feed') THEN RETURN NULL; END IF;
  INSERT INTO public.feed_items (centre_id, level, student_id, kind, payload)
  VALUES (p_centre, p_level, NULL, 'batch_goal',
          jsonb_build_object('title', left(COALESCE(p_title, ''), 120), 'icon', left(COALESCE(p_icon, '🏆'), 8)))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Feed triggers (positive events only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_feed_level_up()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.role = 'student'
     AND public.social_level_rank(NEW.level) IS NOT NULL
     AND public.social_level_rank(NEW.level) > COALESCE(public.social_level_rank(OLD.level), 0)
     AND OLD.level IS NOT NULL THEN
    PERFORM public.feed_post(NEW.id, 'level_up', jsonb_build_object('level', NEW.level));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_feed_level_up ON public.profiles;
CREATE TRIGGER trg_feed_level_up AFTER UPDATE OF level ON public.profiles
  FOR EACH ROW WHEN (OLD.level IS DISTINCT FROM NEW.level) EXECUTE FUNCTION public.trg_feed_level_up();

CREATE OR REPLACE FUNCTION public.trg_feed_badge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b record;
BEGIN
  -- Backfilled badges (earned long ago) are not news.
  IF NEW.earned_at < now() - interval '1 day' THEN RETURN NULL; END IF;
  SELECT name, icon INTO b FROM public.badge_catalogue WHERE key = NEW.badge_key;
  PERFORM public.feed_post(NEW.student_id, 'badge',
    jsonb_build_object('badge', NEW.badge_key, 'name', COALESCE(b.name, NEW.badge_key), 'icon', COALESCE(b.icon, '🏅')));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_feed_badge ON public.student_badges;
CREATE TRIGGER trg_feed_badge AFTER INSERT ON public.student_badges
  FOR EACH ROW EXECUTE FUNCTION public.trg_feed_badge();

CREATE OR REPLACE FUNCTION public.trg_feed_personal_best()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.is_personal_best AND NOT NEW.first_best AND NEW.created_at > now() - interval '1 day' THEN
    PERFORM public.feed_post(NEW.student_id, 'personal_best', jsonb_build_object('label', left(NEW.label, 80)));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_feed_personal_best ON public.student_xp_events;
CREATE TRIGGER trg_feed_personal_best AFTER INSERT ON public.student_xp_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_feed_personal_best();

-- ---------------------------------------------------------------------------
-- 4. Staff read policies (moderation scope)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS social_settings_read ON public.social_settings;
CREATE POLICY social_settings_read ON public.social_settings FOR SELECT TO authenticated
  USING (public.is_centre_admin(centre_id) OR centre_id = public.my_centre());
DROP POLICY IF EXISTS friend_requests_staff_read ON public.friend_requests;
CREATE POLICY friend_requests_staff_read ON public.friend_requests FOR SELECT TO authenticated
  USING (public.social_can_moderate(from_id) OR public.social_can_moderate(to_id));
DROP POLICY IF EXISTS friendships_staff_read ON public.friendships;
CREATE POLICY friendships_staff_read ON public.friendships FOR SELECT TO authenticated
  USING (public.social_can_moderate(a_id) OR public.social_can_moderate(b_id));
DROP POLICY IF EXISTS feed_items_staff_read ON public.feed_items;
CREATE POLICY feed_items_staff_read ON public.feed_items FOR SELECT TO authenticated
  USING (public.is_centre_admin(centre_id) OR (student_id IS NOT NULL AND public.social_can_moderate(student_id)));
DROP POLICY IF EXISTS safety_reports_staff_read ON public.safety_reports;
CREATE POLICY safety_reports_staff_read ON public.safety_reports FOR SELECT TO authenticated
  USING (public.social_can_moderate(target_id) OR public.social_can_moderate(reporter_id));

-- ---------------------------------------------------------------------------
-- 5. Student functions
-- ---------------------------------------------------------------------------

-- Everything the Friends page needs, for the signed-in student only.
CREATE OR REPLACE FUNCTION public.social_home()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  me record;
BEGIN
  SELECT * INTO me FROM public.social_student(v_me);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_STUDENT'); END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'level', me.level,
    'enabled', jsonb_build_object(
      'friends', public.social_enabled(me.centre_id, 'friends'),
      'feed', public.social_enabled(me.centre_id, 'feed'),
      'reactions', public.social_enabled(me.centre_id, 'reactions')),
    'auto_post', COALESCE((SELECT auto_post FROM public.social_prefs WHERE student_id = v_me), true),
    'friends', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', o.id, 'name', public.display_name_for(o.full_name, o.student_code),
               'avatar_path', public.avatar_visible(o.id, o.avatar_path),
               'level', o.level, 'same_level', o.level IS NOT DISTINCT FROM me.level,
               'since', f.created_at)
             ORDER BY public.display_name_for(o.full_name, o.student_code))
        FROM public.friendships f
        JOIN public.profiles o ON o.id = CASE WHEN f.a_id = v_me THEN f.b_id ELSE f.a_id END
       WHERE (f.a_id = v_me OR f.b_id = v_me) AND f.ended_at IS NULL
         AND o.active AND o.deleted_at IS NULL AND o.centre_id = me.centre_id), '[]'::jsonb),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id,
               'direction', CASE WHEN r.from_id = v_me THEN 'out' ELSE 'in' END,
               'status', r.status,
               'other_id', o.id,
               'name', public.display_name_for(o.full_name, o.student_code),
               'avatar_path', public.avatar_visible(o.id, o.avatar_path),
               'created_at', r.created_at)
             ORDER BY r.created_at DESC)
        FROM public.friend_requests r
        JOIN public.profiles o ON o.id = CASE WHEN r.from_id = v_me THEN r.to_id ELSE r.from_id END
       WHERE (r.from_id = v_me OR r.to_id = v_me)
         AND r.status IN ('pending_student', 'pending_staff')
         AND NOT public.social_blocked(v_me, o.id)), '[]'::jsonb),
    'classmates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', o.id, 'name', public.display_name_for(o.full_name, o.student_code),
               'avatar_path', public.avatar_visible(o.id, o.avatar_path),
               'level', o.level, 'same_level', o.level IS NOT DISTINCT FROM me.level)
             ORDER BY (o.level IS NOT DISTINCT FROM me.level) DESC, public.display_name_for(o.full_name, o.student_code))
        FROM public.profiles o
       WHERE o.role = 'student' AND o.active AND o.deleted_at IS NULL AND o.id <> v_me
         AND o.centre_id = me.centre_id AND COALESCE(o.leaderboard_visible, true)
         AND NOT public.social_blocked(v_me, o.id)
         AND NOT public.social_are_friends(v_me, o.id)
         AND NOT EXISTS (SELECT 1 FROM public.friend_requests r
                          WHERE r.status IN ('pending_student', 'pending_staff')
                            AND ((r.from_id = v_me AND r.to_id = o.id) OR (r.from_id = o.id AND r.to_id = v_me)))),
      '[]'::jsonb),
    'blocked', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', public.display_name_for(o.full_name, o.student_code)))
        FROM public.student_blocks b JOIN public.profiles o ON o.id = b.blocked_id
       WHERE b.blocker_id = v_me), '[]'::jsonb),
    'my_events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'payload', i.payload,
               'created_at', i.created_at, 'hidden', i.hidden_at IS NOT NULL) ORDER BY i.id DESC)
        FROM (SELECT * FROM public.feed_items WHERE student_id = v_me AND removed_at IS NULL
               ORDER BY id DESC LIMIT 20) i), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.social_request_friend(p_to uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  me record;
  them record;
  v_id uuid;
BEGIN
  SELECT * INTO me FROM public.social_student(v_me);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_STUDENT'); END IF;
  SELECT * INTO them FROM public.social_student(p_to);
  -- Same answer for "doesn't exist", "other centre" and "blocked": nothing leaks.
  IF NOT FOUND OR them.id = v_me OR them.centre_id IS DISTINCT FROM me.centre_id OR NOT them.visible
     OR public.social_blocked(v_me, p_to) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNAVAILABLE');
  END IF;
  IF NOT public.social_enabled(me.centre_id, 'friends') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DISABLED');
  END IF;
  IF public.social_are_friends(v_me, p_to) THEN RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_FRIENDS'); END IF;
  IF EXISTS (SELECT 1 FROM public.friend_requests
              WHERE status IN ('pending_student', 'pending_staff')
                AND LEAST(from_id, to_id) = LEAST(v_me, p_to) AND GREATEST(from_id, to_id) = GREATEST(v_me, p_to)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING');
  END IF;
  IF EXISTS (SELECT 1 FROM public.friend_requests
              WHERE from_id = v_me AND to_id = p_to AND status IN ('declined_student', 'declined_staff')
                AND COALESCE(decided_at, responded_at, created_at) > now() - interval '7 days') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_SOON');
  END IF;
  IF (SELECT count(*) FROM public.friend_requests WHERE from_id = v_me AND status = 'pending_student') >= 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOO_MANY_PENDING');
  END IF;
  IF NOT public.social_rate_take(v_me, 'friend_request', 10, interval '1 day') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOW_DOWN');
  END IF;
  INSERT INTO public.friend_requests (from_id, to_id, centre_id) VALUES (v_me, p_to, me.centre_id)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$$;

-- The invited student says yes (then it waits for an adult) or no.
CREATE OR REPLACE FUNCTION public.social_respond_request(p_id uuid, p_accept boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  r public.friend_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.friend_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.to_id IS DISTINCT FROM v_me OR r.status <> 'pending_student' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.social_student(v_me)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_STUDENT');
  END IF;
  UPDATE public.friend_requests
     SET status = CASE WHEN p_accept THEN 'pending_staff' ELSE 'declined_student' END, responded_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN p_accept THEN 'pending_staff' ELSE 'declined_student' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_cancel_request(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.friend_requests SET status = 'cancelled', responded_at = now()
   WHERE id = p_id AND from_id = auth.uid() AND status IN ('pending_student', 'pending_staff');
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_unfriend(p_other uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.friendships SET ended_at = now(), ended_by = auth.uid()
   WHERE a_id = LEAST(auth.uid(), p_other) AND b_id = GREATEST(auth.uid(), p_other) AND ended_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

-- Silent block: ends friendship and open requests both ways.
CREATE OR REPLACE FUNCTION public.social_block(p_other uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.social_student(v_me)) OR p_other IS NULL OR p_other = v_me
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_other AND role = 'student') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_ALLOWED');
  END IF;
  INSERT INTO public.student_blocks (blocker_id, blocked_id) VALUES (v_me, p_other) ON CONFLICT DO NOTHING;
  UPDATE public.friendships SET ended_at = now(), ended_by = v_me
   WHERE a_id = LEAST(v_me, p_other) AND b_id = GREATEST(v_me, p_other) AND ended_at IS NULL;
  UPDATE public.friend_requests SET status = 'blocked', responded_at = now()
   WHERE status IN ('pending_student', 'pending_staff')
     AND LEAST(from_id, to_id) = LEAST(v_me, p_other) AND GREATEST(from_id, to_id) = GREATEST(v_me, p_other);
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_unblock(p_other uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.student_blocks WHERE blocker_id = auth.uid() AND blocked_id = p_other;
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_report(p_target uuid, p_context text, p_context_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  me record;
BEGIN
  SELECT * INTO me FROM public.social_student(v_me);
  IF NOT FOUND OR p_target IS NULL OR p_target = v_me
     OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_target AND role = 'student') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_ALLOWED');
  END IF;
  IF p_context NOT IN ('student', 'feed_item', 'reaction', 'friend_request', 'duel')
     OR p_reason NOT IN ('unkind', 'uncomfortable', 'spam', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;
  IF NOT public.social_rate_take(v_me, 'report', 10, interval '1 day') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOW_DOWN');
  END IF;
  INSERT INTO public.safety_reports (reporter_id, target_id, centre_id, context, context_id, reason)
  VALUES (v_me, p_target, me.centre_id, p_context, left(p_context_id, 64), p_reason);
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- The class feed: my level (default) or my whole centre. Never another centre.
CREATE OR REPLACE FUNCTION public.social_feed(p_scope text DEFAULT 'level', p_before bigint DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  me record;
BEGIN
  SELECT * INTO me FROM public.social_student(v_me);
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_STUDENT'); END IF;
  IF NOT public.social_enabled(me.centre_id, 'feed') THEN
    RETURN jsonb_build_object('ok', true, 'enabled', false, 'items', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('ok', true, 'enabled', true,
    'reactions_enabled', public.social_enabled(me.centre_id, 'reactions'),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', i.id, 'kind', i.kind, 'payload', i.payload, 'level', i.level,
               'created_at', i.created_at, 'mine', i.student_id = v_me,
               'student_id', i.student_id,
               'name', CASE WHEN p.id IS NULL THEN NULL ELSE public.display_name_for(p.full_name, p.student_code) END,
               'avatar_path', CASE WHEN p.id IS NULL THEN NULL ELSE public.avatar_visible(p.id, p.avatar_path) END,
               'reactions', public.social_reaction_counts('feed', i.id::text, v_me))
             ORDER BY i.id DESC)
        FROM (SELECT f.* FROM public.feed_items f
               WHERE f.centre_id = me.centre_id
                 AND f.removed_at IS NULL AND f.hidden_at IS NULL
                 AND (p_scope = 'centre' OR f.level IS NOT DISTINCT FROM me.level)
                 AND (p_before IS NULL OR f.id < p_before)
                 AND (f.student_id IS NULL OR NOT public.social_blocked(v_me, f.student_id))
                 AND f.created_at > now() - interval '30 days'
               ORDER BY f.id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)) i
        LEFT JOIN public.profiles p ON p.id = i.student_id
       WHERE i.student_id IS NULL OR (p.active AND p.deleted_at IS NULL AND COALESCE(p.leaderboard_visible, true))
    ), '[]'::jsonb));
END;
$$;

-- Counts per reaction plus which ones the viewer gave. Internal.
CREATE OR REPLACE FUNCTION public.social_reaction_counts(p_kind text, p_target text, p_viewer uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'counts', COALESCE((SELECT jsonb_object_agg(reaction, n) FROM (
                SELECT r.reaction, count(*) AS n FROM public.social_reactions r
                 WHERE r.target_kind = p_kind AND r.target_id = p_target
                   AND NOT public.social_blocked(p_viewer, r.reactor_id)
                 GROUP BY r.reaction) c), '{}'::jsonb),
    'mine', COALESCE((SELECT jsonb_agg(r.reaction) FROM public.social_reactions r
                       WHERE r.target_kind = p_kind AND r.target_id = p_target AND r.reactor_id = p_viewer), '[]'::jsonb))
$$;

-- May the student react to (and see reactions on) this target?
CREATE OR REPLACE FUNCTION public.social_can_react(p_uid uuid, p_kind text, p_target text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me record;
  v_owner uuid;
BEGIN
  SELECT * INTO me FROM public.social_student(p_uid);
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_kind = 'feed' THEN
    IF p_target !~ '^[0-9]{1,18}$' THEN RETURN false; END IF;
    SELECT student_id INTO v_owner FROM public.feed_items
     WHERE id = p_target::bigint AND centre_id = me.centre_id AND removed_at IS NULL AND hidden_at IS NULL;
    IF NOT FOUND THEN RETURN false; END IF;
    RETURN public.social_enabled(me.centre_id, 'reactions')
       AND (v_owner IS NULL OR NOT public.social_blocked(p_uid, v_owner));
  END IF;
  IF p_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  IF p_kind = 'duel' THEN
    SELECT CASE WHEN challenger_id = p_uid THEN opponent_id ELSE challenger_id END INTO v_owner
      FROM public.duels WHERE id = p_target::uuid AND status = 'done' AND (challenger_id = p_uid OR opponent_id = p_uid);
  ELSIF p_kind = 'live_duel' THEN
    SELECT CASE WHEN a_id = p_uid THEN b_id ELSE a_id END INTO v_owner
      FROM public.live_duels WHERE id = p_target::uuid AND status = 'done' AND (a_id = p_uid OR b_id = p_uid);
  ELSE
    RETURN false;
  END IF;
  RETURN v_owner IS NOT NULL AND NOT public.social_blocked(p_uid, v_owner);
END;
$$;

-- Toggle one preset reaction. 20 taps per 10 minutes.
CREATE OR REPLACE FUNCTION public.social_react(p_kind text, p_target text, p_reaction text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
BEGIN
  IF p_reaction NOT IN ('clap', 'fire', 'gg', 'star', 'muscle', 'party') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_REACTION');
  END IF;
  IF NOT public.social_can_react(v_me, p_kind, p_target) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_ALLOWED');
  END IF;
  IF NOT public.social_rate_take(v_me, 'reaction', 20, interval '10 minutes') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SLOW_DOWN');
  END IF;
  DELETE FROM public.social_reactions
   WHERE reactor_id = v_me AND target_kind = p_kind AND target_id = p_target AND reaction = p_reaction;
  IF NOT FOUND THEN
    INSERT INTO public.social_reactions (reactor_id, target_kind, target_id, reaction)
    VALUES (v_me, p_kind, p_target, p_reaction);
  END IF;
  RETURN jsonb_build_object('ok', true, 'reactions', public.social_reaction_counts(p_kind, p_target, v_me));
END;
$$;

-- Reactions for several duel results the caller played in.
CREATE OR REPLACE FUNCTION public.social_reactions_for(p_kind text, p_targets text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_object_agg(t, public.social_reaction_counts(p_kind, t, auth.uid())), '{}'::jsonb)
    FROM unnest(p_targets[1:50]) AS t
   WHERE public.social_can_react(auth.uid(), p_kind, t)
$$;

CREATE OR REPLACE FUNCTION public.social_hide_item(p_id bigint, p_hidden boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.feed_items SET hidden_at = CASE WHEN p_hidden THEN now() END
   WHERE id = p_id AND student_id = auth.uid();
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_set_auto_post(p_on boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.social_student(auth.uid())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_STUDENT');
  END IF;
  INSERT INTO public.social_prefs (student_id, auto_post, updated_at) VALUES (auth.uid(), COALESCE(p_on, true), now())
  ON CONFLICT (student_id) DO UPDATE SET auto_post = EXCLUDED.auto_post, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Staff functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.social_staff_name(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(full_name, student_code) FROM public.profiles WHERE id = p_id
$$;

-- The moderation page: what this adult may see, newest first.
CREATE OR REPLACE FUNCTION public.social_mod_queue(p_centre uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role text := public.my_role();
BEGIN
  IF v_role IS NULL OR v_role = 'student' THEN RAISE EXCEPTION 'Not allowed'; END IF;
  RETURN jsonb_build_object(
    'can_settings', public.is_centre_head(COALESCE(p_centre, public.my_centre())),
    'centre_id', COALESCE(p_centre, public.my_centre()),
    'settings', (SELECT to_jsonb(s) FROM public.social_settings s WHERE s.centre_id = COALESCE(p_centre, public.my_centre())),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'created_at', r.created_at,
               'from_id', r.from_id, 'from_name', public.social_staff_name(r.from_id),
               'to_id', r.to_id, 'to_name', public.social_staff_name(r.to_id)) ORDER BY r.created_at)
        FROM public.friend_requests r
       WHERE r.status = 'pending_staff' AND (p_centre IS NULL OR r.centre_id = p_centre)
         AND (public.social_can_moderate(r.from_id) OR public.social_can_moderate(r.to_id))), '[]'::jsonb),
    'reports', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status, 'reason', x.reason, 'context', x.context,
               'context_id', x.context_id, 'created_at', x.created_at, 'action', x.action,
               'reporter_id', x.reporter_id, 'reporter_name', public.social_staff_name(x.reporter_id),
               'target_id', x.target_id, 'target_name', public.social_staff_name(x.target_id)) ORDER BY x.status = 'open' DESC, x.created_at DESC)
        FROM (SELECT * FROM public.safety_reports s
               WHERE (p_centre IS NULL OR s.centre_id = p_centre)
                 AND (public.social_can_moderate(s.target_id) OR public.social_can_moderate(s.reporter_id))
                 AND (s.status = 'open' OR s.created_at > now() - interval '30 days')
               ORDER BY s.created_at DESC LIMIT 100) x), '[]'::jsonb),
    'feed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'payload', f.payload, 'level', f.level,
               'created_at', f.created_at, 'student_id', f.student_id,
               'student_name', CASE WHEN f.student_id IS NULL THEN NULL ELSE public.social_staff_name(f.student_id) END,
               'hidden', f.hidden_at IS NOT NULL, 'removed', f.removed_at IS NOT NULL) ORDER BY f.id DESC)
        FROM (SELECT * FROM public.feed_items i
               WHERE (p_centre IS NULL OR i.centre_id = p_centre)
                 AND (public.is_centre_admin(i.centre_id) OR (i.student_id IS NOT NULL AND public.social_can_moderate(i.student_id)))
               ORDER BY i.id DESC LIMIT 60) f), '[]'::jsonb),
    'friendships', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('a_id', f.a_id, 'a_name', public.social_staff_name(f.a_id),
               'b_id', f.b_id, 'b_name', public.social_staff_name(f.b_id), 'created_at', f.created_at,
               'approved_by', public.social_staff_name(f.approved_by)) ORDER BY f.created_at DESC)
        FROM public.friendships f
       WHERE f.ended_at IS NULL AND (p_centre IS NULL OR f.centre_id = p_centre)
         AND (public.social_can_moderate(f.a_id) OR public.social_can_moderate(f.b_id))), '[]'::jsonb),
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('blocker_name', public.social_staff_name(b.blocker_id),
               'blocked_name', public.social_staff_name(b.blocked_id), 'created_at', b.created_at) ORDER BY b.created_at DESC)
        FROM public.student_blocks b
       WHERE public.social_can_moderate(b.blocker_id) OR public.social_can_moderate(b.blocked_id)), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.social_decide_request(p_id uuid, p_approve boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.friend_requests%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.friend_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending_staff'
     OR NOT (public.social_can_moderate(r.from_id) OR public.social_can_moderate(r.to_id)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF p_approve THEN
    -- Re-check at approval time: both still active in the same centre, not blocked.
    IF NOT EXISTS (SELECT 1 FROM public.social_student(r.from_id) a, public.social_student(r.to_id) b
                    WHERE a.centre_id = r.centre_id AND b.centre_id = r.centre_id)
       OR public.social_blocked(r.from_id, r.to_id) THEN
      UPDATE public.friend_requests SET status = 'declined_staff', decided_by = auth.uid(), decided_at = now() WHERE id = p_id;
      RETURN jsonb_build_object('ok', false, 'code', 'UNAVAILABLE');
    END IF;
    UPDATE public.friend_requests SET status = 'approved', decided_by = auth.uid(), decided_at = now() WHERE id = p_id;
    INSERT INTO public.friendships (a_id, b_id, centre_id, request_id, approved_by)
    VALUES (LEAST(r.from_id, r.to_id), GREATEST(r.from_id, r.to_id), r.centre_id, r.id, auth.uid())
    ON CONFLICT DO NOTHING;
  ELSE
    UPDATE public.friend_requests SET status = 'declined_staff', decided_by = auth.uid(), decided_at = now() WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_remove_item(p_id bigint, p_removed boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  f public.feed_items%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.feed_items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (public.is_centre_admin(f.centre_id)
                       OR (f.student_id IS NOT NULL AND public.social_can_moderate(f.student_id))) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  UPDATE public.feed_items
     SET removed_at = CASE WHEN p_removed THEN now() END,
         removed_by = CASE WHEN p_removed THEN auth.uid() END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_end_friendship(p_a uuid, p_b uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.social_can_moderate(p_a) OR public.social_can_moderate(p_b)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  UPDATE public.friendships SET ended_at = now(), ended_by = auth.uid()
   WHERE a_id = LEAST(p_a, p_b) AND b_id = GREATEST(p_a, p_b) AND ended_at IS NULL;
  RETURN jsonb_build_object('ok', FOUND);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_handle_report(p_id bigint, p_status text, p_action text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  x public.safety_reports%ROWTYPE;
BEGIN
  SELECT * INTO x FROM public.safety_reports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (public.social_can_moderate(x.target_id) OR public.social_can_moderate(x.reporter_id)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF p_status NOT IN ('open', 'reviewed', 'actioned')
     OR (p_action IS NOT NULL AND p_action NOT IN ('none', 'removed_item', 'ended_friendship', 'talked')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_INPUT');
  END IF;
  UPDATE public.safety_reports
     SET status = p_status, action = p_action,
         handled_by = CASE WHEN p_status = 'open' THEN NULL ELSE auth.uid() END,
         handled_at = CASE WHEN p_status = 'open' THEN NULL ELSE now() END
   WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.social_update_settings(p_centre uuid, p_friends boolean, p_feed boolean, p_reactions boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_centre IS NULL OR NOT public.is_centre_head(p_centre) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_ALLOWED');
  END IF;
  INSERT INTO public.social_settings (centre_id, friends_enabled, feed_enabled, reactions_enabled, updated_by, updated_at)
  VALUES (p_centre, COALESCE(p_friends, true), COALESCE(p_feed, true), COALESCE(p_reactions, true), auth.uid(), now())
  ON CONFLICT (centre_id) DO UPDATE
    SET friends_enabled = EXCLUDED.friends_enabled, feed_enabled = EXCLUDED.feed_enabled,
        reactions_enabled = EXCLUDED.reactions_enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants: signed-in only for the site's functions; internals service role only
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'social_student(uuid)', 'social_blocked(uuid,uuid)', 'social_are_friends(uuid,uuid)',
    'social_enabled(uuid,text)', 'social_rate_take(uuid,text,integer,interval)', 'social_level_rank(text)',
    'feed_post(uuid,text,jsonb)', 'feed_post_batch_event(uuid,text,text,text)',
    'trg_feed_level_up()', 'trg_feed_badge()', 'trg_feed_personal_best()',
    'social_reaction_counts(text,text,uuid)', 'social_can_react(uuid,text,text)', 'social_staff_name(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'social_can_moderate(uuid)',
    'social_home()', 'social_request_friend(uuid)', 'social_respond_request(uuid,boolean)',
    'social_cancel_request(uuid)', 'social_unfriend(uuid)', 'social_block(uuid)', 'social_unblock(uuid)',
    'social_report(uuid,text,text,text)', 'social_feed(text,bigint,integer)', 'social_react(text,text,text)',
    'social_reactions_for(text,text[])', 'social_hide_item(bigint,boolean)', 'social_set_auto_post(boolean)',
    'social_mod_queue(uuid)', 'social_decide_request(uuid,boolean)', 'social_remove_item(bigint,boolean)',
    'social_end_friendship(uuid,uuid)', 'social_handle_report(bigint,text,text)',
    'social_update_settings(uuid,boolean,boolean,boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
  END LOOP;
END $$;
