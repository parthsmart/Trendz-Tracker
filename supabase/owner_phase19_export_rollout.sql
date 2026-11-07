-- ==============================================================================
-- Trendz Tracker — Owner Phase 19: Private Rollout Boundary State Export
-- File: supabase/owner_phase19_export_rollout.sql
--
-- EXECUTION INSTRUCTIONS:
-- Run in Supabase SQL Editor as database owner (postgres) or service_role.
--
-- PURPOSE:
-- Privately exports the authoritative deployment rollout state for disaster recovery.
-- Save the exported status and activation timestamp securely alongside your private backup archives.
-- ==============================================================================

-- 1. Tabular query for inspection:
SELECT feature, status, activated_at
FROM public.rollout_boundaries
WHERE feature = 'phase19_authoritative_todo';

-- 2. Structured JSON export for audit / disaster recovery record:
SELECT json_build_object(
  'exported_at', now(),
  'feature', feature,
  'status', status,
  'activated_at', activated_at
) AS private_rollout_state
FROM public.rollout_boundaries
WHERE feature = 'phase19_authoritative_todo';
