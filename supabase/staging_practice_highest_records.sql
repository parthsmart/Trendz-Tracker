-- =============================================================================
-- Migration: Staging Practice Highest Records RPC
-- Target Environment: Staging (staging_xhgzbbkvwojwfbexvcmh)
--
-- Features:
-- - Implements strictly comparable highest records across all 4 practice sections:
--   1. Basics: identical category & duration (30s, 60s default, 120s, 300s)
--   2. Flash Anzan: identical (digits, count, mode), ranked by fastest cleared speed (MIN speed_ms) with correct >= 1
--   3. Elements: identical drill & configuration (correct DESC, time_seconds ASC)
--   4. Memoriad: identical module & official scoring (settings->>'score' DESC, used_seconds ASC)
--      with separate Calendar 25/125 date tiers
-- - Eligibility strictly validates submitted drill_sessions (result_id / result_row_id)
-- - Deduplicates tied holders per student so each student appears at most once per record
-- - Complete RPC-to-renderer contract (hasRecord / has_record, title, score_display, attempt_url, etc.)
-- - Active caller enforcement, global_leaderboard on/off scoping, privacy display name policies
-- - Preserves installed format_leaderboard_name(p_full_name TEXT, p_code TEXT, p_mode TEXT) signature
-- - Idempotent, wrapped in a single transaction with operator latch & tripwire safety
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
-- 2. RPC: public.practice_highest_records
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
  v_sec TEXT := LOWER(TRIM(COALESCE(p_section, '')));
  v_duration INT := COALESCE((p_options->>'durationSeconds')::INT, 60);
  v_name_mode TEXT;
  v_is_global BOOLEAN := true;
  v_result JSONB := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '28000';
  END IF;

  -- Verify active caller and resolve role/level
  SELECT role, level, active INTO v_caller_role, v_caller_level, v_caller_active
  FROM public.profiles WHERE id = v_caller;

  IF NOT FOUND OR v_caller_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Active account required.' USING ERRCODE = '42501';
  END IF;

  -- Global leaderboard setting
  SELECT COALESCE(
    (SELECT value = 'on' FROM public.competition_settings WHERE key = 'global_leaderboard'),
    true
  ) INTO v_global_enabled;

  -- Visibility rule: if caller is student and global_leaderboard is off, enforce student's own level
  IF v_caller_role = 'student' AND NOT v_global_enabled THEN
    v_is_global := false;
  ELSIF (p_options->>'scope') = 'level' THEN
    v_is_global := false;
  END IF;

  -- Resolve display name mode from competition settings
  SELECT COALESCE(
    (SELECT value FROM public.competition_settings WHERE key = 'leaderboard_names'),
    'first_name_initial'
  ) INTO v_name_mode;

  -- =========================================================================
  -- BRANCH 1: BASICS
  -- =========================================================================
  IF v_sec = 'basics' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.role = 'student'
        AND p.active = true
        AND p.leaderboard_visible = true
        AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level)
    ),
    valid_scores AS (
      SELECT
        r.id,
        r.category_id,
        r.student_id,
        r.correct,
        r.total,
        (r.total - r.correct) AS wrong,
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
        'score_display', CASE WHEN th.category_id IS NOT NULL THEN th.correct || ' correct (' || th.wrong || ' wrong)' ELSE 'No record yet' END,
        'scoreDisplay', CASE WHEN th.category_id IS NOT NULL THEN th.correct || ' correct (' || th.wrong || ' wrong)' ELSE 'No record yet' END,
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
  -- BRANCH 2: FLASH ANZAN (Comparable Individual Performance: Fastest speed)
  -- =========================================================================
  ELSIF v_sec = 'flash' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.role = 'student'
        AND p.active = true
        AND p.leaderboard_visible = true
        AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level)
    ),
    valid_flash AS (
      SELECT
        ar.id,
        ar.student_id,
        COALESCE((ar.settings->>'digits')::INT, 1) AS digits,
        COALESCE((ar.settings->>'count')::INT, 5) AS count,
        COALESCE((ar.settings->>'speed_ms')::INT, 1000) AS speed_ms,
        COALESCE(ar.settings->>'mode', 'add') AS mode,
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
        'settings_summary', tfh.digits || 'd · ' || tfh.count || 'n · ' || tfh.mode,
        'settingsSummary', tfh.digits || 'd · ' || tfh.count || 'n · ' || tfh.mode,
        'has_record', true,
        'hasRecord', true,
        'score_display', ROUND(tfh.speed_ms / 1000.0, 3) || 's (' || tfh.speed_ms || ' ms)',
        'scoreDisplay', ROUND(tfh.speed_ms / 1000.0, 3) || 's (' || tfh.speed_ms || ' ms)',
        'raw_settings', jsonb_build_object('digits', tfh.digits, 'count', tfh.count, 'speed_ms', tfh.speed_ms, 'mode', tfh.mode),
        'rawSettings', jsonb_build_object('digits', tfh.digits, 'count', tfh.count, 'speed_ms', tfh.speed_ms, 'mode', tfh.mode),
        'attempt_url', '/pages/flash.html?digits=' || tfh.digits || '&count=' || tfh.count || '&speed=' || tfh.speed_ms || '&mode=' || tfh.mode,
        'attemptUrl', '/pages/flash.html?digits=' || tfh.digits || '&count=' || tfh.count || '&speed=' || tfh.speed_ms || '&mode=' || tfh.mode,
        'attempt_label', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(tfh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
        'attemptLabel', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(tfh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
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
      ORDER BY tfh.digits ASC, tfh.count ASC, tfh.speed_ms ASC
    ) INTO v_result
    FROM tied_flash_holders tfh;

  -- =========================================================================
  -- BRANCH 3: ELEMENTS
  -- =========================================================================
  ELSIF v_sec = 'element' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.role = 'student'
        AND p.active = true
        AND p.leaderboard_visible = true
        AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level)
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
        'title', teh.drill_key,
        'section', 'element',
        'drill_key', teh.drill_key,
        'settings_summary', 'Worksheet Drill',
        'settingsSummary', 'Worksheet Drill',
        'has_record', true,
        'hasRecord', true,
        'correct', teh.correct,
        'time_seconds', teh.time_seconds,
        'score_display', teh.correct || ' correct · ' || teh.time_seconds || 's',
        'scoreDisplay', teh.correct || ' correct · ' || teh.time_seconds || 's',
        'attempt_url', '/pages/element-drill.html?drill=' || teh.drill_key,
        'attemptUrl', '/pages/element-drill.html?drill=' || teh.drill_key,
        'attempt_label', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(teh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
        'attemptLabel', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(teh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
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
  -- BRANCH 4: MEMORIAD (Official Memoriad Scoring & Calendar Tiers)
  -- =========================================================================
  ELSIF v_sec = 'memoriad' THEN
    WITH eligible_profiles AS (
      SELECT p.id, p.student_code, p.full_name, p.level
      FROM public.profiles p
      WHERE p.role = 'student'
        AND p.active = true
        AND p.leaderboard_visible = true
        AND (v_is_global OR p.level IS NOT DISTINCT FROM v_caller_level)
    ),
    valid_memoriad AS (
      SELECT
        ar.id,
        COALESCE(ar.settings->>'module', ar.activity_name) AS module_key,
        CASE
          WHEN COALESCE(ar.settings->>'module', ar.activity_name) = 'calendar'
          THEN COALESCE((ar.settings->>'dates')::INT, (ar.settings->>'questions')::INT, 125)
          ELSE NULL
        END AS dates_tier,
        ar.student_id,
        ar.correct,
        ar.total,
        COALESCE((ar.settings->>'score')::NUMERIC, ar.correct::NUMERIC) AS official_score,
        COALESCE((ar.settings->>'used_seconds')::NUMERIC, ar.time_seconds::NUMERIC, 60.0) AS used_seconds,
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
        MIN(vm.used_seconds) AS min_time
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
       AND mtm.min_time = vm.used_seconds
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
        'id', tmh.module_key || CASE WHEN tmh.dates_tier IS NOT NULL THEN '_' || tmh.dates_tier || 'd' ELSE '' END,
        'title', CASE
          WHEN tmh.module_key = 'calendar' THEN 'Calendar (' || tmh.dates_tier || ' Dates)'
          WHEN tmh.module_key = 'multiplication' THEN 'Multiplication (8x8)'
          WHEN tmh.module_key = 'addition' THEN 'Flash Addition'
          WHEN tmh.module_key = 'roots' THEN 'Square Roots'
          ELSE tmh.module_key
        END,
        'section', 'memoriad',
        'module_key', tmh.module_key,
        'dates_tier', tmh.dates_tier,
        'settings_summary', CASE
          WHEN tmh.module_key = 'calendar' THEN tmh.dates_tier || ' dates'
          ELSE 'Competition Module'
        END,
        'settingsSummary', CASE
          WHEN tmh.module_key = 'calendar' THEN tmh.dates_tier || ' dates'
          ELSE 'Competition Module'
        END,
        'has_record', true,
        'hasRecord', true,
        'score', tmh.official_score,
        'used_seconds', tmh.used_seconds,
        'score_display', tmh.official_score || ' pts · ' || tmh.used_seconds || 's',
        'scoreDisplay', tmh.official_score || ' pts · ' || tmh.used_seconds || 's',
        'attempt_url', '/pages/memoriad-play.html?module=' || tmh.module_key || CASE WHEN tmh.dates_tier IS NOT NULL THEN '&dates=' || tmh.dates_tier ELSE '' END,
        'attemptUrl', '/pages/memoriad-play.html?module=' || tmh.module_key || CASE WHEN tmh.dates_tier IS NOT NULL THEN '&dates=' || tmh.dates_tier ELSE '' END,
        'attempt_label', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(tmh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
        'attemptLabel', CASE WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(tmh.holders) h
          WHERE (h->>'student_id')::UUID = v_caller
        ) THEN 'Defend record' ELSE 'Attempt online' END,
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
  ELSE
    RAISE EXCEPTION 'Unknown practice section "%". Expected basics, flash, element, or memoriad.', v_sec
      USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Explicit Function Permissions
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.format_leaderboard_name(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.format_leaderboard_name(TEXT, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.format_leaderboard_name(TEXT, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.practice_highest_records(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.practice_highest_records(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.practice_highest_records(TEXT, JSONB) TO authenticated, service_role;

COMMIT;
