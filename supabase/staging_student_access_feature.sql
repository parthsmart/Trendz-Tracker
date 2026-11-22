-- ==============================================================================
-- TRENDZ TRACKER — STUDENT ACCESS FEATURE MIGRATION
-- File: supabase/staging_student_access_feature.sql
--
-- Features:
-- 1. Table: public.student_practice_access (Level Defaults & Student Overrides)
-- 2. RLS Policies: Admins manage all, Teachers manage assigned students, Students read own
-- 3. Functions:
--    - get_student_effective_access(p_student_id UUID)
--    - get_level_access_defaults(p_level TEXT)
--    - admin_save_level_access(p_level TEXT, p_settings JSONB)
--    - save_student_access_override(p_student_id UUID, p_settings JSONB)
--    - reset_student_access_override(p_student_id UUID)
--    - teacher_bulk_apply_level_access(p_level TEXT, p_settings JSONB)
--    - get_teacher_level_student_count(p_level TEXT)
-- ==============================================================================

-- 1. Table: student_practice_access
CREATE TABLE IF NOT EXISTS public.student_practice_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('level', 'student')),
  level TEXT NULL,
  student_id UUID NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT chk_student_practice_access_scope CHECK (
    (scope = 'level' AND level IS NOT NULL AND student_id IS NULL) OR
    (scope = 'student' AND student_id IS NOT NULL)
  )
);

-- Unique index for Level Defaults (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_practice_access_level_norm
  ON public.student_practice_access (lower(trim(level)))
  WHERE scope = 'level';

-- Unique index for Student Overrides
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_practice_access_student_uniq
  ON public.student_practice_access (student_id)
  WHERE scope = 'student';

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_student_practice_access_scope ON public.student_practice_access(scope);
CREATE INDEX IF NOT EXISTS idx_student_practice_access_student_id ON public.student_practice_access(student_id);

-- 2. Enable Row Level Security
ALTER TABLE public.student_practice_access ENABLE ROW LEVEL SECURITY;

-- Remove direct writes to student_practice_access for signed-in clients
-- All mutations must go through the authorized save, reset, and bulk functions.
DROP POLICY IF EXISTS "student_practice_access_admin_all" ON public.student_practice_access;
DROP POLICY IF EXISTS "student_practice_access_teacher_write" ON public.student_practice_access;

-- Policy: Admin read access
DROP POLICY IF EXISTS "student_practice_access_admin_select" ON public.student_practice_access;
CREATE POLICY "student_practice_access_admin_select"
  ON public.student_practice_access
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- Policy: Teacher read access (levels + assigned students)
DROP POLICY IF EXISTS "student_practice_access_teacher_select" ON public.student_practice_access;
CREATE POLICY "student_practice_access_teacher_select"
  ON public.student_practice_access
  FOR SELECT
  TO authenticated
  USING (
    public.is_teacher(auth.uid()) AND (
      scope = 'level' OR (
        scope = 'student' AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
      )
    )
  );

-- Policy: Student read access for own override or current level default
DROP POLICY IF EXISTS "student_practice_access_student_select" ON public.student_practice_access;
CREATE POLICY "student_practice_access_student_select"
  ON public.student_practice_access
  FOR SELECT
  TO authenticated
  USING (
    (scope = 'student' AND student_id = auth.uid()) OR
    (scope = 'level' AND lower(trim(level)) = lower(trim(COALESCE(
      (SELECT p.level FROM public.profiles p WHERE p.id = auth.uid()),
      ''
    ))))
  );

-- 3. Functions

-- Function: get_student_effective_access
-- Computes the effective access rule for a student with provenance information.
-- Protected: Restricts access to the student themselves, an authorized assigned teacher, an admin, or trusted server.
CREATE OR REPLACE FUNCTION public.get_student_effective_access(p_student_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(auth.role(), ''),
    NULLIF(current_setting('role', true), ''),
    ''
  );
  v_is_service_role BOOLEAN := (v_role = 'service_role');
  v_student_level TEXT;
  v_override_record RECORD;
  v_level_record RECORD;
  v_is_eligible BOOLEAN := false;
BEGIN
  -- Caller authorization check:
  -- Allowed:
  -- 1. Explicitly trusted server role: v_is_service_role
  -- 2. Student themselves: v_caller = p_student_id
  -- 3. Admin: public.is_admin()
  -- 4. Authorized assigned teacher: public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, p_student_id) AND public.has_teacher_permission(v_caller, 'manage_tasks')
  IF v_is_service_role THEN
    NULL;
  ELSIF v_caller IS NULL THEN
    RAISE EXCEPTION 'Access denied: Missing caller identification.'
      USING ERRCODE = '42501';
  ELSIF v_caller = p_student_id THEN
    -- Student reading own access
    NULL;
  ELSIF public.is_admin() THEN
    -- Admin reading any student access
    NULL;
  ELSIF public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, p_student_id) AND public.has_teacher_permission(v_caller, 'manage_tasks') THEN
    -- Authorized assigned teacher reading student access
    NULL;
  ELSE
    RAISE EXCEPTION 'Access denied: You are not authorized to view practice access for this student.'
      USING ERRCODE = '42501';
  END IF;
  -- 1. Fetch student's profile level
  SELECT level INTO v_student_level
  FROM public.profiles
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Student profile not found.'
    );
  END IF;

  -- 2. Check competition eligibility (jmcwc_assignments or competition settings)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_assignments') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.jmcwc_assignments WHERE student_id = p_student_id
    ) INTO v_is_eligible;
  END IF;

  -- 3. Check for student override
  SELECT * INTO v_override_record
  FROM public.student_practice_access
  WHERE scope = 'student' AND student_id = p_student_id
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'student_id', p_student_id,
      'level', COALESCE(v_student_level, ''),
      'scope', 'student',
      'source_label', 'Student override',
      'has_override', true,
      'settings', v_override_record.settings,
      'main_round_eligible', v_is_eligible,
      'updated_at', v_override_record.updated_at
    );
  END IF;

  -- 4. Check for level default
  IF v_student_level IS NOT NULL AND trim(v_student_level) <> '' THEN
    SELECT * INTO v_level_record
    FROM public.student_practice_access
    WHERE scope = 'level' AND lower(trim(level)) = lower(trim(v_student_level))
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'student_id', p_student_id,
        'level', v_student_level,
        'scope', 'level',
        'source_label', 'From ' || v_student_level,
        'has_override', false,
        'settings', v_level_record.settings,
        'main_round_eligible', v_is_eligible,
        'updated_at', v_level_record.updated_at
      );
    END IF;
  END IF;

  -- 5. Fallback: Default full access (preserve current access until staff save a rule)
  RETURN jsonb_build_object(
    'ok', true,
    'student_id', p_student_id,
    'level', COALESCE(v_student_level, ''),
    'scope', 'default',
    'source_label', CASE
      WHEN v_student_level IS NOT NULL AND trim(v_student_level) <> '' THEN 'From ' || v_student_level || ' (Default)'
      ELSE 'Default (Full access)'
    END,
    'has_override', false,
    'settings', jsonb_build_object(
      'basics', jsonb_build_object('all', true, 'categories', '[]'::jsonb),
      'elements', jsonb_build_object('all', true, 'drills', '[]'::jsonb),
      'flash', jsonb_build_object('allowed', true),
      'memoriad', jsonb_build_object('all', true, 'modules', '[]'::jsonb, 'calendar_variants', jsonb_build_array(25, 50, 75, 100, 125)),
      'main_round', jsonb_build_object('all', true, 'categories', '[]'::jsonb)
    ),
    'main_round_eligible', v_is_eligible,
    'updated_at', null
  );
END;
$$;

-- Function: get_level_access_defaults
CREATE OR REPLACE FUNCTION public.get_level_access_defaults(p_level TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_record RECORD;
BEGIN
  IF p_level IS NULL OR trim(p_level) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Level name cannot be empty.');
  END IF;

  SELECT * INTO v_record
  FROM public.student_practice_access
  WHERE scope = 'level' AND lower(trim(level)) = lower(trim(p_level))
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'level', v_record.level,
      'has_rule', true,
      'settings', v_record.settings,
      'updated_at', v_record.updated_at
    );
  END IF;

  -- Return unconfigured default
  RETURN jsonb_build_object(
    'ok', true,
    'level', p_level,
    'has_rule', false,
    'settings', jsonb_build_object(
      'basics', jsonb_build_object('all', true, 'categories', '[]'::jsonb),
      'elements', jsonb_build_object('all', true, 'drills', '[]'::jsonb),
      'flash', jsonb_build_object('allowed', true),
      'memoriad', jsonb_build_object('all', true, 'modules', '[]'::jsonb, 'calendar_variants', jsonb_build_array(25, 50, 75, 100, 125)),
      'main_round', jsonb_build_object('all', true, 'categories', '[]'::jsonb)
    ),
    'updated_at', null
  );
END;
$$;

-- Function: admin_save_level_access
-- Admin-only function to set default access for an entire curriculum level.
CREATE OR REPLACE FUNCTION public.admin_save_level_access(p_level TEXT, p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_record RECORD;
  v_clean_level TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Access denied: Only administrators can save level access defaults.'
      USING ERRCODE = '42501';
  END IF;

  v_clean_level := trim(p_level);
  IF v_clean_level IS NULL OR v_clean_level = '' THEN
    RAISE EXCEPTION 'Level name cannot be empty.' USING ERRCODE = '22000';
  END IF;

  INSERT INTO public.student_practice_access (
    scope,
    level,
    student_id,
    settings,
    updated_at,
    updated_by
  )
  VALUES (
    'level',
    v_clean_level,
    NULL,
    COALESCE(p_settings, '{}'::jsonb),
    timezone('utc'::text, now()),
    v_caller
  )
  ON CONFLICT (lower(trim(level))) WHERE scope = 'level'
  DO UPDATE SET
    level = EXCLUDED.level,
    settings = EXCLUDED.settings,
    updated_at = timezone('utc'::text, now()),
    updated_by = v_caller
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'ok', true,
    'level', v_record.level,
    'settings', v_record.settings,
    'updated_at', v_record.updated_at
  );
END;
$$;

-- Function: save_student_access_override
-- Saves or updates a student-specific access override.
-- Callable by Admin OR authorized Teacher with can_manage_tasks assigned to student.
CREATE OR REPLACE FUNCTION public.save_student_access_override(p_student_id UUID, p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_record RECORD;
  v_student_exists BOOLEAN;
  v_is_eligible BOOLEAN := false;
  v_sanitized_settings JSONB := COALESCE(p_settings, '{}'::jsonb);
BEGIN
  -- Verify student exists
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = p_student_id AND role = 'student'
  ) INTO v_student_exists;

  IF NOT v_student_exists THEN
    RAISE EXCEPTION 'Student profile not found.' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization check
  IF public.is_admin() THEN
    -- Admin allowed
    NULL;
  ELSIF public.is_teacher(v_caller) THEN
    -- Teacher must have manage_tasks permission and be assigned to student
    IF NOT public.has_teacher_permission(v_caller, 'manage_tasks') THEN
      RAISE EXCEPTION 'Access denied: Teacher lacks task management permission.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_teacher_assigned_to_student(v_caller, p_student_id) THEN
      RAISE EXCEPTION 'Access denied: Student is not assigned to your roster.'
        USING ERRCODE = '42501';
    END IF;

    -- Enforce: "Main Round eligibility remains an admin decision."
    -- Teachers cannot grant Main Round competition eligibility!
    IF (v_sanitized_settings->'main_round'->>'eligible')::boolean = true THEN
      RAISE EXCEPTION 'Access denied: Only administrators can grant Main Round competition eligibility.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Access denied: Unauthorized caller.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.student_practice_access (
    scope,
    level,
    student_id,
    settings,
    updated_at,
    updated_by
  )
  VALUES (
    'student',
    NULL,
    p_student_id,
    v_sanitized_settings,
    timezone('utc'::text, now()),
    v_caller
  )
  ON CONFLICT (student_id) WHERE scope = 'student'
  DO UPDATE SET
    settings = EXCLUDED.settings,
    updated_at = timezone('utc'::text, now()),
    updated_by = v_caller
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'ok', true,
    'student_id', v_record.student_id,
    'scope', 'student',
    'settings', v_record.settings,
    'updated_at', v_record.updated_at
  );
END;
$$;

-- Function: reset_student_access_override
-- Deletes a student override, reverting them to their curriculum level default.
CREATE OR REPLACE FUNCTION public.reset_student_access_override(p_student_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF public.is_admin() THEN
    NULL;
  ELSIF public.is_teacher(v_caller) THEN
    IF NOT public.has_teacher_permission(v_caller, 'manage_tasks') THEN
      RAISE EXCEPTION 'Access denied: Teacher lacks task management permission.'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_teacher_assigned_to_student(v_caller, p_student_id) THEN
      RAISE EXCEPTION 'Access denied: Student is not assigned to your roster.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Access denied: Unauthorized caller.' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.student_practice_access
  WHERE scope = 'student' AND student_id = p_student_id;

  RETURN jsonb_build_object(
    'ok', true,
    'student_id', p_student_id,
    'message', 'Student override removed. Student now uses level settings.'
  );
END;
$$;

-- Function: get_teacher_level_student_count
-- Returns the count of students currently assigned to the calling teacher in the specified level.
CREATE OR REPLACE FUNCTION public.get_teacher_level_student_count(p_level TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_count INTEGER := 0;
  v_clean_level TEXT := trim(p_level);
BEGIN
  IF public.is_admin() THEN
    -- Admin sees total students in level
    SELECT COUNT(*) INTO v_count
    FROM public.profiles
    WHERE role = 'student' AND active = true AND lower(trim(COALESCE(level, ''))) = lower(v_clean_level);
  ELSIF public.is_teacher(v_caller) THEN
    -- Teacher sees only their assigned students in level
    SELECT COUNT(*) INTO v_count
    FROM public.profiles p
    JOIN public.teacher_student_assignments tsa ON tsa.student_id = p.id
    WHERE tsa.teacher_id = v_caller
      AND p.role = 'student'
      AND p.active = true
      AND lower(trim(COALESCE(p.level, ''))) = lower(v_clean_level);
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'Unauthorized.');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'level', v_clean_level,
    'count', v_count
  );
END;
$$;

-- Function: teacher_bulk_apply_level_access
-- Applies an access setting to all students assigned to the calling teacher in the selected level.
CREATE OR REPLACE FUNCTION public.teacher_bulk_apply_level_access(p_level TEXT, p_settings JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_clean_level TEXT := trim(p_level);
  v_student_ids UUID[];
  v_stu_id UUID;
  v_applied_count INTEGER := 0;
  v_is_eligible BOOLEAN;
  v_sanitized_settings JSONB;
BEGIN
  IF v_clean_level IS NULL OR v_clean_level = '' THEN
    RAISE EXCEPTION 'Level name cannot be empty.' USING ERRCODE = '22000';
  END IF;

  IF public.is_admin() THEN
    -- Admin can apply to all students in level
    SELECT array_agg(id) INTO v_student_ids
    FROM public.profiles
    WHERE role = 'student' AND active = true AND lower(trim(COALESCE(level, ''))) = lower(v_clean_level);
  ELSIF public.is_teacher(v_caller) THEN
    IF NOT public.has_teacher_permission(v_caller, 'manage_tasks') THEN
      RAISE EXCEPTION 'Access denied: Teacher lacks task management permission.'
        USING ERRCODE = '42501';
    END IF;

    IF (p_settings->'main_round'->>'eligible')::boolean = true THEN
      RAISE EXCEPTION 'Access denied: Only administrators can grant Main Round competition eligibility.'
        USING ERRCODE = '42501';
    END IF;

    -- ONLY students assigned to this teacher in this level!
    SELECT array_agg(p.id) INTO v_student_ids
    FROM public.profiles p
    JOIN public.teacher_student_assignments tsa ON tsa.student_id = p.id
    WHERE tsa.teacher_id = v_caller
      AND p.role = 'student'
      AND p.active = true
      AND lower(trim(COALESCE(p.level, ''))) = lower(v_clean_level);
  ELSE
    RAISE EXCEPTION 'Access denied: Unauthorized caller.' USING ERRCODE = '42501';
  END IF;

  IF v_student_ids IS NULL OR array_length(v_student_ids, 1) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'level', v_clean_level,
      'count', 0,
      'message', 'No assigned active students found in this level.'
    );
  END IF;

  FOREACH v_stu_id IN ARRAY v_student_ids LOOP
    v_sanitized_settings := COALESCE(p_settings, '{}'::jsonb);

    -- If caller is teacher, enforce that Main Round eligibility remains an admin decision
    IF NOT public.is_admin() THEN
      v_is_eligible := false;
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_assignments') THEN
        SELECT EXISTS (
          SELECT 1 FROM public.jmcwc_assignments WHERE student_id = v_stu_id
        ) INTO v_is_eligible;
      END IF;

      IF NOT v_is_eligible AND (v_sanitized_settings->'main_round'->>'eligible')::boolean = true THEN
        v_sanitized_settings := jsonb_set(
          v_sanitized_settings,
          '{main_round,eligible}',
          'false'::jsonb
        );
      END IF;
    END IF;

    INSERT INTO public.student_practice_access (
      scope,
      level,
      student_id,
      settings,
      updated_at,
      updated_by
    )
    VALUES (
      'student',
      NULL,
      v_stu_id,
      v_sanitized_settings,
      timezone('utc'::text, now()),
      v_caller
    )
    ON CONFLICT (student_id) WHERE scope = 'student'
    DO UPDATE SET
      settings = EXCLUDED.settings,
      updated_at = timezone('utc'::text, now()),
      updated_by = v_caller;

    v_applied_count := v_applied_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'level', v_clean_level,
    'count', v_applied_count,
    'student_ids', v_student_ids
  );
END;
$$;

-- Function: flash_start (enforcing student practice access for free practice)
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
  v_profile RECORD;
  v_todo_task_id uuid;
  v_task RECORD;
  v_homework_id uuid;
  v_hw RECORD;
  v_access jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = auth.uid();
  IF NOT FOUND OR NOT v_profile.active THEN
    RAISE EXCEPTION 'This account is not active.';
  END IF;

  -- 1. Check for optional homework_id in p_settings (Homework takes precedence for settings freezing)
  IF p_settings ? 'homework_id' AND p_settings ->> 'homework_id' IS NOT NULL AND TRIM(p_settings ->> 'homework_id') <> '' THEN
    BEGIN
      v_homework_id := (p_settings ->> 'homework_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid homework ID format.';
    END;

    SELECT * INTO v_hw FROM public.homework_assignments WHERE id = v_homework_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Assigned homework not found.';
    END IF;

    IF v_hw.activity_type <> 'flash' THEN
      RAISE EXCEPTION 'Homework activity type mismatch (expected %, requested flash).', v_hw.activity_type;
    END IF;

    IF NOT public.is_student_homework_recipient(v_homework_id, auth.uid()) THEN
      RAISE EXCEPTION 'You are not an authorized recipient of this homework.';
    END IF;

    -- Freeze assigned settings directly from homework settings
    v_digits := COALESCE((v_hw.settings ->> 'digits')::integer, (p_settings ->> 'digits')::integer, 2);
    v_count  := COALESCE((v_hw.settings ->> 'count')::integer, (p_settings ->> 'count')::integer, 5);
    v_speed  := COALESCE((v_hw.settings ->> 'speed_ms')::integer, (p_settings ->> 'speed_ms')::integer, 1000);
    v_mode   := COALESCE(v_hw.settings ->> 'mode', p_settings ->> 'mode', 'add');

  -- 2. Check for optional todo_task_id in p_settings
  ELSIF p_settings ? 'todo_task_id' AND p_settings ->> 'todo_task_id' IS NOT NULL AND TRIM(p_settings ->> 'todo_task_id') <> '' THEN
    BEGIN
      v_todo_task_id := (p_settings ->> 'todo_task_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid daily task ID format.';
    END;

    SELECT * INTO v_task FROM public.daily_tasks WHERE id = v_todo_task_id;
    IF NOT FOUND OR NOT v_task.active THEN
      RAISE EXCEPTION 'Assigned daily task not found or is no longer active.';
    END IF;
    IF v_task.section <> 'flash' THEN
      RAISE EXCEPTION 'Daily task section mismatch (expected %, requested flash).', v_task.section;
    END IF;

    IF v_task.target_scope = 'targeted' THEN
      IF NOT EXISTS (SELECT 1 FROM public.daily_task_recipients WHERE task_id = v_task.id AND student_id = auth.uid()) THEN
        RAISE EXCEPTION 'You are not assigned to this daily task.';
      END IF;
    END IF;

    IF v_task.level IS NOT NULL AND v_task.level <> '' THEN
      IF v_profile.level IS NULL OR v_profile.level <> v_task.level THEN
        RAISE EXCEPTION 'Daily task level mismatch.';
      END IF;
    END IF;

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

    -- Verify practice access for free practice
    v_access := public.get_student_effective_access(auth.uid());
    IF v_access IS NULL
       OR (v_access ->> 'ok')::boolean IS NOT TRUE
       OR v_access -> 'settings' IS NULL
       OR jsonb_typeof(v_access -> 'settings') <> 'object' THEN
      RAISE EXCEPTION 'Practice access lookup failed. Please try again.'
        USING ERRCODE = '53000';
    END IF;
    IF v_access -> 'settings' -> 'flash' ->> 'allowed' = 'false' THEN
      RAISE EXCEPTION 'Flash Anzan practice is not permitted for your current access level.'
        USING ERRCODE = '42501';
    END IF;
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

  -- Generate question via flash_generate_question helper
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'flash_generate_question'
  ) THEN
    v_nums := public.flash_generate_question(v_digits, v_count, v_mode);
  ELSE
    DECLARE
      v_i INT;
      v_min_val INT := 10^(v_digits - 1);
      v_max_val INT := (10^v_digits) - 1;
      v_val INT;
    BEGIN
      v_nums := '{}';
      FOR v_i IN 1..v_count LOOP
        v_val := floor(random() * (v_max_val - v_min_val + 1) + v_min_val)::INT;
        IF v_mode = 'add_sub' AND v_i > 1 AND random() < 0.4 THEN
          v_val := -v_val;
        END IF;
        v_nums := array_append(v_nums, v_val);
      END LOOP;
    END;
  END IF;

  SELECT sum(x)::integer INTO v_sum FROM unnest(v_nums) AS x;

  IF v_todo_task_id IS NOT NULL OR v_homework_id IS NOT NULL THEN
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
    'todo_task_id', v_todo_task_id,
    'homework_id', v_homework_id
  );

  INSERT INTO public.drill_sessions
    (student_id, activity_type, activity_name, settings, questions, expected, min_seconds, expires_at)
  VALUES
    (auth.uid(), 'flash_anzan', 'Flash anzan', v_settings,
     jsonb_build_array(to_jsonb(v_nums)), jsonb_build_array(v_sum), v_min,
     now() + (v_min + 1800) * interval '1 second')
  RETURNING id INTO v_id;

  IF v_homework_id IS NOT NULL THEN
    INSERT INTO public.homework_bound_sessions (assignment_id, student_id, session_id)
    VALUES (v_homework_id, auth.uid(), v_id)
    ON CONFLICT (session_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('session_id', v_id, 'numbers', to_jsonb(v_nums), 'settings', v_settings);
END;
$$;

REVOKE ALL ON FUNCTION public.flash_start(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_start(jsonb) TO authenticated, service_role;

-- 4. Manual Score Entry Guard on public.results
-- Intercepts direct browser writes (INSERT and UPDATE category changes) to public.results.
-- Preserves existing readable history, staff corrections/reviews, and honors valid assignment-specific exceptions.
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS homework_id UUID,
  ADD COLUMN IF NOT EXISTS task_id UUID,
  ADD COLUMN IF NOT EXISTS assignment_id UUID;

CREATE OR REPLACE FUNCTION public.today_ist()
RETURNS DATE
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

REVOKE ALL ON FUNCTION public.today_ist() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.today_ist() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_daily_task_recipient(p_task_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_task_recipients
    WHERE task_id = p_task_id AND student_id = p_student_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_daily_task_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_daily_task_recipient(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_results_practice_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(auth.role(), ''),
    NULLIF(current_setting('role', true), ''),
    ''
  );
  v_is_service_role BOOLEAN := (v_role = 'service_role');
  v_cat RECORD;
  v_access JSONB;
  v_basics JSONB;
  v_round JSONB;
  v_is_allowed BOOLEAN := true;
  v_has_exception BOOLEAN := false;
  v_hw_id UUID;
  v_task_id UUID;
  v_assign RECORD;
  v_task RECORD;
  v_stu_profile RECORD;
  v_today DATE := public.today_ist();
BEGIN
  -- 1. Explicitly trusted server role bypass
  IF v_is_service_role THEN
    RETURN NEW;
  END IF;

  -- 2. Deny missing caller ID if not trusted server role
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Access denied: Missing caller identification.'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Admin bypass (institute-wide roster scope)
  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  -- 4. Teacher bypass: must be assigned to this student (roster scope)
  IF public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, NEW.student_id) THEN
    RETURN NEW;
  END IF;

  -- 5. Preserve staff corrections and score edits on UPDATE
  IF TG_OP = 'UPDATE' THEN
    -- If category_id and student_id have not changed, allow editing existing score fields
    IF OLD.category_id = NEW.category_id AND OLD.student_id = NEW.student_id THEN
      RETURN NEW;
    END IF;
    -- If category_id changed, do NOT skip category check!
    -- Review/flag metadata cannot be used by students to bypass category restrictions.
  END IF;

  -- 6. Fetch category details
  SELECT * INTO v_cat FROM public.categories WHERE id = NEW.category_id;
  IF NOT FOUND THEN
    -- If category not in catalog, allow foreign key constraint to handle
    RETURN NEW;
  END IF;

  -- 7. Fetch effective practice access for the student
  v_access := public.get_student_effective_access(NEW.student_id);
  IF v_access IS NULL
     OR (v_access ->> 'ok')::boolean IS NOT TRUE
     OR v_access -> 'settings' IS NULL
     OR jsonb_typeof(v_access -> 'settings') <> 'object' THEN
    RAISE EXCEPTION 'Practice access lookup failed. Please try again.'
      USING ERRCODE = '53000';
  END IF;

  -- 8. Extract explicitly carried assignment / task ID
  v_hw_id := COALESCE(NEW.homework_id, NEW.assignment_id);
  v_task_id := NEW.task_id;

  IF v_hw_id IS NULL AND v_task_id IS NULL AND NEW.note IS NOT NULL AND NEW.note ~ '^[{\[].*[}\]]$' THEN
    BEGIN
      v_hw_id := NULLIF((NEW.note::jsonb ->> 'homework_id'), '')::UUID;
      v_task_id := NULLIF(COALESCE(NEW.note::jsonb ->> 'task_id', NEW.note::jsonb ->> 'todo_task_id'), '')::UUID;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END IF;

  -- 9. Basics category access enforcement
  IF v_cat.section = 'basics' THEN
    v_basics := v_access -> 'settings' -> 'basics';
    v_is_allowed := true;
    IF v_basics IS NOT NULL AND (v_basics ->> 'all')::boolean = false AND (v_basics ? 'categories') THEN
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_basics -> 'categories') elem
        WHERE lower(regexp_replace(elem, '\s+', '', 'g')) = lower(regexp_replace(v_cat.name, '\s+', '', 'g'))
           OR elem = v_cat.id::text
      ) INTO v_is_allowed;
    END IF;

    IF NOT v_is_allowed THEN
      -- A regular manual score save must follow free-practice access.
      -- Exception requires a specific, valid assignment carried through the submission.
      v_has_exception := false;

      -- Check exact homework assignment if carried
      IF v_hw_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'homework_assignments'
      ) THEN
        SELECT * INTO v_assign
        FROM public.homework_assignments
        WHERE id = v_hw_id;

        IF FOUND THEN
          -- Category & activity match
          IF (v_assign.activity_type = 'basics' OR v_assign.activity_type = 'paper')
             AND (v_assign.category_id = NEW.category_id OR (v_assign.settings ->> 'category_id')::text = NEW.category_id::text OR v_assign.category_id IS NULL) THEN
            -- Existing assignment submission rules to decide whether homework is open:
            -- 1. Date window open at submission time in India Time (public.today_ist()):
            --    ha.assigned_date <= today_ist() and (ha.due_date is null or ha.due_date >= today_ist())
            -- Note: NEW.entry_date (student-entered score date) is preserved for history
            IF v_assign.assigned_date <= v_today AND (v_assign.due_date IS NULL OR v_assign.due_date >= v_today) THEN
              -- 2. Recipient eligibility (including student level check and teacher roster)
              IF public.is_student_homework_recipient(v_assign.id, NEW.student_id) IS TRUE THEN
                -- 3. Not already completed
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'homework_completions'
                ) OR NOT EXISTS (
                  SELECT 1 FROM public.homework_completions hc
                  WHERE hc.assignment_id = v_assign.id
                    AND hc.student_id = NEW.student_id
                    AND hc.status = 'completed'
                ) THEN
                  v_has_exception := true;
                END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;

      -- Check exact Daily To-Do task if carried (e.g. from Dashboard -> "Log result")
      IF v_has_exception IS NOT TRUE AND v_task_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'daily_tasks'
      ) THEN
        SELECT * INTO v_task
        FROM public.daily_tasks
        WHERE id = v_task_id AND active = true;

        IF FOUND THEN
          -- Match exact task creation-date rule of current daily plan:
          -- (t.created_at AT TIME ZONE 'Asia/Kolkata')::date <= v_today
          IF v_task.created_at IS NULL OR (v_task.created_at AT TIME ZONE 'Asia/Kolkata')::date <= v_today THEN
            -- Active Basics task matching category (or category-wide)
            IF v_task.section = 'basics' AND (v_task.category_id = NEW.category_id OR v_task.category_id IS NULL) THEN
              SELECT * INTO v_stu_profile FROM public.profiles WHERE id = NEW.student_id;
              IF FOUND AND v_stu_profile.active IS TRUE THEN
                -- Eligibility rules matching the installed Daily To-Do plan (todo_status_on):
                IF v_task.target_scope = 'targeted' THEN
                  -- For targeted tasks, use existing recipient check
                  IF EXISTS (
                    SELECT 1 FROM pg_proc WHERE proname = 'is_daily_task_recipient'
                  ) THEN
                    v_has_exception := (public.is_daily_task_recipient(v_task.id, NEW.student_id) IS TRUE);
                  ELSE
                    SELECT (EXISTS (
                      SELECT 1 FROM public.daily_task_recipients dtr
                      WHERE dtr.task_id = v_task.id AND dtr.student_id = NEW.student_id
                    ) IS TRUE) INTO v_has_exception;
                  END IF;
                ELSIF COALESCE(v_task.target_scope, 'all') = 'all' THEN
                  -- For all tasks, require either a NULL task level or an exact match with the student's level
                  v_has_exception := (v_task.level IS NULL OR (v_stu_profile.level IS NOT NULL AND v_task.level = v_stu_profile.level));
                END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;

      -- If not a valid assigned submission or regular save without assignment: BLOCKED
      -- Grant an assignment exception only when eligibility is explicitly true
      IF v_has_exception IS NOT TRUE THEN
        RAISE EXCEPTION 'This category is not permitted for your practice access.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 10. Main Round category access & eligibility enforcement
  IF v_cat.section = 'round' OR NEW.student_round_id IS NOT NULL THEN
    -- Check competition eligibility
    IF (v_access ->> 'main_round_eligible')::boolean = false OR (v_access -> 'settings' -> 'main_round' ->> 'eligible')::boolean = false THEN
      RAISE EXCEPTION 'You are not eligible for Main Round competition practice.'
        USING ERRCODE = '42501';
    END IF;

    v_round := v_access -> 'settings' -> 'main_round';
    v_is_allowed := true;
    IF v_round IS NOT NULL AND (v_round ->> 'all')::boolean = false AND (v_round ? 'categories') THEN
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_round -> 'categories') elem
        WHERE lower(regexp_replace(elem, '\s+', '', 'g')) = lower(regexp_replace(v_cat.name, '\s+', '', 'g'))
           OR elem = v_cat.id::text
      ) INTO v_is_allowed;
    END IF;

    IF NOT v_is_allowed THEN
      v_has_exception := false;

      IF v_hw_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'homework_assignments'
      ) THEN
        SELECT * INTO v_assign
        FROM public.homework_assignments
        WHERE id = v_hw_id;

        IF FOUND THEN
          IF v_assign.activity_type = 'round'
             AND (v_assign.category_id = NEW.category_id OR (v_assign.settings ->> 'category_id')::text = NEW.category_id::text OR v_assign.category_id IS NULL) THEN
            -- Use the same public.today_ist() date window in Main Round manual Homework branch as in Basics:
            IF v_assign.assigned_date <= v_today AND (v_assign.due_date IS NULL OR v_assign.due_date >= v_today) THEN
              IF public.is_student_homework_recipient(v_assign.id, NEW.student_id) IS TRUE THEN
                IF NOT EXISTS (
                  SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'homework_completions'
                ) OR NOT EXISTS (
                  SELECT 1 FROM public.homework_completions hc
                  WHERE hc.assignment_id = v_assign.id
                    AND hc.student_id = NEW.student_id
                    AND hc.status = 'completed'
                ) THEN
                  v_has_exception := true;
                END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;

      IF v_has_exception IS NOT TRUE THEN
        RAISE EXCEPTION 'This round category is not permitted for your practice access.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_results_practice_access ON public.results;
CREATE TRIGGER trg_check_results_practice_access
  BEFORE INSERT OR UPDATE ON public.results
  FOR EACH ROW
  EXECUTE FUNCTION public.check_results_practice_access();

-- Explicit Function Permissions
REVOKE ALL ON FUNCTION public.get_student_effective_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_student_effective_access(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_level_access_defaults(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_level_access_defaults(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_save_level_access(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_level_access(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_student_access_override(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_student_access_override(UUID, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reset_student_access_override(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_student_access_override(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_teacher_level_student_count(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_level_student_count(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_bulk_apply_level_access(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_bulk_apply_level_access(TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.flash_start(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_start(JSONB) TO authenticated, service_role;

-- Table grants: Authenticated clients may only SELECT; all mutations route through security-definer RPCs
REVOKE ALL ON TABLE public.student_practice_access FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.student_practice_access TO authenticated;
GRANT ALL ON TABLE public.student_practice_access TO service_role;
