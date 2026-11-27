import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildLiveDuelHomeHtml, HOME_AVATAR_LIMIT, onlineMates } from '../js/liveDuelHome.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live duel home: only classmates in presence count, never me', () => {
  const mates = [{ id: 'a', display_name: 'Asha' }, { id: 'b', display_name: 'Ben' }, { id: 'c', display_name: 'Cara' }];
  const list = onlineMates(mates, ['b', 'me', 'stranger', 'a'], 'me');
  assert.deepEqual(list.map((m) => m.id), ['a', 'b'], 'keeps classmate order, drops me and other levels or centres');
  assert.deepEqual(onlineMates(null, ['a']), []);
});

test('live duel home: count, tiny avatars and +N overflow', () => {
  const online = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, display_name: `S${i}`, url: i === 0 ? 'https://x/y.png' : null }));
  const html = buildLiveDuelHomeHtml({ online });
  assert.equal((html.match(/class="ldh-av"/g) || []).length, HOME_AVATAR_LIMIT);
  assert.match(html, />\+3</);
  assert.match(html, /<b class="num">8<\/b> classmates online now/);
  assert.match(html, /width:22px;height:22px/);
  assert.match(html, /Play live duel/);
  assert.match(html, /href="\/pages\/live-duel\.html"/);
  assert.match(buildLiveDuelHomeHtml({ online: online.slice(0, 1) }), /1<\/b> classmate online now/);
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

test('student home layout: live duels above Practice & More, daily challenge above My XP, My Day right below My XP, no board or lecture tile', () => {
  const html = fs.readFileSync(path.join(ROOT, 'pages/student.html'), 'utf8');
  const at = (id) => html.indexOf(`id="${id}"`);
  // Live duels sit in the side column, right above Practice & More.
  assert.ok(at('live-duel-home') > html.indexOf('sh-top-side'));
  assert.ok(at('live-duel-home') < html.indexOf('aria-labelledby="practice-more-heading"'));
  assert.ok(at('streak-card') < at('xp-progress-card'));
  assert.ok(at('xp-progress-card') < at('todo-heading'));
  assert.ok(at('streak-card') < at('daily-challenge') && at('daily-challenge') < at('xp-progress-card'), 'daily challenge sits between the hero and My XP');
  assert.ok(at('todo-heading') < at('stars-card'), 'My Day comes before the stars card');
  assert.equal(at('btn-watch-lectures-today'), -1);
  assert.doesNotMatch(html, /Jr\. MCWC Video Lectures/);
});
