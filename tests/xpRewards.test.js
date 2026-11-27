import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXpHtml,
  formatXp,
  tierProgress,
  dailyFactorNote,
  streakLine,
  rankLine,
  buildRoundCardHtml,
  buildProgressCardHtml,
  buildSeasonRecapHtml,
  careerXp,
  seasonLine,
  seasonName,
  seasonXp,
} from '../js/xpRewards.js';
import { bestSeasonText, buildSeasonHistoryHtml, buildStatsHtml, buildParentSummaryText } from '../js/profileView.js';
import fs from 'node:fs';
import { formatBoardValue, boardUsesPeriod, BOARD_LABELS } from '../js/leaderboardView.js';

const totals = {
  total_xp: 1500,
  week_xp: 120,
  today_xp: 40,
  tier: { name: 'Silver', floor: 1000, next_name: 'Gold', next_floor: 3000 },
  streak: { current: 4, best: 9, shields: 1, active_today: true },
  week_rank: { rank: 3, of: 12, level: 'Basic 1', above_name: 'A. <b>', gap: 18 },
};

test('formatting helpers', () => {
  assert.equal(escapeXpHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(formatXp(12345.4), '12,345');
  assert.equal(formatXp(null), '0');
});

test('tier progress uses the RPC tier floors', () => {
  const p = tierProgress(1500, totals.tier);
  assert.equal(p.pct, 25);
  assert.equal(p.toNext, 1500);
  assert.equal(p.nextName, 'Gold');
  const top = tierProgress(90000, { name: 'Legend', floor: 75000, next_floor: null });
  assert.equal(top.pct, 100);
  assert.equal(top.nextName, null);
});

test('daily factor, streak and rank lines', () => {
  assert.equal(dailyFactorNote(1), '');
  assert.match(dailyFactorNote(0.5), /Half XP/);
  assert.match(dailyFactorNote(0.25), /Quarter XP/);
  assert.match(streakLine({ current: 0 }), /Start a streak/);
  assert.equal(streakLine({ current: 3, shields: 2 }), '🔥 3-day streak · 🛡️ 2 streak shields');
  assert.equal(rankLine({}), '');
  assert.match(rankLine({ rank: 1, level: 'Basic 1' }), /on top/);
  assert.match(rankLine(totals.week_rank), /18 XP behind A\. <b>/);
});

test('round card: nothing for an unrewarded round, PB details and escaping otherwise', () => {
  assert.equal(buildRoundCardHtml(null), '');
  assert.equal(buildRoundCardHtml({ ...totals, round: null }), '');
  const html = buildRoundCardHtml({
    ...totals,
    round: { xp: 55, bonus_xp: 25, personal_best: true, score: '18/20 in 1:05', prev_best: '16/20', daily_factor: 0.5 },
  });
  assert.match(html, /\+55 XP/);
  assert.match(html, /New personal best/);
  assert.match(html, /was 16\/20/);
  assert.match(html, /Half XP/);
  assert.match(html, /A\. &lt;b&gt;/);
  assert.doesNotMatch(html, /A\. <b>/);
  const first = buildRoundCardHtml({ ...totals, round: { xp: 20, first_best: true, score: '9/10' } });
  assert.match(first, /First score/);
});

test('progress card shows board rows, bests and the leaderboard link', () => {
  assert.equal(buildProgressCardHtml(null), '');
  const html = buildProgressCardHtml(
    { ...totals, bests: [{ label: 'Flash 2D', score: '10/10', day: '2026-11-20' }] },
    [{ rank: 1, display_name: '<i>x</i>', value: 300 }, { rank: 3, display_name: 'Me', value: 120, is_me: true }]
  );
  assert.match(html, /1,500 XP this season/);
  assert.match(html, /&lt;i&gt;x&lt;\/i&gt;/);
  assert.match(html, /Me \(you\)/);
  assert.match(html, /Flash 2D/);
  assert.match(html, /leaderboard\.html\?board=xp&amp;period=month/);
  const empty = buildProgressCardHtml({ ...totals, bests: [] }, []);
  assert.match(empty, /No XP earned/);
  assert.match(empty, /first personal best/);
});

test('leaderboard knows the XP board', () => {
  assert.equal(BOARD_LABELS.xp, 'XP');
  assert.equal(boardUsesPeriod('xp'), true);
  assert.equal(formatBoardValue('xp', 1234), '1,234 XP');
});

const seasonTotals = {
  ...totals,
  total_xp: 204397,
  lifetime_xp: 204397,
  season_xp: 1200,
  season: { from: '2026-11-01', to: '2026-11-30', days_left: 4 },
  tier: { name: 'Gold', floor: 1000, next_name: 'Platinum', next_floor: 2500 },
  season_rank: { rank: 2, of: 9, level: 'Basic 1' },
};

test('seasons: the month decides the tier, lifetime is the career number', () => {
  assert.equal(seasonXp(seasonTotals), 1200);
  assert.equal(careerXp(seasonTotals), 204397);
  assert.equal(seasonXp({ total_xp: 50 }), 50, 'older servers without season_xp still work');
  assert.equal(seasonXp({ season_xp: 0, total_xp: 9000 }), 0, 'a fresh season really is zero');
  assert.equal(seasonName('2026-11-01'), 'November 2026');
  assert.equal(seasonName('2026-03-01', { short: true }), 'March');
  assert.equal(seasonName('nope'), '');
  assert.equal(seasonLine(seasonTotals), '📅 November season · 4 days left');
  assert.equal(seasonLine({ season: { from: '2026-11-01', days_left: 1 } }), '📅 November season · last day!');
  assert.equal(seasonLine({}), '');
});

test('seasons: cards show season XP, season rank and career XP', () => {
  const card = buildProgressCardHtml(seasonTotals, []);
  assert.match(card, /1,200 XP this season/);
  assert.match(card, /Season rank/);
  assert.match(card, /#2/);
  assert.match(card, /November season · 4 days left/);
  assert.match(card, /Career 2,04,397 XP/);
  assert.match(card, /1,300 XP to/, 'progress is to the next season tier');
  const round = buildRoundCardHtml({ ...seasonTotals, round: { xp: 30 } });
  assert.match(round, /Gold · 1,200 season XP/);
  assert.doesNotMatch(round, /2,04,397/);
});

test('seasons: the daily curve note talks about all rounds of the day', () => {
  assert.match(dailyFactorNote(0.5), /20\+ rounds today/);
  assert.match(dailyFactorNote(0.25), /40\+ rounds today/);
});

test('seasons: recap of the month that just ended', () => {
  assert.equal(buildSeasonRecapHtml(null), '');
  assert.equal(buildSeasonRecapHtml({ season: '2026-10-01', rounds: 0, xp: 0 }), '', 'no recap when they did not play');
  const html = buildSeasonRecapHtml({
    season: '2026-10-01', xp: 5200, tier: { name: 'Diamond' }, rounds: 140, practice_days: 21, new_bests: 6,
    level: 'Basic <2>', level_rank: 1, level_size: 7, badges: [{ icon: '🥇', name: 'Gold rank' }],
  });
  assert.match(html, /Your October season/);
  assert.match(html, /Diamond · 5,200 XP/);
  assert.match(html, /#1 of 7 in Basic &lt;2&gt;/);
  assert.match(html, /Gold rank/);
  assert.match(html, /back to Bronze/);
});

test('seasons: profile history, best season and stats', () => {
  assert.match(buildSeasonHistoryHtml([]), /new season/);
  const list = buildSeasonHistoryHtml([
    { season: '2026-10-01', xp: 11630, tier: 'Master', level_rank: 1, level_size: 7 },
    { season: '2026-09-01', xp: 400, tier: 'Silver' },
  ]);
  assert.match(list, /October 2026/);
  assert.match(list, /Master/);
  assert.match(list, /11,630 XP · #1 of 7/);
  assert.match(list, /September 2026/);
  assert.equal(bestSeasonText(null), '');
  assert.equal(bestSeasonText({ season: '2026-03-01', tier: 'Diamond' }), 'Best: 💎 Diamond, March 2026');
  const stats = buildStatsHtml(seasonTotals);
  assert.match(stats, /Season XP/);
  assert.match(stats, /Career XP/);
  assert.match(stats, /2,04,397/);
  const parent = buildParentSummaryText({ ...seasonTotals, profile: { full_name: 'Test Kid', level: 'Basic 1' }, week: {} });
  assert.match(parent, /Season tier: 🥇 Gold \(1,200 XP this month\)/);
});

test('seasons: migration keeps records and the fairer daily curve', () => {
  const sql = fs.readFileSync(new URL('../supabase/migrations/27_phase27_xp_seasons.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.xp_season_results/);
  assert.match(sql, /WHEN p_rounds_before < 20 THEN 1\.0 WHEN p_rounds_before < 40 THEN 0\.5 ELSE 0\.25/);
  assert.match(sql, /WHERE student_id = p_student AND day = p_day;/, 'daily curve counts every practice');
  assert.match(sql, /'tier', public\.xp_season_tier\(v_season\)/);
  assert.match(sql, /day >= date '2026-11-01'/, 'wallet starts with the shop');
  assert.match(sql, /PERFORM public\.xp_settle_seasons\(\);/);
  assert.doesNotMatch(sql, /DELETE FROM public\.student_badges/, 'earned badges are never removed');
  assert.match(fs.readFileSync(new URL('../pages/profile.html', import.meta.url), 'utf8'), /id="pf-seasons"/);
});
