-- ==============================================================================
-- Trendz Tracker — Owner Phase 19 Follow-up: Leaderboard Auth & Weekly Sections
-- File: supabase/owner_phase19_followup_fixes.sql
--
-- TARGET ENVIRONMENT: Production Mumbai (kgzivhavpsvitwrscrrj) & Staging (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Fixes two confirmed database issues following Phase 19:
-- 1. Student Leaderboard Authorization Failure:
--    Extracts trusted internal aggregate calculation helper (_todo_status_on_internal)
--    with restricted execution permissions (service_role only; blocked for anon and authenticated).
--    Updates streak_day_counts and todo_all_done_on to use this internal helper,
--    enabling students to load 'streak' and 'todo' leaderboards without 42501 errors.
--    Preserves strict caller authorization in public todo_status_on (students, unassigned
--    teachers, and anonymous callers still cannot view other students' daily tasks).
-- 2. Weekly-Test Section Creation Failure:
--    Updates save_weekly_test_sections_atomic to normalize and null unrelated fields
--    by section kind (basics, round, elements, memoriad, flash), strictly complying
--    with table check constraint wt_sections_shape_check.
--
-- EXECUTION INSTRUCTIONS:
-- 1. Review this script carefully.
-- 2. Run in Supabase SQL Editor as database owner (postgres).
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- Part 1: Trusted Internal Task Status Helper (_todo_status_on_internal)
-- Calculates daily task progress and completion for a target student without
-- evaluating caller identity. Restricted so clients cannot call it over PostgREST.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._todo_status_on_internal(
  p_student UUID,
  p_day DATE DEFAULT public.today_ist()
)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_day DATE := COALESCE(p_day, public.today_ist());
  v_phase19_active BOOLEAN := false;
  v_phase19_rollout TIMESTAMPTZ;
BEGIN
  IF p_student IS NULL THEN
    RETURN;
  END IF;

  -- Rollout milestone boundary inspection:
  -- Deterministic behavior: if the boundary is missing, or status <> 'active', or activated_at IS NULL,
  -- enforcement is INACTIVE (v_phase19_active := false).
  BEGIN
    SELECT (status = 'active' AND activated_at IS NOT NULL), activated_at
      INTO v_phase19_active, v_phase19_rollout
      FROM public.rollout_boundaries
     WHERE feature = 'phase19_authoritative_todo';
  EXCEPTION WHEN others THEN
    v_phase19_active := false;
    v_phase19_rollout := NULL;
  END;

  v_phase19_active := COALESCE(v_phase19_active, false);

  RETURN QUERY
  SELECT x.id, x.title, x.section, x.category_id, x.activity_key, x.required_count, x.cnt,
         (x.cnt >= x.required_count)
    FROM (
      SELECT t.id, t.title, t.section, t.category_id, t.activity_key, t.required_count, t.sort_order,
        (CASE
          WHEN t.section = 'basics' THEN
            (SELECT count(*) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'basics'
                AND (t.category_id IS NULL OR r.category_id = t.category_id)
                AND (t.activity_key IS NULL OR r.category_id = t.activity_key::uuid)
                AND r.entry_date = v_day
                AND (
                  -- If Phase 19 is not activated yet, retain existing production credit logic
                  (NOT v_phase19_active)
                  OR
                  -- Source A: Authoritative online assigned session completing full duration
                  (
                    r.source IN ('site', 'online')
                    AND EXISTS (
                      SELECT 1 FROM public.drill_sessions ds
                       WHERE (ds.result_row_id = r.id OR ds.result_id = r.id)
                         AND ds.student_id = p_student
                         AND ds.activity_type = 'basics'
                         AND (ds.settings ->> 'todo_task_id')::uuid = t.id
                         AND COALESCE((ds.settings ->> 'todo_credit')::boolean, false) = true
                    )
                  )
                  OR
                  -- Source B: Manually logged offline practice across actual stored source values (practice, typed, manual, offline, etc.)
                  (
                    COALESCE(r.source, '') NOT IN ('site', 'online')
                  )
                  OR
                  -- Source C: Legacy online rows prior to Phase 19 activation timestamp,
                  -- OR legitimate in-progress sessions started before the activation boundary
                  (
                    r.source IN ('site', 'online')
                    AND (
                      r.created_at < v_phase19_rollout
                      OR EXISTS (
                        SELECT 1 FROM public.drill_sessions ds
                         WHERE (ds.result_row_id = r.id OR ds.result_id = r.id)
                           AND ds.student_id = p_student
                           AND ds.activity_type = 'basics'
                           AND ds.started_at < v_phase19_rollout
                      )
                    )
                  )
                )
                AND COALESCE(r.total, 0) > 0)
          WHEN t.category_id IS NOT NULL AND t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.student_round_id IS NOT NULL AND r.entry_date = v_day
                AND COALESCE(r.total, 0) > 0)
          WHEN t.category_id IS NOT NULL THEN
            (SELECT count(*) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.entry_date = v_day
                AND COALESCE(r.total, 0) > 0)
          WHEN t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'round'
                AND r.student_round_id IS NOT NULL AND r.entry_date = v_day
                AND COALESCE(r.total, 0) > 0)
          WHEN t.section = 'elements' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'element'
                AND (t.activity_key IS NULL OR a.settings ->> 'drill' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day
                AND COALESCE(a.total, 0) > 0)
          WHEN t.section = 'flash' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'flash_anzan'
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day
                AND (
                  -- If Phase 19 is active, new submissions must match the assigned todo_task_id
                  ((a.settings ->> 'todo_task_id')::uuid = t.id)
                  OR
                  -- Fallback to parameter matching if:
                  -- 1. Phase 19 is not active yet (NOT v_phase19_active)
                  -- 2. The result row was created before activation (a.created_at < v_phase19_rollout)
                  -- 3. The session was started before activation (linked drill_session started_at < v_phase19_rollout)
                  (
                    (
                      NOT v_phase19_active
                      OR a.created_at < v_phase19_rollout
                      OR EXISTS (
                        SELECT 1 FROM public.drill_sessions ds
                         WHERE (ds.result_id = a.id OR (a.settings ->> 'session_id')::uuid = ds.id)
                           AND ds.student_id = p_student
                           AND ds.activity_type = 'flash_anzan'
                           AND ds.started_at < v_phase19_rollout
                      )
                    )
                    AND a.settings ->> 'todo_task_id' IS NULL
                    AND (t.flash_digits IS NULL OR a.settings ->> 'digits' = t.flash_digits::text)
                    AND (t.flash_count IS NULL OR a.settings ->> 'count' = t.flash_count::text)
                    AND (t.flash_speed_ms IS NULL OR a.settings ->> 'speed_ms' = t.flash_speed_ms::text)
                    AND (t.flash_mode IS NULL OR a.settings ->> 'mode' = t.flash_mode)
                  )
                )
                AND COALESCE(a.total, 0) > 0)
          WHEN t.section = 'memoriad' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'memoriad'
                AND (t.activity_key IS NULL OR a.settings ->> 'module' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day
                AND COALESCE(a.total, 0) > 0)
          ELSE 0
        END)::integer AS cnt
        FROM public.daily_tasks t
        JOIN public.profiles p ON p.id = p_student
       WHERE t.active
         AND (t.created_at AT TIME ZONE 'Asia/Kolkata')::DATE <= v_day
         AND (
           (t.target_scope = 'targeted' AND public.is_daily_task_recipient(t.id, p_student))
           OR (
             COALESCE(t.target_scope, 'all') = 'all'
             AND (t.level IS NULL OR t.level = p.level)
           )
         )
    ) x
   ORDER BY x.sort_order, x.title;
END;
$$;

-- Restrict execution: clients cannot call internal helper directly over PostgREST
REVOKE ALL ON FUNCTION public._todo_status_on_internal(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._todo_status_on_internal(UUID, DATE) TO service_role;

COMMENT ON FUNCTION public._todo_status_on_internal(UUID, DATE) IS
  'Internal trusted helper computing student task progress and completion. Execution restricted to service_role and security-definer callers.';

-- ------------------------------------------------------------------------------
-- Part 2: Public todo_status_on with Caller Authorization Gate
-- Preserves EXACT Phase 18 parameter signature, return columns, and error codes.
-- Verifies caller access (admin, assigned teacher, self, service-role) before
-- delegating to the internal calculation helper.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.todo_status_on(
  p_student UUID,
  p_day DATE DEFAULT public.today_ist()
)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_service BOOLEAN := (v_jwt_role = 'service_role');
  v_day DATE := COALESCE(p_day, public.today_ist());
  v_caller_active BOOLEAN;
BEGIN
  -- Target student validation
  IF p_student IS NULL THEN
    RAISE EXCEPTION 'Target student ID is required.' USING ERRCODE = '22023';
  END IF;

  -- 1. Anonymous access check: Authentication required
  IF v_caller IS NULL AND NOT v_is_service THEN
    RAISE EXCEPTION 'Unauthorized: Authentication required.'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Caller active status check
  IF NOT v_is_service AND NOT public.is_admin() THEN
    SELECT p.active INTO v_caller_active
    FROM public.profiles p
    WHERE p.id = v_caller;

    IF v_caller_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Forbidden: Inactive or invalid user.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 3. Caller authorization: Student self, active administrator, or authorized assigned teacher
  IF NOT v_is_service AND v_caller IS DISTINCT FROM p_student AND NOT public.is_admin() THEN
    IF public.is_teacher(v_caller) THEN
      IF NOT (
        public.has_teacher_permission(v_caller, 'view_students')
        AND public.has_teacher_permission(v_caller, 'manage_tasks')
        AND public.is_teacher_assigned_to_student(v_caller, p_student)
      ) THEN
        RAISE EXCEPTION 'Forbidden: You do not have permission to view daily tasks for this student.'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      RAISE EXCEPTION 'Forbidden: You may only view your own daily tasks.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public._todo_status_on_internal(p_student, v_day);
END;
$$;

REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;

COMMENT ON FUNCTION public.todo_status_on(UUID, DATE) IS
  'Public authorized RPC returning daily task progress. Enforces strict student self, admin, and assigned teacher authorization.';

-- ------------------------------------------------------------------------------
-- Part 3: Public todo_for Thin Authorized Wrapper
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.todo_for(p_student UUID DEFAULT NULL::UUID)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  task_activity_key TEXT,
  required_count INTEGER,
  done_count INTEGER,
  done BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
BEGIN
  RETURN QUERY
  SELECT * FROM public.todo_status_on(v_target, public.today_ist());
END;
$$;

REVOKE ALL ON FUNCTION public.todo_for(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_for(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 4: Helper streak_day_counts (Uses Internal Calculation Engine)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_day_counts(p_student UUID, p_day DATE, p_has_practice BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_start DATE;
  v_log RECORD;
  v_total INTEGER;
  v_done INTEGER;
BEGIN
  SELECT cs.value::DATE INTO v_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';

  -- before the rule starts (or when the rule is off) any practice counts
  IF v_start IS NULL OR p_day < v_start THEN
    RETURN p_has_practice;
  END IF;

  -- finished days use the stored result
  IF p_day < public.today_ist() THEN
    SELECT l.tasks_total, l.all_done INTO v_log
      FROM public.daily_todo_log l WHERE l.student_id = p_student AND l.day = p_day;
    IF FOUND THEN
      IF v_log.tasks_total = 0 THEN RETURN p_has_practice; END IF;
      RETURN v_log.all_done;
    END IF;
  END IF;

  -- today, or a finished day not stored yet: calculate via internal helper
  SELECT count(*)::INTEGER, (count(*) FILTER (WHERE s.done))::INTEGER
    INTO v_total, v_done
    FROM public._todo_status_on_internal(p_student, p_day) s;
  IF v_total = 0 THEN RETURN p_has_practice; END IF;
  RETURN v_done = v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 5: Helper todo_all_done_on (Uses Internal Calculation Engine)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.todo_all_done_on(p_student UUID, p_day DATE)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT COALESCE(count(*) > 0 AND bool_and(s.done), false)
    FROM public._todo_status_on_internal(p_student, p_day) s;
$$;

REVOKE ALL ON FUNCTION public.todo_all_done_on(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_all_done_on(UUID, DATE) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 6: Helper streak_calc
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_calc(p_student UUID)
RETURNS TABLE(current_streak INTEGER, best_streak INTEGER, shields INTEGER, active_today BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
#variable_conflict use_column
DECLARE
  v_today DATE := public.today_ist();
  v_days DATE[];
  v_start DATE;
  v_d DATE;
  v_streak INTEGER := 0;
  v_best INTEGER := 0;
  v_shields INTEGER := 0;
  v_counts BOOLEAN;
  v_today_counts BOOLEAN := false;
BEGIN
  SELECT array_agg(DISTINCT dt ORDER BY dt) INTO v_days FROM (
    SELECT r.entry_date AS dt
      FROM public.results r
     WHERE r.student_id = p_student
       AND COALESCE(r.total, 0) > 0
       AND r.entry_date <= v_today
    UNION
    SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS dt
      FROM public.activity_results a
     WHERE a.student_id = p_student
       AND a.total > 0
       AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE <= v_today
  ) q;

  IF v_days IS NULL OR array_length(v_days, 1) IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  SELECT min(x) INTO v_start FROM unnest(v_days) AS x;

  FOR v_d IN SELECT g::DATE FROM generate_series(v_start, v_today, interval '1 day') AS g LOOP
    v_counts := public.streak_day_counts(p_student, v_d, (v_d = ANY (v_days)));
    IF v_d = v_today THEN
      v_today_counts := v_counts;
      IF v_counts THEN
        v_streak := v_streak + 1;
        IF v_streak > v_best THEN v_best := v_streak; END IF;
        IF v_streak > 0 AND v_streak % 7 = 0 THEN v_shields := 1; END IF;
      END IF;
    ELSE
      IF v_counts THEN
        v_streak := v_streak + 1;
        IF v_streak > v_best THEN v_best := v_streak; END IF;
        IF v_streak > 0 AND v_streak % 7 = 0 THEN v_shields := 1; END IF;
      ELSE
        IF v_shields > 0 THEN
          v_shields := v_shields - 1;
        ELSE
          v_streak := 0;
        END IF;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_streak, v_best, v_shields, v_today_counts;
END;
$$;

REVOKE ALL ON FUNCTION public.streak_calc(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_calc(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 7: Leaderboard RPC Permissions & Contract Preservation
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.leaderboard(
  p_board TEXT,
  p_period TEXT DEFAULT 'week'::TEXT,
  p_level TEXT DEFAULT NULL::TEXT,
  p_limit INTEGER DEFAULT 10,
  p_scope TEXT DEFAULT 'level'::TEXT
)
RETURNS TABLE(rank INTEGER, student_id UUID, display_name TEXT, value NUMERIC, is_me BOOLEAN, level TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
#variable_conflict use_column
DECLARE
  v_admin BOOLEAN := public.is_admin();
  v_me UUID := auth.uid();
  v_all BOOLEAN;
  v_level TEXT;
  v_from DATE;
  v_to DATE;
  v_wt_mult NUMERIC;
  v_att_pts NUMERIC;
  v_min_entries INTEGER;
  v_limit INTEGER;
  v_today DATE := public.today_ist();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF p_board NOT IN ('points', 'streak', 'practice_days', 'improved', 'todo') THEN
    RAISE EXCEPTION 'Unknown board';
  END IF;
  IF COALESCE(p_scope, 'level') NOT IN ('level', 'global') THEN
    RAISE EXCEPTION 'Unknown scope';
  END IF;

  SELECT b.d_from, b.d_to INTO v_from, v_to FROM public.period_bounds(COALESCE(p_period, 'week')) b;
  SELECT r.weekly_test_multiplier, r.attendance_present_points, r.improved_min_entries
    INTO v_wt_mult, v_att_pts, v_min_entries
    FROM public.competition_rules() r;

  IF v_admin THEN
    v_all := (p_level IS NULL OR lower(p_level) = 'all' OR COALESCE(p_scope, 'level') = 'global');
    v_level := CASE WHEN v_all THEN NULL ELSE p_level END;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  ELSE
    IF COALESCE(p_scope, 'level') = 'global' THEN
      IF NOT public.global_leaderboard_enabled() THEN
        RAISE EXCEPTION 'The global leaderboard is switched off.';
      END IF;
      v_all := true;
      v_level := NULL;
    ELSE
      v_all := false;
      SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;
    END IF;
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 10);
  END IF;

  RETURN QUERY
  WITH elig AS (
    SELECT p.id, p.level AS lvl, public.display_name_for(p.full_name, p.student_code) AS dn
      FROM public.profiles p
     WHERE p.role = 'student' AND p.active AND p.leaderboard_visible
       AND (v_all OR p.level IS NOT DISTINCT FROM v_level)
  ),
  vals AS (
    SELECT e.id, e.dn, e.lvl,
      (CASE p_board
        WHEN 'points' THEN
          COALESCE((SELECT sum(GREATEST(0, 2 * s.correct - s.total))
                      FROM public.weekly_test_scores s
                      JOIN public.weekly_tests t ON t.id = s.test_id
                     WHERE s.student_id = e.id AND t.test_date BETWEEN v_from AND v_to), 0) * v_wt_mult
          + COALESCE((SELECT count(*)
                        FROM public.attendance a
                        JOIN public.attendance_sessions x ON x.id = a.session_id
                       WHERE a.student_id = e.id AND a.status = 'present'
                         AND x.session_date BETWEEN v_from AND v_to), 0) * v_att_pts
        WHEN 'streak' THEN
          (SELECT sc.current_streak FROM public.streak_calc(e.id) sc)
        WHEN 'practice_days' THEN
          public.practice_days_for(e.id, v_from, v_to)
        WHEN 'improved' THEN
          (SELECT CASE WHEN w.n1 >= v_min_entries AND w.n0 >= v_min_entries AND w.t1 > 0 AND w.t0 > 0
                       THEN round(100.0 * w.c1 / w.t1 - 100.0 * w.c0 / w.t0, 1) END
             FROM (
               SELECT
                 count(*) FILTER (WHERE r.entry_date > v_today - 7) AS n1,
                 sum(r.correct) FILTER (WHERE r.entry_date > v_today - 7) AS c1,
                 sum(r.total) FILTER (WHERE r.entry_date > v_today - 7) AS t1,
                 count(*) FILTER (WHERE r.entry_date <= v_today - 7) AS n0,
                 sum(r.correct) FILTER (WHERE r.entry_date <= v_today - 7) AS c0,
                 sum(r.total) FILTER (WHERE r.entry_date <= v_today - 7) AS t0
               FROM public.results r
              WHERE r.student_id = e.id AND r.total > 0 AND r.correct IS NOT NULL
                AND r.entry_date > v_today - 14 AND r.entry_date <= v_today
             ) w)
        WHEN 'todo' THEN
          COALESCE((SELECT count(*) FROM public.daily_todo_log l
                     WHERE l.student_id = e.id AND l.day BETWEEN v_from AND v_to
                       AND l.tasks_total > 0 AND l.all_done), 0)
          + CASE WHEN v_today BETWEEN v_from AND v_to
                      AND public.todo_all_done_on(e.id, v_today) THEN 1 ELSE 0 END
      END)::numeric AS v
    FROM elig e
  ),
  ranked AS (
    SELECT (rank() OVER (ORDER BY vv.v DESC))::integer AS rk, vv.id, vv.dn, vv.lvl, vv.v
      FROM vals vv
     WHERE vv.v IS NOT NULL AND vv.v > 0
  )
  SELECT r.rk, CASE WHEN v_admin THEN r.id END, r.dn, r.v, (r.id = v_me), r.lvl
    FROM ranked r
   WHERE r.rk <= v_limit OR r.id = v_me
   ORDER BY r.rk, r.dn;
END;
$$;

REVOKE ALL ON FUNCTION public.leaderboard(TEXT, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leaderboard(TEXT, TEXT, TEXT, INTEGER, TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 8: Atomic Weekly Test Sections RPC (save_weekly_test_sections_atomic)
-- Normalizes and validates section fields by kind to strictly comply with
-- table constraint wt_sections_shape_check.
-- ------------------------------------------------------------------------------
-- Ensure any existing unique position constraint is DEFERRABLE INITIALLY DEFERRED
-- so position reordering within 1..20 does not fail on intermediate swaps without
-- resorting to invalid negative numbers that violate weekly_test_sections_position_check.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weekly_test_sections_test_id_position_key'
      AND conrelid = 'public.weekly_test_sections'::regclass
      AND NOT condeferrable
  ) THEN
    ALTER TABLE public.weekly_test_sections
      DROP CONSTRAINT weekly_test_sections_test_id_position_key;
    ALTER TABLE public.weekly_test_sections
      ADD CONSTRAINT weekly_test_sections_test_id_position_key
      UNIQUE (test_id, position)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.save_weekly_test_sections_atomic(
  p_test_id UUID,
  p_test JSONB,
  p_sections JSONB,
  p_recipients UUID[] DEFAULT NULL::UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT;
  v_active BOOLEAN;
  v_is_admin BOOLEAN := false;
  v_caller UUID := auth.uid();
  v_created_by UUID;

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
  v_deduped_recipients UUID[] := ARRAY[]::UUID[];
BEGIN
  -- Step 1: Authorization
  SELECT role, active INTO v_role, v_active FROM public.profiles WHERE id = v_caller;

  IF v_role = 'admin' AND v_active = true THEN
    v_is_admin := true;
  ELSIF v_role = 'teacher' AND v_active = true THEN
    IF NOT public.has_teacher_permission(v_caller, 'manage_tests') THEN
      RAISE EXCEPTION 'Unauthorized: Teacher does not have can_manage_tests permission.'
        USING ERRCODE = '42501';
    END IF;
    v_is_admin := false;
  ELSIF COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_is_admin := true;
  ELSE
    RAISE EXCEPTION 'Unauthorized: only admin or authorized teacher can modify weekly tests'
      USING ERRCODE = '42501';
  END IF;

  -- Teacher edit ownership check
  IF NOT v_is_admin AND p_test_id IS NOT NULL THEN
    SELECT created_by INTO v_created_by FROM public.weekly_tests WHERE id = p_test_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Weekly test % not found', p_test_id USING ERRCODE = 'P0002';
    END IF;
    IF v_created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only edit weekly tests that they created.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Deduplicate & strip NULLs
  IF p_recipients IS NOT NULL AND cardinality(p_recipients) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_recipients
    FROM unnest(p_recipients) AS sid WHERE sid IS NOT NULL;
  END IF;

  -- Teacher recipient validation: MUST fail closed if empty, NULL, or all-NULL
  IF NOT v_is_admin THEN
    IF v_deduped_recipients IS NULL OR cardinality(v_deduped_recipients) = 0 THEN
      RAISE EXCEPTION 'Targeted recipients required: Teachers must specify at least one recipient.'
        USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT public.is_teacher_assigned_to_student(v_caller, sid)
    ) THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only assign weekly tests to their assigned students.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Validate all non-empty recipients exist as active students
  IF v_deduped_recipients IS NOT NULL AND cardinality(v_deduped_recipients) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid recipient: All test recipients must be active students.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Step 2: Parent Test Payload Validation
  IF p_test IS NULL OR jsonb_typeof(p_test) <> 'object' THEN
    RAISE EXCEPTION 'Invalid test payload: must be a JSON object' USING ERRCODE = '22023';
  END IF;

  v_title := TRIM(COALESCE(p_test->>'title', ''));
  IF v_title = '' THEN
    RAISE EXCEPTION 'Test title is required' USING ERRCODE = '22023';
  END IF;

  v_date_str := TRIM(COALESCE(p_test->>'test_date', ''));
  IF v_date_str = '' THEN
    RAISE EXCEPTION 'Test date is required' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_test_date := v_date_str::DATE;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid test date format: %', v_date_str USING ERRCODE = '22023';
  END;

  v_test_type := TRIM(COALESCE(p_test->>'test_type', 'offline'));
  IF v_test_type NOT IN ('offline', 'online') THEN
    RAISE EXCEPTION 'Invalid test_type: must be offline or online' USING ERRCODE = '22023';
  END IF;

  v_audience_level := NULLIF(TRIM(COALESCE(p_test->>'audience_level', '')), '');
  v_notes := NULLIF(TRIM(COALESCE(p_test->>'notes', '')), '');

  IF v_test_type = 'online' THEN
    IF p_test->>'opens_at' IS NOT NULL AND TRIM(p_test->>'opens_at') <> '' THEN
      BEGIN
        v_opens_at := (p_test->>'opens_at')::TIMESTAMPTZ;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid opens_at timestamp' USING ERRCODE = '22023';
      END;
    END IF;

    IF p_test->>'closes_at' IS NOT NULL AND TRIM(p_test->>'closes_at') <> '' THEN
      BEGIN
        v_closes_at := (p_test->>'closes_at')::TIMESTAMPTZ;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid closes_at timestamp' USING ERRCODE = '22023';
      END;
    END IF;

    IF v_opens_at IS NOT NULL AND v_closes_at IS NOT NULL AND v_closes_at <= v_opens_at THEN
      RAISE EXCEPTION 'closes_at must be strictly after opens_at' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_opens_at := NULL;
    v_closes_at := NULL;
  END IF;

  v_remind_raw := TRIM(COALESCE(p_test->>'remind_days_before', ''));
  IF v_remind_raw <> '' THEN
    BEGIN
      v_remind_days := v_remind_raw::INT;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid remind_days_before: must be an integer' USING ERRCODE = '22023';
    END;
    IF v_remind_days < 0 OR v_remind_days > 30 THEN
      RAISE EXCEPTION 'remind_days_before must be between 0 and 30' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_remind_days := 7;
  END IF;

  -- Step 3: Sections Validation
  IF p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' THEN
    RAISE EXCEPTION 'Sections payload must be a JSON array' USING ERRCODE = '22023';
  END IF;

  v_sec_count := jsonb_array_length(p_sections);
  IF v_sec_count > 12 THEN
    RAISE EXCEPTION 'Weekly tests can have at most 12 sections (received %)', v_sec_count
      USING ERRCODE = '22023';
  END IF;

  -- Step 4: Lock Parent Test Row
  IF p_test_id IS NOT NULL THEN
    SELECT id, created_by INTO v_existing_test_id, v_created_by
    FROM public.weekly_tests
    WHERE id = p_test_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Weekly test with id % not found', p_test_id USING ERRCODE = '23503';
    END IF;

    UPDATE public.weekly_tests
    SET title = v_title,
        test_date = v_test_date,
        test_type = v_test_type,
        audience_level = v_audience_level,
        notes = v_notes,
        opens_at = v_opens_at,
        closes_at = v_closes_at,
        remind_days_before = v_remind_days,
        target_scope = CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    WHERE id = p_test_id;
  ELSE
    v_existing_test_id := gen_random_uuid();
    INSERT INTO public.weekly_tests (
      id, title, test_date, test_type, audience_level, notes,
      opens_at, closes_at, remind_days_before, created_by, target_scope
    ) VALUES (
      v_existing_test_id, v_title, v_test_date, v_test_type, v_audience_level, v_notes,
      v_opens_at, v_closes_at, v_remind_days, v_caller,
      CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    );
  END IF;

  -- Step 5: Update Recipients
  IF NOT v_is_admin OR p_recipients IS NOT NULL THEN
    DELETE FROM public.weekly_test_recipients WHERE test_id = v_existing_test_id;
    IF cardinality(v_deduped_recipients) > 0 THEN
      INSERT INTO public.weekly_test_recipients (test_id, student_id)
      SELECT v_existing_test_id, sid FROM unnest(v_deduped_recipients) AS sid;
    END IF;
  END IF;

  -- Step 6: Validate & Upsert Sections
  -- Check locked sections
  IF p_test_id IS NOT NULL THEN
    FOR v_old_sec IN
      SELECT s.* FROM public.weekly_test_sections s WHERE s.test_id = p_test_id
    LOOP
      SELECT (
        EXISTS (SELECT 1 FROM public.weekly_test_scores sc WHERE sc.test_id = p_test_id AND sc.category_id = v_old_sec.category_id)
        OR EXISTS (SELECT 1 FROM public.weekly_test_attempts att WHERE att.section_id = v_old_sec.id)
      ) INTO v_is_locked;

      IF v_is_locked THEN
        -- Verify it is not deleted
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_sections) sec_el
          WHERE (sec_el->>'id')::UUID = v_old_sec.id
        ) THEN
          RAISE EXCEPTION 'Cannot delete section %: attempts or scores already recorded', v_old_sec.id
            USING ERRCODE = '23503';
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Upsert sections
  FOR i IN 0..(v_sec_count - 1) LOOP
    v_sec := p_sections->i;
    v_pos := i + 1;
    v_kind := LOWER(TRIM(COALESCE(v_sec->>'kind', 'basics')));
    IF v_kind NOT IN ('basics', 'round', 'flash', 'elements', 'memoriad') THEN
      RAISE EXCEPTION 'Invalid section kind "%": must be basics, round, flash, elements, or memoriad', v_kind
        USING ERRCODE = '22023';
    END IF;

    IF v_test_type = 'online' AND v_kind = 'round' THEN
      RAISE EXCEPTION 'Round sections are available for offline tests only'
        USING ERRCODE = '22023';
    END IF;

    v_sec_id := NULLIF(TRIM(COALESCE(v_sec->>'id', '')), '')::UUID;
    IF v_sec_id IS NULL THEN
      v_sec_id := gen_random_uuid();
    END IF;

    IF v_sec_id = ANY(v_incoming_ids) THEN
      RAISE EXCEPTION 'Duplicate section id in payload: %', v_sec_id
        USING ERRCODE = '23505';
    END IF;
    v_incoming_ids := array_append(v_incoming_ids, v_sec_id);

    -- -------------------------------------------------------------------------
    -- Field normalization and validation by section kind:
    -- Strictly satisfies table check constraint wt_sections_shape_check:
    -- - basics / round: category_id populated; activity_key, flash_*, question_count NULL.
    -- - elements / memoriad: activity_key populated (2..40 chars); category_id, seconds, flash_*, question_count NULL.
    -- - flash: flash_* & question_count validated; category_id, seconds, activity_key NULL.
    -- -------------------------------------------------------------------------
    IF v_kind IN ('basics', 'round') THEN
      v_activity_key := NULL;
      v_flash_digits := NULL;
      v_flash_count := NULL;
      v_flash_speed_ms := NULL;
      v_flash_mode := NULL;
      v_question_count := NULL;

      v_raw_cat := NULLIF(TRIM(COALESCE(v_sec->>'category_id', '')), '');
      IF v_raw_cat IS NULL THEN
        RAISE EXCEPTION '% section requires category_id', v_kind USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_cat_id := v_raw_cat::UUID;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid category_id format: %', v_raw_cat USING ERRCODE = '22023';
      END;

      SELECT name, section INTO v_cat_name, v_cat_section
        FROM public.categories
       WHERE id = v_cat_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION '% category % does not exist', v_kind, v_cat_id USING ERRCODE = '23503';
      END IF;
      IF v_cat_section IS DISTINCT FROM v_kind THEN
        RAISE EXCEPTION 'Category "%" does not belong to % (section is "%")', v_cat_name, v_kind, v_cat_section
          USING ERRCODE = '22023';
      END IF;

      IF v_kind = 'basics' THEN
        IF (v_sec->>'seconds') IS NOT NULL AND TRIM(v_sec->>'seconds') <> '' THEN
          BEGIN
            v_seconds := (v_sec->>'seconds')::INT;
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Invalid seconds format' USING ERRCODE = '22023';
          END;
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
      ELSE
        -- Round sections cannot have seconds
        v_seconds := NULL;
      END IF;

    ELSIF v_kind IN ('elements', 'memoriad') THEN
      v_cat_id := NULL;
      v_seconds := NULL;
      v_flash_digits := NULL;
      v_flash_count := NULL;
      v_flash_speed_ms := NULL;
      v_flash_mode := NULL;
      v_question_count := NULL;

      v_activity_key := NULLIF(TRIM(COALESCE(v_sec->>'activity_key', '')), '');
      IF v_activity_key IS NULL THEN
        RAISE EXCEPTION '% section requires activity_key', v_kind USING ERRCODE = '22023';
      END IF;
      IF NOT (v_activity_key ~ '^[a-z0-9_]{2,40}$') THEN
        RAISE EXCEPTION 'Invalid activity_key "%" for % section', v_activity_key, v_kind USING ERRCODE = '22023';
      END IF;

    ELSIF v_kind = 'flash' THEN
      v_cat_id := NULL;
      v_seconds := NULL;
      v_activity_key := NULL;

      BEGIN
        v_flash_digits := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_digits', '')), '')::INT, 1);
        v_flash_count := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_count', '')), '')::INT, 20);
        v_flash_speed_ms := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_speed_ms', '')), '')::INT, 800);
        v_flash_mode := LOWER(TRIM(COALESCE(v_sec->>'flash_mode', 'add')));
        v_question_count := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'question_count', '')), '')::INT, 5);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Invalid Flash settings format' USING ERRCODE = '22023';
      END;

      IF v_flash_digits < 1 OR v_flash_digits > 5 THEN
        RAISE EXCEPTION 'Flash digits must be between 1 and 5 (received %)', v_flash_digits USING ERRCODE = '22023';
      END IF;
      IF v_flash_count < 2 OR v_flash_count > 1000 THEN
        RAISE EXCEPTION 'Flash count must be between 2 and 1000 (received %)', v_flash_count USING ERRCODE = '22023';
      END IF;
      IF v_flash_speed_ms < 200 OR v_flash_speed_ms > 5000 THEN
        RAISE EXCEPTION 'Flash speed must be between 200 and 5000 ms (received %)', v_flash_speed_ms USING ERRCODE = '22023';
      END IF;
      IF v_flash_mode NOT IN ('add', 'add_sub') THEN
        RAISE EXCEPTION 'Flash mode must be "add" or "add_sub" (received %)', v_flash_mode USING ERRCODE = '22023';
      END IF;
      IF v_question_count < 1 OR v_question_count > 10 THEN
        RAISE EXCEPTION 'Flash question_count must be between 1 and 10 (received %)', v_question_count USING ERRCODE = '22023';
      END IF;
    END IF;

    INSERT INTO public.weekly_test_sections (
      id, test_id, position, kind, category_id, seconds, activity_key,
      flash_digits, flash_count, flash_speed_ms, flash_mode, question_count
    ) VALUES (
      v_sec_id, v_existing_test_id, v_pos, v_kind, v_cat_id, v_seconds, v_activity_key,
      v_flash_digits, v_flash_count, v_flash_speed_ms, v_flash_mode, v_question_count
    )
    ON CONFLICT (id) DO UPDATE SET
      position = EXCLUDED.position,
      kind = EXCLUDED.kind,
      category_id = EXCLUDED.category_id,
      seconds = EXCLUDED.seconds,
      activity_key = EXCLUDED.activity_key,
      flash_digits = EXCLUDED.flash_digits,
      flash_count = EXCLUDED.flash_count,
      flash_speed_ms = EXCLUDED.flash_speed_ms,
      flash_mode = EXCLUDED.flash_mode,
      question_count = EXCLUDED.question_count;
  END LOOP;

  -- Delete removed unlocked sections
  DELETE FROM public.weekly_test_sections
  WHERE test_id = v_existing_test_id
    AND id <> ALL(v_incoming_ids);

  RETURN jsonb_build_object(
    'ok', true,
    'test_id', v_existing_test_id,
    'section_count', v_sec_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]) IS
  'Atomic weekly test and sections upsert RPC. Enforces wt_sections_shape_check by normalizing unrelated columns to NULL by kind.';

COMMIT;
