-- Rollback for 33_centres_guard.sql. Removes the trigger and its function.
-- No data is changed.
DROP TRIGGER IF EXISTS centres_guard ON public.centres;
DROP FUNCTION IF EXISTS public.centres_guard();
