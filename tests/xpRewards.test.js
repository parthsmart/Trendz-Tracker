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
} from '../js/xpRewards.js';
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
  assert.match(html, /1,500 XP total/);
  assert.match(html, /&lt;i&gt;x&lt;\/i&gt;/);
  assert.match(html, /Me \(you\)/);
  assert.match(html, /Flash 2D/);
  assert.match(html, /leaderboard\.html\?board=xp/);
  const empty = buildProgressCardHtml({ ...totals, bests: [] }, []);
  assert.match(empty, /No XP earned/);
  assert.match(empty, /first personal best/);
});

test('leaderboard knows the XP board', () => {
  assert.equal(BOARD_LABELS.xp, 'XP');
  assert.equal(boardUsesPeriod('xp'), true);
  assert.equal(formatBoardValue('xp', 1234), '1,234 XP');
});
