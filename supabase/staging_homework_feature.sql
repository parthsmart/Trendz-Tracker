-- ==============================================================================
-- staging_homework_feature.sql
-- Standalone Staging Prerequisite: Independent Homework Feature & Message Linking
--
-- STRICT ARCHITECTURAL CONTRACT:
-- - Homework is strictly isolated from daily_tasks, daily_todo_log, streaks,
--   shields, and streak leaderboards.
-- - Completing homework does NOT grant streak credit or increment streak counters.
-- - Permitted admins & teachers can assign homework to all, a level, or students
--   in their authorized roster.
-- - Teachers cannot assign homework to students outside their roster or without can_manage_tasks.
-- - Intended assignment recipients and completion history are strictly preserved
--   across student level or teacher roster changes.
-- - Students cannot directly mutate homework_completions or self-certify graded drills.
-- - Restricted server RPC submit_homework_completion authoritatively validates
--   session binding, assignment date, settings/workload, duration, saved result ownership,
--   and guarantees atomicity with replay protection.
-- - verify_homework_completion only approves legitimate pending offline evidence,
--   respects required_count, and rejects online homework bypasses.
-- - Multi-source typed private message score linking with server ownership checks.
-- - Idempotent, wrapped in a single transaction with operator latch & tripwire safety.
-- ==============================================================================

-- Operator confirmation latch
SET app.target_environment = 'staging_xhgzbbkvwojwfbexvcmh';

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. PRE-FLIGHT CHECKS: OPERATOR LATCH & PRODUCTION DATA TRIPWIRE
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_target_env TEXT := current_setting('app.target_environment', true);
BEGIN
  -- 0a. Operator Intent Confirmation Latch
  IF v_target_env IS DISTINCT FROM 'staging_xhgzbbkvwojwfbexvcmh' THEN
    RAISE EXCEPTION 'OPERATOR SAFETY HALT: Target environment latch unset or mismatched. Got "%". Set `SET app.target_environment = ''staging_xhgzbbkvwojwfbexvcmh'';` before running.',
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

-- -----------------------------------------------------------------------------
-- 1. Table: public.homework_assignments
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.homework_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(120) NOT NULL,
  instructions TEXT NULL,
  assigned_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  target_type VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (target_type IN ('all', 'level', 'student')),
  target_level VARCHAR(50) NULL,
  target_student_id UUID NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  activity_type VARCHAR(30) NOT NULL DEFAULT 'paper' CHECK (activity_type IN ('basics', 'flash', 'element', 'memoriad', 'round', 'paper', 'custom')),
  category_id UUID NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_seconds INTEGER NULL CHECK (duration_seconds IS NULL OR (duration_seconds >= 5 AND duration_seconds <= 3600)),
  required_count INTEGER NOT NULL DEFAULT 1 CHECK (required_count >= 1),
  assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT chk_homework_assignment_title CHECK (char_length(trim(title)) >= 1 AND char_length(title) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_homework_assignments_target
  ON public.homework_assignments (target_type, target_level, target_student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_homework_assignments_assigned_by
  ON public.homework_assignments (assigned_by, created_at DESC);

-- -----------------------------------------------------------------------------
-- 2. Table: public.homework_completions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.homework_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  progress_count INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'pending_review')),
  session_id UUID NULL,
  result_id UUID REFERENCES public.results(id) ON DELETE SET NULL,
  activity_result_id UUID REFERENCES public.activity_results(id) ON DELETE SET NULL,
  submission_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT NULL,
  completed_at TIMESTAMPTZ NULL,
  verified_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_homework_student_assignment UNIQUE (assignment_id, student_id)
);

ALTER TABLE public.homework_completions
  DROP CONSTRAINT IF EXISTS homework_completions_session_id_fkey;

CREATE INDEX IF NOT EXISTS idx_homework_completions_student
  ON public.homework_completions (student_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_homework_completions_assignment
  ON public.homework_completions (assignment_id);

-- -----------------------------------------------------------------------------
-- 2b. Table: public.homework_bound_sessions
-- Authoritative tracking of sessions and competition attempts bound to homework.
-- Unique session_id prevents an attempt or session from being bound to multiple assignments.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.homework_bound_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES public.homework_assignments(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_homework_bound_sessions_lookup
  ON public.homework_bound_sessions (assignment_id, student_id, session_id);

GRANT ALL ON TABLE public.homework_bound_sessions TO service_role, postgres;
GRANT SELECT ON TABLE public.homework_bound_sessions TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Triggers: updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_homework_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_homework_assignments_updated_at ON public.homework_assignments;
CREATE TRIGGER trg_homework_assignments_updated_at
  BEFORE UPDATE ON public.homework_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_homework_updated_at();

DROP TRIGGER IF EXISTS trg_homework_completions_updated_at ON public.homework_completions;
CREATE TRIGGER trg_homework_completions_updated_at
  BEFORE UPDATE ON public.homework_completions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_homework_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Helper: is_student_homework_recipient
-- Checks if p_student_id is an authorized recipient of p_assignment_id.
-- Preserves recipient history if a completion row already exists.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_student_homework_recipient(
  p_assignment_id UUID,
  p_student_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
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

  SELECT role, active INTO v_creator_role, v_creator_active
  FROM public.profiles WHERE id = v_assign.assigned_by;
  IF NOT FOUND OR v_creator_active IS NOT TRUE THEN
    RETURN false;
  END IF;

  -- If creator is Admin:
  IF v_creator_role = 'admin' THEN
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
$$;

-- -----------------------------------------------------------------------------
-- 5. Trigger: Lock in Intended Recipients at Assignment Creation
-- Populates homework_completions rows so recipients & history remain immutable
-- even if student levels or teacher rosters change later.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_homework_populate_recipients()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_creator_role TEXT;
  v_recip RECORD;
BEGIN
  SELECT role INTO v_creator_role FROM public.profiles WHERE id = NEW.assigned_by;

  IF v_creator_role = 'admin' THEN
    IF NEW.target_type = 'student' AND NEW.target_student_id IS NOT NULL THEN
      INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
      VALUES (NEW.id, NEW.target_student_id, 0, 'in_progress', NEW.created_at, NEW.created_at)
      ON CONFLICT (assignment_id, student_id) DO NOTHING;
    ELSIF NEW.target_type = 'level' AND NEW.target_level IS NOT NULL THEN
      INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
      SELECT NEW.id, p.id, 0, 'in_progress', NEW.created_at, NEW.created_at
      FROM public.profiles p
      WHERE p.role = 'student' AND p.active = true AND LOWER(TRIM(COALESCE(p.level, ''))) = LOWER(TRIM(NEW.target_level))
      ON CONFLICT (assignment_id, student_id) DO NOTHING;
    ELSIF NEW.target_type = 'all' THEN
      INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
      SELECT NEW.id, p.id, 0, 'in_progress', NEW.created_at, NEW.created_at
      FROM public.profiles p
      WHERE p.role = 'student' AND p.active = true
      ON CONFLICT (assignment_id, student_id) DO NOTHING;
    END IF;
  ELSIF v_creator_role = 'teacher' THEN
    IF NEW.target_type = 'student' AND NEW.target_student_id IS NOT NULL THEN
      -- Student must be in teacher's roster
      IF EXISTS (
        SELECT 1 FROM public.teacher_student_assignments
        WHERE teacher_id = NEW.assigned_by AND student_id = NEW.target_student_id
      ) THEN
        INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
        VALUES (NEW.id, NEW.target_student_id, 0, 'in_progress', NEW.created_at, NEW.created_at)
        ON CONFLICT (assignment_id, student_id) DO NOTHING;
      END IF;
    ELSIF NEW.target_type = 'level' AND NEW.target_level IS NOT NULL THEN
      INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
      SELECT NEW.id, p.id, 0, 'in_progress', NEW.created_at, NEW.created_at
      FROM public.profiles p
      JOIN public.teacher_student_assignments tsa ON tsa.student_id = p.id AND tsa.teacher_id = NEW.assigned_by
      WHERE p.role = 'student' AND p.active = true AND LOWER(TRIM(COALESCE(p.level, ''))) = LOWER(TRIM(NEW.target_level))
      ON CONFLICT (assignment_id, student_id) DO NOTHING;
    ELSIF NEW.target_type = 'all' THEN
      INSERT INTO public.homework_completions (assignment_id, student_id, progress_count, status, created_at, updated_at)
      SELECT NEW.id, p.id, 0, 'in_progress', NEW.created_at, NEW.created_at
      FROM public.profiles p
      JOIN public.teacher_student_assignments tsa ON tsa.student_id = p.id AND tsa.teacher_id = NEW.assigned_by
      WHERE p.role = 'student' AND p.active = true
      ON CONFLICT (assignment_id, student_id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_homework_populate_recipients ON public.homework_assignments;
CREATE TRIGGER trg_homework_populate_recipients
  AFTER INSERT ON public.homework_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_homework_populate_recipients();

-- -----------------------------------------------------------------------------
-- 6. Row Level Security Policies
-- -----------------------------------------------------------------------------
ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homework_completions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.homework_assignments FROM PUBLIC;
REVOKE ALL ON TABLE public.homework_assignments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.homework_assignments TO authenticated;
GRANT ALL ON TABLE public.homework_assignments TO service_role;

REVOKE ALL ON TABLE public.homework_completions FROM PUBLIC;
REVOKE ALL ON TABLE public.homework_completions FROM anon;
GRANT SELECT ON TABLE public.homework_completions TO authenticated;
GRANT ALL ON TABLE public.homework_completions TO service_role;

-- 6a. Assignments SELECT Policy
DROP POLICY IF EXISTS "homework_assignments_select" ON public.homework_assignments;
CREATE POLICY "homework_assignments_select"
  ON public.homework_assignments
  FOR SELECT TO authenticated
  USING (
    -- Admin can read all
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
    -- Teacher can read assignments they created OR assignments where target students are in their roster
    OR (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
      AND (
        assigned_by = auth.uid()
        OR (
          target_type = 'student'
          AND target_student_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.teacher_student_assignments
            WHERE teacher_id = auth.uid() AND student_id = target_student_id
          )
        )
      )
    )
    -- Student can read ONLY if they are an eligible recipient
    OR (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'student' AND active = true)
      AND public.is_student_homework_recipient(id, auth.uid())
    )
  );

-- 6b. Assignments INSERT Policy
-- Enforces active teacher capability (can_manage_tasks) and non-empty roster boundary
DROP POLICY IF EXISTS "homework_assignments_insert" ON public.homework_assignments;
CREATE POLICY "homework_assignments_insert"
  ON public.homework_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    -- Admin can insert any assignment
    (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
      AND assigned_by = auth.uid()
    )
    -- Teacher can insert ONLY with active account, can_manage_tasks, and targeting authorized roster
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = auth.uid() AND p.role = 'teacher' AND p.active = true
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
        )
        OR EXISTS (
          SELECT 1 FROM public.teacher_permissions tp
          WHERE tp.teacher_id = auth.uid() AND tp.can_manage_tasks = true
        )
      )
      AND assigned_by = auth.uid()
      AND (
        -- If specific student, must be in teacher roster
        (
          target_type = 'student'
          AND target_student_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.teacher_student_assignments tsa
            WHERE tsa.teacher_id = auth.uid() AND tsa.student_id = target_student_id
          )
        )
        -- If level, teacher must have at least one roster student at that level
        OR (
          target_type = 'level'
          AND target_level IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.teacher_student_assignments tsa
            JOIN public.profiles sp ON sp.id = tsa.student_id
            WHERE tsa.teacher_id = auth.uid()
              AND sp.role = 'student'
              AND sp.active = true
              AND LOWER(TRIM(COALESCE(sp.level, ''))) = LOWER(TRIM(target_level))
          )
        )
        -- If all, teacher must have at least one assigned student in roster
        OR (
          target_type = 'all'
          AND EXISTS (
            SELECT 1 FROM public.teacher_student_assignments tsa
            WHERE tsa.teacher_id = auth.uid()
          )
        )
      )
    )
  );

-- 6c. Assignments UPDATE / DELETE Policies
DROP POLICY IF EXISTS "homework_assignments_modify" ON public.homework_assignments;
CREATE POLICY "homework_assignments_modify"
  ON public.homework_assignments
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
    OR (
      assigned_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
        )
        OR EXISTS (
          SELECT 1 FROM public.teacher_permissions tp
          WHERE tp.teacher_id = auth.uid() AND tp.can_manage_tasks = true
        )
      )
    )
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
    OR (
      assigned_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
        )
        OR EXISTS (
          SELECT 1 FROM public.teacher_permissions tp
          WHERE tp.teacher_id = auth.uid() AND tp.can_manage_tasks = true
        )
      )
    )
  );

DROP POLICY IF EXISTS "homework_assignments_delete" ON public.homework_assignments;
CREATE POLICY "homework_assignments_delete"
  ON public.homework_assignments
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
    OR (
      assigned_by = auth.uid()
      AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
      AND (
        NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
        )
        OR EXISTS (
          SELECT 1 FROM public.teacher_permissions tp
          WHERE tp.teacher_id = auth.uid() AND tp.can_manage_tasks = true
        )
      )
    )
  );

-- 6d. Completions SELECT Policy
DROP POLICY IF EXISTS "homework_completions_select" ON public.homework_completions;
CREATE POLICY "homework_completions_select"
  ON public.homework_completions
  FOR SELECT TO authenticated
  USING (
    -- Admin can read all
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND active = true)
    -- Student can read only their own completion
    OR student_id = auth.uid()
    -- Teacher can read if they assigned it OR if student is in their roster
    OR (
      EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'teacher' AND active = true)
      AND (
        EXISTS (
          SELECT 1 FROM public.homework_assignments ha
          WHERE ha.id = assignment_id AND ha.assigned_by = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM public.teacher_student_assignments tsa
          WHERE tsa.teacher_id = auth.uid() AND tsa.student_id = homework_completions.student_id
        )
      )
    )
  );

ALTER TABLE public.homework_bound_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "homework_bound_sessions_select" ON public.homework_bound_sessions;
CREATE POLICY "homework_bound_sessions_select"
  ON public.homework_bound_sessions
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin', 'teacher') AND active = true
    )
  );

-- -----------------------------------------------------------------------------
-- 6b. Authoritative RPC: public.bind_homework_session
-- Binds a drill session or competition attempt to a homework assignment at start.
-- Server-only operation: Students cannot create session links directly.
-- Verifies session existence, student ownership, and exact homework match.
-- Idempotent retry returns success only if existing link matches.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bind_homework_session(
  p_assignment_id UUID,
  p_session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
  v_caller_active BOOLEAN;
  v_assign RECORD;
  v_jmcwc RECORD;
  v_drill RECORD;
  v_session_student UUID;
  v_existing_bound RECORD;
  v_is_recipient BOOLEAN;
  v_student_active BOOLEAN;
BEGIN
  IF p_assignment_id IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'Assignment ID and Session ID are required.' USING ERRCODE = '22023';
  END IF;

  -- 1. Strictly restrict execution to the trusted server role
  IF auth.uid() IS NOT NULL OR (COALESCE(auth.role(), '') != 'service_role' AND current_user NOT IN ('service_role', 'postgres')) THEN
    RAISE EXCEPTION 'Access denied: bind_homework_session can only be executed by the trusted server role.'
      USING ERRCODE = '42501';
  END IF;

  -- 2. Verify homework assignment exists
  SELECT * INTO v_assign FROM public.homework_assignments WHERE id = p_assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Assigned homework not found.' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Verify that the session exists and was started for that exact homework
  -- Check jmcwc_attempts
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_attempts') THEN
    SELECT * INTO v_jmcwc FROM public.jmcwc_attempts WHERE id = p_session_id;
  END IF;

  IF v_jmcwc.id IS NOT NULL THEN
    v_session_student := v_jmcwc.student_id;
    -- Verify attempt settings match homework requirements
    IF (v_assign.settings->>'mode') IS NOT NULL AND v_jmcwc.mode IS DISTINCT FROM (v_assign.settings->>'mode') THEN
      RAISE EXCEPTION 'Competition attempt mode mismatch.' USING ERRCODE = '22023';
    END IF;
    IF (v_assign.settings->>'category_key') IS NOT NULL AND v_jmcwc.category_key IS DISTINCT FROM (v_assign.settings->>'category_key') THEN
      RAISE EXCEPTION 'Competition attempt category mismatch.' USING ERRCODE = '22023';
    END IF;
    IF (v_assign.settings->>'group_key') IS NOT NULL AND v_jmcwc.group_key IS DISTINCT FROM (v_assign.settings->>'group_key') THEN
      RAISE EXCEPTION 'Competition attempt group mismatch.' USING ERRCODE = '22023';
    END IF;
  ELSE
    -- Check drill_sessions
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'drill_sessions') THEN
      SELECT * INTO v_drill FROM public.drill_sessions WHERE id = p_session_id;
    END IF;

    IF v_drill.id IS NOT NULL THEN
      v_session_student := v_drill.student_id;
      -- Verify session was started for this exact homework
      IF (v_drill.settings->>'homework_id') IS DISTINCT FROM p_assignment_id::text THEN
        RAISE EXCEPTION 'Session was not started for this homework assignment.' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  IF v_session_student IS NULL THEN
    RAISE EXCEPTION 'Session % does not exist.', p_session_id USING ERRCODE = 'P0002';
  END IF;

  -- 4. Verify student ownership and recipient eligibility
  SELECT active INTO v_student_active FROM public.profiles WHERE id = v_session_student;
  IF v_student_active IS NULL OR v_student_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Student account is inactive or not found.' USING ERRCODE = '42501';
  END IF;

  v_is_recipient := public.is_student_homework_recipient(p_assignment_id, v_session_student);
  IF v_is_recipient IS NOT TRUE THEN
    RAISE EXCEPTION 'Access denied: Student is not an authorized recipient of this homework assignment.'
      USING ERRCODE = '42501';
  END IF;

  -- 5. Retry check: A retry should return success only if the existing link matches
  SELECT * INTO v_existing_bound FROM public.homework_bound_sessions WHERE session_id = p_session_id;
  IF FOUND THEN
    IF v_existing_bound.assignment_id = p_assignment_id AND v_existing_bound.student_id = v_session_student THEN
      -- Existing link matches! Idempotent retry succeeds
      RETURN jsonb_build_object(
        'success', true,
        'assignment_id', p_assignment_id,
        'session_id', p_session_id,
        'student_id', v_session_student,
        'is_retry', true
      );
    ELSE
      -- Existing link does NOT match (bound to another homework or different student)
      RAISE EXCEPTION 'This session is already bound to another homework assignment.' USING ERRCODE = '23505';
    END IF;
  END IF;

  -- 6. Insert link
  INSERT INTO public.homework_bound_sessions (assignment_id, student_id, session_id)
  VALUES (p_assignment_id, v_session_student, p_session_id);

  -- Ensure an in_progress homework_completions row exists
  INSERT INTO public.homework_completions (
    assignment_id, student_id, status, progress_count
  ) VALUES (
    p_assignment_id, v_session_student, 'in_progress', 0
  ) ON CONFLICT (assignment_id, student_id) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'assignment_id', p_assignment_id,
    'session_id', p_session_id,
    'student_id', v_session_student,
    'is_retry', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bind_homework_session(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_homework_session(UUID, UUID) TO service_role;

-- -----------------------------------------------------------------------------
-- 6c. Authoritative JMCWC Attempt Creation with Atomic Homework Binding
-- Saves attempt and homework link in one transaction.
-- A retry reuses the attempt only if original homework link matches.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jmcwc_create_attempt(
  p_student uuid,
  p_request uuid,
  p_paper uuid,
  p_mode text,
  p_category text,
  p_questions jsonb,
  p_homework_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g text;
  p RECORD;
  a uuid;
  expected integer;
  q jsonb;
  blueprint_slot jsonb;
  question_marks numeric;
  target integer;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_student::text, 172026)
  );

  g := public.jmcwc_check_student(p_student);

  SELECT id INTO a
  FROM public.jmcwc_attempts
  WHERE student_id = p_student
    AND request_id = p_request;

  IF FOUND THEN
    -- A retry should reuse the attempt only if its original homework link matches the request
    IF p_homework_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.homework_bound_sessions
        WHERE session_id = a AND assignment_id = p_homework_id AND student_id = p_student
      ) THEN
        RAISE EXCEPTION 'Idempotent retry homework mismatch: attempt was not created for this homework assignment.'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      IF EXISTS (
        SELECT 1 FROM public.homework_bound_sessions
        WHERE session_id = a
      ) THEN
        RAISE EXCEPTION 'Idempotent retry homework mismatch: attempt was created for a homework assignment.'
          USING ERRCODE = '23505';
      END IF;
    END IF;

    RETURN a;
  END IF;

  IF p_request IS NULL
     OR p_mode IS NULL
     OR p_mode NOT IN ('flat','category')
  THEN
    RAISE EXCEPTION 'Invalid request.';
  END IF;

  SELECT * INTO p
  FROM public.jmcwc_papers
  WHERE id = p_paper
    AND group_key = g
    AND published;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No published paper for your assigned group.';
  END IF;

  IF (p_mode = 'flat' AND p_category IS NOT NULL)
     OR (p_mode = 'category' AND p_category IS NULL)
  THEN
    RAISE EXCEPTION 'Invalid category.';
  END IF;

  IF p_mode = 'flat'
     AND (
       SELECT count(*)
       FROM public.jmcwc_attempts
       WHERE student_id = p_student
         AND mode = 'flat'
         AND status <> 'submitted'
     ) >= 3
  THEN
    RAISE EXCEPTION 'You have three unfinished flat rounds. Complete one before starting another.';
  END IF;

  SELECT count(*) INTO expected
  FROM jsonb_array_elements(p.spec->'sections') s
  CROSS JOIN LATERAL
    jsonb_array_elements(s->'questions') item
  WHERE p_mode = 'flat'
     OR s->>'key' = p_category;

  IF expected = 0
     OR jsonb_typeof(p_questions) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Invalid generated paper.';
  END IF;

  IF jsonb_array_length(p_questions) <> expected
     OR octet_length(p_questions::text) > 5000000
  THEN
    RAISE EXCEPTION 'Paper size mismatch.';
  END IF;

  IF (
    SELECT count(DISTINCT x->>'id')
    FROM jsonb_array_elements(p_questions) x
  ) <> expected
  OR (
    SELECT count(DISTINCT (x->>'category_key',x->>'slot'))
    FROM jsonb_array_elements(p_questions) x
  ) <> expected
  THEN
    RAISE EXCEPTION 'Duplicate question IDs or slots.';
  END IF;

  FOR q IN
    SELECT * FROM jsonb_array_elements(p_questions)
  LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object'
       OR coalesce(q->>'id','') = ''
       OR length(q->>'id') > 100
       OR NOT(q ? 'answer_key')
       OR NOT(q ? 'prompt')
       OR NOT(q ? 'input')
       OR jsonb_typeof(q->'max_marks') IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION 'Invalid generated question.';
    END IF;

    SELECT item INTO blueprint_slot
    FROM jsonb_array_elements(p.spec->'sections') s
    CROSS JOIN LATERAL
      jsonb_array_elements(s->'questions') item
    WHERE s->>'key' = q->>'category_key'
      AND item->>'slot' = q->>'slot'
      AND (
        p_mode = 'flat'
        OR s->>'key' = p_category
      );

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Question does not match the published blueprint.';
    END IF;

    question_marks := (q->>'max_marks')::numeric;

    PERFORM public.jmcwc_validate_marks(
      q->>'category_key',
      blueprint_slot,
      question_marks
    );
  END LOOP;

  SELECT target_seconds INTO target
  FROM public.jmcwc_targets
  WHERE group_key = g
    AND category_key = p_category;

  INSERT INTO public.jmcwc_attempts(
    student_id,
    request_id,
    paper_id,
    group_key,
    mode,
    category_key,
    target_seconds
  )
  VALUES(
    p_student,
    p_request,
    p_paper,
    g,
    p_mode,
    p_category,
    CASE WHEN p_mode = 'category' THEN target END
  )
  RETURNING id INTO a;

  INSERT INTO public.jmcwc_payloads(
    attempt_id, questions
  )
  VALUES(a, p_questions);

  -- Atomic Session Linking in Same Transaction
  IF p_homework_id IS NOT NULL THEN
    PERFORM public.bind_homework_session(p_homework_id, a);
  END IF;

  RETURN a;
END;
$$;

REVOKE ALL ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb, uuid) TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- 6d. Backward-Compatible 6-Argument jmcwc_create_attempt (Upgrade-Safe)
-- Preserves existing callers/scripts; delegates with NULL homework_id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jmcwc_create_attempt(
  p_student uuid,
  p_request uuid,
  p_paper uuid,
  p_mode text,
  p_category text,
  p_questions jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.jmcwc_create_attempt(
    p_student,
    p_request,
    p_paper,
    p_mode,
    p_category,
    p_questions,
    NULL::uuid
  );
END;
$$;

REVOKE ALL ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jmcwc_create_attempt(uuid, uuid, uuid, text, text, jsonb) TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- 7. Authoritative RPC: public.submit_homework_completion
-- Restricted database operation that validates assignment, recipient, session,
-- settings, duration, required_count, and guarantees atomicity & replay protection.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_homework_completion(
  p_assignment_id UUID,
  p_session_id UUID DEFAULT NULL,
  p_result_id UUID DEFAULT NULL,
  p_activity_result_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_student_active BOOLEAN;
  v_assign RECORD;
  v_session RECORD;
  v_comp RECORD;
  v_curr_progress INTEGER := 0;
  v_new_progress INTEGER := 0;
  v_history JSONB := '[]'::jsonb;
  v_session_str TEXT;
  v_is_completed BOOLEAN := false;
  v_new_status VARCHAR(20) := 'in_progress';
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
  v_found_result BOOLEAN := false;
  v_jmcwc_row RECORD;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '28000';
  END IF;

  -- 1a. Fail closed: Caller must be an ACTIVE student
  SELECT active INTO v_student_active FROM public.profiles WHERE id = v_caller AND role = 'student';
  IF v_student_active IS NULL OR v_student_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Access denied: Student account is inactive or not found.' USING ERRCODE = '42501';
  END IF;

  -- 1b. Fetch assignment and verify existence
  SELECT * INTO v_assign FROM public.homework_assignments WHERE id = p_assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Homework assignment not found.' USING ERRCODE = 'P0002';
  END IF;

  -- 2. Verify caller eligibility
  IF NOT public.is_student_homework_recipient(p_assignment_id, v_caller) THEN
    RAISE EXCEPTION 'Access denied: Caller is not an authorized recipient of this homework assignment.'
      USING ERRCODE = '42501';
  END IF;

  -- 3. Atomic Concurrency Lock: serialize simultaneous calls for the same student and assignment
  PERFORM pg_advisory_xact_lock(hashtext(p_assignment_id::text), hashtext(v_caller::text));

  -- Fetch existing completion record with row lock
  SELECT * INTO v_comp FROM public.homework_completions
  WHERE assignment_id = p_assignment_id AND student_id = v_caller
  FOR UPDATE;

  IF FOUND THEN
    v_curr_progress := v_comp.progress_count;
    v_history := COALESCE(v_comp.submission_history, '[]'::jsonb);
    IF v_comp.status = 'completed' AND v_curr_progress >= v_assign.required_count THEN
      RETURN jsonb_build_object(
        'success', true,
        'already_completed', true,
        'status', 'completed',
        'progress_count', v_curr_progress,
        'required_count', v_assign.required_count
      );
    END IF;
  END IF;

  -- 4. Branch by Activity Type
  -- Branch 4A: Online Main Round competition attempts (jmcwc_attempts)
  IF v_assign.activity_type = 'round' THEN
    IF p_session_id IS NULL THEN
      RAISE EXCEPTION 'Main Round homework completion requires a valid attempt ID.'
        USING ERRCODE = '22023';
    END IF;

    v_session_str := p_session_id::text;

    -- Cross-assignment Replay Protection: Check if this attempt was already credited in another assignment
    IF EXISTS (
      SELECT 1 FROM public.homework_completions hc,
      LATERAL jsonb_array_elements(hc.submission_history) elem
      WHERE elem->>'session_id' = v_session_str
        AND hc.assignment_id != p_assignment_id
    ) OR EXISTS (
      SELECT 1 FROM public.homework_completions hc
      WHERE hc.session_id = p_session_id
        AND hc.assignment_id != p_assignment_id
    ) THEN
      RAISE EXCEPTION 'This attempt has already been credited to another homework assignment.'
        USING ERRCODE = '23505';
    END IF;

    -- Within-assignment Replay Protection: Check if this attempt_id was already credited
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_history) elem
      WHERE elem->>'session_id' = v_session_str
    ) THEN
      RAISE EXCEPTION 'This competition attempt has already been submitted for this homework.'
        USING ERRCODE = '23505';
    END IF;

    -- Verify jmcwc_attempts exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_attempts'
    ) THEN
      RAISE EXCEPTION 'Competition attempts table not found.' USING ERRCODE = 'P0002';
    END IF;

    -- Look up the exact attempt
    SELECT * INTO v_jmcwc_row FROM public.jmcwc_attempts WHERE id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Competition attempt not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_jmcwc_row.student_id != v_caller THEN
      RAISE EXCEPTION 'Competition attempt belongs to another student.' USING ERRCODE = '42501';
    END IF;

    -- Authoritative Session Binding: Attempt MUST be bound to this homework
    IF NOT EXISTS (
      SELECT 1 FROM public.homework_bound_sessions
      WHERE assignment_id = p_assignment_id
        AND session_id = p_session_id
        AND student_id = v_caller
    ) THEN
      RAISE EXCEPTION 'Competition attempt was not started for this homework assignment.'
        USING ERRCODE = '22023';
    END IF;

    IF v_jmcwc_row.status IS DISTINCT FROM 'submitted' THEN
      RAISE EXCEPTION 'Cannot credit an unsubmitted competition attempt.' USING ERRCODE = '22023';
    END IF;

    -- Attempt Date: Attempt must have been created on or after assigned_date
    IF v_jmcwc_row.created_at::date < v_assign.assigned_date THEN
      RAISE EXCEPTION 'Competition attempt was started before the homework assignment date.' USING ERRCODE = '22023';
    END IF;

    -- Settings validation: mode, category, group, duration
    IF (v_assign.settings->>'mode') IS NOT NULL AND v_jmcwc_row.mode IS DISTINCT FROM (v_assign.settings->>'mode') THEN
      RAISE EXCEPTION 'Competition attempt mode mismatch.' USING ERRCODE = '22023';
    END IF;

    IF (v_assign.settings->>'category_key') IS NOT NULL AND v_jmcwc_row.category_key IS DISTINCT FROM (v_assign.settings->>'category_key') THEN
      RAISE EXCEPTION 'Competition attempt category mismatch.' USING ERRCODE = '22023';
    END IF;

    IF (v_assign.settings->>'group_key') IS NOT NULL AND v_jmcwc_row.group_key IS DISTINCT FROM (v_assign.settings->>'group_key') THEN
      RAISE EXCEPTION 'Competition attempt group mismatch.' USING ERRCODE = '22023';
    END IF;

    IF v_assign.duration_seconds IS NOT NULL AND v_jmcwc_row.mode = 'category' THEN
      IF v_jmcwc_row.target_seconds IS NOT NULL AND v_jmcwc_row.target_seconds < v_assign.duration_seconds THEN
        RAISE EXCEPTION 'Competition attempt duration is less than assigned duration.' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Record in history
    v_history := v_history || jsonb_build_object(
      'session_id', v_session_str,
      'submitted_at', v_now
    );

    v_new_progress := v_curr_progress + 1;
    IF v_new_progress >= v_assign.required_count THEN
      v_is_completed := true;
      v_new_status := 'completed';
    ELSE
      v_is_completed := false;
      v_new_status := 'in_progress';
    END IF;

    INSERT INTO public.homework_completions (
      assignment_id,
      student_id,
      progress_count,
      status,
      session_id,
      submission_history,
      completed_at,
      updated_at
    )
    VALUES (
      p_assignment_id,
      v_caller,
      v_new_progress,
      v_new_status,
      p_session_id,
      v_history,
      CASE WHEN v_is_completed THEN v_now ELSE NULL END,
      v_now
    )
    ON CONFLICT (assignment_id, student_id) DO UPDATE SET
      progress_count = EXCLUDED.progress_count,
      status = EXCLUDED.status,
      session_id = EXCLUDED.session_id,
      submission_history = EXCLUDED.submission_history,
      completed_at = CASE WHEN EXCLUDED.status = 'completed' AND homework_completions.completed_at IS NULL THEN v_now ELSE homework_completions.completed_at END,
      updated_at = v_now;

  -- Branch 4B: Online graded practice drills (drill_sessions)
  ELSIF v_assign.activity_type IN ('basics', 'flash', 'element', 'memoriad') THEN
    IF p_session_id IS NULL THEN
      RAISE EXCEPTION 'Online homework completion requires a valid session_id.'
        USING ERRCODE = '22023';
    END IF;

    v_session_str := p_session_id::text;

    -- Cross-assignment Replay Protection: Check if this session was already credited in another assignment
    IF EXISTS (
      SELECT 1 FROM public.homework_completions hc,
      LATERAL jsonb_array_elements(hc.submission_history) elem
      WHERE elem->>'session_id' = v_session_str
        AND hc.assignment_id != p_assignment_id
    ) OR EXISTS (
      SELECT 1 FROM public.homework_completions hc
      WHERE hc.session_id = p_session_id
        AND hc.assignment_id != p_assignment_id
    ) THEN
      RAISE EXCEPTION 'This practice session has already been credited to another homework assignment.'
        USING ERRCODE = '23505';
    END IF;

    -- Replay Protection: Check if this session_id was already credited
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_history) elem
      WHERE elem->>'session_id' = v_session_str
    ) THEN
      RAISE EXCEPTION 'This practice session has already been submitted for this homework.'
        USING ERRCODE = '23505';
    END IF;

    -- Load session
    SELECT * INTO v_session FROM public.drill_sessions WHERE id = p_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Drill session not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_session.student_id != v_caller THEN
      RAISE EXCEPTION 'Session belongs to another student.' USING ERRCODE = '42501';
    END IF;

    IF v_session.status != 'submitted' THEN
      RAISE EXCEPTION 'Cannot credit an unsubmitted drill session.' USING ERRCODE = '22023';
    END IF;

    -- Session Assignment Date: Session must have started on or after assigned_date
    IF v_session.started_at::date < v_assign.assigned_date THEN
      RAISE EXCEPTION 'Session was started before the homework assignment date.' USING ERRCODE = '22023';
    END IF;

    -- Authoritative Session Binding: Session MUST be explicitly bound to this homework
    IF (v_session.settings->>'homework_id') IS DISTINCT FROM p_assignment_id::text THEN
      RAISE EXCEPTION 'Session is not bound to this homework assignment.' USING ERRCODE = '22023';
    END IF;

    -- Validate activity_type alignment
    IF v_assign.activity_type = 'flash' AND v_session.activity_type NOT IN ('flash', 'flash_anzan') THEN
      RAISE EXCEPTION 'Session activity type mismatch for Flash homework.' USING ERRCODE = '22023';
    ELSIF v_assign.activity_type != 'flash' AND v_session.activity_type != v_assign.activity_type THEN
      RAISE EXCEPTION 'Session activity type mismatch.' USING ERRCODE = '22023';
    END IF;

    -- Activity-specific Workload Validation & Saved Result Ownership
    IF v_assign.activity_type = 'basics' THEN
      IF v_assign.category_id IS NOT NULL THEN
        IF (v_session.settings->>'category_id')::UUID IS DISTINCT FROM v_assign.category_id THEN
          RAISE EXCEPTION 'Practice session category does not match assigned homework category.' USING ERRCODE = '22023';
        END IF;
      END IF;

      -- Validate duration
      IF v_assign.duration_seconds IS NOT NULL THEN
        DECLARE
          v_sess_dur INT := COALESCE(
            (v_session.settings->>'duration_seconds')::INT,
            (v_session.settings->>'time_limit_seconds')::INT,
            v_session.min_seconds::INT
          );
        BEGIN
          IF v_sess_dur IS NOT NULL AND v_sess_dur < v_assign.duration_seconds THEN
            RAISE EXCEPTION 'Drill session duration is less than assigned duration.' USING ERRCODE = '22023';
          END IF;
        END;
      END IF;

      -- Saved result must belong to this session
      IF v_session.result_id IS NULL AND v_session.result_row_id IS NULL THEN
        RAISE EXCEPTION 'No eligible saved practice result found for this session.' USING ERRCODE = '22023';
      END IF;

      IF p_result_id IS NOT NULL AND p_result_id IS DISTINCT FROM v_session.result_id AND p_result_id IS DISTINCT FROM v_session.result_row_id THEN
        RAISE EXCEPTION 'Result ID does not match the session result.' USING ERRCODE = '22023';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.results r
        WHERE (r.id = v_session.result_id OR r.id = v_session.result_row_id)
          AND r.student_id = v_caller
          AND (v_assign.category_id IS NULL OR r.category_id = v_assign.category_id)
      ) INTO v_found_result;

      IF NOT v_found_result THEN
        RAISE EXCEPTION 'No eligible saved practice result found for this session.' USING ERRCODE = '22023';
      END IF;

    ELSIF v_assign.activity_type = 'flash' THEN
      -- Validate digits, count, mode, and speed
      IF v_assign.settings->>'digits' IS NOT NULL AND (v_session.settings->>'digits')::INT IS DISTINCT FROM (v_assign.settings->>'digits')::INT THEN
        RAISE EXCEPTION 'Flash digits workload does not match assigned homework.' USING ERRCODE = '22023';
      END IF;
      IF v_assign.settings->>'count' IS NOT NULL AND (v_session.settings->>'count')::INT IS DISTINCT FROM (v_assign.settings->>'count')::INT THEN
        RAISE EXCEPTION 'Flash numbers count does not match assigned homework.' USING ERRCODE = '22023';
      END IF;
      IF v_assign.settings->>'mode' IS NOT NULL AND v_session.settings->>'mode' IS DISTINCT FROM v_assign.settings->>'mode' THEN
        RAISE EXCEPTION 'Flash operation mode does not match assigned homework.' USING ERRCODE = '22023';
      END IF;
      IF v_assign.settings->>'speed_ms' IS NOT NULL AND (v_session.settings->>'speed_ms')::INT IS DISTINCT FROM (v_assign.settings->>'speed_ms')::INT THEN
        RAISE EXCEPTION 'Flash speed does not match assigned homework.' USING ERRCODE = '22023';
      END IF;

      -- Saved result must belong to this session
      IF v_session.result_id IS NULL AND v_session.result_row_id IS NULL THEN
        RAISE EXCEPTION 'No eligible saved Flash result found for this session.' USING ERRCODE = '22023';
      END IF;

      IF p_activity_result_id IS NOT NULL AND p_activity_result_id IS DISTINCT FROM v_session.result_id AND p_activity_result_id IS DISTINCT FROM v_session.result_row_id THEN
        RAISE EXCEPTION 'Result ID does not match the session result.' USING ERRCODE = '22023';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.activity_results ar
        WHERE (ar.id = v_session.result_id OR ar.id = v_session.result_row_id)
          AND ar.student_id = v_caller
          AND ar.activity_type = 'flash_anzan'
      ) INTO v_found_result;

      IF NOT v_found_result THEN
        RAISE EXCEPTION 'No eligible saved Flash result found for this session.' USING ERRCODE = '22023';
      END IF;

    ELSIF v_assign.activity_type = 'element' THEN
      IF v_assign.settings->>'drill' IS NOT NULL AND v_session.settings->>'drill' IS DISTINCT FROM v_assign.settings->>'drill' THEN
        RAISE EXCEPTION 'Elements drill type does not match assigned homework.' USING ERRCODE = '22023';
      END IF;

      -- Saved result must belong to this session
      IF v_session.result_id IS NULL AND v_session.result_row_id IS NULL THEN
        RAISE EXCEPTION 'No eligible saved Elements result found for this session.' USING ERRCODE = '22023';
      END IF;

      IF p_activity_result_id IS NOT NULL AND p_activity_result_id IS DISTINCT FROM v_session.result_id AND p_activity_result_id IS DISTINCT FROM v_session.result_row_id THEN
        RAISE EXCEPTION 'Result ID does not match the session result.' USING ERRCODE = '22023';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.activity_results ar
        WHERE (ar.id = v_session.result_id OR ar.id = v_session.result_row_id)
          AND ar.student_id = v_caller
          AND ar.activity_type = 'element'
      ) INTO v_found_result;

      IF NOT v_found_result THEN
        RAISE EXCEPTION 'No eligible saved Elements result found for this session.' USING ERRCODE = '22023';
      END IF;

    ELSIF v_assign.activity_type = 'memoriad' THEN
      IF v_assign.settings->>'module' IS NOT NULL AND v_session.settings->>'module' IS DISTINCT FROM v_assign.settings->>'module' THEN
        RAISE EXCEPTION 'Memoriad module does not match assigned homework.' USING ERRCODE = '22023';
      END IF;
      IF (v_assign.settings->>'module') = 'calendar' AND (v_assign.settings->>'dates' IS NOT NULL OR v_assign.settings->>'date_count' IS NOT NULL) THEN
        DECLARE
          v_req_dates INT := COALESCE((v_assign.settings->>'dates')::INT, (v_assign.settings->>'date_count')::INT);
          v_sess_dates INT := COALESCE((v_session.settings->>'dates')::INT, (v_session.settings->>'date_count')::INT);
        BEGIN
          IF v_sess_dates IS DISTINCT FROM v_req_dates THEN
            RAISE EXCEPTION 'Memoriad calendar dates tier does not match assigned homework.' USING ERRCODE = '22023';
          END IF;
        END;
      END IF;

      -- Validate duration
      IF v_assign.duration_seconds IS NOT NULL THEN
        DECLARE
          v_mem_dur INT := COALESCE(
            (v_session.settings->>'duration_seconds')::INT,
            (v_session.settings->>'time_limit_seconds')::INT
          );
        BEGIN
          IF v_mem_dur IS NOT NULL AND v_mem_dur < v_assign.duration_seconds THEN
            RAISE EXCEPTION 'Memoriad session duration is less than assigned duration.' USING ERRCODE = '22023';
          END IF;
        END;
      END IF;

      -- Saved result must belong to this session
      IF v_session.result_id IS NULL AND v_session.result_row_id IS NULL THEN
        RAISE EXCEPTION 'No eligible saved Memoriad result found for this session.' USING ERRCODE = '22023';
      END IF;

      IF p_activity_result_id IS NOT NULL AND p_activity_result_id IS DISTINCT FROM v_session.result_id AND p_activity_result_id IS DISTINCT FROM v_session.result_row_id THEN
        RAISE EXCEPTION 'Result ID does not match the session result.' USING ERRCODE = '22023';
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM public.activity_results ar
        WHERE (ar.id = v_session.result_id OR ar.id = v_session.result_row_id)
          AND ar.student_id = v_caller
          AND ar.activity_type = 'memoriad'
      ) INTO v_found_result;

      IF NOT v_found_result THEN
        RAISE EXCEPTION 'No eligible saved Memoriad result found for this session.' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Record in history
    v_history := v_history || jsonb_build_object(
      'session_id', v_session_str,
      'submitted_at', v_now,
      'score', v_session.settings->'score'
    );

    v_new_progress := v_curr_progress + 1;
    IF v_new_progress >= v_assign.required_count THEN
      v_is_completed := true;
      v_new_status := 'completed';
    ELSE
      v_is_completed := false;
      v_new_status := 'in_progress';
    END IF;

    INSERT INTO public.homework_completions (
      assignment_id,
      student_id,
      progress_count,
      status,
      session_id,
      submission_history,
      completed_at,
      updated_at
    )
    VALUES (
      p_assignment_id,
      v_caller,
      v_new_progress,
      v_new_status,
      p_session_id,
      v_history,
      CASE WHEN v_is_completed THEN v_now ELSE NULL END,
      v_now
    )
    ON CONFLICT (assignment_id, student_id) DO UPDATE SET
      progress_count = EXCLUDED.progress_count,
      status = EXCLUDED.status,
      session_id = EXCLUDED.session_id,
      submission_history = EXCLUDED.submission_history,
      completed_at = CASE WHEN EXCLUDED.status = 'completed' AND homework_completions.completed_at IS NULL THEN v_now ELSE homework_completions.completed_at END,
      updated_at = v_now;

  -- Branch 4C: Offline / Paper homework
  ELSE
    v_new_progress := 0;
    v_new_status := 'pending_review';

    INSERT INTO public.homework_completions (
      assignment_id,
      student_id,
      progress_count,
      status,
      result_id,
      notes,
      updated_at
    )
    VALUES (
      p_assignment_id,
      v_caller,
      v_new_progress,
      v_new_status,
      p_result_id,
      p_notes,
      v_now
    )
    ON CONFLICT (assignment_id, student_id) DO UPDATE SET
      status = EXCLUDED.status,
      result_id = COALESCE(EXCLUDED.result_id, homework_completions.result_id),
      notes = COALESCE(EXCLUDED.notes, homework_completions.notes),
      updated_at = v_now;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_new_status,
    'progress_count', v_new_progress,
    'required_count', v_assign.required_count
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. Authoritative RPC: public.verify_homework_completion
-- Permitted teacher or admin verifies an offline homework completion.
-- Strictly rejects manual approval of online graded homework.
-- Respects required_count upon approval.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_homework_completion(
  p_completion_id UUID,
  p_decision VARCHAR(20) DEFAULT 'approve',
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
  v_caller_active BOOLEAN;
  v_comp RECORD;
  v_assign RECORD;
  v_now TIMESTAMPTZ := timezone('utc'::text, now());
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '28000';
  END IF;

  SELECT role, active INTO v_caller_role, v_caller_active FROM public.profiles WHERE id = v_caller;
  IF v_caller_role IS NULL OR v_caller_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Access denied: Caller account is inactive or not found.' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('admin', 'teacher') THEN
    RAISE EXCEPTION 'Access denied: Only admins and teachers can verify homework.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_comp FROM public.homework_completions WHERE id = p_completion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion record not found.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_assign FROM public.homework_assignments WHERE id = v_comp.assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Homework assignment not found.' USING ERRCODE = 'P0002';
  END IF;

  -- 1. Check teacher authorization, can_manage_tasks capability & active roster
  IF v_caller_role = 'teacher' THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.teacher_permissions
        WHERE teacher_id = v_caller AND can_manage_tasks = true
      ) THEN
        RAISE EXCEPTION 'Access denied: Teacher lacks task management permission.'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.teacher_student_assignments
      WHERE teacher_id = v_caller AND student_id = v_comp.student_id
    ) THEN
      RAISE EXCEPTION 'Access denied: You are not authorized to verify this student''s homework.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Reject manual verification for online graded practice: prevents bypasses
  IF v_assign.activity_type IN ('basics', 'flash', 'element', 'memoriad', 'round') THEN
    RAISE EXCEPTION 'Cannot manually verify online homework. Online drills must be completed through practice sessions.'
      USING ERRCODE = '22023';
  END IF;

  -- 3. Check status is legitimate pending offline evidence
  IF v_comp.status = 'completed' THEN
    RAISE EXCEPTION 'Homework is already completed.' USING ERRCODE = '22023';
  END IF;
  IF v_comp.status = 'in_progress' THEN
    RAISE EXCEPTION 'Homework has not been submitted for review.' USING ERRCODE = '22023';
  END IF;

  -- 4. Apply decision respecting required_count
  IF p_decision = 'approve' THEN
    UPDATE public.homework_completions
    SET
      status = 'completed',
      progress_count = GREATEST(v_comp.progress_count, v_assign.required_count),
      completed_at = COALESCE(completed_at, v_now),
      verified_by = v_caller,
      verified_at = v_now,
      notes = COALESCE(p_notes, notes),
      updated_at = v_now
    WHERE id = p_completion_id;
  ELSIF p_decision = 'reject' THEN
    UPDATE public.homework_completions
    SET
      status = 'in_progress',
      completed_at = NULL,
      verified_by = v_caller,
      verified_at = v_now,
      notes = COALESCE(p_notes, notes),
      updated_at = v_now
    WHERE id = p_completion_id;
  ELSE
    RAISE EXCEPTION 'Invalid verification decision: %. Expected "approve" or "reject".', p_decision
      USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'decision', p_decision,
    'status', CASE WHEN p_decision = 'approve' THEN 'completed' ELSE 'in_progress' END,
    'completion_id', p_completion_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. Authoritative RPC: public.flash_start
-- Authorizes and freezes homework settings (digits, count, speed_ms, mode)
-- when starting a Flash Anzan drill session for assigned homework.
-- -----------------------------------------------------------------------------
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
  v_homework_id uuid;
  v_hw public.homework_assignments;
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
    -- Safe procedural question generator fallback if flash_generate_question is not yet loaded
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

-- -----------------------------------------------------------------------------
-- 10. Authoritative RPC: public.admin_send_student_message
-- Supports typed score linking across results, activity_results, and jmcwc_attempts
-- with strict server ownership checks, deep link resolution, and flag semantics.
-- Preserves Migration 15 guarantees: fail closed on inactive/missing profiles,
-- strict nonce comparison with 23505 on reuse with differing payload,
-- advisory locks, unique-conflict retry handling, and real results schema.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_send_student_message(
  p_student_id UUID,
  p_title TEXT,
  p_body TEXT,
  p_needs_attention BOOLEAN DEFAULT false,
  p_attention_reason TEXT DEFAULT NULL,
  p_linked_type TEXT DEFAULT NULL,
  p_linked_id UUID DEFAULT NULL,
  p_client_nonce TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
  v_caller_active BOOLEAN;
  v_clean_title TEXT;
  v_clean_body TEXT;
  v_clean_reason TEXT;
  v_clean_linked_type TEXT;
  v_clean_link TEXT := '/pages/student.html';
  v_clean_nonce TEXT;
  v_student_level TEXT;
  v_student_active BOOLEAN;
  v_new_msg RECORD;
  v_existing_msg RECORD;
  v_result_row RECORD;
  v_cat_section TEXT;
  v_act_row RECORD;
  v_jmcwc_row RECORD;
  v_attempt_row RECORD;
  v_test_row RECORD;
  v_resolved_score BOOLEAN := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '28000';
  END IF;

  -- 1. Fail closed on missing or inactive profiles
  SELECT role, active INTO v_caller_role, v_caller_active FROM public.profiles WHERE id = v_caller;
  IF v_caller_role IS NULL OR v_caller_active IS NOT TRUE OR v_caller_role NOT IN ('admin', 'teacher') THEN
    RAISE EXCEPTION 'Access denied: Only active admins and teachers can send messages.' USING ERRCODE = '42501';
  END IF;

  SELECT level, active INTO v_student_level, v_student_active
  FROM public.profiles WHERE id = p_student_id AND role = 'student';
  IF NOT FOUND OR v_student_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Recipient student not found or inactive.' USING ERRCODE = 'P0002';
  END IF;

  -- 2. If caller is teacher, verify capability & roster assignment
  IF v_caller_role = 'teacher' THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'teacher_permissions'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.teacher_permissions
        WHERE teacher_id = v_caller AND can_manage_tasks = true
      ) THEN
        RAISE EXCEPTION 'Access denied: Teacher lacks task management permission.' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.teacher_student_assignments
      WHERE teacher_id = v_caller AND student_id = p_student_id
    ) THEN
      RAISE EXCEPTION 'Access denied: Student is not assigned to your roster.' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_clean_title := TRIM(COALESCE(p_title, ''));
  v_clean_body := TRIM(COALESCE(p_body, ''));
  v_clean_reason := NULLIF(TRIM(COALESCE(p_attention_reason, '')), '');
  v_clean_linked_type := NULLIF(TRIM(COALESCE(p_linked_type, '')), '');
  v_clean_nonce := NULLIF(TRIM(COALESCE(p_client_nonce, '')), '');

  IF char_length(v_clean_title) < 1 OR char_length(v_clean_title) > 120 THEN
    RAISE EXCEPTION 'Title must be between 1 and 120 characters.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_clean_body) < 1 OR char_length(v_clean_body) > 2000 THEN
    RAISE EXCEPTION 'Body must be between 1 and 2000 characters.' USING ERRCODE = '22023';
  END IF;

  -- 3. Idempotent check on client_nonce with transaction serialization & strict comparison
  IF v_clean_nonce IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_caller::text), hashtext(v_clean_nonce));

    SELECT * INTO v_existing_msg FROM public.student_messages
    WHERE sender_id = v_caller AND client_nonce = v_clean_nonce;

    IF FOUND THEN
      IF v_existing_msg.student_id <> p_student_id
         OR v_existing_msg.title <> v_clean_title
         OR v_existing_msg.body <> v_clean_body
         OR v_existing_msg.needs_attention <> COALESCE(p_needs_attention, false)
         OR v_existing_msg.attention_reason IS DISTINCT FROM v_clean_reason
         OR v_existing_msg.linked_type IS DISTINCT FROM v_clean_linked_type
         OR v_existing_msg.linked_id IS DISTINCT FROM p_linked_id THEN
        RAISE EXCEPTION 'Nonce reuse detected: client_nonce has already been used with different parameters'
          USING ERRCODE = '23505';
      END IF;

      RETURN to_jsonb(v_existing_msg) || jsonb_build_object(
        'success', true,
        'message_id', v_existing_msg.id,
        'link', v_existing_msg.link,
        'action_url', v_existing_msg.link
      );
    END IF;
  END IF;

  -- 4. Typed Reference Resolution
  IF v_clean_linked_type = 'score' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked score ID.' USING ERRCODE = '22023';
    END IF;

    -- 4a. Check public.results (Basics & Manual Round scores) using real installed contract
    -- results has student_round_id UUID (NO round_number column!)
    SELECT id, student_id, category_id, student_round_id, flagged, flag_note INTO v_result_row
    FROM public.results WHERE id = p_linked_id FOR UPDATE;

    IF FOUND THEN
      v_resolved_score := true;
      IF v_result_row.student_id <> p_student_id THEN
        RAISE EXCEPTION 'Linked score does not belong to the recipient student.' USING ERRCODE = '42501';
      END IF;

      SELECT section INTO v_cat_section FROM public.categories WHERE id = v_result_row.category_id;
      IF v_cat_section = 'round' THEN
        IF v_result_row.student_round_id IS NOT NULL THEN
          v_clean_link := '/pages/round-scores.html?roundId=' || v_result_row.student_round_id || '&resultId=' || p_linked_id;
        ELSE
          v_clean_link := '/pages/round-scores.html?resultId=' || p_linked_id;
        END IF;
      ELSE
        v_clean_link := '/pages/basics.html?resultId=' || p_linked_id;
      END IF;

      IF p_needs_attention = true THEN
        UPDATE public.results
        SET flagged = true, flag_note = COALESCE(v_clean_reason, v_clean_body)
        WHERE id = p_linked_id;

        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'result_audit') THEN
          INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
          VALUES (
            p_linked_id,
            p_student_id,
            v_caller,
            'flag',
            jsonb_build_object('flagged', v_result_row.flagged, 'flag_note', v_result_row.flag_note),
            jsonb_build_object('flagged', true, 'flag_note', COALESCE(v_clean_reason, v_clean_body)),
            COALESCE(v_clean_reason, 'Teacher flagged via private message')
          );
        END IF;
      END IF;
    END IF;

    -- 4b. Check public.activity_results (Elements, Flash Anzan, Memoriad)
    IF NOT v_resolved_score AND EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'activity_results'
    ) THEN
      SELECT id, student_id, activity_type, settings INTO v_act_row
      FROM public.activity_results WHERE id = p_linked_id;

      IF FOUND THEN
        v_resolved_score := true;
        IF v_act_row.student_id <> p_student_id THEN
          RAISE EXCEPTION 'Linked score does not belong to the recipient student.' USING ERRCODE = '42501';
        END IF;

        IF v_act_row.activity_type IN ('flash', 'flash_anzan') THEN
          v_clean_link := '/pages/flash.html?resultId=' || p_linked_id;
        ELSIF v_act_row.activity_type = 'element' THEN
          v_clean_link := '/pages/elements.html?resultId=' || p_linked_id;
        ELSIF v_act_row.activity_type = 'memoriad' THEN
          v_clean_link := '/pages/memoriad.html?resultId=' || p_linked_id;
        ELSE
          v_clean_link := '/pages/student.html';
        END IF;

        IF p_needs_attention = true THEN
          UPDATE public.activity_results
          SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
            'flagged', true,
            'flag_note', COALESCE(v_clean_reason, v_clean_body),
            'flagged_at', timezone('utc'::text, now()),
            'flagged_by', v_caller
          )
          WHERE id = p_linked_id;
        END IF;
      END IF;
    END IF;

    -- 4c. Check public.jmcwc_attempts (Online Main Round JMCWC simulator)
    IF NOT v_resolved_score AND EXISTS (
      SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'jmcwc_attempts'
    ) THEN
      SELECT id, student_id INTO v_jmcwc_row
      FROM public.jmcwc_attempts WHERE id = p_linked_id;

      IF FOUND THEN
        v_resolved_score := true;
        IF v_jmcwc_row.student_id <> p_student_id THEN
          RAISE EXCEPTION 'Linked score does not belong to the recipient student.' USING ERRCODE = '42501';
        END IF;
        v_clean_link := '/pages/round-scores.html?attemptId=' || p_linked_id;
      END IF;
    END IF;

    IF NOT v_resolved_score THEN
      RAISE EXCEPTION 'Linked score not found.' USING ERRCODE = 'P0002';
    END IF;

  ELSIF v_clean_linked_type = 'attempt' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked attempt ID.' USING ERRCODE = '22023';
    END IF;

    SELECT id, test_id, student_id INTO v_attempt_row
    FROM public.weekly_test_attempts WHERE id = p_linked_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked weekly test attempt not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_attempt_row.student_id <> p_student_id THEN
      RAISE EXCEPTION 'Linked attempt does not belong to the recipient student.' USING ERRCODE = '42501';
    END IF;

    v_clean_link := '/pages/weekly-test.html?testId=' || v_attempt_row.test_id || '&attemptId=' || p_linked_id;

  ELSIF v_clean_linked_type = 'weekly_test' THEN
    IF p_linked_id IS NULL THEN
      RAISE EXCEPTION 'Missing linked weekly test ID.' USING ERRCODE = '22023';
    END IF;

    SELECT id, audience_level INTO v_test_row
    FROM public.weekly_tests WHERE id = p_linked_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked weekly test not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_test_row.audience_level IS NOT NULL
       AND (v_student_level IS NULL OR LOWER(TRIM(v_test_row.audience_level)) <> LOWER(TRIM(v_student_level))) THEN
      RAISE EXCEPTION 'Weekly test is not assigned to recipient student level.' USING ERRCODE = '22023';
    END IF;

    v_clean_link := '/pages/weekly-test.html?testId=' || p_linked_id;

  ELSIF v_clean_linked_type IS NULL THEN
    v_clean_link := '/pages/student.html';
  ELSE
    RAISE EXCEPTION 'Invalid linked_type: %, must be score, weekly_test, or attempt.', p_linked_type
      USING ERRCODE = '22023';
  END IF;

  -- 5. Insert message record with concurrency retry & strict nonce validation
  BEGIN
    INSERT INTO public.student_messages (
      student_id,
      sender_id,
      title,
      body,
      needs_attention,
      attention_reason,
      linked_type,
      linked_id,
      link,
      client_nonce,
      created_at
    )
    VALUES (
      p_student_id,
      v_caller,
      v_clean_title,
      v_clean_body,
      COALESCE(p_needs_attention, false),
      v_clean_reason,
      v_clean_linked_type,
      p_linked_id,
      v_clean_link,
      v_clean_nonce,
      timezone('utc'::text, now())
    )
    RETURNING * INTO v_new_msg;
  EXCEPTION WHEN unique_violation THEN
    IF v_clean_nonce IS NOT NULL THEN
      SELECT * INTO v_existing_msg
      FROM public.student_messages
      WHERE sender_id = v_caller AND client_nonce = v_clean_nonce;

      IF FOUND THEN
        IF v_existing_msg.student_id <> p_student_id
           OR v_existing_msg.title <> v_clean_title
           OR v_existing_msg.body <> v_clean_body
           OR v_existing_msg.needs_attention <> COALESCE(p_needs_attention, false)
           OR v_existing_msg.attention_reason IS DISTINCT FROM v_clean_reason
           OR v_existing_msg.linked_type IS DISTINCT FROM v_clean_linked_type
           OR v_existing_msg.linked_id IS DISTINCT FROM p_linked_id THEN
          RAISE EXCEPTION 'Nonce reuse detected: client_nonce has already been used with different parameters'
            USING ERRCODE = '23505';
        END IF;

        RETURN to_jsonb(v_existing_msg) || jsonb_build_object(
          'success', true,
          'message_id', v_existing_msg.id,
          'link', v_existing_msg.link,
          'action_url', v_existing_msg.link
        );
      END IF;
    END IF;
    RAISE;
  END;

  RETURN to_jsonb(v_new_msg) || jsonb_build_object(
    'success', true,
    'message_id', v_new_msg.id,
    'link', v_clean_link,
    'action_url', v_clean_link
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 11. Explicit Function Permissions
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.is_student_homework_recipient(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_student_homework_recipient(UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_student_homework_recipient(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.flash_start(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.flash_start(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.flash_start(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.submit_homework_completion(UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_homework_completion(UUID, UUID, UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_homework_completion(UUID, UUID, UUID, UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.verify_homework_completion(UUID, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_homework_completion(UUID, VARCHAR, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.verify_homework_completion(UUID, VARCHAR, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_send_student_message(UUID, TEXT, TEXT, BOOLEAN, TEXT, TEXT, UUID, TEXT) TO authenticated, service_role;

COMMIT;
