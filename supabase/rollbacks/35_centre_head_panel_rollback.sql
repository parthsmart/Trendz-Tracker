-- Rollback for migration 35 (centre head panel). Drops only the new functions;
-- no data was changed by the migration. Audit rows it wrote stay.
DROP FUNCTION IF EXISTS public.centre_backup(uuid);
DROP FUNCTION IF EXISTS public.centre_update_settings(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.centre_update_teacher_permissions(uuid, jsonb);
DROP FUNCTION IF EXISTS public.centre_set_teacher_assignments(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.centre_restore(uuid);
DROP FUNCTION IF EXISTS public.centre_soft_delete(uuid);
DROP FUNCTION IF EXISTS public.centre_set_active(uuid, boolean);
DROP FUNCTION IF EXISTS public.centre_update_person(uuid, text, text);
DROP FUNCTION IF EXISTS public.centre_panel(uuid);
DROP FUNCTION IF EXISTS public.centre_panel_person(uuid, boolean, text[]);
DROP FUNCTION IF EXISTS public.centre_panel_centre(uuid, boolean);
