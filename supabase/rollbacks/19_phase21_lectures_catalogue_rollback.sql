-- =====================================================================
-- Rollback 19: Phase 21 Resources Lectures Catalogue
-- File: supabase/rollbacks/19_phase21_lectures_catalogue_rollback.sql
-- =====================================================================

DROP TABLE IF EXISTS public.lectures CASCADE;
DROP TABLE IF EXISTS public.lecture_categories CASCADE;
DROP FUNCTION IF EXISTS public.has_jmcwc_lecture_assignment();
