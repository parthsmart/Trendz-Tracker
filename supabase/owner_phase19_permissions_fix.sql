-- ==============================================================================
-- Trendz Tracker — Owner Phase 19: Anon Function Execution Revocations
-- File: supabase/owner_phase19_permissions_fix.sql
--
-- EXECUTION INSTRUCTIONS:
-- Run in Supabase SQL Editor as database owner (postgres) on staging and production.
--
-- PURPOSE:
-- Revokes explicit anon EXECUTE grants on Phase 19 RPCs while strictly preserving
-- authenticated and service_role execution rights.
--
-- RATIONALE:
-- In PostgreSQL / Supabase, REVOKE ALL ON FUNCTION ... FROM PUBLIC does not revoke
-- explicit grants made directly to the 'anon' role. These statements explicitly
-- revoke permissions from both PUBLIC and anon.
-- ==============================================================================

BEGIN;

-- 1. Daily Task Management RPC
REVOKE ALL ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_daily_task_atomic(UUID, JSONB, UUID[]) TO authenticated, service_role;

-- 2. Flash Anzan Live Practice RPCs
REVOKE ALL ON FUNCTION public.flash_start(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_start(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.flash_submit(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flash_submit(uuid, jsonb) TO authenticated, service_role;

-- 3. Daily To-do Status RPC
REVOKE ALL ON FUNCTION public.todo_status_on(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.todo_status_on(UUID, DATE) TO authenticated, service_role;

COMMIT;

-- ------------------------------------------------------------------------------
-- Verification Query (Read-Only)
-- Run after committing to confirm anon EXECUTE is false and authenticated/service_role is true:
-- ------------------------------------------------------------------------------
-- SELECT p.proname AS function_name,
--        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
--        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('save_daily_task_atomic', 'flash_start', 'flash_submit', 'todo_status_on')
-- ORDER BY p.proname;
