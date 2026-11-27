-- Rollback for 30_multi_centre_schema.sql.
--
-- Only safe BEFORE step 2 (31_*) runs: once people hold the new roles
-- (owner, director, centre_head, ...) the old role check would reject them.
-- Run step 2's rollback first. Drops centre_id from profiles, so take a
-- backup first. Keeps the anon revokes on admin_* / teacher_* functions
-- (they never needed anon, and re-granting would only widen access).

DROP TRIGGER IF EXISTS profiles_keep_an_owner ON public.profiles;
DROP TRIGGER IF EXISTS role_audit_profiles ON public.profiles;
DROP TRIGGER IF EXISTS role_audit_teacher_permissions ON public.teacher_permissions;

DROP FUNCTION IF EXISTS public.set_person_role(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.can_manage_profile(uuid);
DROP FUNCTION IF EXISTS public.profile_centre(uuid);

-- Restore the guard and is_admin() exactly as they were before.
CREATE OR REPLACE FUNCTION public.profiles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.student_code IS DISTINCT FROM OLD.student_code THEN
      RAISE EXCEPTION 'The student ID is the login name and cannot be changed here.';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'The role cannot be changed from the site.';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT COALESCE(
    (SELECT role = 'admin' AND active = true
     FROM public.profiles
     WHERE id = auth.uid()),
    false
  );
$function$;

DROP TABLE IF EXISTS public.role_change_tickets;
DROP TABLE IF EXISTS public.role_audit;
DROP TABLE IF EXISTS public.centre_visibility;
DROP TABLE IF EXISTS public.centre_staff;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS centre_id;
DROP TABLE IF EXISTS public.centres;

DROP FUNCTION IF EXISTS public.is_centre_head(uuid);
DROP FUNCTION IF EXISTS public.is_centre_admin(uuid);
DROP FUNCTION IF EXISTS public.is_owner();
DROP FUNCTION IF EXISTS public.is_network_admin();
DROP FUNCTION IF EXISTS public.my_centre();
DROP FUNCTION IF EXISTS public.my_rank();
DROP FUNCTION IF EXISTS public.my_role();
DROP FUNCTION IF EXISTS public.role_rank(text);
DROP FUNCTION IF EXISTS public.role_audit_row();
DROP FUNCTION IF EXISTS public.role_audit_profiles();
DROP FUNCTION IF EXISTS public.profiles_keep_an_owner();

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('student', 'teacher', 'admin'));
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_level_allowed;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_level_allowed CHECK (
  level IS NULL
  OR public.is_standard_student_level(level)
  OR (role = 'teacher' AND level = 'Teacher')
  OR (role = 'admin' AND level = 'Admin'));
