/**
 * Phase 3 gamification: leagues, duels, class vs class, reward shop, certificates.
 * Pure functions only; rankings, winners and balances come from the database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DUEL_SECONDS, DUELS_PER_DAY, duelSide, isUuid, newDuelSeed } from '../api/_duels.js';
import { createSeededRng, generateBasicsSet } from '../api/_drills.js';
import {
  buildArenaSummaryHtml,
  buildCertificateModel,
  buildClassVsClassHtml,
  buildDuelFormHtml,
  buildDuelListHtml,
  buildLeagueHtml,
  buildRewardAdminHtml,
  buildRewardShopHtml,
  duelStatusText,
  leagueLastText,
  parseRewardItemForm,
  zoneLabel,
} from '../js/arenaView.js';
import { buildBadgeWallHtml, certificateHref } from '../js/profileView.js';
import { NAV_CONFIG } from '../js/navConfig.js';
import { SETTINGS_ENTRIES } from '../js/settingsHub.js';
import { FULL_BACKUP_KNOWN_TABLES } from '../js/fullBackup.js';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TIERS = [
  { tier: 1, name: 'Sprout', icon: '🌱', students: 9 },
  { tier: 2, name: 'Sapling', icon: '🌿', students: 5 },
  { tier: 3, name: 'Oak', icon: '🌳', students: 0 },
];

describe('duels', () => {
  it('are 1-minute rounds with a daily limit', () => {
    assert.equal(DUEL_SECONDS, 60);
    assert.equal(DUELS_PER_DAY, 3);
  });

  it('knows which side a student is on', () => {
    const duel = { challenger_id: A, opponent_id: B };
    assert.equal(duelSide(duel, A), 'c');
    assert.equal(duelSide(duel, B), 'o');
    assert.equal(duelSide(duel, 'someone-else'), null);
    assert.equal(duelSide(null, A), null);
  });

  it('validates ids and makes 32-bit seeds', () => {
    assert.equal(isUuid(A), true);
    assert.equal(isUuid('nope'), false);
    assert.equal(newDuelSeed(() => 0), 0);
    const top = newDuelSeed(() => 0.999999999);
    assert.ok(Number.isInteger(top) && top > 4294967000 && top <= 4294967295);
  });

  it('gives both players the same questions', () => {
    const seed = newDuelSeed();
    assert.deepEqual(
      generateBasicsSet('2D 4R', 30, createSeededRng(seed)),
      generateBasicsSet('2D 4R', 30, createSeededRng(seed))
    );
  });

  it('describes duel states kindly', () => {
    assert.equal(duelStatusText({ status: 'open', my_started: false, other_done: true }), 'Your classmate has played — your turn!');
    assert.match(duelStatusText({ status: 'open', my_done: true, other_done: false }), /Waiting/);
    assert.match(duelStatusText({ status: 'done', result: 'won' }), /won/);
    assert.match(duelStatusText({ status: 'done', result: 'lost' }), /classmate won/);
    assert.match(duelStatusText({ status: 'done', result: 'draw' }), /Draw/);
    assert.match(duelStatusText({ status: 'declined', role: 'challenger' }), /declined/);
  });

  it('hides the other score until I have played and offers play / cancel', () => {
    const html = buildDuelListHtml([
      { id: A, role: 'opponent', other_name: '<Asha>', category_name: '2d4r', status: 'open', expires_at: '2026-11-30T10:00:00Z',
        my_started: false, my_done: false, other_done: true, other_correct: null, other_total: null },
    ]);
    assert.match(html, /&lt;Asha&gt;/);
    assert.match(html, /✔ played/);
    assert.match(html, new RegExp(`duel=${A}`));
    assert.doesNotMatch(html, /data-duel-cancel/, 'cannot decline after the other side played');
    assert.match(buildDuelListHtml([]), /No duels yet/);
  });

  it('builds the challenge form and respects the daily limit', () => {
    const options = { opponents: [{ id: B, display_name: 'Ravi' }, { id: A, display_name: 'Busy', busy: true }], categories: [{ id: A, name: '1d4r' }], created_today: 3, daily_limit: 3 };
    const html = buildDuelFormHtml(options);
    assert.match(html, /Ravi/);
    assert.doesNotMatch(html, /Busy/);
    assert.match(html, /disabled/);
    assert.match(html, /send 0 more today/);
    assert.match(buildDuelFormHtml({ opponents: [], categories: [] }), /nobody else/);
  });
});

describe('leagues', () => {
  it('never shows someone else dropping', () => {
    assert.equal(zoneLabel('down', false), '');
    assert.match(zoneLabel('down', true), /Earn XP to stay/);
    assert.match(zoneLabel('up', false), /Moving up/);
  });

  it('renders my group with zones and avatars', () => {
    const html = buildLeagueHtml({
      member: true, tier: 2, tiers: TIERS, week: { from: '2026-11-23', to: '2026-11-29' },
      rows: [
        { rank: 1, display_name: 'Ravi', xp: 300, zone: 'up', is_me: false },
        { rank: 2, display_name: 'Me', xp: 0, zone: 'down', is_me: true },
      ],
      last: { tier_before: 1, tier_after: 2, rank: 1, group_size: 9 },
    });
    assert.match(html, /Sapling league/);
    assert.match(html, /Moving up/);
    assert.match(html, /Earn XP to stay/);
    assert.match(html, /Promoted to 🌿 Sapling/);
    assert.match(html, /is-current/);
    assert.match(buildLeagueHtml({ member: false }), /leaderboard/);
  });

  it('words last week kindly', () => {
    assert.match(leagueLastText({ tier_before: 2, tier_after: 1, rank: 9, group_size: 9 }, TIERS), /lift you back up/);
    assert.match(leagueLastText({ tier_before: 1, tier_after: 1 }, TIERS), /stayed/);
    assert.equal(leagueLastText(null, TIERS), '');
  });
});

describe('class vs class', () => {
  it('compares average XP and marks my class', () => {
    const html = buildClassVsClassHtml({ period: 'week', from: '2026-11-23', to: '2026-11-29', classes: [
      { rank: 1, level: 'Level 2', avg_xp: 200, students: 3, active: 2 },
      { rank: 2, level: 'Master', avg_xp: 50, students: 8, active: 2, is_mine: true },
    ] });
    assert.match(html, /average XP per student/);
    assert.match(html, /Master \(your class\)/);
    assert.match(html, /width:100%/);
    assert.match(html, /width:25%/);
    assert.match(buildClassVsClassHtml({ classes: [] }), /No classes/);
  });
});

describe('reward shop', () => {
  const shop = {
    can_request: true, earned: 500, spent: 100, balance: 400,
    items: [
      { id: 1, name: 'Pencil', icon: '✏️', cost: 300, stock: null },
      { id: 2, name: 'Medal', icon: '🏅', cost: 1000, stock: 4 },
      { id: 3, name: 'Sticker', icon: '⭐', cost: 50, stock: 0 },
    ],
    redemptions: [{ id: 9, name: 'Eraser', icon: '🧽', cost: 100, status: 'requested', requested_at: '2026-11-26T10:00:00Z' }],
  };

  it('shows what I can afford, what I still need and what is waiting', () => {
    const html = buildRewardShopHtml(shop);
    assert.match(html, /data-reward="1"/);
    assert.match(html, /600 XP to go/);
    assert.match(html, /Out of stock/);
    assert.match(html, /never lowers your level/);
    assert.match(html, /data-reward-cancel="9"/);
    assert.doesNotMatch(buildRewardShopHtml({ ...shop, can_request: false }), /data-reward=/);
  });

  it('lists waiting requests for admins', () => {
    const html = buildRewardAdminHtml({ items: [{ id: 1, name: 'Pencil', icon: '✏️', cost: 300, stock: null, active: true, given: 2 }],
      requests: [{ id: 5, name: 'Pencil', icon: '✏️', cost: 300, status: 'requested', student_name: 'Asha', requested_at: '2026-11-26T10:00:00Z' }] });
    assert.match(html, /Requests waiting \(1\)/);
    assert.match(html, /data-decide="given" data-id="5"/);
    assert.match(html, /unlimited · 2 given/);
  });

  it('validates the item form', () => {
    assert.equal(parseRewardItemForm({ name: '', cost: 5 }).ok, false);
    assert.equal(parseRewardItemForm({ name: 'Pen', cost: 0 }).ok, false);
    assert.equal(parseRewardItemForm({ name: 'Pen', cost: 5, stock: '-1' }).ok, false);
    assert.deepEqual(parseRewardItemForm({ name: ' Pen ', cost: '50', stock: '', icon: '' }).value,
      { name: 'Pen', icon: '🎁', description: '', cost: 50, stock: null, active: true });
  });
});

describe('home card and certificates', () => {
  it('summarises the arena on the home page', () => {
    const html = buildArenaSummaryHtml({ league: { icon: '🌿', name: 'Sapling', rank: 2, size: 5, zone: 'up' }, duels_to_play: 1, reward_balance: 400, rewards_available: 2 });
    assert.match(html, /Sapling league · #2 of 5 · ⬆️ moving up/);
    assert.match(html, /1 duel to play/);
    assert.match(html, /400 XP to spend/);
    assert.equal(buildArenaSummaryHtml(null), '');
  });

  const profile = {
    profile: { full_name: 'Asha Kumar', level: 'Level 2' },
    badges: [
      { key: 'tier_gold', name: 'Gold tier', icon: '🥇', description: 'Reach Gold.', category: 'rank', earned_at: '2026-11-20T10:00:00Z' },
      { key: 'star_month', name: 'Star of the Month', icon: '🌟', description: 'Top of the month.', category: 'award', earned_at: '2026-11-01T10:00:00Z' },
      { key: 'tier_master', name: 'Master tier', icon: '👑', description: 'Reach Master.', category: 'rank', earned_at: null },
      { key: 'first_round', name: 'First steps', icon: '👣', description: 'x', category: 'practice', earned_at: '2026-11-01T10:00:00Z' },
    ],
    awards: [{ kind: 'month', from: '2026-10-01', to: '2026-10-31' }],
  };

  it('builds certificates only for earned badges', () => {
    const gold = buildCertificateModel(profile, 'tier_gold');
    assert.equal(gold.name, 'Asha Kumar');
    assert.equal(gold.title, 'Gold tier');
    assert.match(gold.date, /20 November 2026/);
    assert.match(buildCertificateModel(profile, 'star_month').detail, /Star of the Month · 1 Oct – 31 Oct/);
    assert.equal(buildCertificateModel(profile, 'tier_master'), null);
    assert.equal(buildCertificateModel(null, 'tier_gold'), null);
  });

  it('links certificates from the badge wall for tiers, awards and leagues', () => {
    const html = buildBadgeWallHtml(profile.badges, { studentId: A });
    assert.equal((html.match(/pf-cert/g) || []).length, 2);
    assert.match(html, new RegExp(`badge=tier_gold&amp;student=${A}`));
    assert.equal(certificateHref('league_up'), '/pages/certificate.html?badge=league_up');
  });
});

describe('wiring', () => {
  it('adds the arena to the student menu and the admin settings hub', () => {
    const item = NAV_CONFIG.student.find((i) => i.id === 'student-arena');
    assert.equal(item?.href, '/pages/arena.html');
    assert.equal(item?.desktopPlacement, 'menu-only');
    assert.ok(SETTINGS_ENTRIES.some((e) => e.href === '/pages/arena.html'));
  });

  it('backs up the new tables and builds the new pages', () => {
    for (const t of ['duels', 'league_results', 'league_tiers', 'league_weeks', 'reward_items', 'reward_redemptions', 'student_leagues']) {
      assert.ok(FULL_BACKUP_KNOWN_TABLES.includes(t), t);
    }
    const vite = fs.readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    assert.match(vite, /pages\/arena\.html/);
    assert.match(vite, /pages\/certificate\.html/);
  });

  it('keeps the drill API to one function file', () => {
    const files = fs.readdirSync(new URL('../api/', import.meta.url)).filter((f) => f.endsWith('.js') && !f.startsWith('_'));
    assert.ok(files.length <= 12, `Vercel Hobby allows 12 functions, found ${files.length}`);
  });
});
