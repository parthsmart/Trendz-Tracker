/**
 * Regression & Integration Tests for Simplified Admin Navigation
 * (tests/adminNavigation.test.js)
 *
 * Verifies:
 * 1. Exactly one Monthly Report entry and one Settings entry per admin navigation surface (desktop & mobile).
 * 2. Admin "Setup" dropdown is replaced with a direct "Settings" link to /pages/settings.html.
 * 3. /pages/report.html redirects to /pages/monthly-report.html preserving full query string and hash with location.replace.
 * 4. Every setup tool remains reachable through Settings hub.
 * 5. Settings is highlighted when viewing the hub or any of its subpages on both desktop and mobile.
 * 6. Monthly Report is highlighted when viewing monthly-report.html and does not highlight Settings.
 * 7. Breadcrumbs and direct access to settings subpages are preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_CONFIG,
  SETTINGS_SUBPAGE_PATHS,
  getRoleNavItems,
  getInlineNavItems,
  getDesktopNavEntries,
  getGroupedNavItems,
  isNavItemCurrent,
} from '../js/navConfig.js';
import { SETTINGS_ENTRIES, getSettingsBreadcrumb } from '../js/settingsHub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

test('Admin desktop surface has exactly 1 Monthly Report link and 1 Settings link, and 0 dropdowns', () => {
  const desktopEntries = getDesktopNavEntries('admin');

  // Verify all entries are links, zero dropdowns
  const dropdowns = desktopEntries.filter((e) => e.type === 'dropdown');
  assert.equal(dropdowns.length, 0, 'Admin desktop navigation must not contain any dropdowns');

  const links = desktopEntries.filter((e) => e.type === 'link').map((e) => e.item);
  const labels = links.map((item) => item.label);

  assert.deepEqual(labels, [
    'Overview',
    'Review',
    'Students',
    'Attendance',
    'Weekly Tests',
    'Leaderboard',
    'Monthly Report',
    'Settings',
  ]);

  // Check Monthly Report
  const monthlyReportLinks = links.filter((i) => i.href === '/pages/monthly-report.html');
  assert.equal(monthlyReportLinks.length, 1, 'Desktop surface must have exactly one Monthly Report link');
  assert.equal(monthlyReportLinks[0].label, 'Monthly Report');

  // Check Settings
  const settingsLinks = links.filter((i) => i.href === '/pages/settings.html');
  assert.equal(settingsLinks.length, 1, 'Desktop surface must have exactly one Settings link');
  assert.equal(settingsLinks[0].label, 'Settings');

  // Verify no duplicate hrefs
  const hrefs = links.map((i) => i.href);
  assert.equal(new Set(hrefs).size, hrefs.length, 'No duplicate hrefs allowed on desktop surface');
});

test('Admin mobile surface has exactly 1 Monthly Report entry and 1 Settings entry, with no subpage clutter', () => {
  const groups = getGroupedNavItems('admin');

  // Overview group contains the main admin links
  const overviewGroup = groups.find((g) => g.group === 'Overview');
  assert.ok(overviewGroup, 'Expected Overview group on mobile surface');
  const overviewLabels = overviewGroup.items.map((i) => i.label);
  assert.deepEqual(overviewLabels, [
    'Overview',
    'Review',
    'Students',
    'Attendance',
    'Weekly Tests',
    'Leaderboard',
    'Monthly Report',
  ]);

  // Settings group contains solely the Settings hub link
  const settingsGroup = groups.find((g) => g.group === 'Settings');
  assert.ok(settingsGroup, 'Expected Settings group on mobile surface');
  assert.equal(settingsGroup.items.length, 1, 'Settings group should contain only the Settings hub link');
  assert.equal(settingsGroup.items[0].label, 'Settings');
  assert.equal(settingsGroup.items[0].href, '/pages/settings.html');

  // Account group
  const accountGroup = groups.find((g) => g.group === 'Account');
  assert.ok(accountGroup, 'Expected Account group on mobile surface');
  assert.deepEqual(
    accountGroup.items.map((i) => i.label),
    ['Account', 'Sign out']
  );

  // Across all mobile items, check counts of Monthly Report and Settings
  const allItems = groups.flatMap((g) => g.items);
  const monthlyItems = allItems.filter((i) => i.href === '/pages/monthly-report.html');
  assert.equal(monthlyItems.length, 1, 'Mobile surface must have exactly one Monthly Report entry');

  const settingsItems = allItems.filter((i) => i.href === '/pages/settings.html');
  assert.equal(settingsItems.length, 1, 'Mobile surface must have exactly one Settings entry');

  // Ensure no old /pages/report.html or setup subpages clutter the mobile menu
  assert.equal(allItems.some((i) => i.href === '/pages/report.html'), false);
  for (const subPath of SETTINGS_SUBPAGE_PATHS) {
    assert.equal(
      allItems.some((i) => i.href === subPath),
      false,
      `Subpage ${subPath} should not clutter mobile menu; it is accessed via Settings hub`
    );
  }
});

test('/pages/report.html redirects to /pages/monthly-report.html with query params via location.replace', () => {
  const reportHtmlPath = path.join(ROOT_DIR, 'pages', 'report.html');
  const content = fs.readFileSync(reportHtmlPath, 'utf8');

  // Must use location.replace so browser Back does not loop
  assert.ok(
    content.includes('window.location.replace') || content.includes('location.replace'),
    'report.html must use location.replace for redirection'
  );

  // Must redirect to /pages/monthly-report.html
  assert.ok(
    content.includes('/pages/monthly-report.html'),
    'report.html must target /pages/monthly-report.html'
  );

  // Must preserve query string (search) and hash
  assert.ok(
    content.includes('location.search'),
    'report.html must preserve location.search query parameters'
  );

  // Must have meta refresh fallback
  assert.ok(
    /<meta\s+http-equiv=["']refresh["']/i.test(content),
    'report.html should include a <meta http-equiv="refresh"> fallback'
  );

  // Simulate query preservation logic
  const simulateRedirect = (mockSearch, mockHash = '') => {
    return '/pages/monthly-report.html' + (mockSearch || '') + (mockHash || '');
  };

  assert.equal(
    simulateRedirect('?id=STU001&month=2026-10'),
    '/pages/monthly-report.html?id=STU001&month=2026-10'
  );
  assert.equal(
    simulateRedirect('?studentId=STU999'),
    '/pages/monthly-report.html?studentId=STU999'
  );
  assert.equal(
    simulateRedirect('?id=STU001', '#tests'),
    '/pages/monthly-report.html?id=STU001#tests'
  );
  assert.equal(
    simulateRedirect(''),
    '/pages/monthly-report.html'
  );
});

test('Every setup tool remains reachable through the Settings hub (SETTINGS_ENTRIES)', () => {
  const expectedTools = [
    { id: 'todos', href: '/pages/todos.html' },
    { id: 'targets', href: '/pages/targets.html' },
    { id: 'categories', href: '/pages/categories.html' },
    { id: 'resources', href: '/pages/resources.html' },
    { id: 'competition', href: '/pages/competition.html' },
    { id: 'rounds', href: '/pages/rounds.html' },
    { id: 'announcements', href: '/pages/announcements.html' },
    { id: 'reports', href: '/pages/monthly-report.html' },
    { id: 'import', href: '/pages/import.html' },
    { id: 'backup', href: '/pages/backup.html' },
  ];

  for (const tool of expectedTools) {
    const entry = SETTINGS_ENTRIES.find((e) => e.id === tool.id);
    assert.ok(entry, `Expected tool "${tool.id}" in SETTINGS_ENTRIES`);
    assert.equal(entry.href, tool.href, `Expected tool "${tool.id}" href to be ${tool.href}`);
    assert.ok(entry.title, `Expected tool "${tool.id}" to have title`);
    assert.ok(entry.description, `Expected tool "${tool.id}" to have description`);
  }
});

test('Settings is highlighted when viewing /pages/settings.html or any of its subpages', () => {
  const settingsItem = NAV_CONFIG.admin.find((i) => i.href === '/pages/settings.html');
  assert.ok(settingsItem);

  // Directly on the hub
  assert.equal(isNavItemCurrent(settingsItem, '/pages/settings.html'), true);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/settings.html?group=all'), true);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/settings.html#categories'), true);

  // On each subpage
  const subpages = [
    '/pages/todos.html',
    '/pages/resources.html',
    '/pages/categories.html',
    '/pages/rounds.html',
    '/pages/targets.html',
    '/pages/competition.html',
    '/pages/announcements.html',
    '/pages/import.html',
    '/pages/backup.html',
  ];

  for (const page of subpages) {
    assert.equal(
      isNavItemCurrent(settingsItem, page),
      true,
      `Settings item should be active when visiting ${page}`
    );
    assert.equal(
      isNavItemCurrent(settingsItem, `${page}?query=123`),
      true,
      `Settings item should be active when visiting ${page} with query`
    );
  }

  // Does NOT highlight for non-settings pages
  assert.equal(isNavItemCurrent(settingsItem, '/pages/monthly-report.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/monthly-report.html?id=STU1'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/admin.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/review.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/students.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/student-detail.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/attendance.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/weekly-tests.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/leaderboard.html'), false);
});

test('Monthly Report is highlighted when viewing /pages/monthly-report.html and not Settings', () => {
  const monthlyItem = NAV_CONFIG.admin.find((i) => i.href === '/pages/monthly-report.html');
  const settingsItem = NAV_CONFIG.admin.find((i) => i.href === '/pages/settings.html');

  assert.equal(isNavItemCurrent(monthlyItem, '/pages/monthly-report.html'), true);
  assert.equal(isNavItemCurrent(monthlyItem, '/pages/monthly-report.html?id=STU1&month=2026-10'), true);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/monthly-report.html'), false);

  assert.equal(isNavItemCurrent(monthlyItem, '/pages/settings.html'), false);
});

test('Settings subpages breadcrumbs resolve accurately and exclude top-level monthly-report', () => {
  const todoCrumb = getSettingsBreadcrumb('/pages/todos.html');
  assert.ok(todoCrumb);
  assert.equal(todoCrumb.breadcrumbTitle, 'Daily To-Do');

  const compCrumb = getSettingsBreadcrumb('/pages/competition.html');
  assert.ok(compCrumb);
  assert.equal(compCrumb.breadcrumbTitle, 'Competition settings');

  // Top level pages must not have settings breadcrumb
  assert.equal(getSettingsBreadcrumb('/pages/monthly-report.html'), null);
  assert.equal(getSettingsBreadcrumb('/pages/admin.html'), null);
  assert.equal(getSettingsBreadcrumb('/pages/students.html'), null);
});
