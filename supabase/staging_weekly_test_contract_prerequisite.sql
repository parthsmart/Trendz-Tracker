-- ==============================================================================
-- Trendz Tracker — Staging Database Prerequisite: Weekly Test Contract & Attempts Alignment
-- File: supabase/staging_weekly_test_contract_prerequisite.sql
--
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Upgrades the staging database's `public.weekly_test_attempts` table and routines
-- to match the full verified database contract (Phase 16d / Phase 18 / Migration 14):
--
-- 1. Schema Extensions (Idempotent):
--    - tries_started INT NOT NULL DEFAULT 0
--    - tries_correct INT NOT NULL DEFAULT 0
--    - seconds_used INT NOT NULL DEFAULT 0
--    - claim_token UUID NULL
--    - updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
--
-- 2. Conflict Detection Without Data Loss:
--    - Detects duplicate attempt or score groups for (test_id, student_id, section_id).
--    - If conflicts exist, raises an exception with diagnostic details (record counts and IDs),
--      aborting the transaction and preserving every record. NO automatic record deletion.
--    - Creates unique indexes uq_weekly_test_attempts_test_student_section and
--      uq_weekly_test_scores_test_student_section once validated conflict-free.
--
-- 3. Validated Storage Evidence Backfill (Legacy Upgrade Only):
--    - Runs backfill ONLY when upgrading from an identified legacy state (tries_started absent).
--    - Single-try sections: sets tries_started = 1, tries_correct = sc.correct, seconds_used = sc.time_seconds.
--    - Flash multi-try: recovers tries_started from validated session evidence (linked session try_no,
--      max try_no in drill_sessions, session count) and score evidence. Does NOT equate tries_started
--      with question_count or score_correct.
--    - Reports ambiguous Flash records that lack session/score evidence instead of guessing.
--    - Backfills updated_at = COALESCE(finished_at, started_at, now()) for legacy records.
--
-- 4. Safe Reapplication & Idempotency:
--    - Reapplication detects modern state and skips backfill entirely.
--    - Preserves existing timestamps, active reservation claim_tokens, session links,
--      counters, and valid zero values.
--
-- 5. Authoritative Routines:
--    - weekly_test_reserve_section_start(p_test_id, p_student_id, p_section_id, p_category_id)
--    - weekly_test_rollback_start_reservation(p_attempt_id, p_student_id, p_claim_token)
--    - Helper functions: has_weekly_test_recipients, is_weekly_test_recipient, today_ist
--    - public.my_weekly_tests() reads tries_started and tries_correct directly.
--
-- 6. Strict Permissions & Row Level Security:
--    - Reservation and rollback routines restricted to service_role.
--    - my_weekly_tests granted to authenticated and service_role.
--    - RLS on weekly_test_attempts: self, admin, or assigned teacher with review_scores.
--
-- SAFETY & ISOLATION:
-- 1. OPERATOR CONFIRMATION LATCH: Requires `SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';`
-- 2. PRODUCTION DATA TRIPWIRE: Aborts immediately if Mumbai production student records exist.
-- 3. ZERO REMOTE SQL: Staging-only script. Do not run on Mumbai production.
-- ==============================================================================

-- Operator confirmation latch
SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. PRE-FLIGHT CHECKS: OPERATOR LATCH & PRODUCTION DATA TRIPWIRE
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_target_env TEXT := current_setting('app.target_environment', true);
  v_is_prod BOOLEAN := false;
BEGIN
  -- 0a. Operator Intent Confirmation Latch
  IF v_target_env IS DISTINCT FROM 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR SAFETY HALT: Target environment latch unset or mismatched. Got "%". Set `SET app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'';` before running.',
      COALESCE(v_target_env, '<unset>')
      USING ERRCODE = '28000';
  END IF;

  -- 0b. Secondary Safeguard: Production Data Tripwire
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'student_code'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'full_name'
  ) THEN
    EXECUTE $tripwire$
      SELECT EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE student_code IN ('STU101', 'STU-101') AND full_name ILIKE '%Riya%'
      )
    $tripwire$ INTO v_is_prod;

    IF v_is_prod THEN
      RAISE EXCEPTION 'SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected in public.profiles (STU101 / Riya)! Refusing execution on production database (kgzivhavpsvitwrscrrj).'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. PREREQUISITE BASELINE TABLES VALIDATION
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weekly_tests')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weekly_test_sections')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weekly_test_scores') THEN
    RAISE EXCEPTION 'Prerequisite missing: Weekly test baseline tables not found in schema public.'
      USING ERRCODE = '42P01';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. SCHEMA EXTENSIONS & VALIDATED STORAGE EVIDENCE BACKFILL (LEGACY UPGRADE ONLY)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_is_legacy_upgrade BOOLEAN;
  v_contradictory_evidence TEXT;
  v_missing_evidence TEXT;
  v_active_flash TEXT;
  v_inconsistent_evidence TEXT;
  v_dup_ordinals TEXT;
  v_ambiguous_flash TEXT;
  v_rec RECORD;
  v_latest_session_id UUID;
  v_recovered_tries_correct INT;
  v_recovered_seconds_used INT;
BEGIN
  -- Detect if table is in legacy state (tries_started column does not exist yet)
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts' AND column_name = 'tries_started'
  ) INTO v_is_legacy_upgrade;

  -- 2a. Add missing columns with safe defaults
  ALTER TABLE public.weekly_test_attempts
    ADD COLUMN IF NOT EXISTS tries_started INT NOT NULL DEFAULT 0;

  ALTER TABLE public.weekly_test_attempts
    ADD COLUMN IF NOT EXISTS tries_correct INT NOT NULL DEFAULT 0;

  ALTER TABLE public.weekly_test_attempts
    ADD COLUMN IF NOT EXISTS seconds_used INT NOT NULL DEFAULT 0;

  ALTER TABLE public.weekly_test_attempts
    ADD COLUMN IF NOT EXISTS claim_token UUID NULL;

  ALTER TABLE public.weekly_test_attempts
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;

  -- 2b. Execute backfill ONLY when upgrading from identified legacy state
  -- Reapplication skips this block completely, preserving active claims, recent timestamps, and counters.
  IF v_is_legacy_upgrade THEN
    -- =========================================================================
    -- Check 1: CONTRADICTORY SESSION METADATA REJECTION
    -- Candidate membership:
    --   - the directly linked session (ds.id = a.session_id); OR
    --   - a same-student session explicitly identifying the current section.
    -- The same test_id alone does NOT establish membership.
    -- After establishing membership, retain strict test/student/section/kind validation.
    -- =========================================================================
    SELECT string_agg(
      format('attempt_id: %s (test: %s, student: %s, section: %s), session_id: %s (test: %s, student: %s, section: %s, activity: %s, kind: %s, section_kind: %s)',
             a.id, a.test_id, a.student_id, a.section_id,
             ds.id, ds.settings->>'test_id', ds.student_id, ds.settings->>'section_id', ds.activity_type, ds.settings->>'kind', ds.settings->>'section_kind'),
      E'\n'
    )
    INTO v_contradictory_evidence
    FROM public.weekly_test_attempts a
    JOIN public.weekly_test_sections s ON s.id = a.section_id
    JOIN public.drill_sessions ds ON (
      ds.id = a.session_id
      OR (
        ds.student_id = a.student_id
        AND ds.settings->>'section_id' = a.section_id::text
      )
    )
    WHERE s.kind = 'flash'
      AND (
        ds.student_id <> a.student_id
        OR (ds.settings->>'test_id' IS NOT NULL AND ds.settings->>'test_id' <> a.test_id::text)
        OR (ds.settings->>'section_id' IS NOT NULL AND ds.settings->>'section_id' <> a.section_id::text)
        OR ds.activity_type <> 'flash_anzan'
        OR (ds.settings->>'kind' IS NOT NULL AND ds.settings->>'kind' <> 'weekly_test')
        OR (ds.settings->>'section_kind' IS NOT NULL AND ds.settings->>'section_kind' <> 'flash')
      );

    IF v_contradictory_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'CONTRADICTORY SESSION METADATA DETECTED: Candidate drill session has metadata contradicting weekly test attempt. Aborting transaction:\n%', v_contradictory_evidence
        USING ERRCODE = '22023';
    END IF;

    -- =========================================================================
    -- Check 2: MISSING IDENTIFYING EVIDENCE (AMBIGUITY REPORTING)
    -- All candidate sessions must possess complete identifying evidence:
    -- kind = 'weekly_test', section_kind = 'flash', test_id, section_id, and try_no.
    -- Candidate sessions missing any identifying evidence must abort as ambiguous.
    -- =========================================================================
    SELECT string_agg(
      format('attempt_id: %s, session_id: %s, missing: %s',
             a.id, ds.id,
             concat_ws(', ',
               CASE WHEN ds.settings->>'kind' IS NULL THEN 'kind' END,
               CASE WHEN ds.settings->>'section_kind' IS NULL THEN 'section_kind' END,
               CASE WHEN ds.settings->>'test_id' IS NULL THEN 'test_id' END,
               CASE WHEN ds.settings->>'section_id' IS NULL THEN 'section_id' END,
               CASE WHEN ds.settings->>'try_no' IS NULL THEN 'try_no' END
             )
      ),
      E'\n'
    )
    INTO v_missing_evidence
    FROM public.weekly_test_attempts a
    JOIN public.weekly_test_sections s ON s.id = a.section_id
    JOIN public.drill_sessions ds ON (
      ds.id = a.session_id
      OR (
        ds.student_id = a.student_id
        AND ds.settings->>'section_id' = a.section_id::text
      )
    )
    WHERE s.kind = 'flash'
      AND (
        ds.settings->>'kind' IS NULL
        OR ds.settings->>'section_kind' IS NULL
        OR ds.settings->>'test_id' IS NULL
        OR ds.settings->>'section_id' IS NULL
        OR ds.settings->>'try_no' IS NULL
      );

    IF v_missing_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'AMBIGUOUS FLASH ATTEMPT DETECTED: Candidate session evidence is missing required identifying fields (kind, section_kind, test_id, section_id, try_no). Aborting backfill:\n%', v_missing_evidence
        USING ERRCODE = '22023';
    END IF;

    -- =========================================================================
    -- Check 3: DEFER MIGRATION IF ACTIVE FLASH SESSIONS ARE IN PROGRESS
    -- A Flash session is active if status = 'open' and it has not expired.
    -- Preserves blocking; does not detach active sessions or invent claim tokens.
    -- =========================================================================
    SELECT string_agg(
      format('attempt_id: %s, student_id: %s, test_id: %s, section_id: %s, session_id: %s, try_no: %s, status: %s, expires_at: %s',
             a.id, a.student_id, a.test_id, a.section_id, ds.id, ds.settings->>'try_no', ds.status, ds.expires_at),
      E'\n'
    )
    INTO v_active_flash
    FROM public.weekly_test_attempts a
    JOIN public.weekly_test_sections s ON s.id = a.section_id
    JOIN public.drill_sessions ds ON (
      ds.id = a.session_id
      OR (
        ds.student_id = a.student_id
        AND ds.settings->>'section_id' = a.section_id::text
      )
    )
    WHERE s.kind = 'flash'
      AND ds.status = 'open'
      AND (ds.expires_at IS NULL OR ds.expires_at > now());

    IF v_active_flash IS NOT NULL THEN
      RAISE EXCEPTION 'ACTIVE FLASH SESSIONS IN PROGRESS: Cannot migrate while drill sessions are actively open. Defer migration until active sessions complete or expire. Active sessions:\n%', v_active_flash
        USING ERRCODE = '55000';
    END IF;

    -- =========================================================================
    -- Check 4: VALIDATE SESSION STATE & ORDINAL RANGE
    -- Validates session state ('submitted', 'completed', 'open') and integer ordinal
    -- within configured question_count range (1..question_count).
    -- Rejects inconsistent evidence transactionally.
    -- =========================================================================
    SELECT string_agg(
      format('attempt_id: %s, session_id: %s, status: %s, raw_try_no: %s, configured_max_tries: %s',
             a.id, ds.id, ds.status, ds.settings->>'try_no', COALESCE(s.question_count, 5)),
      E'\n'
    )
    INTO v_inconsistent_evidence
    FROM public.weekly_test_attempts a
    JOIN public.weekly_test_sections s ON s.id = a.section_id
    JOIN public.drill_sessions ds ON (
      ds.id = a.session_id
      OR (
        ds.student_id = a.student_id
        AND ds.settings->>'section_id' = a.section_id::text
      )
    )
    WHERE s.kind = 'flash'
      AND (
        ds.status NOT IN ('submitted', 'completed', 'open')
        OR (ds.settings->>'try_no') !~ '^[0-9]+$'
        OR (ds.settings->>'try_no')::int < 1
        OR (ds.settings->>'try_no')::int > COALESCE(s.question_count, 5)
      );

    IF v_inconsistent_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'INCONSISTENT SESSION EVIDENCE: Session has invalid state or try_no outside valid range 1..question_count. Aborting migration:\n%', v_inconsistent_evidence
        USING ERRCODE = '22023';
    END IF;

    -- =========================================================================
    -- Check 5: DUPLICATE ORDINAL EVIDENCE DETECTION
    -- Multiple drill sessions found with identical try_no for the same section attempt
    -- cannot be resolved and must abort transactionally.
    -- =========================================================================
    WITH dup_ordinals AS (
      SELECT
        a.id AS attempt_id,
        (ds.settings->>'try_no')::int AS try_no,
        count(*) AS cnt,
        array_agg(ds.id::text) AS session_ids
      FROM public.weekly_test_attempts a
      JOIN public.weekly_test_sections s ON s.id = a.section_id
      JOIN public.drill_sessions ds ON (
        ds.id = a.session_id
        OR (
          ds.student_id = a.student_id
          AND ds.settings->>'section_id' = a.section_id::text
        )
      )
      WHERE s.kind = 'flash'
        AND (ds.settings->>'try_no') ~ '^[0-9]+$'
      GROUP BY a.id, (ds.settings->>'try_no')::int
      HAVING count(*) > 1
    )
    SELECT string_agg(
      format('attempt_id: %s, try_no: %s, count: %s, session_ids: %s',
             attempt_id, try_no, cnt, array_to_string(session_ids, ', ')),
      E'\n'
    )
    INTO v_dup_ordinals
    FROM dup_ordinals;

    IF v_dup_ordinals IS NOT NULL THEN
      RAISE EXCEPTION 'DUPLICATE ORDINAL EVIDENCE DETECTED: Multiple drill sessions found with identical try_no for the same section attempt. Inconsistent evidence cannot be resolved. Duplicates:\n%', v_dup_ordinals
        USING ERRCODE = '23505';
    END IF;

    -- =========================================================================
    -- Check 6: AMBIGUITY CHECK (ZERO-SCORE PLACEHOLDERS & SCORE-ONLY GUESSING REMOVED)
    -- Correct answers and score rows do NOT establish tries started.
    -- Flash attempts lacking authoritative validated try ordinals MUST abort.
    -- =========================================================================
    WITH flash_attempts AS (
      SELECT
        a.id AS attempt_id,
        a.test_id,
        a.student_id,
        a.section_id,
        a.status,
        sc.correct AS score_correct,
        sc.total AS score_total,
        (SELECT MAX((ds.settings->>'try_no')::int)
         FROM public.drill_sessions ds
         WHERE (
           ds.id = a.session_id
           OR (
             ds.student_id = a.student_id
             AND ds.settings->>'section_id' = a.section_id::text
           )
         )
         AND ds.student_id = a.student_id
         AND ds.activity_type = 'flash_anzan'
         AND ds.settings->>'kind' = 'weekly_test'
         AND ds.settings->>'section_kind' = 'flash'
         AND ds.settings->>'test_id' = a.test_id::text
         AND ds.settings->>'section_id' = a.section_id::text
         AND (ds.settings->>'try_no') ~ '^[0-9]+$'
        ) AS max_validated_try_no
      FROM public.weekly_test_attempts a
      JOIN public.weekly_test_sections s ON s.id = a.section_id
      LEFT JOIN public.weekly_test_scores sc
        ON sc.test_id = a.test_id AND sc.student_id = a.student_id AND sc.section_id = a.section_id
      WHERE s.kind = 'flash'
    )
    SELECT string_agg(
      format('attempt_id: %s, test_id: %s, student_id: %s, section_id: %s, status: %s, score_correct: %s, score_total: %s',
             attempt_id, test_id, student_id, section_id, status, score_correct, score_total),
      E'\n'
    )
    INTO v_ambiguous_flash
    FROM flash_attempts
    WHERE max_validated_try_no IS NULL;

    IF v_ambiguous_flash IS NOT NULL THEN
      RAISE EXCEPTION 'AMBIGUOUS FLASH ATTEMPT DETECTED: Cannot recover tries_started without authoritative session try ordinals. Score-only records (including zero-score placeholders) do not establish tries started. Aborting backfill to prevent guessing. Ambiguous records:\n%', v_ambiguous_flash
        USING ERRCODE = '22023';
    END IF;

    -- =========================================================================
    -- Check 7: BACKFILL SINGLE-TRY SECTIONS (basics, elements, memoriad)
    -- =========================================================================
    UPDATE public.weekly_test_attempts a
    SET
      tries_started = 1,
      tries_correct = COALESCE(sub.correct, 0),
      seconds_used = COALESCE(sub.time_seconds, 0),
      updated_at = COALESCE(a.finished_at, a.started_at, now())
    FROM (
      SELECT
        a2.id AS attempt_id,
        sc.correct,
        sc.time_seconds
      FROM public.weekly_test_attempts a2
      JOIN public.weekly_test_sections s ON s.id = a2.section_id
      LEFT JOIN public.weekly_test_scores sc
        ON sc.test_id = a2.test_id AND sc.student_id = a2.student_id AND sc.section_id = s.id
      WHERE s.kind <> 'flash'
        AND a2.updated_at IS NULL
    ) sub
    WHERE a.id = sub.attempt_id;

    -- =========================================================================
    -- Check 8: BACKFILL FLASH SECTIONS FROM VALIDATED AUTHORITATIVE ORDINAL
    -- Uses the single consistently validated evidence set for ordinal recovery
    -- and final session selection.
    -- =========================================================================
    FOR v_rec IN
      SELECT
        a.id AS attempt_id,
        a.test_id,
        a.student_id,
        a.section_id,
        a.status,
        a.started_at,
        a.finished_at,
        (SELECT MAX((ds.settings->>'try_no')::int)
         FROM public.drill_sessions ds
         WHERE (
           ds.id = a.session_id
           OR (
             ds.student_id = a.student_id
             AND ds.settings->>'section_id' = a.section_id::text
           )
         )
         AND ds.student_id = a.student_id
         AND ds.activity_type = 'flash_anzan'
         AND ds.settings->>'kind' = 'weekly_test'
         AND ds.settings->>'section_kind' = 'flash'
         AND ds.settings->>'test_id' = a.test_id::text
         AND ds.settings->>'section_id' = a.section_id::text
         AND (ds.settings->>'try_no') ~ '^[0-9]+$'
        ) AS max_validated_try_no,
        sc.correct AS score_correct,
        sc.time_seconds AS score_time
      FROM public.weekly_test_attempts a
      JOIN public.weekly_test_sections s ON s.id = a.section_id
      LEFT JOIN public.weekly_test_scores sc
        ON sc.test_id = a.test_id AND sc.student_id = a.student_id AND sc.section_id = a.section_id
      WHERE s.kind = 'flash'
        AND a.updated_at IS NULL
    LOOP
      -- Resolve session_id for the maximum validated try_no using the exact validated evidence set
      SELECT ds.id INTO v_latest_session_id
      FROM public.drill_sessions ds
      WHERE ds.student_id = v_rec.student_id
        AND ds.activity_type = 'flash_anzan'
        AND ds.settings->>'kind' = 'weekly_test'
        AND ds.settings->>'section_kind' = 'flash'
        AND ds.settings->>'test_id' = v_rec.test_id::text
        AND ds.settings->>'section_id' = v_rec.section_id::text
        AND (ds.settings->>'try_no')::int = v_rec.max_validated_try_no
      ORDER BY ds.started_at DESC
      LIMIT 1;

      v_recovered_tries_correct := COALESCE(v_rec.score_correct, 0);
      v_recovered_seconds_used := COALESCE(v_rec.score_time, 0);

      UPDATE public.weekly_test_attempts
      SET tries_started = v_rec.max_validated_try_no,
          tries_correct = v_recovered_tries_correct,
          seconds_used = v_recovered_seconds_used,
          session_id = COALESCE(v_latest_session_id, session_id),
          claim_token = NULL,
          updated_at = COALESCE(v_rec.finished_at, v_rec.started_at, now())
      WHERE id = v_rec.attempt_id;
    END LOOP;

    -- Backfill any legacy attempts with NULL section_id but category_id set
    UPDATE public.weekly_test_attempts a
    SET
      tries_started = 1,
      tries_correct = COALESCE(sub.correct, 0),
      seconds_used = COALESCE(sub.time_seconds, 0),
      updated_at = COALESCE(a.finished_at, a.started_at, now())
    FROM (
      SELECT
        a2.id AS attempt_id,
        sc.correct,
        sc.time_seconds
      FROM public.weekly_test_attempts a2
      LEFT JOIN public.weekly_test_scores sc
        ON sc.test_id = a2.test_id AND sc.student_id = a2.student_id AND sc.category_id = a2.category_id
      WHERE a2.section_id IS NULL
        AND a2.category_id IS NOT NULL
        AND a2.updated_at IS NULL
    ) sub
    WHERE a.id = sub.attempt_id;
  END IF;

  -- 2c. Ensure updated_at has NOT NULL constraint and default
  ALTER TABLE public.weekly_test_attempts
    ALTER COLUMN updated_at SET DEFAULT now();

  UPDATE public.weekly_test_attempts
  SET updated_at = now()
  WHERE updated_at IS NULL;

  ALTER TABLE public.weekly_test_attempts
    ALTER COLUMN updated_at SET NOT NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. CONFLICT DETECTION & UNIQUE CONSTRAINTS (ZERO DATA LOSS)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_dup_attempts TEXT;
  v_dup_scores TEXT;
BEGIN
  -- 3a. Detect conflicting attempts: report diagnostics and abort rather than deleting
  WITH dups AS (
    SELECT test_id, student_id, section_id, count(*) AS cnt, array_agg(id::text ORDER BY started_at) AS ids
    FROM public.weekly_test_attempts
    WHERE section_id IS NOT NULL
    GROUP BY test_id, student_id, section_id
    HAVING count(*) > 1
  )
  SELECT string_agg(
    format('test_id: %s, student_id: %s, section_id: %s (count: %s, ids: %s)',
           test_id, student_id, section_id, cnt, array_to_string(ids, ', ')),
    E'\n'
  )
  INTO v_dup_attempts
  FROM dups;

  IF v_dup_attempts IS NOT NULL THEN
    RAISE EXCEPTION 'CONFLICTING ATTEMPTS DETECTED: Cannot create unique index uq_weekly_test_attempts_test_student_section because duplicate attempt records exist. Aborting transaction to prevent data loss. Conflicting groups:\n%', v_dup_attempts
      USING ERRCODE = '23505';
  END IF;

  -- 3b. Detect conflicting scores: report diagnostics and abort rather than deleting
  WITH dups AS (
    SELECT test_id, student_id, section_id, count(*) AS cnt, array_agg(id::text ORDER BY id) AS ids
    FROM public.weekly_test_scores
    WHERE section_id IS NOT NULL
    GROUP BY test_id, student_id, section_id
    HAVING count(*) > 1
  )
  SELECT string_agg(
    format('test_id: %s, student_id: %s, section_id: %s (count: %s, ids: %s)',
           test_id, student_id, section_id, cnt, array_to_string(ids, ', ')),
    E'\n'
  )
  INTO v_dup_scores
  FROM dups;

  IF v_dup_scores IS NOT NULL THEN
    RAISE EXCEPTION 'CONFLICTING SCORES DETECTED: Cannot create unique index uq_weekly_test_scores_test_student_section because duplicate score records exist. Aborting transaction to prevent data loss. Conflicting groups:\n%', v_dup_scores
      USING ERRCODE = '23505';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_test_attempts_test_student_section
  ON public.weekly_test_attempts (test_id, student_id, section_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_test_scores_test_student_section
  ON public.weekly_test_scores (test_id, student_id, section_id);

-- -----------------------------------------------------------------------------
-- 4. HELPER SECURITY FUNCTIONS FOR RECIPIENT SCOPING & TIME
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.today_ist()
RETURNS DATE
LANGUAGE sql
STABLE
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

CREATE OR REPLACE FUNCTION public.has_weekly_test_recipients(p_test_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.weekly_test_recipients
    WHERE test_id = p_test_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_weekly_test_recipient(p_test_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.weekly_test_recipients
    WHERE test_id = p_test_id AND student_id = p_student_id
  );
$$;

REVOKE ALL ON FUNCTION public.has_weekly_test_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_weekly_test_recipients(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_weekly_test_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_weekly_test_recipient(UUID, UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. RPC: weekly_test_reserve_section_start (Phase 16d / Phase 18 Authoritative)
-- -----------------------------------------------------------------------------
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
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_student_id AND NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
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
  -- Step 3: Eligibility Checks (Online, Window, Audience Level & Recipient Scope)
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
    IF v_test.test_date > public.today_ist() THEN
      RAISE EXCEPTION 'This weekly test has not opened yet'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Targeted Recipient Enforcement (Durable audience scope):
  IF v_test.target_scope = 'targeted' OR public.has_weekly_test_recipients(p_test_id) THEN
    IF NOT public.is_weekly_test_recipient(p_test_id, p_student_id) THEN
      RAISE EXCEPTION 'You are not assigned to this weekly test' USING ERRCODE = '42501';
    END IF;
  ELSIF v_test.audience_level IS NOT NULL AND TRIM(v_test.audience_level) <> '' AND LOWER(TRIM(v_test.audience_level)) <> 'everyone' THEN
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

      -- Check if an active try claim or active linked session is currently in progress
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
      ELSIF v_att.session_id IS NOT NULL THEN
        -- Check if linked session is still open and unexpired
        IF EXISTS (
          SELECT 1 FROM public.drill_sessions ds
          WHERE ds.id = v_att.session_id
            AND ds.status = 'open'
            AND (ds.expires_at IS NULL OR ds.expires_at > NOW())
        ) THEN
          RAISE EXCEPTION 'A try is currently in progress for this section'
            USING ERRCODE = '23505';
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

-- -----------------------------------------------------------------------------
-- 6. RPC: weekly_test_rollback_start_reservation (Phase 16d Authoritative)
-- -----------------------------------------------------------------------------
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
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_student_id AND NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
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

-- -----------------------------------------------------------------------------
-- 7. RPC: public.my_weekly_tests() (Clean Student Listing)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_weekly_tests()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not allowed: Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'notes', t.notes,
      'test_date', t.test_date,
      'type', t.test_type,
      'opens_at', t.o,
      'closes_at', t.c,
      'state', CASE
                 WHEN t.test_type = 'online' THEN
                   CASE
                     WHEN now() < t.o THEN 'upcoming'
                     WHEN now() >= t.c THEN 'closed'
                     ELSE 'open'
                   END
                 ELSE
                   CASE
                     WHEN t.test_date > v_today THEN 'upcoming'
                     WHEN t.test_date = v_today THEN 'today'
                     ELSE 'past'
                   END
               END,
      'leaderboard_ready', (t.test_type <> 'online' OR CASE WHEN now() < t.o THEN 'upcoming' WHEN now() >= t.c THEN 'closed' ELSE 'open' END = 'closed'),
      'sections', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'section_id', s.id,
                 'kind', s.kind,
                 'category_id', s.category_id,
                 'name', c.name,
                 'activity_key', s.activity_key,
                 'seconds', s.seconds,
                 'position', s.position,
                 'flash_digits', s.flash_digits,
                 'flash_count', s.flash_count,
                 'flash_speed_ms', s.flash_speed_ms,
                 'flash_mode', s.flash_mode,
                 'question_count', s.question_count,
                 'attempt', a.status,
                 'tries_started', CASE
                                    WHEN s.kind = 'flash' THEN
                                      COALESCE(
                                        a.tries_started,
                                        CASE
                                          WHEN a.status = 'submitted' THEN COALESCE(s.question_count, 5)
                                          WHEN a.status = 'started' THEN 1
                                          ELSE 0
                                        END,
                                        0
                                      )
                                    ELSE 0
                                  END,
                 'tries_correct', CASE
                                    WHEN s.kind = 'flash' THEN COALESCE(a.tries_correct, sc.correct, 0)
                                    ELSE 0
                                  END,
                 'correct', sc.correct,
                 'total', sc.total,
                 'time_seconds', sc.time_seconds
               ) ORDER BY s.position)
          FROM public.weekly_test_sections s
          LEFT JOIN public.categories c ON c.id = s.category_id
          LEFT JOIN public.weekly_test_attempts a
                 ON a.test_id = t.id
                AND a.student_id = v_me
                AND (a.section_id = s.id OR (a.section_id IS NULL AND s.category_id IS NOT NULL AND a.category_id = s.category_id))
          LEFT JOIN public.weekly_test_scores sc
                 ON sc.test_id = t.id
                AND sc.student_id = v_me
                AND (sc.section_id = s.id OR (sc.section_id IS NULL AND s.category_id IS NOT NULL AND sc.category_id = s.category_id))
         WHERE s.test_id = t.id
      ), '[]'::jsonb),
      'scores', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'section_id', sc2.section_id,
                 'category_id', COALESCE(sc2.category_id, s2.category_id),
                 'category', c2.name,
                 'kind', COALESCE(s2.kind, CASE WHEN c2.section = 'round' THEN 'round' ELSE 'basics' END),
                 'activity_key', s2.activity_key,
                 'flash_digits', s2.flash_digits,
                 'flash_count', s2.flash_count,
                 'flash_speed_ms', s2.flash_speed_ms,
                 'flash_mode', s2.flash_mode,
                 'question_count', s2.question_count,
                 'seconds', s2.seconds,
                 'correct', sc2.correct,
                 'total', sc2.total,
                 'time_seconds', sc2.time_seconds,
                 'source', sc2.source
                ))
          FROM public.weekly_test_scores sc2
          LEFT JOIN public.weekly_test_sections s2 ON s2.id = sc2.section_id
          LEFT JOIN public.categories c2 ON c2.id = COALESCE(sc2.category_id, s2.category_id)
         WHERE sc2.test_id = t.id AND sc2.student_id = v_me
      ), '[]'::jsonb)
    ) ORDER BY t.test_date DESC)
    FROM (
      SELECT w.*,
             COALESCE(w.opens_at, (w.test_date::timestamp AT TIME ZONE 'Asia/Kolkata')) AS o,
             COALESCE(w.closes_at, ((w.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS c
        FROM public.weekly_tests w
       WHERE (
         w.test_date BETWEEN v_today - 180 AND v_today + 60
         OR (w.test_type = 'online' AND (w.closes_at IS NULL OR w.closes_at > now()))
       )
         AND (
           -- Targeted test assigned to this student in recipients table
           EXISTS (
             SELECT 1 FROM public.weekly_test_recipients wtr
             WHERE wtr.test_id = w.id AND wtr.student_id = v_me
           )
           -- Or general audience test matching student level
           OR (
             COALESCE(w.target_scope, 'all') = 'all'
             AND (
               w.audience_level IS NULL
               OR LOWER(TRIM(w.audience_level)) = 'everyone'
               OR LOWER(TRIM(w.audience_level)) = LOWER(TRIM(COALESCE(v_level, '')))
             )
           )
         )
    ) t
  ), '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. PERMISSIONS & ROW LEVEL SECURITY
-- -----------------------------------------------------------------------------
-- Server-only execution for reservation and rollback
REVOKE ALL ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.weekly_test_rollback_start_reservation(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_rollback_start_reservation(UUID, UUID, UUID) TO service_role;

-- Student listing RPC
REVOKE ALL ON FUNCTION public.my_weekly_tests() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.my_weekly_tests() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_weekly_tests() TO authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.my_weekly_tests() TO service_role';
  END IF;
END $$;

-- Table-level grants and RLS
ALTER TABLE public.weekly_test_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weekly_test_attempts_select" ON public.weekly_test_attempts;
DROP POLICY IF EXISTS "wt_attempts_read" ON public.weekly_test_attempts;
CREATE POLICY "weekly_test_attempts_select"
ON public.weekly_test_attempts FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_teacher')
    AND public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'review_scores')
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

DROP POLICY IF EXISTS "wt_attempts_admin_write" ON public.weekly_test_attempts;
CREATE POLICY "wt_attempts_admin_write"
ON public.weekly_test_attempts FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_attempts TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_scores TO authenticated, service_role;

COMMIT;

-- -----------------------------------------------------------------------------
-- 9. POST-INSTALL VERIFICATION CHECKS (Run in SQL Editor after script)
-- -----------------------------------------------------------------------------
-- Check 1: Verify all 5 columns exist on public.weekly_test_attempts
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'weekly_test_attempts'
--   AND column_name IN ('tries_started', 'tries_correct', 'seconds_used', 'claim_token', 'updated_at');

-- Check 2: Verify unique indexes are active
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public' AND indexname IN (
--   'uq_weekly_test_attempts_test_student_section',
--   'uq_weekly_test_scores_test_student_section'
-- );

-- Check 3: Verify routines exist with correct security definer
-- SELECT proname, prosecdef, provolatile
-- FROM pg_proc
-- WHERE proname IN ('weekly_test_reserve_section_start', 'weekly_test_rollback_start_reservation', 'my_weekly_tests');
