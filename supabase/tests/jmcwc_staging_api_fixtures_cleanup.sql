-- =============================================================================
-- Trendz Tracker — JMCWC Staging API Integration Fixture Cleanup SQL
-- File: supabase/tests/jmcwc_staging_api_fixtures_cleanup.sql
--
-- TARGET ENVIRONMENT: ISOLATED STAGING DATABASE ONLY.
-- PURPOSE:
--   Removes ONLY the explicitly identified synthetic API test fixtures created by
--   `supabase/tests/jmcwc_staging_api_fixtures_setup.sql` and `tests/jmcwcStagingApi.integration.js`:
--     - Attempts tied to synthetic fixture paper `00000000-0000-4000-8000-000000172098`
--       (cascades to their `jmcwc_payloads` and `jmcwc_scores` rows)
--     - The synthetic fixture paper `00000000-0000-4000-8000-000000172098`
--       (`version = 'staging-api-fixture-2026.1'`)
--     - The group assignment for the dedicated test student (`student_code = 'JMCWC_STAGE_TEST_01'`)
--
--   NEVER deletes any existing `'2026.1'` papers or any real student profiles/records.
-- =============================================================================

BEGIN;

-- 1. Delete only attempts created against the synthetic staging fixture paper
DELETE FROM public.jmcwc_attempts
WHERE paper_id = '00000000-0000-4000-8000-000000172098'::uuid;

-- 2. Delete the group assignment for the dedicated staging test student
DELETE FROM public.jmcwc_assignments
WHERE student_id IN (
  SELECT id
  FROM public.profiles
  WHERE student_code = 'JMCWC_STAGE_TEST_01'
);

-- 3. Delete only the explicitly identified synthetic staging fixture paper
DELETE FROM public.jmcwc_papers
WHERE id = '00000000-0000-4000-8000-000000172098'::uuid
  AND version = 'staging-api-fixture-2026.1';

COMMIT;
