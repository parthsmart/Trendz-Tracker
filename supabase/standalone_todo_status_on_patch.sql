-- ==============================================================================
-- TRENDZ TRACKER - STANDALONE SECURITY HOTFIX: todo_status_on Authorization
-- Scope: PRE-PHASE-18 DATABASE COMPATIBLE (Zero teacher tables/helpers referenced)
-- Instructions: Run in Supabase SQL Editor as database owner.
-- ==============================================================================

-- 1. Secure todo_status_on with caller authorization and verbatim calculation body
CREATE OR REPLACE FUNCTION public.todo_status_on(p_student uuid, p_day date)
RETURNS TABLE (
  task_id uuid,
  task_title text,
  task_section text,
  task_category_id uuid,
  task_activity_key text,
  required_count integer,
  done_count integer,
  done boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_is_service_role boolean := (v_jwt_role = 'service_role');
  v_caller_active boolean;
BEGIN
  IF p_student IS NULL THEN
    RAISE EXCEPTION 'Target student ID is required.' USING ERRCODE = '22023';
  END IF;

  -- Caller authorization: service_role and active admin permitted across all students
  IF NOT v_is_service_role AND NOT public.is_admin() THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'Unauthorized: Authentication required.' USING ERRCODE = '42501';
    END IF;

    SELECT p.active INTO v_caller_active
    FROM public.profiles p
    WHERE p.id = v_caller;

    IF v_caller_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Forbidden: Inactive or invalid user.' USING ERRCODE = '42501';
    END IF;

    IF v_caller <> p_student THEN
      RAISE EXCEPTION 'Forbidden: You may only view your own daily tasks.' USING ERRCODE = '42501';
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
                AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
          WHEN t.category_id IS NOT NULL THEN
            (SELECT count(*) FROM public.results r
              WHERE r.student_id = p_student AND r.category_id = t.category_id
                AND r.entry_date = p_day)
          WHEN t.section = 'round' THEN
            (SELECT count(DISTINCT r.student_round_id) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'round'
                AND r.student_round_id IS NOT NULL AND r.entry_date = p_day)
          WHEN t.section = 'basics' THEN
            (SELECT count(*) FROM public.results r
               JOIN public.categories c ON c.id = r.category_id
              WHERE r.student_id = p_student AND c.section = 'basics' AND r.entry_date = p_day)
          WHEN t.section = 'elements' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'element'
                AND (t.activity_key IS NULL OR a.settings ->> 'drill' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          WHEN t.section = 'flash' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'flash_anzan'
                AND (t.flash_digits IS NULL OR a.settings ->> 'digits' = t.flash_digits::text)
                AND (t.flash_count IS NULL OR a.settings ->> 'count' = t.flash_count::text)
                AND (t.flash_speed_ms IS NULL OR a.settings ->> 'speed_ms' = t.flash_speed_ms::text)
                AND (t.flash_mode IS NULL OR a.settings ->> 'mode' = t.flash_mode)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          WHEN t.section = 'memoriad' THEN
            (SELECT count(*) FROM public.activity_results a
              WHERE a.student_id = p_student AND a.activity_type = 'memoriad'
                AND (t.activity_key IS NULL OR a.settings ->> 'module' = t.activity_key)
                AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date = p_day)
          ELSE 0
        END)::integer AS cnt
        FROM public.daily_tasks t
        JOIN public.profiles p ON p.id = p_student
       WHERE t.active AND (t.level IS NULL OR t.level = p.level)
    ) x
   ORDER BY x.sort_order, x.title;
END;
$$;

-- 2. Ensure todo_for delegates cleanly to todo_status_on
CREATE OR REPLACE FUNCTION public.todo_for(p_student uuid)
RETURNS TABLE (
  task_id uuid,
  task_title text,
  task_section text,
  task_category_id uuid,
  task_activity_key text,
  required_count integer,
  done_count integer,
  done boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
BEGIN
  IF auth.uid() IS NULL OR (p_student <> auth.uid() AND NOT public.is_admin()) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.todo_status_on(p_student, public.today_ist());
END;
$$;

-- 3. Execution grants & privilege hardening
REVOKE ALL ON FUNCTION public.todo_status_on(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_status_on(uuid, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.todo_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_for(uuid) TO authenticated, service_role;
