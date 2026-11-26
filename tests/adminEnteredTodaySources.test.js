import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-11-25';

const student = (id, extra = {}) => ({
  student_id: id,
  student_code: id.toUpperCase(),
  full_name: id,
  level: 'Master',
  active: true,
  current_streak: 0,
  entered_today: false,
  last_entry_date: '2026-11-21',
  entries_7d: 2,
  accuracy_7d: 80,
  ...extra,
});

test('Main Round entries and Weekly Tests count as entered today', async () => {
  const { buildOtherPracticeRows, enrichOverviewRows, formatTimeIST } = await import('../js/adminOverview.js');

  const other = buildOtherPracticeRows(
    [
      // Main Round saved at 06:33 PM IST on the 25th
      { student_id: 'round', round_date: TODAY, created_at: '2026-11-25T13:03:57.279Z' },
      // Older Main Round only moves the last entry date
      { student_id: 'old-round', round_date: '2026-11-23', created_at: '2026-11-23T10:00:00Z' },
      { student_id: null, round_date: TODAY },
    ],
    [
      // Weekly test finished at 09:00 PM IST on the 25th
      { student_id: 'weekly', started_at: '2026-11-25T15:00:00Z', finished_at: '2026-11-25T15:30:00Z' },
      // Started late on the 24th IST, unfinished: belongs to the 24th
      { student_id: 'late', started_at: '2026-11-24T18:00:00Z', finished_at: null },
      { student_id: 'no-time', started_at: null, finished_at: null },
    ]
  );
  assert.deepEqual(other.map((o) => [o.student_id, o.day]), [
    ['round', TODAY],
    ['old-round', '2026-11-23'],
    ['weekly', TODAY],
    ['late', '2026-11-24'],
  ]);

  const rows = enrichOverviewRows(
    [student('round'), student('old-round'), student('weekly'), student('late'), student('none')],
    [],
    [],
    TODAY,
    other
  );
  const by = Object.fromEntries(rows.map((r) => [r.student_id, r]));

  assert.equal(by.round.entered_today, true);
  assert.equal(by.round.last_entry_date, TODAY);
  assert.equal(by.round.first_entry_time, formatTimeIST('2026-11-25T13:03:57.279Z'));
  assert.equal(by.round.entries_7d, 2, '7-day entries are unchanged');
  assert.equal(by.round.accuracy_7d, 80, '7-day accuracy is unchanged');

  assert.equal(by['old-round'].entered_today, false);
  assert.equal(by['old-round'].last_entry_date, '2026-11-23');

  assert.equal(by.weekly.entered_today, true);
  assert.equal(by.weekly.latest_entry_time, formatTimeIST('2026-11-25T15:30:00Z'));

  assert.equal(by.late.entered_today, false);
  assert.equal(by.late.last_entry_date, '2026-11-24');

  assert.equal(by.none.entered_today, false);
  assert.equal(by.none.last_entry_date, '2026-11-21');
});

test('future-dated Main Round entries do not mark a student as entered today', async () => {
  const { buildOtherPracticeRows, enrichOverviewRows } = await import('../js/adminOverview.js');
  const other = buildOtherPracticeRows([{ student_id: 'future', round_date: '2026-11-30', created_at: '2026-11-25T05:00:00Z' }], []);
  const [row] = enrichOverviewRows([student('future')], [], [], TODAY, other);
  assert.equal(row.entered_today, false);
  assert.equal(row.last_entry_date, '2026-11-21');
});

test('the overview still works without the extra practice rows', async () => {
  const { enrichOverviewRows } = await import('../js/adminOverview.js');
  const [row] = enrichOverviewRows([student('a')], [], [], TODAY);
  assert.equal(row.entered_today, false);
});

test('the admin overview loads Main Round entries and Weekly Test attempts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/adminOverview.js'), 'utf8');
  assert.match(src, /\.from\('student_rounds'\)/);
  assert.match(src, /\.from\('weekly_test_attempts'\)/);
  assert.match(src, /buildOtherPracticeRows\(roundsRes\?\.data \|\| null, weeklyRes\?\.data \|\| null\)/);
});
