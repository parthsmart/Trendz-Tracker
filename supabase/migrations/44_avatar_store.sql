-- =============================================================================
-- Phase 44: avatar & store - coins, avatar items, profile style, titles,
-- mathematician cards and practice chests.
--
--   * Coins are a new currency, separate from the XP reward shop (which is unchanged).
--     Balance = 1 coin per 10 XP earned from practice since coin_start_date()
--             + the sum of student_coin_ledger (chest coins, duplicate cards, purchases).
--     Every ledger row is unique per (student, ref), so a grant or a purchase can only
--     happen once, and a trigger refuses any row that would leave the balance below 0.
--   * Avatar items, name colours and banners are bought with coins. Skin tones, the
--     starter styles, and hijab / turban / patka are free.
--   * Titles are earned from achievements and can never be bought.
--   * Chests: daily (after the first practice round of the day, India time), weekly
--     (after all 3 weekly quests) and level-up (each new season tier, once per season).
--     Contents are rolled here, saved once per (student, kind, period) and returned
--     unchanged on any repeat claim. Odds are published by chest_odds().
--   * avatar_visible() now returns a 'look:' token when the student shows their avatar,
--     so every existing page that shows photos shows avatars with no other change.
--   * Students cannot write to any new table directly; only the RPCs below can.
--   * No real money anywhere.
--
-- Rollback: supabase/rollbacks/44_avatar_store_rollback.sql (keeps the data tables).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Catalogues
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.avatar_items (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z0-9_]+$'),
  slot text NOT NULL CHECK (slot IN ('hair', 'hair_color', 'outfit', 'outfit_color', 'headwear', 'headwear_color',
                                     'accessory', 'background', 'frame', 'name_color', 'banner')),
  name text NOT NULL,
  cost integer NOT NULL DEFAULT 0 CHECK (cost >= 0 AND cost <= 100000),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  CHECK (split_part(key, '.', 1) = slot)
);

INSERT INTO public.avatar_items (key, slot, name, cost, sort_order) VALUES
  ('hair.short', 'hair', 'Short', 0, 1), ('hair.curly', 'hair', 'Curly', 0, 2), ('hair.fringe', 'hair', 'Fringe', 0, 3),
  ('hair.bun', 'hair', 'Top bun', 0, 4), ('hair.buzz', 'hair', 'Buzz cut', 0, 5),
  ('hair.spiky', 'hair', 'Spiky', 60, 10), ('hair.ponytail', 'hair', 'Ponytail', 60, 11), ('hair.long', 'hair', 'Long', 80, 12),
  ('hair.afro', 'hair', 'Afro', 80, 13), ('hair.braids', 'hair', 'Braids', 90, 14),
  ('hair_color.black', 'hair_color', 'Black', 0, 1), ('hair_color.darkbrown', 'hair_color', 'Dark brown', 0, 2),
  ('hair_color.brown', 'hair_color', 'Brown', 0, 3), ('hair_color.auburn', 'hair_color', 'Auburn', 0, 4),
  ('hair_color.blonde', 'hair_color', 'Blonde', 0, 5), ('hair_color.grey', 'hair_color', 'Grey', 0, 6),
  ('hair_color.blue', 'hair_color', 'Blue', 120, 10), ('hair_color.pink', 'hair_color', 'Pink', 120, 11),
  ('hair_color.purple', 'hair_color', 'Purple', 120, 12), ('hair_color.green', 'hair_color', 'Green', 120, 13),
  ('outfit.tee', 'outfit', 'T-shirt', 0, 1), ('outfit.kurta', 'outfit', 'Kurta', 0, 2),
  ('outfit.hoodie', 'outfit', 'Hoodie', 80, 10), ('outfit.blazer', 'outfit', 'School blazer', 100, 11),
  ('outfit.jersey', 'outfit', 'Sports jersey', 100, 12), ('outfit.labcoat', 'outfit', 'Lab coat', 150, 13),
  ('outfit.cape', 'outfit', 'Hero cape', 250, 14),
  ('outfit_color.blue', 'outfit_color', 'Blue', 0, 1), ('outfit_color.navy', 'outfit_color', 'Navy', 0, 2),
  ('outfit_color.green', 'outfit_color', 'Green', 0, 3), ('outfit_color.red', 'outfit_color', 'Red', 0, 4),
  ('outfit_color.orange', 'outfit_color', 'Orange', 40, 10), ('outfit_color.purple', 'outfit_color', 'Purple', 40, 11),
  ('outfit_color.pink', 'outfit_color', 'Pink', 40, 12), ('outfit_color.yellow', 'outfit_color', 'Yellow', 40, 13),
  ('outfit_color.teal', 'outfit_color', 'Teal', 40, 14), ('outfit_color.gold', 'outfit_color', 'Gold', 150, 15),
  ('headwear.none', 'headwear', 'None', 0, 0), ('headwear.hijab', 'headwear', 'Hijab', 0, 1),
  ('headwear.turban', 'headwear', 'Turban', 0, 2), ('headwear.patka', 'headwear', 'Patka', 0, 3),
  ('headwear.cap', 'headwear', 'Cap', 80, 10), ('headwear.wizard', 'headwear', 'Wizard hat', 250, 11),
  ('headwear.grad', 'headwear', 'Graduation cap', 300, 12), ('headwear.crown', 'headwear', 'Crown', 400, 13),
  ('headwear_color.navy', 'headwear_color', 'Navy', 0, 1), ('headwear_color.black', 'headwear_color', 'Black', 0, 2),
  ('headwear_color.white', 'headwear_color', 'White', 0, 3), ('headwear_color.red', 'headwear_color', 'Red', 0, 4),
  ('headwear_color.blue', 'headwear_color', 'Blue', 0, 5), ('headwear_color.teal', 'headwear_color', 'Teal', 0, 6),
  ('headwear_color.saffron', 'headwear_color', 'Saffron', 0, 7), ('headwear_color.green', 'headwear_color', 'Green', 0, 8),
  ('headwear_color.maroon', 'headwear_color', 'Maroon', 0, 9),
  ('headwear_color.purple', 'headwear_color', 'Purple', 40, 10), ('headwear_color.pink', 'headwear_color', 'Pink', 40, 11),
  ('headwear_color.gold', 'headwear_color', 'Gold', 60, 12),
  ('accessory.freckles', 'accessory', 'Freckles', 0, 1),
  ('accessory.star', 'accessory', 'Star clip', 50, 10), ('accessory.earrings', 'accessory', 'Earrings', 50, 11),
  ('accessory.glasses', 'accessory', 'Glasses', 60, 12), ('accessory.pencil', 'accessory', 'Pencil', 70, 13),
  ('accessory.sunglasses', 'accessory', 'Sunglasses', 90, 14), ('accessory.headphones', 'accessory', 'Headphones', 120, 15),
  ('background.sky', 'background', 'Sky', 0, 1), ('background.mint', 'background', 'Mint', 0, 2),
  ('background.peach', 'background', 'Peach', 40, 10), ('background.lilac', 'background', 'Lilac', 40, 11),
  ('background.sunset', 'background', 'Sunset', 120, 12), ('background.stars', 'background', 'Night stars', 150, 13),
  ('background.beads', 'background', 'Abacus beads', 150, 14), ('background.numbers', 'background', 'Numbers', 200, 15),
  ('background.galaxy', 'background', 'Galaxy', 250, 16),
  ('frame.none', 'frame', 'No frame', 0, 0), ('frame.silver', 'frame', 'Silver', 100, 10),
  ('frame.beads', 'frame', 'Bead ring', 200, 11), ('frame.gold', 'frame', 'Gold', 250, 12), ('frame.rainbow', 'frame', 'Rainbow', 300, 13),
  ('name_color.default', 'name_color', 'Standard', 0, 0), ('name_color.blue', 'name_color', 'Blue', 60, 10),
  ('name_color.green', 'name_color', 'Green', 60, 11), ('name_color.pink', 'name_color', 'Pink', 60, 12),
  ('name_color.purple', 'name_color', 'Purple', 80, 13), ('name_color.orange', 'name_color', 'Orange', 80, 14),
  ('name_color.rainbow', 'name_color', 'Rainbow', 300, 15),
  ('banner.plain', 'banner', 'Plain', 0, 0), ('banner.ocean', 'banner', 'Ocean', 100, 10),
  ('banner.sunset', 'banner', 'Sunset', 100, 11), ('banner.forest', 'banner', 'Forest', 100, 12),
  ('banner.abacus', 'banner', 'Abacus', 150, 13), ('banner.numbers', 'banner', 'Numbers', 150, 14),
  ('banner.galaxy', 'banner', 'Galaxy', 200, 15)
ON CONFLICT (key) DO UPDATE
  SET slot = EXCLUDED.slot, name = EXCLUDED.name, cost = EXCLUDED.cost, sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS public.collectible_cards (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]+$'),
  number integer NOT NULL UNIQUE,
  name text NOT NULL,
  rarity text NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  subtitle text NOT NULL,
  fact text NOT NULL CHECK (char_length(fact) <= 320)
);

INSERT INTO public.collectible_cards (key, number, name, rarity, subtitle, fact) VALUES
  ('aryabhata', 1, 'Aryabhata', 'legendary', 'India · 476–550 CE',
   'He wrote his famous maths and astronomy book, the Aryabhatiya, when he was only 23. He worked out π as about 3.1416. India''s first satellite, launched in 1975, is named after him.'),
  ('ramanujan', 2, 'Srinivasa Ramanujan', 'legendary', 'India · 1887–1920',
   'He taught himself from a borrowed book and filled notebooks with thousands of results. 1729 is called the Hardy–Ramanujan number: the smallest number that is the sum of two cubes in two different ways.'),
  ('brahmagupta', 3, 'Brahmagupta', 'legendary', 'India · 598–668 CE',
   'In 628 CE he wrote rules for calculating with zero as a number of its own. He also wrote rules for negative numbers, which he called debts, and positive numbers, which he called fortunes.'),
  ('matsuzaki', 4, 'Kiyoshi Matsuzaki', 'epic', 'Abacus hero · Japan, 1946',
   'In 1946 in Tokyo, this clerk from the postal service raced an electric calculator using only his soroban. He won 4 of the 5 events. The machine only won at multiplication.'),
  ('shakuntala_devi', 5, 'Shakuntala Devi', 'epic', 'India · 1929–2013',
   'Known as the "Human Computer". In 1980 in London she multiplied two 13-digit numbers in her head in 28 seconds, a feat recorded by Guinness World Records.'),
  ('al_khwarizmi', 6, 'Al-Khwarizmi', 'epic', 'Baghdad · about 780–850',
   'He worked at the House of Wisdom in Baghdad. The word "algebra" comes from the title of his book, and the word "algorithm" comes from his name.'),
  ('hypatia', 7, 'Hypatia', 'epic', 'Alexandria, Egypt · died 415 CE',
   'One of the first women mathematicians we know about. She taught maths, astronomy and philosophy in Alexandria, and students travelled from far away to learn from her.'),
  ('katherine_johnson', 8, 'Katherine Johnson', 'epic', 'USA · 1918–2020',
   'Her calculations helped send astronauts into space. In 1962 astronaut John Glenn asked for her to check the computer''s numbers before his flight around the Earth.'),
  ('bhaskara', 9, 'Bhaskara II', 'rare', 'India · 1114–1185',
   'He wrote Lilavati, a famous book of maths puzzles about things like bees, monkeys and arrows. Students in India learned arithmetic from it for hundreds of years.'),
  ('euclid', 10, 'Euclid', 'rare', 'Greece · around 300 BCE',
   'His book Elements explained geometry step by step, starting from a few simple ideas. Schools used it to teach geometry for more than 2,000 years.'),
  ('archimedes', 11, 'Archimedes', 'rare', 'Sicily · about 287–212 BCE',
   'He showed that π is between 3 10/71 and 3 1/7 by fitting shapes with 96 sides inside and outside a circle.'),
  ('fibonacci', 12, 'Fibonacci', 'rare', 'Italy · about 1170–1250',
   'His 1202 book Liber Abaci helped bring the digits 0 to 9, first used in India, to Europe. His puzzle about rabbits gives the sequence 1, 1, 2, 3, 5, 8, 13…'),
  ('ada_lovelace', 13, 'Ada Lovelace', 'rare', 'England · 1815–1852',
   'She wrote step-by-step instructions for a calculating machine that had not even been built yet. Many people call her the first computer programmer.'),
  ('gauss', 14, 'Carl Friedrich Gauss', 'rare', 'Germany · 1777–1855',
   'A famous story says that as a schoolboy he added 1 to 100 in moments by making pairs: 1 + 100, 2 + 99 and so on. Fifty pairs of 101 make 5050.'),
  ('mirzakhani', 15, 'Maryam Mirzakhani', 'rare', 'Iran · 1977–2017',
   'In 2014 she became the first woman to win the Fields Medal, one of the biggest prizes in maths. She liked to draw her ideas on huge sheets of paper.'),
  ('sophie_germain', 16, 'Sophie Germain', 'rare', 'France · 1776–1831',
   'Women were not allowed to study at the university she wanted, so she read borrowed lecture notes and sent her work under the name "Monsieur LeBlanc". She later won a prize from the French Academy of Sciences.'),
  ('soroban', 17, 'The Soroban', 'common', 'Abacus history · Japan',
   'The Japanese soroban has 1 bead above the bar and 4 below on every rod. Most abacus classes today use this layout. Each top bead is worth 5 and each bottom bead is worth 1.'),
  ('suanpan', 18, 'The Suanpan', 'common', 'Abacus history · China',
   'The Chinese suanpan usually has 2 beads above the bar and 5 below on every rod. Shopkeepers and bankers used it for hundreds of years.'),
  ('salamis_tablet', 19, 'The Salamis Tablet', 'common', 'Abacus history · Greece',
   'Found in 1846 on the Greek island of Salamis, this marble counting board is about 2,300 years old. People moved small stones along its lines to add up.'),
  ('schoty', 20, 'The Schoty', 'common', 'Abacus history · Russia',
   'The Russian schoty has 10 beads on each wire and is used sideways, with the wires running across. It was a common sight in Russian shops for many years.'),
  ('counting_rods', 21, 'Counting Rods', 'common', 'Abacus history · China',
   'Before the abacus, people in China calculated with small bamboo rods laid out on a table. Red rods showed positive numbers and black rods showed negative ones.'),
  ('cheng_dawei', 22, 'Cheng Dawei', 'common', 'Abacus hero · China, 1533–1606',
   'In 1592 he wrote a book about calculating on the suanpan. It was so popular that people kept copying and reprinting it for centuries.'),
  ('napier', 23, 'John Napier', 'common', 'Scotland · 1550–1617',
   'He invented "Napier''s bones", a set of numbered rods that turn multiplication into adding. He also invented logarithms.'),
  ('pascal', 24, 'Blaise Pascal', 'common', 'France · 1623–1662',
   'At 19 he built one of the first mechanical calculators, the Pascaline, to help his father add up taxes.')
ON CONFLICT (key) DO UPDATE
  SET number = EXCLUDED.number, name = EXCLUDED.name, rarity = EXCLUDED.rarity,
      subtitle = EXCLUDED.subtitle, fact = EXCLUDED.fact;

CREATE TABLE IF NOT EXISTS public.title_catalogue (
  key text PRIMARY KEY,
  name text NOT NULL,
  how text NOT NULL,
  badge_key text,
  rule text NOT NULL DEFAULT 'badge' CHECK (rule IN ('badge', 'division')),
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO public.title_catalogue (key, name, how, badge_key, rule, sort_order) VALUES
  ('first_steps',     'First Stepper',     'Finish your first round.',                          'first_round',   'badge', 1),
  ('century',         'Century Maker',     'Finish 100 rounds.',                                 'rounds_100',    'badge', 2),
  ('speed_demon',     'Speed Demon',       'Beat your personal bests 10 times.',                 'pb_10',         'badge', 3),
  ('sharpshooter',    'Sharpshooter',      'Get 25 perfect rounds of 10 or more.',               'perfect_25',    'badge', 4),
  ('flash_master',    'Flash Master',      'Answer every sum right in a Flash Anzan round.',     'flash_perfect', 'badge', 5),
  ('memory_wizard',   'Memory Wizard',     'Practise all 4 Memoriad events.',                    'memoriad_all',  'badge', 6),
  ('streak_keeper',   'Streak Keeper',     'Reach a 30-day streak.',                             'streak_30',     'badge', 7),
  ('challenge_champ', 'Challenge Champ',   'Top your level in a daily challenge.',               'challenge_win', 'badge', 8),
  ('star_month',      'Star of the Month', 'Earn the most XP in your level in a month.',         'star_month',    'badge', 9),
  ('legend',          'Legend',            'Reach Legend rank in a season.',                     'tier_legend',   'badge', 10),
  ('division_king',   'Division King',     'Score 90% or more in 25 division rounds of 10 or more questions.', NULL, 'division', 20),
  ('division_queen',  'Division Queen',    'Score 90% or more in 25 division rounds of 10 or more questions.', NULL, 'division', 21),
  ('division_champ',  'Division Champ',    'Score 90% or more in 25 division rounds of 10 or more questions.', NULL, 'division', 22)
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name, how = EXCLUDED.how, badge_key = EXCLUDED.badge_key,
      rule = EXCLUDED.rule, sort_order = EXCLUDED.sort_order;

-- ---------------------------------------------------------------------------
-- 2. Student data (written only by the functions below)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.student_coin_ledger (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('chest', 'buy', 'duplicate', 'adjust')),
  ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, ref)
);
CREATE INDEX IF NOT EXISTS student_coin_ledger_student_idx ON public.student_coin_ledger (student_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.student_avatar_items (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_key text NOT NULL REFERENCES public.avatar_items(key) ON DELETE CASCADE,
  bought_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, item_key)
);

CREATE TABLE IF NOT EXISTS public.student_style (
  student_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  avatar_mode text CHECK (avatar_mode IN ('photo', 'avatar')),
  look jsonb,
  look_token text CHECK (look_token IS NULL OR look_token ~ '^look:1\|[a-z0-9_|+]+$'),
  name_color text NOT NULL DEFAULT 'default',
  banner text NOT NULL DEFAULT 'plain',
  title_key text REFERENCES public.title_catalogue(key) ON DELETE SET NULL,
  showcase text[] NOT NULL DEFAULT '{}' CHECK (cardinality(showcase) <= 3),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.student_cards (
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  card_key text NOT NULL REFERENCES public.collectible_cards(key) ON DELETE CASCADE,
  copies integer NOT NULL DEFAULT 1 CHECK (copies >= 1),
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, card_key)
);

CREATE TABLE IF NOT EXISTS public.chest_claims (
  id bigserial PRIMARY KEY,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly', 'levelup')),
  period text NOT NULL,
  coins integer NOT NULL CHECK (coins >= 0),
  card_key text REFERENCES public.collectible_cards(key) ON DELETE SET NULL,
  duplicate boolean NOT NULL DEFAULT false,
  duplicate_coins integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, kind, period)
);

ALTER TABLE public.avatar_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collectible_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.title_catalogue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_coin_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_avatar_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_style ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chest_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS avatar_items_select ON public.avatar_items;
CREATE POLICY avatar_items_select ON public.avatar_items FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS collectible_cards_select ON public.collectible_cards;
CREATE POLICY collectible_cards_select ON public.collectible_cards FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS title_catalogue_select ON public.title_catalogue;
CREATE POLICY title_catalogue_select ON public.title_catalogue FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS student_coin_ledger_select ON public.student_coin_ledger;
CREATE POLICY student_coin_ledger_select ON public.student_coin_ledger FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
DROP POLICY IF EXISTS student_avatar_items_select ON public.student_avatar_items;
CREATE POLICY student_avatar_items_select ON public.student_avatar_items FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
DROP POLICY IF EXISTS student_style_select ON public.student_style;
CREATE POLICY student_style_select ON public.student_style FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
DROP POLICY IF EXISTS student_cards_select ON public.student_cards;
CREATE POLICY student_cards_select ON public.student_cards FOR SELECT TO authenticated USING (public.xp_can_view(student_id));
DROP POLICY IF EXISTS chest_claims_select ON public.chest_claims;
CREATE POLICY chest_claims_select ON public.chest_claims FOR SELECT TO authenticated USING (public.xp_can_view(student_id));

REVOKE ALL ON public.avatar_items, public.collectible_cards, public.title_catalogue, public.student_coin_ledger,
  public.student_avatar_items, public.student_style, public.student_cards, public.chest_claims FROM anon, authenticated;
GRANT SELECT ON public.avatar_items, public.collectible_cards, public.title_catalogue, public.student_coin_ledger,
  public.student_avatar_items, public.student_style, public.student_cards, public.chest_claims TO authenticated;
REVOKE ALL ON SEQUENCE public.student_coin_ledger_id_seq, public.chest_claims_id_seq FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Coins
-- ---------------------------------------------------------------------------
-- Practice coins count XP earned from this day (India time).
CREATE OR REPLACE FUNCTION public.coin_start_date()
 RETURNS date LANGUAGE sql IMMUTABLE AS $function$ SELECT date '2026-11-28' $function$;

CREATE OR REPLACE FUNCTION public.ist_today()
 RETURNS date LANGUAGE sql STABLE AS $function$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $function$;

CREATE OR REPLACE FUNCTION public.coin_balance(p_student uuid)
 RETURNS TABLE(practice bigint, ledger bigint, balance bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.v, l.v, p.v + l.v
    FROM (SELECT (COALESCE(sum(xp), 0) / 10)::bigint AS v FROM public.student_xp_events
           WHERE student_id = p_student AND day >= public.coin_start_date()) p,
         (SELECT COALESCE(sum(delta), 0)::bigint AS v FROM public.student_coin_ledger WHERE student_id = p_student) l;
$function$;

-- The balance can never go below zero, whatever writes the ledger.
CREATE OR REPLACE FUNCTION public.trg_coin_ledger_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.delta < 0 AND (SELECT balance FROM public.coin_balance(NEW.student_id)) < 0 THEN
    RAISE EXCEPTION 'Not enough coins.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS coin_ledger_guard ON public.student_coin_ledger;
CREATE TRIGGER coin_ledger_guard AFTER INSERT ON public.student_coin_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_coin_ledger_guard();

-- Serialises coin changes for one student (the profile row is the lock).
CREATE OR REPLACE FUNCTION public.coin_lock_student(p_student uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM 1 FROM public.profiles WHERE id = p_student AND role = 'student' AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only students can do this.' USING ERRCODE = '42501'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.avatar_item_owned(p_student uuid, p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.avatar_items i WHERE i.key = p_key AND i.active AND i.cost = 0)
      OR EXISTS (SELECT 1 FROM public.student_avatar_items s WHERE s.student_id = p_student AND s.item_key = p_key);
$function$;

-- Buying an item you already own costs nothing and changes nothing.
CREATE OR REPLACE FUNCTION public.avatar_buy(p_item text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  i public.avatar_items%ROWTYPE;
  v_bal bigint;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM public.coin_lock_student(v_me);
  SELECT * INTO i FROM public.avatar_items WHERE key = p_item;
  IF NOT FOUND OR NOT i.active THEN RAISE EXCEPTION 'This item is not in the shop.'; END IF;
  IF public.avatar_item_owned(v_me, i.key) THEN
    SELECT balance INTO v_bal FROM public.coin_balance(v_me);
    RETURN jsonb_build_object('item', i.key, 'owned', true, 'already', true, 'balance', v_bal);
  END IF;
  SELECT balance INTO v_bal FROM public.coin_balance(v_me);
  IF v_bal < i.cost THEN
    RAISE EXCEPTION 'You need % more coins for this.', i.cost - v_bal USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.student_coin_ledger (student_id, delta, reason, ref)
  VALUES (v_me, -i.cost, 'buy', 'buy:' || i.key);
  INSERT INTO public.student_avatar_items (student_id, item_key) VALUES (v_me, i.key);
  RETURN jsonb_build_object('item', i.key, 'owned', true, 'already', false, 'balance', v_bal - i.cost);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Avatar look and profile style
-- ---------------------------------------------------------------------------
-- Checks a look against the catalogue and what the student owns. Returns the token
-- 'look:1|skin|hair|hair_color|outfit|outfit_color|headwear|headwear_color|acc+acc|background|frame'.
CREATE OR REPLACE FUNCTION public.avatar_look_token(p_student uuid, p_look jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slots text[] := ARRAY['hair', 'hair_color', 'outfit', 'outfit_color', 'headwear', 'headwear_color', 'background', 'frame'];
  v_slot text;
  v_val text;
  v_parts text[] := ARRAY[]::text[];
  v_skin integer;
  v_acc text[];
  a text;
BEGIN
  IF p_look IS NULL OR jsonb_typeof(p_look) <> 'object' THEN RAISE EXCEPTION 'Choose your avatar first.'; END IF;
  v_skin := CASE WHEN (p_look->>'skin') ~ '^[0-5]$' THEN (p_look->>'skin')::integer END;
  IF v_skin IS NULL THEN RAISE EXCEPTION 'Choose a skin tone.'; END IF;
  FOREACH v_slot IN ARRAY v_slots LOOP
    v_val := p_look->>v_slot;
    IF v_val IS NULL OR v_val !~ '^[a-z0-9_]{1,24}$' OR NOT public.avatar_item_owned(p_student, v_slot || '.' || v_val) THEN
      RAISE EXCEPTION 'That % is not yours yet.', replace(v_slot, '_', ' ');
    END IF;
    v_parts := v_parts || v_val;
  END LOOP;
  IF p_look ? 'accessories' AND jsonb_typeof(p_look->'accessories') <> 'array' THEN RAISE EXCEPTION 'Accessories must be a list.'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[]) INTO v_acc
    FROM jsonb_array_elements_text(COALESCE(p_look->'accessories', '[]'::jsonb)) x;
  IF cardinality(v_acc) > 2 THEN RAISE EXCEPTION 'Pick up to 2 accessories.'; END IF;
  FOREACH a IN ARRAY v_acc LOOP
    IF a !~ '^[a-z0-9_]{1,24}$' OR NOT public.avatar_item_owned(p_student, 'accessory.' || a) THEN
      RAISE EXCEPTION 'That accessory is not yours yet.';
    END IF;
  END LOOP;
  RETURN 'look:1|' || v_skin || '|' || v_parts[1] || '|' || v_parts[2] || '|' || v_parts[3] || '|' || v_parts[4]
      || '|' || v_parts[5] || '|' || v_parts[6] || '|' || COALESCE(NULLIF(array_to_string(v_acc, '+'), ''), 'none')
      || '|' || v_parts[7] || '|' || v_parts[8];
END;
$function$;

-- Saves the avatar and, optionally, which picture to show (p_mode 'photo' or 'avatar').
CREATE OR REPLACE FUNCTION public.avatar_save(p_look jsonb, p_mode text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_token text;
  v_mode text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM public.coin_lock_student(v_me);
  IF p_mode IS NOT NULL AND p_mode NOT IN ('photo', 'avatar') THEN RAISE EXCEPTION 'Unknown picture choice.'; END IF;
  IF p_look IS NOT NULL THEN v_token := public.avatar_look_token(v_me, p_look); END IF;
  INSERT INTO public.student_style AS s (student_id, avatar_mode, look, look_token, updated_at)
  VALUES (v_me, COALESCE(p_mode, 'avatar'), p_look, v_token, now())
  ON CONFLICT (student_id) DO UPDATE
    SET look = COALESCE(EXCLUDED.look, s.look),
        look_token = COALESCE(EXCLUDED.look_token, s.look_token),
        avatar_mode = COALESCE(p_mode, s.avatar_mode, 'avatar'),
        updated_at = now();
  SELECT avatar_mode, look_token INTO v_mode, v_token FROM public.student_style WHERE student_id = v_me;
  IF v_mode = 'avatar' AND v_token IS NULL THEN
    UPDATE public.student_style SET avatar_mode = 'photo' WHERE student_id = v_me;
    RAISE EXCEPTION 'Build your avatar first.';
  END IF;
  RETURN jsonb_build_object('mode', v_mode, 'token', v_token);
END;
$function$;

CREATE OR REPLACE FUNCTION public.titles_unlocked(p_student uuid)
 RETURNS SETOF text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.key FROM public.title_catalogue t
   WHERE (t.rule = 'badge' AND EXISTS (SELECT 1 FROM public.student_badges b
                                        WHERE b.student_id = p_student AND b.badge_key = t.badge_key))
      OR (t.rule = 'division' AND (
            SELECT count(*) FROM public.student_xp_events e
             WHERE e.student_id = p_student AND e.total >= 10 AND e.correct * 10 >= e.total * 9
               AND (e.activity_key ILIKE '%div%' OR e.label ILIKE '%divi%')) >= 25);
$function$;

CREATE OR REPLACE FUNCTION public.profile_style_save(p_name_color text, p_banner text, p_title text, p_showcase text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_show text[];
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  PERFORM public.coin_lock_student(v_me);
  IF NOT public.avatar_item_owned(v_me, 'name_color.' || COALESCE(p_name_color, '')) THEN RAISE EXCEPTION 'That name colour is not yours yet.'; END IF;
  IF NOT public.avatar_item_owned(v_me, 'banner.' || COALESCE(p_banner, '')) THEN RAISE EXCEPTION 'That banner is not yours yet.'; END IF;
  IF p_title IS NOT NULL AND p_title NOT IN (SELECT public.titles_unlocked(v_me)) THEN
    RAISE EXCEPTION 'Earn that title first.';
  END IF;
  SELECT COALESCE(array_agg(x ORDER BY o), ARRAY[]::text[]) INTO v_show
    FROM (SELECT DISTINCT ON (x) x, o FROM unnest(COALESCE(p_showcase, ARRAY[]::text[])) WITH ORDINALITY u(x, o) ORDER BY x, o) d;
  IF cardinality(v_show) > 3 THEN RAISE EXCEPTION 'Pick up to 3 badges.'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_show) x
              WHERE NOT EXISTS (SELECT 1 FROM public.student_badges b WHERE b.student_id = v_me AND b.badge_key = x)) THEN
    RAISE EXCEPTION 'You can only show badges you have earned.';
  END IF;
  INSERT INTO public.student_style AS s (student_id, name_color, banner, title_key, showcase, updated_at)
  VALUES (v_me, p_name_color, p_banner, p_title, v_show, now())
  ON CONFLICT (student_id) DO UPDATE
    SET name_color = EXCLUDED.name_color, banner = EXCLUDED.banner, title_key = EXCLUDED.title_key,
        showcase = EXCLUDED.showcase, updated_at = now();
  RETURN jsonb_build_object('name_color', p_name_color, 'banner', p_banner, 'title', p_title, 'showcase', to_jsonb(v_show));
END;
$function$;

-- Photos keep their old rules (hidden when leaderboards show codes). A cartoon avatar
-- does not identify anyone, so it shows to every signed-in user when chosen.
CREATE OR REPLACE FUNCTION public.avatar_visible(p_student uuid, p_path text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN auth.uid() IS NULL THEN NULL
    WHEN s.avatar_mode = 'avatar' AND s.look_token IS NOT NULL THEN s.look_token
    WHEN p_path IS NULL THEN NULL
    WHEN p_student = auth.uid() OR public.is_admin() OR public.is_teacher(auth.uid()) THEN p_path
    WHEN (SELECT r.leaderboard_names FROM public.competition_rules() r) = 'student_code' THEN NULL
    ELSE p_path
  END
  FROM (SELECT 1) one
  LEFT JOIN public.student_style s ON s.student_id = p_student;
$function$;

-- What the signed-in student (or a student staff may view) shows as their picture.
CREATE OR REPLACE FUNCTION public.my_avatar(p_student uuid DEFAULT NULL)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.avatar_visible(p.id, p.avatar_path)
    FROM public.profiles p
   WHERE p.id = COALESCE(p_student, auth.uid()) AND public.xp_can_view(p.id);
$function$;

-- ---------------------------------------------------------------------------
-- 5. Weekly quests and chests
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ist_week_start(p_day date)
 RETURNS date LANGUAGE sql IMMUTABLE AS $function$ SELECT p_day - ((extract(isodow FROM p_day)::integer) - 1) $function$;

-- The 3 quests for the week starting p_week. The third rotates every week.
CREATE OR REPLACE FUNCTION public.weekly_quests(p_student uuid, p_week date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_days integer; v_rounds integer; v_accurate integer; v_pbs integer; v_kinds integer;
  v_rot integer := (((p_week - date '2026-01-05') / 7) % 3 + 3) % 3;
  q3 jsonb;
BEGIN
  SELECT count(DISTINCT day), count(*),
         count(*) FILTER (WHERE total >= 10 AND correct * 10 >= total * 9),
         count(*) FILTER (WHERE is_personal_best AND NOT first_best),
         count(DISTINCT split_part(activity_key, ':', 1))
    INTO v_days, v_rounds, v_accurate, v_pbs, v_kinds
    FROM public.student_xp_events
   WHERE student_id = p_student AND day >= p_week AND day < p_week + 7 AND total > 0;
  q3 := CASE v_rot
    WHEN 0 THEN jsonb_build_object('key', 'accurate', 'label', 'Score 90% or more in 3 rounds of 10 or more questions', 'goal', 3, 'done', LEAST(v_accurate, 3))
    WHEN 1 THEN jsonb_build_object('key', 'record', 'label', 'Beat one of your personal bests', 'goal', 1, 'done', LEAST(v_pbs, 1))
    ELSE jsonb_build_object('key', 'variety', 'label', 'Practise 2 different kinds of event', 'goal', 2, 'done', LEAST(v_kinds, 2))
  END;
  RETURN jsonb_build_array(
    jsonb_build_object('key', 'days', 'label', 'Practise on 4 different days', 'goal', 4, 'done', LEAST(v_days, 4)),
    jsonb_build_object('key', 'rounds', 'label', 'Finish 15 rounds', 'goal', 15, 'done', LEAST(v_rounds, 15)),
    q3);
END;
$function$;

-- Published odds. Each row: rarity and chance in percent of getting a card of that rarity
-- when a card drops. card_chance is the chance a card drops at all.
CREATE OR REPLACE FUNCTION public.chest_odds()
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'daily',   jsonb_build_object('coins_min', 15, 'coins_max', 25, 'card_chance', 20,
                 'rarity', jsonb_build_object('common', 75, 'rare', 20, 'epic', 5, 'legendary', 0)),
    'weekly',  jsonb_build_object('coins_min', 60, 'coins_max', 80, 'card_chance', 100,
                 'rarity', jsonb_build_object('common', 55, 'rare', 30, 'epic', 12, 'legendary', 3)),
    'levelup', jsonb_build_object('coins_per_tier', 40, 'card_chance', 100,
                 'rarity', jsonb_build_object('common', 40, 'rare', 35, 'epic', 20, 'legendary', 5)),
    'duplicate_coins', jsonb_build_object('common', 5, 'rare', 15, 'epic', 40, 'legendary', 100));
$function$;

-- Which chests the student can open now, and the period key each would use.
CREATE OR REPLACE FUNCTION public.chest_status(p_student uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := public.ist_today();
  v_week date := public.ist_week_start(public.ist_today());
  v_month date := date_trunc('month', public.ist_today())::date;
  v_played boolean;
  v_quests jsonb;
  v_quests_done boolean;
  v_season_xp bigint;
  v_rank integer;
  v_next_rank integer;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.student_xp_events WHERE student_id = p_student AND day = v_today AND total > 0) INTO v_played;
  v_quests := public.weekly_quests(p_student, v_week);
  SELECT bool_and((q->>'done')::integer >= (q->>'goal')::integer) INTO v_quests_done FROM jsonb_array_elements(v_quests) q;
  SELECT COALESCE(sum(xp), 0) INTO v_season_xp FROM public.student_xp_events WHERE student_id = p_student AND day >= v_month;
  v_rank := COALESCE((public.xp_season_tier(v_season_xp)->>'rank')::integer, 1);
  SELECT min(r) INTO v_next_rank FROM generate_series(2, v_rank) r
   WHERE NOT EXISTS (SELECT 1 FROM public.chest_claims c WHERE c.student_id = p_student AND c.kind = 'levelup'
                      AND c.period = to_char(v_month, 'YYYY-MM') || ':tier' || r);
  RETURN jsonb_build_object(
    'daily', jsonb_build_object('period', 'day:' || v_today, 'ready', v_played,
       'claimed', EXISTS (SELECT 1 FROM public.chest_claims c WHERE c.student_id = p_student AND c.kind = 'daily' AND c.period = 'day:' || v_today)),
    'weekly', jsonb_build_object('period', 'week:' || v_week, 'ready', COALESCE(v_quests_done, false), 'quests', v_quests,
       'claimed', EXISTS (SELECT 1 FROM public.chest_claims c WHERE c.student_id = p_student AND c.kind = 'weekly' AND c.period = 'week:' || v_week)),
    'levelup', jsonb_build_object('period', CASE WHEN v_next_rank IS NOT NULL THEN to_char(v_month, 'YYYY-MM') || ':tier' || v_next_rank END,
       'ready', v_next_rank IS NOT NULL, 'claimed', false, 'tier', public.xp_season_tier(v_season_xp), 'season_xp', v_season_xp,
       'next_tier_rank', v_next_rank));
END;
$function$;

CREATE OR REPLACE FUNCTION public.chest_roll_rarity(p_weights jsonb)
 RETURNS text
 LANGUAGE plpgsql
 VOLATILE
AS $function$
DECLARE
  v_roll numeric := random() * 100;
  v_acc numeric := 0;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['legendary', 'epic', 'rare', 'common'] LOOP
    v_acc := v_acc + COALESCE((p_weights->>r)::numeric, 0);
    IF v_roll < v_acc THEN RETURN r; END IF;
  END LOOP;
  RETURN 'common';
END;
$function$;

CREATE OR REPLACE FUNCTION public.chest_claim_json(c public.chest_claims, p_already boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'kind', c.kind, 'period', c.period, 'coins', c.coins, 'already', p_already,
    'duplicate', c.duplicate, 'duplicate_coins', c.duplicate_coins,
    'card', (SELECT jsonb_build_object('key', k.key, 'number', k.number, 'name', k.name, 'rarity', k.rarity,
                                        'subtitle', k.subtitle, 'fact', k.fact)
               FROM public.collectible_cards k WHERE k.key = c.card_key),
    'balance', (SELECT balance FROM public.coin_balance(c.student_id)));
$function$;

-- Opens a chest. Repeating the call (double tap, two phones, a retry) returns the
-- same contents and grants nothing more. Pass the period you were shown to make a
-- level-up retry safe too.
CREATE OR REPLACE FUNCTION public.chest_claim(p_kind text, p_period text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_status jsonb;
  v_period text;
  v_odds jsonb := public.chest_odds();
  v_cfg jsonb;
  v_coins integer;
  v_rarity text;
  v_card text;
  v_dup boolean := false;
  v_dup_coins integer := 0;
  c public.chest_claims%ROWTYPE;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF p_kind NOT IN ('daily', 'weekly', 'levelup') THEN RAISE EXCEPTION 'Unknown chest.'; END IF;
  PERFORM public.coin_lock_student(v_me);

  IF p_period IS NOT NULL THEN
    SELECT * INTO c FROM public.chest_claims WHERE student_id = v_me AND kind = p_kind AND period = p_period;
    IF FOUND THEN RETURN public.chest_claim_json(c, true); END IF;
  END IF;

  v_status := public.chest_status(v_me)->p_kind;
  v_period := v_status->>'period';
  IF v_period IS NULL THEN RAISE EXCEPTION 'Reach a new tier this season to open this chest.'; END IF;
  IF p_period IS NOT NULL AND p_period <> v_period THEN RAISE EXCEPTION 'This chest has changed. Refresh the page.'; END IF;
  SELECT * INTO c FROM public.chest_claims WHERE student_id = v_me AND kind = p_kind AND period = v_period;
  IF FOUND THEN RETURN public.chest_claim_json(c, true); END IF;
  IF NOT (v_status->>'ready')::boolean THEN
    RAISE EXCEPTION '%', CASE p_kind
      WHEN 'daily' THEN 'Finish a practice round today to open this chest.'
      WHEN 'weekly' THEN 'Finish all 3 weekly quests to open this chest.'
      ELSE 'Reach a new tier this season to open this chest.' END;
  END IF;

  v_cfg := v_odds->p_kind;
  IF p_kind = 'levelup' THEN
    v_coins := (v_cfg->>'coins_per_tier')::integer * (v_status->>'next_tier_rank')::integer;
  ELSE
    v_coins := (v_cfg->>'coins_min')::integer
             + floor(random() * ((v_cfg->>'coins_max')::integer - (v_cfg->>'coins_min')::integer + 1))::integer;
  END IF;
  IF random() * 100 < (v_cfg->>'card_chance')::numeric THEN
    v_rarity := public.chest_roll_rarity(v_cfg->'rarity');
    SELECT key INTO v_card FROM public.collectible_cards WHERE rarity = v_rarity ORDER BY random() LIMIT 1;
  END IF;
  IF v_card IS NOT NULL THEN
    v_dup := EXISTS (SELECT 1 FROM public.student_cards WHERE student_id = v_me AND card_key = v_card);
    IF v_dup THEN v_dup_coins := (v_odds->'duplicate_coins'->>v_rarity)::integer; END IF;
    INSERT INTO public.student_cards (student_id, card_key) VALUES (v_me, v_card)
    ON CONFLICT (student_id, card_key) DO UPDATE SET copies = public.student_cards.copies + 1;
  END IF;

  INSERT INTO public.chest_claims (student_id, kind, period, coins, card_key, duplicate, duplicate_coins)
  VALUES (v_me, p_kind, v_period, v_coins, v_card, v_dup, v_dup_coins)
  RETURNING * INTO c;
  INSERT INTO public.student_coin_ledger (student_id, delta, reason, ref)
  VALUES (v_me, v_coins + v_dup_coins, 'chest', 'chest:' || p_kind || ':' || v_period);
  RETURN public.chest_claim_json(c, false);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Everything the store and profile pages need in one call
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.avatar_store_state(p_student uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_target uuid := COALESCE(p_student, auth.uid());
  b record;
  st public.student_style%ROWTYPE;
  v_has_photo boolean;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501'; END IF;
  IF NOT public.xp_can_view(v_target) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501'; END IF;
  SELECT * INTO b FROM public.coin_balance(v_target);
  SELECT * INTO st FROM public.student_style WHERE student_id = v_target;
  SELECT avatar_path IS NOT NULL INTO v_has_photo FROM public.profiles WHERE id = v_target;
  RETURN jsonb_build_object(
    'is_self', v_target = v_me,
    'coins', jsonb_build_object('balance', b.balance, 'practice', b.practice, 'ledger', b.ledger, 'since', public.coin_start_date()),
    'has_photo', COALESCE(v_has_photo, false),
    'style', jsonb_build_object(
      'mode', COALESCE(st.avatar_mode, CASE WHEN st.look_token IS NOT NULL THEN 'avatar' ELSE 'photo' END),
      'look', st.look, 'token', st.look_token,
      'name_color', COALESCE(st.name_color, 'default'), 'banner', COALESCE(st.banner, 'plain'),
      'title', st.title_key, 'showcase', to_jsonb(COALESCE(st.showcase, ARRAY[]::text[]))),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', i.key, 'slot', i.slot, 'name', i.name, 'cost', i.cost,
                         'owned', i.cost = 0 OR o.item_key IS NOT NULL) ORDER BY i.slot, i.sort_order, i.key)
                         FROM public.avatar_items i
                         LEFT JOIN public.student_avatar_items o ON o.student_id = v_target AND o.item_key = i.key
                        WHERE i.active), '[]'::jsonb),
    'titles', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', t.key, 'name', t.name, 'how', t.how,
                          'earned', t.key IN (SELECT public.titles_unlocked(v_target))) ORDER BY t.sort_order)
                          FROM public.title_catalogue t), '[]'::jsonb),
    'badges', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'icon', c.icon) ORDER BY c.sort_order)
                          FROM public.student_badges sb JOIN public.badge_catalogue c ON c.key = sb.badge_key
                         WHERE sb.student_id = v_target), '[]'::jsonb),
    'cards', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', k.key, 'number', k.number, 'name', k.name, 'rarity', k.rarity,
                         'subtitle', k.subtitle, 'fact', CASE WHEN sc.card_key IS NOT NULL THEN k.fact END,
                         'copies', COALESCE(sc.copies, 0)) ORDER BY k.number)
                         FROM public.collectible_cards k
                         LEFT JOIN public.student_cards sc ON sc.student_id = v_target AND sc.card_key = k.key), '[]'::jsonb),
    'chests', public.chest_status(v_target),
    'odds', public.chest_odds(),
    'recent', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'period', r.period, 'coins', r.coins + r.duplicate_coins,
                          'card', r.card_key, 'at', r.created_at) ORDER BY r.created_at DESC)
                          FROM (SELECT * FROM public.chest_claims WHERE student_id = v_target ORDER BY created_at DESC LIMIT 10) r), '[]'::jsonb)
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Grants: internal helpers stay private; the client gets the RPCs only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.coin_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_coin_ledger_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.coin_lock_student(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.avatar_item_owned(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.avatar_look_token(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.titles_unlocked(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.weekly_quests(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chest_status(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chest_roll_rarity(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chest_claim_json(public.chest_claims, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.avatar_visible(uuid, text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.avatar_buy(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.avatar_save(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profile_style_save(text, text, text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chest_claim(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.avatar_store_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_avatar(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.avatar_buy(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.avatar_save(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.profile_style_save(text, text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chest_claim(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.avatar_store_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_avatar(uuid) TO authenticated;
