/**
 * Side menu for every role and the teacher / admin Home header (tests/appRail.test.js)
 *
 * Run with: node --test tests/appRail.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRailItems } from '../js/appRail.js';
import { greetingFor, staffFirstName } from '../js/staffHome.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const currentIds = (resolved) => [...resolved.byId.values()].filter((i) => i.current).map((i) => i.id);

test('admin menu includes NAV_CONFIG pages plus Live Classes, Homework and Teachers shortcuts', () => {
  const { byId } = resolveRailItems({ role: 'admin' }, '/pages/admin.html');
  for (const id of ['admin-overview', 'admin-students', 'admin-review', 'admin-settings', 'admin-live-classes', 'admin-homework', 'admin-teachers']) {
    assert.ok(byId.has(id), `${id} should be present`);
  }
  assert.equal(byId.get('admin-teachers').href, '/pages/teachers.html');
});

test('an exact shortcut wins over the Settings hub for Settings sub-pages', () => {
  assert.deepEqual(currentIds(resolveRailItems({ role: 'admin' }, '/pages/teachers.html')), ['admin-teachers']);
  assert.deepEqual(currentIds(resolveRailItems({ role: 'admin' }, '/pages/homework.html')), ['admin-homework']);
  assert.deepEqual(currentIds(resolveRailItems({ role: 'admin' }, '/pages/categories.html')), ['admin-settings']);
  assert.deepEqual(currentIds(resolveRailItems({ role: 'admin' }, '/pages/student-detail.html')), ['admin-students']);
});

test('teacher menu follows permissions and never shows admin pages', () => {
  const perms = { can_view_students: true, can_mark_attendance: false, can_review_scores: false, can_manage_tasks: true };
  const { byId } = resolveRailItems({ role: 'teacher', permissions: perms }, '/pages/teacher.html');
  assert.ok(byId.has('teacher-students'));
  assert.ok(byId.has('teacher-todos'));
  assert.ok(!byId.has('teacher-attendance'));
  assert.ok(!byId.has('teacher-review'));
  assert.ok(byId.has('teacher-live-classes'));
  for (const href of ['/pages/settings.html', '/pages/teachers.html', '/pages/admin.html']) {
    assert.ok(![...byId.values()].some((i) => i.href === href), `teacher must not link to ${href}`);
  }
});

test('student menu still hides Flash Anzan when practice access closes it', () => {
  const { byId } = resolveRailItems({ role: 'student', practice_access: { flash: { allowed: false } } }, '/pages/student.html');
  assert.ok(!byId.has('student-flash'));
  assert.ok(byId.get('student-today').current);
});

test('unknown roles get no menu', () => {
  assert.equal(resolveRailItems({ role: 'guest' }, '/'), null);
  assert.equal(resolveRailItems(null, '/'), null);
});

test('staff greeting uses India time and strips role suffixes from names', () => {
  assert.equal(greetingFor(new Date('2026-11-25T03:00:00Z')), 'Good morning'); // 08:30 IST
  assert.equal(greetingFor(new Date('2026-11-25T08:00:00Z')), 'Good afternoon'); // 13:30 IST
  assert.equal(greetingFor(new Date('2026-11-25T14:00:00Z')), 'Good evening'); // 19:30 IST
  assert.equal(staffFirstName('Anita Sharma (Teacher)'), 'Anita');
  assert.equal(staffFirstName('(Admin)'), 'there');
  assert.equal(staffFirstName(''), 'there');
});

test('admin and teacher Home keep the element ids their scripts fill in', () => {
  const admin = read('pages/admin.html');
  const teacher = read('pages/teacher.html');
  assert.equal((admin.match(/id="overview-today-ist"/g) || []).length, 1);
  assert.equal((teacher.match(/id="overview-today-ist"/g) || []).length, 1);
  assert.equal((teacher.match(/id="badge-scope"/g) || []).length, 1);
  assert.ok(admin.includes('/css/staffHome.css') && teacher.includes('/css/staffHome.css'));
});

test('student rail groups practice pages under one Practice button, like the phone tab bar', async () => {
  const { buildRailLinksHtml } = await import('../js/appRail.js');
  const resolved = resolveRailItems({ role: 'student' }, '/pages/flash.html');
  const html = buildRailLinksHtml(resolved.layout, resolved.byId);
  const flyStart = html.indexOf('id="rail-fly-practice"');
  assert.ok(flyStart > 0, 'Practice flyout panel should be drawn');
  assert.equal((html.match(/data-rail-pop="practice"/g) || []).length, 1);
  assert.match(html, /aria-controls="rail-fly-practice"/);
  assert.match(html, /aria-expanded="false"/);
  // Practice pages live inside the flyout, not as top-level rail links
  const flyout = html.slice(flyStart, html.indexOf('</div>\n        </div>', flyStart));
  for (const href of ['/pages/basics.html', '/pages/flash.html', '/pages/memoriad.html', '/pages/oral-rounds.html', '/pages/round-scores.html']) {
    assert.ok(flyout.includes(`href="${href}"`), `${href} should be in the Practice flyout`);
    assert.equal(html.split(`href="${href}"`).length - 1, 1, `${href} should appear once`);
  }
  // The Practice button shows as current when a practice page is open
  assert.match(html, /class="rail-link rail-fly is-current"/);
  assert.match(flyout, /href="\/pages\/flash.html" class="rail-fly-link is-current" aria-current="page"/);
});

test('student rail has its own Duels, Arena and Store buttons', async () => {
  const { buildRailLinksHtml } = await import('../js/appRail.js');
  const resolved = resolveRailItems({ role: 'student' }, '/pages/duels.html');
  assert.equal(resolved.byId.get('student-duels').href, '/pages/duels.html');
  assert.equal(resolved.byId.get('student-store').href, '/pages/store.html');
  assert.deepEqual(currentIds(resolved), ['student-duels']);
  const html = buildRailLinksHtml(resolved.layout, resolved.byId);
  assert.match(html, /<a href="\/pages\/duels.html" class="rail-link is-current"/);
  assert.match(html, /<a href="\/pages\/store.html" class="rail-link"/);
  assert.match(html, /<a href="\/pages\/arena.html" class="rail-link"/);
});

test('a student without Flash access does not see it in the Practice flyout', async () => {
  const { buildRailLinksHtml } = await import('../js/appRail.js');
  const resolved = resolveRailItems({ role: 'student', practice_access: { flash: { allowed: false } } }, '/pages/student.html');
  const html = buildRailLinksHtml(resolved.layout, resolved.byId);
  assert.ok(!html.includes('/pages/flash.html'));
  assert.ok(html.includes('/pages/basics.html'));
  assert.ok(!/rail-fly is-current/.test(html));
});

test('staff rails keep plain links (no flyouts)', async () => {
  const { buildRailLinksHtml } = await import('../js/appRail.js');
  const admin = resolveRailItems({ role: 'admin' }, '/pages/admin.html');
  assert.ok(!buildRailLinksHtml(admin.layout, admin.byId).includes('data-rail-pop'));
  const teacher = resolveRailItems({ role: 'teacher', permissions: {} }, '/pages/teacher.html');
  assert.ok(!buildRailLinksHtml(teacher.layout, teacher.byId).includes('data-rail-pop'));
});

test('profile preview shows name, code and level with profile links; staff get no XP block', async () => {
  const { buildProfilePreviewHtml } = await import('../js/appRail.js');
  const student = buildProfilePreviewHtml(
    { role: 'student', level: 'KA-3', full_name: 'Riya <S>' },
    { label: 'Student' },
    { name: 'Riya <S>', initial: 'R', who: 'STU042' }
  );
  assert.match(student, /role="dialog"/);
  assert.match(student, /id="rail-account-menu"/);
  assert.ok(student.includes('Riya &lt;S&gt;'), 'name must be escaped');
  assert.ok(student.includes('STU042 · KA-3'));
  assert.ok(student.includes('data-rp-xp'));
  assert.ok(student.includes('href="/pages/profile.html"'));
  assert.ok(student.includes('data-rail-action="account"') && student.includes('data-rail-action="signout"'));
  assert.match(student, /^<div class="rail-pop rail-profile"[^>]* hidden>/);

  const teacher = buildProfilePreviewHtml({ role: 'teacher' }, { label: 'Teacher' }, { name: 'Anita', initial: 'A', who: 'Teacher' });
  assert.ok(!teacher.includes('data-rp-xp'));
  assert.ok(!teacher.includes('/pages/profile.html'));
  assert.ok(teacher.includes('data-rail-action="signout"'));
});

test('profile preview progress block shows tier, XP, streak and rank', async () => {
  const { buildProfileXpHtml } = await import('../js/appRail.js');
  const html = buildProfileXpHtml(
    { total_xp: 12345, week_xp: 320, streak: { current: 6 }, week_rank: { rank: 3 } },
    { name: 'Gold', icon: '🥇', pct: 42, toNext: 655, nextName: 'Platinum' }
  );
  assert.ok(html.includes('🥇 Gold'));
  assert.ok(html.includes('655 XP to Platinum'));
  assert.ok(html.includes('12,345'));
  assert.ok(html.includes('🔥 6'));
  assert.ok(html.includes('#3'));
  assert.match(html, /aria-valuenow="42"/);
  assert.match(buildProfileXpHtml(null, null), /Finish a practice round/);
  assert.match(buildProfileXpHtml({ total_xp: 0 }, { name: 'Legend', icon: '🌟', pct: 100, toNext: 0, nextName: null }), /Top tier reached/);
});

test('Duels and Store pages reuse the Arena script with only their own panel', () => {
  const duels = read('pages/duels.html');
  const store = read('pages/store.html');
  assert.ok(duels.includes('id="panel-duels"') && !duels.includes('id="panel-rewards"') && !duels.includes('role="tablist"'));
  assert.ok(store.includes('id="panel-rewards"') && store.includes('id="ar-item-form"') && !store.includes('id="panel-duels"'));
  for (const page of [duels, store]) assert.ok(page.includes('src="/js/arena.js"'));
  const vite = read('vite.config.ts');
  assert.ok(vite.includes("pages/duels.html") && vite.includes("pages/store.html"));
});
