-- ==============================================================================
-- 06_phase4a_review_audit_and_attendance.sql
-- Phase 4a: Teacher Entry Review, Immutable Audit Log & Attendance Tracking
-- Run Order: 6 of 12
-- ==============================================================================

-- 1. Add review & correction columns to results
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_note TEXT NULL,
  ADD COLUMN IF NOT EXISTS verified_by UUID NULL REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS corrected_by UUID NULL REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_results_verified_at ON public.results(verified_at);
CREATE INDEX IF NOT EXISTS idx_results_flagged ON public.results(flagged);

-- 2. Table: result_audit
CREATE TABLE IF NOT EXISTS public.result_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL REFERENCES public.profiles(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  action TEXT NOT NULL CHECK (action IN ('verify', 'unverify', 'flag', 'unflag', 'correct', 'delete', 'admin_insert')),
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason TEXT NOT NULL
);

ALTER TABLE public.result_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "result_audit_admin_read" ON public.result_audit;
CREATE POLICY "result_audit_admin_read"
ON public.result_audit FOR SELECT TO authenticated
USING (public.is_admin());

-- 3. Lock verified/corrected rows from student edits or deletes
CREATE OR REPLACE FUNCTION public.enforce_result_locks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.verified = true OR OLD.verified_at IS NOT NULL OR OLD.corrected_at IS NOT NULL THEN
        RAISE EXCEPTION 'Locked entry: Verified or teacher-corrected scores cannot be deleted.';
      END IF;
      RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF OLD.verified = true OR OLD.verified_at IS NOT NULL OR OLD.corrected_at IS NOT NULL THEN
        RAISE EXCEPTION 'Locked entry: Verified or teacher-corrected scores cannot be edited.';
      END IF;
      -- Prevent students from mutating teacher metadata
      NEW.verified := OLD.verified;
      NEW.verified_by := OLD.verified_by;
      NEW.verified_at := OLD.verified_at;
      NEW.corrected_by := OLD.corrected_by;
      NEW.corrected_at := OLD.corrected_at;
      NEW.flagged := OLD.flagged;
      NEW.flag_note := OLD.flag_note;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_result_locks ON public.results;
CREATE TRIGGER trg_enforce_result_locks
  BEFORE UPDATE OR DELETE ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.enforce_result_locks();

-- 4. Admin Review RPCs
CREATE OR REPLACE FUNCTION public.admin_set_verified(
  p_ids UUID[],
  p_verified BOOLEAN,
  p_reason TEXT DEFAULT 'Teacher review'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_row public.results%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  IF array_length(p_ids, 1) IS NULL OR array_length(p_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Provide between 1 and 200 result IDs.';
  END IF;

  FOREACH v_id IN ARRAY p_ids LOOP
    SELECT * INTO v_row FROM public.results WHERE id = v_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.results
      SET
        verified = p_verified,
        verified_by = CASE WHEN p_verified THEN auth.uid() ELSE NULL END,
        verified_at = CASE WHEN p_verified THEN now() ELSE NULL END
      WHERE id = v_id;

      INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
      VALUES (
        v_id,
        v_row.student_id,
        auth.uid(),
        CASE WHEN p_verified THEN 'verify' ELSE 'unverify' END,
        jsonb_build_object('verified', v_row.verified),
        jsonb_build_object('verified', p_verified),
        COALESCE(NULLIF(TRIM(p_reason), ''), 'Teacher verification')
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_flag(
  p_id UUID,
  p_flagged BOOLEAN,
  p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.results%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  SELECT * INTO v_row FROM public.results WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Result entry not found.';
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
    auth.uid(),
    CASE WHEN p_flagged THEN 'flag' ELSE 'unflag' END,
    jsonb_build_object('flagged', v_row.flagged, 'flag_note', v_row.flag_note),
    jsonb_build_object('flagged', p_flagged, 'flag_note', CASE WHEN p_flagged THEN NULLIF(TRIM(p_note), '') ELSE NULL END),
    COALESCE(NULLIF(TRIM(p_note), ''), CASE WHEN p_flagged THEN 'Flagged for student check' ELSE 'Flag cleared' END)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_correct_result(
  p_id UUID,
  p_correct INTEGER,
  p_total INTEGER,
  p_time_seconds INTEGER,
  p_note TEXT,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.results%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  IF p_reason IS NULL OR LENGTH(TRIM(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A correction reason of at least 3 characters is required.';
  END IF;

  IF p_correct IS NOT NULL AND p_total IS NOT NULL AND p_correct > p_total THEN
    RAISE EXCEPTION 'Correct answers cannot exceed total questions.';
  END IF;

  SELECT * INTO v_row FROM public.results WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Result entry not found.';
  END IF;

  UPDATE public.results
  SET
    correct = p_correct,
    total = p_total,
    time_seconds = p_time_seconds,
    note = p_note,
    corrected_by = auth.uid(),
    corrected_at = now(),
    verified = true,
    verified_by = COALESCE(v_row.verified_by, auth.uid()),
    verified_at = COALESCE(v_row.verified_at, now()),
    flagged = false,
    flag_note = NULL
  WHERE id = p_id;

  INSERT INTO public.result_audit (result_id, student_id, changed_by, action, old_values, new_values, reason)
  VALUES (
    p_id,
    v_row.student_id,
    auth.uid(),
    'correct',
    jsonb_build_object('correct', v_row.correct, 'total', v_row.total, 'time_seconds', v_row.time_seconds, 'note', v_row.note),
    jsonb_build_object('correct', p_correct, 'total', p_total, 'time_seconds', p_time_seconds, 'note', p_note),
    TRIM(p_reason)
  );
END;
$$;

-- 5. Tables: attendance_sessions (and sessions alias view/table) & attendance
CREATE TABLE IF NOT EXISTS public.attendance_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date DATE NOT NULL DEFAULT public.today_ist(),
  title TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type IN ('workshop', 'class', 'other')) DEFAULT 'class',
  notes TEXT NULL,
  created_by UUID NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'excused')),
  note TEXT NULL,
  marked_by UUID NULL REFERENCES public.profiles(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_attendance_session_student UNIQUE (session_id, student_id)
);

ALTER TABLE public.attendance_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "attendance_sessions_read" ON public.attendance_sessions;
DROP POLICY IF EXISTS "attendance_sessions_admin_write" ON public.attendance_sessions;
DROP POLICY IF EXISTS "attendance_read" ON public.attendance;
DROP POLICY IF EXISTS "attendance_admin_write" ON public.attendance;

CREATE POLICY "attendance_sessions_read"
ON public.attendance_sessions FOR SELECT TO authenticated USING (true);

CREATE POLICY "attendance_sessions_admin_write"
ON public.attendance_sessions FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "attendance_read"
ON public.attendance FOR SELECT TO authenticated
USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "attendance_admin_write"
ON public.attendance FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 6. RPC: attendance_summary(p_student, p_from, p_to)
-- Excused sessions are strictly excluded from the percentage denominator.
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
  IF v_target IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own attendance summary.';
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
      WHEN COALESCE(v_present, 0) + COALESCE(v_absent, 0) = 0 THEN NULL
      ELSE ROUND((v_present::numeric / (v_present + v_absent)::numeric) * 100.0, 1)
    END;
END;
$$;
