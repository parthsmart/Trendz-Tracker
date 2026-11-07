-- ==============================================================================
-- Trendz Tracker — Owner Phase 19: Post-Restore Rollout Boundary State Restoration
-- File: supabase/owner_phase19_restore_activation.sql
--
-- EXECUTION INSTRUCTIONS:
-- Run in Supabase SQL Editor as database owner (postgres) AFTER restoring application tables.
--
-- PURPOSE:
-- Restores the exact saved deployment rollout state for 'phase19_authoritative_todo'.
-- On a newly restored or rebuilt database, initial migration sets:
--   feature = 'phase19_authoritative_todo', status = 'installed', activated_at = NULL
--
-- RESTORATION INVARIANTS:
-- 1. Exact Saved State Required:
--    You MUST provide the exact exported rollout status ('active' or 'installed')
--    in `v_saved_status`.
--
-- 2. Exact Timestamp Required When Active:
--    If v_saved_status = 'active', you MUST provide the exact historical activation
--    timestamp in `v_saved_activated_at` (e.g. '2026-11-07 10:15:30.123456+00'::timestamptz).
--    NEVER invent a timestamp or default to now() — doing so shifts the historical
--    eligibility boundary and can incorrectly grandfather post-activation scores or sessions.
--
-- 3. Preserve Unactivated Deployments:
--    If the deployment was not activated prior to the disaster (v_saved_status = 'installed'),
--    set v_saved_activated_at := NULL. The script will restore 'installed' status without
--    prematurely activating authoritative task credit enforcement.
--
-- 4. Fail-Closed On Missing State:
--    If v_saved_status is NULL, invalid, or if v_saved_activated_at is missing for an active
--    deployment, the script ABORTS immediately with a descriptive error.
-- ==============================================================================

BEGIN;

-- 1. Verify prerequisite: public.rollout_boundaries must exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rollout_boundaries'
  ) THEN
    RAISE EXCEPTION 'Restoration aborted: table public.rollout_boundaries does not exist. Run owner_phase19_improvements_migration.sql first.'
      USING ERRCODE = '42P01';
  END IF;
END $$;

-- 2. Restore exact saved status and activation timestamp
DO $$
DECLARE
  -- --------------------------------------------------------------------------
  -- OWNER CONFIGURATION (REQUIRED):
  -- Fill in the exact values from your private rollout state export:
  -- --------------------------------------------------------------------------
  v_saved_status TEXT := NULL;              -- Must be set to 'active' or 'installed'
  v_saved_activated_at TIMESTAMPTZ := NULL; -- Required if v_saved_status = 'active', e.g. '2026-11-07 10:15:30.123456+00'::timestamptz
BEGIN
  -- Validate v_saved_status is provided
  IF v_saved_status IS NULL OR trim(v_saved_status) = '' THEN
    RAISE EXCEPTION 'Restoration aborted: saved rollout status (v_saved_status) is required. Set v_saved_status to ''active'' or ''installed'' from your private export.'
      USING ERRCODE = '22023';
  END IF;

  IF v_saved_status NOT IN ('installed', 'active') THEN
    RAISE EXCEPTION 'Restoration aborted: invalid saved status ''%''. Must be ''installed'' or ''active''.', v_saved_status
      USING ERRCODE = '22023';
  END IF;

  -- Validate activation timestamp according to status
  IF v_saved_status = 'active' THEN
    IF v_saved_activated_at IS NULL THEN
      RAISE EXCEPTION 'Restoration aborted: saved status is ''active'' but original activation timestamp (v_saved_activated_at) is NULL. You must provide the exact historical activation timestamp from your private export to avoid shifting the eligibility boundary.'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    -- v_saved_status = 'installed'
    IF v_saved_activated_at IS NOT NULL THEN
      RAISE EXCEPTION 'Restoration aborted: saved status is ''installed'' but v_saved_activated_at is set (%). An unactivated deployment must have NULL activated_at.', v_saved_activated_at
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Apply exact restored state (never guessing or inventing now())
  UPDATE public.rollout_boundaries
     SET status = v_saved_status,
         activated_at = v_saved_activated_at
   WHERE feature = 'phase19_authoritative_todo';

  IF NOT FOUND THEN
    INSERT INTO public.rollout_boundaries (feature, status, activated_at)
    VALUES ('phase19_authoritative_todo', v_saved_status, v_saved_activated_at);
  END IF;

  RAISE NOTICE 'Rollout state successfully restored for feature ''phase19_authoritative_todo'': status=%, activated_at=%',
    v_saved_status, v_saved_activated_at;
END $$;

COMMIT;

-- ------------------------------------------------------------------------------
-- Verification Query (Read-Only)
-- Run after committing to confirm policy state matches your private export:
-- ------------------------------------------------------------------------------
-- SELECT feature, status, activated_at
-- FROM public.rollout_boundaries
-- WHERE feature = 'phase19_authoritative_todo';
