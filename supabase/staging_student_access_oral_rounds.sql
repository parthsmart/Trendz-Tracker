-- ==============================================================================
-- TRENDZ TRACKER — STUDENT ACCESS: ORAL ROUNDS KEY
-- File: supabase/staging_student_access_oral_rounds.sql
--
-- Apply after staging_student_access_feature.sql and
-- staging_student_access_enforcement.sql. Idempotent. Staging first;
-- not yet applied to production.
--
-- Adds the `oral_rounds` practice access key:
--   settings.oral_rounds = {
--     "allowed": true | false,
--     "operations": ["add", "sub", "mul"],   -- subset allowed for the student
--     "digits": [1, 2, 3, 4, 5]               -- operand digit sizes allowed
--   }
--
-- get_student_effective_access is redefined with the same authorization and
-- lookup order as the enforcement migration. The only change: when the
-- resolved settings have no `oral_rounds` key (default access, or a level /
-- student rule saved before this key existed), full Oral Rounds access is
-- merged in. This matches the client fallback in js/oralRounds.js.
--
-- Oral Rounds has no server writes. Its results are never stored in
-- activity_results or anything that feeds leaderboards or streaks, so there is
-- no start/submit RPC to guard here.
--
-- Rollback: re-apply get_student_effective_access from
-- staging_student_access_enforcement.sql. Saved rules may keep an
-- `oral_rounds` key; older code ignores it.
-- ==============================================================================

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
  v_oral_default JSONB := jsonb_build_object(
    'allowed', true,
    'operations', jsonb_build_array('add', 'sub', 'mul'),
    'digits', jsonb_build_array(1, 2, 3, 4, 5)
  );
  v_settings JSONB;
BEGIN
  -- Caller authorization (unchanged from staging_student_access_enforcement.sql):
  -- trusted server role, the student, an admin, or an assigned teacher with manage_tasks.
  IF v_is_service_role THEN
    NULL;
  ELSIF v_caller IS NULL THEN
    RAISE EXCEPTION 'Access denied: Missing caller identification.'
      USING ERRCODE = '42501';
  ELSIF v_caller = p_student_id THEN
    NULL;
  ELSIF public.is_admin() THEN
    NULL;
  ELSIF public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, p_student_id) AND public.has_teacher_permission(v_caller, 'manage_tasks') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Access denied: You are not authorized to view practice access for this student.'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Student's profile level
  SELECT level INTO v_student_level
  FROM public.profiles
  WHERE id = p_student_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'Student profile not found.'
    );
  END IF;

  -- 2. Competition eligibility
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_assignments') THEN
    SELECT EXISTS (
      SELECT 1 FROM public.jmcwc_assignments WHERE student_id = p_student_id
    ) INTO v_is_eligible;
  END IF;

  -- 3. Student override
  SELECT * INTO v_override_record
  FROM public.student_practice_access
  WHERE scope = 'student' AND student_id = p_student_id
  LIMIT 1;

  IF FOUND THEN
    v_settings := COALESCE(v_override_record.settings, '{}'::jsonb);
    IF jsonb_typeof(v_settings) = 'object' AND NOT (v_settings ? 'oral_rounds') THEN
      v_settings := v_settings || jsonb_build_object('oral_rounds', v_oral_default);
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'student_id', p_student_id,
      'level', COALESCE(v_student_level, ''),
      'scope', 'student',
      'source_label', 'Student override',
      'has_override', true,
      'settings', v_settings,
      'main_round_eligible', v_is_eligible,
      'updated_at', v_override_record.updated_at
    );
  END IF;

  -- 4. Level default
  IF v_student_level IS NOT NULL AND trim(v_student_level) <> '' THEN
    SELECT * INTO v_level_record
    FROM public.student_practice_access
    WHERE scope = 'level' AND lower(trim(level)) = lower(trim(v_student_level))
    LIMIT 1;

    IF FOUND THEN
      v_settings := COALESCE(v_level_record.settings, '{}'::jsonb);
      IF jsonb_typeof(v_settings) = 'object' AND NOT (v_settings ? 'oral_rounds') THEN
        v_settings := v_settings || jsonb_build_object('oral_rounds', v_oral_default);
      END IF;
      RETURN jsonb_build_object(
        'ok', true,
        'student_id', p_student_id,
        'level', v_student_level,
        'scope', 'level',
        'source_label', 'From ' || v_student_level,
        'has_override', false,
        'settings', v_settings,
        'main_round_eligible', v_is_eligible,
        'updated_at', v_level_record.updated_at
      );
    END IF;
  END IF;

  -- 5. Fallback: default full access
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
      'main_round', jsonb_build_object('all', true, 'categories', '[]'::jsonb),
      'oral_rounds', v_oral_default
    ),
    'main_round_eligible', v_is_eligible,
    'updated_at', null
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_student_effective_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_student_effective_access(UUID) TO authenticated, service_role;
