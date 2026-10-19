-- ==============================================================================
-- 09_phase4c_2_admin_import_rounds.sql
-- Phase 4c-2: Historical CSV Import Tables & RPCs (category_aliases, import_batches,
-- admin_start_import_batch, admin_import_rounds, admin_finish_import_batch, admin_undo_import_batch)
-- Run Order: 9 of 12
-- ==============================================================================

-- 1. Table: category_aliases
CREATE TABLE IF NOT EXISTS public.category_aliases (
  alias TEXT PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.category_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "category_aliases_read" ON public.category_aliases;
DROP POLICY IF EXISTS "category_aliases_admin_write" ON public.category_aliases;

CREATE POLICY "category_aliases_read" ON public.category_aliases
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "category_aliases_admin_write" ON public.category_aliases
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2. Table: import_batches
CREATE TABLE IF NOT EXISTS public.import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  conflict_mode TEXT NOT NULL CHECK (conflict_mode IN ('skip', 'overwrite')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'undone')),
  rounds_created INTEGER NOT NULL DEFAULT 0,
  results_inserted INTEGER NOT NULL DEFAULT 0,
  results_updated INTEGER NOT NULL DEFAULT 0,
  results_skipped INTEGER NOT NULL DEFAULT 0,
  acknowledgments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  undone_at TIMESTAMPTZ NULL,
  undone_by UUID NULL REFERENCES public.profiles(id)
);

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "import_batches_admin_all" ON public.import_batches;
CREATE POLICY "import_batches_admin_all" ON public.import_batches
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 3. RPC: admin_import_rounds
-- Imports up to 100 rounds per call for a given student, series, and import_batch_id.
CREATE OR REPLACE FUNCTION public.admin_import_rounds(
  p_batch_id UUID,
  p_student UUID,
  p_series UUID,
  p_conflict_mode TEXT,
  p_rounds JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round JSONB;
  v_cell JSONB;
  v_round_num INTEGER;
  v_round_date DATE;
  v_round_type TEXT;
  v_time_taken INTEGER;
  v_student_round_id UUID;
  v_existing_res public.results%ROWTYPE;
  v_cat_id UUID;
  v_correct INTEGER;
  v_total INTEGER;
  v_time_sec INTEGER;
  v_note TEXT;
  v_rounds_created INTEGER := 0;
  v_inserted INTEGER := 0;
  v_updated INTEGER := 0;
  v_skipped INTEGER := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: Admin access required.';
  END IF;

  IF p_conflict_mode NOT IN ('skip', 'overwrite') THEN
    RAISE EXCEPTION 'Invalid conflict mode: %', p_conflict_mode;
  END IF;

  IF jsonb_typeof(p_rounds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rounds) > 100 THEN
    RAISE EXCEPTION 'p_rounds must be a JSON array of at most 100 rounds.';
  END IF;

  FOR v_round IN SELECT * FROM jsonb_array_elements(p_rounds) LOOP
    v_round_num := (v_round->>'round_number')::INTEGER;
    v_round_date := (v_round->>'round_date')::DATE;
    v_round_type := LEFT(COALESCE(NULLIF(TRIM(v_round->>'round_type'), ''), 'Category wise'), 40);
    v_time_taken := (v_round->>'time_taken_seconds')::INTEGER;

    IF v_round_num IS NULL OR v_round_num < 1 OR v_round_num > 100000 THEN
      RAISE EXCEPTION 'Invalid round_number: %', v_round_num;
    END IF;

    IF v_round_date IS NULL OR v_round_date < DATE '2020-01-01' OR v_round_date > public.today_ist() THEN
      RAISE EXCEPTION 'Invalid round_date (%) on round %', v_round_date, v_round_num;
    END IF;

    IF v_time_taken IS NOT NULL AND (v_time_taken < 0 OR v_time_taken > 28800) THEN
      RAISE EXCEPTION 'Invalid time_taken_seconds (%) on round %', v_time_taken, v_round_num;
    END IF;

    SELECT id INTO v_student_round_id
    FROM public.student_rounds
    WHERE student_id = p_student AND series_id = p_series AND round_number = v_round_num;

    IF v_student_round_id IS NULL THEN
      INSERT INTO public.student_rounds (
        student_id, series_id, round_number, round_date, round_type, time_taken_seconds, import_batch_id
      ) VALUES (
        p_student, p_series, v_round_num, v_round_date, v_round_type, v_time_taken, p_batch_id
      )
      RETURNING id INTO v_student_round_id;
      v_rounds_created := v_rounds_created + 1;
    ELSIF p_conflict_mode = 'overwrite' THEN
      UPDATE public.student_rounds
      SET
        round_date = v_round_date,
        round_type = v_round_type,
        time_taken_seconds = COALESCE(v_time_taken, time_taken_seconds)
      WHERE id = v_student_round_id;
    END IF;

    IF jsonb_typeof(v_round->'cells') = 'array' THEN
      FOR v_cell IN SELECT * FROM jsonb_array_elements(v_round->'cells') LOOP
        v_cat_id := (v_cell->>'category_id')::UUID;
        v_correct := (v_cell->>'correct')::INTEGER;
        v_total := (v_cell->>'total')::INTEGER;
        v_time_sec := (v_cell->>'time_seconds')::INTEGER;
        v_note := LEFT(NULLIF(TRIM(v_cell->>'note'), ''), 500);

        IF v_time_sec IS NOT NULL AND (v_time_sec < 0 OR v_time_sec > 14400) THEN
          RAISE EXCEPTION 'Invalid cell time_seconds (%) on round %', v_time_sec, v_round_num;
        END IF;

        SELECT * INTO v_existing_res
        FROM public.results
        WHERE student_round_id = v_student_round_id AND category_id = v_cat_id;

        IF NOT FOUND THEN
          INSERT INTO public.results (
            student_id, category_id, student_round_id, correct, total, time_seconds, note, entry_date
          ) VALUES (
            p_student, v_cat_id, v_student_round_id, v_correct, v_total, v_time_sec, v_note, v_round_date
          );
          v_inserted := v_inserted + 1;
        ELSE
          -- Never overwrite verified or teacher-corrected rows
          IF v_existing_res.verified = true OR v_existing_res.verified_at IS NOT NULL OR v_existing_res.corrected_at IS NOT NULL THEN
            v_skipped := v_skipped + 1;
          ELSIF p_conflict_mode = 'overwrite' THEN
            UPDATE public.results
            SET
              correct = v_correct,
              total = v_total,
              time_seconds = v_time_sec,
              note = v_note
            WHERE id = v_existing_res.id;
            v_updated := v_updated + 1;
          ELSE
            v_skipped := v_skipped + 1;
          END IF;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  UPDATE public.import_batches
  SET
    rounds_created = rounds_created + v_rounds_created,
    results_inserted = results_inserted + v_inserted,
    results_updated = results_updated + v_updated,
    results_skipped = results_skipped + v_skipped
  WHERE id = p_batch_id;

  RETURN jsonb_build_object(
    'rounds_created', v_rounds_created,
    'results_inserted', v_inserted,
    'results_updated', v_updated,
    'results_skipped', v_skipped
  );
END;
$$;
