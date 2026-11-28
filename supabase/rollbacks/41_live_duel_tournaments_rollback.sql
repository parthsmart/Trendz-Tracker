-- Rollback for 41_live_duel_tournaments.sql.
-- Drops the tournament tables and functions and puts reward_balance() back to the
-- phase 27 version. Badges already given stay. Store balance from reward_credits is
-- dropped with the table, so take a backup first if prizes were given.
-- Tournament live duels stay in live_duels; the kind check keeps 'tournament' so they stay valid.

DROP FUNCTION IF EXISTS public.tournament_cancel(uuid);
DROP FUNCTION IF EXISTS public.tournament_create(text, text, integer, uuid, timestamptz, timestamptz, timestamptz, integer);
DROP FUNCTION IF EXISTS public.tournaments_staff();
DROP FUNCTION IF EXISTS public.tournament_state(uuid);
DROP FUNCTION IF EXISTS public.tournament_leave(uuid);
DROP FUNCTION IF EXISTS public.tournament_join(uuid);
DROP FUNCTION IF EXISTS public.my_tournaments();
DROP FUNCTION IF EXISTS public.tournament_card(public.tournaments, uuid);
DROP FUNCTION IF EXISTS public.tournament_attach_duel(uuid, uuid);
DROP FUNCTION IF EXISTS public.tournament_check_in(uuid, uuid);
DROP FUNCTION IF EXISTS public.tournament_tick(uuid);
DROP FUNCTION IF EXISTS public.tournament_finish_match(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.tournament_award(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.tournament_place(uuid, integer, integer, text, uuid, integer);
DROP FUNCTION IF EXISTS public.tournament_visible(public.tournaments, uuid);
DROP FUNCTION IF EXISTS public.tournament_can_manage(uuid);
DROP FUNCTION IF EXISTS public.tournament_seed_order(integer);
DROP FUNCTION IF EXISTS public.tournament_bracket_size(integer, integer);

DROP TABLE IF EXISTS public.tournament_matches;
DROP TABLE IF EXISTS public.tournament_entries;
DROP TABLE IF EXISTS public.tournaments;

CREATE OR REPLACE FUNCTION public.reward_balance(p_student uuid)
 RETURNS TABLE(earned bigint, spent bigint, balance bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.v, s.v, e.v - s.v
    FROM (SELECT COALESCE(sum(xp), 0)::bigint AS v FROM public.student_xp_events
           WHERE student_id = p_student AND day >= date '2026-11-01') e,
         (SELECT COALESCE(sum(cost), 0)::bigint AS v FROM public.reward_redemptions
           WHERE student_id = p_student AND status IN ('requested', 'given')) s;
$function$;

DROP TABLE IF EXISTS public.reward_credits;
