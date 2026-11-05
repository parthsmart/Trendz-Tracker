-- =============================================================================
-- Trendz Tracker — JMCWC Staging API Integration Fixture Setup SQL (COMMITTED)
-- File: supabase/tests/jmcwc_staging_api_fixtures_setup.sql
--
-- TARGET ENVIRONMENT: ISOLATED STAGING DATABASE ONLY (DO NOT RUN IN PRODUCTION).
-- PURPOSE:
--   Separate HTTP/API requests made by `tests/jmcwcStagingApi.integration.js`
--   cannot see uncommitted rows inside a rolled-back SQL transaction.
--   Run this setup script on STAGING before running the live API integration
--   harness, then run `supabase/tests/jmcwc_staging_api_fixtures_cleanup.sql`
--   afterward to remove only these synthetic staging fixtures.
--
-- IMPORTANT SAFEGUARDS:
--   1. Does NOT assume inserting into `public.profiles` creates an Auth user.
--      Verifies that the dedicated test student already exists in `auth.users`.
--   2. Does NOT publish, modify, or delete any existing `'2026.1'` paper.
--      Inserts a separate synthetic staging paper with fixed fixture ID
--      `00000000-0000-4000-8000-000000172098` and version `'staging-api-fixture-2026.1'`.
-- =============================================================================

BEGIN;

DO $setup_api_fixtures$
DECLARE
  -- Optional: paste your staging Auth user UUID here, or leave NULL to look up
  -- the staging profile with student_code = 'JMCWC_STAGE_TEST_01'.
  v_override_student_id uuid := NULL;
  v_student_id uuid;
  v_fixture_paper_id uuid := '00000000-0000-4000-8000-000000172098';
  v_fixture_paper_version text := 'staging-api-fixture-2026.1';
  v_sections jsonb := '[]'::jsonb;
  v_slot_idx integer;
  v_slot_questions jsonb;
  v_cat record;
BEGIN
  -- 1. Resolve the real Supabase Auth staging test user
  IF v_override_student_id IS NOT NULL THEN
    v_student_id := v_override_student_id;
  ELSE
    SELECT id INTO v_student_id
    FROM public.profiles
    WHERE student_code = 'JMCWC_STAGE_TEST_01'
    LIMIT 1;
  END IF;

  IF v_student_id IS NULL THEN
    RAISE EXCEPTION
      'Staging test student not found. First create a dedicated user in Staging Supabase Auth and set their public.profiles.student_code = ''JMCWC_STAGE_TEST_01'' (or set v_override_student_id at the top of this script).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_student_id) THEN
    RAISE EXCEPTION
      'User UUID % does not exist in auth.users. Create the test user through Supabase Auth first.',
      v_student_id;
  END IF;

  -- Assert test profile matches expected isolation invariants
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_student_id
      AND student_code = 'JMCWC_STAGE_TEST_01'
      AND role = 'student'
      AND active = true
  ) THEN
    RAISE EXCEPTION
      'Test isolation violation: user % must have student_code = ''JMCWC_STAGE_TEST_01'', role = ''student'', and active = true.',
      v_student_id;
  END IF;

  -- 2. Verify canonical 23 categories are present in staging
  IF (SELECT count(*) FROM public.jmcwc_categories) <> 23 THEN
    RAISE EXCEPTION
      'Canonical categories missing: public.jmcwc_categories must contain all 23 workbook categories.';
  END IF;

  -- 3. Remove any leftover attempts created by this specific test student on the synthetic fixture paper
  DELETE FROM public.jmcwc_attempts
  WHERE student_id = v_student_id
    AND paper_id = v_fixture_paper_id;

  -- 4. Assign the dedicated staging test student to 'junior1'
  INSERT INTO public.jmcwc_assignments (student_id, group_key)
  VALUES (v_student_id, 'junior1')
  ON CONFLICT (student_id) DO UPDATE
    SET group_key = 'junior1';

  -- 5. Insert a dedicated published synthetic staging paper ('staging-api-fixture-2026.1')
  --    Leaves any existing '2026.1' paper completely untouched (published = false).
  FOR v_cat IN SELECT key, position FROM public.jmcwc_categories ORDER BY position ASC LOOP
    v_slot_questions := '[]'::jsonb;
    FOR v_slot_idx IN 1..10 LOOP
      v_slot_questions := v_slot_questions || jsonb_build_array(
        jsonb_build_object(
          'slot', v_slot_idx,
          'max_marks', 1,
          'generator', 'addition',
          'parameters', jsonb_build_object('scoring_mode', 'fixed', 'digits', jsonb_build_array(2, 2))
        )
      );
    END LOOP;
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object('key', v_cat.key, 'questions', v_slot_questions)
    );
  END LOOP;

  INSERT INTO public.jmcwc_papers (id, group_key, version, spec, published, created_at)
  VALUES (
    v_fixture_paper_id,
    'junior1',
    v_fixture_paper_version,
    jsonb_build_object('sections', v_sections),
    true,
    now() + interval '1 second'
  )
  ON CONFLICT (id) DO NOTHING;
END
$setup_api_fixtures$;

COMMIT;
