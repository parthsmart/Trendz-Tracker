-- Multi-centre step 5d: content belongs to a centre.
--
-- Announcements, daily tasks, resources, weekly tests, homework, live classes and
-- store items get centre_id. NULL means "every centre" (only owners and directors
-- can make that); otherwise the row belongs to one centre and only that centre's
-- people see it. "Everyone" in a teacher's or head's content now means their centre.
--
--   * Existing rows are put in the default centre (Baran). This uses a column
--     default, so no row is rewritten and no existing trigger fires. Store items
--     stay NULL (shared).
--   * content_centre_stamp(): a teacher, head or vice head always writes their own
--     centre and can never move a row to another centre. Owners and directors may
--     choose a centre or NULL. The service role (API) gets the author's centre
--     when it does not set one.
--   * Targeted recipients, homework targets, live class targets, homework
--     completions, weekly test attempts and store requests must be in the row's
--     centre.
--   * Read policies and the student-facing functions hide other centres' content.
--   * teacher_bulk_apply_level_access reaches only the teacher's centre.
--
-- With one centre (production today) every student sees exactly what they saw before.
-- No data is deleted and no column is dropped.
-- Rollback: supabase/rollbacks/45_centre_content_rollback.sql

-- 1. Columns (existing rows -> default centre, without rewriting any row) -------------

DO $$
DECLARE
  v_default uuid;
  t text;
BEGIN
  SELECT id INTO v_default FROM public.centres WHERE is_default ORDER BY created_at LIMIT 1;
  IF v_default IS NULL THEN RAISE EXCEPTION 'No default centre.'; END IF;
  FOREACH t IN ARRAY ARRAY['announcements', 'daily_tasks', 'resources', 'weekly_tests',
                           'homework_assignments', 'live_classes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'centre_id') THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN centre_id uuid DEFAULT %L REFERENCES public.centres(id)',
                     t, v_default);
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN centre_id DROP DEFAULT', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (centre_id)', t || '_centre_idx', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.reward_items ADD COLUMN IF NOT EXISTS centre_id uuid REFERENCES public.centres(id);
CREATE INDEX IF NOT EXISTS reward_items_centre_idx ON public.reward_items (centre_id);

-- 2. Helpers -------------------------------------------------------------------------

-- Can this person see content of this centre? NULL content = every centre.
CREATE OR REPLACE FUNCTION public.content_centre_ok(p_centre uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_centre IS NULL
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = p_user
                    AND (p.centre_id = p_centre OR p.role IN ('owner', 'director', 'admin')));
$function$;

CREATE OR REPLACE FUNCTION public.content_centre_visible(p_centre uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.content_centre_ok(p_centre, auth.uid());
$function$;

REVOKE ALL ON FUNCTION public.content_centre_ok(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_centre_ok(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.content_centre_visible(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.content_centre_visible(uuid) TO authenticated, service_role;

-- 3. Stamp the centre on every write ---------------------------------------------------
-- TG_ARGV[0] is the author column (created_by / assigned_by).

CREATE OR REPLACE FUNCTION public.content_centre_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_network boolean := false;
  v_centre uuid;
  v_author uuid;
  v_row jsonb;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT p.role IN ('owner', 'director', 'admin'), p.centre_id INTO v_network, v_centre
      FROM public.profiles p WHERE p.id = v_uid;
  END IF;

  IF v_uid IS NOT NULL AND v_network IS NOT TRUE THEN
    -- Teachers, heads and vice heads: always their own centre, never moved.
    IF TG_OP = 'UPDATE' THEN
      NEW.centre_id := OLD.centre_id;
    ELSE
      IF v_centre IS NULL THEN
        RAISE EXCEPTION 'Your account has no centre.' USING ERRCODE = '42501';
      END IF;
      NEW.centre_id := v_centre;
    END IF;
  ELSIF TG_OP = 'INSERT' AND NEW.centre_id IS NULL AND v_uid IS NULL THEN
    -- Service role (API): the author's centre. Owners and directors have none,
    -- so their content stays for every centre unless they pick one.
    IF TG_ARGV[0] <> '-' THEN
      v_author := NULLIF(to_jsonb(NEW) ->> TG_ARGV[0], '')::uuid;
    END IF;
    IF v_author IS NOT NULL THEN
      SELECT centre_id INTO v_centre FROM public.profiles WHERE id = v_author;
      NEW.centre_id := v_centre;
    END IF;
  END IF;

  -- Targets written on the row itself must be in the row's centre. On UPDATE only
  -- when the targets or the centre change, so a later student move never blocks
  -- ending a class or editing a title.
  v_row := to_jsonb(NEW);
  IF NEW.centre_id IS NOT NULL AND (TG_OP = 'INSERT'
       OR NEW.centre_id IS DISTINCT FROM OLD.centre_id
       OR v_row -> 'target_student_id' IS DISTINCT FROM to_jsonb(OLD) -> 'target_student_id'
       OR v_row -> 'target_student_ids' IS DISTINCT FROM to_jsonb(OLD) -> 'target_student_ids') THEN
    IF TG_TABLE_NAME = 'homework_assignments' AND v_row ->> 'target_student_id' IS NOT NULL THEN
      IF public.profile_centre((v_row ->> 'target_student_id')::uuid) IS DISTINCT FROM NEW.centre_id THEN
        RAISE EXCEPTION 'That student is in another centre.' USING ERRCODE = '42501';
      END IF;
    ELSIF TG_TABLE_NAME = 'live_classes' AND jsonb_typeof(v_row -> 'target_student_ids') = 'array' THEN
      IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_row -> 'target_student_ids') e(sid)
                  WHERE public.profile_centre(e.sid::uuid) IS DISTINCT FROM NEW.centre_id) THEN
        RAISE EXCEPTION 'Some of those students are in another centre.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.content_centre_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS content_centre_stamp ON public.announcements;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('created_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.daily_tasks;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.daily_tasks
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('created_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.resources;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('created_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.weekly_tests;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.weekly_tests
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('created_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.homework_assignments;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('assigned_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.live_classes;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.live_classes
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('created_by');
DROP TRIGGER IF EXISTS content_centre_stamp ON public.reward_items;
CREATE TRIGGER content_centre_stamp BEFORE INSERT OR UPDATE ON public.reward_items
  FOR EACH ROW EXECUTE FUNCTION public.content_centre_stamp('-');

-- 4. Rows that point at a student must stay inside the content's centre ----------------
-- TG_ARGV[0] = parent table, TG_ARGV[1] = column holding the parent id.

CREATE OR REPLACE FUNCTION public.content_student_centre_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_parent text := to_jsonb(NEW) ->> TG_ARGV[1];
  v_centre uuid;
BEGIN
  IF v_parent IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT centre_id FROM public.%I WHERE id::text = $1', TG_ARGV[0])
     INTO v_centre USING v_parent;
  IF v_centre IS NULL OR public.profile_centre(NEW.student_id) IS NOT DISTINCT FROM v_centre THEN
    RETURN NEW;
  END IF;
  IF TG_ARGV[2] = 'skip' THEN
    RETURN NULL;   -- bulk fills (homework "all"/"level") simply leave the student out
  END IF;
  RAISE EXCEPTION 'That student is in another centre.' USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.content_student_centre_check() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS content_student_centre ON public.announcement_recipients;
CREATE TRIGGER content_student_centre BEFORE INSERT OR UPDATE ON public.announcement_recipients
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('announcements', 'announcement_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.daily_task_recipients;
CREATE TRIGGER content_student_centre BEFORE INSERT OR UPDATE ON public.daily_task_recipients
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('daily_tasks', 'task_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.resource_recipients;
CREATE TRIGGER content_student_centre BEFORE INSERT OR UPDATE ON public.resource_recipients
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('resources', 'resource_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.weekly_test_recipients;
CREATE TRIGGER content_student_centre BEFORE INSERT OR UPDATE ON public.weekly_test_recipients
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('weekly_tests', 'test_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.weekly_test_attempts;
CREATE TRIGGER content_student_centre BEFORE INSERT ON public.weekly_test_attempts
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('weekly_tests', 'test_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.weekly_test_practice_runs;
CREATE TRIGGER content_student_centre BEFORE INSERT ON public.weekly_test_practice_runs
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('weekly_tests', 'test_id', 'raise');
DROP TRIGGER IF EXISTS content_student_centre ON public.homework_completions;
CREATE TRIGGER content_student_centre BEFORE INSERT ON public.homework_completions
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('homework_assignments', 'assignment_id', 'skip');
DROP TRIGGER IF EXISTS content_student_centre ON public.reward_redemptions;
CREATE TRIGGER content_student_centre BEFORE INSERT ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.content_student_centre_check('reward_items', 'item_id', 'raise');

-- 5. Read policies: other centres' content is hidden ----------------------------------

ALTER POLICY announcements_read_policy ON public.announcements USING (
  is_admin() OR (content_centre_visible(centre_id) AND (
    (is_teacher(auth.uid()) AND ((created_by = auth.uid()) OR (target_scope = 'all'::text)))
    OR (((target_scope = 'targeted'::text) AND is_announcement_recipient(id, auth.uid()))
        OR ((target_scope = 'all'::text) AND ((audience_level IS NULL)
            OR (lower(TRIM(BOTH FROM audience_level)) = 'everyone'::text)
            OR (lower(TRIM(BOTH FROM audience_level)) = lower(TRIM(BOTH FROM COALESCE(student_level(auth.uid()), ''::text))))))))));

ALTER POLICY daily_tasks_read_policy ON public.daily_tasks USING (
  is_admin() OR (content_centre_visible(centre_id) AND (
    (is_teacher(auth.uid()) AND ((created_by = auth.uid()) OR (target_scope = 'all'::text)))
    OR ((active = true) AND (((target_scope = 'targeted'::text) AND is_daily_task_recipient(id, auth.uid()))
        OR ((target_scope = 'all'::text) AND ((level IS NULL)
            OR (lower(TRIM(BOTH FROM level)) = 'everyone'::text)
            OR (lower(TRIM(BOTH FROM level)) = lower(TRIM(BOTH FROM COALESCE(student_level(auth.uid()), ''::text)))))))))));

ALTER POLICY resources_read_policy ON public.resources USING (
  is_admin() OR (content_centre_visible(centre_id) AND (
    (is_teacher(auth.uid()) AND ((created_by = auth.uid()) OR (target_scope = 'all'::text)))
    OR ((active = true) AND (((target_scope = 'targeted'::text) AND is_resource_recipient(id, auth.uid()))
        OR ((target_scope = 'all'::text) AND ((audience_level IS NULL)
            OR (lower(TRIM(BOTH FROM audience_level)) = 'everyone'::text)
            OR (lower(TRIM(BOTH FROM audience_level)) = lower(TRIM(BOTH FROM COALESCE(student_level(auth.uid()), ''::text)))))))))));

ALTER POLICY weekly_tests_select_scoped ON public.weekly_tests USING (
  is_admin() OR (content_centre_visible(centre_id) AND (
    (is_teacher(auth.uid()) AND ((created_by = auth.uid()) OR (target_scope = 'all'::text)))
    OR (((target_scope = 'targeted'::text) AND is_weekly_test_recipient(id, auth.uid()))
        OR ((target_scope = 'all'::text) AND ((audience_level IS NULL)
            OR (lower(TRIM(BOTH FROM audience_level)) = 'everyone'::text)
            OR (lower(TRIM(BOTH FROM audience_level)) = lower(TRIM(BOTH FROM COALESCE(student_level(auth.uid()), ''::text))))))))));

ALTER POLICY "Students can view eligible live_classes" ON public.live_classes USING (
  (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'student'::text) AND (p.active = true))))
  AND content_centre_visible(centre_id)
  AND (((target_student_ids IS NOT NULL) AND (target_student_ids ? (auth.uid())::text))
       OR ((target_student_ids IS NULL) AND ((target_level IS NULL)
           OR (target_level = (SELECT profiles.level FROM profiles WHERE (profiles.id = auth.uid())))))));

ALTER POLICY "Teachers can view assigned live_classes" ON public.live_classes USING (
  (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'teacher'::text) AND (p.active = true))))
  AND ((teacher_id = auth.uid())
       OR ((invited_teacher_ids IS NOT NULL) AND (invited_teacher_ids ? (auth.uid())::text))
       OR (content_centre_visible(centre_id) AND (EXISTS (SELECT 1 FROM teacher_student_assignments tsa
             WHERE ((tsa.teacher_id = auth.uid()) AND (((live_classes.target_student_ids IS NOT NULL)
                     AND (live_classes.target_student_ids ? (tsa.student_id)::text))
                   OR ((live_classes.target_student_ids IS NULL) AND ((live_classes.target_level IS NULL)
                     OR (live_classes.target_level = (SELECT profiles.level FROM profiles
                                                        WHERE (profiles.id = tsa.student_id))))))))))));

ALTER POLICY reward_items_select ON public.reward_items USING (
  (active AND content_centre_visible(centre_id)) OR is_admin());

-- 6. Student-facing functions ------------------------------------------------------------

-- 6a. my_weekly_tests: + centre filter.
CREATE OR REPLACE FUNCTION public.my_weekly_tests()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_level text;
  v_today date := public.today_ist();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT p.level INTO v_level FROM public.profiles p WHERE p.id = v_me;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'notes', t.notes, 'test_date', t.test_date,
      'type', t.test_type, 'opens_at', t.opens_ts, 'closes_at', t.closes_ts,
      'state', CASE
                 WHEN t.test_type = 'online' THEN
                   CASE WHEN now() < t.opens_ts THEN 'upcoming'
                        WHEN now() >= t.closes_ts THEN 'closed' ELSE 'open' END
                 ELSE
                   CASE WHEN t.test_date > v_today THEN 'upcoming'
                        WHEN t.test_date = v_today THEN 'today' ELSE 'past' END
               END,
      'leaderboard_ready', (t.test_type = 'offline' OR now() >= t.closes_ts),
      'sections', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'section_id', s.id, 'kind', s.kind, 'name', c.name,
                 'category_id', s.category_id, 'activity_key', s.activity_key,
                 'seconds', s.seconds, 'position', s.position,
                 'flash_digits', s.flash_digits, 'flash_count', s.flash_count,
                 'flash_speed_ms', s.flash_speed_ms, 'flash_mode', s.flash_mode,
                 'question_count', s.question_count,
                 'attempt', a.status, 'tries_started', a.tries_started,
                 'tries_correct', a.tries_correct,
                 'correct', sc.correct, 'total', sc.total, 'time_seconds', sc.time_seconds)
               ORDER BY s.position)
          FROM public.weekly_test_sections s
          LEFT JOIN public.categories c ON c.id = s.category_id
          LEFT JOIN public.weekly_test_attempts a
                 ON a.test_id = t.id AND a.student_id = v_me AND a.section_id = s.id
          LEFT JOIN public.weekly_test_scores sc
                 ON sc.test_id = t.id AND sc.student_id = v_me AND sc.section_id = s.id
         WHERE s.test_id = t.id), '[]'::jsonb),
      'scores', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'category', c2.name, 'kind', s2.kind, 'activity_key', s2.activity_key,
                 'correct', sc2.correct, 'total', sc2.total,
                 'time_seconds', sc2.time_seconds, 'source', sc2.source))
          FROM public.weekly_test_scores sc2
          LEFT JOIN public.categories c2 ON c2.id = sc2.category_id
          LEFT JOIN public.weekly_test_sections s2 ON s2.id = sc2.section_id
         WHERE sc2.test_id = t.id AND sc2.student_id = v_me), '[]'::jsonb)
    ) ORDER BY t.test_date DESC)
    FROM (
      SELECT w.*,
             COALESCE(w.opens_at, (w.test_date::timestamp AT TIME ZONE 'Asia/Kolkata')) AS opens_ts,
             COALESCE(w.closes_at, ((w.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS closes_ts
        FROM public.weekly_tests w
       WHERE w.test_date BETWEEN v_today - 60 AND v_today + 30
         AND (w.audience_level IS NULL OR w.audience_level = v_level)
         AND public.content_centre_ok(w.centre_id, v_me)
    ) t
  ), '[]'::jsonb);
END;
$function$;

-- 6b. get_eligible_live_classes_for_student: + centre filter (the student's centre).
CREATE OR REPLACE FUNCTION public.get_eligible_live_classes_for_student(p_student_id uuid)
 RETURNS TABLE(id uuid, title text, teacher_id uuid, teacher_name text, scheduled_start_time timestamp with time zone, duration_minutes integer, status text, provider_status text, target_level text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_is_active BOOLEAN;
BEGIN
  -- Strict caller authorization check:
  -- Allowed:
  -- 1. Explicitly trusted server role: v_is_service_role
  -- 2. Student themselves: v_caller = p_student_id
  -- 3. Admin: public.is_admin()
  -- 4. Authorized assigned teacher: public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, p_student_id)
  IF v_is_service_role THEN
    NULL;
  ELSIF v_caller IS NULL THEN
    RAISE EXCEPTION 'Access denied: Authentication required.'
      USING ERRCODE = '42501';
  ELSIF v_caller = p_student_id THEN
    -- Student reading own eligible classes
    NULL;
  ELSIF public.is_admin() THEN
    -- Admin reading student's eligible classes
    NULL;
  ELSIF public.is_teacher(v_caller) AND public.is_teacher_assigned_to_student(v_caller, p_student_id) THEN
    -- Authorized assigned teacher reading student's eligible classes
    NULL;
  ELSE
    RAISE EXCEPTION 'Access denied: You are not authorized to view eligible live classes for this student.'
      USING ERRCODE = '42501';
  END IF;

  SELECT p.level, p.active
  INTO v_student_level, v_is_active
  FROM public.profiles p
  WHERE p.id = p_student_id;

  IF v_is_active IS NOT TRUE THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    lc.id,
    lc.title,
    lc.teacher_id,
    tp.full_name AS teacher_name,
    lc.scheduled_start_time,
    lc.duration_minutes,
    lc.status,
    lc.provider_status,
    lc.target_level
  FROM public.live_classes lc
  JOIN public.profiles tp ON tp.id = lc.teacher_id
  WHERE lc.status IN ('scheduled', 'waiting', 'live', 'ended')
    AND public.content_centre_ok(lc.centre_id, p_student_id)
    AND (
      (lc.target_student_ids IS NOT NULL AND lc.target_student_ids ? p_student_id::text)
      OR (
        lc.target_student_ids IS NULL
        AND (lc.target_level IS NULL OR lc.target_level = v_student_level)
      )
    )
  ORDER BY
    CASE
      WHEN lc.status = 'live' THEN 1
      WHEN lc.status = 'waiting' THEN 2
      WHEN lc.status = 'scheduled' THEN 3
      ELSE 4
    END,
    lc.scheduled_start_time ASC;
END;
$function$;

-- 6c. is_student_homework_recipient: + centre check after the student is loaded.
CREATE OR REPLACE FUNCTION public.is_student_homework_recipient(p_assignment_id uuid, p_student_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_assign RECORD;
  v_stu_level TEXT;
  v_stu_active BOOLEAN;
  v_creator_role TEXT;
  v_creator_active BOOLEAN;
BEGIN
  -- 1. If student already has a completion record for this assignment, preserve their history!
  IF EXISTS (
    SELECT 1 FROM public.homework_completions
    WHERE assignment_id = p_assignment_id AND student_id = p_student_id
  ) THEN
    RETURN true;
  END IF;

  SELECT * INTO v_assign FROM public.homework_assignments WHERE id = p_assignment_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT level, active INTO v_stu_level, v_stu_active
  FROM public.profiles WHERE id = p_student_id AND role = 'student';
  IF NOT FOUND OR v_stu_active IS NOT TRUE THEN
    RETURN false;
  END IF;

  -- Homework of one centre is only for that centre's students.
  IF NOT public.content_centre_ok(v_assign.centre_id, p_student_id) THEN
    RETURN false;
  END IF;

  SELECT role, active INTO v_creator_role, v_creator_active
  FROM public.profiles WHERE id = v_assign.assigned_by;
  IF NOT FOUND OR v_creator_active IS NOT TRUE THEN
    RETURN false;
  END IF;

  -- If creator is Admin:
  IF v_creator_role IN ('owner', 'director', 'admin') THEN
    IF v_assign.target_type = 'all' THEN
      RETURN true;
    ELSIF v_assign.target_type = 'level' THEN
      RETURN v_assign.target_level IS NOT NULL AND LOWER(TRIM(v_assign.target_level)) = LOWER(TRIM(COALESCE(v_stu_level, '')));
    ELSIF v_assign.target_type = 'student' THEN
      RETURN v_assign.target_student_id = p_student_id;
    END IF;
    RETURN false;
  END IF;

  -- If creator is Teacher:
  IF v_creator_role = 'teacher' THEN
    -- Check teacher active and can_manage_tasks if teacher_permissions table exists
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.teacher_permissions
        WHERE teacher_id = v_assign.assigned_by AND can_manage_tasks = true
      ) THEN
        RETURN false;
      END IF;
    END IF;

    -- Student MUST be assigned to this teacher in teacher_student_assignments
    IF NOT EXISTS (
      SELECT 1 FROM public.teacher_student_assignments
      WHERE teacher_id = v_assign.assigned_by AND student_id = p_student_id
    ) THEN
      RETURN false;
    END IF;

    IF v_assign.target_type = 'all' THEN
      RETURN true;
    ELSIF v_assign.target_type = 'level' THEN
      RETURN v_assign.target_level IS NOT NULL AND LOWER(TRIM(v_assign.target_level)) = LOWER(TRIM(COALESCE(v_stu_level, '')));
    ELSIF v_assign.target_type = 'student' THEN
      RETURN v_assign.target_student_id = p_student_id;
    END IF;
    RETURN false;
  END IF;

  RETURN false;
END;
$function$;

-- 6d. reward_shop: + only shared items and the student's centre's items.
CREATE OR REPLACE FUNCTION public.reward_shop(p_student uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_target uuid := COALESCE(p_student, auth.uid());
  b record;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT public.xp_can_view(v_target) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  SELECT * INTO b FROM public.reward_balance(v_target);
  RETURN jsonb_build_object(
    'can_request', v_target = v_me,
    'earned', b.earned, 'spent', b.spent, 'balance', b.balance,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'icon', i.icon,
                         'description', i.description, 'cost', i.cost, 'stock', i.stock) ORDER BY i.cost, i.name)
                         FROM public.reward_items i WHERE i.active
                          AND public.content_centre_ok(i.centre_id, v_target)), '[]'::jsonb),
    'redemptions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.item_name, 'icon', r.item_icon,
                               'cost', r.cost, 'status', r.status, 'requested_at', r.requested_at,
                               'decided_at', r.decided_at, 'note', r.note) ORDER BY r.requested_at DESC)
                               FROM (SELECT * FROM public.reward_redemptions WHERE student_id = v_target
                                      ORDER BY requested_at DESC LIMIT 20) r), '[]'::jsonb)
  );
END;
$function$;

-- 6e. reward_request: + another centre's item is "not available".
CREATE OR REPLACE FUNCTION public.reward_request(p_item bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  i public.reward_items%ROWTYPE;
  b record;
  v_id bigint;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM 1 FROM public.profiles WHERE id = v_me AND role = 'student' AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only students can ask for rewards.'; END IF;
  SELECT * INTO i FROM public.reward_items WHERE id = p_item FOR UPDATE;
  IF NOT FOUND OR NOT i.active OR NOT public.content_centre_ok(i.centre_id, v_me) THEN
    RAISE EXCEPTION 'This reward is not available.';
  END IF;
  IF i.stock IS NOT NULL AND i.stock <= 0 THEN RAISE EXCEPTION 'This reward is out of stock.'; END IF;
  IF (SELECT count(*) FROM public.reward_redemptions WHERE student_id = v_me AND status = 'requested') >= 3 THEN
    RAISE EXCEPTION 'You already have 3 requests waiting. Collect them from your trainer first.';
  END IF;
  SELECT * INTO b FROM public.reward_balance(v_me);
  IF b.balance < i.cost THEN RAISE EXCEPTION 'You need % more XP for this reward.', i.cost - b.balance; END IF;

  INSERT INTO public.reward_redemptions (student_id, item_id, item_name, item_icon, cost)
  VALUES (v_me, i.id, i.name, i.icon, i.cost) RETURNING id INTO v_id;
  IF i.stock IS NOT NULL THEN
    UPDATE public.reward_items SET stock = stock - 1, updated_at = now() WHERE id = i.id;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'balance', b.balance - i.cost);
END;
$function$;

-- 6f. weekly_test_practice_block_reason: the test's own centre decides (it used the
--     creator's centre, which is empty for tests made by owners and directors).
CREATE OR REPLACE FUNCTION public.weekly_test_practice_block_reason(p_test uuid, p_student uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_student record;
  v_test record;
  v_closes timestamptz;
  v_creator_centre uuid;
BEGIN
  SELECT id, role, level, active, deleted_at, centre_id INTO v_student
    FROM public.profiles WHERE id = p_student;
  IF NOT FOUND OR v_student.role IS DISTINCT FROM 'student'
     OR v_student.active IS NOT TRUE OR v_student.deleted_at IS NOT NULL THEN
    RETURN 'Only active students can practise weekly tests.';
  END IF;

  SELECT * INTO v_test FROM public.weekly_tests WHERE id = p_test;
  IF NOT FOUND THEN RETURN 'This weekly test was not found.'; END IF;

  IF v_test.test_type IS DISTINCT FROM 'online' THEN
    RETURN 'Only online weekly tests can be practised.';
  END IF;

  v_closes := COALESCE(v_test.closes_at, ((v_test.test_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'));
  IF now() < v_closes THEN
    RETURN 'Practice opens after the official test closes.';
  END IF;

  IF v_test.target_scope = 'targeted' OR public.has_weekly_test_recipients(p_test) THEN
    IF NOT public.is_weekly_test_recipient(p_test, p_student) THEN
      RETURN 'This weekly test was not assigned to you.';
    END IF;
  ELSIF v_test.audience_level IS NOT NULL AND TRIM(v_test.audience_level) <> ''
        AND LOWER(TRIM(v_test.audience_level)) <> 'everyone' THEN
    IF LOWER(TRIM(v_test.audience_level)) IS DISTINCT FROM LOWER(TRIM(COALESCE(v_student.level, ''))) THEN
      RETURN 'This weekly test is for ' || v_test.audience_level || ' students only.';
    END IF;
  END IF;

  v_creator_centre := v_test.centre_id;
  IF v_creator_centre IS NOT NULL AND v_creator_centre IS DISTINCT FROM v_student.centre_id THEN
    RETURN 'This weekly test belongs to another centre.';
  END IF;

  RETURN NULL;
END;
$function$;

-- 6g. teacher_bulk_apply_level_access: a teacher reaches only students of their centre.
CREATE OR REPLACE FUNCTION public.teacher_bulk_apply_level_access(p_level text, p_settings jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      AND p.centre_id IS NOT DISTINCT FROM public.profile_centre(v_caller)
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
$function$;
