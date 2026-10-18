/**
 * Trendz Tracker - Demo Database Module (js/demoDb.js)
 * 
 * NOTE FOR PRODUCTION LAUNCH:
 * This file contains isolated, fixed static sample data used ONLY when live Supabase
 * credentials are unconfigured/placeholders. When real credentials are configured in
 * js/config.js and .env, this mock mode is strictly disabled and unreachable.
 * This entire file can be safely deleted prior to production launch.
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';

// Static keys for demo state persistence
const DEMO_STORAGE_KEY_STUDENTS = 'trendz_demo_students_v2';
const DEMO_STORAGE_KEY_CATEGORIES = 'trendz_demo_categories_v2';
const DEMO_STORAGE_KEY_AUTH = 'trendz_demo_auth_v2';
const DEMO_STORAGE_KEY_TODOS = 'trendz_demo_todos_v2';
const DEMO_STORAGE_KEY_RESOURCES = 'trendz_demo_resources_v2';
const DEMO_STORAGE_KEY_RESULTS = 'trendz_demo_results_v2';
const DEMO_STORAGE_KEY_AUDIT = 'trendz_demo_audit_v2';
const DEMO_STORAGE_KEY_SESSIONS = 'trendz_demo_sessions_v2';
const DEMO_STORAGE_KEY_ATTENDANCE = 'trendz_demo_attendance_v2';
const DEMO_STORAGE_KEY_TARGETS = 'trendz_demo_targets_v2';
const DEMO_STORAGE_KEY_WEEKLY_TESTS = 'trendz_demo_weekly_tests_v2';
const DEMO_STORAGE_KEY_WEEKLY_SCORES = 'trendz_demo_weekly_scores_v2';

export const DEFAULT_ROUND_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'HCF and LCM', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Approximation', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const DEFAULT_BASICS_CATEGORIES = ['1d4r', '2d2r'];

/**
 * Returns whether Demo Mode is currently active.
 * STRICT SECURITY RULE: Demo mode turns on ONLY when Supabase keys are placeholders
 * AND only on localhost or run.app hosts. On production hostnames, it always returns false.
 */
export function isDemoMode() {
  return !isSupabaseConfigured() && isDemoAllowedHost();
}

/**
 * Initializes static fake data for demo testing.
 */
function initDemoStorage() {
  if (typeof localStorage === 'undefined') return;

  // 1. Initial Students
  if (!localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS)) {
    const initialStudents = [
      { id: 'usr-101', student_code: 'STU101', full_name: 'Aarav Sharma', role: 'student', level: 'Level 3', active: true, created_at: '2026-10-01T10:00:00.000Z' },
      { id: 'usr-102', student_code: 'STU102', full_name: 'Diya Patel', role: 'student', level: 'Level 2', active: true, created_at: '2026-10-02T10:00:00.000Z' },
      { id: 'usr-103', student_code: 'STU103', full_name: 'Kabir Verma', role: 'student', level: 'Level 4', active: true, created_at: '2026-10-03T10:00:00.000Z' },
      { id: 'usr-104', student_code: 'STU104', full_name: 'Ananya Iyer', role: 'student', level: 'Level 1', active: false, created_at: '2026-10-04T10:00:00.000Z' },
      { id: 'usr-105', student_code: 'STU105', full_name: 'Rohan Mehra', role: 'student', level: 'Level 2', active: true, created_at: '2026-10-05T10:00:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(initialStudents));
  }

  // 2. Initial Categories
  if (!localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES)) {
    const initialCats = [];
    DEFAULT_ROUND_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-rnd-${index + 1}`,
        name,
        section: 'round',
        sort_order: index + 1,
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      });
    });
    DEFAULT_BASICS_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-bas-${index + 1}`,
        name,
        section: 'basics',
        sort_order: index + 1,
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      });
    });
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORIES, JSON.stringify(initialCats));
  }

  // 3. Initial Resources
  if (!localStorage.getItem(DEMO_STORAGE_KEY_RESOURCES)) {
    const initialResources = [
      {
        id: 'res-1',
        title: 'Junior World Championship Official Rules 2026',
        url: 'https://trendzabacus.com/rules-2026.pdf',
        description: 'Official timing, round structure, and calculation rules for Junior category.',
        topic: 'Championship Guidelines',
        sort_order: 1,
        active: true,
        created_at: '2026-10-10T10:00:00.000Z'
      },
      {
        id: 'res-2',
        title: 'Mental Addition & Subtraction Speed Handbook',
        url: 'https://trendzabacus.com/guides/add-sub-speed.pdf',
        description: 'Tips for rapid 1-digit and 2-digit row visualization without hesitation.',
        topic: 'Calculation Techniques',
        sort_order: 2,
        active: true,
        created_at: '2026-10-11T10:00:00.000Z'
      },
      {
        id: 'res-3',
        title: 'Calendar & Day Calculation Shortcuts',
        url: 'https://trendzabacus.com/guides/calendar-tricks.pdf',
        description: 'Doomsday rule and modular arithmetic shortcuts for calendar tasks.',
        topic: 'Calculation Techniques',
        sort_order: 3,
        active: true,
        created_at: '2026-10-12T10:00:00.000Z'
      },
      {
        id: 'res-4',
        title: 'Daily Practice Routine & Warm-Up Drills',
        url: 'https://trendzabacus.com/practice/warmup.pdf',
        description: 'Structured 20-minute daily regimen prior to competition round simulation.',
        topic: 'Practice Materials',
        sort_order: 4,
        active: true,
        created_at: '2026-10-13T10:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_RESOURCES, JSON.stringify(initialResources));
  }

  // 4. Initial To-Dos
  if (!localStorage.getItem(DEMO_STORAGE_KEY_TODOS)) {
    const initialTodos = [
      { id: 'todo-1', title: 'Round Drill: Addition (ADD)', section: 'round', category_id: 'cat-rnd-1', level: null, sort_order: 1, active: true },
      { id: 'todo-2', title: 'Round Drill: Subtraction (SUB)', section: 'round', category_id: 'cat-rnd-2', level: null, sort_order: 2, active: true },
      { id: 'todo-3', title: 'Round Drill: Multiplication (MULT)', section: 'round', category_id: 'cat-rnd-4', level: null, sort_order: 3, active: true },
      { id: 'todo-4', title: 'Round Drill: Division (DIV)', section: 'round', category_id: 'cat-rnd-5', level: null, sort_order: 4, active: true },
      { id: 'todo-5', title: 'Mental Basics: 1-digit 4-rows (1d4r)', section: 'basics', category_id: 'cat-bas-1', level: null, sort_order: 5, active: true },
      { id: 'todo-6', title: 'Mental Basics: 2-digit 2-rows (2d2r)', section: 'basics', category_id: 'cat-bas-2', level: null, sort_order: 6, active: true },
      { id: 'todo-7', title: 'Any Round Competition Task', section: 'round', category_id: null, level: null, sort_order: 7, active: true }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_TODOS, JSON.stringify(initialTodos));
  }

  // 5. Initial Results (90-day sample data for STU101 across 5 rounds and daily basics)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_RESULTS)) {
    const sampleResults = [];
    const now = new Date();
    
    // Sample rounds: 240, 241, 242, 243, 244
    const rounds = [240, 241, 242, 243, 244];
    rounds.forEach((roundNum, rIdx) => {
      const daysAgo = (4 - rIdx) * 2;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      
      DEFAULT_ROUND_CATEGORIES.forEach((catName, cIdx) => {
        // Some categories in older rounds left unattempted to demonstrate partial rounds
        if (roundNum === 240 && cIdx > 18) return;
        if (roundNum === 241 && cIdx > 20) return;

        const total = 20;
        // High accuracy with occasional realistic mistakes
        let correct = total;
        if (cIdx % 7 === 1) correct = 19;
        else if (cIdx % 7 === 3) correct = 18;
        else if (cIdx % 7 === 5) correct = 17;

        sampleResults.push({
          id: `res-rnd-${roundNum}-${cIdx + 1}`,
          student_id: 'usr-101',
          round_number: roundNum,
          category_id: `cat-rnd-${cIdx + 1}`,
          correct,
          total,
          time_seconds: 45 + (cIdx % 5) * 8,
          note: null,
          entry_date: roundDate,
          created_at: new Date(now.getTime() - daysAgo * 86400000 + cIdx * 60000).toISOString(),
          verified_by: roundNum <= 241 ? 'usr-admin-1' : null,
          verified_at: roundNum <= 241 ? new Date(now.getTime() - (daysAgo - 1) * 86400000).toISOString() : null,
          corrected_by: roundNum === 242 && cIdx === 2 ? 'usr-admin-1' : null,
          corrected_at: roundNum === 242 && cIdx === 2 ? new Date(now.getTime() - 2 * 86400000).toISOString() : null,
          flagged: roundNum === 243 && cIdx === 4,
          flag_note: roundNum === 243 && cIdx === 4 ? 'Please re-verify your multiplication count against your practice worksheet.' : null
        });
      });
    });

    // Add diverse sample results for STU102, STU103, STU107
    const otherStudents = ['usr-102', 'usr-103', 'usr-105', 'usr-107'];
    otherStudents.forEach((stuId, sIdx) => {
      const stuRounds = [243, 244];
      stuRounds.forEach(rNum => {
        sampleResults.push({
          id: `res-rnd-${stuId}-${rNum}-1`,
          student_id: stuId,
          round_number: rNum,
          category_id: 'cat-rnd-1',
          correct: 20,
          total: 20,
          time_seconds: 42 + sIdx * 3,
          note: null,
          entry_date: new Date(now.getTime() - (244 - rNum) * 86400000).toISOString().split('T')[0],
          created_at: new Date(now.getTime() - (244 - rNum) * 86400000 + sIdx * 3600000).toISOString(),
          verified_by: null,
          verified_at: null,
          corrected_by: null,
          corrected_at: null,
          flagged: sIdx === 1,
          flag_note: sIdx === 1 ? 'Check your entered time, was it 45s or 1:45?' : null
        });
      });
    });

    // Sample basics over the last 14 days
    for (let day = 0; day < 14; day++) {
      const dateStr = new Date(now.getTime() - day * 86400000).toISOString().split('T')[0];
      // 1d4r entry
      sampleResults.push({
        id: `res-bas-1d-${day}`,
        student_id: 'usr-101',
        round_number: null,
        category_id: 'cat-bas-1',
        correct: 19 + (day % 2),
        total: 20,
        time_seconds: 32 + (day % 4),
        note: 'Daily speed sprint',
        entry_date: dateStr,
        created_at: new Date(now.getTime() - day * 86400000 + 3600000).toISOString(),
        verified_by: day >= 7 ? 'usr-admin-1' : null,
        verified_at: day >= 7 ? new Date(now.getTime() - (day - 1) * 86400000).toISOString() : null,
        corrected_by: null,
        corrected_at: null,
        flagged: false,
        flag_note: null
      });
      // 2d2r entry
      if (day % 2 === 0) {
        sampleResults.push({
          id: `res-bas-2d-${day}`,
          student_id: 'usr-101',
          round_number: null,
          category_id: 'cat-bas-2',
          correct: 18 + (day % 3 === 0 ? 2 : 1),
          total: 20,
          time_seconds: 40 + (day % 5),
          note: '2-digit concentration',
          entry_date: dateStr,
          created_at: new Date(now.getTime() - day * 86400000 + 7200000).toISOString(),
          verified_by: null,
          verified_at: null,
          corrected_by: null,
          corrected_at: null,
          flagged: day === 2,
          flag_note: day === 2 ? 'Please re-attempt this drill with timer visible.' : null
        });
      }
    }

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(sampleResults));
  }

  // 6. Initial Audit Logs (result_audit)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_AUDIT)) {
    const initialAudits = [
      {
        id: 'aud-1',
        result_id: 'res-rnd-240-1',
        student_id: 'usr-101',
        changed_by: 'usr-admin-1',
        changed_at: '2026-10-14T08:00:00.000Z',
        action: 'verify',
        old_values: { verified: false },
        new_values: { verified: true, verified_by: 'usr-admin-1' },
        reason: 'Verified against teacher round assessment'
      },
      {
        id: 'aud-2',
        result_id: 'res-rnd-242-3',
        student_id: 'usr-101',
        changed_by: 'usr-admin-1',
        changed_at: '2026-10-16T12:00:00.000Z',
        action: 'correct',
        old_values: { correct: 18, total: 20, time_seconds: 61 },
        new_values: { correct: 19, total: 20, time_seconds: 59 },
        reason: 'Corrected 1 miscounted question after paper review'
      },
      {
        id: 'aud-3',
        result_id: 'res-rnd-243-5',
        student_id: 'usr-101',
        changed_by: 'usr-admin-1',
        changed_at: '2026-10-17T09:30:00.000Z',
        action: 'flag',
        old_values: { flagged: false },
        new_values: { flagged: true, flag_note: 'Please re-verify your multiplication count' },
        reason: 'Flagged for student self-check'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_AUDIT, JSON.stringify(initialAudits));
  }

  // 7. Initial Attendance Sessions
  if (!localStorage.getItem(DEMO_STORAGE_KEY_SESSIONS)) {
    const initialSessions = [
      {
        id: 'ses-101',
        session_date: '2026-10-18',
        title: 'Sunday Competition Prep & Finals Workshop',
        session_type: 'workshop',
        notes: 'Covered mental square root, ratio approximations, and speed drill pacing.',
        created_by: 'usr-admin-1',
        created_at: '2026-10-18T04:30:00.000Z'
      },
      {
        id: 'ses-102',
        session_date: '2026-10-16',
        title: 'Friday Speed Drills & Flash Mental Class',
        session_type: 'class',
        notes: 'Timed rounds 242-244 review.',
        created_by: 'usr-admin-1',
        created_at: '2026-10-16T11:00:00.000Z'
      },
      {
        id: 'ses-103',
        session_date: '2026-10-14',
        title: 'Wednesday Prime Factors & HCF-LCM Masterclass',
        session_type: 'class',
        notes: 'Special division techniques for 3-digit denominators.',
        created_by: 'usr-admin-1',
        created_at: '2026-10-14T11:00:00.000Z'
      },
      {
        id: 'ses-104',
        session_date: '2026-10-11',
        title: 'Saturday Championship Mock Exam #12',
        session_type: 'other',
        notes: 'Full 24-category timed mock under competition conditions.',
        created_by: 'usr-admin-1',
        created_at: '2026-10-11T05:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_SESSIONS, JSON.stringify(initialSessions));
  }

  // 8. Initial Attendance Records
  if (!localStorage.getItem(DEMO_STORAGE_KEY_ATTENDANCE)) {
    const initialAttendance = [
      // ses-101
      { id: 'att-101-1', session_id: 'ses-101', student_id: 'usr-101', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-2', session_id: 'ses-101', student_id: 'usr-102', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-3', session_id: 'ses-101', student_id: 'usr-103', status: 'excused', note: 'School science exhibition', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-5', session_id: 'ses-101', student_id: 'usr-105', status: 'absent', note: 'Uninformed absence', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-6', session_id: 'ses-101', student_id: 'usr-106', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-7', session_id: 'ses-101', student_id: 'usr-107', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-8', session_id: 'ses-101', student_id: 'usr-108', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-9', session_id: 'ses-101', student_id: 'usr-109', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },
      { id: 'att-101-10', session_id: 'ses-101', student_id: 'usr-110', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-18T05:00:00.000Z' },

      // ses-102
      { id: 'att-102-1', session_id: 'ses-102', student_id: 'usr-101', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' },
      { id: 'att-102-2', session_id: 'ses-102', student_id: 'usr-102', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' },
      { id: 'att-102-3', session_id: 'ses-102', student_id: 'usr-103', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' },
      { id: 'att-102-5', session_id: 'ses-102', student_id: 'usr-105', status: 'absent', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' },
      { id: 'att-102-6', session_id: 'ses-102', student_id: 'usr-106', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' },
      { id: 'att-102-7', session_id: 'ses-102', student_id: 'usr-107', status: 'present', note: '', marked_by: 'usr-admin-1', marked_at: '2026-10-16T11:30:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_ATTENDANCE, JSON.stringify(initialAttendance));
  }

  // 9. Initial Basics Targets (Phase 4b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_TARGETS)) {
    const initialTargets = [
      {
        id: 'tgt-1',
        category_id: 'cat-bas-1', // 1d4r
        level: null, // default rule
        min_accuracy: 90,
        max_time_seconds: 120, // 2:00
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'tgt-2',
        category_id: 'cat-bas-1', // 1d4r
        level: 'Level 1',
        min_accuracy: 85,
        max_time_seconds: 150, // 2:30
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'tgt-3',
        category_id: 'cat-bas-1', // 1d4r
        level: 'Level 2',
        min_accuracy: 95,
        max_time_seconds: 90, // 1:30
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'tgt-4',
        category_id: 'cat-bas-2', // 2d2r
        level: null, // default rule
        min_accuracy: 80,
        max_time_seconds: 180, // 3:00
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      },
      {
        id: 'tgt-5',
        category_id: 'cat-bas-2', // 2d2r
        level: 'Level 3',
        min_accuracy: 90,
        max_time_seconds: 120, // 2:00
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_TARGETS, JSON.stringify(initialTargets));
  }

  // 10. Initial Weekly Tests (Phase 4b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS)) {
    const initialWeeklyTests = [
      {
        id: 'wkt-1',
        test_date: '2026-10-18',
        title: 'Weekly Speed & Accuracy Sprint #42',
        notes: 'Covers 1d4r basics and 2d2r mental calculation speed check.',
        created_at: '2026-10-18T04:00:00.000Z'
      },
      {
        id: 'wkt-2',
        test_date: '2026-10-11',
        title: 'Sunday Competition Mock Test #41',
        notes: 'Preparation for National Abacus Qualifier.',
        created_at: '2026-10-11T04:00:00.000Z'
      },
      {
        id: 'wkt-3',
        test_date: '2026-10-04',
        title: 'Flash & Mental Assessment #40',
        notes: 'Focus on times under 2:00.',
        created_at: '2026-10-04T04:00:00.000Z'
      },
      {
        id: 'wkt-4',
        test_date: '2026-09-27',
        title: 'Monthly Evaluation Mock #39',
        notes: 'Diagnostic drill check across all sections.',
        created_at: '2026-09-27T04:00:00.000Z'
      },
      {
        id: 'wkt-5',
        test_date: '2026-09-20',
        title: 'Speed Assessment Sprint #38',
        notes: 'Basics baseline benchmarks.',
        created_at: '2026-09-20T04:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(initialWeeklyTests));
  }

  // 11. Initial Weekly Test Scores (Phase 4b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES)) {
    const initialWeeklyScores = [
      // Test 1: wkt-1
      { id: 'sc-1-1', test_id: 'wkt-1', student_id: 'usr-102', category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 95, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-2', test_id: 'wkt-1', student_id: 'usr-102', category_id: 'cat-bas-2', correct: 18, total: 20, time_seconds: 110, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-3', test_id: 'wkt-1', student_id: 'usr-101', category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 85, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-4', test_id: 'wkt-1', student_id: 'usr-103', category_id: 'cat-bas-1', correct: 17, total: 20, time_seconds: 135, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-5', test_id: 'wkt-1', student_id: 'usr-105', category_id: 'cat-bas-1', correct: 15, total: 20, time_seconds: 155, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-6', test_id: 'wkt-1', student_id: 'usr-106', category_id: 'cat-bas-1', correct: 18, total: 20, time_seconds: 115, created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-7', test_id: 'wkt-1', student_id: 'usr-107', category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 78, created_at: '2026-10-18T05:00:00.000Z' },
      // Test 2: wkt-2
      { id: 'sc-2-1', test_id: 'wkt-2', student_id: 'usr-102', category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 88, created_at: '2026-10-11T05:00:00.000Z' },
      { id: 'sc-2-2', test_id: 'wkt-2', student_id: 'usr-102', category_id: 'cat-bas-2', correct: 19, total: 20, time_seconds: 105, created_at: '2026-10-11T05:00:00.000Z' },
      { id: 'sc-2-3', test_id: 'wkt-2', student_id: 'usr-101', category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 90, created_at: '2026-10-11T05:00:00.000Z' },
      // Test 3: wkt-3
      { id: 'sc-3-1', test_id: 'wkt-3', student_id: 'usr-102', category_id: 'cat-bas-1', correct: 18, total: 20, time_seconds: 102, created_at: '2026-10-04T05:00:00.000Z' },
      // Test 4: wkt-4
      { id: 'sc-4-1', test_id: 'wkt-4', student_id: 'usr-102', category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 94, created_at: '2026-09-27T05:00:00.000Z' },
      // Test 5: wkt-5
      { id: 'sc-5-1', test_id: 'wkt-5', student_id: 'usr-102', category_id: 'cat-bas-1', correct: 17, total: 20, time_seconds: 115, created_at: '2026-09-20T05:00:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(initialWeeklyScores));
  }
}

/**
 * Interactive Mock Database implementation for Demo Mode
 */
export const DemoDB = {
  getStudents() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS) || '[]');
  },
  saveStudents(students) {
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(students));
  },
  addStudent({ student_code, full_name, level }) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const students = this.getStudents();
    const cleanCode = student_code.trim().toUpperCase();
    if (students.some(s => s.student_code === cleanCode)) {
      throw new Error(`Student code "${cleanCode}" is already in use.`);
    }
    const newStudent = {
      id: `usr-${Date.now()}`,
      student_code: cleanCode,
      full_name: full_name.trim(),
      role: 'student',
      level: level ? level.trim() : null,
      active: true,
      created_at: new Date().toISOString()
    };
    students.unshift(newStudent);
    this.saveStudents(students);
    return newStudent;
  },
  toggleStudentActive(studentId) {
    const students = this.getStudents();
    const index = students.findIndex(s => s.id === studentId || s.student_code === studentId);
    if (index === -1) throw new Error('Student not found');
    students[index].active = !students[index].active;
    this.saveStudents(students);
    return students[index];
  },
  resetStudentPassword(studentId) {
    const students = this.getStudents();
    const student = students.find(s => s.id === studentId || s.student_code === studentId);
    if (!student) throw new Error('Student not found');
    return true;
  },
  getCategories() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES) || '[]');
  },
  saveCategories(cats) {
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORIES, JSON.stringify(cats));
  },
  addCategory({ name, section }) {
    const cats = this.getCategories();
    const maxSort = cats
      .filter(c => c.section === section)
      .reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
    const newCat = {
      id: `cat-${Date.now()}`,
      name: name.trim(),
      section,
      sort_order: maxSort + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    cats.push(newCat);
    this.saveCategories(cats);
    return newCat;
  },
  renameCategory(catId, newName) {
    const cats = this.getCategories();
    const target = cats.find(c => c.id === catId);
    if (!target) throw new Error('Category not found');
    target.name = newName.trim();
    this.saveCategories(cats);
    return target;
  },
  toggleCategoryActive(catId) {
    const cats = this.getCategories();
    const target = cats.find(c => c.id === catId);
    if (!target) throw new Error('Category not found');
    target.active = !target.active;
    this.saveCategories(cats);
    return target;
  },
  reorderCategory(catId, direction) {
    const cats = this.getCategories();
    const current = cats.find(c => c.id === catId);
    if (!current) return;
    const sameSection = cats.filter(c => c.section === current.section).sort((a, b) => a.sort_order - b.sort_order);
    const index = sameSection.findIndex(c => c.id === catId);
    if (direction === 'up' && index > 0) {
      const prev = sameSection[index - 1];
      const tempOrder = current.sort_order;
      current.sort_order = prev.sort_order;
      prev.sort_order = tempOrder;
    } else if (direction === 'down' && index < sameSection.length - 1) {
      const next = sameSection[index + 1];
      const tempOrder = current.sort_order;
      current.sort_order = next.sort_order;
      next.sort_order = tempOrder;
    }
    this.saveCategories(cats);
  },
  getDemoAuth() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUTH) || 'null');
  },
  setDemoAuth(userProfile) {
    if (!userProfile) {
      localStorage.removeItem(DEMO_STORAGE_KEY_AUTH);
    } else {
      localStorage.setItem(DEMO_STORAGE_KEY_AUTH, JSON.stringify(userProfile));
    }
  },

  // --------------------------------------------------------------------------
  // Phase 3 Static Sample RPC Mock Implementations (Used ONLY in Demo Mode)
  // --------------------------------------------------------------------------

  /**
   * Mock RPC today_ist() returning current date in Asia/Kolkata
   */
  async mockTodayIST() {
    try {
      const istFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return istFormatter.format(new Date());
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  },

  /**
   * Mock RPC streak_for(p_student) returning fixed static sample data:
   * Streak of 8 days, best 15, 1 shield used/ready, today active.
   */
  async mockStreakFor(_studentId) {
    return {
      current_streak: 8,
      best_streak: 15,
      shields: 1,
      active_today: true
    };
  },

  /**
   * Mock RPC todo_for(p_student) returning fixed static sample tasks:
   * 4 of 7 completed today.
   */
  async mockTodoFor(_studentId) {
    initDemoStorage();
    const todos = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TODOS) || '[]');
    // Return sample status: first 4 done, rest pending
    return todos.filter(t => t.active).map((t, idx) => ({
      task_id: t.id,
      task_title: t.title,
      task_section: t.section,
      task_category_id: t.category_id,
      done: idx < 4 // 4 of 7 done
    }));
  },

  /**
   * Resources table CRUD in Demo Mode
   */
  getResources() {
    initDemoStorage();
    const resources = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESOURCES) || '[]');
    return resources.sort((a, b) => a.sort_order - b.sort_order);
  },
  saveResources(resList) {
    localStorage.setItem(DEMO_STORAGE_KEY_RESOURCES, JSON.stringify(resList));
  },
  addResource({ title, url, description, topic }) {
    if (!isDemoMode()) throw new Error('Blocked in production mode');
    const list = this.getResources();
    const newRes = {
      id: `res-${Date.now()}`,
      title: title.trim(),
      url: url.trim(),
      description: description ? description.trim() : '',
      topic: topic ? topic.trim() : 'General',
      sort_order: list.length + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    list.push(newRes);
    this.saveResources(list);
    return newRes;
  },
  updateResource(id, updates) {
    const list = this.getResources();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) throw new Error('Resource not found');
    list[idx] = { ...list[idx], ...updates };
    this.saveResources(list);
    return list[idx];
  },
  reorderResource(id, direction) {
    const list = this.getResources();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      const prev = list[idx - 1];
      const temp = list[idx].sort_order;
      list[idx].sort_order = prev.sort_order;
      prev.sort_order = temp;
    } else if (direction === 'down' && idx < list.length - 1) {
      const next = list[idx + 1];
      const temp = list[idx].sort_order;
      list[idx].sort_order = next.sort_order;
      next.sort_order = temp;
    }
    this.saveResources(list);
  },
  toggleResourceActive(id) {
    const list = this.getResources();
    const target = list.find(r => r.id === id);
    if (!target) throw new Error('Resource not found');
    target.active = !target.active;
    this.saveResources(list);
    return target;
  },

  /**
   * Daily To-Dos CRUD in Demo Mode
   */
  getTodos() {
    initDemoStorage();
    const todos = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TODOS) || '[]');
    return todos.sort((a, b) => a.sort_order - b.sort_order);
  },
  saveTodos(todos) {
    localStorage.setItem(DEMO_STORAGE_KEY_TODOS, JSON.stringify(todos));
  },
  addTodo({ title, section, category_id, level }) {
    if (!isDemoMode()) throw new Error('Blocked in production mode');
    const todos = this.getTodos();
    const newTodo = {
      id: `todo-${Date.now()}`,
      title: title.trim(),
      section,
      category_id: category_id || null,
      level: level ? level.trim() : null,
      sort_order: todos.length + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    todos.push(newTodo);
    this.saveTodos(todos);
    return newTodo;
  },
  updateTodo(id, updates) {
    const todos = this.getTodos();
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Task not found');
    todos[idx] = { ...todos[idx], ...updates };
    this.saveTodos(todos);
    return todos[idx];
  },
  reorderTodo(id, direction) {
    const todos = this.getTodos();
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      const prev = todos[idx - 1];
      const temp = todos[idx].sort_order;
      todos[idx].sort_order = prev.sort_order;
      prev.sort_order = temp;
    } else if (direction === 'down' && idx < todos.length - 1) {
      const next = todos[idx + 1];
      const temp = todos[idx].sort_order;
      todos[idx].sort_order = next.sort_order;
      next.sort_order = temp;
    }
    this.saveTodos(todos);
  },
  toggleTodoActive(id) {
    const todos = this.getTodos();
    const target = todos.find(t => t.id === id);
    if (!target) throw new Error('Task not found');
    target.active = !target.active;
    this.saveTodos(todos);
    return target;
  },

  /**
   * Historical results for STU101 in Demo Mode
   */
  getResults() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
  },

  /**
   * Static sample data for the Admin Overview in Demo Mode.
   * Matches the public.admin_overview() RPC return contract.
   * Zero JavaScript streak calculation; strictly static pre-computed numbers.
   */
  getAdminOverview() {
    return [
      {
        student_id: 'usr-101',
        student_code: 'STU101',
        full_name: 'Aarav Sharma',
        level: 'Level 3',
        active: true,
        current_streak: 8,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 14,
        accuracy_7d: 91.5
      },
      {
        student_id: 'usr-102',
        student_code: 'STU102',
        full_name: 'Diya Patel',
        level: 'Level 2',
        active: true,
        current_streak: 5,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 10,
        accuracy_7d: 87.0
      },
      {
        student_id: 'usr-103',
        student_code: 'STU103',
        full_name: 'Kabir Verma',
        level: 'Level 4',
        active: true,
        current_streak: 12,
        entered_today: false,
        last_entry_date: '2026-10-16',
        entries_7d: 8,
        accuracy_7d: 94.2
      },
      {
        student_id: 'usr-104',
        student_code: 'STU104',
        full_name: 'Ananya Iyer',
        level: 'Level 1',
        active: false,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-09-28',
        entries_7d: 0,
        accuracy_7d: null
      },
      {
        student_id: 'usr-105',
        student_code: 'STU105',
        full_name: 'Rohan Mehra',
        level: 'Level 2',
        active: true,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-10-12', // 5 days ago -> Needs attention
        entries_7d: 2,
        accuracy_7d: 78.4
      },
      {
        student_id: 'usr-106',
        student_code: 'STU106',
        full_name: 'Mira Joshi',
        level: 'Level 3',
        active: true,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-10-13', // 4 days ago -> Needs attention
        entries_7d: 3,
        accuracy_7d: 82.1
      },
      {
        student_id: 'usr-107',
        student_code: 'STU107',
        full_name: 'Arjun Nair',
        level: 'Master',
        active: true,
        current_streak: 22,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 18,
        accuracy_7d: 96.8
      },
      {
        student_id: 'usr-108',
        student_code: 'STU108',
        full_name: 'Riya Sen',
        level: 'Level 2',
        active: true,
        current_streak: 3,
        entered_today: false,
        last_entry_date: '2026-10-16',
        entries_7d: 6,
        accuracy_7d: 89.2
      },
      {
        student_id: 'usr-109',
        student_code: 'STU109',
        full_name: 'Vivaan Gupta',
        level: 'Level 1',
        active: true,
        current_streak: 1,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 5,
        accuracy_7d: 85.0
      },
      {
        student_id: 'usr-110',
        student_code: 'STU110',
        full_name: 'Meera Rao',
        level: 'Level 4',
        active: true,
        current_streak: 15,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 12,
        accuracy_7d: 93.4
      }
    ];
  },

  // ==================== PHASE 4a: REVIEW & AUDIT ====================
  getReviewEntries({ page = 1, pageSize = 50, studentId, search, dateFrom, dateTo, section, categoryId, status = 'unverified' }) {
    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const categories = this.getCategories();
    const students = this.getStudents();

    const catMap = new Map(categories.map(c => [c.id, c]));
    const studentMap = new Map(students.map(s => [s.id, s]));

    // Join with category and student
    let list = results.map(r => {
      const cat = catMap.get(r.category_id) || { name: 'Unknown Category', section: 'other' };
      const student = studentMap.get(r.student_id) || { full_name: 'Unknown Student', student_code: '—', level: '—' };
      const isVerified = !!r.verified_at || !!r.verified_by;
      const isCorrected = !!r.corrected_at || !!r.corrected_by;
      const isFlagged = r.flagged === true;

      return {
        ...r,
        category: cat,
        student,
        isVerified,
        isCorrected,
        isFlagged
      };
    });

    // 1. Filter by studentId if specified
    if (studentId && studentId !== 'all') {
      list = list.filter(item => item.student_id === studentId);
    }

    // 2. Filter by search query (student name or code)
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(item => {
        const name = (item.student.full_name || '').toLowerCase();
        const code = (item.student.student_code || '').toLowerCase();
        return name.includes(q) || code.includes(q);
      });
    }

    // 3. Filter by date range (IST)
    if (dateFrom) {
      list = list.filter(item => item.entry_date >= dateFrom);
    }
    if (dateTo) {
      list = list.filter(item => item.entry_date <= dateTo);
    }

    // 4. Filter by section
    if (section && section !== 'all') {
      list = list.filter(item => item.category.section === section);
    }

    // 5. Filter by category
    if (categoryId && categoryId !== 'all') {
      list = list.filter(item => item.category_id === categoryId);
    }

    // 6. Filter by status
    if (status === 'unverified') {
      list = list.filter(item => !item.isVerified && !item.isCorrected);
    } else if (status === 'verified') {
      list = list.filter(item => item.isVerified);
    } else if (status === 'flagged') {
      list = list.filter(item => item.isFlagged);
    } else if (status === 'corrected') {
      list = list.filter(item => item.isCorrected);
    }

    // 7. Sort newest first (by created_at or entry_date)
    list.sort((a, b) => new Date(b.created_at || b.entry_date).getTime() - new Date(a.created_at || a.entry_date).getTime());

    const totalCount = list.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedEntries = list.slice(startIndex, startIndex + pageSize);

    return {
      entries: paginatedEntries,
      totalCount,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize))
    };
  },

  getAuditHistory(resultId) {
    initDemoStorage();
    const audits = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUDIT) || '[]');
    const students = this.getStudents();
    const studentMap = new Map(students.map(s => [s.id, s]));

    const filtered = audits.filter(a => a.result_id === resultId);
    filtered.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());

    return filtered.map(a => {
      const admin = studentMap.get(a.changed_by) || { full_name: 'Teacher Admin' };
      return {
        ...a,
        changed_by_name: admin.full_name || 'Teacher Admin'
      };
    });
  },

  adminSetVerified(resultIds, verified, reason, adminId = 'usr-admin-1') {
    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const audits = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUDIT) || '[]');
    const nowIso = new Date().toISOString();

    const idSet = new Set(resultIds);
    results.forEach(r => {
      if (idSet.has(r.id)) {
        const oldVerified = r.verified_by || null;
        r.verified_by = verified ? adminId : null;
        r.verified_at = verified ? nowIso : null;

        audits.push({
          id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          result_id: r.id,
          student_id: r.student_id,
          changed_by: adminId,
          changed_at: nowIso,
          action: verified ? 'verify' : 'unverify',
          old_values: { verified_by: oldVerified, verified: !!oldVerified },
          new_values: { verified_by: r.verified_by, verified },
          reason: reason || (verified ? 'Verified by teacher' : 'Unverified by teacher')
        });
      }
    });

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));
    localStorage.setItem(DEMO_STORAGE_KEY_AUDIT, JSON.stringify(audits));
    return true;
  },

  adminSetFlag(resultId, flagged, note, adminId = 'usr-admin-1') {
    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const audits = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUDIT) || '[]');
    const nowIso = new Date().toISOString();

    const target = results.find(r => r.id === resultId);
    if (!target) throw new Error('Result entry not found');

    const oldFlagged = target.flagged || false;
    const oldNote = target.flag_note || null;

    target.flagged = !!flagged;
    target.flag_note = flagged ? (note || '').trim() : null;

    audits.push({
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      result_id: target.id,
      student_id: target.student_id,
      changed_by: adminId,
      changed_at: nowIso,
      action: flagged ? 'flag' : 'unflag',
      old_values: { flagged: oldFlagged, flag_note: oldNote },
      new_values: { flagged: target.flagged, flag_note: target.flag_note },
      reason: note || (flagged ? 'Flagged for student review' : 'Unflagged')
    });

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));
    localStorage.setItem(DEMO_STORAGE_KEY_AUDIT, JSON.stringify(audits));
    return true;
  },

  adminCorrectResult(resultId, correct, total, timeSeconds, note, reason, adminId = 'usr-admin-1') {
    initDemoStorage();
    if (!reason || reason.trim().length < 3) {
      throw new Error('A reason of at least 3 characters is required.');
    }
    if (Number(correct) > Number(total)) {
      throw new Error('Correct answers cannot exceed total attempted.');
    }

    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const audits = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUDIT) || '[]');
    const nowIso = new Date().toISOString();

    const target = results.find(r => r.id === resultId);
    if (!target) throw new Error('Result entry not found');

    const oldValues = {
      correct: target.correct,
      total: target.total,
      time_seconds: target.time_seconds,
      note: target.note,
      corrected_by: target.corrected_by,
      corrected_at: target.corrected_at
    };

    target.correct = Number(correct);
    target.total = Number(total);
    target.time_seconds = Number(timeSeconds);
    if (note !== undefined) target.note = note ? note.trim() : null;
    target.corrected_by = adminId;
    target.corrected_at = nowIso;

    audits.push({
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      result_id: target.id,
      student_id: target.student_id,
      changed_by: adminId,
      changed_at: nowIso,
      action: 'correct',
      old_values: oldValues,
      new_values: {
        correct: target.correct,
        total: target.total,
        time_seconds: target.time_seconds,
        note: target.note,
        corrected_by: adminId,
        corrected_at: nowIso
      },
      reason: reason.trim()
    });

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));
    localStorage.setItem(DEMO_STORAGE_KEY_AUDIT, JSON.stringify(audits));
    return true;
  },

  // ==================== PHASE 4a: ATTENDANCE ====================
  getAttendanceSessions() {
    initDemoStorage();
    const sessions = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_SESSIONS) || '[]');
    const attendance = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ATTENDANCE) || '[]');
    const activeStudents = this.getStudents().filter(s => s.active !== false);
    const activeCount = activeStudents.length;

    // Attach computed counts
    return sessions.map(ses => {
      const records = attendance.filter(a => a.session_id === ses.id);
      let present = 0;
      let absent = 0;
      let excused = 0;
      const markedStudentIds = new Set();

      records.forEach(r => {
        markedStudentIds.add(r.student_id);
        if (r.status === 'present') present++;
        else if (r.status === 'absent') absent++;
        else if (r.status === 'excused') excused++;
      });

      const unmarked = Math.max(0, activeCount - markedStudentIds.size);

      return {
        ...ses,
        present_count: present,
        absent_count: absent,
        excused_count: excused,
        unmarked_count: unmarked
      };
    }).sort((a, b) => new Date(b.session_date).getTime() - new Date(a.session_date).getTime());
  },

  createAttendanceSession(data, adminId = 'usr-admin-1') {
    initDemoStorage();
    const sessions = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_SESSIONS) || '[]');
    const newSession = {
      id: `ses-${Date.now()}`,
      session_date: data.session_date,
      title: data.title.trim(),
      session_type: data.session_type || 'class',
      notes: data.notes ? data.notes.trim() : null,
      created_by: adminId,
      created_at: new Date().toISOString()
    };
    sessions.unshift(newSession);
    localStorage.setItem(DEMO_STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    return newSession;
  },

  updateAttendanceSession(id, data) {
    initDemoStorage();
    const sessions = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_SESSIONS) || '[]');
    const idx = sessions.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('Session not found');

    sessions[idx] = {
      ...sessions[idx],
      title: data.title ? data.title.trim() : sessions[idx].title,
      session_date: data.session_date || sessions[idx].session_date,
      session_type: data.session_type || sessions[idx].session_type,
      notes: data.notes !== undefined ? (data.notes ? data.notes.trim() : null) : sessions[idx].notes
    };

    localStorage.setItem(DEMO_STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    return sessions[idx];
  },

  getSessionAttendance(sessionId) {
    initDemoStorage();
    const attendance = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ATTENDANCE) || '[]');
    const activeStudents = this.getStudents().filter(s => s.active !== false);

    const attMap = new Map();
    attendance.filter(a => a.session_id === sessionId).forEach(a => {
      attMap.set(a.student_id, a);
    });

    return activeStudents.map(student => {
      const rec = attMap.get(student.id);
      return {
        student,
        status: rec ? rec.status : null, // 'present' | 'absent' | 'excused' | null
        note: rec ? (rec.note || '') : ''
      };
    });
  },

  saveAttendanceRecords(sessionId, records, adminId = 'usr-admin-1') {
    initDemoStorage();
    let attendance = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ATTENDANCE) || '[]');
    const nowIso = new Date().toISOString();

    records.forEach(rec => {
      if (!rec.status) return; // Skip unmarked if any

      const existingIdx = attendance.findIndex(a => a.session_id === sessionId && a.student_id === rec.student_id);
      if (existingIdx !== -1) {
        attendance[existingIdx].status = rec.status;
        attendance[existingIdx].note = rec.note ? rec.note.trim() : null;
        attendance[existingIdx].marked_by = adminId;
        attendance[existingIdx].marked_at = nowIso;
      } else {
        attendance.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          session_id: sessionId,
          student_id: rec.student_id,
          status: rec.status,
          note: rec.note ? rec.note.trim() : null,
          marked_by: adminId,
          marked_at: nowIso
        });
      }
    });

    localStorage.setItem(DEMO_STORAGE_KEY_ATTENDANCE, JSON.stringify(attendance));
    return true;
  },

  mockAttendanceSummary(studentId) {
    // Fixed static attendance numbers (never calculated formulaically in client JS)
    if (studentId === 'usr-104') {
      return { present_count: 0, absent_count: 0, excused_count: 0, attendance_pct: null };
    }
    if (studentId === 'usr-107') {
      return { present_count: 18, absent_count: 0, excused_count: 1, attendance_pct: 100.0 };
    }
    if (studentId === 'usr-105') {
      return { present_count: 9, absent_count: 5, excused_count: 2, attendance_pct: 64.3 };
    }
    return {
      present_count: 14,
      absent_count: 2,
      excused_count: 1,
      attendance_pct: 87.5
    };
  },

  // ==================== PHASE 4b: TARGETS & WEEKLY TESTS ====================

  getBasicsThresholds() {
    initDemoStorage();
    const targets = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TARGETS) || '[]');
    const cats = this.getCategories();
    return targets.map(t => {
      const cat = cats.find(c => c.id === t.category_id);
      return {
        ...t,
        category: cat ? { id: cat.id, name: cat.name, section: cat.section, sort_order: cat.sort_order } : null
      };
    }).sort((a, b) => {
      const ordA = a.category?.sort_order ?? 999;
      const ordB = b.category?.sort_order ?? 999;
      if (ordA !== ordB) return ordA - ordB;
      // Default rule first
      if (!a.level && b.level) return -1;
      if (a.level && !b.level) return 1;
      return String(a.level || '').localeCompare(String(b.level || ''));
    });
  },

  createBasicsThreshold(data) {
    initDemoStorage();
    const targets = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TARGETS) || '[]');
    const normLevel = data.level && data.level.trim() ? data.level.trim() : null;

    // Check duplicate rule for same category and level
    const duplicate = targets.find(t => {
      if (t.category_id !== data.category_id) return false;
      const tNorm = t.level && t.level.trim() ? t.level.trim().toLowerCase() : null;
      const dNorm = normLevel ? normLevel.toLowerCase() : null;
      return tNorm === dNorm;
    });

    if (duplicate) {
      throw new Error(`A target rule for this category and level already exists. Please edit the existing rule instead.`);
    }

    const newTarget = {
      id: `tgt-${Date.now()}`,
      category_id: data.category_id,
      level: normLevel,
      min_accuracy: Math.max(0, Math.min(100, Math.round(Number(data.min_accuracy) || 0))),
      max_time_seconds: data.max_time_seconds ? Number(data.max_time_seconds) : null,
      active: data.active !== false,
      created_at: new Date().toISOString()
    };

    targets.push(newTarget);
    localStorage.setItem(DEMO_STORAGE_KEY_TARGETS, JSON.stringify(targets));
    return newTarget;
  },

  updateBasicsThreshold(id, updates) {
    initDemoStorage();
    const targets = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TARGETS) || '[]');
    const idx = targets.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Target rule not found.');

    const current = targets[idx];
    const catId = updates.category_id !== undefined ? updates.category_id : current.category_id;
    const normLevel = updates.level !== undefined ? (updates.level && updates.level.trim() ? updates.level.trim() : null) : current.level;

    // Check duplicate rule on other entries
    const duplicate = targets.find(t => {
      if (t.id === id) return false;
      if (t.category_id !== catId) return false;
      const tNorm = t.level && t.level.trim() ? t.level.trim().toLowerCase() : null;
      const dNorm = normLevel ? normLevel.toLowerCase() : null;
      return tNorm === dNorm;
    });

    if (duplicate) {
      throw new Error(`A target rule for this category and level already exists. Please edit the existing rule instead.`);
    }

    targets[idx] = {
      ...current,
      category_id: catId,
      level: normLevel,
      min_accuracy: updates.min_accuracy !== undefined ? Math.max(0, Math.min(100, Math.round(Number(updates.min_accuracy) || 0))) : current.min_accuracy,
      max_time_seconds: updates.max_time_seconds !== undefined ? (updates.max_time_seconds ? Number(updates.max_time_seconds) : null) : current.max_time_seconds,
      active: updates.active !== undefined ? Boolean(updates.active) : current.active
    };

    localStorage.setItem(DEMO_STORAGE_KEY_TARGETS, JSON.stringify(targets));
    return targets[idx];
  },

  toggleBasicsThresholdActive(id) {
    initDemoStorage();
    const targets = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TARGETS) || '[]');
    const target = targets.find(t => t.id === id);
    if (!target) throw new Error('Target rule not found.');
    target.active = !target.active;
    localStorage.setItem(DEMO_STORAGE_KEY_TARGETS, JSON.stringify(targets));
    return target.active;
  },

  getWeeklyTests() {
    initDemoStorage();
    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    return tests.map(t => {
      const enteredCount = scores.filter(s => s.test_id === t.id).length;
      return {
        ...t,
        scores_count: enteredCount
      };
    }).sort((a, b) => String(b.test_date).localeCompare(String(a.test_date)));
  },

  createWeeklyTest(data) {
    initDemoStorage();
    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const newTest = {
      id: `wkt-${Date.now()}`,
      test_date: data.test_date,
      title: data.title.trim(),
      notes: data.notes ? data.notes.trim() : null,
      created_at: new Date().toISOString()
    };
    tests.unshift(newTest);
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(tests));
    return newTest;
  },

  updateWeeklyTest(id, data) {
    initDemoStorage();
    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const idx = tests.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Weekly test not found.');
    tests[idx] = {
      ...tests[idx],
      test_date: data.test_date !== undefined ? data.test_date : tests[idx].test_date,
      title: data.title !== undefined ? data.title.trim() : tests[idx].title,
      notes: data.notes !== undefined ? (data.notes ? data.notes.trim() : null) : tests[idx].notes
    };
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(tests));
    return tests[idx];
  },

  getWeeklyTestScores(testId, categoryId) {
    initDemoStorage();
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    return scores.filter(s => s.test_id === testId && s.category_id === categoryId);
  },

  saveWeeklyTestScores(testId, categoryId, scoresList) {
    initDemoStorage();
    let scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    scoresList.forEach(item => {
      const idx = scores.findIndex(s => s.test_id === testId && s.category_id === categoryId && s.student_id === item.student_id);

      if (item.correct === null || item.correct === '' || item.total === null || item.total === '') {
        // Clear if previously entered and now blank
        if (idx !== -1) {
          scores.splice(idx, 1);
        }
      } else {
        const correctNum = Number(item.correct);
        const totalNum = Number(item.total);
        const timeSec = item.time_seconds !== null && item.time_seconds !== '' ? Number(item.time_seconds) : null;

        if (idx !== -1) {
          scores[idx] = {
            ...scores[idx],
            correct: correctNum,
            total: totalNum,
            time_seconds: timeSec
          };
        } else {
          scores.push({
            id: `sc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            test_id: testId,
            student_id: item.student_id,
            category_id: categoryId,
            correct: correctNum,
            total: totalNum,
            time_seconds: timeSec,
            created_at: new Date().toISOString()
          });
        }
      }
    });

    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(scores));
    return true;
  },

  getStudentWeeklyTestScores(studentId, testIds) {
    initDemoStorage();
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    const cats = this.getCategories();
    return scores
      .filter(s => s.student_id === studentId && testIds.includes(s.test_id))
      .map(s => {
        const cat = cats.find(c => c.id === s.category_id);
        return {
          ...s,
          categories: cat ? { name: cat.name, section: cat.section } : null
        };
      });
  },

  getResultsWithTarget(studentId, section = 'basics') {
    initDemoStorage();
    const allResults = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const cats = this.getCategories();
    const targets = this.getBasicsThresholds().filter(t => t.active);
    const students = this.getStudents();
    const student = students.find(s => s.id === studentId);
    const studentLevel = (student?.level || '').trim().toLowerCase();

    return allResults
      .filter(r => r.student_id === studentId)
      .map(r => {
        const cat = cats.find(c => c.id === r.category_id);
        // Find effective rule for this category and student level
        const levelRule = targets.find(t => t.category_id === r.category_id && t.level && t.level.trim().toLowerCase() === studentLevel);
        const defaultRule = targets.find(t => t.category_id === r.category_id && !t.level);
        const effective = levelRule || defaultRule;

        let meets = null;
        let minAcc = null;
        let maxTime = null;

        if (effective) {
          minAcc = effective.min_accuracy;
          maxTime = effective.max_time_seconds;

          if (maxTime !== null && (r.time_seconds === null || r.time_seconds > maxTime)) {
            meets = false;
          } else if (r.total && r.total > 0) {
            const acc = (r.correct / r.total) * 100;
            meets = acc >= minAcc;
          } else {
            meets = false;
          }
        }

        return {
          ...r,
          categories: cat ? { id: cat.id, name: cat.name, section: cat.section } : null,
          min_accuracy: minAcc,
          max_time_seconds: maxTime,
          meets_target: meets
        };
      })
      .filter(r => !section || (r.categories && r.categories.section === section));
  }
};
