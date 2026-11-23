-- ==============================================================================
-- Rollback Migration 17: Webinar.gg Live Classes Feature Rollback
-- Phase 20 — Trendz Tracker
-- File: supabase/migrations/17_phase20_live_classes_feature_rollback.sql
--
-- IMPORTANT SAFETY NOTICE:
-- This rollback script STRICTLY PRESERVES all existing records in public.live_classes.
-- It NEVER drops the table, truncates data, or drops columns. All webinar mappings,
-- scheduled/past sessions, host associations, and class records remain intact.
--
-- Actions performed:
-- 1. Drops the database boundary trigger and function:
--    - trg_live_classes_admin_only_fields
--    - enforce_live_class_admin_only_fields()
-- 2. Drops the security definer RPC:
--    - get_eligible_live_classes_for_student(UUID)
-- 3. Drops feature-specific RLS policies:
--    - "Students can view eligible live_classes"
--    - "Teachers can view assigned live_classes"
-- 4. Preserves table public.live_classes, all columns (host_email, invited_teacher_ids),
--    indexes, and Admin access policy to ensure data safety and prevent unauthorized access.
-- ==============================================================================

-- 1. Drop Database Boundary Trigger and Function
DROP TRIGGER IF EXISTS trg_live_classes_admin_only_fields ON public.live_classes;
DROP FUNCTION IF EXISTS public.enforce_live_class_admin_only_fields();

-- 2. Drop Security Definer RPC Function
DROP FUNCTION IF EXISTS public.get_eligible_live_classes_for_student(UUID);

-- 3. Drop Feature-Specific RLS Policies (Student and Teacher Access)
DROP POLICY IF EXISTS "Students can view eligible live_classes" ON public.live_classes;
DROP POLICY IF EXISTS "Teachers can view assigned live_classes" ON public.live_classes;
DROP POLICY IF EXISTS "Teachers can update own live_classes" ON public.live_classes;

-- 4. Preserve Table & Ensure Data Security
-- NOTE: We intentionally DO NOT execute:
--   DROP TABLE public.live_classes;
--   TRUNCATE TABLE public.live_classes;
--   ALTER TABLE public.live_classes DROP COLUMN host_email;
--   ALTER TABLE public.live_classes DROP COLUMN invited_teacher_ids;
--
-- All existing class rows, host emails, webinar IDs, and participant metadata are PRESERVED.
--
-- Ensure admin access policy remains active so administrators and service role retain full management
-- while keeping the table inaccessible to unauthenticated or unauthorized users.
ALTER TABLE public.live_classes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins have full access to live_classes" ON public.live_classes;
CREATE POLICY "Admins have full access to live_classes"
  ON public.live_classes
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'admin' AND p.active = true
    )
  );

-- Retain explicit minimum table privileges for authenticated and service_role
REVOKE ALL ON TABLE public.live_classes FROM PUBLIC;
REVOKE ALL ON TABLE public.live_classes FROM anon;
REVOKE ALL ON TABLE public.live_classes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_classes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.live_classes TO service_role;
