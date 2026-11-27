-- Multi-centre step 4: the centre head panel.
--
-- Centre heads and vice heads manage their own centre from pages/centre.html.
-- Everything they do goes through the SECURITY DEFINER functions below, which
-- check the signed-in person's centre and rank in the database. No existing
-- policy or function is changed, so the admin pages behave exactly as before.
--
--   Both heads and vice heads:  read the centre, edit students and teachers,
--                               activate / deactivate them, set teacher
--                               assignments and permissions.
--   Heads only:                 delete / restore, centre settings, centre backup.
--   Owners and directors:       everything, for any centre.
--
-- Appointing and removing vice heads uses set_person_role() (migration 30),
-- which already limits heads to their own centre and to ranks below their own.
-- A suspended or archived centre's staff are refused by my_role().
--
-- No data changes. Rollback: supabase/rollbacks/35_centre_head_panel_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Internal helpers (not callable from the site)
-- ---------------------------------------------------------------------------

-- The centre a panel call acts on: the given one, or the caller's own.
CREATE OR REPLACE FUNCTION public.centre_panel_centre(p_centre uuid, p_head_only boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_centre uuid := COALESCE(p_centre, public.my_centre());
BEGIN
  IF v_centre IS NULL OR NOT public.is_centre_admin(v_centre) THEN
    RAISE EXCEPTION 'You can only manage your own centre.' USING ERRCODE = '42501';
  END IF;
  IF p_head_only AND NOT public.is_centre_head(v_centre) THEN
    RAISE EXCEPTION 'Only the centre head can do this.' USING ERRCODE = '42501';
  END IF;
  RETURN v_centre;
END;
$$;

-- Locks and returns a student or teacher the caller may manage.
CREATE OR REPLACE FUNCTION public.centre_panel_person(p_target uuid, p_head_only boolean DEFAULT false,
                                                      p_roles text[] DEFAULT ARRAY['student', 'teacher'])
RETURNS public.profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.profiles;
BEGIN
  SELECT * INTO v_row FROM public.profiles WHERE id = p_target FOR UPDATE;
  IF NOT FOUND OR NOT (v_row.role = ANY (p_roles)) THEN
    RAISE EXCEPTION 'Student or teacher not found.' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.centre_id IS NULL OR NOT public.is_centre_admin(v_row.centre_id)
     OR NOT public.can_manage_profile(v_row.id) THEN
    RAISE EXCEPTION 'You can only manage people in your own centre.' USING ERRCODE = '42501';
  END IF;
  IF p_head_only AND NOT public.is_centre_head(v_row.centre_id) THEN
    RAISE EXCEPTION 'Only the centre head can do this.' USING ERRCODE = '42501';
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.centre_panel_centre(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.centre_panel_person(uuid, boolean, text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Read the centre
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.centre_panel(p_centre uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_centre uuid := public.centre_panel_centre(p_centre);
BEGIN
  RETURN jsonb_build_object(
    'centre', (SELECT jsonb_build_object('id', c.id, 'name', c.name, 'code', c.code, 'kind', c.kind,
                                         'status', c.status, 'is_default', c.is_default, 'city', c.city,
                                         'settings', c.settings)
                 FROM public.centres c WHERE c.id = v_centre),
    'my_role', public.my_role(),
    'can_head', public.is_centre_head(v_centre),
    'people', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'student_code', p.student_code, 'full_name', p.full_name,
                                          'role', p.role, 'level', p.level, 'active', p.active,
                                          'deleted_at', p.deleted_at)
                       ORDER BY p.role, lower(p.full_name))
        FROM public.profiles p WHERE p.centre_id = v_centre), '[]'::jsonb),
    'permissions', COALESCE((
      SELECT jsonb_agg(to_jsonb(tp))
        FROM public.teacher_permissions tp
        JOIN public.profiles t ON t.id = tp.teacher_id
       WHERE t.centre_id = v_centre), '[]'::jsonb),
    'assignments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('teacher_id', a.teacher_id, 'student_id', a.student_id))
        FROM public.teacher_student_assignments a
        JOIN public.profiles t ON t.id = a.teacher_id
       WHERE t.centre_id = v_centre), '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Students and teachers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.centre_update_person(p_target uuid, p_full_name text, p_level text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row  public.profiles := public.centre_panel_person(p_target);
  v_name text := btrim(COALESCE(p_full_name, ''));
  v_level text := NULLIF(btrim(COALESCE(p_level, '')), '');
BEGIN
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Restore this person before editing them.';
  END IF;
  IF char_length(v_name) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Enter a name of 2 to 80 characters.';
  END IF;
  IF v_row.role = 'student' THEN
    IF v_level IS NOT NULL AND NOT public.is_standard_student_level(v_level) THEN
      RAISE EXCEPTION 'Choose a valid level.';
    END IF;
  ELSE
    v_level := v_row.level;
  END IF;

  UPDATE public.profiles SET full_name = v_name, level = v_level
   WHERE id = p_target RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'full_name', v_row.full_name, 'level', v_row.level);
END;
$$;

CREATE OR REPLACE FUNCTION public.centre_set_active(p_target uuid, p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.profiles := public.centre_panel_person(p_target);
BEGIN
  IF p_active IS NULL THEN
    RAISE EXCEPTION 'Choose active or inactive.';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Restore this person before changing them.';
  END IF;
  IF v_row.active IS DISTINCT FROM p_active THEN
    UPDATE public.profiles SET active = p_active WHERE id = p_target;
    IF v_row.role = 'teacher' THEN
      INSERT INTO public.teacher_audit_log (teacher_id, actor_id, action, details)
      VALUES (p_target, auth.uid(), CASE WHEN p_active THEN 'activate' ELSE 'deactivate' END,
              jsonb_build_object('active', p_active, 'via', 'centre_panel'));
    END IF;
  END IF;
  RETURN jsonb_build_object('id', p_target, 'active', p_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.centre_soft_delete(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.profiles := public.centre_panel_person(p_target, true);
BEGIN
  IF v_row.deleted_at IS NULL THEN
    UPDATE public.profiles SET deleted_at = now(), deleted_by = auth.uid(), active = false
     WHERE id = p_target RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('id', v_row.id, 'deleted_at', v_row.deleted_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.centre_restore(p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.profiles := public.centre_panel_person(p_target, true);
BEGIN
  IF v_row.deleted_at IS NOT NULL THEN
    UPDATE public.profiles SET deleted_at = NULL, deleted_by = NULL, active = true
     WHERE id = p_target RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('id', v_row.id, 'active', v_row.active);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Teacher assignments and permissions (same rules as the admin versions,
--    limited to students of the teacher's own centre)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.centre_set_teacher_assignments(p_teacher uuid, p_student_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.profiles := public.centre_panel_person(p_teacher, false, ARRAY['teacher']);
  v_ids uuid[];
BEGIN
  IF v_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Restore this teacher before assigning students.';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT sid), ARRAY[]::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_student_ids, ARRAY[]::uuid[])) AS sid WHERE sid IS NOT NULL;

  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS sid
              WHERE NOT EXISTS (SELECT 1 FROM public.profiles s
                                 WHERE s.id = sid AND s.role = 'student' AND s.active
                                   AND s.deleted_at IS NULL AND s.centre_id = v_row.centre_id)) THEN
    RAISE EXCEPTION 'Only active students of this centre can be assigned.' USING ERRCODE = '23503';
  END IF;

  DELETE FROM public.teacher_student_assignments WHERE teacher_id = p_teacher;
  INSERT INTO public.teacher_student_assignments (teacher_id, student_id, assigned_by)
  SELECT p_teacher, sid, auth.uid() FROM unnest(v_ids) AS sid;

  INSERT INTO public.teacher_audit_log (teacher_id, actor_id, action, details)
  VALUES (p_teacher, auth.uid(), 'assign_students',
          jsonb_build_object('assigned_count', cardinality(v_ids), 'student_ids', v_ids, 'via', 'centre_panel'));
  RETURN jsonb_build_object('success', true, 'assigned_count', cardinality(v_ids));
END;
$$;

CREATE OR REPLACE FUNCTION public.centre_update_teacher_permissions(p_teacher uuid, p_permissions jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row  public.profiles := public.centre_panel_person(p_teacher, false, ARRAY['teacher']);
  v_p    jsonb := COALESCE(p_permissions, '{}'::jsonb);
  v_out  public.teacher_permissions;
BEGIN
  IF jsonb_typeof(v_p) <> 'object' THEN
    RAISE EXCEPTION 'Permissions must be a list of switches.';
  END IF;
  INSERT INTO public.teacher_permissions (teacher_id, updated_by) VALUES (p_teacher, auth.uid())
  ON CONFLICT (teacher_id) DO NOTHING;
  UPDATE public.teacher_permissions SET
    can_view_students = COALESCE((v_p->>'can_view_students')::boolean, can_view_students),
    can_mark_attendance = COALESCE((v_p->>'can_mark_attendance')::boolean, can_mark_attendance),
    can_correct_attendance = COALESCE((v_p->>'can_correct_attendance')::boolean, can_correct_attendance),
    can_generate_reports = COALESCE((v_p->>'can_generate_reports')::boolean, can_generate_reports),
    can_manage_tasks = COALESCE((v_p->>'can_manage_tasks')::boolean, can_manage_tasks),
    can_manage_tests = COALESCE((v_p->>'can_manage_tests')::boolean, can_manage_tests),
    can_publish_announcements = COALESCE((v_p->>'can_publish_announcements')::boolean, can_publish_announcements),
    can_manage_resources = COALESCE((v_p->>'can_manage_resources')::boolean, can_manage_resources),
    can_review_scores = COALESCE((v_p->>'can_review_scores')::boolean, can_review_scores),
    can_request_corrections = COALESCE((v_p->>'can_request_corrections')::boolean, can_request_corrections),
    can_schedule_live_classes = COALESCE((v_p->>'can_schedule_live_classes')::boolean, can_schedule_live_classes),
    updated_at = now(),
    updated_by = auth.uid()
  WHERE teacher_id = p_teacher
  RETURNING * INTO v_out;

  INSERT INTO public.teacher_audit_log (teacher_id, actor_id, action, details)
  VALUES (p_teacher, auth.uid(), 'update_permissions', v_p || jsonb_build_object('via', 'centre_panel'));
  RETURN jsonb_build_object('success', true, 'permissions', to_jsonb(v_out));
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Centre settings (head only). Code, type, status and the default flag stay
--    with owners and directors.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.centre_update_settings(p_centre uuid, p_name text, p_city text, p_settings jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_centre uuid := public.centre_panel_centre(p_centre, true);
  v_name   text := btrim(COALESCE(p_name, ''));
  v_city   text := NULLIF(btrim(COALESCE(p_city, '')), '');
  v_in     jsonb := COALESCE(p_settings, '{}'::jsonb);
  v_clean  jsonb := '{}'::jsonb;
  v_key    text;
  v_max    integer;
  v_val    text;
BEGIN
  IF char_length(v_name) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'Enter a centre name of 2 to 80 characters.';
  END IF;
  IF char_length(COALESCE(v_city, '')) > 80 THEN
    RAISE EXCEPTION 'The city can be at most 80 characters.';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN
    RAISE EXCEPTION 'Settings must be a list of fields.';
  END IF;
  FOR v_key, v_max IN SELECT * FROM (VALUES ('address', 200), ('phone', 30), ('email', 120), ('notes', 500)) AS f(k, m) LOOP
    IF v_in ? v_key THEN
      v_val := btrim(COALESCE(v_in->>v_key, ''));
      IF char_length(v_val) > v_max THEN
        RAISE EXCEPTION 'The % can be at most % characters.', v_key, v_max;
      END IF;
      v_clean := v_clean || jsonb_build_object(v_key, v_val);
    END IF;
  END LOOP;

  BEGIN
    UPDATE public.centres
       SET name = v_name, city = v_city, settings = COALESCE(settings, '{}'::jsonb) || v_clean
     WHERE id = v_centre;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Another centre already has that name.';
  END;
  RETURN (SELECT jsonb_build_object('id', id, 'name', name, 'city', city, 'settings', settings)
            FROM public.centres WHERE id = v_centre);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Centre backup (head only): this centre's people and their records.
--    Content (rounds, tests, answer keys) is network-wide and not included.
--    Every export is written to role_audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.centre_backup(p_centre uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_centre   uuid := public.centre_panel_centre(p_centre, true);
  v_limit    constant integer := 50000;
  v_people   uuid[];
  v_students uuid[];
  v_teachers uuid[];
  v_tables   jsonb := '{}'::jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_rows     jsonb;
  v_t        text;
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]),
         COALESCE(array_agg(id) FILTER (WHERE role = 'student'), ARRAY[]::uuid[]),
         COALESCE(array_agg(id) FILTER (WHERE role = 'teacher'), ARRAY[]::uuid[])
    INTO v_people, v_students, v_teachers
    FROM public.profiles WHERE centre_id = v_centre;

  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.role, p.student_code), '[]'::jsonb) INTO v_rows
    FROM public.profiles p WHERE p.id = ANY (v_people);
  v_tables := v_tables || jsonb_build_object('profiles', v_rows);

  IF to_regclass('public.teacher_permissions') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
      FROM public.teacher_permissions x WHERE x.teacher_id = ANY (v_teachers);
    v_tables := v_tables || jsonb_build_object('teacher_permissions', v_rows);
  END IF;
  IF to_regclass('public.teacher_student_assignments') IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_rows
      FROM public.teacher_student_assignments x WHERE x.teacher_id = ANY (v_teachers);
    v_tables := v_tables || jsonb_build_object('teacher_student_assignments', v_rows);
  END IF;

  FOREACH v_t IN ARRAY ARRAY[
    'results', 'activity_results', 'attendance', 'daily_todo_log', 'drill_sessions', 'student_rounds',
    'simple_practice_results', 'daily_challenge_attempts', 'weekly_test_attempts', 'homework_completions',
    'student_badges', 'student_xp_events', 'xp_awards', 'league_results', 'duel_ratings',
    'reward_redemptions', 'student_practice_access'] LOOP
    IF to_regclass('public.' || v_t) IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM (SELECT * FROM public.%I WHERE student_id = ANY ($1) LIMIT %s) x',
                     v_t, v_limit)
        INTO v_rows USING v_students;
      v_tables := v_tables || jsonb_build_object(v_t, v_rows);
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_object_agg(k, jsonb_array_length(v)), '{}'::jsonb) INTO v_counts
    FROM jsonb_each(v_tables) AS e(k, v);

  INSERT INTO public.role_audit (actor_id, actor_role, target_id, centre_id, action, after)
  VALUES (auth.uid(), public.my_role(), NULL, v_centre, 'centre_backup', v_counts);

  RETURN jsonb_build_object(
    'centre', (SELECT jsonb_build_object('id', id, 'name', name, 'code', code) FROM public.centres WHERE id = v_centre),
    'generated_at', now(),
    'row_limit', v_limit,
    'counts', v_counts,
    'tables', v_tables);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants: signed-in people only; each function checks the caller itself.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.centre_panel(uuid)',
    'public.centre_update_person(uuid, text, text)',
    'public.centre_set_active(uuid, boolean)',
    'public.centre_soft_delete(uuid)',
    'public.centre_restore(uuid)',
    'public.centre_set_teacher_assignments(uuid, uuid[])',
    'public.centre_update_teacher_permissions(uuid, jsonb)',
    'public.centre_update_settings(uuid, text, text, jsonb)',
    'public.centre_backup(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END
$grants$;
