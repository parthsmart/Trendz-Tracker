-- Security hotfix: stop report helper functions leaking student data to anyone.
--
-- These SECURITY DEFINER functions have no caller check, and Supabase's default
-- privileges let `anon` and `authenticated` execute them through /rest/v1/rpc.
-- Anyone holding the public anon key could read every student's name, code,
-- level, accuracy, streak and points (weekly_report_data), or one student's
-- full round history (mirror_student_data).
--
-- Only the service-role API (api/weekly-report.js, api/backup.js) calls them
-- directly. Every other caller is itself a SECURITY DEFINER function owned
-- by postgres (leaderboard, admin_milestones, student_month_report,
-- weekly_report_data), so the nested calls run as postgres and keep working.
-- The API already falls back to admin-checked RPCs when the service role is
-- unavailable.
--
-- Rollback: supabase/rollbacks/29_revoke_public_report_rpcs_rollback.sql

REVOKE EXECUTE ON FUNCTION public.weekly_report_data()                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mirror_student_data(uuid)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mirror_fingerprints()                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.milestones_recent(integer)              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.practice_stats_for(uuid, date, date)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.practice_days_for(uuid, date, date)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.points_for(uuid, date, date)            FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.weekly_report_data()                     TO service_role;
GRANT EXECUTE ON FUNCTION public.mirror_student_data(uuid)                TO service_role;
GRANT EXECUTE ON FUNCTION public.mirror_fingerprints()                    TO service_role;
GRANT EXECUTE ON FUNCTION public.milestones_recent(integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.practice_stats_for(uuid, date, date)     TO service_role;
GRANT EXECUTE ON FUNCTION public.practice_days_for(uuid, date, date)      TO service_role;
GRANT EXECUTE ON FUNCTION public.points_for(uuid, date, date)             TO service_role;

-- Not-signed-in visitors have no reason to call these either.
REVOKE EXECUTE ON FUNCTION public.weekly_test_check(uuid, uuid, uuid)     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.student_level(uuid)                     FROM PUBLIC, anon;
