-- =============================================================================
-- Trendz Tracker — JMCWC Owner-Run Staging PostgreSQL Regression Script
-- File: supabase/tests/jmcwc_staging_regression.sql
--
-- TARGET ENVIRONMENT: ISOLATED STAGING DATABASE ONLY.
-- TRANSACTION SAFETY: Entire script is wrapped in BEGIN ... ROLLBACK; so all
-- sequential database tests roll back cleanly at the end of execution.
-- ZERO IMPACT ON REAL DATA: Uses a dedicated real Supabase Auth staging test user
-- (student_code = 'JMCWC_STAGE_TEST_01') and synthetic paper versions
-- ('staging-synthetic-unpub-2026.1' / 'staging-synthetic-pub-2026.1').
-- Never updates or deletes any real student records or existing '2026.1' papers.
--
-- PREREQUISITES:
--   1. Schema & Categories: Staging database must already have the deployed schema,
--      tables, functions, triggers, and all 23 canonical jmcwc_categories seeded.
--   2. Dedicated Staging Student: Create a dedicated user in Staging Supabase Auth
--      (e.g. jmcwc-stage-test@example.com) and ensure public.profiles has:
--         student_code = 'JMCWC_STAGE_TEST_01', role = 'student', active = true.
--      If v_override_student_id is supplied, that profile must already have
--      student_code = 'JMCWC_STAGE_TEST_01', role = 'student', and active = true.
--      The script asserts these prerequisites and rolls back all test mutations.
-- =============================================================================

BEGIN;

DO $staging_regression$
DECLARE
  -- Optional: paste your staging Auth user UUID here, or leave NULL to look up
  -- the staging profile with student_code = 'JMCWC_STAGE_TEST_01'.
  v_override_student_id uuid := NULL;
  v_student_id uuid;
  v_category_count integer;
  v_profile_rec record;
  v_paper_unpub_id uuid := '00000000-0000-4000-8000-000000172001';
  v_paper_pub_id uuid := '00000000-0000-4000-8000-000000172002';
  v_sections jsonb := '[]'::jsonb;
  v_questions_flat jsonb := '[]'::jsonb;
  v_questions_cat jsonb := '[]'::jsonb;
  v_cat record;
  v_att_1 uuid;
  v_att_1_dup uuid;
  v_att_2 uuid;
  v_att_3 uuid;
  v_att_4 uuid;
  v_att_cat uuid;
  v_res jsonb;
  v_lease_1 uuid;
  v_lease_2 uuid;
  v_rev bigint;
  v_items jsonb;
  v_score_count integer;
  v_payload_count integer;
BEGIN
  -- ---------------------------------------------------------------------------
  -- 0. PREREQUISITE ASSERTIONS (READ-ONLY PRE-FLIGHT CHECKS)
  -- Stop immediately before modifying any fixtures if prerequisites do not hold.
  -- Regression tests must NEVER repair or seed shared reference data.
  -- ---------------------------------------------------------------------------

  -- 0.1 Assert canonical public.jmcwc_categories registry matches deployed schema
  SELECT count(*) INTO v_category_count FROM public.jmcwc_categories;
  IF v_category_count <> 23 THEN
    RAISE EXCEPTION
      'Prerequisite assertion failed: public.jmcwc_categories must contain exactly 23 rows (found %). Deploy the canonical category registry before running regression.',
      v_category_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY[
      'addition', 'subtraction', 'mixed', 'multiplication', 'division', 'brackets',
      'prime_factors', 'hcf_lcm', 'fraction_add', 'fraction_sub', 'fraction_mul',
      'fraction_div', 'approximation', 'remainder', 'ratio', 'square_root',
      'inexact_square_root', 'next_square', 'cube_root', 'next_cube', 'calendar',
      'elapsed_time', 'sum_squares'
    ]::text[]) AS k
    WHERE NOT EXISTS (
      SELECT 1 FROM public.jmcwc_categories c WHERE c.key = k
    )
  ) THEN
    RAISE EXCEPTION
      'Prerequisite assertion failed: public.jmcwc_categories is missing one or more of the 23 canonical keys. Regression test will not repair shared reference data.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.jmcwc_categories c
    WHERE c.key NOT IN (
      'addition', 'subtraction', 'mixed', 'multiplication', 'division', 'brackets',
      'prime_factors', 'hcf_lcm', 'fraction_add', 'fraction_sub', 'fraction_mul',
      'fraction_div', 'approximation', 'remainder', 'ratio', 'square_root',
      'inexact_square_root', 'next_square', 'cube_root', 'next_cube', 'calendar',
      'elapsed_time', 'sum_squares'
    )
  ) THEN
    RAISE EXCEPTION
      'Prerequisite assertion failed: public.jmcwc_categories contains keys outside the canonical 23 category set.';
  END IF;

  -- 0.2 Strengthened Test-User Isolation & Validation
  -- Even when v_override_student_id is supplied, the profile MUST already exist,
  -- have student_code = 'JMCWC_STAGE_TEST_01', role = 'student', active = true,
  -- and correspond to a real auth.users row. Never convert an arbitrary account.
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
      'Staging test student not found. Set up a dedicated staging test user with student_code = ''JMCWC_STAGE_TEST_01'' before running regression.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_student_id) THEN
    RAISE EXCEPTION
      'Test user UUID % does not exist in auth.users. The staging test student must correspond to a real auth.users row.',
      v_student_id;
  END IF;

  SELECT * INTO v_profile_rec
  FROM public.profiles
  WHERE id = v_student_id;

  IF v_profile_rec.id IS NULL THEN
    RAISE EXCEPTION
      'Profile for user UUID % not found in public.profiles.',
      v_student_id;
  END IF;

  IF v_profile_rec.student_code IS DISTINCT FROM 'JMCWC_STAGE_TEST_01' THEN
    RAISE EXCEPTION
      'Test isolation violation: user % has student_code = ''%'', expected ''JMCWC_STAGE_TEST_01''. Regression will not convert arbitrary accounts.',
      v_student_id, v_profile_rec.student_code;
  END IF;

  IF v_profile_rec.role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION
      'Test isolation violation: test profile % has role = ''%'', expected ''student''.',
      v_student_id, v_profile_rec.role;
  END IF;

  IF v_profile_rec.active IS NOT TRUE THEN
    RAISE EXCEPTION
      'Test isolation violation: test profile % is inactive (active = %). Expected active = true.',
      v_student_id, v_profile_rec.active;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 0.3 Clear Dedicated Test Student Fixtures & Stage Temporary Test Fixtures
  -- All modifications below are scoped strictly to v_student_id and roll back cleanly.
  -- ---------------------------------------------------------------------------
  DELETE FROM public.jmcwc_attempts WHERE student_id = v_student_id;
  DELETE FROM public.jmcwc_assignments WHERE student_id = v_student_id;

  INSERT INTO public.jmcwc_targets (group_key, category_key, target_seconds)
  VALUES ('junior1', 'addition', 90)
  ON CONFLICT (group_key, category_key) DO UPDATE SET target_seconds = EXCLUDED.target_seconds;

  INSERT INTO public.jmcwc_assignments (student_id, group_key)
  VALUES (v_student_id, 'junior1');

  -- ===========================================================================
  -- SYNTHETIC TEST PAYLOADS (DATABASE-STATE / SCHEMA TESTS ONLY)
  -- NOTE: The questions and payloads built below are synthetic fixtures designed
  -- exclusively to verify PostgreSQL schema, foreign keys, RLS, triggers,
  -- RPC contract enforcement, lease management, idempotency, and lifecycle
  -- state transitions in this rolled-back transaction.
  -- They do NOT verify real question-generation mathematics, algorithmic
  -- arithmetic ranges, or grading correctness (which are tested in unit suites
  -- like tests/jmcwcPhase17a.test.js and tests/jmcwcPhase17b.test.js).
  -- ===========================================================================
  FOR v_cat IN
    SELECT key, position FROM public.jmcwc_categories ORDER BY position ASC
  LOOP
    IF v_cat.key = 'multiplication' THEN
      v_sections := v_sections || jsonb_build_array(
        jsonb_build_object(
          'key', v_cat.key,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'slot', 1,
              'max_marks', 3,
              'generator', 'multiplication',
              'parameters', jsonb_build_object(
                'scoring_mode', 'dynamic',
                'mark_rule', 'multiplication_digits_product',
                'mark_range', jsonb_build_array(2, 6)
              )
            )
          )
        )
      );
    ELSIF v_cat.key = 'prime_factors' THEN
      v_sections := v_sections || jsonb_build_array(
        jsonb_build_object(
          'key', v_cat.key,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'slot', 1,
              'max_marks', 4,
              'generator', 'prime_factors',
              'parameters', jsonb_build_object(
                'scoring_mode', 'dynamic',
                'mark_rule', 'prime_factors_target_scale',
                'mark_range', jsonb_build_array(3, 6)
              )
            )
          )
        )
      );
    ELSIF v_cat.key = 'approximation' THEN
      v_sections := v_sections || jsonb_build_array(
        jsonb_build_object(
          'key', v_cat.key,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'slot', 1,
              'max_marks', 5,
              'generator', 'approximation',
              'parameters', jsonb_build_object(
                'scoring_mode', 'dynamic',
                'mark_rule', 'approximation_product_digits',
                'mark_range', jsonb_build_array(4, 8)
              )
            )
          )
        )
      );
    ELSIF v_cat.key = 'sum_squares' THEN
      v_sections := v_sections || jsonb_build_array(
        jsonb_build_object(
          'key', v_cat.key,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'slot', 1,
              'max_marks', 4,
              'generator', 'sum_squares',
              'parameters', jsonb_build_object(
                'scoring_mode', 'dynamic',
                'mark_rule', 'sum_squares_j1_decomposition',
                'mark_range', jsonb_build_array(2, 8)
              )
            )
          )
        )
      );
    ELSE
      v_sections := v_sections || jsonb_build_array(
        jsonb_build_object(
          'key', v_cat.key,
          'questions', jsonb_build_array(
            jsonb_build_object(
              'slot', 1,
              'max_marks', 2,
              'generator', v_cat.key,
              'parameters', jsonb_build_object('scoring_mode', 'fixed')
            )
          )
        )
      );
    END IF;

    v_questions_flat := v_questions_flat || jsonb_build_array(
      jsonb_build_object(
        'id', v_cat.key || '_s1',
        'category_key', v_cat.key,
        'slot', 1,
        'max_marks', CASE
          WHEN v_cat.key = 'multiplication' THEN 4
          WHEN v_cat.key = 'prime_factors' THEN 5
          WHEN v_cat.key = 'approximation' THEN 6
          WHEN v_cat.key = 'sum_squares' THEN 5
          ELSE 2
        END,
        'prompt', 'Synthetic prompt for ' || v_cat.key,
        'input', jsonb_build_object('answer_type', 'integer'),
        'answer_key', jsonb_build_object('kind', 'exact_integer', 'value', '42')
      )
    );
  END LOOP;

  v_questions_cat := jsonb_build_array(
    jsonb_build_object(
      'id', 'addition_s1',
      'category_key', 'addition',
      'slot', 1,
      'max_marks', 2,
      'prompt', 'Synthetic category prompt for addition',
      'input', jsonb_build_object('answer_type', 'integer'),
      'answer_key', jsonb_build_object('kind', 'exact_integer', 'value', '42')
    )
  );

  -- ---------------------------------------------------------------------------
  -- 1. Dynamic & Fixed Marks + Malformed Scoring Metadata Cases
  -- ---------------------------------------------------------------------------
  PERFORM public.jmcwc_validate_marks(
    'addition',
    '{"slot":1,"max_marks":2,"parameters":{"scoring_mode":"fixed"}}'::jsonb,
    2
  );
  PERFORM public.jmcwc_validate_marks(
    'multiplication',
    '{"slot":1,"max_marks":3,"parameters":{"scoring_mode":"dynamic","mark_rule":"multiplication_digits_product","mark_range":[2,6]}}'::jsonb,
    5
  );
  PERFORM public.jmcwc_validate_marks(
    'prime_factors',
    '{"slot":1,"max_marks":4,"parameters":{"scoring_mode":"dynamic","mark_rule":"prime_factors_target_scale","mark_range":[3,6]}}'::jsonb,
    4
  );
  PERFORM public.jmcwc_validate_marks(
    'approximation',
    '{"slot":1,"max_marks":5,"parameters":{"scoring_mode":"dynamic","mark_rule":"approximation_product_digits","mark_range":[4,8]}}'::jsonb,
    7
  );
  PERFORM public.jmcwc_validate_marks(
    'sum_squares',
    '{"slot":1,"max_marks":4,"parameters":{"scoring_mode":"dynamic","mark_rule":"sum_squares_j1_decomposition","mark_range":[2,8]}}'::jsonb,
    6
  );
  PERFORM public.jmcwc_validate_marks(
    'sum_squares',
    '{"slot":1,"max_marks":5,"parameters":{"scoring_mode":"dynamic","mark_rule":"sum_squares_j2_target","mark_range":[3,9]}}'::jsonb,
    5
  );
  PERFORM public.jmcwc_validate_marks(
    'sum_squares',
    '{"slot":1,"max_marks":6,"parameters":{"scoring_mode":"dynamic","mark_rule":"sum_squares_sr_target","mark_range":[4,10]}}'::jsonb,
    8
  );

  -- Malformed case A: scoring metadata at root of slot instead of slot.parameters
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'addition',
      '{"slot":1,"max_marks":2,"scoring_mode":"fixed","parameters":{}}'::jsonb,
      2
    );
    RAISE EXCEPTION 'Expected root scoring_mode to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Scoring metadata must be inside slot.parameters%' THEN
      RAISE;
    END IF;
  END;

  -- Malformed case B: unknown scoring_mode
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'addition',
      '{"slot":1,"max_marks":2,"parameters":{"scoring_mode":"custom"}}'::jsonb,
      2
    );
    RAISE EXCEPTION 'Expected unknown scoring_mode to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Unknown scoring_mode%' THEN
      RAISE;
    END IF;
  END;

  -- Malformed case C: fixed slot declaring dynamic mark_rule/mark_range
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'addition',
      '{"slot":1,"max_marks":2,"parameters":{"scoring_mode":"fixed","mark_range":[1,3]}}'::jsonb,
      2
    );
    RAISE EXCEPTION 'Expected fixed slot with mark_range to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Fixed slots must not declare dynamic scoring metadata%' THEN
      RAISE;
    END IF;
  END;

  -- Malformed case D: fixed question marks mismatching blueprint max_marks
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'addition',
      '{"slot":1,"max_marks":2,"parameters":{"scoring_mode":"fixed"}}'::jsonb,
      3
    );
    RAISE EXCEPTION 'Expected mismatched fixed question marks to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Fixed question marks must equal blueprint max_marks%' THEN
      RAISE;
    END IF;
  END;

  -- Malformed case E: unrecognized mark_rule for category
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'addition',
      '{"slot":1,"max_marks":3,"parameters":{"scoring_mode":"dynamic","mark_rule":"multiplication_digits_product","mark_range":[2,5]}}'::jsonb,
      3
    );
    RAISE EXCEPTION 'Expected wrong category mark_rule to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Unrecognized scoring rule%' THEN
      RAISE;
    END IF;
  END;

  -- Malformed case F: dynamic question marks outside mark_range
  BEGIN
    PERFORM public.jmcwc_validate_marks(
      'multiplication',
      '{"slot":1,"max_marks":3,"parameters":{"scoring_mode":"dynamic","mark_rule":"multiplication_digits_product","mark_range":[2,6]}}'::jsonb,
      9
    );
    RAISE EXCEPTION 'Expected out-of-range dynamic marks to fail validation';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Dynamic question marks must be an integer within mark_range%' THEN
      RAISE;
    END IF;
  END;

  -- ---------------------------------------------------------------------------
  -- 2. Publication Validation (jmcwc_paper_guard & jmcwc_create_attempt)
  -- ---------------------------------------------------------------------------
  INSERT INTO public.jmcwc_papers (id, group_key, version, spec, published)
  VALUES
    (v_paper_unpub_id, 'junior1', 'staging-synthetic-unpub-2026.1', jsonb_build_object('sections', v_sections), false),
    (v_paper_pub_id, 'junior1', 'staging-synthetic-pub-2026.1', jsonb_build_object('sections', v_sections), true);

  -- Reject publishing a paper with fewer than 23 sections
  BEGIN
    INSERT INTO public.jmcwc_papers (group_key, version, spec, published)
    VALUES ('junior1', 'staging-bad-sections', '{"sections":[{"key":"addition","questions":[]}]}'::jsonb, true);
    RAISE EXCEPTION 'Expected <23 sections published paper to fail jmcwc_paper_guard';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%23 visible workbook sections%' THEN
      RAISE;
    END IF;
  END;

  -- Reject modifying an already published paper
  BEGIN
    UPDATE public.jmcwc_papers
    SET version = 'staging-mutated'
    WHERE id = v_paper_pub_id;
    RAISE EXCEPTION 'Expected published paper mutation to fail jmcwc_paper_guard';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Published papers are immutable%' THEN
      RAISE;
    END IF;
  END;

  -- Reject creating an attempt against an unpublished paper
  BEGIN
    PERFORM public.jmcwc_create_attempt(
      v_student_id,
      '10000000-0000-4000-8000-000000000001'::uuid,
      v_paper_unpub_id,
      'flat',
      NULL,
      v_questions_flat
    );
    RAISE EXCEPTION 'Expected attempt creation on unpublished paper to fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%No published paper for your assigned group%' THEN
      RAISE;
    END IF;
  END;

  -- ---------------------------------------------------------------------------
  -- 3. Idempotent Attempt Creation & Three-Flat-Round Cap
  -- ---------------------------------------------------------------------------
  v_att_1 := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000011'::uuid,
    v_paper_pub_id,
    'flat',
    NULL,
    v_questions_flat
  );

  -- Calling again with the same request_id returns the exact same attempt UUID without duplicating payload
  v_att_1_dup := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000011'::uuid,
    v_paper_pub_id,
    'flat',
    NULL,
    v_questions_flat
  );
  IF v_att_1_dup IS DISTINCT FROM v_att_1 THEN
    RAISE EXCEPTION 'Idempotent jmcwc_create_attempt returned different UUID: % vs %', v_att_1_dup, v_att_1;
  END IF;

  SELECT count(*) INTO v_payload_count FROM public.jmcwc_payloads WHERE attempt_id = v_att_1;
  IF v_payload_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 jmcwc_payloads row for attempt %, found %', v_att_1, v_payload_count;
  END IF;

  -- Create flat attempts #2 and #3
  v_att_2 := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000012'::uuid,
    v_paper_pub_id,
    'flat',
    NULL,
    v_questions_flat
  );
  v_att_3 := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000013'::uuid,
    v_paper_pub_id,
    'flat',
    NULL,
    v_questions_flat
  );

  -- Category attempt does NOT occupy flat round slots and captures configured target_seconds (90s)
  v_att_cat := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000014'::uuid,
    v_paper_pub_id,
    'category',
    'addition',
    v_questions_cat
  );

  -- 4th unfinished flat attempt must be rejected
  BEGIN
    PERFORM public.jmcwc_create_attempt(
      v_student_id,
      '10000000-0000-4000-8000-000000000015'::uuid,
      v_paper_pub_id,
      'flat',
      NULL,
      v_questions_flat
    );
    RAISE EXCEPTION 'Expected 4th unfinished flat attempt to be rejected';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%You have three unfinished flat rounds%' THEN
      RAISE;
    END IF;
  END;

  -- ---------------------------------------------------------------------------
  -- 4. Assignment Guard (Blocks Group Change While Unfinished Attempts Exist)
  -- ---------------------------------------------------------------------------
  BEGIN
    UPDATE public.jmcwc_assignments
    SET group_key = 'senior'
    WHERE student_id = v_student_id;
    RAISE EXCEPTION 'Expected assignment group change with unfinished attempts to fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Complete this student''s unfinished simulator attempts before changing group%' THEN
      RAISE;
    END IF;
  END;

  -- ---------------------------------------------------------------------------
  -- 5. Resume, Switching Attempts, Lease Rules, Ordered Saves & Pause
  -- ---------------------------------------------------------------------------
  -- Resume flat attempt #1
  v_res := public.jmcwc_act(v_student_id, v_att_1, 'resume', NULL, NULL, NULL);
  IF v_res->>'status' <> 'running' OR v_res->>'lease_id' IS NULL THEN
    RAISE EXCEPTION 'Expected attempt 1 to be running with a non-null lease_id';
  END IF;
  v_lease_1 := (v_res->>'lease_id')::uuid;

  -- Ordered saves on attempt #1: seq 2 succeeds
  v_res := public.jmcwc_act(
    v_student_id,
    v_att_1,
    'save',
    v_lease_1,
    2,
    '{"addition_s1":"42","subtraction_s1":"10"}'::jsonb
  );
  IF (v_res->>'save_seq')::bigint <> 2 OR v_res->'answers'->>'addition_s1' <> '42' THEN
    RAISE EXCEPTION 'Expected save_seq=2 and addition_s1=42, got %', v_res;
  END IF;

  -- Out-of-order save (seq 1 <= current save_seq 2) is ignored without overwriting newer answers
  v_res := public.jmcwc_act(
    v_student_id,
    v_att_1,
    'save',
    v_lease_1,
    1,
    '{"addition_s1":"999"}'::jsonb
  );
  IF (v_res->>'save_seq')::bigint <> 2 OR v_res->'answers'->>'addition_s1' <> '42' THEN
    RAISE EXCEPTION 'Out-of-order save_seq=1 must not overwrite save_seq=2';
  END IF;

  -- Switching attempts: resuming attempt #2 automatically pauses attempt #1 and clears its lease_id
  v_res := public.jmcwc_act(v_student_id, v_att_2, 'resume', NULL, NULL, NULL);
  v_lease_2 := (v_res->>'lease_id')::uuid;
  IF v_res->>'status' <> 'running' OR v_lease_2 IS NULL THEN
    RAISE EXCEPTION 'Expected attempt 2 to be running after switch';
  END IF;

  -- Verify there is exactly one running attempt for this student
  IF (SELECT count(*) FROM public.jmcwc_attempts WHERE student_id = v_student_id AND status = 'running') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 running attempt after switching';
  END IF;

  -- Verify a save to attempt #1 (which was already paused by switching) returns its paused state
  -- without altering answers, save_seq, or restarting it:
  v_res := public.jmcwc_act(
    v_student_id,
    v_att_1,
    'save',
    v_lease_1,
    99,
    '{"addition_s1":"777"}'::jsonb
  );
  IF v_res->>'status' <> 'paused'
     OR v_res->>'lease_id' IS NOT NULL
     OR (v_res->>'save_seq')::bigint <> 2
     OR v_res->'answers'->>'addition_s1' <> '42'
  THEN
    RAISE EXCEPTION 'Expected save to switched/paused attempt 1 to return paused state without altering answers or restarting: %', v_res;
  END IF;

  -- Verify a write with an old/mismatched lease to the currently running attempt (#2) is rejected:
  BEGIN
    PERFORM public.jmcwc_act(
      v_student_id,
      v_att_2,
      'save',
      v_lease_1,
      1,
      '{"addition_s1":"42"}'::jsonb
    );
    RAISE EXCEPTION 'Expected old-lease save on currently running attempt 2 to fail';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Session changed. Reload this round.%' THEN
      RAISE;
    END IF;
  END;

  -- Explicit pause on attempt #2
  v_res := public.jmcwc_act(v_student_id, v_att_2, 'pause', v_lease_2, NULL, NULL);
  IF v_res->>'status' <> 'paused' OR v_res->>'lease_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Expected attempt 2 to be paused with NULL lease_id';
  END IF;

  -- ---------------------------------------------------------------------------
  -- 6. Heartbeat Timeout (>25s gap auto-pauses running attempt in jmcwc_tick)
  -- ---------------------------------------------------------------------------
  v_res := public.jmcwc_act(v_student_id, v_att_1, 'resume', NULL, NULL, NULL);
  v_lease_1 := (v_res->>'lease_id')::uuid;

  UPDATE public.jmcwc_attempts
  SET last_seen_at = clock_timestamp() - interval '35 seconds',
      active_ms = 10000
  WHERE id = v_att_1;

  PERFORM public.jmcwc_tick(v_att_1);

  SELECT to_jsonb(a) INTO v_res FROM public.jmcwc_attempts a WHERE a.id = v_att_1;
  IF v_res->>'status' <> 'paused'
     OR v_res->>'lease_id' IS NOT NULL
     OR (v_res->>'active_ms')::bigint <> 10000
  THEN
    RAISE EXCEPTION 'Expected heartbeat timeout to auto-pause attempt 1 without adding offline gap: %', v_res;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 7. Two-Hour Expiry (7,200,000 ms) & Late-Answer Rejection
  -- ---------------------------------------------------------------------------
  v_res := public.jmcwc_act(v_student_id, v_att_1, 'resume', NULL, NULL, NULL);
  v_lease_1 := (v_res->>'lease_id')::uuid;

  UPDATE public.jmcwc_attempts
  SET active_ms = 7195000,
      last_seen_at = clock_timestamp() - interval '10 seconds'
  WHERE id = v_att_1;

  -- Late save attempt when timer has expired: jmcwc_tick transitions to 'grading' ('time_limit')
  -- and jmcwc_act returns immediately before applying the late answer patch
  v_res := public.jmcwc_act(
    v_student_id,
    v_att_1,
    'save',
    v_lease_1,
    10,
    '{"addition_s1":"999999"}'::jsonb
  );

  IF v_res->>'status' <> 'grading'
     OR v_res->>'submitted_reason' <> 'time_limit'
     OR (v_res->>'active_ms')::bigint <> 7200000
     OR v_res->'answers'->>'addition_s1' <> '42'
  THEN
    RAISE EXCEPTION 'Expected 2-hour expiry to clamp active_ms=7200000, set status=grading/time_limit, and reject late answer: %', v_res;
  END IF;

  -- ---------------------------------------------------------------------------
  -- 8. Idempotent Finalization & Slot Liberation
  -- ---------------------------------------------------------------------------
  v_rev := (v_res->>'revision')::bigint;

  SELECT jsonb_agg(
    CASE
      WHEN q->>'id' = 'addition_s1' THEN
        jsonb_build_object('question_id', q->>'id', 'award', 2, 'verdict', 'correct', 'expected', '42', 'explanation', '42')
      WHEN q->>'id' = 'subtraction_s1' THEN
        jsonb_build_object('question_id', q->>'id', 'award', 0, 'verdict', 'wrong', 'expected', '42', 'explanation', '42')
      ELSE
        jsonb_build_object('question_id', q->>'id', 'award', 0, 'verdict', 'skipped', 'expected', '42', 'explanation', '42')
    END
  )
  INTO v_items
  FROM jsonb_array_elements(v_questions_flat) q;

  PERFORM public.jmcwc_finalize(v_student_id, v_att_1, v_rev, v_items);
  PERFORM public.jmcwc_finalize(v_student_id, v_att_1, v_rev, v_items);

  SELECT count(*) INTO v_score_count FROM public.jmcwc_scores WHERE attempt_id = v_att_1;
  IF v_score_count <> 1
     OR (SELECT status FROM public.jmcwc_attempts WHERE id = v_att_1) <> 'submitted'
  THEN
    RAISE EXCEPTION 'Expected attempt 1 to be submitted with 1 jmcwc_scores row';
  END IF;

  -- Now that attempt #1 is submitted, only 2 unfinished flat rounds remain -> starting flat #4 succeeds!
  v_att_4 := public.jmcwc_create_attempt(
    v_student_id,
    '10000000-0000-4000-8000-000000000016'::uuid,
    v_paper_pub_id,
    'flat',
    NULL,
    v_questions_flat
  );
  IF v_att_4 IS NULL THEN
    RAISE EXCEPTION 'Expected 4th flat round creation to succeed after completing 1st flat round';
  END IF;

  RAISE NOTICE 'ALL 14 JMCWC STAGING POSTGRESQL CONTRACT REGRESSION CHECKS PASSED.';
END
$staging_regression$;

ROLLBACK;
