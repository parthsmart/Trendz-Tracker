-- Phase 24: delete a student or teacher without losing their data (soft delete).
--
-- "Delete" on the Students and Teachers pages keeps the profile, results, assignments and
-- history in the database but removes the person from every part of the website:
--   * deleted_at / deleted_by record when and by whom they were deleted;
--   * a deleted account is always inactive, so every leaderboard, roster, report, teacher
--     check and API check that already skips inactive accounts also skips them, and they
--     cannot sign in;
--   * row level security hides deleted profiles from every normal query (admins included),
--     so lists, pickers and embedded names drop them without per-page filters;
--   * admins see them only through admin_deleted_profiles() and can bring them back with
--     admin_restore_profile().
-- The service-role full backup still reads every row, deleted accounts included.

-- 1. Columns
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS deleted_by uuid;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_deleted_inactive;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_deleted_inactive CHECK (
  deleted_at IS NULL OR (role IN ('student', 'teacher') AND active = false)
);

CREATE INDEX IF NOT EXISTS profiles_deleted_at_idx
  ON public.profiles (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 2. Row level security: deleted profiles are invisible to normal queries
DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      id = auth.uid()
      OR public.is_admin()
      OR (
        public.is_teacher(auth.uid())
        AND public.has_teacher_permission(auth.uid(), 'view_students')
        AND public.is_teacher_assigned_to_student(auth.uid(), id)
      )
    )
  );

-- The old FOR ALL admin policy also granted SELECT on deleted rows; split it so admins
-- keep insert/update/delete but only see deleted accounts through the RPCs below.
DROP POLICY IF EXISTS profiles_admin_write_policy ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_insert_policy ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_update_policy ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_delete_policy ON public.profiles;

CREATE POLICY profiles_admin_insert_policy ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

-- Plain updates cannot delete or restore an account: use the RPCs so it is always recorded.
CREATE POLICY profiles_admin_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin() AND deleted_at IS NULL)
  WITH CHECK (public.is_admin() AND deleted_at IS NULL);

CREATE POLICY profiles_admin_delete_policy ON public.profiles
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- 3. Admin RPCs (students and teachers; admin accounts can never be deleted)
CREATE OR REPLACE FUNCTION public.admin_soft_delete_profile(p_profile uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.profiles%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = p_profile FOR UPDATE;
  IF NOT FOUND OR v_row.role NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'Student or teacher not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.deleted_at IS NULL THEN
    UPDATE public.profiles
       SET deleted_at = now(),
           deleted_by = auth.uid(),
           active = false
     WHERE id = p_profile
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'role', v_row.role,
    'student_code', v_row.student_code,
    'full_name', v_row.full_name,
    'deleted_at', v_row.deleted_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_restore_profile(p_profile uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row public.profiles%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = p_profile FOR UPDATE;
  IF NOT FOUND OR v_row.role NOT IN ('student', 'teacher') THEN
    RAISE EXCEPTION 'Student or teacher not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.deleted_at IS NOT NULL THEN
    UPDATE public.profiles
       SET deleted_at = NULL,
           deleted_by = NULL,
           active = true
     WHERE id = p_profile
    RETURNING * INTO v_row;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'role', v_row.role,
    'student_code', v_row.student_code,
    'full_name', v_row.full_name,
    'active', v_row.active
  );
END;
$function$;

-- Full profile rows of deleted accounts (Deleted lists and the admin ZIP export).
-- p_role: 'student', 'teacher', or NULL for both.
CREATE OR REPLACE FUNCTION public.admin_deleted_profiles(p_role text DEFAULT NULL)
 RETURNS SETOF public.profiles
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.* FROM public.profiles p
   WHERE p.deleted_at IS NOT NULL
     AND (p_role IS NULL OR p.role = p_role)
   ORDER BY p.deleted_at DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_soft_delete_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_restore_profile(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_deleted_profiles(text) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.admin_soft_delete_profile(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.admin_restore_profile(uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION public.admin_deleted_profiles(text) TO authenticated;
  END IF;
END
$grants$;

-- 4. Security-definer views that list inactive students too: skip deleted ones
CREATE OR REPLACE FUNCTION public.admin_overview()
 RETURNS TABLE(student_id uuid, student_code text, full_name text, level text, active boolean, current_streak integer, entered_today boolean, last_entry_date date, entries_7d integer, accuracy_7d numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admins only';
  END IF;

  RETURN QUERY
  SELECT
    p.id, p.student_code, p.full_name, p.level, p.active,
    s.current_streak, s.active_today,
    (SELECT max(r.entry_date) FROM public.results r WHERE r.student_id = p.id),
    (SELECT count(*)::integer FROM public.results r
       WHERE r.student_id = p.id AND r.entry_date >= public.today_ist() - 6),
    (SELECT CASE WHEN sum(r.total) > 0 THEN round(100.0 * sum(r.correct) / sum(r.total), 1) END
       FROM public.results r
       WHERE r.student_id = p.id AND r.entry_date >= public.today_ist() - 6 AND r.total > 0)
  FROM public.profiles p
  CROSS JOIN LATERAL public.streak_for(p.id) s
  WHERE p.role = 'student'
    AND p.deleted_at IS NULL
  ORDER BY p.full_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.teacher_get_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- Deleted students no longer count as assigned.
  SELECT array_agg(a.student_id) INTO v_assigned_ids
  FROM public.teacher_student_assignments a
  JOIN public.profiles sp ON sp.id = a.student_id
  WHERE a.teacher_id = v_caller
    AND sp.deleted_at IS NULL;

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
        AND p.deleted_at IS NULL
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
        AND p.deleted_at IS NULL
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
        AND p.deleted_at IS NULL
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
$function$;
