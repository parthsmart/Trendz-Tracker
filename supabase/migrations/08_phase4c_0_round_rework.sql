-- ==============================================================================
-- 08_phase4c_0_round_rework.sql
-- Phase 4c-0: Per-Student Rounds (round_series, category_series, student_rounds,
-- results.student_round_id, and start_round RPC)
-- Run Order: 8 of 12
-- ==============================================================================

-- 1. Table: round_series
CREATE TABLE IF NOT EXISTS public.round_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Seed Old simulator and New simulator (current)
INSERT INTO public.round_series (name, sort_order, is_current)
VALUES
  ('Old simulator', 1, false),
  ('New simulator', 2, true)
ON CONFLICT (name) DO NOTHING;

-- 2. Table: category_series
CREATE TABLE IF NOT EXISTS public.category_series (
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  series_id UUID NOT NULL REFERENCES public.round_series(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, series_id)
);

-- Link existing round categories to New simulator if not yet linked
INSERT INTO public.category_series (category_id, series_id, sort_order)
SELECT c.id, rs.id, c.sort_order
FROM public.categories c
CROSS JOIN public.round_series rs
WHERE c.section = 'round' AND rs.name = 'New simulator'
ON CONFLICT DO NOTHING;

-- 3. Table: student_rounds
CREATE TABLE IF NOT EXISTS public.student_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  series_id UUID NOT NULL REFERENCES public.round_series(id) ON DELETE RESTRICT,
  round_number INTEGER NOT NULL CHECK (round_number >= 1 AND round_number <= 100000),
  round_date DATE NOT NULL DEFAULT public.today_ist(),
  round_type TEXT NOT NULL DEFAULT 'Category wise',
  time_taken_seconds INTEGER NULL CHECK (time_taken_seconds IS NULL OR (time_taken_seconds >= 0 AND time_taken_seconds <= 28800)),
  import_batch_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_student_rounds_student_series_num UNIQUE (student_id, series_id, round_number)
);

-- 4. Add student_round_id to results
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS student_round_id UUID NULL REFERENCES public.student_rounds(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique_student_round_cat
  ON public.results (student_round_id, category_id)
  WHERE student_round_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_results_student_round_id
  ON public.results (student_round_id);

-- Refresh results_with_target view to include student_round_id
CREATE OR REPLACE VIEW public.results_with_target AS
WITH effective_targets AS (
  SELECT
    r.id AS result_id,
    COALESCE(lvl_t.min_accuracy, def_t.min_accuracy) AS min_accuracy,
    COALESCE(lvl_t.max_time_seconds, def_t.max_time_seconds) AS max_time_seconds
  FROM public.results r
  JOIN public.profiles p ON p.id = r.student_id
  LEFT JOIN public.basics_thresholds lvl_t
    ON lvl_t.category_id = r.category_id
    AND lvl_t.active = true
    AND lvl_t.level IS NOT NULL
    AND LOWER(TRIM(lvl_t.level)) = LOWER(TRIM(COALESCE(p.level, '')))
  LEFT JOIN public.basics_thresholds def_t
    ON def_t.category_id = r.category_id
    AND def_t.active = true
    AND def_t.level IS NULL
)
SELECT
  r.*,
  t.min_accuracy,
  t.max_time_seconds,
  CASE
    WHEN t.min_accuracy IS NULL AND t.max_time_seconds IS NULL THEN NULL
    WHEN t.max_time_seconds IS NOT NULL AND (r.time_seconds IS NULL OR r.time_seconds > t.max_time_seconds) THEN false
    WHEN r.total IS NULL OR r.total <= 0 THEN false
    WHEN ((r.correct::numeric / r.total::numeric) * 100.0) < COALESCE(t.min_accuracy, 0) THEN false
    ELSE true
  END AS meets_target
FROM public.results r
LEFT JOIN effective_targets t ON t.result_id = r.id;

-- Enable RLS on round_series, category_series, student_rounds
ALTER TABLE public.round_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_rounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "round_series_read" ON public.round_series;
DROP POLICY IF EXISTS "round_series_admin_write" ON public.round_series;
DROP POLICY IF EXISTS "category_series_read" ON public.category_series;
DROP POLICY IF EXISTS "category_series_admin_write" ON public.category_series;
DROP POLICY IF EXISTS "student_rounds_read" ON public.student_rounds;
DROP POLICY IF EXISTS "student_rounds_student_update" ON public.student_rounds;
DROP POLICY IF EXISTS "student_rounds_admin_write" ON public.student_rounds;

CREATE POLICY "round_series_read" ON public.round_series
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "round_series_admin_write" ON public.round_series
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "category_series_read" ON public.category_series
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "category_series_admin_write" ON public.category_series
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "student_rounds_read" ON public.student_rounds
  FOR SELECT TO authenticated USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "student_rounds_student_update" ON public.student_rounds
  FOR UPDATE TO authenticated
  USING (student_id = auth.uid() AND round_date >= (public.today_ist() - INTERVAL '7 days')::date)
  WITH CHECK (student_id = auth.uid() AND round_date >= (public.today_ist() - INTERVAL '7 days')::date);

CREATE POLICY "student_rounds_admin_write" ON public.student_rounds
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 5. RPC: start_round(p_student, p_round_type)
-- Reuses today's empty round in the current series if one exists; otherwise creates max(round_number) + 1.
CREATE OR REPLACE FUNCTION public.start_round(
  p_student UUID DEFAULT NULL,
  p_round_type TEXT DEFAULT 'Category wise'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target UUID := COALESCE(p_student, auth.uid());
  v_series_id UUID;
  v_existing_id UUID;
  v_next_num INTEGER;
  v_new_id UUID;
BEGIN
  IF v_target IS DISTINCT FROM auth.uid() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: You may only start rounds for yourself.';
  END IF;

  SELECT id INTO v_series_id
  FROM public.round_series
  WHERE is_current = true
  ORDER BY sort_order DESC
  LIMIT 1;

  IF v_series_id IS NULL THEN
    RAISE EXCEPTION 'No current round simulator series is configured.';
  END IF;

  -- Reuse an existing empty round from today in the current series if present
  SELECT sr.id INTO v_existing_id
  FROM public.student_rounds sr
  WHERE sr.student_id = v_target
    AND sr.series_id = v_series_id
    AND sr.round_date = public.today_ist()
    AND NOT EXISTS (
      SELECT 1 FROM public.results r WHERE r.student_round_id = sr.id
    )
  ORDER BY sr.round_number DESC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  SELECT COALESCE(MAX(round_number), 0) + 1 INTO v_next_num
  FROM public.student_rounds
  WHERE student_id = v_target AND series_id = v_series_id;

  INSERT INTO public.student_rounds (student_id, series_id, round_number, round_date, round_type)
  VALUES (
    v_target,
    v_series_id,
    v_next_num,
    public.today_ist(),
    COALESCE(NULLIF(TRIM(p_round_type), ''), 'Category wise')
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;
