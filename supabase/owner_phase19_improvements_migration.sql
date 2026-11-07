-- ==============================================================================
-- Trendz Tracker — Owner Phase 19 Migration: Student & Admin Improvements
-- File: supabase/owner_phase19_improvements_migration.sql
--
-- EXECUTION INSTRUCTIONS:
-- 1. Review this script carefully.
-- 2. Run in Supabase SQL Editor on target project (e.g. staging or production).
-- 3. Execution order:
--    - Part 1: Schema additions (daily_tasks.duration_seconds column)
--    - Part 2: RLS policy on student_rounds for assigned teachers
--    - Part 3: Atomic daily task management RPC update (save_daily_task_atomic)
--    - Part 4: Flash Anzan Live RPCs & Server-Authoritative Assigned Practice (flash_start, flash_submit)
--    - Part 5: Durable rollout boundaries table & seed (rollout_boundaries)
--    - Part 6: todo_status_on RPC update (authoritative Basics & Flash task credit)
--    - Part 7: Verification queries
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- Part 1: Add duration_seconds to public.daily_tasks
-- ------------------------------------------------------------------------------
ALTER TABLE public.daily_tasks
  ADD COLUMN IF NOT EXISTS duration_seconds INT NULL
  CHECK (duration_seconds IS NULL OR (duration_seconds >= 5 AND duration_seconds <= 3600));

COMMENT ON COLUMN public.daily_tasks.duration_seconds IS
  'Optional fixed practice duration in seconds (5 to 3600). When set, online practice sessions launched for this daily task freeze at this exact duration.';

-- ------------------------------------------------------------------------------
-- Part 2: Allow assigned teachers to SELECT student_rounds for assigned students
-- Enforces: active teacher, established permissions (view_students, review_scores, or generate_reports), and assignment
-- ------------------------------------------------------------------------------
DROP POLICY IF EXISTS "student_rounds_teacher_select" ON public.student_rounds;
CREATE POLICY "student_rounds_teacher_select"
  ON public.student_rounds
  FOR SELECT
  TO authenticated
  USING (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'review_scores')
      OR public.has_teacher_permission(auth.uid(), 'generate_reports')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  );

-- ------------------------------------------------------------------------------
-- Part 3: Update public.save_daily_task_atomic to accept & persist duration_seconds
-- Preserves: Active admin / service-role / authorized teacher with manage_tasks check,
-- teacher recipient assignment validation, atomicity, and return signature.
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_daily_task_atomic(
  p_task_id UUID,
  p_task JSONB,
  p_recipients UUID[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_admin BOOLEAN := false;
  v_title TEXT;
  v_section TEXT;
  v_cat_id UUID;
  v_level TEXT;
  v_active BOOLEAN;
  v_sort_order INT;
  v_required_count INT;
  v_activity_key TEXT;
  v_flash_digits SMALLINT;
  v_flash_count INT;
  v_flash_speed_ms INT;
  v_flash_mode TEXT;
  v_duration_seconds INT;
  v_task_id UUID := p_task_id;
  v_rec_count INT := 0;
  v_deduped_recipients UUID[];
  v_invalid_count INT;
BEGIN
  -- 1. Authorization check
  IF v_caller IS NULL THEN
    IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
      v_is_admin := true;
    ELSE
      RAISE EXCEPTION 'Unauthorized: Authentication required.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_is_admin := public.is_admin();
    IF NOT v_is_admin THEN
      IF NOT (
        public.is_teacher(v_caller)
        AND public.has_teacher_permission(v_caller, 'manage_tasks')
      ) THEN
        RAISE EXCEPTION 'Forbidden: You do not have permission to manage daily tasks.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 2. Input extraction and validation
  v_title := NULLIF(TRIM(p_task->>'title'), '');
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'Daily task title is required.'
      USING ERRCODE = '22000';
  END IF;

  v_section := LOWER(TRIM(COALESCE(p_task->>'section', '')));
  IF v_section NOT IN ('basics', 'elements', 'flash', 'round', 'memoriad') THEN
    RAISE EXCEPTION 'Invalid daily task section: %', v_section
      USING ERRCODE = '22000';
  END IF;

  v_cat_id := NULLIF(TRIM(COALESCE(p_task->>'category_id', '')), '')::UUID;
  v_level := NULLIF(TRIM(COALESCE(p_task->>'level', '')), '');
  v_active := COALESCE((p_task->>'active')::BOOLEAN, true);
  v_required_count := COALESCE((p_task->>'required_count')::INT, 1);
  v_activity_key := NULLIF(TRIM(COALESCE(p_task->>'activity_key', '')), '');

  IF v_required_count < 1 OR v_required_count > 100 THEN
    RAISE EXCEPTION 'required_count must be between 1 and 100.'
      USING ERRCODE = '22000';
  END IF;

  -- Section-specific field normalization
  IF v_section = 'flash' THEN
    v_flash_digits := (p_task->>'flash_digits')::SMALLINT;
    v_flash_count := (p_task->>'flash_count')::INT;
    v_flash_speed_ms := (p_task->>'flash_speed_ms')::INT;
    v_flash_mode := NULLIF(TRIM(COALESCE(p_task->>'flash_mode', '')), '');
    v_cat_id := NULL;
    v_activity_key := NULL;
    v_duration_seconds := NULL;
  ELSE
    v_flash_digits := NULL;
    v_flash_count := NULL;
    v_flash_speed_ms := NULL;
    v_flash_mode := NULL;

    IF p_task ? 'duration_seconds' AND (p_task->>'duration_seconds') IS NOT NULL AND TRIM(p_task->>'duration_seconds') <> '' THEN
      v_duration_seconds := (p_task->>'duration_seconds')::INT;
      IF v_duration_seconds < 5 OR v_duration_seconds > 3600 THEN
        RAISE EXCEPTION 'duration_seconds must be between 5 and 3600 seconds.'
          USING ERRCODE = '22000';
      END IF;
    ELSE
      v_duration_seconds := NULL;
    END IF;
  END IF;

  IF v_section = 'basics' THEN
    v_activity_key := NULL;
  ELSIF v_section IN ('elements', 'memoriad') THEN
    v_cat_id := NULL;
  END IF;

  -- Recipient deduplication
  IF p_recipients IS NOT NULL THEN
    SELECT array_agg(DISTINCT r) INTO v_deduped_recipients
    FROM unnest(p_recipients) AS r
    WHERE r IS NOT NULL;
  ELSE
    v_deduped_recipients := ARRAY[]::UUID[];
  END IF;

  -- Teacher recipient assignment verification
  IF NOT v_is_admin AND cardinality(v_deduped_recipients) > 0 THEN
    SELECT count(*)::INT INTO v_invalid_count
    FROM unnest(v_deduped_recipients) AS sid
    WHERE NOT public.is_teacher_assigned_to_student(v_caller, sid);

    IF v_invalid_count > 0 THEN
      RAISE EXCEPTION 'Forbidden: You may only assign daily tasks to students assigned to you.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 3. Upsert daily task
  IF v_task_id IS NOT NULL THEN
    IF NOT v_is_admin THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.daily_tasks
        WHERE id = v_task_id AND (created_by = v_caller OR v_is_admin)
      ) THEN
        RAISE EXCEPTION 'Forbidden: You may only update daily tasks you created.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    UPDATE public.daily_tasks
    SET title = v_title,
        section = v_section,
        category_id = v_cat_id,
        level = v_level,
        active = v_active,
        required_count = v_required_count,
        activity_key = v_activity_key,
        flash_digits = v_flash_digits,
        flash_count = v_flash_count,
        flash_speed_ms = v_flash_speed_ms,
        flash_mode = v_flash_mode,
        duration_seconds = v_duration_seconds,
        sort_order = COALESCE((p_task->>'sort_order')::INT, sort_order),
        target_scope = CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    WHERE id = v_task_id;
  ELSE
    v_task_id := gen_random_uuid();
    v_sort_order := COALESCE(
      (p_task->>'sort_order')::INT,
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.daily_tasks)
    );
    INSERT INTO public.daily_tasks (
      id, title, section, category_id, level, activity_key,
      flash_digits, flash_count, flash_speed_ms, flash_mode, required_count,
      duration_seconds, sort_order, active, created_by, target_scope
    ) VALUES (
      v_task_id, v_title, v_section, v_cat_id, v_level, v_activity_key,
      v_flash_digits, v_flash_count, v_flash_speed_ms, v_flash_mode, v_required_count,
      v_duration_seconds, v_sort_order, v_active, v_caller,
      CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    );
  END IF;

  -- Sync recipients atomically
  IF NOT v_is_admin OR p_recipients IS NOT NULL THEN
    DELETE FROM public.daily_task_recipients WHERE task_id = v_task_id;
    IF cardinality(v_deduped_recipients) > 0 THEN
      INSERT INTO public.daily_task_recipients (task_id, student_id)
      SELECT v_task_id, sid FROM unnest(v_deduped_recipients) AS sid;
      v_rec_count := cardinality(v_deduped_recipients);
    END IF;
  ELSE
    SELECT count(*)::INT INTO v_rec_count
    FROM public.daily_task_recipients
    WHERE task_id = v_task_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_task_id,
    'task_id', v_task_id,
    'recipient_count', v_rec_count,
    'recipients_count', v_rec_count,
    'duration_seconds', v_duration_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 4: Flash Anzan Live Function Definitions & Server-Authoritative Assigned Practice
-- Baseline live RPCs upgraded to validate and freeze assigned daily tasks while
-- strictly preserving signature, caller authorization, row locking, and free practice.
-- NOTE: public.flash_generate_question is already live and deployed in Mumbai production
-- (identical to schema definition lines 655-703) and must NOT be overwritten.
-- It is intentionally omitted here to prevent touching live question generation.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.flash_start(p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_digits integer;
  v_count integer;
  v_speed integer;
  v_mode text;
  v_nums integer[];
  v_sum integer;
  v_min numeric;
  v_settings jsonb;
  v_id uuid;
  v_profile public.profiles;
  v_todo_task_id uuid;
  v_task public.daily_tasks;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR NOT v_profile.active THEN
    RAISE EXCEPTION 'This account is not active.';
  END IF;

  -- 1. Check for optional todo_task_id in p_settings
  IF p_settings ? 'todo_task_id' AND p_settings ->> 'todo_task_id' IS NOT NULL AND TRIM(p_settings ->> 'todo_task_id') <> '' THEN
    BEGIN
      v_todo_task_id := (p_settings ->> 'todo_task_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid daily task ID format.';
    END;

    -- Validate assigned task
    SELECT * INTO v_task FROM public.daily_tasks WHERE id = v_todo_task_id;
    IF NOT FOUND OR NOT v_task.active THEN
      RAISE EXCEPTION 'Assigned daily task not found or is no longer active.';
    END IF;
    IF v_task.section <> 'flash' THEN
      RAISE EXCEPTION 'Daily task section mismatch (expected %, requested flash).', v_task.section;
    END IF;

    -- Check recipient eligibility if targeted
    IF v_task.target_scope = 'targeted' THEN
      IF NOT EXISTS (SELECT 1 FROM public.daily_task_recipients WHERE task_id = v_task.id AND student_id = auth.uid()) THEN
        RAISE EXCEPTION 'You are not assigned to this daily task.';
      END IF;
    END IF;

    -- Check audience level eligibility
    IF v_task.level IS NOT NULL AND v_task.level <> '' THEN
      IF v_profile.level IS NULL OR v_profile.level <> v_task.level THEN
        RAISE EXCEPTION 'Daily task level mismatch.';
      END IF;
    END IF;

    -- Freeze assigned settings directly from the task (ignoring any client spoofing)
    v_digits := COALESCE(v_task.flash_digits, (p_settings ->> 'digits')::integer, 2);
    v_count  := COALESCE(v_task.flash_count, (p_settings ->> 'count')::integer, 5);
    v_speed  := COALESCE(v_task.flash_speed_ms, (p_settings ->> 'speed_ms')::integer, 1000);
    v_mode   := COALESCE(v_task.flash_mode, p_settings ->> 'mode', 'add');
  ELSE
    -- Free practice: parse from p_settings
    BEGIN
      v_digits := (p_settings ->> 'digits')::integer;
      v_count := (p_settings ->> 'count')::integer;
      v_speed := (p_settings ->> 'speed_ms')::integer;
      v_mode := COALESCE(p_settings ->> 'mode', 'add');
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'The settings are not valid.';
    END;
  END IF;

  IF v_digits IS NULL OR v_count IS NULL OR v_speed IS NULL
     OR v_digits < 1 OR v_digits > 5
     OR v_count < 2 OR v_count > 1000
     OR v_speed < 200 OR v_speed > 5000
     OR v_mode NOT IN ('add', 'add_sub') THEN
    RAISE EXCEPTION 'The settings are not valid.';
  END IF;

  IF (SELECT count(*) FROM public.drill_sessions
       WHERE student_id = auth.uid() AND started_at > now() - interval '1 hour') >= 300 THEN
    RAISE EXCEPTION 'Too many tries started. Please wait a little.';
  END IF;

  v_nums := public.flash_generate_question(v_digits, v_count, v_mode);
  SELECT sum(x)::integer INTO v_sum FROM unnest(v_nums) AS x;

  -- Presentation minimum duration:
  -- Assigned practice accounts for preparation countdown (3-2-1 at 650ms + 150ms blank = 2.1s)
  -- and runner presentation schedule (count * (speed + 80ms)).
  -- Free practice preserves established live definition: (count * speed) / 1000.0.
  IF v_todo_task_id IS NOT NULL THEN
    v_min := 2.1 + (v_count * (v_speed + 80) / 1000.0);
  ELSE
    v_min := (v_count * v_speed) / 1000.0;
  END IF;

  v_settings := jsonb_build_object(
    'digits', v_digits,
    'count', v_count,
    'speed_ms', v_speed,
    'mode', v_mode,
    'is_todo', (v_todo_task_id IS NOT NULL),
    'todo_task_id', v_todo_task_id
  );

  INSERT INTO public.drill_sessions
    (student_id, activity_type, activity_name, settings, questions, expected, min_seconds, expires_at)
  VALUES
    (auth.uid(), 'flash_anzan', 'Flash anzan', v_settings,
     jsonb_build_array(to_jsonb(v_nums)), jsonb_build_array(v_sum), v_min,
     now() + (v_min + 1800) * interval '1 second')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('session_id', v_id, 'numbers', to_jsonb(v_nums), 'settings', v_settings);
END;
$$;

REVOKE ALL ON FUNCTION public.flash_start(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_start(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.flash_submit(p_session uuid, p_answer jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s public.drill_sessions;
  v_elapsed numeric;
  v_exp jsonb;
  v_ok boolean;
  v_res uuid;
  v_is_todo boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT * INTO s FROM public.drill_sessions
   WHERE id = p_session AND student_id = auth.uid() AND activity_type = 'flash_anzan'
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This try was not found.';
  END IF;
  IF s.status <> 'open' THEN
    RAISE EXCEPTION 'This try was already submitted.';
  END IF;
  IF now() > s.expires_at THEN
    RAISE EXCEPTION 'This try expired. Please start a new one.';
  END IF;

  v_is_todo := COALESCE((s.settings ->> 'is_todo')::boolean, (s.settings ->> 'todo_task_id') IS NOT NULL, false);
  v_elapsed := extract(epoch FROM (now() - s.started_at));

  -- Minimum presentation duration gate:
  -- For assigned practice, 100% of presentation duration must elapse.
  -- For free practice, preserve the existing 80% tolerance.
  IF v_is_todo THEN
    IF v_elapsed < s.min_seconds THEN
      RAISE EXCEPTION 'This was answered faster than the numbers were shown, so it was not saved.';
    END IF;
  ELSE
    IF v_elapsed < (s.min_seconds * 0.8) THEN
      RAISE EXCEPTION 'Submitted faster than the numbers could be shown.';
    END IF;
  END IF;

  v_exp := s.expected -> 0;
  v_ok := (p_answer IS NOT NULL AND jsonb_typeof(p_answer) = 'number' AND p_answer = v_exp);

  INSERT INTO public.activity_results
    (student_id, activity_type, activity_name, correct, total, time_seconds, settings)
  VALUES
    (s.student_id, s.activity_type, s.activity_name,
     CASE WHEN v_ok THEN 1 ELSE 0 END, 1,
     round(v_elapsed)::integer,
     s.settings || jsonb_build_object('session_id', s.id))
  RETURNING id INTO v_res;

  UPDATE public.drill_sessions
     SET status = 'submitted', submitted_at = now(), result_id = v_res
   WHERE id = s.id;

  RETURN jsonb_build_object(
    'correct', v_ok, 'expected', v_exp, 'given', p_answer, 'seconds', round(v_elapsed));
END;
$$;

REVOKE ALL ON FUNCTION public.flash_submit(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_submit(uuid, jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- Part 5: Durable rollout boundaries table & installation registration
-- Establishes a durable milestone boundary table and seeds the Phase 19 feature
-- in 'installed' state with activated_at = NULL.
-- IMPORTANT: Installation does NOT activate the authoritative task credit policy.
-- Existing production code running on live Mumbai continues to earn Daily To-do credit.
-- Activation is explicitly controlled via supabase/owner_phase19_activation.sql.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rollout_boundaries (
  feature TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'active')),
  activated_at TIMESTAMPTZ NULL
);

ALTER TABLE public.rollout_boundaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rollout_boundaries FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.rollout_boundaries TO service_role;

INSERT INTO public.rollout_boundaries (feature, status, activated_at)
VALUES ('phase19_authoritative_todo', 'installed', NULL)
ON CONFLICT (feature) DO NOTHING;

COMMENT ON TABLE public.rollout_boundaries IS
  'Records authoritative milestone timestamps when system-level behavioral transitions take effect.';

-- ------------------------------------------------------------------------------
-- Part 6: Update public.todo_status_on
-- Preserves EXACT Phase 18 parameter signature (p_student UUID, p_day DATE DEFAULT public.today_ist()),
-- parameter names, return columns, STABLE volatility, service-role detection with claims fallback,
-- target student validation, and caller authorization checks.
-- Implements backward-compatible pre-activation behavior and authoritative post-activation credit.
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
  v_phase19_active BOOLEAN := false;
  v_phase19_rollout TIMESTAMPTZ;
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

  -- 4. Rollout milestone boundary inspection:
  -- Deterministic behavior: if the boundary is missing, or status <> 'active', or activated_at IS NULL,
  -- enforcement is INACTIVE (v_phase19_active := false).
  -- In this unactivated state, existing production workflows and old-code submissions continue earning credit.
  -- Once activated via owner_phase19_activation.sql, v_phase19_rollout holds the fixed activated_at timestamp,
  -- enforcing session-linked credit for new online submissions while preserving legacy records before that boundary.
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

REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;

COMMIT;

-- ------------------------------------------------------------------------------
-- Part 7: Verification queries (Read-Only)
-- Run these queries after committing to verify successful deployment:
-- ------------------------------------------------------------------------------
-- 1. Check daily_tasks duration_seconds column:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'daily_tasks' AND column_name = 'duration_seconds';

-- 2. Check student_rounds teacher RLS policy:
-- SELECT policyname, cmd, roles, qual
-- FROM pg_policies
-- WHERE tablename = 'student_rounds' AND policyname = 'student_rounds_teacher_select';

-- 3. Check rollout boundary registration (installed state):
-- SELECT feature, status, activated_at
-- FROM public.rollout_boundaries
-- WHERE feature = 'phase19_authoritative_todo';

-- 4. Check function signatures & security definer status:
-- SELECT routine_name, routine_type, security_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('save_daily_task_atomic', 'flash_start', 'flash_submit', 'todo_status_on');
