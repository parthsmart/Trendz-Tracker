-- =============================================================================
-- Trendz Tracker — Phase 17a: JMCWC Read-Only Verification & Blueprint Governance SQL
-- =============================================================================
-- NOTE FOR OWNER:
-- 1. All 7 JMCWC tables (`jmcwc_categories`, `jmcwc_papers`, `jmcwc_assignments`,
--    `jmcwc_targets`, `jmcwc_attempts`, `jmcwc_payloads`, `jmcwc_scores`) and all 6
--    JMCWC RPCs (`jmcwc_check_student`, `jmcwc_create_attempt`, `jmcwc_act`,
--    `jmcwc_tick`, `jmcwc_finalize`, `jmcwc_list`) have been verified in your
--    Supabase Mumbai database (`https://kgzivhavpsvitwrscrrj.supabase.co`).
-- 2. Per the Phase 17a governance rule ("Do not produce published blueprint SQL
--    from unread or unresolved sources"), NO `published = true` paper SQL is emitted
--    until `JMCWC-2026-Simulator-Juniors-1.xlsx`, `JMCWC-2026-Simulator-Juniors-2.xlsx`,
--    `JMCWC-2026-Simulator-Seniors.xlsx`, and `JMCWC Rules 2025.pdf` are attached and
--    their cell-by-cell formulas and broken references (`Int Mults H7/H12`,
--    `Brackets B43`, `Fraction Multiplications BD229`, `Cube Roots - Exact S51`)
--    are verified.
-- =============================================================================

-- 1. Read-Only Schema, Category, RPC & RLS Verification Query
SELECT
  'tables' AS check_group,
  c.relname AS object_name,
  CASE WHEN c.relrowsecurity THEN 'RLS enabled' ELSE 'RLS disabled' END AS status_detail
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname LIKE 'jmcwc_%'
UNION ALL
SELECT
  'rpcs' AS check_group,
  p.proname AS object_name,
  pg_get_function_identity_arguments(p.oid) AS status_detail
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'jmcwc_%'
UNION ALL
SELECT
  'categories_count' AS check_group,
  'jmcwc_categories' AS object_name,
  COUNT(*)::text || ' categories seeded' AS status_detail
FROM public.jmcwc_categories
UNION ALL
SELECT
  'published_papers_count' AS check_group,
  'jmcwc_papers' AS object_name,
  COUNT(*) FILTER (WHERE published = true)::text || ' published / ' || COUNT(*)::text || ' total' AS status_detail
FROM public.jmcwc_papers
ORDER BY check_group, object_name;
