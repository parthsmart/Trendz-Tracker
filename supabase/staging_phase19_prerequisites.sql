-- ==============================================================================
-- Trendz Tracker — Phase 19 Staging Database Prerequisites Setup
-- File: supabase/staging_phase19_prerequisites.sql
--
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Installs prerequisite database objects required by Phase 19 on staging that are
-- already present on live Mumbai production (specifically public.flash_generate_question).
--
-- SAFETY & ISOLATION:
-- 1. OPERATOR CONFIRMATION LATCH: Requires `SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';`
-- 2. PRODUCTION DATA TRIPWIRE: Immediately aborts if Mumbai production student records exist.
-- 3. SEPARATION: Kept completely separate from the production upgrade migration.
--
-- HOW TO RUN:
-- 1. In Supabase Dashboard, verify you are viewing project `xhgzbbkvwojwfbexvcmh`.
-- 2. Paste this entire script into the Staging Supabase SQL Editor as database owner.
-- 3. Execute before running owner_phase19_improvements_migration.sql on staging.
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
BEGIN
  -- 0a. Operator Intent Confirmation Latch
  IF v_target_env IS DISTINCT FROM 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR SAFETY HALT: Target environment latch unset or mismatched. Got "%". Set `SET app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'';` before running.',
      COALESCE(v_target_env, '<unset>')
      USING ERRCODE = '28000';
  END IF;

  -- 0b. Secondary Safeguard: Production Data Tripwire
  IF EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE student_code IN ('STU101', 'STU-101') AND full_name ILIKE '%Riya%'
  ) THEN
    RAISE EXCEPTION 'SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected in public.profiles (STU101 / Riya)! Refusing execution on production database (kgzivhavpsvitwrscrrj).'
      USING ERRCODE = '55000';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. PREREQUISITE BASELINE TABLES VALIDATION
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'profiles')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'categories')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'daily_tasks')
     OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'drill_sessions') THEN
    RAISE EXCEPTION 'Prerequisite missing: Baseline tables not found. Run supabase/staging_phase18_prerequisites.sql first before this script.'
      USING ERRCODE = '55000';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. AUTHORITATIVE FLASH QUESTION GENERATOR
-- Authoritative copy from Mumbai production schema dump (pg_dump lines 655-703).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.flash_generate_question(
  p_digits integer,
  p_count integer,
  p_mode text
)
RETURNS integer[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_nums integer[] := ARRAY[]::integer[];
  v_lo integer;
  v_hi integer;
  v_n integer;
  v_sign integer;
  v_total integer := 0;
  v_prev integer := NULL;
  v_tries integer;
BEGIN
  v_lo := 10^(p_digits - 1);
  v_hi := (10^p_digits) - 1;
  FOR i IN 1..p_count LOOP
    v_tries := 0;
    LOOP
      v_tries := v_tries + 1;
      v_n := v_lo + floor(random() * (v_hi - v_lo + 1))::integer;
      v_sign := 1;
      IF p_mode = 'add_sub' AND i > 1 AND random() < 0.4 THEN
        v_sign := -1;
      END IF;
      IF v_sign = -1 AND v_total - v_n < 0 THEN
        v_sign := 1;
      END IF;
      EXIT WHEN v_prev IS NULL OR v_n <> v_prev OR v_tries > 20;
    END LOOP;
    v_nums := v_nums || (v_sign * v_n);
    v_total := v_total + v_sign * v_n;
    v_prev := v_n;
  END LOOP;
  RETURN v_nums;
END;
$$;

REVOKE ALL ON FUNCTION public.flash_generate_question(integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_generate_question(integer, integer, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.flash_generate_question(integer, integer, text) IS
  'Generates random numbers for Flash Anzan drills with digit clamping, consecutive repetition avoidance, and subtotal positivity constraints.';

COMMIT;

-- ------------------------------------------------------------------------------
-- Verification Query (Read-Only)
-- Run after committing to confirm generator functionality:
-- ------------------------------------------------------------------------------
-- SELECT public.flash_generate_question(2, 5, 'add') AS test_addition_sequence;
-- SELECT public.flash_generate_question(2, 5, 'add_sub') AS test_add_sub_sequence;
