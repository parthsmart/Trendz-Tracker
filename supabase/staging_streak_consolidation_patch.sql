-- ==============================================================================
-- TRENDZ TRACKER - OWNER MIGRATION PATCH: STREAK CONSOLIDATION & TASK ENFORCEMENT
-- ==============================================================================
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- Review Hardening & Blockers Addressed:
--   1. Preserved exact zero-argument finalizer signature:
--      - Live Mumbai contains public.todo_finalize() with zero arguments.
--      - Replaces body of public.todo_finalize() in place.
--      - Explicitly drops any overloaded public.todo_finalize(integer) to prevent
--        PostgreSQL 42725 ambiguity.
--      - Callers (api/backup.js) and scheduled jobs invoke public.todo_finalize()
--        with zero arguments.
--   2. Safe routine finalization vs historical backfill:
--      - Routine finalization is strictly bounded to yesterday (public.today_ist() - 1).
--      - Does NOT automatically reconstruct old unlogged history using present tasks.
--      - Uses configured todo_streak_start in audit queries rather than hardcoded dates.
--      - For unlogged past days on or after todo_streak_start, streak_day_counts()
--        does NOT infer historical assignments from current task/profile state;
--        unlogged days require stored daily_todo_log verification or explicit owner repair.
--   3. Helper authorization protection:
--      - Explicitly revoked EXECUTE on streak_calc(uuid), streak_day_counts(uuid,date,boolean),
--        _todo_status_on_internal(uuid,date), and todo_finalize() from PUBLIC, anon, authenticated.
--      - Granted EXECUTE exclusively to service_role and internal SECURITY DEFINER callers.
--      - Public entry point is strictly the authorized wrapper: streak_for(uuid).
--   4. Comprehensive pre-apply capture commands, audit queries, executable rollback,
--      and strict post-apply verification DO block.
-- ==============================================================================

-- ==============================================================================
-- OPERATOR CONFIRMATION LATCH (REQUIRED FOR EXECUTION ON STAGING)
-- ==============================================================================
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

-- ------------------------------------------------------------------------------
-- PRE-APPLY CAPTURE & AUDIT QUERIES (RUN IN SUPABASE SQL EDITOR BEFORE APPLYING)
-- ------------------------------------------------------------------------------
/*
-- STEP 0: CAPTURE INSTALLED DEFINITIONS & PRIVILEGES (PRE-APPLY BACKUP)
-- Captures exact identity arguments, function owner, raw ACLs, definitions, and routine privileges
-- distinguishing every function signature and overload.
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  pg_get_userbyid(p.proowner) AS function_owner,
  p.proacl AS raw_acl,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('streak_for', 'streak_calc', 'streak_day_counts', '_todo_status_on_internal', 'todo_finalize')
ORDER BY p.proname, identity_args;

SELECT
  r.routine_name,
  r.specific_name,
  r.routine_type,
  p.grantee,
  p.privilege_type,
  p.is_grantable
FROM information_schema.routines r
JOIN information_schema.routine_privileges p
  ON r.specific_schema = p.specific_schema AND r.specific_name = p.specific_name
WHERE r.routine_schema = 'public'
  AND r.routine_name IN ('streak_for', 'streak_calc', 'streak_day_counts', '_todo_status_on_internal', 'todo_finalize')
ORDER BY r.routine_name, r.specific_name, p.grantee;

-- 1. Check for stored daily_todo_log rows where all_done contradicts tasks_done/total:
SELECT
  l.student_id,
  p.student_code,
  p.full_name,
  l.day,
  l.tasks_total,
  l.tasks_done,
  l.all_done,
  (l.tasks_total > 0 AND l.tasks_done >= l.tasks_total) AS expected_all_done,
  'FLAG_INCONSISTENCY' AS anomaly_type,
  'Manual review required: do not overwrite automatically' AS proposed_action
FROM public.daily_todo_log l
JOIN public.profiles p ON p.id = l.student_id
CROSS JOIN (
  SELECT cs.value::DATE AS streak_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start'
) cs
WHERE l.day >= cs.streak_start
  AND ((l.all_done IS TRUE AND (l.tasks_total = 0 OR l.tasks_done < l.tasks_total))
   OR (l.all_done IS FALSE AND l.tasks_total > 0 AND l.tasks_done >= l.tasks_total))
ORDER BY l.day DESC, p.student_code ASC;

-- 2. Check for past days with recorded practice but NO daily_todo_log row:
-- NOTE ON UNLOGGED HISTORICAL DATES:
-- When no daily_todo_log row exists for a past date, streak_day_counts() evaluates
-- against currently active tasks whose created_at <= that date, falling back to practice
-- existence ONLY when zero matching tasks exist for that student.
-- Because tasks may have been disabled, edited, or the student's level changed since then
-- (and no historical task audit table exists), automatically finalizing old dates risks
-- inventing history.
-- Proposed Action: Manual review required. Keep unlogged until verified by owner/teacher,
-- or record explicit administrator resolution.
SELECT
  q.student_id,
  p.student_code,
  p.full_name,
  q.dt AS practice_date,
  q.practice_count,
  COALESCE(l.tasks_total, -1) AS log_tasks_total,
  COALESCE(l.all_done, false) AS log_all_done,
  'UNLOGGED_HISTORICAL_PRACTICE' AS anomaly_type,
  'Manual review required: preserve unlogged state until verified' AS proposed_action
FROM (
  SELECT r.student_id, r.entry_date AS dt, count(*) AS practice_count
    FROM public.results r
   WHERE r.entry_date >= (SELECT cs.value::DATE FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start')
     AND r.entry_date < public.today_ist()
   GROUP BY r.student_id, r.entry_date
  UNION
  SELECT a.student_id, (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS dt, count(*) AS practice_count
    FROM public.activity_results a
   WHERE (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= (SELECT cs.value::DATE FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start')
     AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE < public.today_ist()
   GROUP BY a.student_id, (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE
) q
JOIN public.profiles p ON p.id = q.student_id
LEFT JOIN public.daily_todo_log l ON l.student_id = q.student_id AND l.day = q.dt
WHERE l.day IS NULL
ORDER BY q.dt DESC, p.student_code ASC;

-- 3. Check for daily_tasks created or modified after todo_streak_start:
SELECT
  t.id AS task_id,
  t.title,
  t.section,
  (t.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS task_created_ist,
  t.active,
  t.target_scope,
  t.level,
  t.required_count
FROM public.daily_tasks t
WHERE (t.created_at AT TIME ZONE 'Asia/Kolkata')::DATE >= (SELECT cs.value::DATE FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start')
ORDER BY t.created_at DESC;
*/

-- ------------------------------------------------------------------------------
-- DDL UPGRADES: Ensure daily_todo_log supports historical plan snapshots & finalization state
-- ------------------------------------------------------------------------------
ALTER TABLE public.daily_todo_log ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE public.daily_todo_log ADD COLUMN IF NOT EXISTS plan_snapshot JSONB;
ALTER TABLE public.daily_todo_log ALTER COLUMN finalized_at DROP NOT NULL;
ALTER TABLE public.daily_todo_log ALTER COLUMN finalized_at DROP DEFAULT;

-- ------------------------------------------------------------------------------
-- PART 1: HISTORICAL PLAN SNAPSHOTS & TRUSTED STATUS EVALUATION
-- ------------------------------------------------------------------------------

-- 1a. Helper to capture student daily plan snapshot
CREATE OR REPLACE FUNCTION public._todo_plan_snapshot(p_student UUID, p_day DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_day DATE := COALESCE(p_day, public.today_ist());
  v_plan JSONB;
BEGIN
  IF p_student IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'title', t.title,
        'section', t.section,
        'category_id', t.category_id,
        'activity_key', t.activity_key,
        'required_count', t.required_count,
        'sort_order', t.sort_order,
        'flash_digits', t.flash_digits,
        'flash_count', t.flash_count,
        'flash_speed_ms', t.flash_speed_ms,
        'flash_mode', t.flash_mode
      ) ORDER BY t.sort_order, t.title
    ),
    '[]'::jsonb
  )
  INTO v_plan
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
    );

  RETURN v_plan;
END;
$$;

ALTER FUNCTION public._todo_plan_snapshot(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._todo_plan_snapshot(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._todo_plan_snapshot(UUID, DATE) TO service_role;

-- 1b. Helper to evaluate completions against an explicit plan snapshot
CREATE OR REPLACE FUNCTION public._todo_evaluate_plan(
  p_student UUID,
  p_day DATE,
  p_plan JSONB
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
  IF p_student IS NULL OR p_plan IS NULL OR jsonb_typeof(p_plan) <> 'array' OR jsonb_array_length(p_plan) = 0 THEN
    RETURN;
  END IF;

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
      SELECT
        t.id,
        t.title,
        t.section,
        t.category_id,
        t.activity_key,
        t.required_count,
        t.sort_order,
        (CASE
          WHEN t.section = 'basics' THEN
            (SELECT count(*) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'basics'
                AND (t.category_id IS NULL OR r.category_id = t.category_id)
                AND (t.activity_key IS NULL OR r.category_id = t.activity_key::uuid)
                AND r.entry_date = v_day
                AND (
                  (NOT v_phase19_active)
                  OR
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
                  (COALESCE(r.source, '') NOT IN ('site', 'online'))
                  OR
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
                  ((a.settings ->> 'todo_task_id')::uuid = t.id)
                  OR
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
      FROM jsonb_to_recordset(p_plan) AS t(
        id UUID,
        title TEXT,
        section TEXT,
        category_id UUID,
        activity_key TEXT,
        required_count INTEGER,
        sort_order INTEGER,
        flash_digits INTEGER,
        flash_count INTEGER,
        flash_speed_ms INTEGER,
        flash_mode TEXT
      )
    ) x
   ORDER BY x.sort_order, x.title;
END;
$$;

ALTER FUNCTION public._todo_evaluate_plan(UUID, DATE, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._todo_evaluate_plan(UUID, DATE, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._todo_evaluate_plan(UUID, DATE, JSONB) TO service_role;

-- 1c. Trusted Internal Task Status Helper (_todo_status_on_internal)
-- Evaluates past days against saved plan snapshot when available, preventing current-plan pollution.
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
  v_today DATE := public.today_ist();
  v_plan JSONB;
BEGIN
  IF p_student IS NULL THEN
    RETURN;
  END IF;

  -- For past days, evaluate strictly against stored plan snapshot if available
  IF v_day < v_today THEN
    SELECT l.plan_snapshot INTO v_plan
      FROM public.daily_todo_log l
     WHERE l.student_id = p_student AND l.day = v_day;

    IF v_plan IS NOT NULL AND jsonb_typeof(v_plan) = 'array' AND jsonb_array_length(v_plan) > 0 THEN
      RETURN QUERY
      SELECT * FROM public._todo_evaluate_plan(p_student, v_day, v_plan);
      RETURN;
    END IF;
  END IF;

  -- For today (or un-snapshotted historical days), build snapshot and evaluate
  v_plan := public._todo_plan_snapshot(p_student, v_day);
  RETURN QUERY
  SELECT * FROM public._todo_evaluate_plan(p_student, v_day, v_plan);
END;
$$;

ALTER FUNCTION public._todo_status_on_internal(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._todo_status_on_internal(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._todo_status_on_internal(UUID, DATE) TO service_role;

-- ------------------------------------------------------------------------------
-- PART 2: SAFE todo_finalize() (Preserves Zero-Argument Signature, Drops Overload)
-- ------------------------------------------------------------------------------
-- Ensure no overloaded version exists that causes 42725 ambiguity:
DROP FUNCTION IF EXISTS public.todo_finalize(INTEGER);

CREATE OR REPLACE FUNCTION public.todo_finalize()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_start DATE;
  v_yesterday DATE := public.today_ist() - 1;
  v_n INTEGER := 0;
  v_ins INTEGER;
  s RECORD;
  v_plan JSONB;
BEGIN
  SELECT cs.value::DATE INTO v_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';
  IF v_start IS NULL OR v_yesterday < v_start THEN RETURN 0; END IF;

  -- Routine finalization: finalizes strictly yesterday (public.today_ist() - 1).
  -- Older unlogged historical dates are NOT backfilled using current assignment state;
  -- historical repair is kept out of this patch pending owner policy decision.
  FOR s IN SELECT p.id FROM public.profiles p WHERE p.role = 'student' AND p.active LOOP
    -- If a log row already exists for yesterday (e.g. from real-time sync during yesterday or pending):
    IF EXISTS (SELECT 1 FROM public.daily_todo_log WHERE student_id = s.id AND day = v_yesterday) THEN
      UPDATE public.daily_todo_log
         SET finalized_at = COALESCE(finalized_at, now())
       WHERE student_id = s.id AND day = v_yesterday;
    ELSE
      -- Student had no log row yesterday. Snapshot yesterday's plan and insert finalized record:
      v_plan := public._todo_plan_snapshot(s.id, v_yesterday);
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done, finalized_at, plan_snapshot)
      SELECT s.id, v_yesterday,
             COALESCE(jsonb_array_length(v_plan), 0),
             COALESCE((count(*) FILTER (WHERE x.done))::INTEGER, 0),
             (COALESCE(jsonb_array_length(v_plan), 0) > 0 AND COALESCE(jsonb_array_length(v_plan), 0) = count(*) FILTER (WHERE x.done)),
             now(),
             v_plan
        FROM public._todo_evaluate_plan(s.id, v_yesterday, v_plan) x
      ON CONFLICT (student_id, day) DO UPDATE
      SET finalized_at = COALESCE(daily_todo_log.finalized_at, now());
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_n := v_n + v_ins;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

ALTER FUNCTION public.todo_finalize() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.todo_finalize() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.todo_finalize() TO service_role;

-- ------------------------------------------------------------------------------
-- PART 2b: REAL-TIME DAILY PLAN SYNCHRONIZATION (Resolves Midnight-to-Finalization Gap)
-- ------------------------------------------------------------------------------
-- Synchronizes daily plan evidence while the plan is active (during today).
-- When a student completes practice or finishes their daily tasks on day D,
-- daily_todo_log is immediately updated with authoritative completion evidence and plan snapshot.
-- This handles:
--   - Real API submission sequence (results inserted first, drill_sessions linked second)
--   - Session updates, completions, retries, and cleanups
--   - Score deletions and date changes (refreshing both OLD and NEW student/date pairs)
--   - Today's profile level changes, task recipient modifications, and task definitions
-- Across midnight and prior to backup finalization (00:00 - 02:00 IST),
-- the completed day D is already stored in daily_todo_log, preventing
-- temporary streak breaks or shield consumption.
-- Subsequent task/level edits on day D+1 do not alter the captured day D row.

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log(p_student UUID, p_day DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today DATE := public.today_ist();
  v_total INTEGER;
  v_done INTEGER;
  v_all_done BOOLEAN;
  v_existing_log RECORD;
  v_plan JSONB;
BEGIN
  -- Validate input parameters
  IF p_student IS NULL OR p_day IS NULL THEN
    RETURN;
  END IF;

  -- Future dates are ignored
  IF p_day > v_today THEN
    RETURN;
  END IF;

  -- Acquire transaction-level advisory lock on (student, day) to serialize concurrent submissions
  -- and prevent race conditions where parallel transactions read stale task counts.
  PERFORM pg_advisory_xact_lock(hashtext(p_student::text), hashtext(p_day::text));

  IF p_day < v_today THEN
    -- Past day check: only update if a daily_todo_log row already exists!
    -- Never infer or backfill unlogged past history.
    SELECT l.tasks_total, l.tasks_done, l.all_done, l.finalized_at, l.plan_snapshot
      INTO v_existing_log
      FROM public.daily_todo_log l
     WHERE l.student_id = p_student AND l.day = p_day;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    -- If a historical plan snapshot exists, evaluate strictly against that historical plan!
    IF v_existing_log.plan_snapshot IS NOT NULL AND jsonb_typeof(v_existing_log.plan_snapshot) = 'array' THEN
      v_plan := v_existing_log.plan_snapshot;
      v_total := jsonb_array_length(v_plan);
      SELECT (count(*) FILTER (WHERE x.done))::INTEGER
        INTO v_done
        FROM public._todo_evaluate_plan(p_student, p_day, v_plan) x;
      v_all_done := (v_total > 0 AND v_done = v_total);

      UPDATE public.daily_todo_log
         SET tasks_total = v_total,
             tasks_done = v_done,
             all_done = v_all_done
       WHERE student_id = p_student AND day = p_day;
      RETURN;
    END IF;

    -- If already finalized without a snapshot (legacy history), never overwrite:
    IF v_existing_log.finalized_at IS NOT NULL THEN
      RETURN;
    END IF;

    -- Pending past day without snapshot (fallback for in-flight yesterday row):
    v_plan := public._todo_plan_snapshot(p_student, p_day);
    v_total := jsonb_array_length(v_plan);
    SELECT (count(*) FILTER (WHERE x.done))::INTEGER
      INTO v_done
      FROM public._todo_evaluate_plan(p_student, p_day, v_plan) x;
    v_all_done := (v_total > 0 AND v_done = v_total);

    UPDATE public.daily_todo_log
       SET tasks_total = v_total,
           tasks_done = v_done,
           all_done = v_all_done,
           plan_snapshot = v_plan
     WHERE student_id = p_student AND day = p_day;
    RETURN;
  END IF;

  -- TODAY (p_day = v_today):
  -- Actively maintain real-time evidence for today.
  v_plan := public._todo_plan_snapshot(p_student, v_today);
  v_total := jsonb_array_length(v_plan);
  SELECT (count(*) FILTER (WHERE x.done))::INTEGER
    INTO v_done
    FROM public._todo_evaluate_plan(p_student, v_today, v_plan) x;
  v_all_done := (v_total > 0 AND v_done = v_total);

  INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done, finalized_at, plan_snapshot)
  VALUES (p_student, p_day, v_total, v_done, v_all_done, NULL, v_plan)
  ON CONFLICT (student_id, day) DO UPDATE
  SET tasks_total = EXCLUDED.tasks_total,
      tasks_done = EXCLUDED.tasks_done,
      all_done = EXCLUDED.all_done,
      plan_snapshot = EXCLUDED.plan_snapshot;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log(UUID, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._sync_daily_todo_log(OLD.student_id, OLD.entry_date);
    RETURN NULL;
  END IF;

  PERFORM public._sync_daily_todo_log(NEW.student_id, NEW.entry_date);

  IF TG_OP = 'UPDATE' THEN
    IF OLD.student_id IS DISTINCT FROM NEW.student_id OR OLD.entry_date IS DISTINCT FROM NEW.entry_date THEN
      PERFORM public._sync_daily_todo_log(OLD.student_id, OLD.entry_date);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_result() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_result() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_result() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_results ON public.results;
CREATE TRIGGER trg_sync_daily_todo_log_results
AFTER INSERT OR UPDATE OR DELETE ON public.results
FOR EACH ROW EXECUTE FUNCTION public._sync_daily_todo_log_on_result();

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_activity_result()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new_day DATE;
  v_old_day DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_day := (OLD.created_at AT TIME ZONE 'Asia/Kolkata')::date;
    PERFORM public._sync_daily_todo_log(OLD.student_id, v_old_day);
    RETURN NULL;
  END IF;

  v_new_day := (NEW.created_at AT TIME ZONE 'Asia/Kolkata')::date;
  PERFORM public._sync_daily_todo_log(NEW.student_id, v_new_day);

  IF TG_OP = 'UPDATE' THEN
    v_old_day := (OLD.created_at AT TIME ZONE 'Asia/Kolkata')::date;
    IF OLD.student_id IS DISTINCT FROM NEW.student_id OR v_old_day IS DISTINCT FROM v_new_day THEN
      PERFORM public._sync_daily_todo_log(OLD.student_id, v_old_day);
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_activity_result() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_activity_result() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_activity_result() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_activity_results ON public.activity_results;
CREATE TRIGGER trg_sync_daily_todo_log_activity_results
AFTER INSERT OR UPDATE OR DELETE ON public.activity_results
FOR EACH ROW EXECUTE FUNCTION public._sync_daily_todo_log_on_activity_result();

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student UUID;
  v_res_id UUID;
  v_day DATE;
  v_old_res_id UUID;
  v_old_day DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_student := OLD.student_id;
    v_res_id := COALESCE(OLD.result_row_id, OLD.result_id);
    IF v_res_id IS NOT NULL THEN
      SELECT r.entry_date INTO v_day FROM public.results r WHERE r.id = v_res_id;
      IF v_day IS NULL THEN
        SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date INTO v_day
          FROM public.activity_results a WHERE a.id = v_res_id;
      END IF;
    END IF;
    IF v_day IS NULL THEN
      v_day := (COALESCE(OLD.started_at, now()) AT TIME ZONE 'Asia/Kolkata')::date;
    END IF;
    PERFORM public._sync_daily_todo_log(v_student, v_day);
    RETURN NULL;
  END IF;

  v_student := NEW.student_id;
  v_res_id := COALESCE(NEW.result_row_id, NEW.result_id);
  IF v_res_id IS NOT NULL THEN
    SELECT r.entry_date INTO v_day FROM public.results r WHERE r.id = v_res_id;
    IF v_day IS NULL THEN
      SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date INTO v_day
        FROM public.activity_results a WHERE a.id = v_res_id;
    END IF;
  END IF;
  IF v_day IS NULL THEN
    v_day := (COALESCE(NEW.started_at, now()) AT TIME ZONE 'Asia/Kolkata')::date;
  END IF;

  PERFORM public._sync_daily_todo_log(v_student, v_day);

  IF TG_OP = 'UPDATE' THEN
    v_old_res_id := COALESCE(OLD.result_row_id, OLD.result_id);
    IF OLD.student_id IS DISTINCT FROM NEW.student_id OR v_old_res_id IS DISTINCT FROM v_res_id THEN
      IF v_old_res_id IS NOT NULL THEN
        SELECT r.entry_date INTO v_old_day FROM public.results r WHERE r.id = v_old_res_id;
        IF v_old_day IS NULL THEN
          SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::date INTO v_old_day
            FROM public.activity_results a WHERE a.id = v_old_res_id;
        END IF;
      END IF;
      IF v_old_day IS NULL THEN
        v_old_day := (COALESCE(OLD.started_at, now()) AT TIME ZONE 'Asia/Kolkata')::date;
      END IF;
      IF v_old_day IS DISTINCT FROM v_day OR OLD.student_id IS DISTINCT FROM NEW.student_id THEN
        PERFORM public._sync_daily_todo_log(OLD.student_id, v_old_day);
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_session() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_session() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_session() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_drill_sessions ON public.drill_sessions;
CREATE TRIGGER trg_sync_daily_todo_log_drill_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.drill_sessions
FOR EACH ROW EXECUTE FUNCTION public._sync_daily_todo_log_on_session();

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.level IS DISTINCT FROM NEW.level OR OLD.active IS DISTINCT FROM NEW.active) THEN
    PERFORM public._sync_daily_todo_log(NEW.id, public.today_ist());
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_profile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_profile() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_profiles ON public.profiles;
CREATE TRIGGER trg_sync_daily_todo_log_profiles
AFTER UPDATE OF level, active ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public._sync_daily_todo_log_on_profile();

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_recipients()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public._sync_daily_todo_log(OLD.student_id, public.today_ist());
  ELSE
    PERFORM public._sync_daily_todo_log(NEW.student_id, public.today_ist());
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_recipients() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_recipients() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_recipients ON public.daily_task_recipients;
CREATE TRIGGER trg_sync_daily_todo_log_recipients
AFTER INSERT OR UPDATE OR DELETE ON public.daily_task_recipients
FOR EACH ROW EXECUTE FUNCTION public._sync_daily_todo_log_on_recipients();

CREATE OR REPLACE FUNCTION public._sync_daily_todo_log_on_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  -- When daily task configurations change today, re-evaluate daily_todo_log for all active students
  FOR s IN SELECT id FROM public.profiles WHERE role = 'student' AND active LOOP
    PERFORM public._sync_daily_todo_log(s.id, public.today_ist());
  END LOOP;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public._sync_daily_todo_log_on_task() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._sync_daily_todo_log_on_task() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sync_daily_todo_log_on_task() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_tasks ON public.daily_tasks;
CREATE TRIGGER trg_sync_daily_todo_log_tasks
AFTER INSERT OR UPDATE OR DELETE ON public.daily_tasks
FOR EACH STATEMENT EXECUTE FUNCTION public._sync_daily_todo_log_on_task();

-- ------------------------------------------------------------------------------
-- PART 3: UPDATE streak_day_counts (Internal Helper)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_day_counts(
  p_student UUID,
  p_day DATE,
  p_has_practice BOOLEAN
)
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
  IF p_student IS NULL OR p_day IS NULL THEN
    RETURN false;
  END IF;

  SELECT cs.value::DATE INTO v_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';

  -- Before the daily-todo rule start date, any practice counts
  IF v_start IS NULL OR p_day < v_start THEN
    RETURN COALESCE(p_has_practice, false);
  END IF;

  -- Past days on or after todo_streak_start MUST use stored daily_todo_log.
  -- We do NOT infer historical assignments from current state for unlogged past days.
  IF p_day < public.today_ist() THEN
    SELECT l.tasks_total, l.all_done INTO v_log
      FROM public.daily_todo_log l
     WHERE l.student_id = p_student AND l.day = p_day;
    IF FOUND THEN
      IF v_log.tasks_total = 0 THEN
        RETURN COALESCE(p_has_practice, false);
      END IF;
      RETURN COALESCE(v_log.all_done, false);
    END IF;

    -- Unlogged past day on or after todo_streak_start: return false rather than
    -- inferring historical assignments from current task/profile state.
    RETURN false;
  END IF;

  -- For today: evaluate current required tasks
  SELECT count(*)::INTEGER,
         (count(*) FILTER (WHERE x.done))::INTEGER
    INTO v_total, v_done
    FROM public._todo_status_on_internal(p_student, p_day) x;

  -- If student has active required tasks, ALL must be completed
  IF v_total > 0 THEN
    RETURN (v_done = v_total);
  END IF;

  -- If no tasks are assigned, fall back to whether student practiced that day
  RETURN COALESCE(p_has_practice, false);
END;
$$;

ALTER FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) TO service_role;

-- ------------------------------------------------------------------------------
-- PART 4: UPDATE streak_calc (Internal Helper)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_calc(p_student UUID)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
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
  IF p_student IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  -- Collect all distinct dates with valid practice in IST
  SELECT array_agg(DISTINCT dt ORDER BY dt ASC) INTO v_days FROM (
    SELECT (r.entry_date) AS dt
      FROM public.results r
     WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
    UNION
    SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS dt
      FROM public.activity_results a
     WHERE a.student_id = p_student AND COALESCE(a.total, 0) > 0
  ) q;

  IF v_days IS NULL OR array_length(v_days, 1) IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  SELECT min(x) INTO v_start FROM unnest(v_days) AS x;

  -- Ascending day-by-day evaluation
  FOR v_d IN SELECT g::DATE FROM generate_series(v_start, v_today, interval '1 day') AS g LOOP
    v_counts := public.streak_day_counts(p_student, v_d, (v_d = ANY (v_days)));

    IF v_d = v_today THEN
      v_today_counts := v_counts;
    END IF;

    IF v_counts THEN
      v_streak := v_streak + 1;
      IF v_streak > v_best THEN
        v_best := v_streak;
      END IF;
      -- Earn 1 shield every 7 completed days, capped at 1
      IF v_streak % 7 = 0 THEN
        v_shields := 1;
      END IF;
    ELSIF v_d < v_today THEN
      -- Incomplete or missed past day
      IF v_shields > 0 THEN
        v_shields := v_shields - 1;
      ELSE
        v_streak := 0;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_streak, v_best, v_shields, v_today_counts;
END;
$$;

ALTER FUNCTION public.streak_calc(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_calc(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.streak_calc(UUID) TO service_role;

-- ------------------------------------------------------------------------------
-- PART 5: AUTHORIZED PUBLIC WRAPPER streak_for (Consolidated Delegation)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_for(p_student UUID DEFAULT NULL)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller UUID;
  v_target UUID;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required to access streak data'
      USING ERRCODE = '42501';
  END IF;

  IF p_student IS NULL THEN
    v_target := v_caller;
  ELSE
    v_target := p_student;
  END IF;

  -- Authorization check: Caller must be admin, or the student themselves, or an assigned teacher with permissions
  IF NOT (
    v_caller = v_target
    OR public.is_admin()
    OR (
      public.is_teacher(v_caller)
      AND public.is_teacher_assigned_to_student(v_caller, v_target)
      AND (
        public.has_teacher_permission(v_caller, 'view_students')
        OR public.has_teacher_permission(v_caller, 'generate_reports')
      )
    )
  ) THEN
    RAISE EXCEPTION 'Access denied to streak data for student %', v_target
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT sc.current_streak, sc.best_streak, sc.shields, sc.active_today
    FROM public.streak_calc(v_target) sc;
END;
$$;

ALTER FUNCTION public.streak_for(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_for(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.streak_for(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- POST-APPLY VERIFICATION (RUNS AUTOMATICALLY BEFORE COMMIT)
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  v_streak_for_anon BOOLEAN;
  v_streak_for_auth BOOLEAN;
  v_streak_for_srv BOOLEAN;
  v_calc_anon BOOLEAN;
  v_calc_auth BOOLEAN;
  v_counts_anon BOOLEAN;
  v_counts_auth BOOLEAN;
  v_todo_anon BOOLEAN;
  v_todo_auth BOOLEAN;
  v_fin_anon BOOLEAN;
  v_fin_auth BOOLEAN;
  v_fin_srv BOOLEAN;
  v_overload_count INTEGER;
BEGIN
  -- 1. Exact function signature existence:
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'streak_for' AND p.pronargs = 1
  ) THEN RAISE EXCEPTION 'Verification failed: streak_for(uuid) not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'streak_calc' AND p.pronargs = 1
  ) THEN RAISE EXCEPTION 'Verification failed: streak_calc(uuid) not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'streak_day_counts' AND p.pronargs = 3
  ) THEN RAISE EXCEPTION 'Verification failed: streak_day_counts(uuid,date,boolean) not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_todo_status_on_internal' AND p.pronargs = 2
  ) THEN RAISE EXCEPTION 'Verification failed: _todo_status_on_internal(uuid,date) not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'todo_finalize' AND p.pronargs = 0
  ) THEN RAISE EXCEPTION 'Verification failed: zero-argument todo_finalize() not found.'; END IF;

  -- Verify NO conflicting overloaded todo_finalize(integer) exists:
  SELECT count(*) INTO v_overload_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'todo_finalize' AND p.pronargs > 0;
  IF v_overload_count > 0 THEN
    RAISE EXCEPTION 'Verification failed: overloaded todo_finalize with arguments still exists in pg_proc.';
  END IF;

  -- 2. Internal helper execution privileges (must be denied to anon and authenticated):
  SELECT has_function_privilege('anon', 'public.streak_calc(uuid)', 'EXECUTE') INTO v_calc_anon;
  SELECT has_function_privilege('authenticated', 'public.streak_calc(uuid)', 'EXECUTE') INTO v_calc_auth;
  IF v_calc_anon OR v_calc_auth THEN
    RAISE EXCEPTION 'Verification failed: streak_calc is still executable by anon or authenticated.';
  END IF;

  SELECT has_function_privilege('anon', 'public.streak_day_counts(uuid,date,boolean)', 'EXECUTE') INTO v_counts_anon;
  SELECT has_function_privilege('authenticated', 'public.streak_day_counts(uuid,date,boolean)', 'EXECUTE') INTO v_counts_auth;
  IF v_counts_anon OR v_counts_auth THEN
    RAISE EXCEPTION 'Verification failed: streak_day_counts is still executable by anon or authenticated.';
  END IF;

  SELECT has_function_privilege('anon', 'public._todo_status_on_internal(uuid,date)', 'EXECUTE') INTO v_todo_anon;
  SELECT has_function_privilege('authenticated', 'public._todo_status_on_internal(uuid,date)', 'EXECUTE') INTO v_todo_auth;
  IF v_todo_anon OR v_todo_auth THEN
    RAISE EXCEPTION 'Verification failed: _todo_status_on_internal is still executable by anon or authenticated.';
  END IF;

  SELECT has_function_privilege('anon', 'public.todo_finalize()', 'EXECUTE') INTO v_fin_anon;
  SELECT has_function_privilege('authenticated', 'public.todo_finalize()', 'EXECUTE') INTO v_fin_auth;
  SELECT has_function_privilege('service_role', 'public.todo_finalize()', 'EXECUTE') INTO v_fin_srv;
  IF v_fin_anon OR v_fin_auth OR NOT v_fin_srv THEN
    RAISE EXCEPTION 'Verification failed: todo_finalize privileges invalid (must be service_role only).';
  END IF;

  -- 3. Public wrapper privileges: streak_for must be executable by authenticated and service_role, denied to anon:
  SELECT has_function_privilege('anon', 'public.streak_for(uuid)', 'EXECUTE') INTO v_streak_for_anon;
  SELECT has_function_privilege('authenticated', 'public.streak_for(uuid)', 'EXECUTE') INTO v_streak_for_auth;
  SELECT has_function_privilege('service_role', 'public.streak_for(uuid)', 'EXECUTE') INTO v_streak_for_srv;
  IF v_streak_for_anon OR NOT v_streak_for_auth OR NOT v_streak_for_srv THEN
    RAISE EXCEPTION 'Verification failed: streak_for wrapper privileges invalid.';
  END IF;

  -- 4. Real-time plan sync triggers & helper function existence and privileges:
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log' AND p.pronargs = 2
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log(uuid,date) not found.'; END IF;

  IF has_function_privilege('anon', 'public._sync_daily_todo_log(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log must not be executable by anon or authenticated.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_result'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_result trigger function not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_activity_result'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_activity_result trigger function not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_session'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_session trigger function not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_profile'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_profile trigger function not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_recipients'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_recipients trigger function not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_sync_daily_todo_log_on_task'
  ) THEN RAISE EXCEPTION 'Verification failed: _sync_daily_todo_log_on_task trigger function not found.'; END IF;

  IF has_function_privilege('anon', 'public._sync_daily_todo_log_on_result()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_result()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sync_daily_todo_log_on_activity_result()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_activity_result()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sync_daily_todo_log_on_session()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_session()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sync_daily_todo_log_on_profile()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_profile()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sync_daily_todo_log_on_recipients()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_recipients()', 'EXECUTE')
     OR has_function_privilege('anon', 'public._sync_daily_todo_log_on_task()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._sync_daily_todo_log_on_task()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification failed: sync trigger functions must not be executable by anon or authenticated.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_results'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_results trigger not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_activity_results'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_activity_results trigger not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_drill_sessions'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_drill_sessions trigger not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_profiles'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_profiles trigger not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_recipients'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_recipients trigger not found.'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_daily_todo_log_tasks'
  ) THEN RAISE EXCEPTION 'Verification failed: trg_sync_daily_todo_log_tasks trigger not found.'; END IF;

  -- 5. Historical plan snapshots & evaluation functions:
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_todo_plan_snapshot' AND p.pronargs = 2
  ) THEN RAISE EXCEPTION 'Verification failed: _todo_plan_snapshot(uuid,date) not found.'; END IF;

  IF has_function_privilege('anon', 'public._todo_plan_snapshot(uuid,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._todo_plan_snapshot(uuid,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification failed: _todo_plan_snapshot must not be executable by anon or authenticated.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_todo_evaluate_plan' AND p.pronargs = 3
  ) THEN RAISE EXCEPTION 'Verification failed: _todo_evaluate_plan(uuid,date,jsonb) not found.'; END IF;

  IF has_function_privilege('anon', 'public._todo_evaluate_plan(uuid,date,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._todo_evaluate_plan(uuid,date,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Verification failed: _todo_evaluate_plan must not be executable by anon or authenticated.';
  END IF;
END $$;

COMMIT;

-- ==============================================================================
-- EXECUTABLE ROLLBACK SCRIPT (IF RESTORATION IS REQUIRED)
-- ==============================================================================
/*
BEGIN;
SET search_path = public, pg_temp;

-- 1. Drop real-time plan sync triggers and functions:
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_results ON public.results;
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_activity_results ON public.activity_results;
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_drill_sessions ON public.drill_sessions;
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_profiles ON public.profiles;
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_recipients ON public.daily_task_recipients;
DROP TRIGGER IF EXISTS trg_sync_daily_todo_log_tasks ON public.daily_tasks;
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_result();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_activity_result();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_session();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_profile();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_recipients();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log_on_task();
DROP FUNCTION IF EXISTS public._sync_daily_todo_log(UUID, DATE);
DROP FUNCTION IF EXISTS public._todo_evaluate_plan(UUID, DATE, JSONB);
DROP FUNCTION IF EXISTS public._todo_plan_snapshot(UUID, DATE);

-- 2. Ensure any parameterized finalizer overload is cleanly removed:
DROP FUNCTION IF EXISTS public.todo_finalize(INTEGER);

-- 3. Restore original zero-argument todo_finalize() body (60-day loop calling todo_status_on):
CREATE OR REPLACE FUNCTION public.todo_finalize()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start date;
  v_yesterday date := public.today_ist() - 1;
  v_n integer := 0;
  v_ins integer;
  s record;
  v_first date;
  v_d date;
BEGIN
  SELECT cs.value::date INTO v_start
    FROM public.competition_settings cs WHERE cs.key = 'todo_streak_start';
  IF v_start IS NULL THEN RETURN 0; END IF;

  FOR s IN SELECT p.id FROM public.profiles p WHERE p.role = 'student' AND p.active LOOP
    SELECT GREATEST(v_start,
             COALESCE((SELECT max(l.day) + 1 FROM public.daily_todo_log l WHERE l.student_id = s.id), v_start))
      INTO v_first;
    IF v_first < v_yesterday - 59 THEN v_first := v_yesterday - 59; END IF;

    FOR v_d IN SELECT g::date FROM generate_series(v_first, v_yesterday, interval '1 day') AS g LOOP
      INSERT INTO public.daily_todo_log (student_id, day, tasks_total, tasks_done, all_done)
      SELECT s.id, v_d, count(*)::integer, (count(*) FILTER (WHERE x.done))::integer,
             (count(*) > 0 AND count(*) = count(*) FILTER (WHERE x.done))
        FROM public.todo_status_on(s.id, v_d) x
      ON CONFLICT (student_id, day) DO NOTHING;
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_n := v_n + v_ins;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$function$;

ALTER FUNCTION public.todo_finalize() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.todo_finalize() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.todo_finalize() TO authenticated, service_role;

-- 3. Restore previous results-only streak_for definition (0 shields):
CREATE OR REPLACE FUNCTION public.streak_for(p_student UUID DEFAULT NULL)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_today DATE := public.today_ist();
  v_active_today BOOLEAN := false;
  v_cur INTEGER := 0;
  v_best INTEGER := 0;
  v_run INTEGER := 0;
  v_prev DATE := NULL;
  rec RECORD;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND NOT (
       public.is_teacher(auth.uid())
       AND (
         public.has_teacher_permission(auth.uid(), 'view_students')
         OR public.has_teacher_permission(auth.uid(), 'generate_reports')
       )
       AND public.is_teacher_assigned_to_student(auth.uid(), v_target)
     ) THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own streak.' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.results
    WHERE student_id = v_target AND entry_date = v_today
  ) INTO v_active_today;

  FOR rec IN
    SELECT DISTINCT entry_date
    FROM public.results
    WHERE student_id = v_target AND entry_date <= v_today
    ORDER BY entry_date DESC
  LOOP
    IF v_prev IS NULL THEN
      IF rec.entry_date = v_today OR rec.entry_date = (v_today - 1) THEN
        v_cur := 1;
        v_run := 1;
        v_prev := rec.entry_date;
      ELSE
        v_cur := 0;
        v_run := 1;
        v_prev := rec.entry_date;
      END IF;
    ELSE
      IF rec.entry_date = (v_prev - 1) THEN
        v_run := v_run + 1;
        IF v_cur > 0 AND v_cur = (v_run - 1) THEN
          v_cur := v_run;
        END IF;
        v_prev := rec.entry_date;
      ELSE
        IF v_run > v_best THEN
          v_best := v_run;
        END IF;
        v_run := 1;
        v_prev := rec.entry_date;
      END IF;
    END IF;
  END LOOP;

  IF v_run > v_best THEN v_best := v_run; END IF;
  IF v_cur > v_best THEN v_best := v_cur; END IF;

  RETURN QUERY SELECT v_cur, v_best, 0::INTEGER, v_active_today;
END;
$$;

ALTER FUNCTION public.streak_for(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_for(UUID) TO authenticated, service_role;

-- 4. Restore original streak_calc:
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
  SELECT array_agg(DISTINCT dt) INTO v_days FROM (
    SELECT (r.created_at AT TIME ZONE 'Asia/Kolkata')::DATE AS dt
      FROM public.results r
     WHERE r.student_id = p_student AND COALESCE(r.total, 0) > 0
    UNION
    SELECT (a.created_at AT TIME ZONE 'Asia/Kolkata')::DATE
      FROM public.activity_results a
     WHERE a.student_id = p_student AND a.total > 0
  ) q;

  IF v_days IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0, false;
    RETURN;
  END IF;

  SELECT min(x) INTO v_start FROM unnest(v_days) AS x;

  FOR v_d IN SELECT g::DATE FROM generate_series(v_start, v_today, interval '1 day') AS g LOOP
    v_counts := public.streak_day_counts(p_student, v_d, (v_d = ANY (v_days)));
    IF v_d = v_today THEN v_today_counts := v_counts; END IF;
    IF v_counts THEN
      v_streak := v_streak + 1;
      IF v_streak > v_best THEN v_best := v_streak; END IF;
      IF v_streak % 7 = 0 THEN v_shields := 1; END IF;
    ELSIF v_d < v_today THEN
      IF v_shields > 0 THEN
        v_shields := v_shields - 1;
      ELSE
        v_streak := 0;
      END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_streak, v_best, v_shields, v_today_counts;
END;
$$;

ALTER FUNCTION public.streak_calc(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_calc(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_calc(UUID) TO authenticated, service_role;

-- 5. Restore original streak_day_counts:
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

  IF v_start IS NULL OR p_day < v_start THEN
    RETURN p_has_practice;
  END IF;

  IF p_day < public.today_ist() THEN
    SELECT l.tasks_total, l.all_done INTO v_log
      FROM public.daily_todo_log l WHERE l.student_id = p_student AND l.day = p_day;
    IF FOUND THEN
      IF v_log.tasks_total = 0 THEN RETURN p_has_practice; END IF;
      RETURN v_log.all_done;
    END IF;
  END IF;

  SELECT count(*)::INTEGER, (count(*) FILTER (WHERE s.done))::INTEGER
    INTO v_total, v_done
    FROM public._todo_status_on_internal(p_student, p_day) s;
  IF v_total = 0 THEN RETURN p_has_practice; END IF;
  RETURN v_done = v_total;
END;
$$;

ALTER FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) TO authenticated, service_role;

-- 6. Restore original _todo_status_on_internal (without created_at boundary):
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
  IF p_student IS NULL THEN RETURN; END IF;

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
                  (NOT v_phase19_active)
                  OR
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
                  (
                    COALESCE(r.source, '') NOT IN ('site', 'online')
                  )
                  OR
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
                  ((a.settings ->> 'todo_task_id')::uuid = t.id)
                  OR
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

ALTER FUNCTION public._todo_status_on_internal(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._todo_status_on_internal(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._todo_status_on_internal(UUID, DATE) TO authenticated, service_role;

COMMIT;
*/
