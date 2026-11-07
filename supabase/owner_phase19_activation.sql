-- ==============================================================================
-- Trendz Tracker — Owner Phase 19: Authoritative Task Credit Policy Activation
-- File: supabase/owner_phase19_activation.sql
--
-- EXECUTION INSTRUCTIONS:
-- 1. Review this script carefully.
-- 2. Run in Supabase SQL Editor on target project (e.g. staging or production) ONLY AFTER:
--    a) The installation migration (owner_phase19_improvements_migration.sql) has been applied.
--    b) The Phase 19 application code has been deployed to the respective environment.
-- 3. On shared Mumbai (kgzivhavpsvitwrscrrj):
--    DO NOT run this script while production still runs Phase 18 code!
--    First release Phase 19 to production, then execute this activation script.
-- ==============================================================================

BEGIN;

-- Verify rollout_boundaries table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rollout_boundaries'
  ) THEN
    RAISE EXCEPTION 'Prerequisite missing: public.rollout_boundaries table does not exist. Run owner_phase19_improvements_migration.sql first.';
  END IF;
END $$;

-- Activate authoritative task credit policy and record the activation timestamp once
UPDATE public.rollout_boundaries
   SET status = 'active',
       activated_at = COALESCE(activated_at, now())
 WHERE feature = 'phase19_authoritative_todo';

-- If no row existed for phase19_authoritative_todo, insert as active
INSERT INTO public.rollout_boundaries (feature, status, activated_at)
VALUES ('phase19_authoritative_todo', 'active', now())
ON CONFLICT (feature) DO UPDATE
   SET status = 'active',
       activated_at = COALESCE(public.rollout_boundaries.activated_at, EXCLUDED.activated_at);

COMMIT;

-- ------------------------------------------------------------------------------
-- Verification Query (Read-Only)
-- Run after committing to confirm policy activation:
-- ------------------------------------------------------------------------------
-- SELECT feature, status, activated_at
-- FROM public.rollout_boundaries
-- WHERE feature = 'phase19_authoritative_todo';
