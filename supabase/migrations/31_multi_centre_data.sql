-- Multi-centre step 2: Baran Centre, everyone in it, and admin becomes owner.
--
--   1. Creates the default centre "Baran Centre" (code BRN).
--   2. Puts every student and teacher who has no centre into it. Owners and
--      directors (and legacy admin) belong to no centre.
--   3. New students and teachers created without a centre land in the default
--      centre; a constraint keeps "network roles have no centre, everyone else
--      has one" true from now on.
--   4. Rewrites the policies and functions that still tested role = 'admin'
--      inline, so owners and directors keep every admin power. Fails loudly if
--      any 'admin' check is left in a form it does not recognise.
--   5. Converts the admin account to owner.
--
-- No rows are deleted. Centre heads are still not admins (step 5 scopes them).
-- Rollback: supabase/rollbacks/31_multi_centre_data_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Default centre
-- ---------------------------------------------------------------------------
INSERT INTO public.centres (name, code, kind, is_default)
SELECT 'Baran Centre', 'BRN', 'centre', true
 WHERE NOT EXISTS (SELECT 1 FROM public.centres WHERE is_default);

CREATE OR REPLACE FUNCTION public.default_centre()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.centres WHERE is_default AND status = 'active' LIMIT 1
$$;
REVOKE EXECUTE ON FUNCTION public.default_centre() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.default_centre() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Backfill (runs without auth.uid(), so the profiles guard allows it)
-- ---------------------------------------------------------------------------
UPDATE public.profiles
   SET centre_id = public.default_centre()
 WHERE centre_id IS NULL
   AND role NOT IN ('owner', 'director', 'admin');

-- ---------------------------------------------------------------------------
-- 3. New accounts default to the default centre; roles and centres agree
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_default_centre()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.role IN ('owner', 'director', 'admin') THEN
    NEW.centre_id := NULL;
  ELSIF NEW.centre_id IS NULL THEN
    NEW.centre_id := public.default_centre();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.profiles_default_centre() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS profiles_default_centre ON public.profiles;
CREATE TRIGGER profiles_default_centre BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_default_centre();

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_centre_matches_role;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_centre_matches_role CHECK (
  (role IN ('owner', 'director', 'admin')) = (centre_id IS NULL));

-- ---------------------------------------------------------------------------
-- 4a. Policies that tested profiles.role = 'admin' inline
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_from constant text := 'role = ''admin''::text';
  v_to   constant text := 'role = ANY (ARRAY[''owner''::text, ''director''::text, ''admin''::text])';
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

  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '''admin''::text'
                AND (coalesce(qual, '') || coalesce(with_check, ''))
                    !~ 'ARRAY\[''owner''::text, ''director''::text, ''admin''::text\]') THEN
    RAISE EXCEPTION 'A policy still checks role = admin in a form this migration does not know.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4b. Functions that tested role = 'admin' inline
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_left text;
  v_skip constant text[] := ARRAY['role_rank', 'my_role', 'is_network_admin', 'is_owner', 'is_admin',
    'profiles_keep_an_owner', 'set_person_role', 'can_manage_profile', 'profiles_guard',
    'profiles_default_centre', 'default_centre'];
BEGIN
  FOR r IN SELECT p.oid, p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND p.prosrc ~ '''admin'''
              AND NOT (p.proname = ANY (v_skip))
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(v_def, 'IN (''admin'', ''teacher'')', 'IN (''owner'', ''director'', ''admin'', ''teacher'')');
    v_new := regexp_replace(v_new, '(\m[a-z_]*role) = ''admin''', '\1 IN (''owner'', ''director'', ''admin'')', 'g');

    -- Whatever 'admin' is left must be inside the new lists.
    v_left := replace(replace(v_new,
      'IN (''owner'', ''director'', ''admin'', ''teacher'')', ''),
      'IN (''owner'', ''director'', ''admin'')', '');
    IF v_left ~ '''admin''' THEN
      RAISE EXCEPTION 'Function % checks admin in a form this migration does not know.', r.proname;
    END IF;
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The admin account becomes the owner
-- ---------------------------------------------------------------------------
UPDATE public.profiles SET role = 'owner', centre_id = NULL WHERE role = 'admin';
