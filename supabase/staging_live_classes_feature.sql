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
  host_email TEXT NOT NULL DEFAULT 'suniltrendzeducation@gmail.com',
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

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_live_classes_teacher ON public.live_classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_live_classes_scheduled_start ON public.live_classes(scheduled_start_time);
CREATE INDEX IF NOT EXISTS idx_live_classes_status ON public.live_classes(status);

-- 3. Enable RLS
ALTER TABLE public.live_classes ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS "Teachers can update own live_classes" ON public.live_classes;
CREATE POLICY "Teachers can update own live_classes"
  ON public.live_classes
  FOR UPDATE
  TO authenticated
  USING (
    teacher_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'teacher' AND p.active = true
    )
  )
  WITH CHECK (
    teacher_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'teacher' AND p.active = true
    )
  );

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
  v_student_level TEXT;
  v_is_active BOOLEAN;
BEGIN
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

GRANT EXECUTE ON FUNCTION public.get_eligible_live_classes_for_student(UUID) TO authenticated;
