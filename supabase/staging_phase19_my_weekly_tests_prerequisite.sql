-- ==============================================================================
-- Trendz Tracker — Phase 19 Staging Database Prerequisite: my_weekly_tests() RPC
-- File: supabase/staging_phase19_my_weekly_tests_prerequisite.sql
--
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Installs the authenticated RPC `public.my_weekly_tests()` on the staging database.
-- Implements the exact current contract against the ACTUAL staging database schema:
-- 1. Matches actual public.weekly_test_attempts table (which has id, test_id,
--    student_id, section_id, category_id, session_id, status, started_at, finished_at;
--    NO tries_started or tries_correct columns).
-- 2. Derives Flash progress authoritatively from existing session storage
--    (public.drill_sessions settings ->> 'try_no' linked via a.session_id)
--    and score storage (public.weekly_test_scores correct/total), without inventing
--    unsupported columns on weekly_test_attempts.
-- 3. LEFT JOINs public.categories to support modern Elements, Flash Anzan, and
--    Memoriad sections where category_id is NULL.
-- 4. Links attempts and scores via section_id (falling back to category_id for legacy rows).
-- 5. Supports targeted recipient tests (via public.weekly_test_recipients) as well
--    as general audience level tests (target_scope = 'all').
-- 6. Returns JSON test structure with section_id, kind, activity_key, flash specs,
--    attempts, scores, and authoritative window state ('open', 'upcoming', 'closed').
--
-- SAFETY & ISOLATION:
-- 1. OPERATOR CONFIRMATION LATCH: Requires `SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';`
-- 2. PRODUCTION DATA TRIPWIRE: Immediately aborts if Mumbai production student records exist.
-- 3. SEPARATION: Dedicated staging prerequisite script. DO NOT execute on Mumbai production!
--
-- HOW TO RUN:
-- 1. In Supabase Dashboard, verify you are viewing project `xhgzbbkvwojwfbexvcmh`.
-- 2. Paste this entire script into the Staging Supabase SQL Editor as database owner.
-- 3. Execute to restore `my_weekly_tests()` RPC on staging.
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
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'weekly_test_scores')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'drill_sessions') THEN
    RAISE EXCEPTION 'Prerequisite missing: Weekly test baseline tables not found in schema public.'
      USING ERRCODE = '42P01';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. CREATE FUNCTION: public.my_weekly_tests()
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
                                        (SELECT (ds.settings ->> 'try_no')::int
                                           FROM public.drill_sessions ds
                                          WHERE ds.id = a.session_id),
                                        (SELECT count(*)::int
                                           FROM public.drill_sessions ds
                                          WHERE ds.student_id = v_me
                                            AND ds.activity_type = 'flash_anzan'
                                            AND ds.settings ->> 'kind' = 'weekly_test'
                                            AND (ds.settings ->> 'section_id')::uuid = s.id),
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
                                    WHEN s.kind = 'flash' THEN COALESCE(sc.correct, 0)
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
-- 3. PERMISSIONS & ANONYMOUS ACCESS RESTRICTION
-- -----------------------------------------------------------------------------
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

COMMIT;

-- -----------------------------------------------------------------------------
-- 4. VERIFICATION CHECKS (Run in SQL Editor after script)
-- -----------------------------------------------------------------------------
-- Check 1: Function exists with security definer and stable volatility
-- SELECT routine_name, routine_type, provolatile, security_type
-- FROM information_schema.routines r
-- JOIN pg_proc p ON p.proname = r.routine_name
-- WHERE r.routine_schema = 'public' AND r.routine_name = 'my_weekly_tests';

-- Check 2: Verify explicit REVOKE from anon, GRANT to authenticated & service_role
-- SELECT grantee, privilege_type
-- FROM information_schema.routine_privileges
-- WHERE routine_schema = 'public' AND routine_name = 'my_weekly_tests';
