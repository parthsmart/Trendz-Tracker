import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLiveDuelHomeHtml, HOME_AVATAR_LIMIT, onlinePlayers } from '../js/liveDuelHome.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live duel home: every online player at my level counts (any centre), classmates first, never me', () => {
  const known = new Map([
    ['a', { id: 'a', display_name: 'Zed', classmate: true }],
    ['b', { id: 'b', display_name: 'Ben', classmate: false, centre_name: 'North' }],
    ['c', { id: 'c', display_name: 'Cara', classmate: false }],
    ['other-level', null],
  ]);
  const list = onlinePlayers(known, ['b', 'me', 'other-level', 'a', 'c', 'unknown'], 'me');
  assert.deepEqual(list.map((m) => m.id), ['a', 'b', 'c'], 'classmates first, then by name; drops me, other levels and unknown ids');
  assert.deepEqual(onlinePlayers(null, ['a']), []);
});

test('live duel home: count, tiny avatars and +N overflow', () => {
  const online = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, display_name: `S${i}`, url: i === 0 ? 'https://x/y.png' : null }));
  const html = buildLiveDuelHomeHtml({ online });
  assert.equal((html.match(/class="ldh-av"/g) || []).length, HOME_AVATAR_LIMIT);
  assert.match(html, />\+3</);
  assert.match(html, /<b class="num">8<\/b> players online now/);
  assert.match(html, /width:22px;height:22px/);
  assert.match(html, /Play live duel/);
  assert.match(html, /href="\/pages\/live-duel\.html"/);
  assert.match(buildLiveDuelHomeHtml({ online: online.slice(0, 1) }), /1<\/b> player online now/);
});

test('live duel home: a dropdown challenges any online player, never offline ones', () => {
  const html = buildLiveDuelHomeHtml({ online: [{ id: 'a1', display_name: 'Asha', classmate: true }, { id: 'b2', display_name: '<Ben>', centre_name: 'North' }] });
  assert.match(html, /<details class="ldh-pick"><summary>Challenge a player<\/summary>/);
  assert.match(html, /Your centre/);
  assert.match(html, /North/);
  assert.equal((html.match(/data-ldh-challenge="/g) || []).length, 2);
  assert.match(html, /&lt;Ben&gt;/);
  assert.doesNotMatch(buildLiveDuelHomeHtml({ online: [] }), /ldh-pick/);
  assert.doesNotMatch(buildLiveDuelHomeHtml({ online: [{ id: 'a1', display_name: 'A' }], connecting: true }), /ldh-pick/);
});

test('live duel home: nobody online offers a ghost race', () => {
  const html = buildLiveDuelHomeHtml({ online: [] });
  assert.match(html, /Be the first — play vs a ghost/);
  assert.doesNotMatch(html, /ldh-av/);
  assert.match(buildLiveDuelHomeHtml({ connecting: true }), /Checking who is online/);
});

test('live duel home: names are escaped and invites link to the lobby', () => {
  const html = buildLiveDuelHomeHtml({
    online: [{ id: 'x', display_name: '<img src=x onerror=1>' }],
    invites: [{ id: 'd1', from_name: '<b>Ben</b>' }],
    rating: { rating: 1012, played: 3, won: 2 },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;b&gt;Ben&lt;\/b&gt; <\/b> challenges you!|&lt;b&gt;Ben&lt;\/b&gt;<\/b> challenges you!/);
  assert.match(html, /Rating <b>1012<\/b> · 2 won/);
  assert.doesNotMatch(buildLiveDuelHomeHtml({ rating: { rating: 1000, played: 0 } }), /Rating/);
});

test('student home layout: live duels below Practice & More, daily challenge right below My XP, then My Day, no board or lecture tile', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages/student.html'), 'utf8');
  const at = (id) => html.indexOf(`id="${id}"`);
  // Live duels sit in the side column, right below Practice & More.
  assert.ok(at('live-duel-home') > at('sh-tiles'));
  assert.ok(at('live-duel-home') < at('student-live-class-card-container'));
  assert.ok(at('streak-card') < at('xp-progress-card'));
  assert.ok(at('xp-progress-card') < at('daily-challenge') && at('daily-challenge') < at('todo-heading'), 'daily challenge sits right below My XP, before My Day');
  assert.ok(at('todo-heading') < at('stars-card'), 'My Day comes before the stars card');
  assert.equal(at('btn-watch-lectures-today'), -1);
  assert.doesNotMatch(html, /Jr\. MCWC Video Lectures/);
});
