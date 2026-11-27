-- Phase 23: one standard list of student levels.
--
-- Students may only have one of these levels (or none), in this order:
--   KA-1, KA-2, KA-3, Level 1 .. Level 6, Graduate, Master, Grandmaster
-- Staff keep the special levels 'Teacher' and 'Admin'.
-- The same list lives in shared/levels.js (STUDENT_LEVELS); keep both in sync.
--
-- Existing values are moved by the mapping the owner approved on 2026-11-27:
--   '2'                       -> 'Level 2'
--   'Teacher' on a student    -> 'Level 1'   (TEACH_01 .. TEACH_04)
--   'Junior 1', 'Junior 2'    -> no level    (owner sets each one by hand)
-- Any other value outside the list stops the migration so nobody's level is guessed.

CREATE OR REPLACE FUNCTION public.is_standard_student_level(p_level text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT p_level IN (
    'KA-1', 'KA-2', 'KA-3',
    'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6',
    'Graduate', 'Master', 'Grandmaster'
  );
$function$;

-- 1. Approved mapping
UPDATE public.profiles SET level = 'Level 2'
 WHERE role = 'student' AND btrim(level) = '2';

UPDATE public.profiles SET level = 'Level 1'
 WHERE role = 'student' AND btrim(level) = 'Teacher';

UPDATE public.profiles SET level = NULL
 WHERE role = 'student' AND btrim(level) IN ('Junior 1', 'Junior 2');

-- 2. Same level with different spacing or letter case (e.g. 'master ', 'LEVEL 3')
UPDATE public.profiles p SET level = s.std
  FROM unnest(ARRAY[
    'KA-1', 'KA-2', 'KA-3',
    'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6',
    'Graduate', 'Master', 'Grandmaster', 'Teacher', 'Admin'
  ]) AS s(std)
 WHERE p.level IS DISTINCT FROM s.std
   AND lower(btrim(p.level)) = lower(s.std);

UPDATE public.profiles SET level = NULL WHERE btrim(level) = '';

-- 3. Refuse to continue if anything is still outside the list
DO $check$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(DISTINCT format('%s (%s)', level, role), ', ') INTO v_bad
    FROM public.profiles
   WHERE level IS NOT NULL
     AND NOT public.is_standard_student_level(level)
     AND NOT (role IN ('teacher', 'admin') AND level IN ('Teacher', 'Admin'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Levels outside the standard list need a decision first: %', v_bad;
  END IF;
END
$check$;

-- 4. Enforce the list from now on
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_level_allowed;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_level_allowed CHECK (
  level IS NULL
  OR public.is_standard_student_level(level)
  OR (role IN ('teacher', 'admin') AND level IN ('Teacher', 'Admin'))
);
