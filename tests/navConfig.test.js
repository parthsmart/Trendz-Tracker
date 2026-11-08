/**
 * Unit Tests for Single Navigation Config & Breakpoint Parity (tests/navConfig.test.js)
 *
 * Run with: node --test tests/navConfig.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_MOBILE_BREAKPOINT_PX,
  NAV_CONFIG,
  NAV_STAGE_AND_PUBLIC_ALLOWLIST,
  SETTINGS_SUBPAGE_PATHS,
  getRoleNavItems,
  getInlineNavItems,
  getDesktopNavEntries,
  getGroupedNavItems,
  isNavItemCurrent,
  formatShortFirstName,
} from '../js/navConfig.js';
import { SETTINGS_ENTRIES } from '../js/settingsHub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

function extractViteInputPages() {
  const viteConfigPath = path.join(ROOT_DIR, 'vite.config.ts');
  const content = fs.readFileSync(viteConfigPath, 'utf8');
  const regex = /path\.resolve\(__dirname,\s*['"]([^'"]+\.html)['"]\)/g;
  const pages = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const rel = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
    pages.push(rel);
  }
  return pages;
}

test('mobile breakpoint constant in css/variables.css and js/navConfig.js match (1024px)', () => {
  const cssVariablesPath = path.join(ROOT_DIR, 'css', 'variables.css');
  const cssContent = fs.readFileSync(cssVariablesPath, 'utf8');
  const match = cssContent.match(/--nav-mobile-breakpoint:\s*(\d+)px\s*;/);

  assert.ok(match, 'Expected --nav-mobile-breakpoint custom property in css/variables.css');
  const cssBreakpointPx = Number(match[1]);

  assert.equal(cssBreakpointPx, 1024, 'Expected CSS --nav-mobile-breakpoint to be 1024px');
  assert.equal(
    NAV_MOBILE_BREAKPOINT_PX,
    cssBreakpointPx,
    'Expected NAV_MOBILE_BREAKPOINT_PX in js/navConfig.js to match --nav-mobile-breakpoint in css/variables.css'
  );
});

test('every page in vite.config.ts input list appears in NAV_CONFIG for its role or in the explicit allowlist', () => {
  const vitePages = extractViteInputPages();
  assert.ok(vitePages.length >= 30, 'Expected Vite rollupOptions.input to list all HTML pages');

  const studentHrefs = new Set(NAV_CONFIG.student.map((item) => item.href));
  const adminHrefs = new Set(NAV_CONFIG.admin.map((item) => item.href));
  const allowlist = new Set(NAV_STAGE_AND_PUBLIC_ALLOWLIST);

  for (const pageHref of vitePages) {
    const inStudent = studentHrefs.has(pageHref);
    const inAdmin = adminHrefs.has(pageHref);
    const inAllowlist = allowlist.has(pageHref);

    assert.ok(
      inStudent || inAdmin || inAllowlist,
      `Vite input page "${pageHref}" is missing from NAV_CONFIG and not in NAV_STAGE_AND_PUBLIC_ALLOWLIST`
    );
  }

  for (const allowedPath of allowlist) {
    assert.ok(
      vitePages.includes(allowedPath),
      `Allowlisted path "${allowedPath}" does not exist in vite.config.ts input list`
    );
  }
});

test('no HTML page in pages/ contains hard-coded link lists inside .nav-zone (rendered exclusively from js/navConfig.js)', () => {
  const pagesDir = path.join(ROOT_DIR, 'pages');
  const htmlFiles = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length >= 29, 'Expected HTML files in pages/');

  for (const file of htmlFiles) {
    const content = fs.readFileSync(path.join(pagesDir, file), 'utf8');
    const navMatches = content.match(/<nav\s+class="nav-zone"[^>]*>([\s\S]*?)<\/nav>/g) || [];
    for (const navBlock of navMatches) {
      assert.equal(
        /<a\s+/i.test(navBlock),
        false,
        `Found hard-coded <a> link inside .nav-zone in pages/${file}; all header links must be rendered from js/navConfig.js`
      );
    }
  }
});

test('no href is duplicated within student or admin navigation config', () => {
  for (const role of ['student', 'admin']) {
    const items = getRoleNavItems(role);
    const seenHrefs = new Set();
    const seenIds = new Set();

    for (const item of items) {
      assert.ok(item.id && typeof item.id === 'string', `Missing id on ${role} nav item`);
      assert.ok(item.label && typeof item.label === 'string', `Missing label on ${item.id}`);
      assert.ok(item.href && typeof item.href === 'string', `Missing href on ${item.id}`);
      assert.ok(item.group && typeof item.group === 'string', `Missing group on ${item.id}`);

      assert.equal(
        seenHrefs.has(item.href),
        false,
        `Duplicate href "${item.href}" found in ${role} navigation config`
      );
      seenHrefs.add(item.href);

      assert.equal(
        seenIds.has(item.id),
        false,
        `Duplicate id "${item.id}" found in ${role} navigation config`
      );
      seenIds.add(item.id);
    }
  }
});

test('desktop navigation structure matches Phase 14e pre-14d restoration for student and admin', () => {
  const studentInline = getInlineNavItems('student').map((item) => item.label);
  assert.deepEqual(studentInline, [
    'Today',
    'Main Round',
    'Weekly Test',
    'Leaderboard',
    'Monthly Report',
  ]);

  const studentDesktopEntries = getDesktopNavEntries('student');
  assert.deepEqual(
    studentDesktopEntries.map((e) => (e.type === 'dropdown' ? `${e.label} ▾` : e.item.label)),
    [
      'Today',
      'Main Round',
      'Practice ▾',
      'Weekly Test',
      'Leaderboard',
      'Monthly Report',
      'Notifications',
    ]
  );

  const practiceDropdown = studentDesktopEntries.find((e) => e.type === 'dropdown');
  assert.deepEqual(
    practiceDropdown.items.map((i) => i.label),
    ['Basics', 'Flash Anzan', 'Elements', 'Memoriad']
  );

  const adminInline = getInlineNavItems('admin').map((item) => item.label);
  assert.deepEqual(adminInline, [
    'Overview',
    'Review',
    'Students',
    'Attendance',
    'Weekly Tests',
    'Leaderboard',
    'Monthly Report',
    'Settings',
  ]);

  const adminDesktopEntries = getDesktopNavEntries('admin');
  assert.deepEqual(
    adminDesktopEntries.map((e) => (e.type === 'dropdown' ? `${e.label} ▾` : e.item.label)),
    [
      'Overview',
      'Review',
      'Students',
      'Attendance',
      'Weekly Tests',
      'Leaderboard',
      'Monthly Report',
      'Settings',
    ]
  );

  const setupDropdown = adminDesktopEntries.find((e) => e.type === 'dropdown');
  assert.equal(setupDropdown, undefined, 'Admin desktop navigation should have zero dropdowns');
});

test('student config includes Practice group, Notifications badge key, Account, and Sign out', () => {
  const groups = getGroupedNavItems('student');
  const practiceGroup = groups.find((g) => g.group === 'Practice');
  assert.ok(practiceGroup, 'Expected Practice group in student nav');
  assert.deepEqual(
    practiceGroup.items.map((i) => i.label),
    ['Main Round', 'Basics', 'Flash Anzan', 'Elements', 'Memoriad']
  );

  const notifItem = NAV_CONFIG.student.find((i) => i.href === '/pages/notifications.html');
  assert.ok(notifItem, 'Expected Notifications item in student nav');
  assert.equal(notifItem.badge, 'notifications');

  const accountGroup = groups.find((g) => g.group === 'Account');
  assert.ok(accountGroup, 'Expected Account group in student nav');
  assert.deepEqual(
    accountGroup.items.map((i) => i.label),
    ['Account', 'Sign out']
  );
});

test('admin config has exactly one Settings entry linking to /pages/settings.html and exactly one Monthly Report entry', () => {
  const groups = getGroupedNavItems('admin');
  const settingsGroup = groups.find((g) => g.group === 'Settings');
  assert.ok(settingsGroup, 'Expected Settings group in admin nav');
  assert.equal(settingsGroup.items.length, 1);
  assert.equal(settingsGroup.items[0].href, '/pages/settings.html');
  assert.equal(settingsGroup.items[0].label, 'Settings');

  const overviewGroup = groups.find((g) => g.group === 'Overview');
  assert.ok(overviewGroup, 'Expected Overview group in admin nav');
  const monthlyReportItems = overviewGroup.items.filter((i) => i.href === '/pages/monthly-report.html');
  assert.equal(monthlyReportItems.length, 1, 'Expected exactly one Monthly Report item in admin nav');

  // Verify all setup tools are in SETTINGS_SUBPAGE_PATHS and reachable
  assert.equal(SETTINGS_SUBPAGE_PATHS.length, 9);
  for (const subPath of SETTINGS_SUBPAGE_PATHS) {
    assert.ok(
      SETTINGS_ENTRIES.some((e) => e.href === subPath),
      `Expected ${subPath} to be reachable via SETTINGS_ENTRIES in settings hub`
    );
  }
});

test('isNavItemCurrent and formatShortFirstName behave accurately', () => {
  const todayItem = NAV_CONFIG.student[0];
  assert.equal(isNavItemCurrent(todayItem, '/pages/student.html'), true);
  assert.equal(isNavItemCurrent(todayItem, '/pages/basics.html'), false);

  const signoutItem = NAV_CONFIG.student.find((i) => i.action === 'signout');
  assert.equal(isNavItemCurrent(signoutItem, '/pages/student.html'), false);

  // Settings item highlights for settings hub and all 9 subpages
  const settingsItem = NAV_CONFIG.admin.find((i) => i.href === '/pages/settings.html');
  assert.ok(settingsItem, 'Expected admin Settings nav item');
  assert.equal(isNavItemCurrent(settingsItem, '/pages/settings.html'), true);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/settings.html?group=all'), true);

  for (const subPath of SETTINGS_SUBPAGE_PATHS) {
    assert.equal(
      isNavItemCurrent(settingsItem, subPath),
      true,
      `Expected Settings nav item to be highlighted on subpage ${subPath}`
    );
    assert.equal(
      isNavItemCurrent(settingsItem, `${subPath}?tab=edit&id=1`),
      true,
      `Expected Settings nav item to be highlighted on subpage ${subPath} with query params`
    );
  }

  // Settings item does NOT highlight for other admin pages
  assert.equal(isNavItemCurrent(settingsItem, '/pages/monthly-report.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/admin.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/students.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/attendance.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/weekly-tests.html'), false);
  assert.equal(isNavItemCurrent(settingsItem, '/pages/leaderboard.html'), false);

  // Monthly Report item highlights for monthly-report.html only
  const monthlyReportItem = NAV_CONFIG.admin.find((i) => i.href === '/pages/monthly-report.html');
  assert.ok(monthlyReportItem);
  assert.equal(isNavItemCurrent(monthlyReportItem, '/pages/monthly-report.html'), true);
  assert.equal(isNavItemCurrent(monthlyReportItem, '/pages/monthly-report.html?id=STU1&month=2026-10'), true);
  assert.equal(isNavItemCurrent(monthlyReportItem, '/pages/settings.html'), false);

  assert.equal(formatShortFirstName('Aarav Sharma'), 'Aarav');
  assert.equal(formatShortFirstName('   Priya   '), 'Priya');
  assert.equal(formatShortFirstName('', 'Student'), 'Student');
});
