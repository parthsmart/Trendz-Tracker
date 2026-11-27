-- Phase 28: one meaning per word
--   Level  = the class level a trainer sets (e.g. "Master", "Level 1").
--   Tier   = the monthly season tier (Bronze ... Legend).
--   League = the weekly arena league (Sprout ... Galaxy).
--   Rank   = a position on a board (#2).
-- The season tier "Master" clashed with the "Master" class level, so it becomes "Elite".
-- Badge keys stay the same, so badges already earned keep working.

CREATE OR REPLACE FUNCTION public.xp_season_tier(p_xp bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH t(name, floor_xp, ord) AS (
    VALUES ('Bronze', 0, 1), ('Silver', 300, 2), ('Gold', 1000, 3),
           ('Platinum', 2500, 4), ('Diamond', 5000, 5), ('Elite', 9000, 6), ('Legend', 15000, 7)
  ),
  cur AS (SELECT * FROM t WHERE floor_xp <= GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp DESC LIMIT 1),
  nxt AS (SELECT * FROM t WHERE floor_xp > GREATEST(COALESCE(p_xp, 0), 0) ORDER BY floor_xp ASC LIMIT 1)
  SELECT jsonb_build_object(
    'name', cur.name, 'floor', cur.floor_xp, 'rank', cur.ord,
    'next_name', nxt.name, 'next_floor', nxt.floor_xp
  )
  FROM cur LEFT JOIN nxt ON true;
$function$;

-- Lifetime tiers are no longer shown, but keep the names consistent for anything still calling it.
CREATE OR REPLACE FUNCTION public.xp_tier(p_total bigint)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  WITH t(name, floor_xp, ord) AS (
    VALUES ('Bronze', 0, 1), ('Silver', 1000, 2), ('Gold', 3000, 3),
           ('Platinum', 7500, 4), ('Diamond', 15000, 5), ('Elite', 30000, 6), ('Legend', 75000, 7)
  ),
  cur AS (SELECT * FROM t WHERE floor_xp <= GREATEST(COALESCE(p_total, 0), 0) ORDER BY floor_xp DESC LIMIT 1),
  nxt AS (SELECT * FROM t WHERE floor_xp > GREATEST(COALESCE(p_total, 0), 0) ORDER BY floor_xp ASC LIMIT 1)
  SELECT jsonb_build_object(
    'name', cur.name, 'floor', cur.floor_xp, 'rank', cur.ord,
    'next_name', nxt.name, 'next_floor', nxt.floor_xp
  )
  FROM cur LEFT JOIN nxt ON true;
$function$;

UPDATE public.xp_season_results SET tier = 'Elite' WHERE tier = 'Master';

UPDATE public.badge_catalogue SET name = v.n, description = COALESCE(v.d, badge_catalogue.description)
  FROM (VALUES
    ('tier_silver', 'Silver tier', 'Reach the Silver tier in a season (300 XP in one month).'),
    ('tier_gold', 'Gold tier', 'Reach the Gold tier in a season (1,000 XP in one month).'),
    ('tier_platinum', 'Platinum tier', 'Reach the Platinum tier in a season (2,500 XP in one month).'),
    ('tier_diamond', 'Diamond tier', 'Reach the Diamond tier in a season (5,000 XP in one month).'),
    ('tier_master', 'Elite tier', 'Reach the Elite tier in a season (9,000 XP in one month).'),
    ('tier_legend', 'Legend tier', 'Reach the Legend tier in a season (15,000 XP in one month).'),
    ('challenge_30', 'Challenge pro', NULL)
  ) AS v(k, n, d)
 WHERE key = v.k;
