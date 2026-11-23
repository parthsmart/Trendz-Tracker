-- ==============================================================================
-- TRENDZ TRACKER — WEBINAR.GG LIVE CLASSES FEATURE MIGRATION (STAGING)
-- File: supabase/staging_live_classes_feature.sql
--
-- Features:
-- 1. Table: public.live_classes
-- 2. Indexes for fast status, teacher, and schedule filtering
-- 3. Row Level Security (RLS) policies:
--    - Admins: full access (select, insert, update, delete)
--    - Teachers: view own classes and classes targeting their roster students; update own classes
--    - Students: view active classes targeting their level or explicit student ID
-- 4. RPC Functions:
--    - get_eligible_live_classes_for_student(p_student_id UUID)
-- 5. Staging Seed Data: Pilot webinar linking cmvl53hcc0bycs60yjljyys4z
-- ==============================================================================

-- 1. Table: public.live_classes
CREATE TABLE IF NOT EXISTS public.live_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  webinar_id TEXT NOT NULL,
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  host_email TEXT NULL,
  invited_teacher_ids JSONB NULL,
  target_level TEXT NULL,
  target_student_ids JSONB NULL,
  scheduled_start_time TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'waiting', 'live', 'ended', 'cancelled')),
  provider_status TEXT NULL,
  notes TEXT NULL,
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Existing-table upgrade for live_classes.host_email & invited_teacher_ids:
-- If the table already existed, ensure host_email and invited_teacher_ids exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'host_email'
  ) THEN
    ALTER TABLE public.live_classes ADD COLUMN host_email TEXT NULL;
  ELSE
    ALTER TABLE public.live_classes ALTER COLUMN host_email DROP NOT NULL;
    ALTER TABLE public.live_classes ALTER COLUMN host_email DROP DEFAULT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'live_classes' AND column_name = 'invited_teacher_ids'
  ) THEN
    ALTER TABLE public.live_classes ADD COLUMN invited_teacher_ids JSONB NULL;
  END IF;
END $$;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_live_classes_teacher ON public.live_classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_live_classes_scheduled_start ON public.live_classes(scheduled_start_time);
CREATE INDEX IF NOT EXISTS idx_live_classes_status ON public.live_classes(status);

-- 3. Enable RLS and Table Privileges
ALTER TABLE public.live_classes ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.live_classes TO authenticated;
GRANT ALL ON TABLE public.live_classes TO service_role;

-- 4. RLS Policies
DROP POLICY IF EXISTS "Admins have full access to live_classes" ON public.live_classes;
CREATE POLICY "Admins have full access to live_classes"
  ON public.live_classes
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.active = true
    )
  );

DROP POLICY IF EXISTS "Teachers can view assigned live_classes" ON public.live_classes;
CREATE POLICY "Teachers can view assigned live_classes"
  ON public.live_classes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'teacher' AND p.active = true
    )
    AND (
      teacher_id = auth.uid()
      OR (invited_teacher_ids IS NOT NULL AND invited_teacher_ids ? auth.uid()::text)
      OR EXISTS (
        SELECT 1 FROM public.teacher_student_assignments tsa
        WHERE tsa.teacher_id = auth.uid()
          AND (
            (target_student_ids IS NOT NULL AND target_student_ids ? tsa.student_id::text)
            OR (target_student_ids IS NULL AND (target_level IS NULL OR target_level = (SELECT level FROM public.profiles WHERE id = tsa.student_id)))
          )
      )
    )
  );

-- Teachers have SELECT-only access to assigned and invited live classes.
-- Row updates are strictly restricted to administrators.
DROP POLICY IF EXISTS "Teachers can update own live_classes" ON public.live_classes;

-- Database Boundary Trigger: Enforce Admin-only modifications on live classes
-- Strictly blocks non-admin callers from modifying invited_teacher_ids, host_email,
-- webinar_id, target_level, target_student_ids, teacher_id, and created_by.
CREATE OR REPLACE FUNCTION public.enforce_live_class_admin_only_fields()
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
  v_is_admin BOOLEAN := FALSE;
BEGIN
  -- Service role explicitly without a user context is permitted
  IF v_is_service_role AND v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Direct superuser migrations or scripts without user context are permitted
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check if caller is an active admin
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_caller AND role = 'admin' AND active = true
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'Access denied: Only administrators can create live classes.'
        USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF NEW.invited_teacher_ids IS DISTINCT FROM OLD.invited_teacher_ids THEN
        RAISE EXCEPTION 'Access denied: Only administrators can modify invited_teacher_ids.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.host_email IS DISTINCT FROM OLD.host_email THEN
        RAISE EXCEPTION 'Access denied: Only administrators can modify host identity (host_email).'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.webinar_id IS DISTINCT FROM OLD.webinar_id THEN
        RAISE EXCEPTION 'Access denied: Only administrators can modify webinar ID.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.target_level IS DISTINCT FROM OLD.target_level OR NEW.target_student_ids IS DISTINCT FROM OLD.target_student_ids THEN
        RAISE EXCEPTION 'Access denied: Only administrators can modify audience configuration (target_level, target_student_ids).'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id THEN
        RAISE EXCEPTION 'Access denied: Only administrators can modify assigned teacher_id.'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
        RAISE EXCEPTION 'Access denied: created_by is immutable.'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_live_classes_admin_only_fields ON public.live_classes;
CREATE TRIGGER trg_live_classes_admin_only_fields
  BEFORE INSERT OR UPDATE ON public.live_classes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_live_class_admin_only_fields();

DROP POLICY IF EXISTS "Students can view eligible live_classes" ON public.live_classes;
CREATE POLICY "Students can view eligible live_classes"
  ON public.live_classes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'student' AND p.active = true
    )
    AND (
      (target_student_ids IS NOT NULL AND target_student_ids ? auth.uid()::text)
      OR (
        target_student_ids IS NULL
        AND (
          target_level IS NULL
          OR target_level = (SELECT level FROM public.profiles WHERE id = auth.uid())
        )
      )
    )
  );

-- 5. Helper Function: get_eligible_live_classes_for_student
CREATE OR REPLACE FUNCTION public.get_eligible_live_classes_for_student(p_student_id UUID)
RETURNS TABLE (
  id UUID,
  title TEXT,
  teacher_id UUID,
  teacher_name TEXT,
  scheduled_start_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  status TEXT,
  provider_status TEXT,
  target_level TEXT
)
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
$$;

-- Revoke execution from PUBLIC and anon, grant exclusively to authenticated and service_role
REVOKE EXECUTE ON FUNCTION public.get_eligible_live_classes_for_student(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_eligible_live_classes_for_student(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_eligible_live_classes_for_student(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_eligible_live_classes_for_student(UUID) TO service_role;
