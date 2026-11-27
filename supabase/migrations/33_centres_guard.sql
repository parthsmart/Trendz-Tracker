-- Multi-centre step 3: safety rules for editing centres from the owner panel.
--
-- Owners and directors can create and edit centres directly (RLS from
-- migration 30). This trigger stops the edits that would break the site:
--
--   * The default centre (Baran Centre) cannot be suspended, archived or lose
--     its default flag. New students land in it, so it must stay active.
--   * Nobody can make another centre the default from the site.
--   * A centre cannot be archived while it still has people or an open
--     head / vice head post. Move them first.
--   * created_by, archived_at and archived_by are filled in by the database.
--
-- No data changes. Rollback: supabase/rollbacks/33_centres_guard_rollback.sql

CREATE OR REPLACE FUNCTION public.centres_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Migrations and the service role (no signed-in user) are not limited.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_default THEN
      RAISE EXCEPTION 'A new centre cannot be the default centre.';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'A new centre must start active.';
    END IF;
    NEW.created_by := auth.uid();
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.is_default IS DISTINCT FROM OLD.is_default THEN
    RAISE EXCEPTION 'The default centre cannot be changed from the site.';
  END IF;
  IF OLD.is_default AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'The default centre must stay active: new students are added to it.';
  END IF;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;

  IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE centre_id = OLD.id AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Move everyone out of this centre before archiving it.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.centre_staff WHERE centre_id = OLD.id AND ended_at IS NULL) THEN
      RAISE EXCEPTION 'End the head and vice head posts before archiving this centre.';
    END IF;
    NEW.archived_at := now();
    NEW.archived_by := auth.uid();
  ELSIF NEW.status <> 'archived' THEN
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
  ELSE
    NEW.archived_at := OLD.archived_at;
    NEW.archived_by := OLD.archived_by;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.centres_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS centres_guard ON public.centres;
CREATE TRIGGER centres_guard BEFORE INSERT OR UPDATE ON public.centres
  FOR EACH ROW EXECUTE FUNCTION public.centres_guard();
