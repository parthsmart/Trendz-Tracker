/**
 * Unit & Integration Tests for Teacher Navigation & Permission-Scoped Menu
 * (tests/teacherNavigation.test.js)
 *
 * Verifies:
 * 1. Default teacher navigation desktop entries (8 items: 7 links + 1 dropdown).
 * 2. Class Content ▾ dropdown items (Announcements & Resources).
 * 3. Granular permission filtering for desktop navigation links.
 * 4. Dropdown omission when both announcements and resources permissions are false.
 * 5. Dropdown partial filtering when only one class content permission is enabled.
 * 6. Mobile grouped nav items for teacher and permission propagation.
 * 7. Active page highlighting for teacher routes (/pages/teacher.html, /pages/attendance.html, etc.).
 * 8. Strict isolation: teacher navigation never contains admin-only items (Settings, Teachers, Backup, Import).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRoleNavItems,
  getDesktopNavEntries,
  getGroupedNavItems,
  isNavItemCurrent,
} from '../js/navConfig.js';

const ALL_PERMISSIONS = {
  can_view_students: true,
  can_mark_attendance: true,
  can_correct_attendance: true,
  can_generate_reports: true,
  can_manage_tasks: true,
  can_manage_tests: true,
  can_publish_announcements: true,
  can_manage_resources: true,
  can_review_scores: true,
  can_request_corrections: true,
};

test('Teacher desktop navigation: full permissions render all standard entries and dropdown', () => {
  const entries = getDesktopNavEntries('teacher', ALL_PERMISSIONS);

  // 7 links + 1 dropdown = 8 entries
  assert.equal(entries.length, 8, 'Expected 8 top-level entries on teacher desktop navigation');

  const links = entries.filter((e) => e.type === 'link').map((e) => e.item);
  const dropdowns = entries.filter((e) => e.type === 'dropdown');

  assert.equal(dropdowns.length, 1, 'Expected exactly 1 dropdown for Class Content');
  assert.equal(dropdowns[0].label, 'Class Content');
  assert.deepEqual(dropdowns[0].items.map((i) => i.label), ['Announcements', 'Resources']);

  assert.deepEqual(links.map((i) => i.label), [
    'Overview',
    'My Students',
    'Attendance',
    'Tasks',
    'Weekly Tests',
    'Review',
    'Monthly Reports',
  ]);

  // Overview links to /pages/teacher.html
  assert.equal(links[0].href, '/pages/teacher.html');
  assert.equal(links[1].href, '/pages/students.html');
  assert.equal(links[2].href, '/pages/attendance.html');
});

test('Teacher desktop navigation: omitting permissions hides corresponding links', () => {
  const restrictedPermissions = {
    ...ALL_PERMISSIONS,
    can_view_students: false,
    can_mark_attendance: false,
    can_manage_tasks: false,
    can_manage_tests: false,
    can_review_scores: false,
    can_generate_reports: false,
  };

  const entries = getDesktopNavEntries('teacher', restrictedPermissions);
  const links = entries.filter((e) => e.type === 'link').map((e) => e.item);

  // Overview is always present
  assert.deepEqual(links.map((i) => i.label), ['Overview']);
});

test('Teacher desktop navigation: Class Content dropdown omitted when both content permissions false', () => {
  const noContentPermissions = {
    ...ALL_PERMISSIONS,
    can_publish_announcements: false,
    can_manage_resources: false,
  };

  const entries = getDesktopNavEntries('teacher', noContentPermissions);
  const dropdowns = entries.filter((e) => e.type === 'dropdown');

  assert.equal(dropdowns.length, 0, 'Class Content dropdown must be omitted when both child permissions are false');
});

test('Teacher desktop navigation: Class Content dropdown keeps only authorized child', () => {
  const announcementsOnly = {
    ...ALL_PERMISSIONS,
    can_publish_announcements: true,
    can_manage_resources: false,
  };

  const entries = getDesktopNavEntries('teacher', announcementsOnly);
  const dropdowns = entries.filter((e) => e.type === 'dropdown');

  assert.equal(dropdowns.length, 1);
  assert.equal(dropdowns[0].items.length, 1);
  assert.equal(dropdowns[0].items[0].label, 'Announcements');
});

test('Teacher mobile navigation: grouped items respect permissions', () => {
  const groups = getGroupedNavItems('teacher', ALL_PERMISSIONS);

  assert.ok(Array.isArray(groups) && groups.length > 0);
  const groupNames = groups.map((g) => g.group);
  assert.ok(groupNames.includes('Overview') || groupNames.includes('Teaching'));

  const allItems = groups.flatMap((g) => g.items);
  const labels = allItems.map((i) => i.label);

  assert.ok(labels.includes('Overview'));
  assert.ok(labels.includes('My Students'));
  assert.ok(labels.includes('Attendance'));
  assert.ok(labels.includes('Announcements'));
  assert.ok(labels.includes('Resources'));

  // Never contains admin settings, teachers, or backup
  assert.ok(!labels.includes('Settings'));
  assert.ok(!labels.includes('Teachers'));
  assert.ok(!labels.includes('Backup'));
  assert.ok(!labels.includes('Database Backup'));
});

test('Teacher navigation active state: isNavItemCurrent matches current path correctly', () => {
  const overviewItem = { href: '/pages/teacher.html' };
  const attendanceItem = { href: '/pages/attendance.html' };
  const adminOverviewItem = { href: '/pages/admin.html' };

  assert.equal(isNavItemCurrent(overviewItem, '/pages/teacher.html'), true);
  assert.equal(isNavItemCurrent(overviewItem, '/pages/attendance.html'), false);
  assert.equal(isNavItemCurrent(attendanceItem, '/pages/attendance.html'), true);
  // Admin overview does not match teacher overview
  assert.equal(isNavItemCurrent(adminOverviewItem, '/pages/teacher.html'), false);
});
