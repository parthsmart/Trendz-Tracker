-- ==============================================================================
-- TRENDZ TRACKER - STAGING PREREQUISITE: TODO_STREAK_START SETTING
-- ==============================================================================
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Configures the missing 'todo_streak_start' in public.competition_settings on
-- Staging (project xhgzbbkvwojwfbexvcmh).
--
-- INTENDED DATE:
-- '2026-10-29' (Matching authoritative production start date when daily todo rule activated)
--
-- SAFETY SAFEGUARDS:
-- 1. Explicit target environment latch ('staging_xhgzbbkvwojwfbexvcmh')
-- 2. Production data tripwire (aborts immediately if STU101 / Riya detected)
-- ==============================================================================

-- Operator confirmation latch
SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. PRE-FLIGHT SAFETY CHECKS: OPERATOR LATCH & PRODUCTION DATA TRIPWIRE
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_target_env TEXT := current_setting('app.target_environment', true);
BEGIN
  -- 0a. Operator Intent Confirmation Latch
  IF v_target_env IS DISTINCT FROM 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR SAFETY HALT: Target environment latch unset or mismatched. Got "%". Set app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'' before running.',
      COALESCE(v_target_env, '<unset>')
      USING ERRCODE = '28000';
  END IF;

  -- 0b. Secondary Safeguard: Production Data Tripwire
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'student_code'
  ) AND EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE student_code IN ('STU101', 'STU-101') AND full_name ILIKE '%Riya%'
  ) THEN
    RAISE EXCEPTION 'SECONDARY SAFEGUARD TRIPWIRE: Live Mumbai production student data detected in public.profiles (STU101 / Riya)! Refusing execution on production database (kgzivhavpsvitwrscrrj).'
      USING ERRCODE = '55000';
  END IF;
END $$;

SET search_path = public, pg_temp;

-- -----------------------------------------------------------------------------
-- 1. CONFIGURE TODO_STREAK_START SETTING
-- -----------------------------------------------------------------------------
INSERT INTO public.competition_settings (key, value, updated_at)
VALUES ('todo_streak_start', '2026-10-29', now())
ON CONFLICT (key) DO UPDATE
SET value = '2026-10-29', updated_at = now();

-- -----------------------------------------------------------------------------
-- 2. POST-APPLY VERIFICATION
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_val TEXT;
  v_date DATE;
BEGIN
  SELECT value INTO v_val
    FROM public.competition_settings
   WHERE key = 'todo_streak_start';

  IF v_val IS NULL THEN
    RAISE EXCEPTION 'Verification failed: todo_streak_start key not found in competition_settings.';
  END IF;

  BEGIN
    v_date := v_val::DATE;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Verification failed: todo_streak_start value "%" is not a valid DATE.', v_val;
  END;

  IF v_date IS DISTINCT FROM '2026-10-29'::DATE THEN
    RAISE EXCEPTION 'Verification failed: todo_streak_start expected "2026-10-29", found "%".', v_val;
  END IF;
END $$;

COMMIT;
