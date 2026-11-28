-- Rollback for 42_fair_play_guardrails.sql.
-- Removes triggers and functions and restores the board functions. Keeps the review, audit and
-- threshold tables and the fair_play_status columns (no data is dropped); drop them by hand only
-- after exporting them. XP removed by voids stays in fair_play_audit.snapshot.

DROP TRIGGER IF EXISTS trg_fair_play_results_before ON public.results;
DROP TRIGGER IF EXISTS trg_fair_play_results_after ON public.results;
DROP TRIGGER IF EXISTS trg_fair_play_xp_guard ON public.student_xp_events;
DROP TRIGGER IF EXISTS trg_fair_play_session_rate ON public.drill_sessions;
DO $$
BEGIN
  IF to_regclass('public.reward_redemptions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_fair_play_reward_rate ON public.reward_redemptions;
  END IF;
END $$;

-- Undo the board filters.
DO $$
DECLARE
  sig text;
  v_def text;
BEGIN
  FOREACH sig IN ARRAY ARRAY['public.practice_highest_records(text,jsonb)',
                             'public.leaderboard(text,text,text,integer,text)'] LOOP
    IF to_regprocedure(sig) IS NULL THEN CONTINUE; END IF;
    v_def := pg_get_functiondef(to_regprocedure(sig));
    IF position('fair_play_status' IN v_def) = 0 THEN CONTINUE; END IF;
    v_def := replace(v_def,
      '(SELECT * FROM public.results WHERE fair_play_status IS DISTINCT FROM ''voided'' AND (fair_play_status IS DISTINCT FROM ''review'' OR student_id = auth.uid()))',
      'public.results');
    v_def := replace(v_def,
      '(SELECT * FROM public.activity_results WHERE fair_play_status IS DISTINCT FROM ''voided'' AND (fair_play_status IS DISTINCT FROM ''review'' OR student_id = auth.uid()))',
      'public.activity_results');
    EXECUTE v_def;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.fair_play_patch_function(text);
DROP FUNCTION IF EXISTS public.fair_play_results_before();
DROP FUNCTION IF EXISTS public.fair_play_results_after();
DROP FUNCTION IF EXISTS public.fair_play_xp_guard();
DROP FUNCTION IF EXISTS public.fair_play_session_rate();
DROP FUNCTION IF EXISTS public.fair_play_reward_rate();
DROP FUNCTION IF EXISTS public.fair_play_queue(text, integer);
DROP FUNCTION IF EXISTS public.fair_play_decide(bigint, text, text);
DROP FUNCTION IF EXISTS public.fair_play_history(bigint);
DROP FUNCTION IF EXISTS public.my_fair_play_reviews();
DROP FUNCTION IF EXISTS public.fair_play_threshold_save(text, text, text, numeric, numeric, integer, boolean, text);
DROP FUNCTION IF EXISTS public.fair_play_open_review(uuid, text, uuid, text, text, text, text[], jsonb);
DROP FUNCTION IF EXISTS public.fair_play_typed_reasons(text, integer, integer, numeric);
DROP FUNCTION IF EXISTS public.fair_play_threshold(text, text, text);
DROP FUNCTION IF EXISTS public.fair_play_can_review(uuid);
DROP FUNCTION IF EXISTS public.fair_play_rate_hit(uuid, text, integer, integer);
