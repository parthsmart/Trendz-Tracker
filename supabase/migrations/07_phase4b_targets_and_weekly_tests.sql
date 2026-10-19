-- ==============================================================================
-- 07_phase4b_targets_and_weekly_tests.sql
-- Phase 4b: Basics Threshold Targets, Weekly Tests, Weekly Test Scores & results_with_target View
-- Run Order: 7 of 12
-- ==============================================================================

-- 1. Table: basics_thresholds
CREATE TABLE IF NOT EXISTS public.basics_thresholds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  level TEXT NULL,
  min_accuracy INTEGER NOT NULL CHECK (min_accuracy >= 0 AND min_accuracy <= 100),
  max_time_seconds INTEGER NULL CHECK (max_time_seconds IS NULL OR max_time_seconds > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE OR REPLACE FUNCTION public.check_basics_threshold_category()
RETURNS TRIGGER AS $$
DECLARE
  cat_section TEXT;
BEGIN
  SELECT section INTO cat_section FROM public.categories WHERE id = NEW.category_id;
  IF cat_section IS DISTINCT FROM 'basics' THEN
    RAISE EXCEPTION 'Only categories in the basics section can have target thresholds (category % has section %)', NEW.category_id, cat_section;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_basics_threshold_category ON public.basics_thresholds;
CREATE TRIGGER trg_check_basics_threshold_category
  BEFORE INSERT OR UPDATE ON public.basics_thresholds
  FOR EACH ROW EXECUTE FUNCTION public.check_basics_threshold_category();

CREATE UNIQUE INDEX IF NOT EXISTS idx_basics_thresholds_cat_level
  ON public.basics_thresholds (category_id, level)
  WHERE level IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_basics_thresholds_cat_default
  ON public.basics_thresholds (category_id)
  WHERE level IS NULL;

-- 2. Table: weekly_tests
CREATE TABLE IF NOT EXISTS public.weekly_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_date DATE NOT NULL DEFAULT public.today_ist(),
  title TEXT NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Table: weekly_test_scores
CREATE TABLE IF NOT EXISTS public.weekly_test_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES public.weekly_tests(id) ON DELETE RESTRICT,
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  correct INTEGER NOT NULL CHECK (correct >= 0),
  total INTEGER NOT NULL CHECK (total > 0),
  time_seconds INTEGER NULL CHECK (time_seconds IS NULL OR time_seconds >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT chk_test_score_correct_lte_total CHECK (correct <= total),
  CONSTRAINT uq_weekly_test_scores_test_student_cat UNIQUE (test_id, student_id, category_id)
);

-- 4. View: results_with_target
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

-- Enable RLS
ALTER TABLE public.basics_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_test_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read active basics thresholds" ON public.basics_thresholds;
DROP POLICY IF EXISTS "Admins full access to basics thresholds" ON public.basics_thresholds;
DROP POLICY IF EXISTS "Authenticated users can read weekly tests" ON public.weekly_tests;
DROP POLICY IF EXISTS "Admins full access to weekly tests" ON public.weekly_tests;
DROP POLICY IF EXISTS "Students read own weekly test scores" ON public.weekly_test_scores;
DROP POLICY IF EXISTS "Admins manage weekly test scores" ON public.weekly_test_scores;

CREATE POLICY "Anyone can read active basics thresholds" ON public.basics_thresholds
  FOR SELECT TO authenticated USING (active = true OR public.is_admin());

CREATE POLICY "Admins full access to basics thresholds" ON public.basics_thresholds
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Authenticated users can read weekly tests" ON public.weekly_tests
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins full access to weekly tests" ON public.weekly_tests
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Students read own weekly test scores" ON public.weekly_test_scores
  FOR SELECT TO authenticated USING (student_id = auth.uid() OR public.is_admin());

CREATE POLICY "Admins manage weekly test scores" ON public.weekly_test_scores
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
