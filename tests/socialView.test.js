import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REACTIONS, REPORT_REASONS, esc, feedItemHtml, feedItemText, filterClassmates, reactionBarHtml, splitRequests, timeAgo,
} from '../js/socialView.js';
import { buildMyClassCardHtml } from '../js/myClassCard.js';
import { buildCommunityHtml } from '../js/community.js';
import { blockedIdsFor, isBlockedPair } from '../api/_socialBlocks.js';

test('reactions and report reasons match the database whitelists', () => {
  assert.deepEqual(REACTIONS.map((r) => r.key), ['clap', 'fire', 'gg', 'star', 'muscle', 'party']);
  assert.deepEqual(REPORT_REASONS.map((r) => r.key), ['unkind', 'uncomfortable', 'spam', 'other']);
});

test('feed text is positive and escapes names', () => {
  assert.match(feedItemText({ kind: 'level_up', name: 'Diya', payload: { level: 'Level 3' } }).text, /Diya reached Level 3!/);
  assert.match(feedItemText({ kind: 'badge', name: 'Diya', payload: { name: 'Speed Star' } }).text, /Speed Star/);
  const html = feedItemHtml({ id: 1, kind: 'level_up', name: '<img src=x onerror=1>', payload: {}, created_at: new Date().toISOString(), student_id: 's1' });
  assert.ok(!html.includes('<img src=x'));
  assert.equal(esc('"<&>\''), '&quot;&lt;&amp;&gt;&#39;');
});

test('reaction bar has only preset buttons and no text input', () => {
  const html = reactionBarHtml('feed', 7, { counts: { clap: 2 }, mine: ['clap'] });
  assert.equal((html.match(/<button/g) || []).length, 6);
  assert.ok(!/<input|<textarea|contenteditable/.test(html));
  assert.match(html, /aria-pressed="true"[^>]*><span aria-hidden="true">👏<\/span><b>2<\/b>/);
  assert.match(reactionBarHtml('feed', 7, {}, { enabled: false }), /disabled/);
});

test('own items cannot be reacted to or reported', () => {
  const html = feedItemHtml({ id: 2, kind: 'badge', mine: true, student_id: 'me', payload: {}, created_at: new Date().toISOString() });
  assert.ok(!html.includes('data-report-item'));
  assert.equal((html.match(/disabled/g) || []).length, 6);
});

test('requests split into incoming and waiting; classmate search', () => {
  const { incoming, waiting } = splitRequests([
    { id: 'a', direction: 'in', status: 'pending_student' },
    { id: 'b', direction: 'out', status: 'pending_student' },
    { id: 'c', direction: 'in', status: 'pending_staff' },
  ]);
  assert.deepEqual(incoming.map((r) => r.id), ['a']);
  assert.deepEqual(waiting.map((r) => r.id), ['b', 'c']);
  assert.deepEqual(filterClassmates([{ name: 'Diya' }, { name: 'Rohan' }], 'ro').map((c) => c.name), ['Rohan']);
  assert.equal(timeAgo(new Date(Date.now() - 3 * 60000).toISOString()), '3 min ago');
});

test('dashboard card shows at most 5 items and the request badge', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: i, kind: 'level_up', name: `S${i}`, payload: {}, created_at: new Date().toISOString() }));
  const html = buildMyClassCardHtml({ items, incoming: 2 });
  assert.equal((html.match(/class="sc-item"/g) || []).length, 5);
  assert.match(html, /sc-badge[^>]*>2</);
  assert.ok(!html.includes('data-report-item'));
});

test('community page builds every section and escapes names', () => {
  const html = buildCommunityHtml({
    requests: [{ id: 'r1', from_name: '<b>A</b>', to_name: 'B', created_at: new Date().toISOString() }],
    reports: [{ id: 1, reporter_name: 'A', target_name: 'B', reason: 'unkind', context: 'student', status: 'open', created_at: new Date().toISOString() }],
    friendships: [], feed: [], blocks: [], settings: { feed_enabled: false },
  });
  assert.ok(!html.requests.includes('<b>A</b>'));
  assert.match(html.requests, /data-approve="r1"/);
  assert.match(html.reports, /Unkind/);
  assert.match(html.settings, /data-setting="feed_enabled"(?! checked)/);
});

function fakeDb(rows, { fail = false } = {}) {
  return {
    from(table) {
      assert.equal(table, 'student_blocks');
      return {
        select() { return this; },
        or(filter) {
          if (fail) return Promise.resolve({ data: null, error: { message: 'relation does not exist' } });
          const id = /blocker_id\.eq\.([^,]+)/.exec(filter)[1];
          return Promise.resolve({ data: rows.filter((r) => r.blocker_id === id || r.blocked_id === id), error: null });
        },
      };
    },
  };
}

test('duel block checks work both ways and fail open without the table', async () => {
  const db = fakeDb([{ blocker_id: 'a', blocked_id: 'b' }]);
  assert.equal(await isBlockedPair(db, 'a', 'b'), true);
  assert.equal(await isBlockedPair(db, 'b', 'a'), true);
  assert.equal(await isBlockedPair(db, 'a', 'c'), false);
  assert.deepEqual([...await blockedIdsFor(db, 'b')], ['a']);
  assert.equal(await isBlockedPair(fakeDb([], { fail: true }), 'a', 'b'), false);
});
