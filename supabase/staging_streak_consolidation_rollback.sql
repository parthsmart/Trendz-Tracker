-- ==============================================================================
-- TRENDZ TRACKER - STAGING ROLLBACK SCRIPT: STREAK CONSOLIDATION
-- ==============================================================================
-- TARGET ENVIRONMENT: DEDICATED STAGING DATABASE ONLY (xhgzbbkvwojwfbexvcmh)
--
-- PURPOSE:
-- Restores the exact pre-patch schema, routines, ownerships, and ACLs on Staging
-- as captured in the authoritative read-only baseline:
--   - Drops all 6 sync triggers and trigger functions
--   - Drops _todo_evaluate_plan and _todo_plan_snapshot (neither existed previously)
--   - Removes todo_finalize() entirely (did not exist before migration on staging)
--   - Restores streak_day_counts(uuid, date, boolean) RETURNS boolean
--   - Restores streak_calc(uuid) and streak_for(uuid) with exact baseline bodies & ACLs
--   - Restores _todo_status_on_internal(uuid, date) with exact baseline body & ACL
--   - Safely restores daily_todo_log.finalized_at to NOT NULL DEFAULT now()
--   - Drops daily_todo_log.plan_snapshot column
-- ==============================================================================

-- Operator confirmation latch
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

-- -----------------------------------------------------------------------------
-- 1. DROP REAL-TIME PLAN SYNC TRIGGERS & TRIGGER FUNCTIONS
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 2. DROP NEW HELPER ROUTINES (Neither existed on Staging baseline)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public._todo_evaluate_plan(UUID, DATE, JSONB);
DROP FUNCTION IF EXISTS public._todo_plan_snapshot(UUID, DATE);

-- -----------------------------------------------------------------------------
-- 3. REMOVE TODO_FINALIZE ROUTINE COMPLETELY
-- On Staging baseline, public.todo_finalize did not exist before this patch.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.todo_finalize();
DROP FUNCTION IF EXISTS public.todo_finalize(INTEGER);

-- -----------------------------------------------------------------------------
-- 4. RESTORE _TODO_STATUS_ON_INTERNAL (Exact Staging Baseline Definition)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._todo_status_on_internal(p_student uuid, p_day date DEFAULT today_ist())
 RETURNS TABLE(task_id uuid, task_title text, task_section text, task_category_id uuid, task_activity_key text, required_count integer, done_count integer, done boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day DATE := COALESCE(p_day, public.today_ist());
  v_phase19_active BOOLEAN := false;
  v_phase19_rollout TIMESTAMPTZ;
BEGIN
  IF p_student IS NULL THEN
    RETURN;
  END IF;

  -- Rollout milestone boundary inspection:
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
$function$;

ALTER FUNCTION public._todo_status_on_internal(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._todo_status_on_internal(UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._todo_status_on_internal(UUID, DATE) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. RESTORE STREAK_DAY_COUNTS (Exact Staging Baseline: 3 args -> BOOLEAN)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.streak_day_counts(UUID, DATE);

CREATE OR REPLACE FUNCTION public.streak_day_counts(p_student uuid, p_day date, p_has_practice boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

ALTER FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_day_counts(UUID, DATE, BOOLEAN) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. RESTORE STREAK_CALC (Exact Staging Baseline Definition)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_calc(p_student uuid)
 RETURNS TABLE(current_streak integer, best_streak integer, shields integer, active_today boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

ALTER FUNCTION public.streak_calc(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_calc(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_calc(UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. RESTORE STREAK_FOR (Exact Staging Baseline Definition & Grants)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.streak_for(p_student uuid DEFAULT NULL::uuid)
 RETURNS TABLE(current_streak integer, best_streak integer, shields integer, active_today boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF v_run > v_best THEN
    v_best := v_run;
  END IF;
  IF v_cur > v_best THEN
    v_best := v_cur;
  END IF;

  RETURN QUERY SELECT v_cur, v_best, 0::INTEGER, v_active_today;
END;
$function$;

ALTER FUNCTION public.streak_for(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.streak_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_for(UUID) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8. RESTORE DAILY_TODO_LOG COLUMNS (Exact Staging Baseline State)
-- Drops plan_snapshot (did not exist before migration)
-- Safely restores finalized_at to NOT NULL DEFAULT now()
-- -----------------------------------------------------------------------------
ALTER TABLE public.daily_todo_log DROP COLUMN IF EXISTS plan_snapshot;

-- Restore finalized_at default now()
ALTER TABLE public.daily_todo_log ALTER COLUMN finalized_at SET DEFAULT now();

-- Backfill any NULL finalized_at timestamps before restoring NOT NULL constraint
UPDATE public.daily_todo_log SET finalized_at = now() WHERE finalized_at IS NULL;

ALTER TABLE public.daily_todo_log ALTER COLUMN finalized_at SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 9. POST-ROLLBACK READ-ONLY VERIFICATION
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_col_finalized_nullable TEXT;
  v_col_finalized_default TEXT;
  v_col_plan_snapshot_exists BOOLEAN;
BEGIN
  -- 9a. Verify todo_finalize does NOT exist
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'todo_finalize'
  ) THEN
    RAISE EXCEPTION 'Rollback verification failed: public.todo_finalize still exists.';
  END IF;

  -- 9b. Verify helper functions dropped
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('_todo_evaluate_plan', '_todo_plan_snapshot', '_sync_daily_todo_log')
  ) THEN
    RAISE EXCEPTION 'Rollback verification failed: patch helper functions still exist.';
  END IF;

  -- 9c. Verify streak_day_counts has exact 3-argument baseline signature returning boolean
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'streak_day_counts'
       AND pg_get_function_identity_arguments(p.oid) = 'p_student uuid, p_day date, p_has_practice boolean'
       AND pg_get_function_result(p.oid) = 'boolean'
  ) THEN
    RAISE EXCEPTION 'Rollback verification failed: public.streak_day_counts(uuid, date, boolean) not restored.';
  END IF;

  -- 9d. Verify daily_todo_log column states
  SELECT is_nullable, column_default INTO v_col_finalized_nullable, v_col_finalized_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'finalized_at';

  IF v_col_finalized_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'Rollback verification failed: daily_todo_log.finalized_at is not NOT NULL (got %)', v_col_finalized_nullable;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'daily_todo_log' AND column_name = 'plan_snapshot'
  ) INTO v_col_plan_snapshot_exists;

  IF v_col_plan_snapshot_exists THEN
    RAISE EXCEPTION 'Rollback verification failed: daily_todo_log.plan_snapshot was not dropped.';
  END IF;

  -- 9e. Verify no patch sync triggers remain
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname IN (
       'trg_sync_daily_todo_log_results',
       'trg_sync_daily_todo_log_activity_results',
       'trg_sync_daily_todo_log_drill_sessions',
       'trg_sync_daily_todo_log_profiles',
       'trg_sync_daily_todo_log_recipients',
       'trg_sync_daily_todo_log_tasks'
     )
  ) THEN
    RAISE EXCEPTION 'Rollback verification failed: one or more sync triggers still exist.';
  END IF;
END $$;

COMMIT;
