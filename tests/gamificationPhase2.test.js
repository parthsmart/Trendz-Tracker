/**
 * Phase 2 gamification: daily challenge picking/seeding, avatar helpers, profile builders
 * and home cards. Pure functions only; numbers come from the database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHALLENGE_SECONDS,
  challengeSeed,
  hashString,
  pickDailyChallenge,
} from '../api/_dailyChallenge.js';
import { createSeededRng, generateBasicsSet } from '../api/_drills.js';
import { avatarHtml, avatarInitial, centreSquare, isAvatarPath, validateAvatarFile } from '../js/avatars.js';
import {
  awardTitles,
  badgeCounts,
  buildBadgeWallHtml,
  buildParentSummaryText,
  whatsappShareUrl,
} from '../js/profileView.js';
import { buildChallengeBoardDropHtml, buildChallengeBoardHtml, buildChallengeStatusHtml, buildStarsHtml, formatSeconds } from '../js/homeGamify.js';
import { buildRoundCardHtml } from '../js/xpRewards.js';
import { mapLeaderboardRows } from '../js/leaderboardView.js';
import { NAV_CONFIG } from '../js/navConfig.js';

const UID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('daily challenge', () => {
  const candidates = [
    { category_id: 'c3', name: '2D 4R', students: 5 },
    { category_id: 'c1', name: '1D 5R', students: 3 },
    { category_id: 'c2', name: '2D 3R', students: 1 },
    { category_id: 'c9', name: 'Not a basics name', students: 9 },
  ];

  it('is a 1-minute challenge', () => {
    assert.equal(CHALLENGE_SECONDS, 60);
  });

  it('hashString is stable FNV-1a', () => {
    assert.equal(hashString(''), 0x811c9dc5);
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
  });

  it('picks the same category for the same day and level, whatever the input order', () => {
    const a = pickDailyChallenge(candidates, '2026-11-27', 'Level 3');
    const b = pickDailyChallenge([...candidates].reverse(), '2026-11-27', 'Level 3');
    assert.deepEqual(a, b);
    assert.ok(['c1', 'c3'].includes(a.id), 'prefers categories 2+ students practised');
  });

  it('falls back to less popular categories and ignores names that cannot be generated', () => {
    const only = pickDailyChallenge([candidates[2], candidates[3]], '2026-11-27', 'L1');
    assert.equal(only.id, 'c2');
    assert.equal(pickDailyChallenge([candidates[3]], '2026-11-27', 'L1'), null);
    assert.equal(pickDailyChallenge(null, '2026-11-27', 'L1'), null);
  });

  it('rotates across days', () => {
    const ids = new Set();
    for (let d = 1; d <= 20; d++) {
      ids.add(pickDailyChallenge(candidates, `2026-11-${String(d).padStart(2, '0')}`, 'L1').id);
    }
    assert.ok(ids.size > 1);
  });

  it('gives everyone the same questions for the same seed', () => {
    const seed = challengeSeed('2026-11-27', 'Level 3', 'c1');
    assert.equal(seed, challengeSeed('2026-11-27', ' Level 3 ', 'c1'));
    assert.notEqual(seed, challengeSeed('2026-11-28', 'Level 3', 'c1'));
    const one = generateBasicsSet('1D 5R', 20, createSeededRng(seed));
    const two = generateBasicsSet('1D 5R', 20, createSeededRng(seed));
    assert.deepEqual(one, two);
  });
});

describe('avatars', () => {
  it('accepts only own-folder paths the database allows', () => {
    assert.equal(isAvatarPath(`${UID}/abc123.jpg`), true);
    assert.equal(isAvatarPath(`${UID}/abc.png`), true);
    assert.equal(isAvatarPath(`${UID}/../x.jpg`), false);
    assert.equal(isAvatarPath(`${UID}/abc.gif`), false);
    assert.equal(isAvatarPath(null), false);
  });

  it('falls back to an escaped initial', () => {
    assert.equal(avatarInitial('  riya s'), 'R');
    assert.equal(avatarInitial(''), '?');
    assert.match(avatarHtml(null, '<b>', 30), /&lt;/);
    assert.match(avatarHtml('https://x/y.jpg?a=1&b=2', 'A', 30), /<img src="https:\/\/x\/y.jpg\?a=1&amp;b=2"/);
  });

  it('crops the centre square', () => {
    assert.deepEqual(centreSquare(400, 300), { sx: 50, sy: 0, side: 300 });
    assert.deepEqual(centreSquare(300, 500), { sx: 0, sy: 100, side: 300 });
  });

  it('validates picked files', () => {
    assert.equal(validateAvatarFile(null), 'Choose a photo first.');
    assert.match(validateAvatarFile({ type: 'application/pdf', name: 'a.pdf', size: 10 }), /JPG/);
    assert.match(validateAvatarFile({ type: 'image/jpeg', name: 'a.jpg', size: 11 * 1024 * 1024 }), /too large/);
    assert.equal(validateAvatarFile({ type: 'image/png', name: 'a.png', size: 1000 }), '');
  });
});

describe('profile builders', () => {
  const badges = [
    { key: 'first_round', name: 'First steps', icon: '👣', description: 'Finish your first round.', category: 'practice', earned_at: '2026-11-02T10:00:00Z' },
    { key: 'rounds_10', name: 'Warming up', icon: '🔟', description: 'Finish 10 rounds.', category: 'practice', earned_at: null },
    { key: 'streak_3', name: 'On a roll', icon: '🔥', description: 'Reach a 3-day streak.', category: 'streak', earned_at: null },
  ];

  it('shows locked badges greyed out and earned ones with a date', () => {
    const html = buildBadgeWallHtml(badges);
    assert.equal((html.match(/is-earned/g) || []).length, 1);
    assert.equal((html.match(/is-locked/g) || []).length, 2);
    assert.match(html, /Practice/);
    assert.match(html, /Streaks/);
    assert.deepEqual(badgeCounts(badges), { earned: 1, total: 3 });
  });

  it('turns awards into titles', () => {
    const titles = awardTitles([
      { kind: 'month', from: '2026-10-01', to: '2026-10-31' },
      { kind: 'week', from: '2026-11-16', to: '2026-11-22' },
      { kind: 'week', from: '2026-11-09', to: '2026-11-15' },
    ]);
    assert.equal(titles.length, 2);
    assert.match(titles[0].text, /Star of the Month/);
    assert.match(titles[1].text, /Champion of the Week ×2/);
    assert.deepEqual(awardTitles(null), []);
  });

  it('writes a parent summary from the weekly numbers', () => {
    const text = buildParentSummaryText({
      profile: { full_name: 'Asha Kumar', level: 'Level 2' },
      total_xp: 1200,
      week_xp: 340,
      tier: { name: 'Silver', floor: 1000, next_floor: 3000, next_name: 'Gold' },
      streak: { current: 4 },
      awards: [],
      week: {
        from: '2026-11-23', to: '2026-11-29', rounds: 6, practice_days: 3, correct: 45, total: 50,
        new_bests: [{ label: 'Basics 1D 5R', score: '18/20' }],
        new_badges: [{ name: 'On a roll', icon: '🔥' }],
      },
    });
    assert.match(text, /summary for Asha\n/);
    assert.match(text, /3 days \(6 rounds\)/);
    assert.match(text, /45 of 50 correctly \(90%\)/);
    assert.match(text, /4 days/);
    assert.match(text, /Basics 1D 5R \(18\/20\)/);
    assert.match(text, /🔥 On a roll/);
    assert.doesNotMatch(text, /Kumar/);
    const idle = buildParentSummaryText({ profile: { full_name: 'Asha' }, week: { rounds: 0 } });
    assert.match(idle, /has not practised online yet/);
  });

  it('builds a WhatsApp share link', () => {
    assert.equal(whatsappShareUrl('a b&c'), 'https://wa.me/?text=a%20b%26c');
  });
});

describe('home cards and round card', () => {
  it('formats challenge times', () => {
    assert.equal(formatSeconds(42), '42s');
    assert.equal(formatSeconds(65), '1m 05s');
    assert.equal(formatSeconds(null), '0s');
    assert.equal(formatSeconds(-1), '');
  });

  it('shows play, played and empty states', () => {
    assert.match(buildChallengeStatusHtml({ available: true, category: { name: '1D 5R' }, attempt: null }), /challenge=1/);
    assert.match(buildChallengeStatusHtml({ available: true, category: { name: '1D 5R' }, attempt: { submitted_at: 'x', correct: 9, total: 10 } }), /9\/10/);
    assert.doesNotMatch(buildChallengeStatusHtml({ available: true, category: { name: '1D 5R' }, attempt: { started_at: 'x' } }), /challenge=1/);
    assert.match(buildChallengeStatusHtml({ available: false }), /No challenge/);
  });

  it('renders the challenge board and stars without leaking markup', () => {
    const html = buildChallengeBoardHtml([{ rank: 1, display_name: '<x>', correct: 9, total: 10, time_seconds: 60, is_me: true }]);
    assert.match(html, /&lt;x&gt; \(you\)/);
    assert.match(buildChallengeBoardHtml([]), /Be the first/);
    const drop = buildChallengeBoardDropHtml([{ rank: 1, display_name: 'A', correct: 9, total: 10 }], new Map(), 12);
    assert.match(drop, /^<details class="gm-board-drop"><summary>/, 'board is a closed dropdown');
    assert.doesNotMatch(drop, /<details[^>]*open/);
    assert.match(drop, /12 played/);
    const stars = buildStarsHtml({ level: 'L1', month: { label: 'October 2026', winners: [{ display_name: 'A', xp: 900 }] }, week: { winners: [] } });
    assert.match(stars, /October 2026/);
    assert.match(stars, /Not decided yet/);
  });

  it('lists badges unlocked by a round', () => {
    const html = buildRoundCardHtml({
      round: { xp: 30 },
      total_xp: 100,
      tier: { name: 'Bronze', floor: 0, next_floor: 1000, next_name: 'Silver' },
      new_badges: [{ name: 'First steps', icon: '👣', description: 'Finish your first round.' }],
    });
    assert.match(html, /First steps/);
    assert.match(html, /profile\.html/);
  });

  it('keeps leaderboard photo paths', () => {
    const rows = mapLeaderboardRows([{ rank: 1, display_name: 'A', value: 5, avatar_path: `${UID}/a.jpg` }, { rank: 2, display_name: 'B', value: 3 }]);
    assert.equal(rows[0].avatar_path, `${UID}/a.jpg`);
    assert.equal(rows[1].avatar_path, null);
  });

  it('adds My Profile to the student menu', () => {
    const item = NAV_CONFIG.student.find((i) => i.id === 'student-profile');
    assert.equal(item?.href, '/pages/profile.html');
    assert.equal(item?.desktopPlacement, 'menu-only');
  });
});
