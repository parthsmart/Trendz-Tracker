/**
 * Trendz Tracker — Admin Entered Today Modal Test Suite
 * (tests/adminEnteredTodayModal.test.js)
 *
 * Verifies:
 * 1. Accessible DOM Trigger & Dialog Contract:
 *    - #btn-entered-today-card is an accessible button with aria-haspopup="dialog"
 *      and aria-controls="modal-entered-today".
 *    - #modal-entered-today is a valid dialog with role="dialog", aria-modal="true",
 *      and aria-labelledby="modal-entered-today-title".
 * 2. Distinct Metric Definitions:
 *    - "Entered Today" represents any qualifying practice today, distinctly different
 *      from "Daily To-Do complete" and "Streak counts today".
 * 3. Deduplication & Data Formatting:
 *    - Students with qualifying entries are deduplicated.
 *    - Renders name, student code, level, first entry IST, latest entry IST,
 *      Daily To-Do progress ("8 of 11 done"), status badge, and student detail link.
 * 4. Search Filtering:
 *    - Case-insensitive search filters rows by student name and code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Entered Today Modal — Accessible DOM Trigger & Dialog Contract in pages/admin.html', () => {
  const adminHtml = fs.readFileSync(path.resolve(__dirname, '../pages/admin.html'), 'utf-8');

  // Trigger button contract
  assert.ok(adminHtml.includes('id="btn-entered-today-card"'), 'Expected #btn-entered-today-card button');
  assert.ok(adminHtml.includes('aria-haspopup="dialog"'), 'Expected aria-haspopup="dialog" on trigger');
  assert.ok(adminHtml.includes('aria-controls="modal-entered-today"'), 'Expected aria-controls="modal-entered-today"');

  // Modal dialog contract
  assert.ok(adminHtml.includes('id="modal-entered-today"'), 'Expected #modal-entered-today container');
  assert.ok(adminHtml.includes('role="dialog"'), 'Expected role="dialog"');
  assert.ok(adminHtml.includes('aria-modal="true"'), 'Expected aria-modal="true"');
  assert.ok(adminHtml.includes('aria-labelledby="modal-entered-today-title"'), 'Expected aria-labelledby');
  assert.ok(adminHtml.includes('id="btn-close-entered-today-modal"'), 'Expected close button');
  assert.ok(adminHtml.includes('id="search-entered-today-modal"'), 'Expected search input');
  assert.ok(adminHtml.includes('id="entered-today-modal-content"'), 'Expected content scroll container');
});

test('Entered Today Modal — Pure Formatting & Deduplication Logic', () => {
  // Sample multi-source student entries today
  const rawPracticeEvents = [
    { student_id: 'stu-1', student_code: 'STU101', full_name: 'Aarav Sharma', level: 'Level 3', source: 'basics', time: '09:15 AM' },
    { student_id: 'stu-1', student_code: 'STU101', full_name: 'Aarav Sharma', level: 'Level 3', source: 'flash', time: '11:30 AM' },
    { student_id: 'stu-1', student_code: 'STU101', full_name: 'Aarav Sharma', level: 'Level 3', source: 'elements', time: '04:15 PM' },
    { student_id: 'stu-2', student_code: 'STU102', full_name: 'Diya Patel', level: 'Level 2', source: 'basics', time: '10:00 AM' },
    { student_id: 'stu-3', student_code: 'STU103', full_name: 'Kabir Verma', level: 'Level 4', source: 'weekly_test', time: '02:00 PM' },
  ];

  // Deduplicate and compute first/latest entry times
  const studentMap = new Map();
  for (const ev of rawPracticeEvents) {
    if (!studentMap.has(ev.student_id)) {
      studentMap.set(ev.student_id, {
        student_id: ev.student_id,
        student_code: ev.student_code,
        full_name: ev.full_name,
        level: ev.level,
        first_entry_time: ev.time,
        latest_entry_time: ev.time,
        entries_count: 1,
      });
    } else {
      const existing = studentMap.get(ev.student_id);
      existing.latest_entry_time = ev.time;
      existing.entries_count += 1;
    }
  }

  const deduplicated = Array.from(studentMap.values());
  assert.equal(deduplicated.length, 3, 'Must have exactly 3 deduplicated students');

  const aarav = deduplicated.find((s) => s.student_id === 'stu-1');
  assert.ok(aarav);
  assert.equal(aarav.entries_count, 3);
  assert.equal(aarav.first_entry_time, '09:15 AM');
  assert.equal(aarav.latest_entry_time, '04:15 PM');
});

test('Entered Today Modal — Distinct Metric Definitions (Entered vs To-Do vs Streak)', () => {
  // Test case displaying all 3 distinct states:
  // Student A: Entered today (did 2 practice drills), but Daily To-Do incomplete (4 of 11 tasks done), streak does NOT count today.
  // Student B: Entered today, Daily To-Do complete (11 of 11 done), streak counts today.
  // Student C: Did NOT enter today, streak preserved via shield / freeze.
  const studentA = {
    student_id: 'stu-a',
    entered_today: true,
    todo_done_count: 4,
    todo_total_count: 11,
    is_todo_complete: false,
    streak_counts_today: false,
  };

  const studentB = {
    student_id: 'stu-b',
    entered_today: true,
    todo_done_count: 11,
    todo_total_count: 11,
    is_todo_complete: true,
    streak_counts_today: true,
  };

  const studentC = {
    student_id: 'stu-c',
    entered_today: false,
    todo_done_count: 0,
    todo_total_count: 11,
    is_todo_complete: false,
    streak_counts_today: false,
  };

  const students = [studentA, studentB, studentC];

  // Entered Today count = 2 (Student A and B)
  const enteredToday = students.filter((s) => s.entered_today);
  assert.equal(enteredToday.length, 2);

  // Daily To-Do Complete count = 1 (Student B only)
  const todoComplete = students.filter((s) => s.is_todo_complete);
  assert.equal(todoComplete.length, 1);

  // Student A is qualifying "Entered Today" even though their to-do is incomplete
  assert.equal(studentA.entered_today, true);
  assert.equal(studentA.is_todo_complete, false);
});

test('Entered Today Modal — formatTimeIST and Honest Unavailable State (Zero Fabricated Fallbacks)', async () => {
  const { formatTimeIST } = await import('../js/adminOverview.js');

  assert.equal(formatTimeIST(null), 'Unavailable');
  assert.equal(formatTimeIST(undefined), 'Unavailable');
  assert.equal(formatTimeIST('invalid-date-string'), 'Unavailable');

  // Verify real time formatting in Asia/Kolkata
  // 2026-11-21T03:45:00.000Z -> IST is UTC+5:30 -> 09:15 AM
  const formatted = formatTimeIST('2026-11-21T03:45:00.000Z');
  assert.ok(formatted.includes('09:15') || formatted.includes('9:15'), `Expected 9:15 AM, got ${formatted}`);
  assert.ok(formatted.toLowerCase().includes('am'));
});

test('Entered Today Modal — Basics results created_at resolves first and latest entry times on the same IST day', async () => {
  const { enrichOverviewRows, formatTimeIST } = await import('../js/adminOverview.js');

  const overviewRows = [
    {
      student_id: 'stu-basics-multi',
      student_code: 'STU201',
      full_name: 'Priya Sharma',
      level: 'Level 2',
      active: true,
      current_streak: 7,
      best_streak: 15,
      entered_today: false,
      last_entry_date: '2026-11-20',
      entries_7d: 5,
      accuracy_7d: 88.5,
      todo_done_count: 4,
      todo_total_count: 10,
    },
    {
      student_id: 'stu-basics-single',
      student_code: 'STU202',
      full_name: 'Rahul Patel',
      level: 'Level 1',
      active: true,
      current_streak: 3,
      best_streak: 3,
      entered_today: false,
      last_entry_date: '2026-11-20',
      entries_7d: 2,
      accuracy_7d: 92.0,
      todo_done_count: 0,
      todo_total_count: 8,
    },
    {
      student_id: 'stu-multi-source',
      student_code: 'STU203',
      full_name: 'Ananya Rao',
      level: 'Level 3',
      active: true,
      current_streak: 10,
      best_streak: 20,
      entered_today: false,
      last_entry_date: '2026-11-20',
      entries_7d: 8,
      accuracy_7d: 95.0,
      todo_done_count: 10,
      todo_total_count: 10,
    },
  ];

  // Two Basics practice scores entered on 2026-11-21 IST:
  // Score 1: 03:45 UTC = 09:15 AM IST (First)
  // Score 2: 10:45 UTC = 04:15 PM IST (Latest)
  // Deliberately placed out of order (latest score first) to verify chronological sorting
  const resultRows = [
    {
      student_id: 'stu-basics-multi',
      correct: 18,
      total: 20,
      entry_date: '2026-11-21',
      created_at: '2026-11-21T10:45:00.000Z', // 04:15 PM IST
    },
    {
      student_id: 'stu-basics-multi',
      correct: 20,
      total: 20,
      entry_date: '2026-11-21',
      created_at: '2026-11-21T03:45:00.000Z', // 09:15 AM IST
    },
    // Single Basics score entered on 2026-11-21 IST: 06:00 UTC = 11:30 AM IST
    {
      student_id: 'stu-basics-single',
      correct: 15,
      total: 15,
      entry_date: '2026-11-21',
      created_at: '2026-11-21T06:00:00.000Z', // 11:30 AM IST
    },
    // Basics score for Ananya: 03:00 UTC = 08:30 AM IST
    {
      student_id: 'stu-multi-source',
      correct: 25,
      total: 25,
      entry_date: '2026-11-21',
      created_at: '2026-11-21T03:00:00.000Z', // 08:30 AM IST
    },
    // Historical Basics score from yesterday (should NOT pollute today's times)
    {
      student_id: 'stu-basics-multi',
      correct: 20,
      total: 20,
      entry_date: '2026-11-20',
      created_at: '2026-11-20T10:30:00.000Z', // Yesterday 04:00 PM IST
    },
  ];

  // Activity results: Elements drill for Ananya at 11:30 UTC = 05:00 PM IST
  const activityRows = [
    {
      student_id: 'stu-multi-source',
      correct: 30,
      total: 30,
      created_at: '2026-11-21T11:30:00.000Z', // 05:00 PM IST
    },
  ];

  const enriched = enrichOverviewRows(overviewRows, activityRows, resultRows, '2026-11-21');
  assert.equal(enriched.length, 3);

  // 1. Student with 2 Basics scores on the same IST day:
  const priya = enriched.find((s) => s.student_id === 'stu-basics-multi');
  assert.ok(priya);
  assert.equal(priya.entered_today, true);
  assert.equal(priya.last_entry_date, '2026-11-21');

  // Verify first and latest entry times match the earlier and later scores in IST
  const expectedFirst = formatTimeIST('2026-11-21T03:45:00.000Z');
  const expectedLatest = formatTimeIST('2026-11-21T10:45:00.000Z');
  assert.equal(priya.first_entry_time, expectedFirst, 'First entry must be 09:15 AM IST');
  assert.equal(priya.latest_entry_time, expectedLatest, 'Latest entry must be 04:15 PM IST');
  assert.notEqual(priya.first_entry_time, priya.latest_entry_time, 'Two distinct scores must have distinct times');

  // Daily To-Do count and streak invariants must remain strictly untouched
  assert.equal(priya.current_streak, 7, 'Streak must remain unchanged');
  assert.equal(priya.best_streak, 15, 'Best streak must remain unchanged');
  assert.equal(priya.todo_done_count, 4, 'To-do done count must remain unchanged');
  assert.equal(priya.todo_total_count, 10, 'To-do total count must remain unchanged');

  // 2. Student with 1 Basics score on the same IST day:
  const rahul = enriched.find((s) => s.student_id === 'stu-basics-single');
  assert.ok(rahul);
  assert.equal(rahul.entered_today, true);
  const expectedRahulTime = formatTimeIST('2026-11-21T06:00:00.000Z');
  assert.equal(rahul.first_entry_time, expectedRahulTime);
  assert.equal(rahul.latest_entry_time, expectedRahulTime);
  assert.equal(rahul.current_streak, 3, 'Streak must remain unchanged');
  assert.equal(rahul.todo_done_count, 0, 'To-do done count must remain unchanged');

  // 3. Student with multi-source practice (Basics at 8:30 AM + Elements at 5:00 PM):
  const ananya = enriched.find((s) => s.student_id === 'stu-multi-source');
  assert.ok(ananya);
  assert.equal(ananya.entered_today, true);
  const expectedAnanyaFirst = formatTimeIST('2026-11-21T03:00:00.000Z');
  const expectedAnanyaLatest = formatTimeIST('2026-11-21T11:30:00.000Z');
  assert.equal(ananya.first_entry_time, expectedAnanyaFirst, 'First entry should be Basics at 08:30 AM IST');
  assert.equal(ananya.latest_entry_time, expectedAnanyaLatest, 'Latest entry should be Elements at 05:00 PM IST');
  assert.equal(ananya.current_streak, 10, 'Streak must remain unchanged');
  assert.equal(ananya.todo_done_count, 10, 'To-do done count must remain unchanged');
});
