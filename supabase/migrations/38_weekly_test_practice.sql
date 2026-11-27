-- Weekly test practice: take a weekly test after it has closed.
--
-- Once an online weekly test's official window has closed, any student in its
-- audience may practise it as many times as they like. A practice run has the
-- same sections, time limits and scoring as the official test (questions are
-- generated per student, exactly as in the official test).
--
-- Isolation: practice is stored ONLY in the two new tables below. Nothing that
-- reads weekly_test_scores / weekly_test_attempts (official leaderboard,
-- points_for, monthly report, weekly report, teacher review, backups) can see
-- it. Practice earns no XP.
--
-- "Where would I have stood": weekly_test_practice_standing() returns the
-- official board for the test with the caller's practice score slotted in. It
-- only ever returns the caller's own practice row, so nobody else's view
-- changes.
--
-- No existing table, policy or function is changed.
-- Rollback: supabase/rollbacks/38_weekly_test_practice_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Tables (service role only; the site reads them through the RPCs below)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weekly_test_practice_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id     uuid NOT NULL REFERENCES public.weekly_tests (id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weekly_test_practice_runs_student_idx
  ON public.weekly_test_practice_runs (student_id, test_id, started_at DESC);
CREATE INDEX IF NOT EXISTS weekly_test_practice_runs_test_idx
  ON public.weekly_test_practice_runs (test_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.weekly_test_practice_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES public.weekly_test_practice_runs (id) ON DELETE CASCADE,
  test_id       uuid NOT NULL REFERENCES public.weekly_tests (id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  section_id    uuid NOT NULL REFERENCES public.weekly_test_sections (id) ON DELETE CASCADE,
  category_id   uuid NULL,
  session_id    uuid NULL,
  status        text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'submitted')),
  tries_started integer NOT NULL DEFAULT 0 CHECK (tries_started >= 0),
  tries_correct integer NOT NULL DEFAULT 0 CHECK (tries_correct >= 0),
  seconds_used  integer NOT NULL DEFAULT 0 CHECK (seconds_used >= 0),
  correct       integer NULL CHECK (correct IS NULL OR correct >= 0),
  total         integer NULL CHECK (total IS NULL OR total > 0),
  time_seconds  integer NULL CHECK (time_seconds IS NULL OR time_seconds >= 0),
  claim_token   uuid NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_test_practice_attempts_correct_lte_total
    CHECK (correct IS NULL OR total IS NULL OR correct <= total),
  CONSTRAINT weekly_test_practice_attempts_run_section UNIQUE (run_id, section_id)
);
CREATE INDEX IF NOT EXISTS weekly_test_practice_attempts_student_idx
  ON public.weekly_test_practice_attempts (student_id, test_id);

ALTER TABLE public.weekly_test_practice_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_test_practice_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_test_practice_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.weekly_test_practice_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.weekly_test_practice_runs TO service_role;
GRANT ALL ON public.weekly_test_practice_attempts TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Gate: may this student practise this test right now?
--    Returns NULL when allowed, otherwise the reason.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_practice_block_reason(p_test uuid, p_student uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_student record;
  v_test record;
  v_closes timestamptz;
  v_creator_centre uuid;
BEGIN
  SELECT id, role, level, active, deleted_at, centre_id INTO v_student
    FROM public.profiles WHERE id = p_student;
  IF NOT FOUND OR v_student.role IS DISTINCT FROM 'student'
     OR v_student.active IS NOT TRUE OR v_student.deleted_at IS NOT NULL THEN
    RETURN 'Only active students can practise weekly tests.';
  END IF;

  SELECT * INTO v_test FROM public.weekly_tests WHERE id = p_test;
  IF NOT FOUND THEN RETURN 'This weekly test was not found.'; END IF;

  IF v_test.test_type IS DISTINCT FROM 'online' THEN
    RETURN 'Only online weekly tests can be practised.';
  END IF;

  -- Same closing rule as my_weekly_tests() / weekly_test_leaderboard().
  v_closes := COALESCE(v_test.closes_at, ((v_test.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'));
  IF now() < v_closes THEN
    RETURN 'Practice opens after the official test closes.';
  END IF;

  -- Same audience rule as weekly_test_reserve_section_start().
  IF v_test.target_scope = 'targeted' OR public.has_weekly_test_recipients(p_test) THEN
    IF NOT public.is_weekly_test_recipient(p_test, p_student) THEN
      RETURN 'This weekly test was not assigned to you.';
    END IF;
  ELSIF v_test.audience_level IS NOT NULL AND TRIM(v_test.audience_level) <> ''
        AND LOWER(TRIM(v_test.audience_level)) <> 'everyone' THEN
    IF LOWER(TRIM(v_test.audience_level)) IS DISTINCT FROM LOWER(TRIM(COALESCE(v_student.level, ''))) THEN
      RETURN 'This weekly test is for ' || v_test.audience_level || ' students only.';
    END IF;
  END IF;

  -- Centre scoping: a test written by centre staff belongs to that centre.
  -- Tests by owners / directors (no centre) are network-wide.
  v_creator_centre := public.profile_centre(v_test.created_by);
  IF v_creator_centre IS NOT NULL AND v_creator_centre IS DISTINCT FROM v_student.centre_id THEN
    RETURN 'This weekly test belongs to another centre.';
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Begin a practice run (service role: api/weekly-test.js)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_practice_begin(p_test uuid, p_student uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_reason text;
  v_run uuid;
  v_today_runs integer;
BEGIN
  v_reason := public.weekly_test_practice_block_reason(p_test, p_student);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '22023';
  END IF;

  -- Generous abuse guard: unlimited practice, but not more than 30 runs of one
  -- test in a day.
  SELECT count(*) INTO v_today_runs
    FROM public.weekly_test_practice_runs
   WHERE test_id = p_test AND student_id = p_student
     AND started_at > now() - interval '1 day';
  IF v_today_runs >= 30 THEN
    RAISE EXCEPTION 'You have practised this test a lot today. Try again tomorrow.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.weekly_test_practice_runs (test_id, student_id)
  VALUES (p_test, p_student)
  RETURNING id INTO v_run;

  RETURN jsonb_build_object('ok', true, 'run_id', v_run, 'test_id', p_test);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reserve a section start inside a run (service role). Mirrors
--    weekly_test_reserve_section_start(): one start per single-try section,
--    question_count tries for Flash, stale unlinked reservations reclaimed
--    after 60 s. Returns the same shape.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_practice_reserve(p_run uuid, p_student uuid, p_section uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_run record;
  v_test record;
  v_sec record;
  v_att record;
  v_reason text;
  v_claim uuid := gen_random_uuid();
  v_attempt uuid;
  v_prev integer := 0;
  v_next integer := 1;
  v_cat_name text;
BEGIN
  SELECT * INTO v_run FROM public.weekly_test_practice_runs
   WHERE id = p_run AND student_id = p_student FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Practice run not found.' USING ERRCODE = '23503';
  END IF;

  v_reason := public.weekly_test_practice_block_reason(v_run.test_id, p_student);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_test FROM public.weekly_tests WHERE id = v_run.test_id;

  SELECT * INTO v_sec FROM public.weekly_test_sections
   WHERE id = p_section AND test_id = v_run.test_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Section not found in this weekly test.' USING ERRCODE = '23503';
  END IF;
  IF v_sec.kind = 'round' THEN
    RAISE EXCEPTION 'Round sections are available for offline tests only' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_att FROM public.weekly_test_practice_attempts
   WHERE run_id = p_run AND section_id = v_sec.id FOR UPDATE;

  IF FOUND THEN
    IF v_att.status = 'submitted' THEN
      RAISE EXCEPTION 'You have already finished this section in this practice run.' USING ERRCODE = '23505';
    END IF;

    IF v_sec.kind = 'flash' THEN
      IF v_att.claim_token IS NOT NULL THEN
        IF v_att.session_id IS NOT NULL THEN
          RAISE EXCEPTION 'A try is currently in progress for this section' USING ERRCODE = '23505';
        ELSIF v_att.updated_at < now() - interval '60 seconds' THEN
          v_att.tries_started := GREATEST(0, v_att.tries_started - 1);
        ELSE
          RAISE EXCEPTION 'A try reservation is currently in progress for this section' USING ERRCODE = '23505';
        END IF;
      END IF;
      IF COALESCE(v_att.tries_started, 0) >= COALESCE(v_sec.question_count, 5) THEN
        RAISE EXCEPTION 'You have already completed all tries for this section' USING ERRCODE = '23505';
      END IF;
      v_attempt := v_att.id;
      v_prev := COALESCE(v_att.tries_started, 0);
      v_next := LEAST(COALESCE(v_sec.question_count, 5), v_prev + 1);
      UPDATE public.weekly_test_practice_attempts
         SET tries_started = v_next, claim_token = v_claim, session_id = NULL, updated_at = now()
       WHERE id = v_att.id;
    ELSE
      IF v_att.session_id IS NOT NULL THEN
        RAISE EXCEPTION 'You have already started this section in this practice run.' USING ERRCODE = '23505';
      END IF;
      IF v_att.updated_at >= now() - interval '60 seconds' THEN
        RAISE EXCEPTION 'A start reservation is currently in progress for this section' USING ERRCODE = '23505';
      END IF;
      v_attempt := v_att.id;
      UPDATE public.weekly_test_practice_attempts
         SET claim_token = v_claim, started_at = now(), updated_at = now(), status = 'started'
       WHERE id = v_att.id;
    END IF;
  ELSE
    INSERT INTO public.weekly_test_practice_attempts (
      run_id, test_id, student_id, section_id, category_id, status,
      tries_started, tries_correct, seconds_used, claim_token,
      correct, total, time_seconds)
    VALUES (
      p_run, v_run.test_id, p_student, v_sec.id, v_sec.category_id, 'started',
      1, 0, 0, v_claim,
      CASE WHEN v_sec.kind = 'flash' THEN 0 END,
      CASE WHEN v_sec.kind = 'flash' THEN COALESCE(v_sec.question_count, 5) END,
      CASE WHEN v_sec.kind = 'flash' THEN 0 END)
    RETURNING id INTO v_attempt;
  END IF;

  UPDATE public.weekly_test_practice_runs SET updated_at = now() WHERE id = p_run;

  IF v_sec.category_id IS NOT NULL THEN
    SELECT name INTO v_cat_name FROM public.categories WHERE id = v_sec.category_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_type', 'practice',
    'run_id', p_run,
    'attempt_id', v_attempt,
    'claim_token', v_claim,
    'test_id', v_run.test_id,
    'test_title', v_test.title,
    'section_id', v_sec.id,
    'kind', v_sec.kind,
    'category_id', v_sec.category_id,
    'category_name', v_cat_name,
    'seconds', v_sec.seconds,
    'activity_key', v_sec.activity_key,
    'flash_digits', v_sec.flash_digits,
    'flash_count', v_sec.flash_count,
    'flash_speed_ms', v_sec.flash_speed_ms,
    'flash_mode', v_sec.flash_mode,
    'question_count', v_sec.question_count,
    'tries_started', v_prev,
    'next_try_no', v_next
  );
END;
$$;

-- Undo a reservation whose session could not be created (service role).
CREATE OR REPLACE FUNCTION public.weekly_test_practice_rollback(p_attempt uuid, p_student uuid, p_claim uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_att record;
BEGIN
  SELECT * INTO v_att FROM public.weekly_test_practice_attempts
   WHERE id = p_attempt AND student_id = p_student FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'not_found');
  END IF;
  IF v_att.claim_token IS DISTINCT FROM p_claim THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'token_mismatch');
  END IF;
  IF v_att.session_id IS NOT NULL OR v_att.status = 'submitted' THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'already_active_or_completed');
  END IF;
  IF COALESCE(v_att.tries_started, 0) > 1 OR COALESCE(v_att.tries_correct, 0) > 0
     OR COALESCE(v_att.seconds_used, 0) > 0 THEN
    UPDATE public.weekly_test_practice_attempts
       SET tries_started = GREATEST(0, tries_started - 1), claim_token = NULL, updated_at = now()
     WHERE id = p_attempt;
    RETURN jsonb_build_object('ok', true, 'rolled_back', true, 'action', 'try_decremented');
  END IF;
  DELETE FROM public.weekly_test_practice_attempts WHERE id = p_attempt;
  RETURN jsonb_build_object('ok', true, 'rolled_back', true, 'action', 'attempt_deleted');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Points helper: same formula as the official board.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_section_points(p_correct integer, p_total integer)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT GREATEST(0, 2 * COALESCE(p_correct, 0) - COALESCE(p_total, 0))
$$;

-- ---------------------------------------------------------------------------
-- 6. Student: my practice runs for one test (signed-in student only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.my_weekly_test_practice(p_test uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_reason text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  v_reason := public.weekly_test_practice_block_reason(p_test, v_me);

  RETURN jsonb_build_object(
    'test_id', p_test,
    'can_practise', v_reason IS NULL,
    'reason', v_reason,
    'runs', CASE WHEN v_reason IS NOT NULL THEN '[]'::jsonb ELSE COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'run_id', r.id,
               'started_at', r.started_at,
               'sections', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'section_id', a.section_id, 'status', a.status,
                          'tries_started', a.tries_started, 'tries_correct', a.tries_correct,
                          'correct', a.correct, 'total', a.total, 'time_seconds', a.time_seconds))
                   FROM public.weekly_test_practice_attempts a WHERE a.run_id = r.id), '[]'::jsonb))
             ORDER BY r.started_at DESC)
        FROM (SELECT * FROM public.weekly_test_practice_runs
               WHERE test_id = p_test AND student_id = v_me
               ORDER BY started_at DESC LIMIT 20) r), '[]'::jsonb) END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Student: "where would I have stood" (signed-in student only)
--
--    The official board for p_test, built exactly like weekly_test_leaderboard
--    (level scope, active + leaderboard_visible students, points > 0), limited
--    to the caller's centre, with the caller's own official row replaced by the
--    practice run. Ranks are recomputed with the practice row slotted in.
--    The practice row is the only row marked is_practice and it is always the
--    caller's own.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_practice_standing(p_test uuid, p_run uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_reason text;
  v_level text;
  v_centre uuid;
  v_name text;
  v_run record;
  v_mult numeric;
  v_p_pts integer;
  v_p_c integer;
  v_p_t integer;
  v_p_secs integer;
  v_p_done integer;
  v_sections integer;
  v_official_rank integer;
  v_official_pts integer;
  v_board jsonb;
  v_my_rank integer;
  v_field integer;
  v_found boolean := false;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  v_reason := public.weekly_test_practice_block_reason(p_test, v_me);
  IF v_reason IS NOT NULL THEN RAISE EXCEPTION '%', v_reason; END IF;

  SELECT p.level, p.centre_id, public.display_name_for(p.full_name, p.student_code)
    INTO v_level, v_centre, v_name
    FROM public.profiles p WHERE p.id = v_me;
  SELECT r.weekly_test_multiplier INTO v_mult FROM public.competition_rules() r;
  v_mult := COALESCE(v_mult, 1);

  IF p_run IS NOT NULL THEN
    SELECT * INTO v_run FROM public.weekly_test_practice_runs
     WHERE id = p_run AND test_id = p_test AND student_id = v_me;
    v_found := FOUND;
  ELSE
    SELECT r.* INTO v_run FROM public.weekly_test_practice_runs r
     WHERE r.test_id = p_test AND r.student_id = v_me
       AND EXISTS (SELECT 1 FROM public.weekly_test_practice_attempts a
                    WHERE a.run_id = r.id AND a.total IS NOT NULL)
     ORDER BY r.started_at DESC LIMIT 1;
    v_found := FOUND;
  END IF;
  IF NOT v_found THEN
    RAISE EXCEPTION 'No practice score yet. Finish at least one section first.';
  END IF;

  SELECT COALESCE(sum(public.weekly_test_section_points(a.correct, a.total)), 0)::integer,
         COALESCE(sum(a.correct), 0)::integer, COALESCE(sum(a.total), 0)::integer,
         COALESCE(sum(a.time_seconds), 0)::integer,
         count(*) FILTER (WHERE a.status = 'submitted')::integer
    INTO v_p_pts, v_p_c, v_p_t, v_p_secs, v_p_done
    FROM public.weekly_test_practice_attempts a
   WHERE a.run_id = v_run.id AND a.total IS NOT NULL;
  SELECT count(*) INTO v_sections FROM public.weekly_test_sections WHERE test_id = p_test;

  WITH elig AS (
    SELECT p.id, public.display_name_for(p.full_name, p.student_code) AS dn, p.level AS lvl
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND p.level IS NOT DISTINCT FROM v_level
       AND p.centre_id IS NOT DISTINCT FROM v_centre
  ),
  official AS (
    SELECT e.id, e.dn, e.lvl,
           sum(public.weekly_test_section_points(s.correct, s.total)) AS pts,
           sum(s.correct) AS c, sum(s.total) AS t,
           COALESCE(sum(s.time_seconds), 0) AS secs
      FROM elig e JOIN public.weekly_test_scores s ON s.student_id = e.id
     WHERE s.test_id = p_test
     GROUP BY e.id, e.dn, e.lvl
  ),
  official_ranked AS (
    SELECT (rank() OVER (ORDER BY o.pts DESC, o.c DESC, o.secs ASC))::integer AS rk, o.*
      FROM official o WHERE o.pts > 0
  ),
  combined AS (
    SELECT o.id, o.dn, o.lvl, o.pts, o.c, o.t, o.secs, false AS is_practice
      FROM official o WHERE o.pts > 0 AND o.id <> v_me
    UNION ALL
    SELECT v_me, v_name, v_level, v_p_pts, v_p_c, v_p_t, v_p_secs, true
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY cb.pts DESC, cb.c DESC, cb.secs ASC, cb.is_practice ASC))::integer AS rk, cb.*
      FROM combined cb
  )
  SELECT
    (SELECT rk FROM official_ranked WHERE id = v_me),
    (SELECT pts FROM official WHERE id = v_me),
    (SELECT rk FROM ranked WHERE is_practice),
    (SELECT count(*) FROM ranked)::integer,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'rank', r.rk, 'display_name', r.dn, 'level', r.lvl,
               'points', round(r.pts * v_mult, 1), 'correct', r.c, 'attempted', r.t,
               'seconds', r.secs, 'is_me', r.is_practice, 'is_practice', r.is_practice)
             ORDER BY r.rk, r.is_practice DESC, r.dn)
        FROM ranked r WHERE r.rk <= 10 OR r.is_practice), '[]'::jsonb)
    INTO v_official_rank, v_official_pts, v_my_rank, v_field, v_board;

  RETURN jsonb_build_object(
    'test_id', p_test,
    'run_id', v_run.id,
    'run_started_at', v_run.started_at,
    'label', 'Practice — not official',
    'practice', jsonb_build_object(
      'rank', v_my_rank,
      'out_of', v_field,
      'points', round(v_p_pts * v_mult, 1),
      'correct', v_p_c, 'attempted', v_p_t, 'seconds', v_p_secs,
      'sections_done', v_p_done, 'sections_total', v_sections),
    'official', jsonb_build_object(
      'took_test', v_official_pts IS NOT NULL,
      'rank', v_official_rank,
      'points', CASE WHEN v_official_pts IS NULL THEN NULL ELSE round(v_official_pts * v_mult, 1) END),
    'board', v_board
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Staff: practice attempts for a test, labelled as practice.
--    Network admins see everyone; centre heads / vice heads their centre;
--    teachers their assigned students.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.weekly_test_practice_review(p_test uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_role text := public.my_role();
BEGIN
  IF v_me IS NULL OR v_role IS NULL OR v_role = 'student' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'run_id', x.run_id, 'student_id', x.student_id, 'full_name', x.full_name,
             'student_code', x.student_code, 'level', x.level, 'started_at', x.started_at,
             'sections_done', x.done, 'correct', x.c, 'attempted', x.t, 'seconds', x.secs,
             'points', x.pts, 'attempt_type', 'practice')
           ORDER BY x.started_at DESC)
      FROM (
        SELECT r.id AS run_id, p.id AS student_id, p.full_name, p.student_code, p.level, r.started_at,
               count(*) FILTER (WHERE a.status = 'submitted') AS done,
               COALESCE(sum(a.correct), 0) AS c, COALESCE(sum(a.total), 0) AS t,
               COALESCE(sum(a.time_seconds), 0) AS secs,
               COALESCE(sum(public.weekly_test_section_points(a.correct, a.total)) FILTER (WHERE a.total IS NOT NULL), 0) AS pts
          FROM public.weekly_test_practice_runs r
          JOIN public.profiles p ON p.id = r.student_id
          LEFT JOIN public.weekly_test_practice_attempts a ON a.run_id = r.id
         WHERE r.test_id = p_test
           AND (public.is_network_admin()
                OR public.is_centre_admin(p.centre_id)
                OR (v_role = 'teacher' AND public.is_teacher_assigned_to_student(v_me, p.id)))
         GROUP BY r.id, p.id, p.full_name, p.student_code, p.level, r.started_at
         ORDER BY r.started_at DESC
         LIMIT 300) x), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.weekly_test_practice_block_reason(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.weekly_test_practice_begin(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.weekly_test_practice_reserve(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.weekly_test_practice_rollback(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_block_reason(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_begin(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_reserve(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_rollback(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.weekly_test_section_points(integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_weekly_test_practice(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.weekly_test_practice_standing(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.weekly_test_practice_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.weekly_test_section_points(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_weekly_test_practice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_standing(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_practice_review(uuid) TO authenticated;
