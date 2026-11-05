-- ==============================================================================
-- 13_phase16c_atomic_weekly_test_sections.sql
-- Phase 16c: Transaction-Safe Atomic Save for Weekly Tests and Sections
-- Schema verified against live Mumbai database:
--
-- public.weekly_tests columns:
--   id (UUID PK), test_date (DATE NOT NULL), title (TEXT NOT NULL), notes (TEXT),
--   created_by (UUID), created_at (TIMESTAMPTZ), updated_at (TIMESTAMPTZ),
--   updated_by (UUID), test_type (TEXT NOT NULL DEFAULT 'offline' CHECK (test_type IN ('offline', 'online'))),
--   audience_level (TEXT), opens_at (TIMESTAMPTZ), closes_at (TIMESTAMPTZ),
--   remind_days_before (INT NOT NULL DEFAULT 7 CHECK (remind_days_before >= 0 AND remind_days_before <= 30))
--   CONSTRAINT chk_weekly_tests_window CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
--
-- public.weekly_test_sections columns:
--   id (UUID PK), test_id (UUID FK), position (INT CHECK (position >= 1 AND position <= 20)),
--   category_id (UUID FK nullable), seconds (INT nullable CHECK (seconds IS NULL OR seconds IN (30, 60, 120, 300))),
--   kind (TEXT CHECK (kind IN ('basics', 'round', 'flash', 'elements', 'memoriad'))),
--   activity_key (TEXT nullable), flash_digits (INT nullable CHECK (flash_digits IS NULL OR (flash_digits >= 1 AND flash_digits <= 5))),
--   flash_count (INT nullable CHECK (flash_count IS NULL OR (flash_count >= 2 AND flash_count <= 1000))),
--   flash_speed_ms (INT nullable CHECK (flash_speed_ms IS NULL OR (flash_speed_ms >= 200 AND flash_speed_ms <= 5000))),
--   flash_mode (TEXT nullable CHECK (flash_mode IS NULL OR flash_mode IN ('add', 'add_sub'))),
--   question_count (INT nullable CHECK (question_count IS NULL OR (question_count >= 1 AND question_count <= 10)))
--
-- DO NOT EXECUTE REMOTELY. Provided for database owner review.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. Explicit Migration for Owner Review: Deferrable Position Constraint
-- Preserves CHECK (position >= 1 AND position <= 20).
-- Alters UNIQUE (test_id, position) to be DEFERRABLE INITIALLY DEFERRED
-- so that in-transaction position reordering within 1..20 does not fail on intermediate swaps.
-- ------------------------------------------------------------------------------
ALTER TABLE public.weekly_test_sections
  DROP CONSTRAINT IF EXISTS weekly_test_sections_test_id_position_key;

ALTER TABLE public.weekly_test_sections
  ADD CONSTRAINT weekly_test_sections_test_id_position_key
  UNIQUE (test_id, position)
  DEFERRABLE INITIALLY DEFERRED;

-- ------------------------------------------------------------------------------
-- 2. Stored Procedure: save_weekly_test_sections_atomic
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_weekly_test_sections_atomic(
  p_test_id UUID,
  p_test JSONB,
  p_sections JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_title TEXT;
  v_date_str TEXT;
  v_test_date DATE;
  v_test_type TEXT;
  v_audience_level TEXT;
  v_notes TEXT;
  v_opens_at TIMESTAMPTZ;
  v_closes_at TIMESTAMPTZ;
  v_remind_raw TEXT;
  v_remind_days INT;

  v_sec_count INT;
  v_sec JSONB;
  v_sec_id UUID;
  v_pos INT;
  v_kind TEXT;
  v_cat_id UUID;
  v_cat_name TEXT;
  v_cat_section TEXT;
  v_raw_cat TEXT;
  v_seconds INT;
  v_activity_key TEXT;
  v_flash_digits INT;
  v_flash_count INT;
  v_flash_speed_ms INT;
  v_flash_mode TEXT;
  v_question_count INT;

  v_existing_test_id UUID;
  v_is_locked BOOLEAN;
  v_old_sec RECORD;

  v_incoming_ids UUID[] := ARRAY[]::UUID[];
  v_seen_cat_ids UUID[] := ARRAY[]::UUID[];
  v_seen_act_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- ----------------------------------------------------------------------------
  -- Step 1: Authorization Validation
  -- ----------------------------------------------------------------------------
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: only admin can modify weekly tests'
      USING ERRCODE = '42501';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 2: Parent Test Payload Validation
  -- ----------------------------------------------------------------------------
  IF p_test IS NULL OR jsonb_typeof(p_test) <> 'object' THEN
    RAISE EXCEPTION 'Invalid test payload: must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  v_title := TRIM(COALESCE(p_test->>'title', ''));
  IF v_title = '' THEN
    RAISE EXCEPTION 'Weekly test title is required'
      USING ERRCODE = '22023';
  END IF;

  v_date_str := TRIM(COALESCE(p_test->>'test_date', ''));
  IF v_date_str = '' THEN
    RAISE EXCEPTION 'Weekly test test_date is required'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_test_date := v_date_str::DATE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid test_date format: %', v_date_str
      USING ERRCODE = '22023';
  END;

  v_test_type := LOWER(TRIM(COALESCE(p_test->>'test_type', 'offline')));
  IF v_test_type NOT IN ('offline', 'online') THEN
    RAISE EXCEPTION 'Invalid test_type "%": must be offline or online', v_test_type
      USING ERRCODE = '22023';
  END IF;

  v_audience_level := NULLIF(TRIM(COALESCE(p_test->>'audience_level', '')), '');
  v_notes := NULLIF(p_test->>'notes', '');

  -- Opens At / Closes At Window Validation
  IF p_test->>'opens_at' IS NOT NULL AND TRIM(p_test->>'opens_at') <> '' THEN
    BEGIN
      v_opens_at := (p_test->>'opens_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid opens_at format: %', p_test->>'opens_at' USING ERRCODE = '22023';
    END;
  ELSE
    v_opens_at := NULL;
  END IF;

  IF p_test->>'closes_at' IS NOT NULL AND TRIM(p_test->>'closes_at') <> '' THEN
    BEGIN
      v_closes_at := (p_test->>'closes_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid closes_at format: %', p_test->>'closes_at' USING ERRCODE = '22023';
    END;
  ELSE
    v_closes_at := NULL;
  END IF;

  IF v_opens_at IS NOT NULL AND v_closes_at IS NOT NULL AND v_opens_at >= v_closes_at THEN
    RAISE EXCEPTION 'opens_at (%) must be earlier than closes_at (%)', v_opens_at, v_closes_at
      USING ERRCODE = '22023';
  END IF;

  -- Remind Days Before Validation:
  -- Live constraint: NOT NULL DEFAULT 7, CHECK 0..30.
  -- Creation with omitted reminder uses 7.
  -- Edits handle omitted reminder explicitly without writing NULL.
  -- Invalid reminder values are rejected.
  v_remind_raw := TRIM(COALESCE(p_test->>'remind_days_before', ''));
  IF v_remind_raw <> '' THEN
    BEGIN
      v_remind_days := v_remind_raw::INT;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid remind_days_before format: %', v_remind_raw
        USING ERRCODE = '22023';
    END;
    IF v_remind_days < 0 OR v_remind_days > 30 THEN
      RAISE EXCEPTION 'remind_days_before must be between 0 and 30 (received %)', v_remind_days
        USING ERRCODE = '22023';
    END IF;
  ELSE
    IF p_test_id IS NULL THEN
      v_remind_days := 7;
    ELSE
      SELECT remind_days_before INTO v_remind_days
      FROM public.weekly_tests
      WHERE id = p_test_id;

      IF v_remind_days IS NULL THEN
        v_remind_days := 7;
      END IF;
    END IF;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 3: Application Limit: Sections Payload & Count Validation (Max 12)
  -- ----------------------------------------------------------------------------
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' THEN
    RAISE EXCEPTION 'Invalid sections payload: must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  v_sec_count := jsonb_array_length(p_sections);
  IF v_test_type = 'online' AND (v_sec_count < 1 OR v_sec_count > 12) THEN
    RAISE EXCEPTION 'Online weekly tests require between 1 and 12 sections (received %)', v_sec_count
      USING ERRCODE = '22023';
  END IF;
  IF v_test_type = 'offline' AND v_sec_count > 12 THEN
    RAISE EXCEPTION 'Offline weekly tests allow at most 12 sections (received %)', v_sec_count
      USING ERRCODE = '22023';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 4: Parent Test Existence & Row-Level Locking
  -- ----------------------------------------------------------------------------
  IF p_test_id IS NOT NULL THEN
    PERFORM 1 FROM public.weekly_tests WHERE id = p_test_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Weekly test % does not exist', p_test_id
        USING ERRCODE = '23503';
    END IF;

    -- Lock all existing sections for this test
    PERFORM 1 FROM public.weekly_test_sections WHERE test_id = p_test_id FOR UPDATE;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 5: Validate Incoming Sections Shapes, Compatibility & Uniqueness
  -- ----------------------------------------------------------------------------
  FOR v_sec IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    v_kind := LOWER(TRIM(COALESCE(v_sec->>'kind', '')));
    IF v_kind NOT IN ('basics', 'round', 'flash', 'elements', 'memoriad') THEN
      RAISE EXCEPTION 'Invalid section kind "%": must be basics, round, flash, elements, or memoriad', v_kind
        USING ERRCODE = '22023';
    END IF;

    IF v_test_type = 'online' AND v_kind = 'round' THEN
      RAISE EXCEPTION 'Round sections are available for offline tests only'
        USING ERRCODE = '22023';
    END IF;

    -- Check duplicate section ID in incoming payload
    IF (v_sec->>'id') IS NOT NULL AND TRIM(v_sec->>'id') <> '' THEN
      v_sec_id := (v_sec->>'id')::UUID;
      IF v_sec_id = ANY(v_incoming_ids) THEN
        RAISE EXCEPTION 'Duplicate section id in payload: %', v_sec_id
          USING ERRCODE = '23505';
      END IF;
      v_incoming_ids := array_append(v_incoming_ids, v_sec_id);

      -- Verify section belongs to this test
      IF p_test_id IS NOT NULL THEN
        SELECT test_id INTO v_existing_test_id
        FROM public.weekly_test_sections
        WHERE id = v_sec_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Section % does not exist', v_sec_id
            USING ERRCODE = '23503';
        END IF;
        IF v_existing_test_id <> p_test_id THEN
          RAISE EXCEPTION 'Section % belongs to another test', v_sec_id
            USING ERRCODE = '23503';
        END IF;
      ELSE
        RAISE EXCEPTION 'Cannot specify existing section id % on a new weekly test', v_sec_id
          USING ERRCODE = '23503';
      END IF;
    END IF;

    -- Validate Category ID
    IF (v_sec->>'category_id') IS NOT NULL AND TRIM(v_sec->>'category_id') <> '' THEN
      v_cat_id := (v_sec->>'category_id')::UUID;
      IF v_cat_id = ANY(v_seen_cat_ids) THEN
        RAISE EXCEPTION 'Duplicate category_id % in weekly test', v_cat_id
          USING ERRCODE = '23505';
      END IF;
      v_seen_cat_ids := array_append(v_seen_cat_ids, v_cat_id);
    ELSE
      v_cat_id := NULL;
    END IF;

    -- Validate Activity Key
    IF (v_sec->>'activity_key') IS NOT NULL AND TRIM(v_sec->>'activity_key') <> '' THEN
      v_activity_key := TRIM(v_sec->>'activity_key');
      IF (v_kind || ':' || v_activity_key) = ANY(v_seen_act_keys) THEN
        RAISE EXCEPTION 'Duplicate activity "%" in weekly test', v_activity_key
          USING ERRCODE = '23505';
      END IF;
      v_seen_act_keys := array_append(v_seen_act_keys, (v_kind || ':' || v_activity_key));
    ELSE
      v_activity_key := NULL;
    END IF;

    -- Kind-specific shape and compatibility checks
    IF v_kind = 'basics' THEN
      IF v_cat_id IS NULL THEN
        RAISE EXCEPTION 'Basics section requires category_id' USING ERRCODE = '22023';
      END IF;

      -- Server-side validation: category must exist and belong to 'basics' section
      SELECT name, section INTO v_cat_name, v_cat_section
      FROM public.categories
      WHERE id = v_cat_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Basics category % does not exist', v_cat_id
          USING ERRCODE = '23503';
      END IF;
      IF v_cat_section IS DISTINCT FROM 'basics' THEN
        RAISE EXCEPTION 'Category "%" does not belong to Basics (section is "%")', v_cat_name, v_cat_section
          USING ERRCODE = '22023';
      END IF;

      -- Check online Basics question generation support
      IF v_test_type = 'online' THEN
        v_raw_cat := lower(regexp_replace(v_cat_name, '\s+', '', 'g'));
        IF NOT (
          v_raw_cat ~ '^[1-5]d([2-9]|1[0-5])r$'
          OR v_raw_cat ~ '^[1-5]d[x*][1-5]d$'
          OR (
            v_raw_cat ~ '^[1-6]d(by|\/)[1-4]d$'
            AND (substring(v_raw_cat from '^([1-6])')::INT >= substring(v_raw_cat from '(?:by|\/)([1-4])d$')::INT)
          )
        ) THEN
          RAISE EXCEPTION 'Category "%" is not supported for online question generation', v_cat_name
            USING ERRCODE = '22023';
        END IF;
      END IF;

      IF (v_sec->>'seconds') IS NOT NULL AND TRIM(v_sec->>'seconds') <> '' THEN
        v_seconds := (v_sec->>'seconds')::INT;
        IF v_seconds NOT IN (30, 60, 120, 300) THEN
          RAISE EXCEPTION 'Basics section seconds must be 30, 60, 120, or 300 (received %)', v_seconds
            USING ERRCODE = '22023';
        END IF;
      ELSE
        v_seconds := NULL;
      END IF;
      IF v_test_type = 'online' AND v_seconds IS NULL THEN
        RAISE EXCEPTION 'Online Basics section requires seconds duration (30, 60, 120, or 300)'
          USING ERRCODE = '22023';
      END IF;

    ELSIF v_kind = 'round' THEN
      IF v_cat_id IS NULL THEN
        RAISE EXCEPTION 'Round section requires category_id' USING ERRCODE = '22023';
      END IF;

      -- Server-side validation: category must exist and belong to 'round' section
      SELECT name, section INTO v_cat_name, v_cat_section
      FROM public.categories
      WHERE id = v_cat_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Round category % does not exist', v_cat_id
          USING ERRCODE = '23503';
      END IF;
      IF v_cat_section IS DISTINCT FROM 'round' THEN
        RAISE EXCEPTION 'Category "%" does not belong to Round (section is "%")', v_cat_name, v_cat_section
          USING ERRCODE = '22023';
      END IF;

      IF (v_sec->>'seconds') IS NOT NULL AND TRIM(v_sec->>'seconds') <> '' THEN
        RAISE EXCEPTION 'Round sections cannot have a seconds duration'
          USING ERRCODE = '22023';
      END IF;

    ELSIF v_kind = 'elements' THEN
      IF v_activity_key IS NULL THEN
        RAISE EXCEPTION 'Elements section requires activity_key' USING ERRCODE = '22023';
      END IF;

      -- Server-side validation against actual enabled catalog (23 drills, modulo disabled)
      IF v_activity_key NOT IN (
        'day_codes', 'month_codes', 'century_codes', 'time_conversion',
        'squares_stage_1', 'squares_stage_2', 'squares_stage_3', 'squares_stage_4', 'squares_combined',
        'cubes_stage_1', 'cubes_stage_2', 'cubes_stage_3', 'cubes_stage_4', 'cubes_combined',
        'divide_by_4', 'divide_by_7', 'prime_factors', 'ratio',
        'days_to_seconds', 'hours_to_seconds', 'minutes_to_seconds',
        'number_to_be_squared', 'squares_3d_4d'
      ) THEN
        RAISE EXCEPTION 'Elements drill "%" is not supported or disabled', v_activity_key
          USING ERRCODE = '22023';
      END IF;

    ELSIF v_kind = 'memoriad' THEN
      IF v_activity_key IS NULL OR v_activity_key NOT IN ('calendar', 'additions', 'multiplications', 'square_roots') THEN
        RAISE EXCEPTION 'Memoriad section activity_key must be calendar, additions, multiplications, or square_roots'
          USING ERRCODE = '22023';
      END IF;

    ELSIF v_kind = 'flash' THEN
      v_flash_digits := (v_sec->>'flash_digits')::INT;
      v_flash_count := (v_sec->>'flash_count')::INT;
      v_flash_speed_ms := (v_sec->>'flash_speed_ms')::INT;
      v_flash_mode := LOWER(TRIM(COALESCE(v_sec->>'flash_mode', '')));
      v_question_count := (v_sec->>'question_count')::INT;

      IF v_flash_digits IS NULL OR v_flash_digits < 1 OR v_flash_digits > 5 THEN
        RAISE EXCEPTION 'Flash digits must be between 1 and 5' USING ERRCODE = '22023';
      END IF;
      IF v_flash_count IS NULL OR v_flash_count < 2 OR v_flash_count > 1000 THEN
        RAISE EXCEPTION 'Flash numbers count must be between 2 and 1000' USING ERRCODE = '22023';
      END IF;
      IF v_flash_speed_ms IS NULL OR v_flash_speed_ms < 200 OR v_flash_speed_ms > 5000 THEN
        RAISE EXCEPTION 'Flash speed ms must be between 200 and 5000' USING ERRCODE = '22023';
      END IF;
      IF v_flash_mode NOT IN ('add', 'add_sub') THEN
        RAISE EXCEPTION 'Flash mode must be add or add_sub' USING ERRCODE = '22023';
      END IF;
      IF v_question_count IS NULL OR v_question_count < 1 OR v_question_count > 10 THEN
        RAISE EXCEPTION 'Flash question_count must be between 1 and 10' USING ERRCODE = '22023';
      END IF;
    END IF;
  END LOOP;

  -- ----------------------------------------------------------------------------
  -- Step 6: Protect Locked Sections from Deletion AND Configuration Changes
  -- ----------------------------------------------------------------------------
  IF p_test_id IS NOT NULL THEN
    FOR v_old_sec IN SELECT * FROM public.weekly_test_sections WHERE test_id = p_test_id LOOP
      SELECT (
        EXISTS (SELECT 1 FROM public.weekly_test_scores sc WHERE sc.section_id = v_old_sec.id)
        OR EXISTS (SELECT 1 FROM public.weekly_test_attempts att WHERE att.section_id = v_old_sec.id)
      ) INTO v_is_locked;

      IF v_is_locked THEN
        IF NOT (v_old_sec.id = ANY(v_incoming_ids)) THEN
          RAISE EXCEPTION 'Cannot delete locked section %: student attempts or scores exist', v_old_sec.id
            USING ERRCODE = '23503';
        END IF;

        FOR v_sec IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
          IF (v_sec->>'id') IS NOT NULL AND (v_sec->>'id')::UUID = v_old_sec.id THEN
            IF (v_sec->>'kind') IS DISTINCT FROM v_old_sec.kind
               OR (CASE WHEN (v_sec->>'category_id') IS NOT NULL AND (v_sec->>'category_id') <> '' THEN (v_sec->>'category_id')::UUID ELSE NULL END) IS DISTINCT FROM v_old_sec.category_id
               OR (CASE WHEN (v_sec->>'seconds') IS NOT NULL AND (v_sec->>'seconds') <> '' THEN (v_sec->>'seconds')::INT ELSE NULL END) IS DISTINCT FROM v_old_sec.seconds
               OR NULLIF(TRIM(v_sec->>'activity_key'), '') IS DISTINCT FROM v_old_sec.activity_key
               OR (CASE WHEN (v_sec->>'flash_digits') IS NOT NULL AND (v_sec->>'flash_digits') <> '' THEN (v_sec->>'flash_digits')::INT ELSE NULL END) IS DISTINCT FROM v_old_sec.flash_digits
               OR (CASE WHEN (v_sec->>'flash_count') IS NOT NULL AND (v_sec->>'flash_count') <> '' THEN (v_sec->>'flash_count')::INT ELSE NULL END) IS DISTINCT FROM v_old_sec.flash_count
               OR (CASE WHEN (v_sec->>'flash_speed_ms') IS NOT NULL AND (v_sec->>'flash_speed_ms') <> '' THEN (v_sec->>'flash_speed_ms')::INT ELSE NULL END) IS DISTINCT FROM v_old_sec.flash_speed_ms
               OR NULLIF(TRIM(v_sec->>'flash_mode'), '') IS DISTINCT FROM v_old_sec.flash_mode
               OR (CASE WHEN (v_sec->>'question_count') IS NOT NULL AND (v_sec->>'question_count') <> '' THEN (v_sec->>'question_count')::INT ELSE NULL END) IS DISTINCT FROM v_old_sec.question_count
            THEN
              RAISE EXCEPTION 'Cannot modify configuration of locked section %: student attempts or scores exist (only order/position changes are permitted)', v_old_sec.id
                USING ERRCODE = '23503';
            END IF;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 7: Upsert Parent Test Record
  -- ----------------------------------------------------------------------------
  IF p_test_id IS NULL THEN
    INSERT INTO public.weekly_tests (
      test_date, title, notes, test_type, audience_level, opens_at, closes_at, remind_days_before, created_by, updated_by, created_at, updated_at
    ) VALUES (
      v_test_date, v_title, v_notes, v_test_type, v_audience_level, v_opens_at, v_closes_at, v_remind_days, auth.uid(), auth.uid(), NOW(), NOW()
    ) RETURNING id INTO p_test_id;
  ELSE
    UPDATE public.weekly_tests
    SET
      test_date = v_test_date,
      title = v_title,
      notes = v_notes,
      test_type = v_test_type,
      audience_level = v_audience_level,
      opens_at = v_opens_at,
      closes_at = v_closes_at,
      remind_days_before = v_remind_days,
      updated_by = auth.uid(),
      updated_at = NOW()
    WHERE id = p_test_id;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 8: Delete Unlocked Removed Sections
  -- ----------------------------------------------------------------------------
  DELETE FROM public.weekly_test_sections
  WHERE test_id = p_test_id
    AND NOT (id = ANY(v_incoming_ids));

  -- ----------------------------------------------------------------------------
  -- Step 9: Reorder & Insert Sections Within Constraint Range (1..20)
  -- Uses DEFERRABLE INITIALLY DEFERRED position constraint to avoid collisions.
  -- ----------------------------------------------------------------------------
  SET CONSTRAINTS weekly_test_sections_test_id_position_key DEFERRED;

  v_pos := 1;
  FOR v_sec IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    v_kind := LOWER(TRIM(v_sec->>'kind'));
    v_cat_id := CASE WHEN (v_sec->>'category_id') IS NOT NULL AND (v_sec->>'category_id') <> '' THEN (v_sec->>'category_id')::UUID ELSE NULL END;
    v_seconds := CASE WHEN (v_sec->>'seconds') IS NOT NULL AND (v_sec->>'seconds') <> '' THEN (v_sec->>'seconds')::INT ELSE NULL END;
    v_activity_key := NULLIF(TRIM(v_sec->>'activity_key'), '');
    v_flash_digits := CASE WHEN (v_sec->>'flash_digits') IS NOT NULL AND (v_sec->>'flash_digits') <> '' THEN (v_sec->>'flash_digits')::INT ELSE NULL END;
    v_flash_count := CASE WHEN (v_sec->>'flash_count') IS NOT NULL AND (v_sec->>'flash_count') <> '' THEN (v_sec->>'flash_count')::INT ELSE NULL END;
    v_flash_speed_ms := CASE WHEN (v_sec->>'flash_speed_ms') IS NOT NULL AND (v_sec->>'flash_speed_ms') <> '' THEN (v_sec->>'flash_speed_ms')::INT ELSE NULL END;
    v_flash_mode := NULLIF(TRIM(v_sec->>'flash_mode'), '');
    v_question_count := CASE WHEN (v_sec->>'question_count') IS NOT NULL AND (v_sec->>'question_count') <> '' THEN (v_sec->>'question_count')::INT ELSE NULL END;

    v_sec_id := CASE WHEN (v_sec->>'id') IS NOT NULL AND (v_sec->>'id') <> '' THEN (v_sec->>'id')::UUID ELSE NULL END;

    IF v_sec_id IS NOT NULL THEN
      UPDATE public.weekly_test_sections
      SET
        position = v_pos,
        kind = v_kind,
        category_id = v_cat_id,
        seconds = v_seconds,
        activity_key = v_activity_key,
        flash_digits = v_flash_digits,
        flash_count = v_flash_count,
        flash_speed_ms = v_flash_speed_ms,
        flash_mode = v_flash_mode,
        question_count = v_question_count
      WHERE id = v_sec_id AND test_id = p_test_id;
    ELSE
      INSERT INTO public.weekly_test_sections (
        test_id,
        position,
        kind,
        category_id,
        seconds,
        activity_key,
        flash_digits,
        flash_count,
        flash_speed_ms,
        flash_mode,
        question_count
      ) VALUES (
        p_test_id,
        v_pos,
        v_kind,
        v_cat_id,
        v_seconds,
        v_activity_key,
        v_flash_digits,
        v_flash_count,
        v_flash_speed_ms,
        v_flash_mode,
        v_question_count
      );
    END IF;

    v_pos := v_pos + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'test_id', p_test_id);
END;
$$;

-- ------------------------------------------------------------------------------
-- 3. Explicit Permissions
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB) TO service_role;
