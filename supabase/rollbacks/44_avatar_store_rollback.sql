-- Rollback for migration 44 (avatar & store). Removes the avatar store functions and
-- puts avatar_visible() back to its migration 24 version, so every page shows photos
-- again. The data tables (coins ledger, owned items, style, cards, chest claims and
-- catalogues) are kept, so nothing a student earned is lost; drop them by hand only
-- after a backup if they are truly no longer wanted.
CREATE OR REPLACE FUNCTION public.avatar_visible(p_student uuid, p_path text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_path IS NULL OR auth.uid() IS NULL THEN NULL
    WHEN p_student = auth.uid() OR public.is_admin() OR public.is_teacher(auth.uid()) THEN p_path
    WHEN (SELECT r.leaderboard_names FROM public.competition_rules() r) = 'student_code' THEN NULL
    ELSE p_path
  END;
$function$;

DROP FUNCTION IF EXISTS public.avatar_store_state(uuid);
DROP FUNCTION IF EXISTS public.chest_claim(text, text);
DROP FUNCTION IF EXISTS public.chest_claim_json(public.chest_claims, boolean);
DROP FUNCTION IF EXISTS public.chest_roll_rarity(jsonb);
DROP FUNCTION IF EXISTS public.chest_status(uuid);
DROP FUNCTION IF EXISTS public.chest_odds();
DROP FUNCTION IF EXISTS public.weekly_quests(uuid, date);
DROP FUNCTION IF EXISTS public.ist_week_start(date);
DROP FUNCTION IF EXISTS public.my_avatar(uuid);
DROP FUNCTION IF EXISTS public.profile_style_save(text, text, text, text[]);
DROP FUNCTION IF EXISTS public.titles_unlocked(uuid);
DROP FUNCTION IF EXISTS public.avatar_save(jsonb, text);
DROP FUNCTION IF EXISTS public.avatar_look_token(uuid, jsonb);
DROP FUNCTION IF EXISTS public.avatar_buy(text);
DROP FUNCTION IF EXISTS public.avatar_item_owned(uuid, text);
DROP FUNCTION IF EXISTS public.coin_lock_student(uuid);
