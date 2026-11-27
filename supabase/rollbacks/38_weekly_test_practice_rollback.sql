-- Rollback for migration 38 (weekly test practice). Drops the practice
-- functions and tables. Official weekly test data is untouched; practice runs
-- are lost.
DROP FUNCTION IF EXISTS public.weekly_test_practice_review(uuid);
DROP FUNCTION IF EXISTS public.weekly_test_practice_standing(uuid, uuid);
DROP FUNCTION IF EXISTS public.my_weekly_test_practice(uuid);
DROP FUNCTION IF EXISTS public.weekly_test_section_points(integer, integer);
DROP FUNCTION IF EXISTS public.weekly_test_practice_rollback(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.weekly_test_practice_reserve(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.weekly_test_practice_begin(uuid, uuid);
DROP FUNCTION IF EXISTS public.weekly_test_practice_block_reason(uuid, uuid);
DROP TABLE IF EXISTS public.weekly_test_practice_attempts;
DROP TABLE IF EXISTS public.weekly_test_practice_runs;
