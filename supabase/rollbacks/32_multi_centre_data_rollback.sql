-- Rollback for 32_multi_centre_data.sql: owner back to admin, everyone out of
-- Baran Centre, and the inline admin checks back to role = 'admin'.
--
-- Only safe while nobody holds a role the old checks do not know (director,
-- centre_head, vice_centre_head) and there is a single owner; it refuses
-- otherwise. Take a backup first. No rows are deleted except the Baran
-- Centre row itself (after everyone has been moved out of it).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE role IN ('director', 'centre_head', 'vice_centre_head'))
     OR (SELECT count(*) FROM public.profiles WHERE role = 'owner') > 1 THEN
    RAISE EXCEPTION 'Rollback refused: directors, heads or extra owners exist. Change them first.';
  END IF;
END $$;

UPDATE public.profiles SET role = 'admin' WHERE role = 'owner';

-- Inline admin checks back to their old form.
DO $$
DECLARE
  r record;
  v_from constant text := 'role = ANY (ARRAY[''owner''::text, ''director''::text, ''admin''::text])';
  v_to   constant text := 'role = ''admin''::text';
  v_sql  text;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check
             FROM pg_policies
            WHERE schemaname = 'public'
              AND (position(v_from IN coalesce(qual, '')) > 0 OR position(v_from IN coalesce(with_check, '')) > 0)
  LOOP
    v_sql := format('ALTER POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    IF r.qual IS NOT NULL THEN
      v_sql := v_sql || ' USING (' || replace(r.qual, v_from, v_to) || ')';
    END IF;
    IF r.with_check IS NOT NULL THEN
      v_sql := v_sql || ' WITH CHECK (' || replace(r.with_check, v_from, v_to) || ')';
    END IF;
    EXECUTE v_sql;
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN SELECT p.oid
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND p.prosrc ~ 'IN \(''owner'', ''director'', ''admin'''
              AND p.proname NOT IN ('profiles_default_centre')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, 'IN (''owner'', ''director'', ''admin'', ''teacher'')', 'IN (''admin'', ''teacher'')');
    v_new := regexp_replace(v_new, '(\m[a-z_]*role) IN \(''owner'', ''director'', ''admin''\)', '\1 = ''admin''', 'g');
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_centre_matches_role;
DROP TRIGGER IF EXISTS profiles_default_centre ON public.profiles;
DROP FUNCTION IF EXISTS public.profiles_default_centre();

UPDATE public.profiles SET centre_id = NULL
 WHERE centre_id = (SELECT id FROM public.centres WHERE code = 'BRN');
DELETE FROM public.centre_staff WHERE centre_id = (SELECT id FROM public.centres WHERE code = 'BRN');
DELETE FROM public.centre_visibility
 WHERE source_centre_id = (SELECT id FROM public.centres WHERE code = 'BRN')
    OR viewer_centre_id = (SELECT id FROM public.centres WHERE code = 'BRN');
DELETE FROM public.centres WHERE code = 'BRN';
DROP FUNCTION IF EXISTS public.default_centre();
