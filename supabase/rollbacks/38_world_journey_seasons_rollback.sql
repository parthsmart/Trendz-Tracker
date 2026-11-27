-- Rollback for 38_world_journey_seasons.sql (keeps all data; only removes the new layer).
-- After running this, re-apply the xp_settle_seasons / xp_season_live / xp_totals / my_xp_summary
-- definitions from 27/28 and leaderboard() from 37 to restore monthly seasons.
DROP FUNCTION IF EXISTS public.journey_levelup_review(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.journey_staff_board(text);
DROP FUNCTION IF EXISTS public.journey_finish_session(uuid, uuid, jsonb, integer, integer, numeric, boolean, jsonb);
DROP FUNCTION IF EXISTS public.journey_boss_check(uuid);
DROP FUNCTION IF EXISTS public.set_my_mascot(text, text);
DROP FUNCTION IF EXISTS public.my_world(uuid);
DROP FUNCTION IF EXISTS public.journey_progress_for(uuid);
DROP FUNCTION IF EXISTS public.season_board(text, uuid, integer);
DROP FUNCTION IF EXISTS public.season_cancel(bigint);
DROP FUNCTION IF EXISTS public.season_save(text, text, date, text, integer);
DROP FUNCTION IF EXISTS public.season_list();
-- Tables are left in place (no data dropped). season_bounds() is still referenced by the patched
-- leaderboard() until leaderboard is re-applied, so drop it only after that:
-- DROP FUNCTION IF EXISTS public.season_bounds(date);
