-- Multi-centre step 1: schema, role helpers and escalation-proof role changes.
--
-- Hierarchy (rank): owner 100 > director 80 > centre_head 60 > vice_centre_head 50
--                   > teacher 30 > student 10.   Legacy 'admin' ranks as owner (100)
--                   until step 2 converts it.
--
-- This migration changes NO behaviour for existing accounts:
--   * no data is moved (step 2 creates "Baran Centre" and backfills centre_id);
--   * is_admin() keeps meaning "sees everything": legacy admin, owner, director.
--     Centre heads and vice heads are deliberately NOT is_admin(), so until the
--     scoped policies land (step 5) they fail closed (see nothing extra) instead
--     of seeing every centre.
--   * role and centre changes go only through set_person_role() (it leaves a
--     one-time ticket the guard checks), which enforces:
--       - the actor's rank must be strictly higher than the person's current
--         AND new rank (owners may also manage owners);
--       - centre staff act only inside their own centre and cannot move people
--         between centres;
--       - nobody changes their own role;
--       - there is always at least one active owner.
--   * every role / centre / active / permission change is written to role_audit
--     by trigger (append-only: no update or delete is possible from the site).
--
-- Rollback: supabase/rollbacks/30_multi_centre_schema_rollback.sql

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.centres (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text NOT NULL,
  kind        text NOT NULL DEFAULT 'centre' CHECK (kind IN ('centre', 'school')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  is_default  boolean NOT NULL DEFAULT false,
  city        text,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by uuid,
  CONSTRAINT centres_name_len CHECK (char_length(trim(name)) BETWEEN 2 AND 80),
  CONSTRAINT centres_code_format CHECK (code ~ '^[A-Z0-9]{2,8}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS centres_code_key ON public.centres (code);
CREATE UNIQUE INDEX IF NOT EXISTS centres_name_key ON public.centres (lower(trim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS centres_one_default ON public.centres ((true)) WHERE is_default;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS centre_id uuid REFERENCES public.centres (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS profiles_centre_id_idx ON public.profiles (centre_id);

-- Who runs which centre, with history (ended_at is set instead of deleting).
CREATE TABLE IF NOT EXISTS public.centre_staff (
  id          bigserial PRIMARY KEY,
  centre_id   uuid NOT NULL REFERENCES public.centres (id) ON DELETE RESTRICT,
  profile_id  uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('centre_head', 'vice_centre_head')),
  assigned_by uuid,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  ended_by    uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS centre_staff_one_head
  ON public.centre_staff (centre_id) WHERE role = 'centre_head' AND ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS centre_staff_one_active_post
  ON public.centre_staff (profile_id) WHERE ended_at IS NULL;

-- Cross-centre exposure for duels (owner / director decide). Students of
-- source_centre_id become duel opponents for viewer_centre_id (NULL = every
-- centre): all of them, a chosen list, or the top N by XP.
CREATE TABLE IF NOT EXISTS public.centre_visibility (
  id               bigserial PRIMARY KEY,
  source_centre_id uuid NOT NULL REFERENCES public.centres (id) ON DELETE CASCADE,
  viewer_centre_id uuid REFERENCES public.centres (id) ON DELETE CASCADE,
  mode             text NOT NULL CHECK (mode IN ('all', 'students', 'top_n')),
  student_ids      uuid[],
  top_n            integer CHECK (top_n IS NULL OR top_n BETWEEN 1 AND 500),
  purpose          text NOT NULL DEFAULT 'duels' CHECK (purpose IN ('duels')),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  CONSTRAINT centre_visibility_mode_args CHECK (
    (mode = 'all' AND student_ids IS NULL AND top_n IS NULL)
    OR (mode = 'students' AND student_ids IS NOT NULL AND top_n IS NULL)
    OR (mode = 'top_n' AND top_n IS NOT NULL AND student_ids IS NULL)),
  CONSTRAINT centre_visibility_not_self CHECK (viewer_centre_id IS DISTINCT FROM source_centre_id)
);

-- Append-only audit of every role, centre and permission change.
CREATE TABLE IF NOT EXISTS public.role_audit (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,
  actor_role text,
  target_id  uuid,
  centre_id  uuid,
  action     text NOT NULL,
  before     jsonb,
  after      jsonb
);
CREATE INDEX IF NOT EXISTS role_audit_target_idx ON public.role_audit (target_id, at DESC);
CREATE INDEX IF NOT EXISTS role_audit_centre_idx ON public.role_audit (centre_id, at DESC);

-- One-time tickets that let set_person_role() past the profiles guard. Nobody
-- but the function owner can read or write this table, so a client cannot
-- forge one (a session setting could be set by anyone with SQL access).
CREATE TABLE IF NOT EXISTS public.role_change_tickets (
  target_id uuid NOT NULL,
  tx        bigint NOT NULL,
  role      text NOT NULL,
  centre_id uuid,
  PRIMARY KEY (target_id, tx)
);
ALTER TABLE public.role_change_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.role_change_tickets FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Profile constraints for the new roles
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (
  role IN ('owner', 'director', 'centre_head', 'vice_centre_head', 'teacher', 'student', 'admin'));

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_level_allowed;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_level_allowed CHECK (
  level IS NULL
  OR public.is_standard_student_level(level)
  OR (role <> 'student' AND level IN ('Teacher', 'Admin')));

-- ---------------------------------------------------------------------------
-- 3. Role helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.role_rank(p_role text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN 100
    WHEN 'admin' THEN 100           -- legacy, converted to owner in step 2
    WHEN 'director' THEN 80
    WHEN 'centre_head' THEN 60
    WHEN 'vice_centre_head' THEN 50
    WHEN 'teacher' THEN 30
    WHEN 'student' THEN 10
    ELSE 0 END
$$;

-- The signed-in person's role, or NULL when inactive, deleted, or in a
-- suspended / archived centre (centre-bound roles only).
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.role
    FROM public.profiles p
    LEFT JOIN public.centres c ON c.id = p.centre_id
   WHERE p.id = auth.uid() AND p.active AND p.deleted_at IS NULL
     AND (p.role IN ('owner', 'director', 'admin') OR p.centre_id IS NULL OR c.status = 'active')
$$;

CREATE OR REPLACE FUNCTION public.my_rank()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.role_rank(public.my_role())
$$;

CREATE OR REPLACE FUNCTION public.my_centre()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.centre_id FROM public.profiles p
   WHERE p.id = auth.uid() AND p.active AND p.deleted_at IS NULL
$$;

-- Owner, director (and legacy admin): every centre.
CREATE OR REPLACE FUNCTION public.is_network_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.my_role() IN ('owner', 'director', 'admin'), false)
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.my_role() IN ('owner', 'admin'), false)
$$;

-- Unchanged meaning: "sees everything". Heads are NOT included on purpose.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_network_admin()
$$;

-- Network admin, or head / vice head of that (active) centre.
CREATE OR REPLACE FUNCTION public.is_centre_admin(p_centre uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_network_admin()
      OR COALESCE(p_centre IS NOT NULL
          AND public.my_role() IN ('centre_head', 'vice_centre_head')
          AND public.my_centre() = p_centre, false)
$$;

CREATE OR REPLACE FUNCTION public.is_centre_head(p_centre uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_network_admin()
      OR COALESCE(p_centre IS NOT NULL AND public.my_role() = 'centre_head' AND public.my_centre() = p_centre, false)
$$;

CREATE OR REPLACE FUNCTION public.profile_centre(p_profile uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT centre_id FROM public.profiles WHERE id = p_profile
$$;

-- Can the signed-in person manage (edit, deactivate, reset) this person?
CREATE OR REPLACE FUNCTION public.can_manage_profile(p_profile uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT p.id <> auth.uid()
       AND (public.role_rank(p.role) < public.my_rank()
            OR (public.is_owner() AND p.role IN ('owner', 'admin')))
       AND (public.is_network_admin() OR public.is_centre_admin(p.centre_id))
      FROM public.profiles p WHERE p.id = p_profile), false)
$$;

-- ---------------------------------------------------------------------------
-- 4. Guard: role and centre change only through set_person_role(); nobody
--    edits an account ranked at or above their own.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rpc boolean;
BEGIN
  DELETE FROM public.role_change_tickets t
   WHERE t.target_id = OLD.id AND t.tx = txid_current()
     AND t.role = NEW.role AND t.centre_id IS NOT DISTINCT FROM NEW.centre_id;
  v_rpc := FOUND;
  IF auth.uid() IS NOT NULL THEN
    IF NEW.student_code IS DISTINCT FROM OLD.student_code THEN
      RAISE EXCEPTION 'The student ID is the login name and cannot be changed here.';
    END IF;
    IF NOT v_rpc AND NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'The role cannot be changed from the site.';
    END IF;
    IF NOT v_rpc AND NEW.centre_id IS DISTINCT FROM OLD.centre_id THEN
      RAISE EXCEPTION 'The centre can only be changed with a transfer.';
    END IF;
    -- Staff only: students edit only themselves (RLS), and definer functions
    -- acting for a student (duels, XP) may touch other students' rows.
    IF OLD.id <> auth.uid()
       AND public.my_rank() >= 30
       AND public.role_rank(OLD.role) >= public.my_rank()
       AND NOT (public.is_owner() AND OLD.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'You cannot change an account at or above your own level.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Always keep at least one active owner (legacy admin counts until step 2).
CREATE OR REPLACE FUNCTION public.profiles_keep_an_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.role IN ('owner', 'admin') AND OLD.active AND OLD.deleted_at IS NULL
     AND (TG_OP = 'DELETE'
          OR NEW.role NOT IN ('owner', 'admin') OR NOT NEW.active OR NEW.deleted_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.profiles o
                      WHERE o.id <> OLD.id AND o.role IN ('owner', 'admin')
                        AND o.active AND o.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'There must always be at least one active owner.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS profiles_keep_an_owner ON public.profiles;
CREATE TRIGGER profiles_keep_an_owner
  BEFORE UPDATE OF role, active, deleted_at OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_keep_an_owner();

-- ---------------------------------------------------------------------------
-- 5. Audit triggers (append-only role_audit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.role_audit_profiles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_audit (actor_id, actor_role, target_id, centre_id, action, after)
    VALUES (auth.uid(), public.my_role(), NEW.id, NEW.centre_id, 'create',
            jsonb_build_object('role', NEW.role, 'centre_id', NEW.centre_id, 'active', NEW.active));
  ELSIF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.centre_id IS DISTINCT FROM OLD.centre_id
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    INSERT INTO public.role_audit (actor_id, actor_role, target_id, centre_id, action, before, after)
    VALUES (auth.uid(), public.my_role(), NEW.id, COALESCE(NEW.centre_id, OLD.centre_id),
            CASE WHEN NEW.role IS DISTINCT FROM OLD.role THEN 'role_change'
                 WHEN NEW.centre_id IS DISTINCT FROM OLD.centre_id THEN 'transfer'
                 WHEN NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
                   CASE WHEN NEW.deleted_at IS NULL THEN 'restore' ELSE 'delete' END
                 WHEN NEW.active THEN 'activate' ELSE 'deactivate' END,
            jsonb_build_object('role', OLD.role, 'centre_id', OLD.centre_id, 'active', OLD.active, 'deleted_at', OLD.deleted_at),
            jsonb_build_object('role', NEW.role, 'centre_id', NEW.centre_id, 'active', NEW.active, 'deleted_at', NEW.deleted_at));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS role_audit_profiles ON public.profiles;
CREATE TRIGGER role_audit_profiles AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_profiles();

-- Generic row audit for permission / centre / visibility tables.
CREATE OR REPLACE FUNCTION public.role_audit_row()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := COALESCE(v_new, v_old);
BEGIN
  INSERT INTO public.role_audit (actor_id, actor_role, target_id, centre_id, action, before, after)
  VALUES (auth.uid(), public.my_role(),
          CASE TG_TABLE_NAME
            WHEN 'teacher_permissions' THEN (v_row->>'teacher_id')::uuid
            WHEN 'centre_staff' THEN (v_row->>'profile_id')::uuid
            ELSE NULL END,
          CASE TG_TABLE_NAME
            WHEN 'centres' THEN (v_row->>'id')::uuid
            WHEN 'centre_staff' THEN (v_row->>'centre_id')::uuid
            WHEN 'centre_visibility' THEN (v_row->>'source_centre_id')::uuid
            WHEN 'teacher_permissions' THEN public.profile_centre((v_row->>'teacher_id')::uuid)
            ELSE NULL END,
          TG_TABLE_NAME || '_' || lower(TG_OP), v_old, v_new);
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS role_audit_teacher_permissions ON public.teacher_permissions;
CREATE TRIGGER role_audit_teacher_permissions AFTER INSERT OR UPDATE OR DELETE ON public.teacher_permissions
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_row();
DROP TRIGGER IF EXISTS role_audit_centres ON public.centres;
CREATE TRIGGER role_audit_centres AFTER INSERT OR UPDATE OR DELETE ON public.centres
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_row();
DROP TRIGGER IF EXISTS role_audit_centre_staff ON public.centre_staff;
CREATE TRIGGER role_audit_centre_staff AFTER INSERT OR UPDATE OR DELETE ON public.centre_staff
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_row();
DROP TRIGGER IF EXISTS role_audit_centre_visibility ON public.centre_visibility;
CREATE TRIGGER role_audit_centre_visibility AFTER INSERT OR UPDATE OR DELETE ON public.centre_visibility
  FOR EACH ROW EXECUTE FUNCTION public.role_audit_row();

-- ---------------------------------------------------------------------------
-- 6. The only way to change someone's role or centre
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_person_role(p_target uuid, p_role text, p_centre uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text := public.my_role();
  v_actor_rank integer := public.my_rank();
  v_network    boolean := public.is_network_admin();
  v_t          public.profiles;
  v_centre     uuid;
  v_new_rank   integer := public.role_rank(p_role);
BEGIN
  IF v_actor IS NULL OR v_actor_rank < 50 THEN
    RAISE EXCEPTION 'Only centre heads and above can change roles.';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'director', 'centre_head', 'vice_centre_head', 'teacher', 'student') THEN
    RAISE EXCEPTION 'Unknown role.';
  END IF;
  IF p_target = v_actor THEN
    RAISE EXCEPTION 'You cannot change your own role.';
  END IF;

  SELECT * INTO v_t FROM public.profiles WHERE id = p_target FOR UPDATE;
  IF NOT FOUND OR v_t.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Person not found.';
  END IF;

  -- Rank: strictly above both the current and the new role (owners may manage owners).
  IF NOT (public.role_rank(v_t.role) < v_actor_rank AND v_new_rank < v_actor_rank)
     AND NOT (v_actor_role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'You can only give or change roles below your own level.';
  END IF;

  -- Centre: network roles have none; everyone else needs one.
  IF p_role IN ('owner', 'director') THEN
    v_centre := NULL;
  ELSE
    v_centre := COALESCE(p_centre, v_t.centre_id, CASE WHEN NOT v_network THEN public.my_centre() END);
    IF v_centre IS NULL THEN
      RAISE EXCEPTION 'Choose a centre for this person.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.centres WHERE id = v_centre AND status = 'active') THEN
      RAISE EXCEPTION 'That centre is not active.';
    END IF;
  END IF;

  -- Scope: centre staff act only inside their own centre and cannot transfer.
  IF NOT v_network THEN
    IF v_t.centre_id IS DISTINCT FROM public.my_centre() OR v_centre IS DISTINCT FROM public.my_centre() THEN
      RAISE EXCEPTION 'You can only manage people in your own centre.';
    END IF;
  END IF;

  IF p_role = 'centre_head' AND EXISTS (
       SELECT 1 FROM public.centre_staff s
        WHERE s.centre_id = v_centre AND s.role = 'centre_head' AND s.ended_at IS NULL
          AND s.profile_id <> p_target) THEN
    RAISE EXCEPTION 'This centre already has a head. Change the current head first.';
  END IF;

  -- End any current staff post that no longer matches.
  UPDATE public.centre_staff
     SET ended_at = now(), ended_by = v_actor
   WHERE profile_id = p_target AND ended_at IS NULL
     AND (role IS DISTINCT FROM p_role OR centre_id IS DISTINCT FROM v_centre);

  INSERT INTO public.role_change_tickets (target_id, tx, role, centre_id)
  VALUES (p_target, txid_current(), p_role, v_centre)
  ON CONFLICT (target_id, tx) DO UPDATE SET role = EXCLUDED.role, centre_id = EXCLUDED.centre_id;
  UPDATE public.profiles
     SET role = p_role,
         centre_id = v_centre,
         level = CASE WHEN p_role = 'student' THEN
                        CASE WHEN level IN ('Teacher', 'Admin') THEN NULL ELSE level END
                      WHEN p_role = 'teacher' THEN 'Teacher'
                      ELSE 'Admin' END
   WHERE id = p_target;
  DELETE FROM public.role_change_tickets WHERE target_id = p_target AND tx = txid_current();

  IF p_role IN ('centre_head', 'vice_centre_head') AND NOT EXISTS (
       SELECT 1 FROM public.centre_staff
        WHERE profile_id = p_target AND ended_at IS NULL AND role = p_role AND centre_id = v_centre) THEN
    INSERT INTO public.centre_staff (centre_id, profile_id, role, assigned_by)
    VALUES (v_centre, p_target, p_role, v_actor);
  END IF;

  RETURN jsonb_build_object('id', p_target, 'role', p_role, 'centre_id', v_centre);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Row level security on the new tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.centres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.centre_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.centre_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_audit ENABLE ROW LEVEL SECURITY;

-- Centre names and codes are not private (shown next to duel opponents).
DROP POLICY IF EXISTS centres_read ON public.centres;
CREATE POLICY centres_read ON public.centres FOR SELECT TO authenticated
  USING (status <> 'archived' OR public.is_network_admin());
DROP POLICY IF EXISTS centres_network_write ON public.centres;
CREATE POLICY centres_network_write ON public.centres FOR ALL TO authenticated
  USING (public.is_network_admin()) WITH CHECK (public.is_network_admin());

DROP POLICY IF EXISTS centre_staff_read ON public.centre_staff;
CREATE POLICY centre_staff_read ON public.centre_staff FOR SELECT TO authenticated
  USING (public.is_centre_admin(centre_id));
-- No write policy: staff posts change only through set_person_role().

DROP POLICY IF EXISTS centre_visibility_read ON public.centre_visibility;
CREATE POLICY centre_visibility_read ON public.centre_visibility FOR SELECT TO authenticated
  USING (public.is_network_admin() OR public.is_centre_admin(source_centre_id)
         OR (viewer_centre_id IS NOT NULL AND public.is_centre_admin(viewer_centre_id)));
DROP POLICY IF EXISTS centre_visibility_network_write ON public.centre_visibility;
CREATE POLICY centre_visibility_network_write ON public.centre_visibility FOR ALL TO authenticated
  USING (public.is_network_admin()) WITH CHECK (public.is_network_admin());

DROP POLICY IF EXISTS role_audit_read ON public.role_audit;
CREATE POLICY role_audit_read ON public.role_audit FOR SELECT TO authenticated
  USING (public.is_network_admin() OR (centre_id IS NOT NULL AND public.is_centre_head(centre_id)));
-- No insert / update / delete policy: written only by the SECURITY DEFINER triggers.

GRANT SELECT ON public.centres, public.centre_staff, public.centre_visibility, public.role_audit TO authenticated;
GRANT INSERT, UPDATE ON public.centres, public.centre_visibility TO authenticated;
GRANT DELETE ON public.centre_visibility TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.centre_visibility_id_seq TO authenticated;
REVOKE ALL ON public.centres, public.centre_staff, public.centre_visibility, public.role_audit FROM anon;
GRANT ALL ON public.centres, public.centre_staff, public.centre_visibility, public.role_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.role_audit_id_seq, public.centre_staff_id_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Function grants: signed-in users only; never anon
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.role_rank(text), public.my_role(), public.my_rank(), public.my_centre(),
  public.is_network_admin(), public.is_owner(), public.is_centre_admin(uuid), public.is_centre_head(uuid),
  public.profile_centre(uuid), public.can_manage_profile(uuid), public.set_person_role(uuid, text, uuid),
  public.profiles_keep_an_owner(), public.role_audit_profiles(), public.role_audit_row()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.role_rank(text), public.my_role(), public.my_rank(), public.my_centre(),
  public.is_network_admin(), public.is_owner(), public.is_centre_admin(uuid), public.is_centre_head(uuid),
  public.profile_centre(uuid), public.can_manage_profile(uuid), public.set_person_role(uuid, text, uuid)
  TO authenticated, service_role;
-- is_admin() stays executable by everyone: RLS policies written TO public call
-- it, and it simply returns false for anon.

-- Staff-only RPCs have no business being callable without signing in.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f'
              AND (p.proname LIKE 'admin\_%' OR p.proname LIKE 'teacher\_%')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.fn);
  END LOOP;
END $$;
