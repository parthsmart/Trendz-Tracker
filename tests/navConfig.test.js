/**
 * Unit Tests for Single Navigation Config (tests/navConfig.test.js)
 *
 * Run with: node --test tests/navConfig.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_CONFIG,
  NAV_STAGE_AND_PUBLIC_ALLOWLIST,
  getRoleNavItems,
  getInlineNavItems,
  getGroupedNavItems,
  isNavItemCurrent,
  formatShortFirstName,
} from '../js/navConfig.js';

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

test('short inline link lists match Phase 14d specification for >= 1100px width', () => {
  const studentInline = getInlineNavItems('student').map((item) => item.label);
  assert.deepEqual(studentInline, ['Today', 'Weekly Test', 'Leaderboard']);

  const adminInline = getInlineNavItems('admin').map((item) => item.label);
  assert.deepEqual(adminInline, ['Overview', 'Students', 'Review', 'Weekly Tests']);
});

test('student config includes Practice group, Notifications badge key, Account, and Sign out', () => {
  const groups = getGroupedNavItems('student');
  const practiceGroup = groups.find((g) => g.group === 'Practice');
  assert.ok(practiceGroup, 'Expected Practice group in student nav');
  assert.deepEqual(
    practiceGroup.items.map((i) => i.label),
    ['Round scores', 'Basics', 'Flash Anzan', 'Elements', 'Memoriad']
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

test('admin config links the Settings hub page and lists all admin settings pages under Settings', () => {
  const groups = getGroupedNavItems('admin');
  const settingsGroup = groups.find((g) => g.group === 'Settings');
  assert.ok(settingsGroup, 'Expected Settings group in admin nav');

  const hrefs = settingsGroup.items.map((i) => i.href);
  assert.equal(hrefs[0], '/pages/settings.html', 'Settings hub page should be linked first in Settings group');

  const expectedSettingsPages = [
    '/pages/settings.html',
    '/pages/todos.html',
    '/pages/resources.html',
    '/pages/categories.html',
    '/pages/rounds.html',
    '/pages/targets.html',
    '/pages/competition.html',
    '/pages/announcements.html',
    '/pages/report.html',
    '/pages/import.html',
    '/pages/backup.html',
  ];

  for (const expectedHref of expectedSettingsPages) {
    assert.ok(
      hrefs.includes(expectedHref),
      `Expected admin Settings group to include ${expectedHref}`
    );
  }
});

test('isNavItemCurrent and formatShortFirstName behave accurately', () => {
  const todayItem = NAV_CONFIG.student[0];
  assert.equal(isNavItemCurrent(todayItem, '/pages/student.html'), true);
  assert.equal(isNavItemCurrent(todayItem, '/pages/basics.html'), false);

  const signoutItem = NAV_CONFIG.student.find((i) => i.action === 'signout');
  assert.equal(isNavItemCurrent(signoutItem, '/pages/student.html'), false);

  assert.equal(formatShortFirstName('Aarav Sharma'), 'Aarav');
  assert.equal(formatShortFirstName('   Priya   '), 'Priya');
  assert.equal(formatShortFirstName('', 'Student'), 'Student');
});
