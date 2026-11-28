-- Rollback for 40_battle_royale.sql: removes battle royale (games, players, answers,
-- keys and functions). XP already awarded and royale_win badges students earned stay.

DROP FUNCTION IF EXISTS public.royale_leave(uuid);
DROP FUNCTION IF EXISTS public.my_royale();
DROP FUNCTION IF EXISTS public.royale_state(uuid);
DROP FUNCTION IF EXISTS public.royale_answer(uuid, integer, text);
DROP FUNCTION IF EXISTS public.royale_tick(uuid);
DROP FUNCTION IF EXISTS public.royale_settle_round(uuid);
DROP FUNCTION IF EXISTS public.royale_finish(uuid);
DROP FUNCTION IF EXISTS public.royale_place_xp(integer, integer);
DROP FUNCTION IF EXISTS public.royale_out_count(integer, integer);
DROP FUNCTION IF EXISTS public.royale_next_slot(timestamptz);

DROP TABLE IF EXISTS public.royale_answers;
DROP TABLE IF EXISTS public.royale_players;
DROP TABLE IF EXISTS public.royale_keys;
DROP TABLE IF EXISTS public.royale_games;
