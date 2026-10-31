import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_GROUPS,
  SETTINGS_ENTRIES,
  filterSettingsEntries,
  getSettingsBreadcrumb
} from '../js/settingsHub.js';

test('SETTINGS_GROUPS and SETTINGS_ENTRIES have required groups and descriptions', () => {
  assert.deepEqual(
    SETTINGS_GROUPS.map(g => g.id),
    ['all', 'practice', 'competition', 'communication', 'data']
  );
  assert.ok(SETTINGS_ENTRIES.length >= 9);
  for (const entry of SETTINGS_ENTRIES) {
    assert.ok(entry.id);
    assert.ok(entry.title);
    assert.ok(entry.description);
    assert.ok(entry.href.startsWith('/pages/'));
    assert.ok(['practice', 'competition', 'communication', 'data'].includes(entry.group));
  }
});

test('filterSettingsEntries filters by group and search query case-insensitively', () => {
  const all = filterSettingsEntries(SETTINGS_ENTRIES, '', 'all');
  assert.equal(all.length, SETTINGS_ENTRIES.length);

  const practice = filterSettingsEntries(SETTINGS_ENTRIES, '', 'practice');
  assert.deepEqual(
    practice.map(e => e.id),
    ['todos', 'targets', 'categories', 'resources']
  );

  const backupQuery = filterSettingsEntries(SETTINGS_ENTRIES, 'JSON', 'all');
  assert.equal(backupQuery.length, 1);
  assert.equal(backupQuery[0].id, 'backup');

  const combined = filterSettingsEntries(SETTINGS_ENTRIES, 'announcements', 'communication');
  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, 'announcements');

  const noMatch = filterSettingsEntries(SETTINGS_ENTRIES, 'nonexistent-xyz', 'practice');
  assert.equal(noMatch.length, 0);
});

test('getSettingsBreadcrumb resolves matching entry by path', () => {
  const todoCrumb = getSettingsBreadcrumb('/pages/todos.html');
  assert.ok(todoCrumb);
  assert.equal(todoCrumb.breadcrumbTitle, 'Daily To-Do');

  const compCrumb = getSettingsBreadcrumb('/pages/competition.html?tab=points');
  assert.ok(compCrumb);
  assert.equal(compCrumb.breadcrumbTitle, 'Competition settings');

  assert.equal(getSettingsBreadcrumb('/pages/admin.html'), null);
});
