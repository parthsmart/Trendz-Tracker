/**
 * Trendz Tracker - coins, avatar items, chests and cards: data calls (js/avatarStore.js)
 *
 * Every grant and purchase happens in the database (avatar_buy, avatar_save,
 * profile_style_save, chest_claim). The browser only asks and shows the answer.
 * Without a database (local demo) a small in-browser stand-in follows the same rules,
 * so the pages can be tried out; it never runs on the live site.
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { ITEMS, CARDS, TITLES, CHEST_ODDS } from '../shared/avatarCatalogue.js';
import { lookToken, normalizeLook } from '../shared/avatarArt.js';

async function rpc(name, args = {}) {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('The database is not connected.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'Something went wrong.');
  return data;
}

const online = () => isSupabaseConfigured();

/** Everything the shop and profile need. Throws a readable Error. */
export async function loadAvatarState(studentId = null) {
  if (!online()) return demo.state();
  return rpc('avatar_store_state', { p_student: studentId });
}

export async function buyAvatarItem(itemKey) {
  if (!online()) return demo.buy(itemKey);
  return rpc('avatar_buy', { p_item: itemKey });
}

/** Saves the look (or null to keep it) and which picture to show ('photo' | 'avatar' | null). */
export async function saveAvatarLook(look, mode = null) {
  if (!online()) return demo.save(look, mode);
  return rpc('avatar_save', { p_look: look, p_mode: mode });
}

export async function saveProfileStyle({ nameColor, banner, title, showcase }) {
  if (!online()) return demo.style(nameColor, banner, title, showcase);
  return rpc('profile_style_save', { p_name_color: nameColor, p_banner: banner, p_title: title || null, p_showcase: showcase || [] });
}

/** Opens a chest. Repeat calls with the same period return the same contents. */
export async function claimChest(kind, period = null) {
  if (!online()) return demo.claim(kind, period);
  return rpc('chest_claim', { p_kind: kind, p_period: period });
}

/** The picture a student shows: avatar token, photo path, or null. */
export async function shownAvatarRef(studentId = null, photoPath = null) {
  if (!online()) return demo.shown(photoPath);
  try {
    const ref = await rpc('my_avatar', { p_student: studentId });
    return ref || null;
  } catch {
    return photoPath || null;
  }
}

// ---------------------------------------------------------------------------
// Local demo stand-in (no database). Same rules, kept in localStorage.
// ---------------------------------------------------------------------------
const DEMO_KEY = 'tt_demo_avatar_store_v1';
const demo = {
  load() {
    let s = null;
    try { s = JSON.parse(globalThis.localStorage?.getItem(DEMO_KEY) || 'null'); } catch { s = null; }
    return s || { earned: 340, ledger: [], owned: [], style: { mode: 'photo', look: null, token: null, name_color: 'default', banner: 'plain', title: null, showcase: [] }, cards: {}, claims: {} };
  },
  put(s) { try { globalThis.localStorage?.setItem(DEMO_KEY, JSON.stringify(s)); } catch { /* demo only */ } },
  balance(s) { return s.earned + s.ledger.reduce((a, r) => a + r.delta, 0); },
  owns(s, key) { const it = ITEMS.find((i) => i[0] === key); return !!it && (it[2] === 0 || s.owned.includes(key)); },
  today() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); },
  week() { const d = new Date(`${demo.today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); },
  badges: [['first_round', 'First round', '🎯'], ['pb_10', 'Record breaker', '⚡'], ['rounds_100', '100 rounds', '💯']],
  chests(s) {
    const month = demo.today().slice(0, 7);
    const rank = 3;
    let next = null;
    for (let r = 2; r <= rank; r++) if (!s.claims[`levelup|${month}:tier${r}`]) { next = r; break; }
    const quests = [
      { key: 'days', label: 'Practise on 4 different days', goal: 4, done: 4 },
      { key: 'rounds', label: 'Finish 15 rounds', goal: 15, done: 15 },
      { key: 'variety', label: 'Practise 2 different kinds of event', goal: 2, done: 2 },
    ];
    return {
      daily: { period: `day:${demo.today()}`, ready: true, claimed: !!s.claims[`daily|day:${demo.today()}`] },
      weekly: { period: `week:${demo.week()}`, ready: true, quests, claimed: !!s.claims[`weekly|week:${demo.week()}`] },
      levelup: { period: next ? `${month}:tier${next}` : null, ready: !!next, claimed: false, next_tier_rank: next, season_xp: 1240, tier: { name: 'Gold', rank, next_name: 'Platinum', next_floor: 2500, floor: 1000 } },
    };
  },
  state() {
    const s = demo.load();
    const titlesEarned = new Set(TITLES.filter((t) => demo.badges.some((b) => b[0] === t[3])).map((t) => t[0]));
    return {
      is_self: true,
      demo: true,
      coins: { balance: demo.balance(s), practice: s.earned, ledger: demo.balance(s) - s.earned },
      has_photo: false,
      style: { ...s.style },
      items: ITEMS.map(([key, name, cost]) => ({ key, slot: key.split('.')[0], name, cost, owned: cost === 0 || s.owned.includes(key) })),
      titles: TITLES.map(([key, name, how]) => ({ key, name, how, earned: titlesEarned.has(key) })),
      badges: demo.badges.map(([key, name, icon]) => ({ key, name, icon })),
      cards: CARDS.map(([key, number, name, rarity, subtitle, fact]) => ({ key, number, name, rarity, subtitle, fact: s.cards[key] ? fact : null, copies: s.cards[key] || 0 })),
      chests: demo.chests(s),
      odds: CHEST_ODDS,
      recent: [],
    };
  },
  buy(key) {
    const s = demo.load();
    const it = ITEMS.find((i) => i[0] === key);
    if (!it) throw new Error('This item is not in the shop.');
    if (demo.owns(s, key)) return { item: key, owned: true, already: true, balance: demo.balance(s) };
    if (demo.balance(s) < it[2]) throw new Error(`You need ${it[2] - demo.balance(s)} more coins for this.`);
    s.ledger.push({ delta: -it[2], ref: `buy:${key}` });
    s.owned.push(key);
    demo.put(s);
    return { item: key, owned: true, already: false, balance: demo.balance(s) };
  },
  save(look, mode) {
    const s = demo.load();
    if (look) {
      const o = normalizeLook(look);
      for (const slot of ['hair', 'hair_color', 'outfit', 'outfit_color', 'headwear', 'headwear_color', 'background', 'frame']) {
        if (!demo.owns(s, `${slot}.${o[slot]}`)) throw new Error(`That ${slot.replace('_', ' ')} is not yours yet.`);
      }
      if (o.accessories.some((a) => !demo.owns(s, `accessory.${a}`))) throw new Error('That accessory is not yours yet.');
      s.style.look = o;
      s.style.token = lookToken(o);
    }
    s.style.mode = mode || (look ? 'avatar' : s.style.mode);
    if (s.style.mode === 'avatar' && !s.style.token) throw new Error('Build your avatar first.');
    demo.put(s);
    return { mode: s.style.mode, token: s.style.token };
  },
  style(nameColor, banner, title, showcase) {
    const s = demo.load();
    if (!demo.owns(s, `name_color.${nameColor}`)) throw new Error('That name colour is not yours yet.');
    if (!demo.owns(s, `banner.${banner}`)) throw new Error('That banner is not yours yet.');
    const st = demo.state();
    if (title && !st.titles.find((t) => t.key === title && t.earned)) throw new Error('Earn that title first.');
    const show = [...new Set(showcase || [])];
    if (show.length > 3) throw new Error('Pick up to 3 badges.');
    if (show.some((b) => !demo.badges.some((x) => x[0] === b))) throw new Error('You can only show badges you have earned.');
    Object.assign(s.style, { name_color: nameColor, banner, title: title || null, showcase: show });
    demo.put(s);
    return { name_color: nameColor, banner, title, showcase: show };
  },
  claim(kind, period) {
    const s = demo.load();
    const st = demo.chests(s)[kind];
    if (!st) throw new Error('Unknown chest.');
    const p = period || st.period;
    if (s.claims[`${kind}|${p}`]) return { ...s.claims[`${kind}|${p}`], already: true, balance: demo.balance(s) };
    if (!st.ready || p !== st.period) throw new Error('This chest is not ready yet.');
    const cfg = CHEST_ODDS[kind];
    const coins = kind === 'levelup' ? cfg.coins_per_tier * st.next_tier_rank : cfg.coins_min + Math.floor(Math.random() * (cfg.coins_max - cfg.coins_min + 1));
    let card = null; let dup = false; let dupCoins = 0;
    if (Math.random() * 100 < cfg.card_chance) {
      let roll = Math.random() * 100; let rarity = 'common';
      for (const r of ['legendary', 'epic', 'rare', 'common']) { roll -= cfg.rarity[r]; if (roll < 0) { rarity = r; break; } }
      const pool = CARDS.filter((c) => c[3] === rarity);
      const c = pool[Math.floor(Math.random() * pool.length)];
      dup = !!s.cards[c[0]];
      dupCoins = dup ? CHEST_ODDS.duplicate_coins[rarity] : 0;
      s.cards[c[0]] = (s.cards[c[0]] || 0) + 1;
      card = { key: c[0], number: c[1], name: c[2], rarity: c[3], subtitle: c[4], fact: c[5] };
    }
    const result = { kind, period: p, coins, card, duplicate: dup, duplicate_coins: dupCoins };
    s.claims[`${kind}|${p}`] = result;
    s.ledger.push({ delta: coins + dupCoins, ref: `chest:${kind}:${p}` });
    demo.put(s);
    return { ...result, already: false, balance: demo.balance(s) };
  },
  shown(photoPath) {
    const s = demo.load();
    return s.style.mode === 'avatar' && s.style.token ? s.style.token : photoPath || null;
  },
};
