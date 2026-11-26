-- Phase 22: teachers can schedule live classes (when allowed), and classes can run on Zoom.
--
-- 1. teacher_permissions.can_schedule_live_classes (off by default: every Webinar.gg class
--    uses the one owner account, so admins choose who may book it).
-- 2. live_classes.meeting_url for Zoom classes. The API hands it out only on Join.
-- 3. has_teacher_permission / admin_update_teacher_permissions / admin_create_teacher_entry
--    know the new permission.

ALTER TABLE public.teacher_permissions
  ADD COLUMN IF NOT EXISTS can_schedule_live_classes boolean NOT NULL DEFAULT false;

ALTER TABLE public.live_classes
  ADD COLUMN IF NOT EXISTS meeting_url text;

CREATE OR REPLACE FUNCTION public.has_teacher_permission(p_teacher_id uuid, p_permission text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      WHEN 'schedule_live_classes' THEN can_schedule_live_classes
      ELSE false
    END
  INTO v_allowed
  FROM public.teacher_permissions
  WHERE teacher_id = p_teacher_id;

  RETURN COALESCE(v_allowed, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_teacher_permissions(p_teacher_id uuid, p_permissions jsonb, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller UUID := COALESCE(auth.uid(), p_actor_id);
  v_teacher RECORD;
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
    can_schedule_live_classes = COALESCE((p_permissions->>'can_schedule_live_classes')::boolean, can_schedule_live_classes),
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_teacher_entry(p_teacher_id uuid, p_teacher_code text, p_full_name text, p_permissions jsonb DEFAULT '{}'::jsonb, p_student_ids uuid[] DEFAULT ARRAY[]::uuid[], p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- 3. Upsert permissions (scheduling live classes is off unless the admin ticks it)
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
    'can_request_corrections', COALESCE((p_permissions->>'can_request_corrections')::boolean, true),
    'can_schedule_live_classes', COALESCE((p_permissions->>'can_schedule_live_classes')::boolean, false)
  );

  INSERT INTO public.teacher_permissions (
    teacher_id,
    can_view_students, can_mark_attendance, can_correct_attendance,
    can_generate_reports, can_manage_tasks, can_manage_tests,
    can_publish_announcements, can_manage_resources, can_review_scores,
    can_request_corrections, can_schedule_live_classes, updated_by
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
    (v_perms_payload->>'can_schedule_live_classes')::boolean,
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
    can_schedule_live_classes = EXCLUDED.can_schedule_live_classes,
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
$function$;
