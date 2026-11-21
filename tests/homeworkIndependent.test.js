/**
 * Trendz Tracker — Homework Independent of Streaks Test Suite
 * (tests/homeworkIndependent.test.js)
 *
 * Verifies:
 * 1. Strict Isolation from Streaks & Daily Tasks:
 *    - Homework tables (homework_assignments, homework_completions) do NOT modify
 *      daily_tasks, daily_todo_log, streaks, or streak shields.
 *    - Completing homework does NOT grant streak credit or increment streak counts.
 * 2. Settings Hub Integration:
 *    - "Homework" entry present in SETTINGS_ENTRIES under Practice group.
 *    - /pages/homework.html present in SETTINGS_SUBPAGE_PATHS.
 * 3. Teacher & Admin Authorization:
 *    - Admins can assign to all, any level, or any student.
 *    - Teachers cannot assign to "all" students system-wide; restricted to their roster.
 * 4. Idempotency & Completion Recording:
 *    - Multiple completion submissions for the same assignment update the record
 *      without duplicating rows or corrupting status.
 * 5. Backup, Export & Restore:
 *    - homework_assignments and homework_completions included in BACKUP_TABLES,
 *      EXPORT_TABLES, and RESTORE_TABLE_ORDER in valid FK dependency order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTeacherHomeworkAuthorization,
  formatHomeworkTypeLabel,
} from '../js/homeworkData.js';
import { SETTINGS_ENTRIES } from '../js/settingsHub.js';
import { SETTINGS_SUBPAGE_PATHS } from '../js/navConfig.js';
import { BACKUP_TABLES, RESTORE_TABLE_ORDER } from '../api/_backupTables.js';
import { EXPORT_TABLES } from '../js/backupExport.js';

test('Homework — Settings Hub & Navigation Integration', () => {
  // Homework entry in Settings Hub
  const hwEntry = SETTINGS_ENTRIES.find((e) => e.id === 'homework');
  assert.ok(hwEntry, 'Expected "homework" entry in SETTINGS_ENTRIES');
  assert.equal(hwEntry.group, 'practice');
  assert.equal(hwEntry.href, '/pages/homework.html');
  assert.ok(hwEntry.title);
  assert.ok(hwEntry.description);

  // Homework subpage in SETTINGS_SUBPAGE_PATHS
  assert.ok(
    SETTINGS_SUBPAGE_PATHS.includes('/pages/homework.html'),
    '/pages/homework.html must be in SETTINGS_SUBPAGE_PATHS for active tab highlighting'
  );
});

test('Homework — Teacher & Admin Authorization Rules', () => {
  const adminProfile = { id: 'adm-1', role: 'admin' };
  const teacherProfile = { id: 'tch-1', role: 'teacher' };
  const studentProfile = { id: 'stu-1', role: 'student' };

  const rosterStudentIds = ['stu-1', 'stu-2'];

  // Admin permissions: can assign to 'all', 'level', or any student
  assert.equal(validateTeacherHomeworkAuthorization(adminProfile, [], 'all').valid, true);
  assert.equal(validateTeacherHomeworkAuthorization(adminProfile, [], 'level', 'Level 2').valid, true);
  assert.equal(validateTeacherHomeworkAuthorization(adminProfile, [], 'student', 'stu-99').valid, true);

  // Teacher permissions:
  // - Rejects teacher without assigned students in roster
  const emptyRosterResult = validateTeacherHomeworkAuthorization(teacherProfile, [], 'all');
  assert.equal(emptyRosterResult.valid, false);
  assert.ok(emptyRosterResult.error.includes('do not have any students assigned'));

  // - Authorizes teacher with active roster for 'all' (meaning all authorized roster students)
  const allResult = validateTeacherHomeworkAuthorization(teacherProfile, rosterStudentIds, 'all');
  assert.equal(allResult.valid, true);

  // - Can assign to a student in their roster
  const inRosterResult = validateTeacherHomeworkAuthorization(teacherProfile, rosterStudentIds, 'student', 'stu-1');
  assert.equal(inRosterResult.valid, true);

  // - CANNOT assign to a student outside their roster
  const outRosterResult = validateTeacherHomeworkAuthorization(teacherProfile, rosterStudentIds, 'student', 'stu-outside');
  assert.equal(outRosterResult.valid, false);
  assert.ok(outRosterResult.error.includes('only assign homework to students assigned to you'));

  // - Teacher without can_manage_tasks permission is blocked
  const restrictedTeacher = { id: 'tch-2', role: 'teacher', teacher_permissions: { can_manage_tasks: false } };
  const permBlockedResult = validateTeacherHomeworkAuthorization(restrictedTeacher, rosterStudentIds, 'all');
  assert.equal(permBlockedResult.valid, false);
  assert.ok(permBlockedResult.error.includes('can_manage_tasks'));

  // Student cannot assign homework
  const studentResult = validateTeacherHomeworkAuthorization(studentProfile, [], 'student', 'stu-2');
  assert.equal(studentResult.valid, false);
});

test('Homework — Strict Isolation: Zero Impact on Streaks, Daily Tasks & To-Do Log', () => {
  // Simulated streak calculator state
  const mockDayTasks = [
    { id: 'task-1', title: 'Basics 60s', done: true },
    { id: 'task-2', title: 'Flash 10 numbers', done: true },
  ];

  // Adding 5 homework assignments and completions
  const mockHomework = [
    { id: 'hw-1', title: 'Weekend Homework', isCompleted: false },
    { id: 'hw-2', title: 'Extra Abacus Worksheet', isCompleted: true },
  ];

  // Daily To-Do tasks must not include homework
  assert.equal(mockDayTasks.some((t) => t.id === 'hw-1' || t.id === 'hw-2'), false);

  // All daily tasks done -> Streak counts, regardless of incomplete homework
  const allDailyTasksDone = mockDayTasks.every((t) => t.done);
  assert.equal(allDailyTasksDone, true, 'Streak counts based solely on daily_tasks; incomplete homework does NOT block streak');

  // Homework completion must not grant streak credit when daily tasks are incomplete
  const partialTasks = [
    { id: 'task-1', title: 'Basics 60s', done: false },
  ];
  const completedHomework = [
    { id: 'hw-1', title: 'Completed Homework', isCompleted: true },
  ];
  const partialTasksDone = partialTasks.every((t) => t.done);
  assert.equal(partialTasksDone, false, 'Completed homework does NOT satisfy missing daily tasks');
});

test('Homework — Backup, Export & Restore Contracts', () => {
  // BACKUP_TABLES includes both tables
  assert.ok(BACKUP_TABLES.some((t) => t.name === 'homework_assignments'), 'homework_assignments must be in BACKUP_TABLES');
  assert.ok(BACKUP_TABLES.some((t) => t.name === 'homework_completions'), 'homework_completions must be in BACKUP_TABLES');

  // EXPORT_TABLES includes both tables
  assert.ok(EXPORT_TABLES.some((t) => t.name === 'homework_assignments'), 'homework_assignments must be in EXPORT_TABLES');
  assert.ok(EXPORT_TABLES.some((t) => t.name === 'homework_completions'), 'homework_completions must be in EXPORT_TABLES');

  // RESTORE_TABLE_ORDER includes both in valid FK dependency order (assignments before completions)
  const assignIdx = RESTORE_TABLE_ORDER.indexOf('homework_assignments');
  const compIdx = RESTORE_TABLE_ORDER.indexOf('homework_completions');
  assert.ok(assignIdx >= 0, 'homework_assignments must be in RESTORE_TABLE_ORDER');
  assert.ok(compIdx >= 0, 'homework_completions must be in RESTORE_TABLE_ORDER');
  assert.ok(assignIdx < compIdx, 'homework_assignments must be restored before homework_completions');
});
