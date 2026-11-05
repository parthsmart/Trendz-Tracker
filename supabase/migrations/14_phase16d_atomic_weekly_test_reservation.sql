-- ==============================================================================
-- 14_phase16d_atomic_weekly_test_reservation.sql
-- Phase 16d: Database-Backed Atomic Start Reservation & Locking Protocol
-- Eliminates student-start / admin-edit race condition.
--
-- Security & Permissions:
-- - Server-only execution: EXECUTE revoked from PUBLIC, anon, and authenticated.
-- - Granted exclusively to service_role.
-- - Internal ownership checks prevent cross-student reservation or rollback.
-- - Student role and active status validated against public.profiles schema.
--
-- Flash Multi-Try Atomic Claim:
-- - Atomically claims each try in PostgreSQL, preventing overlapping starts from
--   claiming the same try_no.
-- - Generates a unique claim_token per reservation.
-- - Rollback requires matching claim_token and refuses to roll back linked sessions
--   or completed attempts.
-- - Failed requests cannot cancel another request's successful reservation.
--
-- Schema verified against live Mumbai database.
-- DO NOT EXECUTE REMOTELY. Provided for database owner review.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Schema Extensions for Atomic Claim & Uniqueness
-- ------------------------------------------------------------------------------
ALTER TABLE public.weekly_test_attempts
  ADD COLUMN IF NOT EXISTS claim_token UUID NULL;

ALTER TABLE public.weekly_test_attempts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_test_attempts_test_student_section
  ON public.weekly_test_attempts (test_id, student_id, section_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_test_scores_test_student_section
  ON public.weekly_test_scores (test_id, student_id, section_id);

-- ------------------------------------------------------------------------------
-- 2. Stored Procedure: weekly_test_reserve_section_start
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_test_reserve_section_start(
  p_test_id UUID,
  p_student_id UUID,
  p_section_id UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student RECORD;
  v_test RECORD;
  v_sec RECORD;
  v_score RECORD;
  v_att RECORD;
  v_claim_token UUID := gen_random_uuid();
  v_attempt_id UUID;
  v_cat_name TEXT := NULL;
  v_prev_tries_started INT := 0;
  v_next_try_no INT := 1;
  v_is_first_start BOOLEAN := FALSE;
BEGIN
  -- ----------------------------------------------------------------------------
  -- Step 1: Authorization & Profile Validation
  -- ----------------------------------------------------------------------------
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_student_id AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: caller cannot reserve section for another student'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, role, level, active INTO v_student
  FROM public.profiles
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile % not found', p_student_id
      USING ERRCODE = '23503';
  END IF;

  IF v_student.role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'Profile % is not a student (role: %)', p_student_id, v_student.role
      USING ERRCODE = '22023';
  END IF;

  IF v_student.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Student account % is inactive', p_student_id
      USING ERRCODE = '22023';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 2: Parent Test Existence & Coordination Lock
  -- ----------------------------------------------------------------------------
  SELECT * INTO v_test
  FROM public.weekly_tests
  WHERE id = p_test_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Weekly test % not found', p_test_id
      USING ERRCODE = '23503';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 3: Eligibility Checks (Online, Window, Audience Level)
  -- ----------------------------------------------------------------------------
  IF v_test.test_type IS DISTINCT FROM 'online' THEN
    RAISE EXCEPTION 'This weekly test is an offline test and cannot be taken online'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.opens_at IS NOT NULL AND NOW() < v_test.opens_at THEN
    RAISE EXCEPTION 'This weekly test has not opened yet'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.closes_at IS NOT NULL AND NOW() > v_test.closes_at THEN
    RAISE EXCEPTION 'This weekly test has closed'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.opens_at IS NULL AND v_test.closes_at IS NULL THEN
    IF v_test.test_date > CURRENT_DATE THEN
      RAISE EXCEPTION 'This weekly test has not opened yet'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_test.audience_level IS NOT NULL AND TRIM(v_test.audience_level) <> '' THEN
    IF LOWER(TRIM(v_test.audience_level)) IS DISTINCT FROM LOWER(TRIM(COALESCE(v_student.level, ''))) THEN
      RAISE EXCEPTION 'This weekly test is assigned to % students only', v_test.audience_level
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 4: Resolve & Row-Level Lock Section
  -- ----------------------------------------------------------------------------
  IF p_section_id IS NOT NULL THEN
    SELECT * INTO v_sec
    FROM public.weekly_test_sections
    WHERE id = p_section_id AND test_id = p_test_id
    FOR UPDATE;
  ELSIF p_category_id IS NOT NULL THEN
    SELECT * INTO v_sec
    FROM public.weekly_test_sections
    WHERE category_id = p_category_id AND test_id = p_test_id
    FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Either section_id or category_id must be provided'
      USING ERRCODE = '22023';
  END IF;

  IF v_sec.id IS NULL THEN
    RAISE EXCEPTION 'Section not found in weekly test %', p_test_id
      USING ERRCODE = '23503';
  END IF;

  IF v_sec.kind = 'round' THEN
    RAISE EXCEPTION 'Round sections are available for offline tests only'
      USING ERRCODE = '22023';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 5: Duplicate-Start & Attempt Limit Protection
  -- ----------------------------------------------------------------------------
  -- Check completed scores (non-Flash sections only have 1 score row)
  SELECT * INTO v_score
  FROM public.weekly_test_scores
  WHERE test_id = p_test_id
    AND student_id = p_student_id
    AND section_id = v_sec.id;

  IF FOUND AND v_sec.kind <> 'flash' THEN
    RAISE EXCEPTION 'You have already completed this section'
      USING ERRCODE = '23505';
  END IF;

  -- Row-lock existing attempt
  SELECT * INTO v_att
  FROM public.weekly_test_attempts
  WHERE test_id = p_test_id
    AND student_id = p_student_id
    AND section_id = v_sec.id
  FOR UPDATE;

  IF v_sec.kind = 'flash' THEN
    IF FOUND THEN
      IF v_att.status = 'submitted' THEN
        RAISE EXCEPTION 'You have already completed all tries for this section'
          USING ERRCODE = '23505';
      END IF;

      -- Check if an active try claim is currently in progress
      IF v_att.claim_token IS NOT NULL THEN
        IF v_att.session_id IS NOT NULL THEN
          RAISE EXCEPTION 'A try is currently in progress for this section'
            USING ERRCODE = '23505';
        ELSE
          IF v_att.updated_at < NOW() - INTERVAL '60 seconds' THEN
            -- Reclaim stale unlinked reservation
            v_att.tries_started := GREATEST(0, v_att.tries_started - 1);
          ELSE
            RAISE EXCEPTION 'A try reservation is currently in progress for this section'
              USING ERRCODE = '23505';
          END IF;
        END IF;
      END IF;

      IF COALESCE(v_att.tries_started, 0) >= COALESCE(v_sec.question_count, 5) THEN
        RAISE EXCEPTION 'You have already completed all tries for this section'
          USING ERRCODE = '23505';
      END IF;

      v_is_first_start := FALSE;
      v_attempt_id := v_att.id;
      v_prev_tries_started := COALESCE(v_att.tries_started, 0);
      v_next_try_no := LEAST(COALESCE(v_sec.question_count, 5), v_prev_tries_started + 1);

      -- Atomically claim the next try
      UPDATE public.weekly_test_attempts
      SET tries_started = v_next_try_no,
          claim_token = v_claim_token,
          session_id = NULL,
          updated_at = NOW()
      WHERE id = v_att.id;
    ELSE
      v_is_first_start := TRUE;
      v_prev_tries_started := 0;
      v_next_try_no := 1;

      -- Atomically claim try 1 on insert
      INSERT INTO public.weekly_test_attempts (
        test_id,
        student_id,
        section_id,
        category_id,
        status,
        tries_started,
        tries_correct,
        seconds_used,
        claim_token,
        started_at,
        updated_at
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        'started',
        1,
        0,
        0,
        v_claim_token,
        NOW(),
        NOW()
      ) RETURNING id INTO v_attempt_id;

      INSERT INTO public.weekly_test_scores (
        test_id,
        student_id,
        section_id,
        category_id,
        correct,
        total,
        time_seconds,
        source
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        0,
        COALESCE(v_sec.question_count, 5),
        0,
        'online'
      )
      ON CONFLICT (test_id, student_id, section_id) DO NOTHING;
    END IF;
  ELSE
    -- Single-try kinds: basics, elements, memoriad
    IF FOUND THEN
      IF v_att.status = 'submitted' THEN
        RAISE EXCEPTION 'You have already completed this section'
          USING ERRCODE = '23505';
      END IF;

      IF v_att.session_id IS NOT NULL THEN
        RAISE EXCEPTION 'You have already started this section'
          USING ERRCODE = '23505';
      END IF;

      -- Interrupted, unlinked reservation (session_id IS NULL and status <> 'submitted')
      IF v_att.updated_at < NOW() - INTERVAL '60 seconds' THEN
        -- Bounded recovery: reclaim stale unlinked reservation and rotate claim token
        v_is_first_start := TRUE;
        v_prev_tries_started := 0;
        v_next_try_no := 1;
        v_attempt_id := v_att.id;

        UPDATE public.weekly_test_attempts
        SET claim_token = v_claim_token,
            started_at = NOW(),
            updated_at = NOW(),
            status = 'started'
        WHERE id = v_att.id;
      ELSE
        RAISE EXCEPTION 'A start reservation is currently in progress for this section'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      v_is_first_start := TRUE;
      v_prev_tries_started := 0;
      v_next_try_no := 1;

      INSERT INTO public.weekly_test_attempts (
        test_id,
        student_id,
        section_id,
        category_id,
        status,
        tries_started,
        claim_token,
        started_at,
        updated_at
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        'started',
        1,
        v_claim_token,
        NOW(),
        NOW()
      ) RETURNING id INTO v_attempt_id;
    END IF;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 6: Capture Authoritative Settings & Return
  -- ----------------------------------------------------------------------------
  IF v_sec.category_id IS NOT NULL THEN
    SELECT name INTO v_cat_name
    FROM public.categories
    WHERE id = v_sec.category_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt_id,
    'claim_token', v_claim_token,
    'test_id', p_test_id,
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
    'tries_started', v_prev_tries_started,
    'next_try_no', v_next_try_no,
    'is_first_start', v_is_first_start
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Stored Procedure: weekly_test_rollback_start_reservation
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_test_rollback_start_reservation(
  p_attempt_id UUID,
  p_student_id UUID,
  p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_att RECORD;
BEGIN
  -- ----------------------------------------------------------------------------
  -- Step 1: Authorization Check
  -- ----------------------------------------------------------------------------
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_student_id AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: caller cannot rollback attempt for another student'
      USING ERRCODE = '42501';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 2: Row-level lock attempt
  -- ----------------------------------------------------------------------------
  SELECT * INTO v_att
  FROM public.weekly_test_attempts
  WHERE id = p_attempt_id AND student_id = p_student_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'not_found');
  END IF;

  -- Token ownership verification: a failed request must NOT cancel another request's reservation
  IF v_att.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'token_mismatch');
  END IF;

  -- CRITICAL: Safe recovery must never remove an active or submitted attempt!
  IF v_att.session_id IS NOT NULL OR v_att.status = 'submitted' THEN
    RETURN jsonb_build_object('ok', true, 'rolled_back', false, 'reason', 'already_active_or_completed');
  END IF;

  -- For Flash multi-try:
  -- If it was try 2, 3... (tries_started > 1 or tries_correct > 0 or seconds_used > 0):
  -- Decrement tries_started and clear claim_token, preserving the attempt!
  IF COALESCE(v_att.tries_started, 0) > 1 OR COALESCE(v_att.tries_correct, 0) > 0 OR COALESCE(v_att.seconds_used, 0) > 0 THEN
    UPDATE public.weekly_test_attempts
    SET tries_started = GREATEST(0, tries_started - 1),
        claim_token = NULL,
        updated_at = NOW()
    WHERE id = p_attempt_id;

    RETURN jsonb_build_object('ok', true, 'rolled_back', true, 'action', 'try_decremented');
  END IF;

  -- If it was initial creation of try 1 with 0 completed tries: delete unstarted attempt
  DELETE FROM public.weekly_test_attempts WHERE id = p_attempt_id;

  DELETE FROM public.weekly_test_scores
  WHERE test_id = v_att.test_id
    AND student_id = p_student_id
    AND section_id = v_att.section_id
    AND correct = 0
    AND time_seconds = 0;

  RETURN jsonb_build_object('ok', true, 'rolled_back', true, 'action', 'attempt_deleted');
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. Explicit Permissions for Server-Only Execution
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.weekly_test_rollback_start_reservation(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_rollback_start_reservation(UUID, UUID, UUID) TO service_role;
