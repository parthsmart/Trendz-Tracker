import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildProgressCardHtml, levelName, rankLine, tierIcon } from '../js/xpRewards.js';
import { buildStarsHtml, shortDateRange } from '../js/homeGamify.js';
import { boardTitle } from '../js/leaderboardView.js';
import { buildPodiumHtml, podiumOrder } from '../js/leaderboardPodium.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('naming: a class level always reads as a level, never as a tier', () => {
  assert.equal(levelName('Master'), 'Master level');
  assert.equal(levelName('Level 2'), 'Level 2');
  assert.equal(levelName(''), 'your level');
  assert.equal(levelName(null), 'your level');
  assert.equal(tierIcon('Elite'), '👑');
  assert.equal(tierIcon('Master'), '👑', 'old saved season results still get an icon');
});

test('naming: home XP card says which level the ranks are in', () => {
  const html = buildProgressCardHtml({
    season_xp: 1200,
    tier: { name: 'Gold', floor: 1000, next_name: 'Platinum', next_floor: 2500 },
    week_rank: { rank: 2, of: 4, level: 'Master' },
    season_rank: { rank: 3, of: 9, level: 'Master' },
  }, []);
  assert.match(html, /of 4 · Master level/);
  assert.match(html, /of 9 · Master level/);
  assert.match(html, /This week's XP board · Master level/);
  assert.equal(rankLine({ rank: 2, of: 4, level: 'Master', gap: 18, above_name: 'Riya S.' }),
    '🏆 #2 of 4 in Master level this week · 18 XP behind Riya S.');
  assert.equal(rankLine({ rank: 1, level: 'Level 3' }), '🏆 #1 in Level 3 this week. You are on top!');
});

test('naming: stars card says the champion is from last week, with dates', () => {
  assert.equal(shortDateRange('2026-11-16', '2026-11-22'), '16–22 Nov');
  assert.equal(shortDateRange('2026-10-27', '2026-11-02'), '27 Oct – 2 Nov');
  assert.equal(shortDateRange(null, '2026-11-02'), '');
  const html = buildStarsHtml({
    level: 'Master',
    month: { label: 'October 2026', winners: [{ display_name: 'A B.', xp: 900 }] },
    week: { from: '2026-11-16', to: '2026-11-22', winners: [{ display_name: 'C D.', xp: 306 }] },
  });
  assert.match(html, /Stars of Master level/);
  assert.match(html, /Star of last month · October 2026/);
  assert.match(html, /Champion of last week · 16–22 Nov/);
  assert.doesNotMatch(html, /Champion of the Week/);
});

test('naming: XP leaderboard calls the month a season and all time the career', () => {
  assert.match(boardTitle('xp', 'month', 'global'), /^XP - This season - Global/);
  assert.match(boardTitle('xp', 'all', 'global'), /^XP - Career \(all time\) - Global/);
  assert.match(boardTitle('xp', 'week', 'global'), /^XP - This week - /);
  assert.match(boardTitle('points', 'month', 'global'), /This month/, 'other boards keep their words');
  const lb = read('../js/leaderboard.js');
  assert.match(lb, /XP_PERIOD_LABELS\[choice\]/);
  assert.equal((lb.match(/\$\{buildRowDataAttrs\(row\)\}/g) || []).length, 3, 'every board row carries its name');
});

test('naming: migration renames the Master tier to Elite and keeps badge keys', () => {
  const sql = read('../supabase/migrations/28_phase28_tier_naming.sql');
  assert.match(sql, /\('Elite', 9000, 6\)/);
  assert.match(sql, /\('Elite', 30000, 6\)/);
  assert.doesNotMatch(sql, /'Master', \d+, 6/);
  assert.match(sql, /UPDATE public\.xp_season_results SET tier = 'Elite' WHERE tier = 'Master'/);
  assert.match(sql, /\('tier_master', 'Elite tier'/, 'badge key unchanged, name fixed');
  assert.match(sql, /COALESCE\(v\.d, badge_catalogue\.description\)/);
  assert.match(read('../js/fullBackup.js'), /'28_phase28_tier_naming'/);
});

test('podium: #1 in the middle, #2 and #3 beside it, #4 and #5 outside', () => {
  const ranks = (n) => podiumOrder(n).map((i) => i + 1);
  assert.deepEqual(ranks(5), [4, 2, 1, 3, 5]);
  assert.deepEqual(ranks(4), [4, 2, 1, 3]);
  assert.deepEqual(ranks(3), [2, 1, 3]);
  assert.deepEqual(ranks(2), [2, 1]);
  assert.deepEqual(ranks(1), [1]);
  assert.deepEqual(ranks(0), []);
  assert.deepEqual(ranks(9), [4, 2, 1, 3, 5]);
});

test('podium: real names, photos, level chip and You, no initials as names', () => {
  const rows = [1, 2, 3, 4, 5].map((rank) => ({
    rank, name: `Student ${rank}`, value: `${600 - rank * 100}`, level: rank === 2 ? 'Master' : '', photo: rank === 1 ? 'https://x/p.jpg' : '', me: rank === 3,
  }));
  const html = buildPodiumHtml(rows, 'XP');
  const order = [...html.matchAll(/lb-place-(\d)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [4, 2, 1, 3, 5]);
  for (let r = 1; r <= 5; r += 1) assert.match(html, new RegExp(`<b class="lb-name">Student ${r}</b>`));
  assert.match(html, /<img src="https:\/\/x\/p\.jpg"/);
  assert.match(html, /<span class="lb-level">Master<\/span>/);
  assert.equal((html.match(/lb-crown/g) || []).length, 1);
  assert.equal((html.match(/class="lb-you"/g) || []).length, 1);
  assert.match(html, /lb-place-3 is-me/);
  assert.match(buildPodiumHtml([{ rank: 1, name: '<b>', value: '1', me: false }], 'XP'), /&lt;b&gt;/);
});

test('podium: rows below never get a second avatar', () => {
  const src = read('../js/leaderboardPodium.js');
  assert.match(src, /querySelector\('\.lb-av, \.tt-av'\)/);
  assert.match(src, /getAttribute\('data-name'\)/);
});
