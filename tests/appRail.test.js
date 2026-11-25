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
