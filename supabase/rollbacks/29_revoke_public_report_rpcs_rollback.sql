-- Rollback for 29_revoke_public_report_rpcs.sql: restores the previous (leaky) grants.
-- Only use this if something essential broke; it re-opens the data leak.

GRANT EXECUTE ON FUNCTION public.weekly_report_data()                     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mirror_student_data(uuid)                TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mirror_fingerprints()                    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.milestones_recent(integer)               TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.practice_stats_for(uuid, date, date)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.practice_days_for(uuid, date, date)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.points_for(uuid, date, date)             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_test_check(uuid, uuid, uuid)      TO anon;
GRANT EXECUTE ON FUNCTION public.student_level(uuid)                      TO anon;
