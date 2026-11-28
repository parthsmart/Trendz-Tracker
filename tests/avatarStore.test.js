/**
 * Avatar & store: coins, purchases, chests, cards, titles and avatar visibility.
 * Runs the avatar store migration (NN_avatar_store.sql) in PGlite on top of small stand-ins for the
 * tables and helpers it uses from earlier migrations.
 */

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { ART_VALUES, CARD_ART, avatarSvg, isLookToken, lookToken, parseLookToken, lookTokenDataUri, cardArtSvg } from '../shared/avatarArt.js';
import { ITEMS, CARDS, TITLES, CHEST_ODDS } from '../shared/avatarCatalogue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).find((f) => /^\d+_avatar_store\.sql$/.test(f));
const SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations', MIGRATION), 'utf8');

const STU = '11111111-1111-4111-8111-111111111111';
const STU2 = '22222222-2222-4222-8222-222222222222';
const TEACHER = '33333333-3333-4333-8333-333333333333';
const PHOTO = `${STU}/abc.jpg`;

const LOOK = {
  skin: 4, hair: 'curly', hair_color: 'black', outfit: 'kurta', outfit_color: 'green',
  headwear: 'hijab', headwear_color: 'teal', accessories: ['freckles'], background: 'mint', frame: 'none',
};

async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.uid', true), '')::uuid $$;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'student', active boolean NOT NULL DEFAULT true, avatar_path text);
    CREATE TABLE public.student_xp_events (id serial PRIMARY KEY, student_id uuid, activity_key text, label text, correct int, total int,
      day date, xp int, is_personal_best boolean DEFAULT false, first_best boolean DEFAULT false);
    CREATE TABLE public.badge_catalogue (key text PRIMARY KEY, name text, icon text, sort_order int DEFAULT 0);
    CREATE TABLE public.student_badges (student_id uuid, badge_key text);
    CREATE TABLE public.test_rules (leaderboard_names text);
    INSERT INTO public.test_rules VALUES ('full_name');
    CREATE FUNCTION public.xp_season_tier(p bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_build_object('rank', CASE WHEN p >= 2500 THEN 4 WHEN p >= 1000 THEN 3 WHEN p >= 300 THEN 2 ELSE 1 END) $$;
    CREATE FUNCTION public.competition_rules() RETURNS TABLE(leaderboard_names text) LANGUAGE sql STABLE AS $$ SELECT leaderboard_names FROM public.test_rules $$;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.is_teacher(u uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = u AND role = 'teacher') $$;
    CREATE FUNCTION public.xp_can_view(s uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT s = auth.uid() OR public.is_teacher(auth.uid()) $$;
    INSERT INTO public.profiles (id, role, avatar_path) VALUES ('${STU}', 'student', '${PHOTO}'), ('${STU2}', 'student', NULL), ('${TEACHER}', 'teacher', NULL);
    INSERT INTO public.badge_catalogue VALUES ('first_round', 'First round', '🎯', 1), ('pb_10', 'Record breaker', '⚡', 2), ('streak_30', 'Streak', '🔥', 3);
  `);
  await db.exec(SQL);
  return db;
}

async function as(db, uid, fn) {
  await db.exec(`SET app.uid = '${uid}'; SET ROLE authenticated;`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SET app.uid = '';`); }
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const today = "(now() AT TIME ZONE 'Asia/Kolkata')::date";
async function practise(db, student, xp, extra = {}) {
  const e = { activity_key: 'cat:abc:t60', label: 'Addition', correct: 10, total: 10, ...extra };
  await db.query(`INSERT INTO public.student_xp_events (student_id, activity_key, label, correct, total, day, xp)
                  VALUES ($1, $2, $3, $4, $5, ${extra.day || today}, $6)`, [student, e.activity_key, e.label, e.correct, e.total, xp]);
}
const balance = async (db, student) => Number((await one(db, 'SELECT balance FROM public.coin_balance($1)', [student])).balance);

describe('avatar store migration', () => {
  let db;
  before(async () => { db = await makeDb(); });

  it('applies twice without error and keeps one copy of the catalogue', async () => {
    await db.exec(SQL);
    assert.equal(Number((await one(db, 'SELECT count(*) c FROM public.avatar_items')).c), ITEMS.length);
    assert.equal(Number((await one(db, 'SELECT count(*) c FROM public.collectible_cards')).c), 24);
  });

  it('earns coins only from practice: 1 coin per 10 XP', async () => {
    assert.equal(await balance(db, STU), 0);
    await practise(db, STU, 255);
    assert.equal(await balance(db, STU), 25);
    await practise(db, STU, 400, { day: "date '2026-11-01'" }); // before coins started
    assert.equal(await balance(db, STU), 25);
  });

  it('daily chest: locked before practice, then granted once however often it is claimed', async () => {
    await assert.rejects(as(db, STU2, () => db.query(`SELECT public.chest_claim('daily')`)), /Finish a practice round today/);
    await practise(db, STU2, 50);
    const first = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('daily') r`))).r;
    assert.equal(first.already, false);
    assert.ok(first.coins >= 15 && first.coins <= 25);
    const again = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('daily') r`))).r;
    const withPeriod = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('daily', $1) r`, [first.period]))).r;
    for (const r of [again, withPeriod]) {
      assert.equal(r.already, true);
      assert.equal(r.coins, first.coins);
      assert.deepEqual(r.card, first.card);
    }
    assert.equal(Number((await one(db, `SELECT count(*) c FROM public.chest_claims WHERE student_id = $1`, [STU2])).c), 1);
    assert.equal(Number((await one(db, `SELECT count(*) c FROM public.student_coin_ledger WHERE student_id = $1 AND reason = 'chest'`, [STU2])).c), 1);
    assert.equal(await balance(db, STU2), 5 + first.coins + first.duplicate_coins);
  });

  it('level-up chest pays 40 coins per tier, lowest tier first, each once per season', async () => {
    await practise(db, STU2, 1000); // season XP 1050 -> rank 3
    const t2 = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('levelup') r`))).r;
    assert.equal(t2.coins, 80);
    assert.match(t2.period, /:tier2$/);
    assert.ok(t2.card, 'level-up chests always hold a card');
    const t3 = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('levelup') r`))).r;
    assert.equal(t3.coins, 120);
    assert.match(t3.period, /:tier3$/);
    await assert.rejects(as(db, STU2, () => db.query(`SELECT public.chest_claim('levelup')`)), /Reach a new tier/);
    // A retry of an earlier period returns the saved result.
    const retry = (await as(db, STU2, () => one(db, `SELECT public.chest_claim('levelup', $1) r`, [t2.period]))).r;
    assert.equal(retry.already, true);
    assert.equal(retry.coins, 80);
  });

  it('weekly chest opens only after all 3 quests', async () => {
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.chest_claim('weekly')`)), /all 3 weekly quests/);
    const status = (await as(db, STU, () => one(db, 'SELECT public.avatar_store_state() s'))).s.chests.weekly;
    assert.equal(status.quests.length, 3);
    assert.equal(status.ready, false);
  });

  it('students cannot write coins, cards, items or claims directly', async () => {
    const attempts = [
      `INSERT INTO public.student_coin_ledger (student_id, delta, reason, ref) VALUES ('${STU}', 9999, 'adjust', 'x')`,
      `INSERT INTO public.student_cards (student_id, card_key) VALUES ('${STU}', 'ramanujan')`,
      `INSERT INTO public.student_avatar_items (student_id, item_key) VALUES ('${STU}', 'headwear.crown')`,
      `INSERT INTO public.chest_claims (student_id, kind, period, coins) VALUES ('${STU}', 'daily', 'day:2099-01-01', 999)`,
      `UPDATE public.student_style SET look_token = 'look:1|0|short|black|tee|blue|crown|gold|none|galaxy|gold' WHERE student_id = '${STU}'`,
    ];
    for (const sql of attempts) await assert.rejects(as(db, STU, () => db.query(sql)), /permission denied/);
    await assert.rejects(as(db, STU, () => db.query(`SELECT * FROM public.coin_balance('${STU}')`)), /permission denied/);
  });

  it('buying with too few coins is refused and changes nothing', async () => {
    const b = await balance(db, STU);
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.avatar_buy('headwear.crown')`)), /more coins/);
    assert.equal(await balance(db, STU), b);
    assert.equal(Number((await one(db, `SELECT count(*) c FROM public.student_avatar_items WHERE student_id = $1 AND item_key = 'headwear.crown'`, [STU])).c), 0);
  });

  it('the ledger guard refuses any spend that would go negative, even from a trusted writer', async () => {
    const b = await balance(db, STU);
    await assert.rejects(db.query(`INSERT INTO public.student_coin_ledger (student_id, delta, reason, ref) VALUES ($1, $2, 'adjust', 'test:overspend')`, [STU, -(b + 1)]), /Not enough coins/);
    assert.equal(await balance(db, STU), b);
  });

  it('buying the same item twice charges once', async () => {
    await practise(db, STU, 2000); // +200 coins
    const b = await balance(db, STU);
    const a = (await as(db, STU, () => one(db, `SELECT public.avatar_buy('hair.spiky') r`))).r;
    const again = (await as(db, STU, () => one(db, `SELECT public.avatar_buy('hair.spiky') r`))).r;
    assert.equal(a.already, false);
    assert.equal(again.already, true);
    assert.equal(await balance(db, STU), b - 60);
    assert.equal(Number((await one(db, `SELECT count(*) c FROM public.student_coin_ledger WHERE student_id = $1 AND ref = 'buy:hair.spiky'`, [STU])).c), 1);
    // Free items are never charged.
    const free = (await as(db, STU, () => one(db, `SELECT public.avatar_buy('headwear.hijab') r`))).r;
    assert.equal(free.already, true);
    assert.equal(await balance(db, STU), b - 60);
  });

  it('saving an avatar checks ownership and returns the same token as the browser', async () => {
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.avatar_save($1::jsonb)`, [JSON.stringify({ ...LOOK, headwear: 'crown' })])), /not yours yet/);
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.avatar_save($1::jsonb)`, [JSON.stringify({ ...LOOK, accessories: ['freckles', 'star', 'glasses'] })])), /up to 2/);
    const r = (await as(db, STU, () => one(db, `SELECT public.avatar_save($1::jsonb) r`, [JSON.stringify(LOOK)]))).r;
    assert.equal(r.mode, 'avatar');
    assert.equal(r.token, lookToken(LOOK));
    assert.deepEqual(parseLookToken(r.token), { ...LOOK });
  });

  it('avatar_visible shows the avatar when chosen, and the old photo rules otherwise', async () => {
    const token = lookToken(LOOK);
    const seen = async (viewer) => (await as(db, viewer, () => one(db, `SELECT public.my_avatar($1) v`, [STU]))).v;
    assert.equal(await seen(STU), token);
    await db.exec(`UPDATE public.test_rules SET leaderboard_names = 'student_code'`);
    const asOther = (await as(db, STU2, () => one(db, `SELECT public.avatar_visible($1, $2) v`, [STU, PHOTO]).catch(() => null)));
    assert.equal(asOther, null, 'avatar_visible is not callable by students directly');
    const direct = (await one(db, `SELECT public.avatar_visible($1, $2) v`, [STU, PHOTO])).v;
    assert.equal(direct, null, 'no signed-in user sees nothing');
    await as(db, STU, () => db.query(`SELECT public.avatar_save(NULL, 'photo')`));
    assert.equal(await seen(STU), PHOTO, 'own photo when photo is chosen');
    await as(db, STU, () => db.query(`SELECT public.avatar_save(NULL, 'avatar')`));
    await db.exec(`UPDATE public.test_rules SET leaderboard_names = 'full_name'`);
  });

  it('a student without a saved look cannot switch to avatar', async () => {
    await assert.rejects(as(db, STU2, () => db.query(`SELECT public.avatar_save(NULL, 'avatar')`)), /Build your avatar first/);
    const st = (await as(db, STU2, () => one(db, 'SELECT public.avatar_store_state() s'))).s;
    assert.equal(st.style.mode, 'photo');
  });

  it('titles are earned, never bought; showcase holds up to 3 earned badges', async () => {
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.profile_style_save('default', 'plain', 'speed_demon', '{}')`)), /Earn that title first/);
    await db.exec(`INSERT INTO public.student_badges VALUES ('${STU}', 'pb_10'), ('${STU}', 'first_round')`);
    await as(db, STU, () => db.query(`SELECT public.profile_style_save('default', 'plain', 'speed_demon', '{pb_10,first_round}')`));
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.profile_style_save('default', 'plain', NULL, '{streak_30}')`)), /badges you have earned/);
    await assert.rejects(as(db, STU, () => db.query(`SELECT public.profile_style_save('rainbow', 'plain', NULL, '{}')`)), /not yours yet/);
    assert.equal(Number((await one(db, `SELECT count(*) c FROM public.avatar_items WHERE slot = 'title'`)).c), 0);
    const st = (await as(db, STU, () => one(db, 'SELECT public.avatar_store_state() s'))).s;
    assert.equal(st.style.title, 'speed_demon');
    assert.deepEqual(st.style.showcase, ['pb_10', 'first_round']);
  });

  it('division titles need 25 accurate division rounds', async () => {
    const has = async () => (await one(db, `SELECT 'division_king' IN (SELECT public.titles_unlocked($1)) v`, [STU])).v;
    for (let i = 0; i < 24; i++) await practise(db, STU, 1, { activity_key: 'cat:division:t60', label: 'Division', correct: 9, total: 10 });
    assert.equal(await has(), false);
    await practise(db, STU, 1, { activity_key: 'cat:x:t60', label: 'Division', correct: 8, total: 10 });
    assert.equal(await has(), false, '80% does not count');
    await practise(db, STU, 1, { activity_key: 'cat:division:t60', label: 'Division', correct: 10, total: 10 });
    assert.equal(await has(), true);
  });

  it('hides card facts until the card is found, and teachers can view a student', async () => {
    const st = (await as(db, TEACHER, () => one(db, 'SELECT public.avatar_store_state($1) s', [STU]))).s;
    assert.equal(st.is_self, false);
    assert.equal(st.cards.length, 24);
    assert.ok(st.cards.every((c) => (c.copies > 0) === (c.fact !== null)));
    await assert.rejects(as(db, STU2, () => db.query('SELECT public.avatar_store_state($1)', [STU])), /Access denied/);
  });

  it('chest odds add up to 100% and match the browser copy', async () => {
    const odds = (await one(db, 'SELECT public.chest_odds() o')).o;
    assert.deepEqual(odds, CHEST_ODDS);
    for (const k of ['daily', 'weekly', 'levelup']) {
      assert.equal(Object.values(odds[k].rarity).reduce((a, b) => a + b, 0), 100, k);
    }
  });

  it('the browser catalogue copy matches the database exactly', async () => {
    const items = (await db.query('SELECT key, name, cost FROM public.avatar_items ORDER BY slot, sort_order, key')).rows.map((r) => [r.key, r.name, r.cost]);
    assert.deepEqual(items, ITEMS);
    const cards = (await db.query('SELECT key, number, name, rarity, subtitle, fact FROM public.collectible_cards ORDER BY number')).rows.map((r) => [r.key, r.number, r.name, r.rarity, r.subtitle, r.fact]);
    assert.deepEqual(cards, CARDS);
    const titles = (await db.query('SELECT key, name, how, badge_key, rule FROM public.title_catalogue ORDER BY sort_order')).rows.map((r) => [r.key, r.name, r.how, r.badge_key, r.rule]);
    assert.deepEqual(titles, TITLES);
  });
});

describe('avatar art', () => {
  it('draws every item in the catalogue and every card', () => {
    for (const [key] of ITEMS) {
      const [slot, value] = key.split('.');
      assert.ok(ART_VALUES[slot]?.includes(value), `no art for ${key}`);
    }
    for (const [key] of CARDS) assert.ok(CARD_ART[key], `no art for card ${key}`);
    assert.equal(Object.keys(CARD_ART).length, CARDS.length);
  });

  it('keeps free choices for every skin tone and hijab, turban and patka', () => {
    const free = new Set(ITEMS.filter((i) => i[2] === 0).map((i) => i[0]));
    for (const k of ['headwear.hijab', 'headwear.turban', 'headwear.patka', 'headwear.none']) assert.ok(free.has(k), k);
    assert.ok(!ITEMS.some(([k]) => k.startsWith('skin')), 'skin tones are never sold');
  });

  it('keeps card facts short and the art free of outside images', () => {
    for (const c of CARDS) assert.ok(c[5].length <= 320, c[0]);
    for (const [key] of CARDS) {
      const svg = cardArtSvg(key, key);
      assert.ok(svg.startsWith('<svg'), key);
      assert.ok(!/<image|href=["']http|xlink:href/i.test(svg), `${key} must not load outside images`);
    }
  });

  it('round-trips tokens and turns them into image URLs', () => {
    const t = lookToken({ ...LOOK, accessories: ['glasses', 'freckles'] });
    assert.equal(t, 'look:1|4|curly|black|kurta|green|hijab|teal|freckles+glasses|mint|none');
    assert.ok(isLookToken(t));
    assert.ok(!isLookToken(`${STU}/abc.jpg`));
    assert.ok(!isLookToken('look:1|<script>'));
    assert.match(lookTokenDataUri(t), /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    assert.equal(lookTokenDataUri('nope'), null);
  });

  it('hides hair under the hijab and draws every part combination', () => {
    const withHijab = avatarSvg({ ...LOOK, hair: 'afro', hair_color: 'pink' });
    assert.ok(!withHijab.includes('#EC6FA9'), 'hair is hidden under a hijab');
    for (const hair of ART_VALUES.hair) for (const headwear of ART_VALUES.headwear) {
      const svg = avatarSvg({ ...LOOK, hair, headwear, accessories: ['glasses', 'pencil'] });
      assert.ok(svg.endsWith('</svg>') && !svg.includes('undefined'), `${hair}/${headwear}`);
    }
  });
});
