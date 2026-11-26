-- Trendz Tracker — Simple practice page and Flash Anzan mode access
--
-- Apply after staging_flash_simple_mode.sql. Safe to run more than once.
--
-- 1. public.simple_practice_results stores Simple scores: no-formula sums
--    (1D 4R, 2D 2R, 3D 2R), tables dodging (2 to 9) and mixed tables
--    (2-5, 2-9), practised online or logged from paper (offline).
--    Students write only through simple_practice_log / simple_practice_delete.
--    These scores are kept apart from `results`, so Basics stats, targets,
--    leaderboards and streaks do not change.
-- 2. Practice access key settings.simple_practice = { allowed, activities }.
--    A missing key means full access (same as the client, js/simplePractice.js).
-- 3. settings.flash.modes (['add', 'add_sub', 'simple']) limits the Flash Anzan
--    modes in free practice. flash_start is patched in place to check it; a
--    missing list means every mode. Daily tasks, homework and weekly tests keep
--    the mode the teacher set.

BEGIN;

-- 1. Table --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.simple_practice_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  activity_key text NOT NULL,
  source text NOT NULL,
  correct integer NOT NULL,
  total integer NOT NULL,
  time_seconds integer,
  practiced_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Kolkata')::date),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT simple_practice_activity_check CHECK (activity_key = ANY (ARRAY[
    'simple_1d4r', 'simple_2d2r', 'simple_3d2r',
    'table_2', 'table_3', 'table_4', 'table_5', 'table_6', 'table_7', 'table_8', 'table_9',
    'mix_2_5', 'mix_2_9'
  ])),
  CONSTRAINT simple_practice_source_check CHECK (source = ANY (ARRAY['online', 'offline'])),
  CONSTRAINT simple_practice_numbers_check CHECK (
    total >= 1 AND total <= 1000 AND correct >= 0 AND correct <= total
    AND (time_seconds IS NULL OR (time_seconds >= 0 AND time_seconds <= 14400))
  )
);

CREATE INDEX IF NOT EXISTS simple_practice_results_student_idx
  ON public.simple_practice_results (student_id, created_at DESC);

ALTER TABLE public.simple_practice_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS simple_practice_results_select ON public.simple_practice_results;
CREATE POLICY simple_practice_results_select ON public.simple_practice_results
  FOR SELECT TO authenticated
  USING (
    student_id = auth.uid()
    OR public.is_admin()
    OR (public.is_teacher(auth.uid()) AND public.is_teacher_assigned_to_student(auth.uid(), student_id))
  );

REVOKE ALL ON public.simple_practice_results FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.simple_practice_results FROM authenticated;
GRANT SELECT ON public.simple_practice_results TO authenticated;

-- 2. Save a score ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.simple_practice_log(
  p_activity_key text,
  p_source text,
  p_correct integer,
  p_total integer,
  p_time_seconds integer DEFAULT NULL,
  p_practiced_on date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile RECORD;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_day date := COALESCE(p_practiced_on, (now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_key text := lower(trim(COALESCE(p_activity_key, '')));
  v_access jsonb;
  v_rule jsonb;
  v_row public.simple_practice_results;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_uid;
  IF NOT FOUND OR NOT v_profile.active OR v_profile.role <> 'student' THEN
    RAISE EXCEPTION 'Only active students can save Simple scores.' USING ERRCODE = '42501';
  END IF;

  IF p_source IS NULL OR p_source NOT IN ('online', 'offline') THEN
    RAISE EXCEPTION 'Unknown entry type.';
  END IF;
  IF v_key NOT IN (
    'simple_1d4r', 'simple_2d2r', 'simple_3d2r',
    'table_2', 'table_3', 'table_4', 'table_5', 'table_6', 'table_7', 'table_8', 'table_9',
    'mix_2_5', 'mix_2_9'
  ) THEN
    RAISE EXCEPTION 'Unknown Simple activity.';
  END IF;
  IF p_total IS NULL OR p_total < 1 OR p_total > 1000 THEN
    RAISE EXCEPTION 'Questions must be a whole number from 1 to 1000.';
  END IF;
  IF p_correct IS NULL OR p_correct < 0 OR p_correct > p_total THEN
    RAISE EXCEPTION 'Correct must be between 0 and the number of questions.';
  END IF;
  IF p_time_seconds IS NOT NULL AND (p_time_seconds < 0 OR p_time_seconds > 14400) THEN
    RAISE EXCEPTION 'Time must be between 0 seconds and 4 hours.';
  END IF;
  IF v_day > v_today THEN
    RAISE EXCEPTION 'The date cannot be in the future.';
  END IF;
  IF v_day < v_today - 7 THEN
    RAISE EXCEPTION 'You can log practice from the last 7 days only.';
  END IF;

  IF (SELECT count(*) FROM public.simple_practice_results
       WHERE student_id = v_uid AND created_at > now() - interval '1 hour') >= 120 THEN
    RAISE EXCEPTION 'Too many scores saved. Please wait a little.';
  END IF;

  -- Practice access: a missing simple_practice key means full access.
  v_access := public.get_student_effective_access(v_uid);
  IF v_access IS NULL OR (v_access ->> 'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Practice access lookup failed. Please try again.' USING ERRCODE = '53000';
  END IF;
  v_rule := v_access -> 'settings' -> 'simple_practice';
  IF v_rule IS NOT NULL AND jsonb_typeof(v_rule) = 'object' THEN
    IF v_rule ->> 'allowed' = 'false' THEN
      RAISE EXCEPTION 'Simple practice is not turned on for you.' USING ERRCODE = '42501';
    END IF;
    IF jsonb_typeof(v_rule -> 'activities') = 'array' AND NOT ((v_rule -> 'activities') ? v_key) THEN
      RAISE EXCEPTION 'This activity is not turned on for you.' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.simple_practice_results
    (student_id, activity_key, source, correct, total, time_seconds, practiced_on)
  VALUES
    (v_uid, v_key, p_source, p_correct, p_total, p_time_seconds, v_day)
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.simple_practice_log(text, text, integer, integer, integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.simple_practice_log(text, text, integer, integer, integer, date) TO authenticated;

-- Students may delete their own offline logs from the last 7 days.
CREATE OR REPLACE FUNCTION public.simple_practice_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.simple_practice_results
   WHERE id = p_id
     AND student_id = auth.uid()
     AND source = 'offline'
     AND practiced_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 7;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only your own offline scores from the last 7 days can be deleted.';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.simple_practice_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.simple_practice_delete(uuid) TO authenticated;

-- 3. Flash Anzan: check the allowed modes in free practice -----------------------------

DO $patch$
DECLARE
  v_old text := pg_get_functiondef('public.flash_start(jsonb)'::regprocedure);
  v_new text;
  v_anchor text := $q$'Flash Anzan practice is not permitted for your current access level.'
        USING ERRCODE = '42501';
    END IF;$q$;
  v_check text := $q$
    IF jsonb_typeof(v_access -> 'settings' -> 'flash' -> 'modes') = 'array'
       AND NOT ((v_access -> 'settings' -> 'flash' -> 'modes') ? lower(trim(v_mode))) THEN
      RAISE EXCEPTION 'This Flash Anzan mode is not turned on for you.'
        USING ERRCODE = '42501';
    END IF;$q$;
BEGIN
  IF position($q$'This Flash Anzan mode is not turned on for you.'$q$ IN v_old) > 0 THEN
    RAISE NOTICE 'flash_start already checks the allowed modes';
    RETURN;
  END IF;
  IF position(v_anchor IN v_old) = 0 THEN
    RAISE EXCEPTION 'Could not add the mode check to flash_start (its access check was not found)';
  END IF;
  v_new := replace(v_old, v_anchor, v_anchor || v_check);
  EXECUTE v_new;
  RAISE NOTICE 'Patched flash_start';
END
$patch$;

COMMIT;
