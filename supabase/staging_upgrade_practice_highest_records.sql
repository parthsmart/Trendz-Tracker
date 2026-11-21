-- =============================================================================
-- Migration: Staging Upgrade Practice Highest Records RPC
-- Target Environment: Staging (staging_xhgzbbkvwojwfbexvcmh)
-- File: supabase/staging_upgrade_practice_highest_records.sql
--
-- Features:
-- - Upgrades an already-installed public.practice_highest_records RPC.
-- - Preserves backward compatibility: existing callers calling without format: 'per_digit'
--   receive the original benchmark results (fastest cleared speed per workload).
-- - Adds simplified Flash Anzan view when format: 'per_digit':
--   * 1 card per supported digit level (1..5).
--   * Filtered by speed (including 0.3s) and mode ('add' vs 'add_sub').
--   * Ranked by longest correctly completed sequence (MAX count).
--   * Authoritative results: verified linked submitted drill_sessions (status = 'submitted').
--   * Strict mode check: missing mode does NOT default to Addition.
--   * Skips incomplete or malformed settings safely without failing the whole records page.
--   * Confirms submitted sequence was answered correctly (correct >= 1 AND total >= 1 AND correct >= total).
--   * Deduplicates repeat runs so each student appears at most once per record.
--   * Genuine ties share the record with all holders listed.
-- - All Students | My Best toggle across all sections (authenticated caller privacy, 'No personal record yet').
-- - Preserves installed format_leaderboard_name signature (p_full_name TEXT, p_code TEXT, p_mode TEXT).
-- - Wrapped in a single transaction with operator latch & tripwire safety.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Safety Latch & Production Tripwire
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_target_env TEXT := current_setting('app.target_environment', true);
  v_prod_count INT := 0;
BEGIN
  IF v_target_env IS NULL OR v_target_env <> 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'SAFETY TRIPPED: Operator confirmation latch missing. Execute "SET app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'';" before running this script.'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO v_prod_count
  FROM public.profiles
  WHERE student_code IN ('STU101', 'STU-101')
    AND full_name ILIKE '%Riya%';

  IF v_prod_count > 0 THEN
    RAISE EXCEPTION 'CRITICAL ABORT: Production data markers detected in target database! Execution halted.'
      USING ERRCODE = '55002';
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Helper: format_leaderboard_name
-- Preserves installed signature (p_full_name TEXT, p_code TEXT, p_mode TEXT) to avoid 42P13
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.format_leaderboard_name(
  p_full_name TEXT,
  p_code TEXT,
  p_mode TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_parts TEXT[];
BEGIN
  IF p_mode = 'student_code' THEN
    RETURN COALESCE(NULLIF(TRIM(p_code), ''), 'Student');
  ELSIF p_mode = 'full_name' THEN
    RETURN COALESCE(NULLIF(TRIM(p_full_name), ''), COALESCE(NULLIF(TRIM(p_code), ''), 'Student'));
  ELSE
    -- first_name_initial default
    IF p_full_name IS NULL OR TRIM(p_full_name) = '' THEN
      RETURN COALESCE(NULLIF(TRIM(p_code), ''), 'Student');
    END IF;
    v_parts := string_to_array(TRIM(p_full_name), ' ');
    IF array_length(v_parts, 1) > 1 THEN
      RETURN v_parts[1] || ' ' || UPPER(SUBSTRING(v_parts[array_length(v_parts, 1)], 1, 1)) || '.';
    ELSE
      RETURN v_parts[1];
    END IF;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Upgraded RPC: public.practice_highest_records
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.practice_highest_records(
  p_section TEXT,
  p_options JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
  v_caller_level TEXT;
  v_caller_active BOOLEAN;
  v_global_enabled BOOLEAN := true;
  v_is_global BOOLEAN := true;
  v_name_mode TEXT := 'first_name_initial';
  v_sec TEXT := LOWER(TRIM(COALESCE(p_section, '')));
  v_duration INT := 60;
  v_view TEXT := LOWER(TRIM(COALESCE(p_options->>'view', 'all')));
  v_flash_format TEXT := LOWER(TRIM(COALESCE(p_options->>'format', p_options->>'layout', '')));
  v_flash_speed_ms INT := 300;
  v_flash_mode TEXT := LOWER(TRIM(COALESCE(p_options->>'mode', 'add')));
  v_result JSONB := '[]'::jsonb;
BEGIN
  -- Safely parse durationSeconds
  IF (p_options->>'durationSeconds') ~ '^[0-9]{1,4}$' THEN
    v_duration := (p_options->>'durationSeconds')::INT;
  END IF;

  -- Safely parse Flash speed and mode without casting errors on oversized or invalid inputs
  IF (p_options->>'speed_ms') ~ '^[0-9]{3,4}$' THEN
    v_flash_speed_ms := (p_options->>'speed_ms')::INT;
  ELSIF (p_options->>'speedMs') ~ '^[0-9]{3,4}$' THEN
    v_flash_speed_ms := (p_options->>'speedMs')::INT;
  ELSIF (p_options->>'speed') ~ '^[0-9]+(\.[0-9]+)?$' AND (p_options->>'speed')::NUMERIC BETWEEN 0.2 AND 5.0 THEN
    v_flash_speed_ms := ROUND((p_options->>'speed')::NUMERIC * 1000)::INT;
  ELSE
    v_flash_speed_ms := 300;
  END IF;

  IF v_flash_speed_ms < 200 OR v_flash_speed_ms > 5000 OR (v_flash_speed_ms % 100 <> 0) THEN
    v_flash_speed_ms := 300;
  END IF;

  IF v_flash_mode NOT IN ('add', 'add_sub') THEN
    v_flash_mode := 'add';
  END IF;
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '28000';
  END IF;

  SELECT role, level, active INTO v_caller_role, v_caller_level, v_caller_active
  FROM public.profiles WHERE id = v_caller;

  IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Active account required.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    (SELECT value = 'on' FROM public.competition_settings WHERE key = 'global_leaderboard'),
    true
  ) INTO v_global_enabled;

  IF v_caller_role = 'student' AND NOT v_global_enabled THEN
    v_is_global := false;
  ELSIF (p_options->>'scope') = 'level' THEN
    v_is_global := false;
  END IF;

  SELECT COALESCE(
    (SELECT value FROM public.competition_settings WHERE key = 'leaderboard_names'),
    'first_name_initial'
  ) INTO v_name_mode;

  -- Normalize flash mode
  IF v_flash_mode NOT IN ('add', 'add_sub') THEN
    v_flash_mode := 'add';
  END IF;

  -- =========================================================================
  -- BRANCH 1: BASICS
  -- =========================================================================
  IF v_sec = 'basics' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.active = true
        AND (
          (v_view = 'my_best' AND p.id = v_caller)
          OR
          (v_view <> 'my_best' AND p.role = 'student' AND p.leaderboard_visible = true AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level))
        )
    ),
    valid_scores AS (
      SELECT
        r.id,
        r.category_id,
        r.student_id,
        r.correct,
        r.total,
        GREATEST(0, r.total - r.correct) AS wrong,
        r.time_seconds,
        r.created_at,
        ep.student_code,
        ep.full_name,
        public.format_leaderboard_name(ep.full_name, ep.student_code, v_name_mode) AS display_name
      FROM public.results r
      JOIN eligible_profiles ep ON ep.id = r.student_id
      JOIN public.categories c ON c.id = r.category_id
      WHERE c.section = 'basics'
        AND r.time_seconds = v_duration
        AND (
          r.verified = true
          OR EXISTS (
            SELECT 1 FROM public.drill_sessions ds
            WHERE (ds.result_id = r.id OR ds.result_row_id = r.id)
              AND ds.status = 'submitted'
              AND ds.student_id = r.student_id
          )
        )
    ),
    best_per_cat AS (
      SELECT
        category_id,
        MAX(correct) AS max_correct
      FROM valid_scores
      GROUP BY category_id
    ),
    min_wrong_per_cat AS (
      SELECT
        vs.category_id,
        vs.correct,
        MIN(vs.wrong) AS min_wrong
      FROM valid_scores vs
      JOIN best_per_cat bpc ON bpc.category_id = vs.category_id AND bpc.max_correct = vs.correct
      GROUP BY vs.category_id, vs.correct
    ),
    deduped_holders AS (
      SELECT DISTINCT ON (vs.category_id, vs.student_id)
        vs.category_id,
        vs.student_id,
        vs.student_code,
        vs.display_name,
        vs.correct,
        vs.wrong,
        vs.created_at
      FROM valid_scores vs
      JOIN min_wrong_per_cat mwc ON mwc.category_id = vs.category_id AND mwc.correct = vs.correct AND mwc.min_wrong = vs.wrong
      ORDER BY vs.category_id, vs.student_id, vs.created_at ASC
    ),
    tied_holders AS (
      SELECT
        dh.category_id,
        dh.correct,
        dh.wrong,
        jsonb_agg(
          jsonb_build_object(
            'student_id', dh.student_id,
            'student_code', dh.student_code,
            'display_name', dh.display_name
          )
          ORDER BY dh.created_at ASC
        ) AS holders
      FROM deduped_holders dh
      GROUP BY dh.category_id, dh.correct, dh.wrong
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'category_id', c.id,
        'category_name', c.name,
        'title', c.name,
        'section', 'basics',
        'duration_seconds', v_duration,
        'durationSeconds', v_duration,
        'settings_summary', v_duration || ' seconds',
        'settingsSummary', v_duration || ' seconds',
        'has_record', (th.category_id IS NOT NULL),
        'hasRecord', (th.category_id IS NOT NULL),
        'correct', th.correct,
        'wrong', th.wrong,
        'score_display', CASE
          WHEN th.category_id IS NOT NULL THEN th.correct || ' correct (' || th.wrong || ' wrong)'
          WHEN v_view = 'my_best' THEN 'No personal record yet'
          ELSE 'No record yet'
        END,
        'scoreDisplay', CASE
          WHEN th.category_id IS NOT NULL THEN th.correct || ' correct (' || th.wrong || ' wrong)'
          WHEN v_view = 'my_best' THEN 'No personal record yet'
          ELSE 'No record yet'
        END,
        'attempt_url', '/pages/basics-practice.html?cat=' || c.id || '&seconds=' || v_duration,
        'attemptUrl', '/pages/basics-practice.html?cat=' || c.id || '&seconds=' || v_duration,
        'attempt_label', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(th.holders, '[]'::jsonb)) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
        'attemptLabel', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(th.holders, '[]'::jsonb)) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
        'holders', COALESCE(th.holders, '[]'::jsonb),
        'holder_count', COALESCE(jsonb_array_length(th.holders), 0),
        'is_tie', (COALESCE(jsonb_array_length(th.holders), 0) > 1),
        'caller_holds', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(th.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        ),
        'isHeldByMe', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(th.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        )
      )
      ORDER BY c.sort_order ASC, c.name ASC
    ) INTO v_result
    FROM public.categories c
    LEFT JOIN tied_holders th ON th.category_id = c.id
    WHERE c.section = 'basics' AND c.active = true;

  -- =========================================================================
  -- BRANCH 2A: FLASH ANZAN — NEW ONE-CARD-PER-DIGIT VIEW (format = 'per_digit')
  -- =========================================================================
  ELSIF v_sec = 'flash' AND v_flash_format IN ('per_digit', 'per-digit') THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.active = true
        AND (
          (v_view = 'my_best' AND p.id = v_caller)
          OR
          (v_view <> 'my_best' AND p.role = 'student' AND p.leaderboard_visible = true AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level))
        )
    ),
    supported_digits AS (
      SELECT unnest(ARRAY[1, 2, 3, 4, 5]) AS digits
    ),
    valid_flash AS (
      SELECT
        ar.id,
        ar.student_id,
        (CASE WHEN (ds.settings->>'digits') ~ '^[1-5]$' THEN (ds.settings->>'digits')::INT ELSE NULL END) AS digits,
        (CASE WHEN (ds.settings->>'count') ~ '^[0-9]{1,4}$' THEN (ds.settings->>'count')::INT ELSE NULL END) AS count,
        (CASE WHEN (ds.settings->>'speed_ms') ~ '^[0-9]{3,4}$' THEN (ds.settings->>'speed_ms')::INT ELSE NULL END) AS speed_ms,
        (ds.settings->>'mode') AS mode,
        ar.correct,
        ar.total,
        ar.created_at,
        ep.student_code,
        ep.full_name,
        public.format_leaderboard_name(ep.full_name, ep.student_code, v_name_mode) AS display_name
      FROM public.activity_results ar
      JOIN eligible_profiles ep ON ep.id = ar.student_id
      JOIN public.drill_sessions ds ON (
        (ds.result_id = ar.id OR ds.result_row_id = ar.id)
        AND ds.status = 'submitted'
        AND ds.student_id = ar.student_id
        AND ds.activity_type = 'flash_anzan'
      )
      WHERE ar.activity_type = 'flash_anzan'
        AND ar.correct >= 1
        AND ar.total >= 1
        AND ar.correct >= ar.total
        AND ds.settings IS NOT NULL
        AND jsonb_typeof(ds.settings) = 'object'
        AND (ds.settings->>'digits') ~ '^[1-5]$'
        AND (ds.settings->>'count') ~ '^[0-9]{1,4}$'
        AND (CASE WHEN (ds.settings->>'count') ~ '^[0-9]{1,4}$' THEN (ds.settings->>'count')::INT ELSE NULL END) BETWEEN 2 AND 1000
        AND (ds.settings->>'speed_ms') ~ '^[0-9]{3,4}$'
        AND (CASE WHEN (ds.settings->>'speed_ms') ~ '^[0-9]{3,4}$' THEN (ds.settings->>'speed_ms')::INT ELSE NULL END) BETWEEN 200 AND 5000
        AND ((CASE WHEN (ds.settings->>'speed_ms') ~ '^[0-9]{3,4}$' THEN (ds.settings->>'speed_ms')::INT ELSE NULL END) % 100 = 0)
        AND (CASE WHEN (ds.settings->>'speed_ms') ~ '^[0-9]{3,4}$' THEN (ds.settings->>'speed_ms')::INT ELSE NULL END) = v_flash_speed_ms
        AND (ds.settings->>'mode') IN ('add', 'add_sub')
        AND (ds.settings->>'mode') = v_flash_mode
    ),
    best_per_digit AS (
      SELECT
        digits,
        MAX(count) AS max_count
      FROM valid_flash
      GROUP BY digits
    ),
    deduped_flash_holders AS (
      SELECT DISTINCT ON (vf.digits, vf.student_id)
        vf.digits,
        vf.count,
        vf.speed_ms,
        vf.mode,
        vf.student_id,
        vf.student_code,
        vf.display_name,
        vf.created_at
      FROM valid_flash vf
      JOIN best_per_digit bpd
        ON bpd.digits = vf.digits
       AND bpd.max_count = vf.count
      ORDER BY vf.digits, vf.student_id, vf.created_at ASC
    ),
    tied_flash_holders AS (
      SELECT
        dfh.digits,
        dfh.count,
        dfh.speed_ms,
        dfh.mode,
        jsonb_agg(
          jsonb_build_object(
            'student_id', dfh.student_id,
            'student_code', dfh.student_code,
            'display_name', dfh.display_name
          )
          ORDER BY dfh.created_at ASC
        ) AS holders
      FROM deduped_flash_holders dfh
      GROUP BY dfh.digits, dfh.count, dfh.speed_ms, dfh.mode
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', 'flash_' || sd.digits || 'd',
        'title', sd.digits || ' Digit' || CASE WHEN sd.digits > 1 THEN 's' ELSE '' END,
        'section', 'flash',
        'format', 'per_digit',
        'digits', sd.digits,
        'count', tfh.count,
        'speed_ms', v_flash_speed_ms,
        'speed_seconds', ROUND(v_flash_speed_ms / 1000.0, 3),
        'mode', v_flash_mode,
        'settings_summary', sd.digits || 'd · ' || ROUND(v_flash_speed_ms / 1000.0, 1) || 's · ' || CASE WHEN v_flash_mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END,
        'settingsSummary', sd.digits || 'd · ' || ROUND(v_flash_speed_ms / 1000.0, 1) || 's · ' || CASE WHEN v_flash_mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END,
        'has_record', (tfh.digits IS NOT NULL),
        'hasRecord', (tfh.digits IS NOT NULL),
        'score_display', CASE
          WHEN tfh.digits IS NOT NULL THEN tfh.count || ' numbers'
          WHEN v_view = 'my_best' THEN 'No personal record yet'
          ELSE 'No record yet'
        END,
        'scoreDisplay', CASE
          WHEN tfh.digits IS NOT NULL THEN tfh.count || ' numbers'
          WHEN v_view = 'my_best' THEN 'No personal record yet'
          ELSE 'No record yet'
        END,
        'raw_settings', jsonb_build_object(
          'digits', sd.digits,
          'count', COALESCE(tfh.count, 10),
          'speed_ms', v_flash_speed_ms,
          'mode', v_flash_mode
        ),
        'rawSettings', jsonb_build_object(
          'digits', sd.digits,
          'count', COALESCE(tfh.count, 10),
          'speed_ms', v_flash_speed_ms,
          'mode', v_flash_mode
        ),
        'attempt_url', '/pages/flash.html?digits=' || sd.digits || '&count=' || COALESCE(tfh.count, 10) || '&speed=' || v_flash_speed_ms || '&mode=' || v_flash_mode,
        'attemptUrl', '/pages/flash.html?digits=' || sd.digits || '&count=' || COALESCE(tfh.count, 10) || '&speed=' || v_flash_speed_ms || '&mode=' || v_flash_mode,
        'attempt_label', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(tfh.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'attemptLabel', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(tfh.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'holders', COALESCE(tfh.holders, '[]'::jsonb),
        'holder_count', COALESCE(jsonb_array_length(tfh.holders), 0),
        'is_tie', (COALESCE(jsonb_array_length(tfh.holders), 0) > 1),
        'caller_holds', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(tfh.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        ),
        'isHeldByMe', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(tfh.holders, '[]'::jsonb)) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        )
      )
      ORDER BY sd.digits ASC
    ) INTO v_result
    FROM supported_digits sd
    LEFT JOIN tied_flash_holders tfh ON tfh.digits = sd.digits;

  -- =========================================================================
  -- BRANCH 2B: FLASH ANZAN — PRESERVED BENCHMARK VIEW FOR EXISTING CALLERS
  -- =========================================================================
  ELSIF v_sec = 'flash' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.active = true
        AND (
          (v_view = 'my_best' AND p.id = v_caller)
          OR
          (v_view <> 'my_best' AND p.role = 'student' AND p.leaderboard_visible = true AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level))
        )
    ),
    valid_flash AS (
      SELECT
        ar.id,
        ar.student_id,
        (ar.settings->>'digits')::INT AS digits,
        (ar.settings->>'count')::INT AS count,
        (ar.settings->>'speed_ms')::INT AS speed_ms,
        (ar.settings->>'mode') AS mode,
        ar.correct,
        ar.total,
        ar.created_at,
        ep.student_code,
        ep.full_name,
        public.format_leaderboard_name(ep.full_name, ep.student_code, v_name_mode) AS display_name
      FROM public.activity_results ar
      JOIN eligible_profiles ep ON ep.id = ar.student_id
      JOIN public.drill_sessions ds ON (
        (ds.result_id = ar.id OR ds.result_row_id = ar.id OR (ar.settings->>'session_id' IS NOT NULL AND ds.id::text = (ar.settings->>'session_id')))
        AND ds.status = 'submitted'
        AND ds.student_id = ar.student_id
        AND ds.activity_type = 'flash_anzan'
      )
      WHERE ar.activity_type = 'flash_anzan'
        AND ar.correct >= 1
        AND ar.total >= 1
        AND ar.correct >= ar.total
        AND ar.settings IS NOT NULL
        AND jsonb_typeof(ar.settings) = 'object'
        AND (ar.settings->>'digits') ~ '^[1-5]$'
        AND (ar.settings->>'count') ~ '^[1-9][0-9]*$'
        AND (ar.settings->>'speed_ms') ~ '^[1-9][0-9]*$'
        AND (ar.settings->>'mode') IN ('add', 'add_sub')
    ),
    fastest_per_workload AS (
      SELECT
        digits,
        count,
        mode,
        MIN(speed_ms) AS best_speed_ms
      FROM valid_flash
      GROUP BY digits, count, mode
    ),
    deduped_flash_holders AS (
      SELECT DISTINCT ON (vf.digits, vf.count, vf.mode, vf.student_id)
        vf.digits,
        vf.count,
        vf.mode,
        vf.speed_ms,
        vf.student_id,
        vf.student_code,
        vf.display_name,
        vf.created_at
      FROM valid_flash vf
      JOIN fastest_per_workload fpw
        ON fpw.digits = vf.digits
       AND fpw.count = vf.count
       AND fpw.mode = vf.mode
       AND fpw.best_speed_ms = vf.speed_ms
      ORDER BY vf.digits, vf.count, vf.mode, vf.student_id, vf.created_at ASC
    ),
    tied_flash_holders AS (
      SELECT
        dfh.digits,
        dfh.count,
        dfh.mode,
        dfh.speed_ms,
        jsonb_agg(
          jsonb_build_object(
            'student_id', dfh.student_id,
            'student_code', dfh.student_code,
            'display_name', dfh.display_name
          )
          ORDER BY dfh.created_at ASC
        ) AS holders
      FROM deduped_flash_holders dfh
      GROUP BY dfh.digits, dfh.count, dfh.mode, dfh.speed_ms
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', tfh.digits || 'd_' || tfh.count || 'n_' || tfh.mode,
        'title', tfh.digits || ' Digit' || CASE WHEN tfh.digits > 1 THEN 's' ELSE '' END || ' · ' || tfh.count || ' Numbers · ' || CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Subtract' ELSE 'Add' END,
        'section', 'flash',
        'digits', tfh.digits,
        'count', tfh.count,
        'mode', tfh.mode,
        'speed_ms', tfh.speed_ms,
        'speed_seconds', ROUND(tfh.speed_ms / 1000.0, 3),
        'settings_summary', tfh.digits || 'd · ' || tfh.count || 'n · ' || CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END,
        'settingsSummary', tfh.digits || 'd · ' || tfh.count || 'n · ' || CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END,
        'has_record', true,
        'hasRecord', true,
        'score_display', ROUND(tfh.speed_ms / 1000.0, 2) || 's per number (' || tfh.speed_ms || 'ms)',
        'scoreDisplay', ROUND(tfh.speed_ms / 1000.0, 2) || 's per number (' || tfh.speed_ms || 'ms)',
        'score_numeric', tfh.speed_ms,
        'scoreNumeric', tfh.speed_ms,
        'attempt_url', '/pages/flash.html?digits=' || tfh.digits || '&count=' || tfh.count || '&speed=' || tfh.speed_ms || '&mode=' || tfh.mode,
        'attemptUrl', '/pages/flash.html?digits=' || tfh.digits || '&count=' || tfh.count || '&speed=' || tfh.speed_ms || '&mode=' || tfh.mode,
        'attempt_label', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(tfh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'attemptLabel', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(tfh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'holders', tfh.holders,
        'holder_count', jsonb_array_length(tfh.holders),
        'is_tie', (jsonb_array_length(tfh.holders) > 1),
        'caller_holds', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(tfh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        ),
        'isHeldByMe', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(tfh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        )
      )
      ORDER BY tfh.digits DESC, tfh.count DESC, tfh.speed_ms ASC
    ) INTO v_result
    FROM tied_flash_holders tfh;

  -- =========================================================================
  -- BRANCH 3: ELEMENTS
  -- =========================================================================
  ELSIF v_sec = 'element' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.active = true
        AND (
          (v_view = 'my_best' AND p.id = v_caller)
          OR
          (v_view <> 'my_best' AND p.role = 'student' AND p.leaderboard_visible = true AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level))
        )
    ),
    valid_elements AS (
      SELECT
        ar.id,
        COALESCE(ar.settings->>'drill', ar.activity_name) AS drill_key,
        ar.student_id,
        ar.correct,
        ar.total,
        COALESCE(ar.time_seconds, (ar.settings->>'time_limit_seconds')::INT, 60) AS time_seconds,
        ar.created_at,
        ep.student_code,
        ep.full_name,
        public.format_leaderboard_name(ep.full_name, ep.student_code, v_name_mode) AS display_name
      FROM public.activity_results ar
      JOIN eligible_profiles ep ON ep.id = ar.student_id
      JOIN public.drill_sessions ds ON (
        (ds.result_id = ar.id OR ds.result_row_id = ar.id OR (ar.settings->>'session_id' IS NOT NULL AND ds.id::text = (ar.settings->>'session_id')))
        AND ds.status = 'submitted'
        AND ds.student_id = ar.student_id
        AND ds.activity_type = 'element'
      )
      WHERE ar.activity_type = 'element'
    ),
    best_per_drill AS (
      SELECT
        drill_key,
        MAX(correct) AS max_correct
      FROM valid_elements
      GROUP BY drill_key
    ),
    min_time_per_drill AS (
      SELECT
        ve.drill_key,
        ve.correct,
        MIN(ve.time_seconds) AS min_time
      FROM valid_elements ve
      JOIN best_per_drill bpd ON bpd.drill_key = ve.drill_key AND bpd.max_correct = ve.correct
      GROUP BY ve.drill_key, ve.correct
    ),
    deduped_element_holders AS (
      SELECT DISTINCT ON (ve.drill_key, ve.student_id)
        ve.drill_key,
        ve.correct,
        ve.time_seconds,
        ve.student_id,
        ve.student_code,
        ve.display_name,
        ve.created_at
      FROM valid_elements ve
      JOIN min_time_per_drill mtd ON mtd.drill_key = ve.drill_key AND mtd.correct = ve.correct AND mtd.min_time = ve.time_seconds
      ORDER BY ve.drill_key, ve.student_id, ve.created_at ASC
    ),
    tied_element_holders AS (
      SELECT
        deh.drill_key,
        deh.correct,
        deh.time_seconds,
        jsonb_agg(
          jsonb_build_object(
            'student_id', deh.student_id,
            'student_code', deh.student_code,
            'display_name', deh.display_name
          )
          ORDER BY deh.created_at ASC
        ) AS holders
      FROM deduped_element_holders deh
      GROUP BY deh.drill_key, deh.correct, deh.time_seconds
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', teh.drill_key,
        'drill_key', teh.drill_key,
        'title', teh.drill_key,
        'section', 'element',
        'has_record', true,
        'hasRecord', true,
        'correct', teh.correct,
        'time_seconds', teh.time_seconds,
        'score_display', teh.correct || ' correct in ' || teh.time_seconds || 's',
        'scoreDisplay', teh.correct || ' correct in ' || teh.time_seconds || 's',
        'score_numeric', teh.correct,
        'scoreNumeric', teh.correct,
        'timeSeconds', teh.time_seconds,
        'attempt_url', '/pages/element-drill.html?drill=' || teh.drill_key,
        'attemptUrl', '/pages/element-drill.html?drill=' || teh.drill_key,
        'attempt_label', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(teh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'attemptLabel', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(teh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'holders', teh.holders,
        'holder_count', jsonb_array_length(teh.holders),
        'is_tie', (jsonb_array_length(teh.holders) > 1),
        'caller_holds', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(teh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        ),
        'isHeldByMe', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(teh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        )
      )
      ORDER BY teh.drill_key ASC
    ) INTO v_result
    FROM tied_element_holders teh;

  -- =========================================================================
  -- BRANCH 4: MEMORIAD (Official Score DESC, used_seconds ASC, separate Calendar 25/125 tiers)
  -- =========================================================================
  ELSIF v_sec = 'memoriad' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.active = true
        AND (
          (v_view = 'my_best' AND p.id = v_caller)
          OR
          (v_view <> 'my_best' AND p.role = 'student' AND p.leaderboard_visible = true AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level))
        )
    ),
    valid_memoriad AS (
      SELECT
        ar.id,
        COALESCE(ar.settings->>'module', ar.settings->>'module_key', ar.activity_name) AS module_key,
        CASE
          WHEN COALESCE(ar.settings->>'module', ar.settings->>'module_key', ar.activity_name) = 'calendar'
            THEN COALESCE(NULLIF(ar.settings->>'dates', '')::INT, NULLIF(ar.settings->>'dates_tier', '')::INT, NULLIF(ar.settings->>'total_dates', '')::INT, 125)
          ELSE NULL
        END AS dates_tier,
        ar.student_id,
        ar.correct,
        ar.total,
        COALESCE((ar.settings->>'score')::NUMERIC, ar.correct::NUMERIC) AS official_score,
        COALESCE(ar.time_seconds, (ar.settings->>'used_seconds')::INT, (ar.settings->>'time_seconds')::INT, 300) AS used_seconds,
        ar.created_at,
        ep.student_code,
        ep.full_name,
        public.format_leaderboard_name(ep.full_name, ep.student_code, v_name_mode) AS display_name
      FROM public.activity_results ar
      JOIN eligible_profiles ep ON ep.id = ar.student_id
      JOIN public.drill_sessions ds ON (
        (ds.result_id = ar.id OR ds.result_row_id = ar.id OR (ar.settings->>'session_id' IS NOT NULL AND ds.id::text = (ar.settings->>'session_id')))
        AND ds.status = 'submitted'
        AND ds.student_id = ar.student_id
        AND ds.activity_type = 'memoriad'
      )
      WHERE ar.activity_type = 'memoriad'
    ),
    best_per_module AS (
      SELECT
        module_key,
        dates_tier,
        MAX(official_score) AS max_score
      FROM valid_memoriad
      GROUP BY module_key, dates_tier
    ),
    min_time_per_module AS (
      SELECT
        vm.module_key,
        vm.dates_tier,
        vm.official_score,
        MIN(vm.used_seconds) AS min_used_seconds
      FROM valid_memoriad vm
      JOIN best_per_module bpm
        ON bpm.module_key = vm.module_key
       AND bpm.dates_tier IS NOT DISTINCT FROM vm.dates_tier
       AND bpm.max_score = vm.official_score
      GROUP BY vm.module_key, vm.dates_tier, vm.official_score
    ),
    deduped_memoriad_holders AS (
      SELECT DISTINCT ON (vm.module_key, vm.dates_tier, vm.student_id)
        vm.module_key,
        vm.dates_tier,
        vm.official_score,
        vm.used_seconds,
        vm.student_id,
        vm.student_code,
        vm.display_name,
        vm.created_at
      FROM valid_memoriad vm
      JOIN min_time_per_module mtm
        ON mtm.module_key = vm.module_key
       AND mtm.dates_tier IS NOT DISTINCT FROM vm.dates_tier
       AND mtm.official_score = vm.official_score
       AND mtm.min_used_seconds = vm.used_seconds
      ORDER BY vm.module_key, vm.dates_tier, vm.student_id, vm.created_at ASC
    ),
    tied_memoriad_holders AS (
      SELECT
        dmh.module_key,
        dmh.dates_tier,
        dmh.official_score,
        dmh.used_seconds,
        jsonb_agg(
          jsonb_build_object(
            'student_id', dmh.student_id,
            'student_code', dmh.student_code,
            'display_name', dmh.display_name
          )
          ORDER BY dmh.created_at ASC
        ) AS holders
      FROM deduped_memoriad_holders dmh
      GROUP BY dmh.module_key, dmh.dates_tier, dmh.official_score, dmh.used_seconds
    )
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', CASE WHEN tmh.dates_tier IS NOT NULL THEN tmh.module_key || '_' || tmh.dates_tier ELSE tmh.module_key END,
        'module_key', tmh.module_key,
        'dates_tier', tmh.dates_tier,
        'title', CASE
          WHEN tmh.module_key = 'calendar' THEN 'Calendar (' || tmh.dates_tier || ' Dates)'
          ELSE tmh.module_key
        END,
        'section', 'memoriad',
        'has_record', true,
        'hasRecord', true,
        'score', tmh.official_score,
        'official_score', tmh.official_score,
        'score_numeric', tmh.official_score,
        'scoreNumeric', tmh.official_score,
        'used_seconds', tmh.used_seconds,
        'time_seconds', tmh.used_seconds,
        'timeSeconds', tmh.used_seconds,
        'score_display', tmh.official_score || ' pts · ' || tmh.used_seconds || 's',
        'scoreDisplay', tmh.official_score || ' pts · ' || tmh.used_seconds || 's',
        'attempt_url', '/pages/memoriad-play.html?module=' || tmh.module_key || CASE WHEN tmh.dates_tier IS NOT NULL THEN '&dates=' || tmh.dates_tier ELSE '' END,
        'attemptUrl', '/pages/memoriad-play.html?module=' || tmh.module_key || CASE WHEN tmh.dates_tier IS NOT NULL THEN '&dates=' || tmh.dates_tier ELSE '' END,
        'attempt_label', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(tmh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'attemptLabel', CASE
          WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(tmh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          ) THEN 'Defend record'
          ELSE 'Attempt online'
        END,
        'holders', tmh.holders,
        'holder_count', jsonb_array_length(tmh.holders),
        'is_tie', (jsonb_array_length(tmh.holders) > 1),
        'caller_holds', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(tmh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        ),
        'isHeldByMe', (
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(tmh.holders) h
            WHERE (h->>'student_id')::UUID = v_caller
          )
        )
      )
      ORDER BY tmh.module_key ASC, tmh.dates_tier ASC
    ) INTO v_result
    FROM tied_memoriad_holders tmh;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.practice_highest_records(TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.practice_highest_records(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.practice_highest_records(TEXT, JSONB) TO service_role;

COMMIT;
