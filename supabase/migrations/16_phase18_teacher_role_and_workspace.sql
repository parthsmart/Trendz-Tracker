-- ==============================================================================
-- 16_phase18_teacher_role_and_workspace.sql
-- Phase 18: Teacher Role, Student Assignments, Granular Permissions,
--           Transactional Management, Recipient-Scoped Content & Strict RLS
-- Run Order: 16 of 16
--
-- DO NOT EXECUTE REMOTELY. Provided for database owner review and manual execution.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. Profiles Role Constraint Update
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('student', 'teacher', 'admin'));

-- ------------------------------------------------------------------------------
-- 2. Table: teacher_student_assignments (Many-to-Many Teacher -> Student)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teacher_student_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_teacher_student_assignment UNIQUE (teacher_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_assignments_teacher ON public.teacher_student_assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_assignments_student ON public.teacher_student_assignments(student_id);

ALTER TABLE public.teacher_student_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teacher_assignments_admin_all" ON public.teacher_student_assignments;
CREATE POLICY "teacher_assignments_admin_all"
  ON public.teacher_student_assignments
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  );

DROP POLICY IF EXISTS "teacher_assignments_teacher_select" ON public.teacher_student_assignments;
CREATE POLICY "teacher_assignments_teacher_select"
  ON public.teacher_student_assignments
  FOR SELECT
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
  );

-- ------------------------------------------------------------------------------
-- 3. Table: teacher_permissions (10 Granular Permissions per Teacher)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teacher_permissions (
  teacher_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  can_view_students BOOLEAN NOT NULL DEFAULT true,
  can_mark_attendance BOOLEAN NOT NULL DEFAULT true,
  can_correct_attendance BOOLEAN NOT NULL DEFAULT true,
  can_generate_reports BOOLEAN NOT NULL DEFAULT true,
  can_manage_tasks BOOLEAN NOT NULL DEFAULT true,
  can_manage_tests BOOLEAN NOT NULL DEFAULT true,
  can_publish_announcements BOOLEAN NOT NULL DEFAULT true,
  can_manage_resources BOOLEAN NOT NULL DEFAULT true,
  can_review_scores BOOLEAN NOT NULL DEFAULT true,
  can_request_corrections BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

ALTER TABLE public.teacher_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teacher_permissions_admin_all" ON public.teacher_permissions;
CREATE POLICY "teacher_permissions_admin_all"
  ON public.teacher_permissions
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  );

DROP POLICY IF EXISTS "teacher_permissions_teacher_select" ON public.teacher_permissions;
CREATE POLICY "teacher_permissions_teacher_select"
  ON public.teacher_permissions
  FOR SELECT
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
  );

-- ------------------------------------------------------------------------------
-- 4. Helper Security Functions (SECURITY DEFINER)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_teacher(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT role = 'teacher' AND active = true
     FROM public.profiles
     WHERE id = p_uid),
    false
  );
$$;

CREATE OR REPLACE FUNCTION public.is_teacher_assigned_to_student(p_teacher_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.teacher_student_assignments
    WHERE teacher_id = p_teacher_id AND student_id = p_student_id
  );
$$;

CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_allowed BOOLEAN := false;
BEGIN
  IF NOT public.is_teacher(p_teacher_id) THEN
    RETURN false;
  END IF;

  SELECT
    CASE p_permission
      WHEN 'view_students' THEN can_view_students
      WHEN 'mark_attendance' THEN can_mark_attendance
      WHEN 'correct_attendance' THEN can_correct_attendance
      WHEN 'generate_reports' THEN can_generate_reports
      WHEN 'manage_tasks' THEN can_manage_tasks
      WHEN 'manage_tests' THEN can_manage_tests
      WHEN 'publish_announcements' THEN can_publish_announcements
      WHEN 'manage_resources' THEN can_manage_resources
      WHEN 'review_scores' THEN can_review_scores
      WHEN 'request_corrections' THEN can_request_corrections
      ELSE false
    END
  INTO v_allowed
  FROM public.teacher_permissions
  WHERE teacher_id = p_teacher_id;

  RETURN COALESCE(v_allowed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.teacher_has_student_access(p_student_id UUID, p_permission TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_admin() THEN
    RETURN true;
  END IF;

  IF public.is_teacher(v_caller) THEN
    IF NOT public.is_teacher_assigned_to_student(v_caller, p_student_id) THEN
      RETURN false;
    END IF;

    IF p_permission IS NOT NULL AND NOT public.has_teacher_permission(v_caller, p_permission) THEN
      RETURN false;
    END IF;

    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. Table: score_correction_requests (Teacher Proposals with Original Snapshot)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.score_correction_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  result_id UUID REFERENCES public.results(id) ON DELETE CASCADE,
  activity_result_id UUID REFERENCES public.activity_results(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL CHECK (table_name IN ('results', 'activity_results')),
  original_score_snapshot JSONB NOT NULL,
  proposed_correct INTEGER CHECK (proposed_correct >= 0),
  proposed_total INTEGER CHECK (proposed_total >= 0),
  proposed_time_seconds INTEGER CHECK (proposed_time_seconds >= 0),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) >= 3),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT chk_proposed_correct_lte_total CHECK (
    proposed_correct IS NULL OR proposed_total IS NULL OR proposed_correct <= proposed_total
  )
);

CREATE INDEX IF NOT EXISTS idx_correction_req_status ON public.score_correction_requests(status);
CREATE INDEX IF NOT EXISTS idx_correction_req_student ON public.score_correction_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_correction_req_teacher ON public.score_correction_requests(teacher_id);

ALTER TABLE public.score_correction_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "correction_req_admin_all" ON public.score_correction_requests;
CREATE POLICY "correction_req_admin_all"
  ON public.score_correction_requests
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  );

DROP POLICY IF EXISTS "correction_req_teacher_select" ON public.score_correction_requests;
CREATE POLICY "correction_req_teacher_select"
  ON public.score_correction_requests
  FOR SELECT
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
  );

-- ------------------------------------------------------------------------------
-- 6. Table: attendance_audit (Previous/New Values & Actor for Attendance)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_id UUID,
  session_id UUID NOT NULL,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL REFERENCES public.profiles(id),
  action TEXT NOT NULL CHECK (action IN ('mark', 'correct', 'delete')),
  old_status TEXT,
  new_status TEXT,
  old_note TEXT,
  new_note TEXT,
  reason TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_attendance_audit_student ON public.attendance_audit(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_audit_session ON public.attendance_audit(session_id);

ALTER TABLE public.attendance_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attendance_audit_admin_all" ON public.attendance_audit;
CREATE POLICY "attendance_audit_admin_all"
  ON public.attendance_audit
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  );

DROP POLICY IF EXISTS "attendance_audit_teacher_select" ON public.attendance_audit;
CREATE POLICY "attendance_audit_teacher_select"
  ON public.attendance_audit
  FOR SELECT
  TO authenticated
  USING (
    public.is_teacher(auth.uid())
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  );

-- ------------------------------------------------------------------------------
-- 7. Table: teacher_audit_log (Admin Operations on Teacher Accounts)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teacher_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES public.profiles(id),
  action TEXT NOT NULL CHECK (action IN (
    'create_teacher',
    'update_permissions',
    'assign_students',
    'unassign_students',
    'activate',
    'deactivate',
    'reset_password'
  )),
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_teacher_audit_teacher ON public.teacher_audit_log(teacher_id);

ALTER TABLE public.teacher_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "teacher_audit_admin_all" ON public.teacher_audit_log;
CREATE POLICY "teacher_audit_admin_all"
  ON public.teacher_audit_log
  FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
  );

-- ------------------------------------------------------------------------------
-- 8. Transactional Admin Management RPCs
-- ------------------------------------------------------------------------------

-- 8a. Atomic teacher entry creation & audit
DROP FUNCTION IF EXISTS public.admin_create_teacher_entry(UUID, TEXT, TEXT, JSONB, UUID[]);
DROP FUNCTION IF EXISTS public.admin_create_teacher_entry(UUID, TEXT, TEXT, JSONB, UUID[], UUID);
CREATE OR REPLACE FUNCTION public.admin_create_teacher_entry(
  p_teacher_id UUID,
  p_teacher_code TEXT,
  p_full_name TEXT,
  p_permissions JSONB DEFAULT '{}'::jsonb,
  p_student_ids UUID[] DEFAULT ARRAY[]::UUID[],
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := COALESCE(auth.uid(), p_actor_id);
  v_code TEXT := UPPER(TRIM(p_teacher_code));
  v_name TEXT := TRIM(p_full_name);
  v_deduped_ids UUID[] := ARRAY[]::UUID[];
  v_assigned_count INT := 0;
  v_perms_payload JSONB;
BEGIN
  IF NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can create teacher accounts.' USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Actor ID is required for administrative audit logging.' USING ERRCODE = '23502';
  END IF;

  IF v_code = '' OR v_name = '' THEN
    RAISE EXCEPTION 'Teacher code and full name are required.' USING ERRCODE = '22023';
  END IF;

  -- 1. Deduplicate & validate student IDs
  IF p_student_ids IS NOT NULL AND array_length(p_student_ids, 1) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_ids
    FROM unnest(p_student_ids) AS sid
    WHERE sid IS NOT NULL;

    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_ids) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid assignment: All assigned students must be active accounts with role=student.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- 2. Upsert profile
  INSERT INTO public.profiles (
    id, student_code, full_name, role, level, active
  ) VALUES (
    p_teacher_id, v_code, v_name, 'teacher', 'Teacher', true
  )
  ON CONFLICT (id) DO UPDATE SET
    student_code = EXCLUDED.student_code,
    full_name = EXCLUDED.full_name,
    role = 'teacher',
    level = 'Teacher',
    active = true;

  -- 3. Upsert permissions
  v_perms_payload := jsonb_build_object(
    'can_view_students', COALESCE((p_permissions->>'can_view_students')::boolean, true),
    'can_mark_attendance', COALESCE((p_permissions->>'can_mark_attendance')::boolean, true),
    'can_correct_attendance', COALESCE((p_permissions->>'can_correct_attendance')::boolean, true),
    'can_generate_reports', COALESCE((p_permissions->>'can_generate_reports')::boolean, true),
    'can_manage_tasks', COALESCE((p_permissions->>'can_manage_tasks')::boolean, true),
    'can_manage_tests', COALESCE((p_permissions->>'can_manage_tests')::boolean, true),
    'can_publish_announcements', COALESCE((p_permissions->>'can_publish_announcements')::boolean, true),
    'can_manage_resources', COALESCE((p_permissions->>'can_manage_resources')::boolean, true),
    'can_review_scores', COALESCE((p_permissions->>'can_review_scores')::boolean, true),
    'can_request_corrections', COALESCE((p_permissions->>'can_request_corrections')::boolean, true)
  );

  INSERT INTO public.teacher_permissions (
    teacher_id,
    can_view_students, can_mark_attendance, can_correct_attendance,
    can_generate_reports, can_manage_tasks, can_manage_tests,
    can_publish_announcements, can_manage_resources, can_review_scores,
    can_request_corrections, updated_by
  ) VALUES (
    p_teacher_id,
    (v_perms_payload->>'can_view_students')::boolean,
    (v_perms_payload->>'can_mark_attendance')::boolean,
    (v_perms_payload->>'can_correct_attendance')::boolean,
    (v_perms_payload->>'can_generate_reports')::boolean,
    (v_perms_payload->>'can_manage_tasks')::boolean,
    (v_perms_payload->>'can_manage_tests')::boolean,
    (v_perms_payload->>'can_publish_announcements')::boolean,
    (v_perms_payload->>'can_manage_resources')::boolean,
    (v_perms_payload->>'can_review_scores')::boolean,
    (v_perms_payload->>'can_request_corrections')::boolean,
    v_caller
  )
  ON CONFLICT (teacher_id) DO UPDATE SET
    can_view_students = EXCLUDED.can_view_students,
    can_mark_attendance = EXCLUDED.can_mark_attendance,
    can_correct_attendance = EXCLUDED.can_correct_attendance,
    can_generate_reports = EXCLUDED.can_generate_reports,
    can_manage_tasks = EXCLUDED.can_manage_tasks,
    can_manage_tests = EXCLUDED.can_manage_tests,
    can_publish_announcements = EXCLUDED.can_publish_announcements,
    can_manage_resources = EXCLUDED.can_manage_resources,
    can_review_scores = EXCLUDED.can_review_scores,
    can_request_corrections = EXCLUDED.can_request_corrections,
    updated_at = now(),
    updated_by = v_caller;

  -- 4. Insert initial student assignments
  IF array_length(v_deduped_ids, 1) > 0 THEN
    INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
    SELECT p_teacher_id, sid, v_caller
    FROM unnest(v_deduped_ids) AS sid
    ON CONFLICT (teacher_id, student_id) DO NOTHING;

    v_assigned_count := array_length(v_deduped_ids, 1);
  END IF;

  -- 5. Record audit log
  INSERT INTO public.teacher_audit_log (
    teacher_id, actor_id, action, details
  ) VALUES (
    p_teacher_id,
    v_caller,
    'create_teacher',
    jsonb_build_object(
      'teacher_code', v_code,
      'full_name', v_name,
      'permissions', v_perms_payload,
      'assigned_count', v_assigned_count,
      'student_ids', v_deduped_ids
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'success', true,
    'teacher_id', p_teacher_id,
    'assigned_count', v_assigned_count,
    'permissions', v_perms_payload
  );
END;
$$;

-- 8b. Atomic assignment replacement & audit
DROP FUNCTION IF EXISTS public.admin_replace_teacher_assignments(UUID, UUID[]);
DROP FUNCTION IF EXISTS public.admin_replace_teacher_assignments(UUID, UUID[], UUID);
CREATE OR REPLACE FUNCTION public.admin_replace_teacher_assignments(
  p_teacher_id UUID,
  p_student_ids UUID[],
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := COALESCE(auth.uid(), p_actor_id);
  v_teacher RECORD;
  v_deduped_ids UUID[] := ARRAY[]::UUID[];
  v_assigned_count INT := 0;
BEGIN
  IF NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify teacher assignments.' USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Actor ID is required for administrative audit logging.' USING ERRCODE = '23502';
  END IF;

  SELECT id, role, active INTO v_teacher
  FROM public.profiles
  WHERE id = p_teacher_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Teacher profile not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_teacher.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'Target user is not a teacher (role: %).', v_teacher.role USING ERRCODE = '22023';
  END IF;

  -- Deduplicate and validate that every student ID exists and is an active student
  IF p_student_ids IS NOT NULL AND array_length(p_student_ids, 1) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_ids
    FROM unnest(p_student_ids) AS sid
    WHERE sid IS NOT NULL;

    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_ids) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid assignment: All assigned students must be active accounts with role=student.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Transactional replacement: clear existing and insert new
  DELETE FROM public.teacher_student_assignments
  WHERE teacher_id = p_teacher_id;

  IF array_length(v_deduped_ids, 1) > 0 THEN
    INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
    SELECT p_teacher_id, sid, v_caller
    FROM unnest(v_deduped_ids) AS sid;

    v_assigned_count := array_length(v_deduped_ids, 1);
  END IF;

  -- Record audit log
  INSERT INTO public.teacher_audit_log (
    teacher_id, actor_id, action, details
  ) VALUES (
    p_teacher_id,
    v_caller,
    'assign_students',
    jsonb_build_object(
      'assigned_count', v_assigned_count,
      'student_ids', v_deduped_ids
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'success', true,
    'assigned_count', v_assigned_count
  );
END;
$$;

-- 8c. Atomic permission updates & audit
DROP FUNCTION IF EXISTS public.admin_update_teacher_permissions(UUID, JSONB);
DROP FUNCTION IF EXISTS public.admin_update_teacher_permissions(UUID, JSONB, UUID);
CREATE OR REPLACE FUNCTION public.admin_update_teacher_permissions(
  p_teacher_id UUID,
  p_permissions JSONB,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := COALESCE(auth.uid(), p_actor_id);
  v_teacher RECORD;
  v_patch JSONB := '{}'::jsonb;
  v_updated RECORD;
BEGIN
  IF NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can modify teacher permissions.' USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Actor ID is required for administrative audit logging.' USING ERRCODE = '23502';
  END IF;

  SELECT id, role INTO v_teacher FROM public.profiles WHERE id = p_teacher_id;
  IF NOT FOUND OR v_teacher.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'Teacher profile not found.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.teacher_permissions
  SET
    can_view_students = COALESCE((p_permissions->>'can_view_students')::boolean, can_view_students),
    can_mark_attendance = COALESCE((p_permissions->>'can_mark_attendance')::boolean, can_mark_attendance),
    can_correct_attendance = COALESCE((p_permissions->>'can_correct_attendance')::boolean, can_correct_attendance),
    can_generate_reports = COALESCE((p_permissions->>'can_generate_reports')::boolean, can_generate_reports),
    can_manage_tasks = COALESCE((p_permissions->>'can_manage_tasks')::boolean, can_manage_tasks),
    can_manage_tests = COALESCE((p_permissions->>'can_manage_tests')::boolean, can_manage_tests),
    can_publish_announcements = COALESCE((p_permissions->>'can_publish_announcements')::boolean, can_publish_announcements),
    can_manage_resources = COALESCE((p_permissions->>'can_manage_resources')::boolean, can_manage_resources),
    can_review_scores = COALESCE((p_permissions->>'can_review_scores')::boolean, can_review_scores),
    can_request_corrections = COALESCE((p_permissions->>'can_request_corrections')::boolean, can_request_corrections),
    updated_at = now(),
    updated_by = v_caller
  WHERE teacher_id = p_teacher_id
  RETURNING * INTO v_updated;

  INSERT INTO public.teacher_audit_log (
    teacher_id, actor_id, action, details
  ) VALUES (
    p_teacher_id,
    v_caller,
    'update_permissions',
    p_permissions
  );

  RETURN jsonb_build_object('success', true, 'permissions', to_jsonb(v_updated));
END;
$$;

-- 8d. Atomic activation toggle & audit
DROP FUNCTION IF EXISTS public.admin_set_teacher_active(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.admin_set_teacher_active(UUID, BOOLEAN, UUID);
CREATE OR REPLACE FUNCTION public.admin_set_teacher_active(
  p_teacher_id UUID,
  p_active BOOLEAN,
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := COALESCE(auth.uid(), p_actor_id);
  v_teacher RECORD;
BEGIN
  IF NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can activate or deactivate teachers.' USING ERRCODE = '42501';
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Actor ID is required for administrative audit logging.' USING ERRCODE = '23502';
  END IF;

  SELECT id, role INTO v_teacher FROM public.profiles WHERE id = p_teacher_id;
  IF NOT FOUND OR v_teacher.role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'Teacher profile not found.' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.profiles
  SET active = p_active
  WHERE id = p_teacher_id;

  INSERT INTO public.teacher_audit_log (
    teacher_id, actor_id, action, details
  ) VALUES (
    p_teacher_id,
    v_caller,
    CASE WHEN p_active THEN 'activate' ELSE 'deactivate' END,
    jsonb_build_object('active', p_active)
  );

  RETURN jsonb_build_object('success', true, 'active', p_active);
END;
$$;

-- ------------------------------------------------------------------------------
-- 9. Content Targeting Tables (Teacher Content Recipients)
-- ------------------------------------------------------------------------------
ALTER TABLE public.weekly_tests
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS test_type TEXT NOT NULL DEFAULT 'offline',
  ADD COLUMN IF NOT EXISTS audience_level TEXT,
  ADD COLUMN IF NOT EXISTS opens_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS remind_days_before INT NOT NULL DEFAULT 7;

ALTER TABLE public.weekly_tests
  ADD COLUMN IF NOT EXISTS target_scope TEXT NOT NULL DEFAULT 'all';

ALTER TABLE public.daily_tasks
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS target_scope TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS activity_key TEXT,
  ADD COLUMN IF NOT EXISTS flash_digits INT,
  ADD COLUMN IF NOT EXISTS flash_count INT,
  ADD COLUMN IF NOT EXISTS flash_speed_ms INT,
  ADD COLUMN IF NOT EXISTS flash_mode TEXT,
  ADD COLUMN IF NOT EXISTS required_count INT NOT NULL DEFAULT 1;

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS target_scope TEXT NOT NULL DEFAULT 'all';

ALTER TABLE public.resources
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS audience_level TEXT,
  ADD COLUMN IF NOT EXISTS target_scope TEXT NOT NULL DEFAULT 'all';

CREATE TABLE IF NOT EXISTS public.weekly_test_recipients (
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (test_id, student_id)
);

CREATE TABLE IF NOT EXISTS public.daily_task_recipients (
  task_id UUID NOT NULL REFERENCES public.daily_tasks(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, student_id)
);

CREATE TABLE IF NOT EXISTS public.announcement_recipients (
  announcement_id UUID NOT NULL REFERENCES public.announcements(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, student_id)
);

CREATE TABLE IF NOT EXISTS public.resource_recipients (
  resource_id UUID NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, student_id)
);

ALTER TABLE public.weekly_test_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_task_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_recipients ENABLE ROW LEVEL SECURITY;

-- Durable audience migration: Backfill existing targeted content
UPDATE public.weekly_tests
SET target_scope = 'targeted'
WHERE id IN (SELECT test_id FROM public.weekly_test_recipients)
   OR created_by IN (SELECT id FROM public.profiles WHERE role = 'teacher');

UPDATE public.daily_tasks
SET target_scope = 'targeted'
WHERE id IN (SELECT task_id FROM public.daily_task_recipients)
   OR created_by IN (SELECT id FROM public.profiles WHERE role = 'teacher');

UPDATE public.announcements
SET target_scope = 'targeted'
WHERE id IN (SELECT announcement_id FROM public.announcement_recipients)
   OR created_by IN (SELECT id FROM public.profiles WHERE role = 'teacher');

UPDATE public.resources
SET target_scope = 'targeted'
WHERE id IN (SELECT resource_id FROM public.resource_recipients)
   OR created_by IN (SELECT id FROM public.profiles WHERE role = 'teacher');

-- 7b. Invariant Protection Trigger on Content Tables
CREATE OR REPLACE FUNCTION public.enforce_content_targeting_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_is_caller_teacher BOOLEAN := false;
BEGIN
  -- Service role and admin bypass trigger checks
  IF public.is_admin() OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_is_caller_teacher := public.is_teacher(v_caller) OR EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_caller AND role = 'teacher'
  );

  IF v_is_caller_teacher THEN
    -- Teacher content must ALWAYS be targeted
    IF NEW.target_scope IS DISTINCT FROM 'targeted' THEN
      RAISE EXCEPTION 'Teacher content must have target_scope = targeted' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
      NEW.created_by := v_caller;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'Unauthorized: Cannot change content creator/ownership.' USING ERRCODE = '42501';
      END IF;
      IF NEW.target_scope IS DISTINCT FROM OLD.target_scope THEN
        RAISE EXCEPTION 'Unauthorized: Cannot change content audience scope.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_weekly_tests_invariants ON public.weekly_tests;
CREATE TRIGGER trg_weekly_tests_invariants
  BEFORE INSERT OR UPDATE ON public.weekly_tests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_content_targeting_invariants();

DROP TRIGGER IF EXISTS trg_daily_tasks_invariants ON public.daily_tasks;
CREATE TRIGGER trg_daily_tasks_invariants
  BEFORE INSERT OR UPDATE ON public.daily_tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_content_targeting_invariants();

DROP TRIGGER IF EXISTS trg_announcements_invariants ON public.announcements;
CREATE TRIGGER trg_announcements_invariants
  BEFORE INSERT OR UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_content_targeting_invariants();

DROP TRIGGER IF EXISTS trg_resources_invariants ON public.resources;
CREATE TRIGGER trg_resources_invariants
  BEFORE INSERT OR UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.enforce_content_targeting_invariants();

-- ------------------------------------------------------------------------------
-- 9b. Content & Recipient Security Helpers (SECURITY DEFINER)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_weekly_test_recipients(p_test_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.weekly_test_recipients
    WHERE test_id = p_test_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_weekly_test_recipient(p_test_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.weekly_test_recipients
    WHERE test_id = p_test_id AND student_id = p_student_id
  );
$$;

CREATE OR REPLACE FUNCTION public.has_daily_task_recipients(p_task_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_task_recipients
    WHERE task_id = p_task_id
  );
$$;

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

CREATE OR REPLACE FUNCTION public.has_announcement_recipients(p_announcement_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.announcement_recipients
    WHERE announcement_id = p_announcement_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_announcement_recipient(p_announcement_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.announcement_recipients
    WHERE announcement_id = p_announcement_id AND student_id = p_student_id
  );
$$;

CREATE OR REPLACE FUNCTION public.has_resource_recipients(p_resource_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.resource_recipients
    WHERE resource_id = p_resource_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_resource_recipient(p_resource_id UUID, p_student_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.resource_recipients
    WHERE resource_id = p_resource_id AND student_id = p_student_id
  );
$$;

CREATE OR REPLACE FUNCTION public.student_level(p_uid UUID)
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT level FROM public.profiles WHERE id = p_uid;
$$;

CREATE OR REPLACE FUNCTION public.is_weekly_test_creator(p_test_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.weekly_tests
    WHERE id = p_test_id AND created_by = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_daily_task_creator(p_task_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.daily_tasks
    WHERE id = p_task_id AND created_by = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_announcement_creator(p_announcement_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.announcements
    WHERE id = p_announcement_id AND created_by = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.is_resource_creator(p_resource_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.resources
    WHERE id = p_resource_id AND created_by = p_user_id
  );
$$;

-- ------------------------------------------------------------------------------
-- 10. RPC: teacher_save_attendance
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_save_attendance(
  p_session_id UUID,
  p_records JSONB,
  p_reason TEXT DEFAULT 'Teacher attendance entry'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_session RECORD;
  v_today DATE := public.today_ist();
  v_rec JSONB;
  v_student_id UUID;
  v_status TEXT;
  v_note TEXT;
  v_existing RECORD;
  v_is_update BOOLEAN;
  v_processed INT := 0;
BEGIN
  IF NOT public.is_teacher(v_caller) AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Teacher or admin access required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Attendance session not found.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_admin() THEN
    IF (v_session.session_date < (v_today - 7)) OR (v_session.session_date > v_today) THEN
      RAISE EXCEPTION 'Attendance window violation: Teachers may only mark or correct attendance from % to % (India time). Session is %.',
        (v_today - 7), v_today, v_session.session_date
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'Records must be a JSON array.' USING ERRCODE = '22023';
  END IF;

  -- Pre-validate every student is assigned before modifying any rows
  IF NOT public.is_admin() THEN
    FOR v_rec IN SELECT * FROM jsonb_array_elements(p_records) LOOP
      v_student_id := (v_rec->>'student_id')::UUID;
      IF NOT public.is_teacher_assigned_to_student(v_caller, v_student_id) THEN
        RAISE EXCEPTION 'Unauthorized: Student % is not assigned to this teacher.', v_student_id
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;

  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_records) LOOP
    v_student_id := (v_rec->>'student_id')::UUID;
    v_status := v_rec->>'status';
    v_note := NULLIF(TRIM(COALESCE(v_rec->>'note', '')), '');

    IF v_status NOT IN ('present', 'absent', 'excused') THEN
      RAISE EXCEPTION 'Invalid attendance status: %', v_status USING ERRCODE = '22023';
    END IF;

    SELECT id, status, note INTO v_existing
    FROM public.attendance
    WHERE session_id = p_session_id AND student_id = v_student_id
    FOR UPDATE;

    v_is_update := FOUND;

    IF v_is_update THEN
      IF NOT public.is_admin() THEN
        IF NOT public.has_teacher_permission(v_caller, 'correct_attendance') THEN
          RAISE EXCEPTION 'Permission denied: can_correct_attendance is required to modify attendance.'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      UPDATE public.attendance
      SET status = v_status, note = v_note, marked_by = v_caller, marked_at = now()
      WHERE id = v_existing.id;

      INSERT INTO public.attendance_audit (
        attendance_id, session_id, student_id, changed_by, action,
        old_status, new_status, old_note, new_note, reason
      ) VALUES (
        v_existing.id, p_session_id, v_student_id, v_caller, 'correct',
        v_existing.status, v_status, v_existing.note, v_note, p_reason
      );
    ELSE
      IF NOT public.is_admin() THEN
        IF NOT public.has_teacher_permission(v_caller, 'mark_attendance') THEN
          RAISE EXCEPTION 'Permission denied: can_mark_attendance is required to record attendance.'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      INSERT INTO public.attendance (session_id, student_id, status, note, marked_by, marked_at)
      VALUES (p_session_id, v_student_id, v_status, v_note, v_caller, now())
      RETURNING id INTO v_existing.id;

      INSERT INTO public.attendance_audit (
        attendance_id, session_id, student_id, changed_by, action,
        old_status, new_status, old_note, new_note, reason
      ) VALUES (
        v_existing.id, p_session_id, v_student_id, v_caller, 'mark',
        NULL, v_status, NULL, v_note, p_reason
      );
    END IF;

    v_processed := v_processed + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_processed);
END;
$$;

-- ------------------------------------------------------------------------------
-- 11. RPC: teacher_request_score_correction
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_request_score_correction(
  p_result_id UUID,
  p_table_name TEXT,
  p_proposed_correct INTEGER,
  p_proposed_total INTEGER,
  p_proposed_time_seconds INTEGER,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_res RECORD;
  v_student_id UUID;
  v_snapshot JSONB;
  v_req_id UUID;
BEGIN
  IF NOT public.is_teacher(v_caller) THEN
    RAISE EXCEPTION 'Unauthorized: Only teachers can submit score correction requests.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_teacher_permission(v_caller, 'request_corrections') THEN
    RAISE EXCEPTION 'Permission denied: can_request_corrections is disabled for your account.' USING ERRCODE = '42501';
  END IF;

  IF p_table_name IS DISTINCT FROM 'results' AND p_table_name IS DISTINCT FROM 'activity_results' THEN
    RAISE EXCEPTION 'Invalid table_name: must be results or activity_results.' USING ERRCODE = '22023';
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A clear explanation (at least 3 characters) is required for score corrections.' USING ERRCODE = '22023';
  END IF;

  IF p_table_name = 'results' THEN
    SELECT * INTO v_res FROM public.results WHERE id = p_result_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Practice result not found.' USING ERRCODE = 'P0002';
    END IF;
    v_student_id := v_res.student_id;
    v_snapshot := jsonb_build_object(
      'correct', v_res.correct,
      'total', v_res.total,
      'time_seconds', v_res.time_seconds,
      'category_id', v_res.category_id,
      'entry_date', v_res.entry_date,
      'verified', v_res.verified
    );
  ELSE
    SELECT * INTO v_res FROM public.activity_results WHERE id = p_result_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Activity result not found.' USING ERRCODE = 'P0002';
    END IF;
    v_student_id := v_res.student_id;
    v_snapshot := jsonb_build_object(
      'correct', v_res.correct,
      'total', v_res.total,
      'activity_type', v_res.activity_type,
      'activity_name', v_res.activity_name
    );
  END IF;

  IF NOT public.is_teacher_assigned_to_student(v_caller, v_student_id) THEN
    RAISE EXCEPTION 'Unauthorized: You can only request corrections for your assigned students.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.score_correction_requests (
    teacher_id, student_id, result_id, activity_result_id, table_name,
    original_score_snapshot, proposed_correct, proposed_total, proposed_time_seconds, reason
  ) VALUES (
    v_caller, v_student_id,
    CASE WHEN p_table_name = 'results' THEN p_result_id ELSE NULL END,
    CASE WHEN p_table_name = 'activity_results' THEN p_result_id ELSE NULL END,
    p_table_name,
    v_snapshot, p_proposed_correct, p_proposed_total, p_proposed_time_seconds, TRIM(p_reason)
  )
  RETURNING id INTO v_req_id;

  RETURN jsonb_build_object('success', true, 'request_id', v_req_id);
END;
$$;

-- ------------------------------------------------------------------------------
-- 12. RPC: admin_decide_score_correction
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_decide_score_correction(
  p_request_id UUID,
  p_action TEXT,
  p_decision_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_req RECORD;
  v_res RECORD;
  v_act_res RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: Only administrators can decide score correction requests.' USING ERRCODE = '42501';
  END IF;

  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Invalid action: must be approve or reject.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_req FROM public.score_correction_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Score correction request not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'Request is already decided (current status: %).', v_req.status USING ERRCODE = '23505';
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.score_correction_requests
    SET
      status = 'rejected',
      decided_by = v_admin_id,
      decided_at = now(),
      decision_note = NULLIF(TRIM(COALESCE(p_decision_note, '')), '')
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'status', 'rejected');
  END IF;

  IF v_req.table_name = 'results' THEN
    SELECT * INTO v_res FROM public.results WHERE id = v_req.result_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target score row no longer exists.' USING ERRCODE = 'P0002';
    END IF;

    -- Concurrency drift verification against snapshot
    IF (v_res.correct IS DISTINCT FROM (v_req.original_score_snapshot ->> 'correct')::INTEGER)
       OR (v_res.total IS DISTINCT FROM (v_req.original_score_snapshot ->> 'total')::INTEGER)
       OR (v_res.time_seconds IS DISTINCT FROM (v_req.original_score_snapshot ->> 'time_seconds')::INTEGER) THEN
      RAISE EXCEPTION 'Score modified since request was created. Fresh review is required.' USING ERRCODE = '40001';
    END IF;

    UPDATE public.results
    SET
      correct = COALESCE(v_req.proposed_correct, v_res.correct),
      total = COALESCE(v_req.proposed_total, v_res.total),
      time_seconds = COALESCE(v_req.proposed_time_seconds, v_res.time_seconds),
      corrected_by = v_req.teacher_id,
      corrected_at = now(),
      verified = true,
      verified_by = v_admin_id,
      verified_at = now()
    WHERE id = v_req.result_id;

    INSERT INTO public.result_audit (
      result_id, student_id, changed_by, action, old_values, new_values, reason
    ) VALUES (
      v_req.result_id,
      v_res.student_id,
      v_admin_id,
      'correct',
      v_req.original_score_snapshot,
      jsonb_build_object(
        'correct', COALESCE(v_req.proposed_correct, v_res.correct),
        'total', COALESCE(v_req.proposed_total, v_res.total),
        'time_seconds', COALESCE(v_req.proposed_time_seconds, v_res.time_seconds),
        'corrected_by', v_req.teacher_id,
        'approved_by', v_admin_id
      ),
      'Teacher request approved: ' || v_req.reason || COALESCE(' | Note: ' || p_decision_note, '')
    );
  ELSE
    SELECT * INTO v_act_res FROM public.activity_results WHERE id = v_req.activity_result_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target activity score row no longer exists.' USING ERRCODE = 'P0002';
    END IF;

    IF (v_act_res.correct IS DISTINCT FROM (v_req.original_score_snapshot ->> 'correct')::INTEGER)
       OR (v_act_res.total IS DISTINCT FROM (v_req.original_score_snapshot ->> 'total')::INTEGER) THEN
      RAISE EXCEPTION 'Activity score modified since request was created. Fresh review is required.' USING ERRCODE = '40001';
    END IF;

    UPDATE public.activity_results
    SET
      correct = COALESCE(v_req.proposed_correct, v_act_res.correct),
      total = COALESCE(v_req.proposed_total, v_act_res.total)
    WHERE id = v_req.activity_result_id;
  END IF;

  UPDATE public.score_correction_requests
  SET
    status = 'approved',
    decided_by = v_admin_id,
    decided_at = now(),
    decision_note = NULLIF(TRIM(COALESCE(p_decision_note, '')), '')
  WHERE id = p_request_id;

  RETURN jsonb_build_object('success', true, 'status', 'approved');
END;
$$;

-- ------------------------------------------------------------------------------
-- 13. RPC: teacher_verify_scores & teacher_flag_score
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_verify_scores(
  p_ids UUID[],
  p_verified BOOLEAN,
  p_reason TEXT DEFAULT 'Teacher verification'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_id UUID;
  v_row public.results%ROWTYPE;
  v_count INT := 0;
BEGIN
  IF NOT public.is_admin() THEN
    IF NOT public.is_teacher(v_caller) THEN
      RAISE EXCEPTION 'Unauthorized: Teacher or admin access required.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.has_teacher_permission(v_caller, 'review_scores') THEN
      RAISE EXCEPTION 'Permission denied: can_review_scores is disabled.' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Provide between 1 and 200 result IDs.' USING ERRCODE = '22023';
  END IF;

  -- Pre-validate all results belong to assigned students
  IF NOT public.is_admin() THEN
    FOREACH v_id IN ARRAY p_ids LOOP
      SELECT * INTO v_row FROM public.results WHERE id = v_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Result entry % not found.', v_id USING ERRCODE = 'P0002';
      END IF;
      IF NOT public.is_teacher_assigned_to_student(v_caller, v_row.student_id) THEN
        RAISE EXCEPTION 'Unauthorized: Result % belongs to an unassigned student.', v_id USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    SELECT * INTO v_row FROM public.results WHERE id = v_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.results
      SET
        verified = p_verified,
        verified_by = CASE WHEN p_verified THEN v_caller ELSE NULL END,
        verified_at = CASE WHEN p_verified THEN now() ELSE NULL END
      WHERE id = v_id;

      INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
      VALUES (
        v_id,
        v_row.student_id,
        v_caller,
        CASE WHEN p_verified THEN 'verify' ELSE 'unverify' END,
        jsonb_build_object('verified', v_row.verified),
        jsonb_build_object('verified', p_verified),
        COALESCE(NULLIF(TRIM(p_reason), ''), 'Teacher verification')
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'verified_count', v_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.teacher_flag_score(
  p_id UUID,
  p_flagged BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_row public.results%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    IF NOT public.is_teacher(v_caller) THEN
      RAISE EXCEPTION 'Unauthorized: Teacher or admin access required.' USING ERRCODE = '42501';
    END IF;
    IF NOT public.has_teacher_permission(v_caller, 'review_scores') THEN
      RAISE EXCEPTION 'Permission denied: can_review_scores is disabled.' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.results WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Result entry not found.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_admin() THEN
    IF NOT public.is_teacher_assigned_to_student(v_caller, v_row.student_id) THEN
      RAISE EXCEPTION 'Unauthorized: Student is not assigned to you.' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.results
  SET
    flagged = p_flagged,
    flag_note = CASE WHEN p_flagged THEN NULLIF(TRIM(p_note), '') ELSE NULL END
  WHERE id = p_id;

  INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
  VALUES (
    p_id,
    v_row.student_id,
    v_caller,
    CASE WHEN p_flagged THEN 'flag' ELSE 'unflag' END,
    jsonb_build_object('flagged', v_row.flagged, 'flag_note', v_row.flag_note),
    jsonb_build_object('flagged', p_flagged, 'flag_note', CASE WHEN p_flagged THEN NULLIF(TRIM(p_note), '') ELSE NULL END),
    COALESCE(NULLIF(TRIM(p_note), ''), CASE WHEN p_flagged THEN 'Flagged by teacher' ELSE 'Flag cleared' END)
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ------------------------------------------------------------------------------
-- 14. RPC: save_weekly_test_sections_atomic (Teacher & Recipient Integration)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]);

CREATE OR REPLACE FUNCTION public.save_weekly_test_sections_atomic(
  p_test_id UUID,
  p_test JSONB,
  p_sections JSONB,
  p_recipients UUID[] DEFAULT NULL
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
  v_seen_cat_ids UUID[] := ARRAY[]::UUID[];
  v_seen_act_keys TEXT[] := ARRAY[]::TEXT[];
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

  -- Set positions to temporary negative values to avoid collision during reordering
  UPDATE public.weekly_test_sections
  SET position = -position
  WHERE test_id = v_existing_test_id;

  -- Upsert sections
  FOR i IN 0..(v_sec_count - 1) LOOP
    v_sec := p_sections->i;
    v_pos := i + 1;
    v_kind := TRIM(COALESCE(v_sec->>'kind', 'basics'));
    IF v_kind NOT IN ('basics', 'elements', 'flash', 'memoriad', 'offline') THEN
      RAISE EXCEPTION 'Invalid section kind "%"', v_kind USING ERRCODE = '22023';
    END IF;

    v_sec_id := NULLIF(TRIM(COALESCE(v_sec->>'id', '')), '')::UUID;
    IF v_sec_id IS NULL THEN
      v_sec_id := gen_random_uuid();
    END IF;
    v_incoming_ids := array_append(v_incoming_ids, v_sec_id);

    v_raw_cat := NULLIF(TRIM(COALESCE(v_sec->>'category_id', '')), '');
    v_cat_id := v_raw_cat::UUID;

    v_seconds := NULLIF(TRIM(COALESCE(v_sec->>'seconds', '')), '')::INT;
    v_activity_key := NULLIF(TRIM(COALESCE(v_sec->>'activity_key', '')), '');
    v_flash_digits := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_digits', '')), '')::INT, 1);
    v_flash_count := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_count', '')), '')::INT, 20);
    v_flash_speed_ms := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'flash_speed_ms', '')), '')::INT, 800);
    v_flash_mode := TRIM(COALESCE(v_sec->>'flash_mode', 'add'));
    v_question_count := COALESCE(NULLIF(TRIM(COALESCE(v_sec->>'question_count', '')), '')::INT, 5);

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

-- ------------------------------------------------------------------------------
-- 14b. RPC: save_announcement_atomic (Fail-Closed Teacher Recipients)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_announcement_atomic(UUID, JSONB, UUID[]);
CREATE OR REPLACE FUNCTION public.save_announcement_atomic(
  p_announcement_id UUID,
  p_announcement JSONB,
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
  v_body TEXT;
  v_audience_level TEXT;
  v_starts_at TIMESTAMPTZ;
  v_expires_at TIMESTAMPTZ;
  v_existing_created_by UUID;
  v_ann_id UUID;
  v_deduped_recipients UUID[] := ARRAY[]::UUID[];
  v_rec_count INT := 0;
BEGIN
  -- Authorization check
  IF public.is_admin() OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_is_admin := true;
  ELSIF public.is_teacher(v_caller) THEN
    IF NOT public.has_teacher_permission(v_caller, 'publish_announcements') THEN
      RAISE EXCEPTION 'Unauthorized: Teacher does not have can_publish_announcements permission.'
        USING ERRCODE = '42501';
    END IF;
    v_is_admin := false;
  ELSE
    RAISE EXCEPTION 'Unauthorized: Only administrators or authorized teachers can save announcements.'
      USING ERRCODE = '42501';
  END IF;

  -- Validate announcement payload
  IF p_announcement IS NULL OR jsonb_typeof(p_announcement) <> 'object' THEN
    RAISE EXCEPTION 'Invalid announcement payload: must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_title := TRIM(COALESCE(p_announcement->>'title', ''));
  v_body := TRIM(COALESCE(p_announcement->>'body', ''));
  v_audience_level := NULLIF(TRIM(COALESCE(p_announcement->>'audience_level', '')), '');
  
  IF v_title = '' THEN
    RAISE EXCEPTION 'Announcement title is required.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_title) > 80 THEN
    RAISE EXCEPTION 'Announcement title must not exceed 80 characters.' USING ERRCODE = '22023';
  END IF;

  IF v_body = '' THEN
    RAISE EXCEPTION 'Announcement message body is required.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_body) > 500 THEN
    RAISE EXCEPTION 'Announcement message body must not exceed 500 characters.' USING ERRCODE = '22023';
  END IF;

  IF p_announcement->>'starts_at' IS NOT NULL AND TRIM(p_announcement->>'starts_at') <> '' THEN
    v_starts_at := (p_announcement->>'starts_at')::TIMESTAMPTZ;
  ELSE
    v_starts_at := now();
  END IF;

  IF p_announcement->>'expires_at' IS NOT NULL AND TRIM(p_announcement->>'expires_at') <> '' THEN
    v_expires_at := (p_announcement->>'expires_at')::TIMESTAMPTZ;
    IF v_expires_at <= v_starts_at THEN
      RAISE EXCEPTION 'Announcement expires_at must be after starts_at.' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_expires_at := NULL;
  END IF;

  -- Edit ownership check
  IF p_announcement_id IS NOT NULL THEN
    SELECT created_by INTO v_existing_created_by
    FROM public.announcements
    WHERE id = p_announcement_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Announcement with id % not found.', p_announcement_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_is_admin AND v_existing_created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only edit announcements they created.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Recipient validation: Deduplicate and strip NULLs
  IF p_recipients IS NOT NULL AND cardinality(p_recipients) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_recipients
    FROM unnest(p_recipients) AS sid
    WHERE sid IS NOT NULL;
  END IF;

  -- Fail-closed for teachers: Must specify at least one recipient
  IF NOT v_is_admin THEN
    IF v_deduped_recipients IS NULL OR cardinality(v_deduped_recipients) = 0 THEN
      RAISE EXCEPTION 'Targeted recipients required: Teachers must specify at least one recipient.'
        USING ERRCODE = '22023';
    END IF;

    -- Enforce all recipients are active students AND assigned to the teacher
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT public.is_teacher_assigned_to_student(v_caller, sid)
    ) THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only assign announcements to their assigned students.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- If recipients provided, validate they are active students
  IF v_deduped_recipients IS NOT NULL AND cardinality(v_deduped_recipients) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid recipient: All announcement recipients must be active students.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Upsert announcement row
  IF p_announcement_id IS NOT NULL THEN
    v_ann_id := p_announcement_id;
    UPDATE public.announcements
    SET title = v_title,
        body = v_body,
        audience_level = v_audience_level,
        starts_at = v_starts_at,
        expires_at = v_expires_at,
        target_scope = CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    WHERE id = v_ann_id;
  ELSE
    v_ann_id := gen_random_uuid();
    INSERT INTO public.announcements (
      id, title, body, audience_level, starts_at, expires_at, created_by, target_scope
    ) VALUES (
      v_ann_id, v_title, v_body, v_audience_level, v_starts_at, v_expires_at, v_caller,
      CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    );
  END IF;

  -- Sync recipients atomically
  IF NOT v_is_admin OR p_recipients IS NOT NULL THEN
    DELETE FROM public.announcement_recipients WHERE announcement_id = v_ann_id;
    IF cardinality(v_deduped_recipients) > 0 THEN
      INSERT INTO public.announcement_recipients (announcement_id, student_id)
      SELECT v_ann_id, sid FROM unnest(v_deduped_recipients) AS sid;
      v_rec_count := cardinality(v_deduped_recipients);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_ann_id,
    'recipient_count', v_rec_count
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 14c. RPC: save_resource_atomic (Fail-Closed Teacher Recipients)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_resource_atomic(UUID, JSONB, UUID[]);
CREATE OR REPLACE FUNCTION public.save_resource_atomic(
  p_resource_id UUID,
  p_resource JSONB,
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
  v_url TEXT;
  v_topic TEXT;
  v_description TEXT;
  v_audience_level TEXT;
  v_active BOOLEAN;
  v_sort_order INT;
  v_existing_created_by UUID;
  v_res_id UUID;
  v_deduped_recipients UUID[] := ARRAY[]::UUID[];
  v_rec_count INT := 0;
BEGIN
  -- Authorization check
  IF public.is_admin() OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_is_admin := true;
  ELSIF public.is_teacher(v_caller) THEN
    IF NOT public.has_teacher_permission(v_caller, 'manage_resources') THEN
      RAISE EXCEPTION 'Unauthorized: Teacher does not have can_manage_resources permission.'
        USING ERRCODE = '42501';
    END IF;
    v_is_admin := false;
  ELSE
    RAISE EXCEPTION 'Unauthorized: Only administrators or authorized teachers can save resources.'
      USING ERRCODE = '42501';
  END IF;

  -- Validate resource payload
  IF p_resource IS NULL OR jsonb_typeof(p_resource) <> 'object' THEN
    RAISE EXCEPTION 'Invalid resource payload: must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_title := TRIM(COALESCE(p_resource->>'title', ''));
  v_url := TRIM(COALESCE(p_resource->>'url', ''));
  v_topic := TRIM(COALESCE(p_resource->>'topic', 'General'));
  IF v_topic = '' THEN v_topic := 'General'; END IF;
  v_description := NULLIF(TRIM(COALESCE(p_resource->>'description', '')), '');
  v_audience_level := NULLIF(TRIM(COALESCE(p_resource->>'audience_level', '')), '');
  v_active := COALESCE((p_resource->>'active')::BOOLEAN, true);

  IF v_title = '' THEN
    RAISE EXCEPTION 'Resource title is required.' USING ERRCODE = '22023';
  END IF;
  IF v_url = '' THEN
    RAISE EXCEPTION 'Resource URL is required.' USING ERRCODE = '22023';
  END IF;

  -- Edit ownership check
  IF p_resource_id IS NOT NULL THEN
    SELECT created_by INTO v_existing_created_by
    FROM public.resources
    WHERE id = p_resource_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Resource with id % not found.', p_resource_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_is_admin AND v_existing_created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only edit resources they created.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Recipient validation: Deduplicate and strip NULLs
  IF p_recipients IS NOT NULL AND cardinality(p_recipients) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_recipients
    FROM unnest(p_recipients) AS sid
    WHERE sid IS NOT NULL;
  END IF;

  -- Fail-closed for teachers: Must specify at least one recipient
  IF NOT v_is_admin THEN
    IF v_deduped_recipients IS NULL OR cardinality(v_deduped_recipients) = 0 THEN
      RAISE EXCEPTION 'Targeted recipients required: Teachers must specify at least one recipient.'
        USING ERRCODE = '22023';
    END IF;

    -- Enforce all recipients are active students AND assigned to the teacher
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT public.is_teacher_assigned_to_student(v_caller, sid)
    ) THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only assign resources to their assigned students.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- If recipients provided, validate they are active students
  IF v_deduped_recipients IS NOT NULL AND cardinality(v_deduped_recipients) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid recipient: All resource recipients must be active students.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Upsert resource row
  IF p_resource_id IS NOT NULL THEN
    v_res_id := p_resource_id;
    UPDATE public.resources
    SET title = v_title,
        url = v_url,
        topic = v_topic,
        description = v_description,
        audience_level = v_audience_level,
        active = v_active,
        target_scope = CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    WHERE id = v_res_id;
  ELSE
    v_res_id := gen_random_uuid();
    v_sort_order := COALESCE(
      (p_resource->>'sort_order')::INT,
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.resources)
    );
    INSERT INTO public.resources (
      id, title, url, topic, description, audience_level, sort_order, active, created_by, target_scope
    ) VALUES (
      v_res_id, v_title, v_url, v_topic, v_description, v_audience_level, v_sort_order, v_active, v_caller,
      CASE WHEN NOT v_is_admin OR cardinality(v_deduped_recipients) > 0 THEN 'targeted' ELSE 'all' END
    );
  END IF;

  -- Sync recipients atomically
  IF NOT v_is_admin OR p_recipients IS NOT NULL THEN
    DELETE FROM public.resource_recipients WHERE resource_id = v_res_id;
    IF cardinality(v_deduped_recipients) > 0 THEN
      INSERT INTO public.resource_recipients (resource_id, student_id)
      SELECT v_res_id, sid FROM unnest(v_deduped_recipients) AS sid;
      v_rec_count := cardinality(v_deduped_recipients);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_res_id,
    'recipient_count', v_rec_count
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 14d. RPC: save_daily_task_atomic (Fail-Closed Teacher Recipients)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.save_daily_task_atomic(UUID, JSONB, UUID[]);
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
  v_existing_created_by UUID;
  v_task_id UUID;
  v_activity_key TEXT;
  v_flash_digits INT;
  v_flash_count INT;
  v_flash_speed_ms INT;
  v_flash_mode TEXT;
  v_required_count INT;
  v_deduped_recipients UUID[] := ARRAY[]::UUID[];
  v_rec_count INT := 0;
BEGIN
  -- Authorization check
  IF public.is_admin() OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_is_admin := true;
  ELSIF public.is_teacher(v_caller) THEN
    IF NOT public.has_teacher_permission(v_caller, 'manage_tasks') THEN
      RAISE EXCEPTION 'Unauthorized: Teacher does not have can_manage_tasks permission.'
        USING ERRCODE = '42501';
    END IF;
    v_is_admin := false;
  ELSE
    RAISE EXCEPTION 'Unauthorized: Only administrators or authorized teachers can save daily tasks.'
      USING ERRCODE = '42501';
  END IF;

  -- Validate task payload
  IF p_task IS NULL OR jsonb_typeof(p_task) <> 'object' THEN
    RAISE EXCEPTION 'Invalid task payload: must be a JSON object.' USING ERRCODE = '22023';
  END IF;

  v_title := TRIM(COALESCE(p_task->>'title', ''));
  v_section := TRIM(COALESCE(p_task->>'section', ''));
  v_level := NULLIF(TRIM(COALESCE(p_task->>'level', '')), '');
  v_active := COALESCE((p_task->>'active')::BOOLEAN, true);
  v_activity_key := NULLIF(TRIM(COALESCE(p_task->>'activity_key', '')), '');
  v_flash_digits := NULLIF(TRIM(COALESCE(p_task->>'flash_digits', '')), '')::INT;
  v_flash_count := NULLIF(TRIM(COALESCE(p_task->>'flash_count', '')), '')::INT;
  v_flash_speed_ms := NULLIF(TRIM(COALESCE(p_task->>'flash_speed_ms', '')), '')::INT;
  v_flash_mode := NULLIF(TRIM(COALESCE(p_task->>'flash_mode', '')), '');
  v_required_count := COALESCE(NULLIF(TRIM(COALESCE(p_task->>'required_count', '')), '')::INT, 1);

  IF p_task->>'category_id' IS NOT NULL AND TRIM(p_task->>'category_id') <> '' THEN
    v_cat_id := (p_task->>'category_id')::UUID;
  ELSE
    v_cat_id := NULL;
  END IF;

  IF v_title = '' THEN
    RAISE EXCEPTION 'Daily task title is required.' USING ERRCODE = '22023';
  END IF;
  IF v_section = '' THEN
    RAISE EXCEPTION 'Daily task section is required.' USING ERRCODE = '22023';
  END IF;

  -- Edit ownership check
  IF p_task_id IS NOT NULL THEN
    SELECT created_by INTO v_existing_created_by
    FROM public.daily_tasks
    WHERE id = p_task_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Daily task with id % not found.', p_task_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT v_is_admin AND v_existing_created_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only edit daily tasks they created.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Recipient validation: Deduplicate and strip NULLs
  IF p_recipients IS NOT NULL AND cardinality(p_recipients) > 0 THEN
    SELECT array_agg(DISTINCT sid) INTO v_deduped_recipients
    FROM unnest(p_recipients) AS sid
    WHERE sid IS NOT NULL;
  END IF;

  -- Fail-closed for teachers: Must specify at least one recipient
  IF NOT v_is_admin THEN
    IF v_deduped_recipients IS NULL OR cardinality(v_deduped_recipients) = 0 THEN
      RAISE EXCEPTION 'Targeted recipients required: Teachers must specify at least one recipient.'
        USING ERRCODE = '22023';
    END IF;

    -- Enforce all recipients are active students AND assigned to the teacher
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT public.is_teacher_assigned_to_student(v_caller, sid)
    ) THEN
      RAISE EXCEPTION 'Unauthorized: Teachers may only assign daily tasks to their assigned students.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- If recipients provided, validate they are active students
  IF v_deduped_recipients IS NOT NULL AND cardinality(v_deduped_recipients) > 0 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_deduped_recipients) AS sid
      WHERE NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = sid AND role = 'student' AND active = true
      )
    ) THEN
      RAISE EXCEPTION 'Invalid recipient: All task recipients must be active students.'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  -- Upsert daily task row
  IF p_task_id IS NOT NULL THEN
    v_task_id := p_task_id;
    UPDATE public.daily_tasks
    SET title = v_title,
        section = v_section,
        category_id = v_cat_id,
        level = v_level,
        activity_key = v_activity_key,
        flash_digits = v_flash_digits,
        flash_count = v_flash_count,
        flash_speed_ms = v_flash_speed_ms,
        flash_mode = v_flash_mode,
        required_count = v_required_count,
        active = v_active,
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
      sort_order, active, created_by, target_scope
    ) VALUES (
      v_task_id, v_title, v_section, v_cat_id, v_level, v_activity_key,
      v_flash_digits, v_flash_count, v_flash_speed_ms, v_flash_mode, v_required_count,
      v_sort_order, v_active, v_caller,
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
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id', v_task_id,
    'recipient_count', v_rec_count
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 15. RPC: weekly_test_reserve_section_start (Targeted Recipient Enforcement)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_test_reserve_section_start(
  p_test_id UUID,
  p_student_id UUID,
  p_section_id UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_student RECORD;
  v_test RECORD;
  v_sec RECORD;
  v_score RECORD;
  v_att RECORD;
  v_claim_token UUID := gen_random_uuid();
  v_attempt_id UUID;
  v_cat_name TEXT := NULL;
  v_prev_tries_started INT := 0;
  v_next_try_no INT := 1;
  v_is_first_start BOOLEAN := FALSE;
BEGIN
  -- ----------------------------------------------------------------------------
  -- Step 1: Authorization & Profile Validation
  -- ----------------------------------------------------------------------------
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_student_id AND NOT public.is_admin() AND COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized: caller cannot reserve section for another student'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, role, level, active INTO v_student
  FROM public.profiles
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile % not found', p_student_id
      USING ERRCODE = '23503';
  END IF;

  IF v_student.role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'Profile % is not a student (role: %)', p_student_id, v_student.role
      USING ERRCODE = '22023';
  END IF;

  IF v_student.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Student account % is inactive', p_student_id
      USING ERRCODE = '22023';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 2: Parent Test Existence & Coordination Lock
  -- ----------------------------------------------------------------------------
  SELECT * INTO v_test
  FROM public.weekly_tests
  WHERE id = p_test_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Weekly test % not found', p_test_id
      USING ERRCODE = '23503';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 3: Eligibility Checks (Online, Window, Audience Level & Recipient Scope)
  -- ----------------------------------------------------------------------------
  IF v_test.test_type IS DISTINCT FROM 'online' THEN
    RAISE EXCEPTION 'This weekly test is an offline test and cannot be taken online'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.opens_at IS NOT NULL AND NOW() < v_test.opens_at THEN
    RAISE EXCEPTION 'This weekly test has not opened yet'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.closes_at IS NOT NULL AND NOW() > v_test.closes_at THEN
    RAISE EXCEPTION 'This weekly test has closed'
      USING ERRCODE = '22023';
  END IF;

  IF v_test.opens_at IS NULL AND v_test.closes_at IS NULL THEN
    IF v_test.test_date > public.today_ist() THEN
      RAISE EXCEPTION 'This weekly test has not opened yet'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Targeted Recipient Enforcement (Durable audience scope):
  IF v_test.target_scope = 'targeted' OR public.has_weekly_test_recipients(p_test_id) THEN
    IF NOT public.is_weekly_test_recipient(p_test_id, p_student_id) THEN
      RAISE EXCEPTION 'You are not assigned to this weekly test' USING ERRCODE = '42501';
    END IF;
  ELSIF v_test.audience_level IS NOT NULL AND TRIM(v_test.audience_level) <> '' AND LOWER(TRIM(v_test.audience_level)) <> 'everyone' THEN
    IF LOWER(TRIM(v_test.audience_level)) IS DISTINCT FROM LOWER(TRIM(COALESCE(v_student.level, ''))) THEN
      RAISE EXCEPTION 'This weekly test is assigned to % students only', v_test.audience_level
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 4: Resolve & Row-Level Lock Section
  -- ----------------------------------------------------------------------------
  IF p_section_id IS NOT NULL THEN
    SELECT * INTO v_sec
    FROM public.weekly_test_sections
    WHERE id = p_section_id AND test_id = p_test_id
    FOR UPDATE;
  ELSIF p_category_id IS NOT NULL THEN
    SELECT * INTO v_sec
    FROM public.weekly_test_sections
    WHERE category_id = p_category_id AND test_id = p_test_id
    FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Either section_id or category_id must be provided'
      USING ERRCODE = '22023';
  END IF;

  IF v_sec.id IS NULL THEN
    RAISE EXCEPTION 'Section not found in weekly test %', p_test_id
      USING ERRCODE = '23503';
  END IF;

  IF v_sec.kind = 'round' THEN
    RAISE EXCEPTION 'Round sections are available for offline tests only'
      USING ERRCODE = '22023';
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 5: Duplicate-Start & Attempt Limit Protection
  -- ----------------------------------------------------------------------------
  -- Check completed scores (non-Flash sections only have 1 score row)
  SELECT * INTO v_score
  FROM public.weekly_test_scores
  WHERE test_id = p_test_id
    AND student_id = p_student_id
    AND section_id = v_sec.id;

  IF FOUND AND v_sec.kind <> 'flash' THEN
    RAISE EXCEPTION 'You have already completed this section'
      USING ERRCODE = '23505';
  END IF;

  -- Row-lock existing attempt
  SELECT * INTO v_att
  FROM public.weekly_test_attempts
  WHERE test_id = p_test_id
    AND student_id = p_student_id
    AND section_id = v_sec.id
  FOR UPDATE;

  IF v_sec.kind = 'flash' THEN
    IF FOUND THEN
      IF v_att.status = 'submitted' THEN
        RAISE EXCEPTION 'You have already completed all tries for this section'
          USING ERRCODE = '23505';
      END IF;

      -- Check if an active try claim is currently in progress
      IF v_att.claim_token IS NOT NULL THEN
        IF v_att.session_id IS NOT NULL THEN
          RAISE EXCEPTION 'A try is currently in progress for this section'
            USING ERRCODE = '23505';
        ELSE
          IF v_att.updated_at < NOW() - INTERVAL '60 seconds' THEN
            -- Reclaim stale unlinked reservation
            v_att.tries_started := GREATEST(0, v_att.tries_started - 1);
          ELSE
            RAISE EXCEPTION 'A try reservation is currently in progress for this section'
              USING ERRCODE = '23505';
          END IF;
        END IF;
      END IF;

      IF COALESCE(v_att.tries_started, 0) >= COALESCE(v_sec.question_count, 5) THEN
        RAISE EXCEPTION 'You have already completed all tries for this section'
          USING ERRCODE = '23505';
      END IF;

      v_is_first_start := FALSE;
      v_attempt_id := v_att.id;
      v_prev_tries_started := COALESCE(v_att.tries_started, 0);
      v_next_try_no := LEAST(COALESCE(v_sec.question_count, 5), v_prev_tries_started + 1);

      -- Atomically claim the next try
      UPDATE public.weekly_test_attempts
      SET tries_started = v_next_try_no,
          claim_token = v_claim_token,
          session_id = NULL,
          updated_at = NOW()
      WHERE id = v_att.id;
    ELSE
      v_is_first_start := TRUE;
      v_prev_tries_started := 0;
      v_next_try_no := 1;

      -- Atomically claim try 1 on insert
      INSERT INTO public.weekly_test_attempts (
        test_id,
        student_id,
        section_id,
        category_id,
        status,
        tries_started,
        tries_correct,
        seconds_used,
        claim_token,
        started_at,
        updated_at
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        'started',
        1,
        0,
        0,
        v_claim_token,
        NOW(),
        NOW()
      ) RETURNING id INTO v_attempt_id;

      INSERT INTO public.weekly_test_scores (
        test_id,
        student_id,
        section_id,
        category_id,
        correct,
        total,
        time_seconds,
        source
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        0,
        COALESCE(v_sec.question_count, 5),
        0,
        'online'
      )
      ON CONFLICT (test_id, student_id, section_id) DO NOTHING;
    END IF;
  ELSE
    -- Single-try kinds: basics, elements, memoriad
    IF FOUND THEN
      IF v_att.status = 'submitted' THEN
        RAISE EXCEPTION 'You have already completed this section'
          USING ERRCODE = '23505';
      END IF;

      IF v_att.session_id IS NOT NULL THEN
        RAISE EXCEPTION 'You have already started this section'
          USING ERRCODE = '23505';
      END IF;

      -- Interrupted, unlinked reservation (session_id IS NULL and status <> 'submitted')
      IF v_att.updated_at < NOW() - INTERVAL '60 seconds' THEN
        -- Bounded recovery: reclaim stale unlinked reservation and rotate claim token
        v_is_first_start := TRUE;
        v_prev_tries_started := 0;
        v_next_try_no := 1;
        v_attempt_id := v_att.id;

        UPDATE public.weekly_test_attempts
        SET claim_token = v_claim_token,
            started_at = NOW(),
            updated_at = NOW(),
            status = 'started'
        WHERE id = v_att.id;
      ELSE
        RAISE EXCEPTION 'A start reservation is currently in progress for this section'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      v_is_first_start := TRUE;
      v_prev_tries_started := 0;
      v_next_try_no := 1;

      INSERT INTO public.weekly_test_attempts (
        test_id,
        student_id,
        section_id,
        category_id,
        status,
        tries_started,
        claim_token,
        started_at,
        updated_at
      ) VALUES (
        p_test_id,
        p_student_id,
        v_sec.id,
        v_sec.category_id,
        'started',
        1,
        v_claim_token,
        NOW(),
        NOW()
      ) RETURNING id INTO v_attempt_id;
    END IF;
  END IF;

  -- ----------------------------------------------------------------------------
  -- Step 6: Capture Authoritative Settings & Return
  -- ----------------------------------------------------------------------------
  IF v_sec.category_id IS NOT NULL THEN
    SELECT name INTO v_cat_name
    FROM public.categories
    WHERE id = v_sec.category_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt_id,
    'claim_token', v_claim_token,
    'test_id', p_test_id,
    'test_title', v_test.title,
    'section_id', v_sec.id,
    'kind', v_sec.kind,
    'category_id', v_sec.category_id,
    'category_name', v_cat_name,
    'seconds', v_sec.seconds,
    'activity_key', v_sec.activity_key,
    'flash_digits', v_sec.flash_digits,
    'flash_count', v_sec.flash_count,
    'flash_speed_ms', v_sec.flash_speed_ms,
    'flash_mode', v_sec.flash_mode,
    'question_count', v_sec.question_count,
    'tries_started', v_prev_tries_started,
    'next_try_no', v_next_try_no,
    'is_first_start', v_is_first_start
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 16. Reporting & Progression RPCs (Preserving Migration 11 Contract Exactly)
-- ------------------------------------------------------------------------------

-- 16a. student_month_report (Exact deployed implementation preserved with teacher authorization)
CREATE OR REPLACE FUNCTION public.student_month_report(
  p_student UUID,
  p_month DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_from date := date_trunc('month', COALESCE(p_month, public.today_ist()))::date;
  v_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) + interval '1 month' - interval '1 day')::date;
  v_prev_from date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 month')::date;
  v_prev_to date := (date_trunc('month', COALESCE(p_month, public.today_ist())) - interval '1 day')::date;
  v_name text;
  v_code text;
  v_level text;
  v_att record;
  v_streak record;
  v_ps record;
  v_pp record;
BEGIN
  IF auth.uid() IS NULL OR (
    p_student <> auth.uid()
    AND NOT public.is_admin()
    AND NOT (
      public.is_teacher(auth.uid())
      AND public.has_teacher_permission(auth.uid(), 'generate_reports')
      AND public.is_teacher_assigned_to_student(auth.uid(), p_student)
    )
  ) THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own monthly report or reports of assigned students.' USING ERRCODE = '42501';
  END IF;

  SELECT p.full_name, p.student_code, p.level INTO v_name, v_code, v_level
    FROM public.profiles p WHERE p.id = p_student AND p.role = 'student';
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found'; END IF;

  SELECT * INTO v_att FROM public.attendance_summary(p_student, v_from, v_to);
  SELECT * INTO v_streak FROM public.streak_calc(p_student);
  SELECT * INTO v_ps FROM public.practice_stats_for(p_student, v_from, v_to);
  SELECT * INTO v_pp FROM public.practice_stats_for(p_student, v_prev_from, v_prev_to);

  RETURN jsonb_build_object(
    'student', jsonb_build_object('name', v_name, 'code', v_code, 'level', v_level),
    'month_start', v_from,
    'month_end', v_to,
    'days_elapsed', GREATEST(0, LEAST(v_to, public.today_ist()) - v_from + 1),
    'practice', jsonb_build_object(
      'entries', v_ps.n_entries, 'correct', v_ps.n_correct, 'total', v_ps.n_total,
      'accuracy', v_ps.accuracy_pct, 'qpm', v_ps.qpm, 'rounds', v_ps.n_rounds,
      'practice_days', public.practice_days_for(p_student, v_from, v_to)),
    'previous', jsonb_build_object(
      'entries', v_pp.n_entries, 'accuracy', v_pp.accuracy_pct, 'qpm', v_pp.qpm,
      'practice_days', public.practice_days_for(p_student, v_prev_from, v_prev_to)),
    'streak', jsonb_build_object('current', v_streak.current_streak, 'best', v_streak.best_streak),
    'attendance', jsonb_build_object(
      'present', v_att.present_count, 'absent', v_att.absent_count,
      'excused', v_att.excused_count, 'percent', v_att.attendance_pct),
    'points', public.points_for(p_student, v_from, v_to),
    'weeks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('week_start', w.ws, 'entries', w.n, 'accuracy', w.acc) ORDER BY w.ws)
        FROM (
          SELECT date_trunc('week', r.entry_date)::date AS ws,
                 count(*) AS n,
                 round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc
            FROM public.results r
           WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
             AND r.total > 0 AND r.correct IS NOT NULL
           GROUP BY 1
        ) w), '[]'::jsonb),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', c.name, 'section', c.section, 'entries', x.n,
                                          'accuracy', x.acc, 'wrong', x.wrong) ORDER BY x.acc, c.name)
        FROM (
          SELECT r.category_id,
                 count(*) AS n,
                 round(100.0 * sum(r.correct) / sum(r.total), 1) AS acc,
                 sum(r.total - r.correct) AS wrong
            FROM public.results r
           WHERE r.student_id = p_student AND r.entry_date BETWEEN v_from AND v_to
             AND r.total > 0 AND r.correct IS NOT NULL
           GROUP BY r.category_id
          HAVING count(*) >= 3
        ) x
        JOIN public.categories c ON c.id = x.category_id), '[]'::jsonb),
    'targets', (
      SELECT jsonb_build_object(
               'measured', count(*) FILTER (WHERE t.meets_target IS NOT NULL),
               'met', count(*) FILTER (WHERE t.meets_target IS TRUE))
        FROM public.results_with_target t
       WHERE t.student_id = p_student AND t.entry_date BETWEEN v_from AND v_to),
    'weekly_tests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'title', t.title,
        'date', t.test_date,
        'category', COALESCE(
          c.name,
          CASE sec.kind
            WHEN 'elements' THEN
              CASE sec.activity_key
                WHEN 'squares_stage_1' THEN 'Square - Stage 1 (1-25)'
                WHEN 'squares_stage_2' THEN 'Square - Stage 2 (26-50)'
                WHEN 'squares_stage_3' THEN 'Square - Stage 3 (51-75)'
                WHEN 'squares_stage_4' THEN 'Square - Stage 4 (76-100)'
                WHEN 'squares_combined' THEN 'Square - Combined (1-100)'
                WHEN 'cubes_stage_1' THEN 'Cube - Stage 1 (1-25)'
                WHEN 'cubes_stage_2' THEN 'Cube - Stage 2 (26-50)'
                WHEN 'cubes_stage_3' THEN 'Cube - Stage 3 (51-75)'
                WHEN 'cubes_stage_4' THEN 'Cube - Stage 4 (76-100)'
                WHEN 'cubes_combined' THEN 'Cube - Combined (1-100)'
                WHEN 'day_codes' THEN 'Day Codes'
                WHEN 'month_codes' THEN 'Month Codes'
                WHEN 'century_codes' THEN 'Century Codes'
                WHEN 'time_conversion' THEN 'Conversion in Seconds'
                WHEN 'divide_by_4' THEN 'Division by 4'
                WHEN 'divide_by_7' THEN 'Division by 7'
                WHEN 'prime_factors' THEN 'Prime Factor'
                WHEN 'modulo' THEN 'Modulo Calculation'
                WHEN 'ratio' THEN 'Ratio'
                WHEN 'days_to_seconds' THEN 'Days --> Seconds'
                WHEN 'hours_to_seconds' THEN 'Hours --> Seconds'
                WHEN 'minutes_to_seconds' THEN 'Minutes --> Seconds'
                WHEN 'number_to_be_squared' THEN 'Number To Be Squared'
                WHEN 'squares_3d_4d' THEN '3D - 4D Square'
                ELSE COALESCE(INITCAP(REPLACE(sec.activity_key, '_', ' ')), 'Elements')
              END
            WHEN 'memoriad' THEN
              CASE sec.activity_key
                WHEN 'calendar' THEN 'Mental Calendar Dates'
                WHEN 'additions' THEN 'Mental Additions'
                WHEN 'multiplications' THEN 'Mental Multiplications'
                WHEN 'square_roots' THEN 'Mental Square Roots'
                ELSE COALESCE(INITCAP(REPLACE(sec.activity_key, '_', ' ')), 'Memoriad')
              END
            WHEN 'flash' THEN
              CASE
                WHEN sec.flash_digits IS NOT NULL AND sec.flash_count IS NOT NULL
                  THEN 'Flash Anzan (' || sec.flash_digits || 'D ' || sec.flash_count || 'N)'
                ELSE 'Flash Anzan'
              END
            ELSE COALESCE(INITCAP(sec.kind), 'General')
          END
        ),
        'correct', s.correct,
        'total', s.total,
        'time_seconds', s.time_seconds
      ) ORDER BY t.test_date, COALESCE(c.sort_order, sec.position, 999), COALESCE(c.name, sec.activity_key, t.title))
        FROM public.weekly_test_scores s
        JOIN public.weekly_tests t ON t.id = s.test_id
        LEFT JOIN public.weekly_test_sections sec ON sec.id = s.section_id
        LEFT JOIN public.categories c ON c.id = COALESCE(s.category_id, sec.category_id)
       WHERE s.student_id = p_student AND t.test_date BETWEEN v_from AND v_to), '[]'::jsonb)
  );
END;
$$;

-- 16b. streak_for (Authorized for student self, admin, or assigned teacher)
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

  IF v_run > v_best THEN
    v_best := v_run;
  END IF;
  IF v_cur > v_best THEN
    v_best := v_cur;
  END IF;

  RETURN QUERY SELECT v_cur, v_best, 0::INTEGER, v_active_today;
END;
$$;

-- 16c. attendance_summary (Authorized for student self, admin, or assigned teacher)
CREATE OR REPLACE FUNCTION public.attendance_summary(
  p_student UUID DEFAULT NULL,
  p_from DATE DEFAULT NULL,
  p_to DATE DEFAULT NULL
)
RETURNS TABLE (
  present_count INTEGER,
  absent_count INTEGER,
  excused_count INTEGER,
  attendance_pct NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_present INTEGER := 0;
  v_absent INTEGER := 0;
  v_excused INTEGER := 0;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin()
     AND NOT (
       public.is_teacher(auth.uid())
       AND (
         public.has_teacher_permission(auth.uid(), 'view_students')
         OR public.has_teacher_permission(auth.uid(), 'generate_reports')
         OR public.has_teacher_permission(auth.uid(), 'mark_attendance')
         OR public.has_teacher_permission(auth.uid(), 'correct_attendance')
       )
       AND public.is_teacher_assigned_to_student(auth.uid(), v_target)
     ) THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own attendance summary.' USING ERRCODE = '42501';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE a.status = 'present')::INTEGER,
    COUNT(*) FILTER (WHERE a.status = 'absent')::INTEGER,
    COUNT(*) FILTER (WHERE a.status = 'excused')::INTEGER
  INTO v_present, v_absent, v_excused
  FROM public.attendance a
  JOIN public.attendance_sessions s ON s.id = a.session_id
  WHERE a.student_id = v_target
    AND (p_from IS NULL OR s.session_date >= p_from)
    AND (p_to IS NULL OR s.session_date <= p_to);

  RETURN QUERY SELECT
    COALESCE(v_present, 0),
    COALESCE(v_absent, 0),
    COALESCE(v_excused, 0),
    CASE
      WHEN (COALESCE(v_present, 0) + COALESCE(v_absent, 0)) > 0 THEN
        ROUND((v_present::numeric / (v_present + v_absent)::numeric) * 100.0, 1)
      ELSE NULL
    END;
END;
$$;

-- 16d-1. todo_status_on (Shared calculation engine with caller authorization and durable targeting)
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
  SELECT x.id, x.title, x.section, x.category_id, x.activity_key, x.required_count, x.cnt,
         (x.cnt >= x.required_count)
    FROM (
      SELECT t.id, t.title, t.section, t.category_id, t.activity_key, t.required_count, t.sort_order,
        (CASE
          WHEN t.category_id IS NOT NULL AND t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.student_round_id IS NOT NULL AND r.entry_date = v_day)
          WHEN t.category_id IS NOT NULL THEN
            (SELECT count(*) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.entry_date = v_day)
          WHEN t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'round'
                AND r.student_round_id IS NOT NULL AND r.entry_date = v_day)
          WHEN t.section = 'basics' THEN
            (SELECT count(*) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'basics' AND r.entry_date = v_day)
          WHEN t.section = 'elements' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'element'
                AND (t.activity_key IS NULL OR a.settings ->> 'drill' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day)
          WHEN t.section = 'flash' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'flash_anzan'
                AND (t.flash_digits IS NULL OR a.settings ->> 'digits' = t.flash_digits::text)
                AND (t.flash_count IS NULL OR a.settings ->> 'count' = t.flash_count::text)
                AND (t.flash_speed_ms IS NULL OR a.settings ->> 'speed_ms' = t.flash_speed_ms::text)
                AND (t.flash_mode IS NULL OR a.settings ->> 'mode' = t.flash_mode)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day)
          WHEN t.section = 'memoriad' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'memoriad'
                AND (t.activity_key IS NULL OR a.settings ->> 'module' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = v_day)
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

-- 16d-2. todo_for (Thin authorized wrapper delegating to todo_status_on)
CREATE OR REPLACE FUNCTION public.todo_for(p_student UUID DEFAULT NULL)
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

-- 16e. my_notifications (Student delivery RPC with targeted audience enforcement)
CREATE TABLE IF NOT EXISTS public.notification_dismissals (
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (student_id, ref)
);
ALTER TABLE public.notification_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notification_dismissals_user" ON public.notification_dismissals;
CREATE POLICY "notification_dismissals_user"
ON public.notification_dismissals FOR ALL TO authenticated
USING (student_id = auth.uid() OR public.is_admin())
WITH CHECK (student_id = auth.uid() OR public.is_admin());

CREATE OR REPLACE FUNCTION public.my_notifications()
RETURNS TABLE (
  ref TEXT,
  kind TEXT,
  title TEXT,
  body TEXT,
  link TEXT,
  event_date DATE,
  days_left INT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_student_id UUID := auth.uid();
  v_today DATE := public.today_ist();
  v_level TEXT;
  v_role TEXT;
  v_active BOOLEAN;
BEGIN
  -- Verify authenticated caller
  SELECT role, level, active INTO v_role, v_level, v_active
  FROM public.profiles
  WHERE id = v_student_id;

  IF NOT FOUND OR v_active IS NOT TRUE THEN
    RETURN;
  END IF;

  -- 1. Weekly Tests
  RETURN QUERY
  SELECT
    'test:' || t.id || ':' || (
      CASE
        WHEN t.test_date = v_today THEN 'today'
        WHEN t.test_date = v_today + 1 THEN 'tomorrow'
        ELSE 'upcoming'
      END
    ) AS ref,
    CASE
      WHEN t.test_date = v_today THEN 'test_today'
      ELSE 'test_upcoming'
    END AS kind,
    t.title,
    CASE
      WHEN t.test_type = 'online' THEN 'Online test on Trendz Tracker.'
      ELSE 'Offline test with your trainer.'
    END || COALESCE(' ' || NULLIF(TRIM(t.notes), ''), '') AS body,
    '/pages/weekly-test.html' AS link,
    t.test_date AS event_date,
    (t.test_date - v_today)::INT AS days_left,
    t.created_at
  FROM public.weekly_tests t
  WHERE t.test_date >= v_today
    AND t.test_date <= v_today + COALESCE(t.remind_days_before, 7)
    AND (
      (t.target_scope = 'targeted' AND public.is_weekly_test_recipient(t.id, v_student_id))
      OR (
        t.target_scope = 'all'
        AND (
          t.audience_level IS NULL
          OR LOWER(TRIM(t.audience_level)) = 'everyone'
          OR LOWER(TRIM(t.audience_level)) = LOWER(TRIM(COALESCE(v_level, '')))
        )
      )
    )
    -- Exclude online tests on test day if student has already completed all sections
    AND NOT (
      t.test_type = 'online'
      AND t.test_date = v_today
      AND (SELECT COUNT(*) FROM public.weekly_test_sections s WHERE s.test_id = t.id) > 0
      AND (SELECT COUNT(*) FROM public.weekly_test_sections s WHERE s.test_id = t.id) =
          (SELECT COUNT(*) FROM public.weekly_test_attempts a
           WHERE a.test_id = t.id AND a.student_id = v_student_id AND a.status = 'submitted')
    )
    -- Exclude dismissed stage references
    AND NOT EXISTS (
      SELECT 1 FROM public.notification_dismissals d
      WHERE d.student_id = v_student_id
        AND d.ref = ('test:' || t.id || ':' || (
          CASE
            WHEN t.test_date = v_today THEN 'today'
            WHEN t.test_date = v_today + 1 THEN 'tomorrow'
            ELSE 'upcoming'
          END
        ))
    )
  ORDER BY t.test_date ASC;

  -- 2. Announcements
  RETURN QUERY
  SELECT
    'ann:' || a.id AS ref,
    'announcement' AS kind,
    a.title,
    a.body,
    '/pages/student.html' AS link,
    (a.starts_at AT TIME ZONE 'Asia/Kolkata')::DATE AS event_date,
    NULL::INT AS days_left,
    a.created_at
  FROM public.announcements a
  WHERE a.starts_at <= now()
    AND (a.expires_at IS NULL OR a.expires_at > now())
    AND (
      (a.target_scope = 'targeted' AND public.is_announcement_recipient(a.id, v_student_id))
      OR (
        a.target_scope = 'all'
        AND (
          a.audience_level IS NULL
          OR LOWER(TRIM(a.audience_level)) = 'everyone'
          OR LOWER(TRIM(a.audience_level)) = LOWER(TRIM(COALESCE(v_level, '')))
        )
      )
    )
    -- Exclude dismissed announcements
    AND NOT EXISTS (
      SELECT 1 FROM public.notification_dismissals d
      WHERE d.student_id = v_student_id AND d.ref = 'ann:' || a.id
    )
  ORDER BY a.starts_at DESC;
END;
$$;

-- ------------------------------------------------------------------------------
-- 17. RPC: teacher_get_overview
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.teacher_get_overview()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_today DATE := public.today_ist();
  v_is_admin BOOLEAN := false;
  v_assigned_ids UUID[];
  v_assigned_count INT := 0;
  v_not_practiced JSONB := '[]'::jsonb;
  v_needs_attention JSONB := '[]'::jsonb;
  v_pending_review JSONB := '[]'::jsonb;
  v_upcoming_tests JSONB := '[]'::jsonb;
BEGIN
  IF public.is_admin() OR COALESCE(auth.jwt() ->> 'role', '') = 'service_role' THEN
    v_is_admin := true;
  ELSIF NOT public.is_teacher(v_caller) THEN
    RAISE EXCEPTION 'Unauthorized: Teacher access required.' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(student_id) INTO v_assigned_ids
  FROM public.teacher_student_assignments
  WHERE teacher_id = v_caller;

  v_assigned_count := COALESCE(cardinality(v_assigned_ids), 0);

  IF v_assigned_count = 0 AND NOT v_is_admin THEN
    RETURN jsonb_build_object(
      'assigned_count', 0,
      'not_practiced_today', '[]'::jsonb,
      'needs_attention', '[]'::jsonb,
      'pending_review', '[]'::jsonb,
      'upcoming_tests', '[]'::jsonb
    );
  END IF;

  -- 1. Assigned students who have not practiced today (requires can_view_students)
  IF v_is_admin OR public.has_teacher_permission(v_caller, 'view_students') THEN
    SELECT COALESCE(jsonb_agg(sub.item), '[]'::jsonb)
    INTO v_not_practiced
    FROM (
      SELECT jsonb_build_object(
        'id', p.id,
        'student_code', p.student_code,
        'full_name', p.full_name,
        'level', p.level
      ) AS item
      FROM public.profiles p
      WHERE (v_is_admin OR p.id = ANY(v_assigned_ids))
        AND p.role = 'student'
        AND p.active = true
        AND NOT EXISTS (
          SELECT 1 FROM public.results r
          WHERE r.student_id = p.id AND r.entry_date = v_today
        )
      ORDER BY p.full_name ASC
      LIMIT 100
    ) sub;
  END IF;

  -- 2. Scores pending review & needs attention (requires can_review_scores)
  IF v_is_admin OR public.has_teacher_permission(v_caller, 'review_scores') THEN
    -- Flagged results (LIMIT 20 before aggregation)
    SELECT COALESCE(jsonb_agg(sub.item), '[]'::jsonb)
    INTO v_needs_attention
    FROM (
      SELECT jsonb_build_object(
        'result_id', r.id,
        'student_id', p.id,
        'student_name', p.full_name,
        'student_code', p.student_code,
        'flag_note', r.flag_note,
        'entry_date', r.entry_date
      ) AS item
      FROM public.results r
      JOIN public.profiles p ON p.id = r.student_id
      WHERE (v_is_admin OR r.student_id = ANY(v_assigned_ids))
        AND r.flagged = true
      ORDER BY r.entry_date DESC
      LIMIT 20
    ) sub;

    -- Scores pending review (unverified results in last 7 days, LIMIT 25 before aggregation)
    SELECT COALESCE(jsonb_agg(sub.item), '[]'::jsonb)
    INTO v_pending_review
    FROM (
      SELECT jsonb_build_object(
        'result_id', r.id,
        'student_id', p.id,
        'student_name', p.full_name,
        'student_code', p.student_code,
        'correct', r.correct,
        'total', r.total,
        'entry_date', r.entry_date
      ) AS item
      FROM public.results r
      JOIN public.profiles p ON p.id = r.student_id
      WHERE (v_is_admin OR r.student_id = ANY(v_assigned_ids))
        AND r.verified = false
        AND r.entry_date >= (v_today - 7)
      ORDER BY r.created_at DESC
      LIMIT 25
    ) sub;
  END IF;

  -- 3. Upcoming weekly tests (requires can_manage_tests)
  -- Scoped to: created by teacher, targeted to assigned students, or general admin tests
  IF v_is_admin OR public.has_teacher_permission(v_caller, 'manage_tests') THEN
    SELECT COALESCE(jsonb_agg(sub.item), '[]'::jsonb)
    INTO v_upcoming_tests
    FROM (
      SELECT jsonb_build_object(
        'id', wt.id,
        'title', wt.title,
        'test_date', wt.test_date,
        'opens_at', wt.opens_at,
        'closes_at', wt.closes_at,
        'test_type', wt.test_type
      ) AS item
      FROM public.weekly_tests wt
      WHERE (wt.test_date >= v_today)
        AND (
          v_is_admin
          OR wt.created_by = v_caller
          OR EXISTS (
            SELECT 1 FROM public.weekly_test_recipients wtr
            WHERE wtr.test_id = wt.id AND wtr.student_id = ANY(v_assigned_ids)
          )
          OR (
            wt.target_scope = 'all'
            AND NOT EXISTS (
              SELECT 1 FROM public.weekly_test_recipients wtr
              WHERE wtr.test_id = wt.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.profiles p
              WHERE p.id = wt.created_by AND p.role = 'teacher'
            )
          )
        )
      ORDER BY wt.test_date ASC
      LIMIT 10
    ) sub;
  END IF;

  RETURN jsonb_build_object(
    'assigned_count', v_assigned_count,
    'not_practiced_today', COALESCE(v_not_practiced, '[]'::jsonb),
    'needs_attention', COALESCE(v_needs_attention, '[]'::jsonb),
    'pending_review', COALESCE(v_pending_review, '[]'::jsonb),
    'upcoming_tests', COALESCE(v_upcoming_tests, '[]'::jsonb)
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 18. Comprehensive Row Level Security (Direct Reads & Writes)
-- ------------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_test_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

-- 18a. profiles: Self, Admin, or Assigned Teacher with can_view_students
DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy"
ON public.profiles FOR SELECT TO authenticated
USING (
  id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'view_students')
    AND public.is_teacher_assigned_to_student(auth.uid(), id)
  )
);

-- 18b. results: Self, Admin, or Assigned Teacher
DROP POLICY IF EXISTS "results_select_policy" ON public.results;
CREATE POLICY "results_select_policy"
ON public.results FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'review_scores')
      OR public.has_teacher_permission(auth.uid(), 'generate_reports')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

-- 18c. activity_results: Self, Admin, or Assigned Teacher
DROP POLICY IF EXISTS "activity_results_select_policy" ON public.activity_results;
CREATE POLICY "activity_results_select_policy"
ON public.activity_results FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'review_scores')
      OR public.has_teacher_permission(auth.uid(), 'generate_reports')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

-- 18d. attendance: Self, Admin, or Assigned Teacher
DROP POLICY IF EXISTS "attendance_read" ON public.attendance;
CREATE POLICY "attendance_read"
ON public.attendance FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'mark_attendance')
      OR public.has_teacher_permission(auth.uid(), 'correct_attendance')
      OR public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'generate_reports')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

-- 18d-2. attendance_sessions: Admin, Teacher (creator or assigned to a student in session), or Student (has attendance row in session)
ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "att_sessions_read" ON public.attendance_sessions;
DROP POLICY IF EXISTS "attendance_sessions_read" ON public.attendance_sessions;
DROP POLICY IF EXISTS "attendance_sessions_select_scoped" ON public.attendance_sessions;
CREATE POLICY "attendance_sessions_select_scoped"
ON public.attendance_sessions FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.attendance a
        WHERE a.session_id = attendance_sessions.id
          AND public.is_teacher_assigned_to_student(auth.uid(), a.student_id)
          AND (
            public.has_teacher_permission(auth.uid(), 'mark_attendance')
            OR public.has_teacher_permission(auth.uid(), 'correct_attendance')
            OR public.has_teacher_permission(auth.uid(), 'view_students')
            OR public.has_teacher_permission(auth.uid(), 'generate_reports')
          )
      )
    )
  )
  OR EXISTS (
    SELECT 1 FROM public.attendance a
    WHERE a.session_id = attendance_sessions.id
      AND a.student_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "attendance_sessions_admin_write" ON public.attendance_sessions;
DROP POLICY IF EXISTS "attendance_sessions_write" ON public.attendance_sessions;
CREATE POLICY "attendance_sessions_write"
ON public.attendance_sessions FOR ALL TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'mark_attendance')
      OR public.has_teacher_permission(auth.uid(), 'correct_attendance')
    )
    AND (created_by = auth.uid() OR public.is_admin())
  )
)
WITH CHECK (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'mark_attendance')
      OR public.has_teacher_permission(auth.uid(), 'correct_attendance')
    )
    AND created_by = auth.uid()
  )
);

-- 18e. weekly_test_scores: Self, Admin, or Assigned Teacher
DROP POLICY IF EXISTS "Students read own weekly test scores" ON public.weekly_test_scores;
DROP POLICY IF EXISTS "weekly_test_scores_select" ON public.weekly_test_scores;
CREATE POLICY "weekly_test_scores_select"
ON public.weekly_test_scores FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'review_scores')
      OR public.has_teacher_permission(auth.uid(), 'manage_tests')
      OR public.has_teacher_permission(auth.uid(), 'generate_reports')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

-- 18f. weekly_test_attempts: Self, Admin, or Assigned Teacher
ALTER TABLE public.weekly_test_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weekly_test_attempts_select" ON public.weekly_test_attempts;
CREATE POLICY "weekly_test_attempts_select"
ON public.weekly_test_attempts FOR SELECT TO authenticated
USING (
  student_id = auth.uid()
  OR public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      public.has_teacher_permission(auth.uid(), 'view_students')
      OR public.has_teacher_permission(auth.uid(), 'review_scores')
      OR public.has_teacher_permission(auth.uid(), 'manage_tests')
    )
    AND public.is_teacher_assigned_to_student(auth.uid(), student_id)
  )
);

-- 18g. weekly_tests: Admin, Teacher (own or general), or Student (targeted recipient or general)
DROP POLICY IF EXISTS "weekly_tests_read" ON public.weekly_tests;
DROP POLICY IF EXISTS "Authenticated users can read weekly tests" ON public.weekly_tests;
DROP POLICY IF EXISTS "weekly_tests_select_scoped" ON public.weekly_tests;
CREATE POLICY "weekly_tests_select_scoped"
ON public.weekly_tests FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      created_by = auth.uid()
      OR target_scope = 'all'
    )
  )
  OR (
    (target_scope = 'targeted' AND public.is_weekly_test_recipient(id, auth.uid()))
    OR (
      target_scope = 'all'
      AND (
        audience_level IS NULL
        OR LOWER(TRIM(audience_level)) = 'everyone'
        OR LOWER(TRIM(audience_level)) = LOWER(TRIM(COALESCE(public.student_level(auth.uid()), '')))
      )
    )
  )
);

-- 18g-2. weekly_test_sections: Admin, Teacher (creator or general parent test), or Student (targeted recipient or general parent test)
ALTER TABLE public.weekly_test_sections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wt_sections_read" ON public.weekly_test_sections;
DROP POLICY IF EXISTS "weekly_test_sections_select_scoped" ON public.weekly_test_sections;
CREATE POLICY "weekly_test_sections_select_scoped"
ON public.weekly_test_sections FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.weekly_tests wt
      WHERE wt.id = weekly_test_sections.test_id
        AND (wt.created_by = auth.uid() OR wt.target_scope = 'all')
    )
  )
  OR EXISTS (
    SELECT 1 FROM public.weekly_tests wt
    WHERE wt.id = weekly_test_sections.test_id
      AND (
        (wt.target_scope = 'targeted' AND public.is_weekly_test_recipient(wt.id, auth.uid()))
        OR (
          wt.target_scope = 'all'
          AND (
            wt.audience_level IS NULL
            OR LOWER(TRIM(wt.audience_level)) = 'everyone'
            OR LOWER(TRIM(wt.audience_level)) = LOWER(TRIM(COALESCE(public.student_level(auth.uid()), '')))
          )
        )
      )
  )
);

DROP POLICY IF EXISTS "weekly_test_recipients_select" ON public.weekly_test_recipients;
CREATE POLICY "weekly_test_recipients_select"
ON public.weekly_test_recipients FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.is_weekly_test_creator(test_id, auth.uid())
  )
  OR student_id = auth.uid()
);

DROP POLICY IF EXISTS "weekly_test_recipients_write" ON public.weekly_test_recipients;
CREATE POLICY "weekly_test_recipients_write"
ON public.weekly_test_recipients FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 18h. daily_tasks: Admin, Teacher (own or general), or Student (targeted or general)
DROP POLICY IF EXISTS "daily_tasks_read_policy" ON public.daily_tasks;
CREATE POLICY "daily_tasks_read_policy"
ON public.daily_tasks FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      created_by = auth.uid()
      OR target_scope = 'all'
    )
  )
  OR (
    active = true
    AND (
      (target_scope = 'targeted' AND public.is_daily_task_recipient(id, auth.uid()))
      OR (
        target_scope = 'all'
        AND (
          level IS NULL
          OR LOWER(TRIM(level)) = 'everyone'
          OR LOWER(TRIM(level)) = LOWER(TRIM(COALESCE(public.student_level(auth.uid()), '')))
        )
      )
    )
  )
);

DROP POLICY IF EXISTS "daily_tasks_admin_write_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_write_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_insert_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_update_policy" ON public.daily_tasks;
DROP POLICY IF EXISTS "daily_tasks_delete_policy" ON public.daily_tasks;

CREATE POLICY "daily_tasks_insert_policy"
ON public.daily_tasks FOR INSERT TO authenticated
WITH CHECK (public.is_admin());

CREATE POLICY "daily_tasks_update_policy"
ON public.daily_tasks FOR UPDATE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_tasks')
    AND created_by = auth.uid()
  )
)
WITH CHECK (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_tasks')
    AND created_by = auth.uid()
  )
);

CREATE POLICY "daily_tasks_delete_policy"
ON public.daily_tasks FOR DELETE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_tasks')
    AND created_by = auth.uid()
  )
);

DROP POLICY IF EXISTS "daily_task_recipients_select" ON public.daily_task_recipients;
CREATE POLICY "daily_task_recipients_select"
ON public.daily_task_recipients FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.is_daily_task_creator(task_id, auth.uid())
  )
  OR student_id = auth.uid()
);

DROP POLICY IF EXISTS "daily_task_recipients_write" ON public.daily_task_recipients;
CREATE POLICY "daily_task_recipients_write"
ON public.daily_task_recipients FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 18i. announcements: Admin, Teacher (own or general), or Student
DROP POLICY IF EXISTS "announcements_read_policy" ON public.announcements;
CREATE POLICY "announcements_read_policy"
ON public.announcements FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      created_by = auth.uid()
      OR target_scope = 'all'
    )
  )
  OR (
    (target_scope = 'targeted' AND public.is_announcement_recipient(id, auth.uid()))
    OR (
      target_scope = 'all'
      AND (
        audience_level IS NULL
        OR LOWER(TRIM(audience_level)) = 'everyone'
        OR LOWER(TRIM(audience_level)) = LOWER(TRIM(COALESCE(public.student_level(auth.uid()), '')))
      )
    )
  )
);

DROP POLICY IF EXISTS "announcements_write_policy" ON public.announcements;
DROP POLICY IF EXISTS "announcements_insert_policy" ON public.announcements;
DROP POLICY IF EXISTS "announcements_update_policy" ON public.announcements;
DROP POLICY IF EXISTS "announcements_delete_policy" ON public.announcements;

CREATE POLICY "announcements_insert_policy"
ON public.announcements FOR INSERT TO authenticated
WITH CHECK (public.is_admin());

CREATE POLICY "announcements_update_policy"
ON public.announcements FOR UPDATE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'publish_announcements')
    AND created_by = auth.uid()
  )
)
WITH CHECK (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'publish_announcements')
    AND created_by = auth.uid()
  )
);

CREATE POLICY "announcements_delete_policy"
ON public.announcements FOR DELETE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'publish_announcements')
    AND created_by = auth.uid()
  )
);

DROP POLICY IF EXISTS "announcement_recipients_select" ON public.announcement_recipients;
CREATE POLICY "announcement_recipients_select"
ON public.announcement_recipients FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.is_announcement_creator(announcement_id, auth.uid())
  )
  OR student_id = auth.uid()
);

DROP POLICY IF EXISTS "announcement_recipients_write" ON public.announcement_recipients;
CREATE POLICY "announcement_recipients_write"
ON public.announcement_recipients FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- 18j. resources: Admin, Teacher (own or general), or Student
DROP POLICY IF EXISTS "resources_read_policy" ON public.resources;
CREATE POLICY "resources_read_policy"
ON public.resources FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND (
      created_by = auth.uid()
      OR target_scope = 'all'
    )
  )
  OR (
    active = true
    AND (
      (target_scope = 'targeted' AND public.is_resource_recipient(id, auth.uid()))
      OR (
        target_scope = 'all'
        AND (
          audience_level IS NULL
          OR LOWER(TRIM(audience_level)) = 'everyone'
          OR LOWER(TRIM(audience_level)) = LOWER(TRIM(COALESCE(public.student_level(auth.uid()), '')))
        )
      )
    )
  )
);

DROP POLICY IF EXISTS "resources_admin_write_policy" ON public.resources;
DROP POLICY IF EXISTS "resources_write_policy" ON public.resources;
DROP POLICY IF EXISTS "resources_insert_policy" ON public.resources;
DROP POLICY IF EXISTS "resources_update_policy" ON public.resources;
DROP POLICY IF EXISTS "resources_delete_policy" ON public.resources;

CREATE POLICY "resources_insert_policy"
ON public.resources FOR INSERT TO authenticated
WITH CHECK (public.is_admin());

CREATE POLICY "resources_update_policy"
ON public.resources FOR UPDATE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_resources')
    AND created_by = auth.uid()
  )
)
WITH CHECK (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_resources')
    AND created_by = auth.uid()
  )
);

CREATE POLICY "resources_delete_policy"
ON public.resources FOR DELETE TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.has_teacher_permission(auth.uid(), 'manage_resources')
    AND created_by = auth.uid()
  )
);

DROP POLICY IF EXISTS "resource_recipients_select" ON public.resource_recipients;
CREATE POLICY "resource_recipients_select"
ON public.resource_recipients FOR SELECT TO authenticated
USING (
  public.is_admin()
  OR (
    public.is_teacher(auth.uid())
    AND public.is_resource_creator(resource_id, auth.uid())
  )
  OR student_id = auth.uid()
);

DROP POLICY IF EXISTS "resource_recipients_write" ON public.resource_recipients;
CREATE POLICY "resource_recipients_write"
ON public.resource_recipients FOR ALL TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- ------------------------------------------------------------------------------
-- 19. Explicit Grants
-- ------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_teacher(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_teacher(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_teacher_assigned_to_student(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_teacher_assigned_to_student(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_teacher_permission(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_teacher_permission(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_has_student_access(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_has_student_access(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_weekly_test_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_weekly_test_recipients(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_weekly_test_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_weekly_test_recipient(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_daily_task_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_daily_task_recipients(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_daily_task_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_daily_task_recipient(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_announcement_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_announcement_recipients(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_announcement_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_announcement_recipient(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_resource_recipients(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_resource_recipients(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_resource_recipient(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_resource_recipient(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.student_level(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_level(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_weekly_test_creator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_weekly_test_creator(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_daily_task_creator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_daily_task_creator(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_announcement_creator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_announcement_creator(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_resource_creator(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_resource_creator(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_create_teacher_entry(UUID, TEXT, TEXT, JSONB, UUID[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_teacher_entry(UUID, TEXT, TEXT, JSONB, UUID[], UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_replace_teacher_assignments(UUID, UUID[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_replace_teacher_assignments(UUID, UUID[], UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_update_teacher_permissions(UUID, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_teacher_permissions(UUID, JSONB, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_set_teacher_active(UUID, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_teacher_active(UUID, BOOLEAN, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_save_attendance(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_save_attendance(UUID, JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_request_score_correction(UUID, TEXT, INT, INT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_request_score_correction(UUID, TEXT, INT, INT, INT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_decide_score_correction(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_decide_score_correction(UUID, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_verify_scores(UUID[], BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_verify_scores(UUID[], BOOLEAN, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_flag_score(UUID, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_flag_score(UUID, BOOLEAN, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_weekly_test_sections_atomic(UUID, JSONB, JSONB, UUID[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_announcement_atomic(UUID, JSONB, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_announcement_atomic(UUID, JSONB, UUID[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_resource_atomic(UUID, JSONB, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_resource_atomic(UUID, JSONB, UUID[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_reserve_section_start(UUID, UUID, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.student_month_report(UUID, DATE) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.student_month_report(UUID, DATE) TO authenticated;
GRANT ALL ON FUNCTION public.student_month_report(UUID, DATE) TO service_role;

REVOKE ALL ON FUNCTION public.streak_for(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.streak_for(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.attendance_summary(UUID, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_summary(UUID, DATE, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.todo_for(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_for(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.teacher_get_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.teacher_get_overview() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.my_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_notifications() TO authenticated, service_role;

-- Explicit Table Permissions
-- Audit logs: read-only to authenticated users; modified exclusively via SECURITY DEFINER RPCs
REVOKE ALL ON TABLE public.teacher_audit_log FROM anon, authenticated, PUBLIC;
GRANT SELECT ON TABLE public.teacher_audit_log TO authenticated, service_role;
GRANT ALL ON TABLE public.teacher_audit_log TO service_role;

REVOKE ALL ON TABLE public.attendance_audit FROM anon, authenticated, PUBLIC;
GRANT SELECT ON TABLE public.attendance_audit TO authenticated, service_role;
GRANT ALL ON TABLE public.attendance_audit TO service_role;

-- Administrative state tables: governed by RLS (is_admin check)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teacher_student_assignments TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teacher_permissions TO authenticated, service_role;

-- Operational tables governed by RLS
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_tests TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_sections TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_scores TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_attempts TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance_sessions TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.attendance TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_tasks TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcements TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resources TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.score_correction_requests TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.weekly_test_recipients TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_task_recipients TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.announcement_recipients TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resource_recipients TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notification_dismissals TO authenticated, service_role;

-- Enforce strict revocation of TRUNCATE for client and public roles across all public tables
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated, PUBLIC;

COMMIT;
