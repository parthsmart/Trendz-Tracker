-- ==============================================================================
-- 04_phase3_streak_todo_and_resources.sql
-- Phase 3: Learning Resources Table, streak_for(p_student), and todo_for(p_student)
-- Run Order: 4 of 12
-- ==============================================================================

-- 1. Table: resources
CREATE TABLE IF NOT EXISTS public.resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  url TEXT NOT NULL CHECK (url ~* '^https?://'),
  description TEXT NULL,
  topic TEXT NOT NULL DEFAULT 'General',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "resources_read_policy" ON public.resources;
DROP POLICY IF EXISTS "resources_admin_write_policy" ON public.resources;

CREATE POLICY "resources_read_policy"
ON public.resources FOR SELECT TO authenticated
USING (active = true OR public.is_admin());

CREATE POLICY "resources_admin_write_policy"
ON public.resources FOR ALL TO authenticated
USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2. RPC: streak_for(p_student UUID)
CREATE OR REPLACE FUNCTION public.streak_for(p_student UUID DEFAULT NULL)
RETURNS TABLE (
  current_streak INTEGER,
  best_streak INTEGER,
  shields INTEGER,
  active_today BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_today DATE := public.today_ist();
  v_active_today BOOLEAN := false;
  v_cur INTEGER := 0;
  v_best INTEGER := 0;
  v_run INTEGER := 0;
  v_prev DATE := NULL;
  rec RECORD;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own streak.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.results
    WHERE student_id = v_target AND entry_date = v_today
  ) INTO v_active_today;

  -- Compute best_streak across distinct practice dates
  FOR rec IN
    SELECT DISTINCT entry_date
    FROM public.results
    WHERE student_id = v_target
    ORDER BY entry_date ASC
  LOOP
    IF v_prev IS NULL OR rec.entry_date = v_prev + 1 THEN
      v_run := v_run + 1;
    ELSE
      v_run := 1;
    END IF;
    IF v_run > v_best THEN
      v_best := v_run;
    END IF;
    v_prev := rec.entry_date;
  END LOOP;

  -- Compute current_streak backward from today (or yesterday if not yet entered today)
  v_prev := CASE WHEN v_active_today THEN v_today ELSE (v_today - 1) END;
  FOR rec IN
    SELECT DISTINCT entry_date
    FROM public.results
    WHERE student_id = v_target AND entry_date <= v_prev
    ORDER BY entry_date DESC
  LOOP
    IF rec.entry_date = v_prev THEN
      v_cur := v_cur + 1;
      v_prev := v_prev - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_cur, GREATEST(v_best, v_cur), 0, v_active_today;
END;
$$;

-- 3. RPC: todo_for(p_student UUID)
CREATE OR REPLACE FUNCTION public.todo_for(p_student UUID DEFAULT NULL)
RETURNS TABLE (
  task_id UUID,
  task_title TEXT,
  task_section TEXT,
  task_category_id UUID,
  done BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_today DATE := public.today_ist();
  v_level TEXT;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: You may only view your own daily tasks.';
  END IF;

  SELECT level INTO v_level FROM public.profiles WHERE id = v_target;

  RETURN QUERY
  SELECT
    dt.id AS task_id,
    dt.title AS task_title,
    dt.section AS task_section,
    dt.category_id AS task_category_id,
    CASE
      WHEN dt.category_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM public.results r
        WHERE r.student_id = v_target
          AND r.entry_date = v_today
          AND r.category_id = dt.category_id
      )
      ELSE EXISTS (
        SELECT 1 FROM public.results r
        JOIN public.categories c ON c.id = r.category_id
        WHERE r.student_id = v_target
          AND r.entry_date = v_today
          AND c.section = dt.section
      )
    END AS done
  FROM public.daily_tasks dt
  WHERE dt.active = true
    AND (dt.level IS NULL OR LOWER(TRIM(dt.level)) = LOWER(TRIM(COALESCE(v_level, ''))))
  ORDER BY dt.section ASC, dt.sort_order ASC, dt.created_at ASC;
END;
$$;
