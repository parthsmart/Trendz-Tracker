-- Trendz Tracker — Flash Anzan "Simple" mode
--
-- Adds a third Flash Anzan mode, 'simple', next to 'add' and 'add_sub'.
-- Simple questions can be solved on the abacus without any formula: every rod
-- (digit column) is added to or taken from directly, digits are 1-9 (no zeros),
-- plus and minus numbers are mixed at random, and the total never goes below zero.
--
-- This file:
-- 1. Replaces flash_generate_question with a version that also builds Simple questions
--    ('add' and 'add_sub' work exactly as before).
-- 2. Lets flash_start, save_weekly_test_sections_atomic and practice_highest_records
--    accept 'simple'. These functions are patched in place (small text replacements on
--    the live definition), so nothing else in them changes.
-- 3. Lets daily_tasks.flash_mode and weekly_test_sections.flash_mode store 'simple'.
--
-- Safe to run more than once. Older app versions never send 'simple', so they keep working.

BEGIN;

-- 1. Question generator -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.flash_generate_question(p_digits integer, p_count integer, p_mode text)
 RETURNS integer[]
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_lo integer := CASE WHEN p_digits = 1 THEN 1 ELSE (10 ^ (p_digits - 1))::integer END;
  v_hi integer := (10 ^ p_digits)::integer - 1;
  v_nums integer[] := '{}';
  v_total integer := 0;
  v_prev integer := NULL;
  v_n integer;
  v_sign integer;
  v_tries integer;
  i integer;
  -- Simple mode
  v_rods integer[];
  v_ds integer[];
  v_opts integer[];
  v_rod integer;
  v_pick integer;
  v_can_add boolean;
  v_can_sub boolean;
  c integer;
  k integer;
BEGIN
  IF p_mode = 'simple' THEN
    v_rods := array_fill(0, ARRAY[p_digits]);
    FOR i IN 1..p_count LOOP
      v_sign := 1;
      IF i > 1 THEN
        -- A rod at 9 cannot take a plus and a rod at 0 cannot take a minus.
        -- A plus never makes a 0 and a minus never makes a 9, so one of them always works.
        v_can_add := NOT (9 = ANY (v_rods));
        v_can_sub := NOT (0 = ANY (v_rods));
        IF v_can_add AND v_can_sub THEN
          IF random() < 0.5 THEN
            v_sign := -1;
          END IF;
        ELSIF v_can_sub THEN
          v_sign := -1;
        END IF;
      END IF;

      v_tries := 0;
      LOOP
        v_tries := v_tries + 1;
        v_n := 0;
        v_ds := '{}';
        FOR c IN 1..p_digits LOOP
          v_rod := v_rods[c];
          IF i = 1 THEN
            v_pick := 1 + floor(random() * 9)::integer;
          ELSE
            v_opts := '{}';
            FOR k IN 1..9 LOOP
              IF v_sign = 1 THEN
                IF (v_rod % 5) + (k % 5) <= 4 AND (v_rod / 5) + (k / 5) <= 1 THEN
                  v_opts := v_opts || k;
                END IF;
              ELSE
                IF (v_rod % 5) >= (k % 5) AND (v_rod / 5) >= (k / 5) THEN
                  v_opts := v_opts || k;
                END IF;
              END IF;
            END LOOP;
            v_pick := v_opts[1 + floor(random() * array_length(v_opts, 1))::integer];
          END IF;
          v_ds := v_ds || v_pick;
          v_n := v_n * 10 + v_pick;
        END LOOP;
        -- avoid the same number twice in a row
        EXIT WHEN v_prev IS NULL OR v_n <> v_prev OR v_tries >= 10;
      END LOOP;

      FOR c IN 1..p_digits LOOP
        v_rods[c] := v_rods[c] + v_sign * v_ds[c];
      END LOOP;
      v_nums := v_nums || (v_sign * v_n);
      v_total := v_total + v_sign * v_n;
      v_prev := v_n;
    END LOOP;
    RETURN v_nums;
  END IF;

  FOR i IN 1..p_count LOOP
    v_tries := 0;
    LOOP
      v_tries := v_tries + 1;
      v_n := v_lo + floor(random() * (v_hi - v_lo + 1))::integer;
      v_sign := 1;
      IF p_mode = 'add_sub' AND i > 1 AND random() < 0.4 THEN
        v_sign := -1;
      END IF;
      -- subtract only if the running total stays at zero or above
      IF v_sign = -1 AND v_total - v_n < 0 THEN
        v_sign := 1;
      END IF;
      -- avoid the same number twice in a row
      EXIT WHEN v_prev IS NULL OR v_n <> v_prev OR v_tries > 20;
    END LOOP;
    v_nums := v_nums || (v_sign * v_n);
    v_total := v_total + v_sign * v_n;
    v_prev := v_n;
  END LOOP;
  RETURN v_nums;
END;
$function$;

-- 2. Accept 'simple' in the functions that check the mode ------------------------------

DO $patch$
DECLARE
  v_fn text;
  v_old text;
  v_new text;
  v_pairs text[][];
  v_targets text[] := ARRAY[
    'public.flash_start(jsonb)',
    'public.save_weekly_test_sections_atomic',
    'public.practice_highest_records(text, jsonb)'
  ];
  v_target text;
  v_oid oid;
  j integer;
BEGIN
  v_pairs := ARRAY[
    ARRAY[$q$v_mode NOT IN ('add', 'add_sub')$q$,
          $q$v_mode NOT IN ('add', 'add_sub', 'simple')$q$],
    ARRAY[$q$IN ('add', 'add_sub')$q$,
          $q$IN ('add', 'add_sub', 'simple')$q$],
    ARRAY[$q$Flash mode must be "add" or "add_sub" (received %)$q$,
          $q$Flash mode must be "add", "add_sub" or "simple" (received %)$q$],
    ARRAY[$q$CASE WHEN v_flash_mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END$q$,
          $q$CASE WHEN v_flash_mode = 'add_sub' THEN 'Add & Sub' WHEN v_flash_mode = 'simple' THEN 'Simple' ELSE 'Add' END$q$],
    ARRAY[$q$CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Subtract' ELSE 'Add' END$q$,
          $q$CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Subtract' WHEN tfh.mode = 'simple' THEN 'Simple' ELSE 'Add' END$q$],
    ARRAY[$q$CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Sub' ELSE 'Add' END$q$,
          $q$CASE WHEN tfh.mode = 'add_sub' THEN 'Add & Sub' WHEN tfh.mode = 'simple' THEN 'Simple' ELSE 'Add' END$q$]
  ];

  FOREACH v_target IN ARRAY v_targets LOOP
    IF position('(' IN v_target) > 0 THEN
      v_oid := v_target::regprocedure;
    ELSE
      SELECT p.oid INTO v_oid
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = split_part(v_target, '.', 2);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Function % not found', v_target;
      END IF;
    END IF;

    v_old := pg_get_functiondef(v_oid);
    v_new := v_old;
    FOR j IN 1..array_length(v_pairs, 1) LOOP
      v_new := replace(v_new, v_pairs[j][1], v_pairs[j][2]);
    END LOOP;

    IF position($q$'simple'$q$ IN v_new) = 0 THEN
      RAISE EXCEPTION 'Could not add the simple mode to % (its mode check was not found)', v_target;
    END IF;

    IF v_new <> v_old THEN
      EXECUTE v_new;
      RAISE NOTICE 'Patched %', v_target;
    ELSE
      RAISE NOTICE '% already accepts simple', v_target;
    END IF;
  END LOOP;
END
$patch$;

-- 3. Table checks ------------------------------------------------------------------

DO $con$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.daily_tasks'::regclass AND conname = 'daily_tasks_flash_ranges';
  IF v_def IS NOT NULL AND position('simple' IN v_def) = 0 THEN
    ALTER TABLE public.daily_tasks DROP CONSTRAINT daily_tasks_flash_ranges;
    ALTER TABLE public.daily_tasks ADD CONSTRAINT daily_tasks_flash_ranges CHECK (
      (flash_digits IS NULL OR (flash_digits >= 1 AND flash_digits <= 5))
      AND (flash_count IS NULL OR (flash_count >= 2 AND flash_count <= 1000))
      AND (flash_speed_ms IS NULL OR (flash_speed_ms >= 200 AND flash_speed_ms <= 5000))
      AND (flash_mode IS NULL OR flash_mode = ANY (ARRAY['add'::text, 'add_sub'::text, 'simple'::text]))
    );
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.weekly_test_sections'::regclass AND conname = 'wt_sections_shape_check';
  IF v_def IS NOT NULL AND position('simple' IN v_def) = 0 THEN
    ALTER TABLE public.weekly_test_sections DROP CONSTRAINT wt_sections_shape_check;
    ALTER TABLE public.weekly_test_sections ADD CONSTRAINT wt_sections_shape_check CHECK (
      (
        kind = ANY (ARRAY['basics'::text, 'round'::text])
        AND category_id IS NOT NULL AND activity_key IS NULL
        AND flash_digits IS NULL AND flash_count IS NULL AND flash_speed_ms IS NULL
        AND flash_mode IS NULL AND question_count IS NULL
      ) OR (
        kind = ANY (ARRAY['elements'::text, 'memoriad'::text])
        AND category_id IS NULL AND seconds IS NULL AND activity_key IS NOT NULL
        AND activity_key ~ '^[a-z0-9_]{2,40}$'::text
        AND flash_digits IS NULL AND flash_count IS NULL AND flash_speed_ms IS NULL
        AND flash_mode IS NULL AND question_count IS NULL
      ) OR (
        kind = 'flash'::text
        AND category_id IS NULL AND activity_key IS NULL AND seconds IS NULL
        AND flash_digits IS NOT NULL AND flash_digits >= 1 AND flash_digits <= 5
        AND flash_count IS NOT NULL AND flash_count >= 2 AND flash_count <= 1000
        AND flash_speed_ms IS NOT NULL AND flash_speed_ms >= 200 AND flash_speed_ms <= 5000
        AND flash_mode IS NOT NULL
        AND flash_mode = ANY (ARRAY['add'::text, 'add_sub'::text, 'simple'::text])
        AND question_count IS NOT NULL AND question_count >= 1 AND question_count <= 10
      )
    );
  END IF;
END
$con$;

COMMIT;
