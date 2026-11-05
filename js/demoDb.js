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
const DEMO_STORAGE_KEY_CATEGORIES = 'trendz_demo_categories_v3';
const DEMO_STORAGE_KEY_ROUND_SERIES = 'trendz_demo_round_series_v1';
const DEMO_STORAGE_KEY_CATEGORY_SERIES = 'trendz_demo_category_series_v1';
const DEMO_STORAGE_KEY_STUDENT_ROUNDS = 'trendz_demo_student_rounds_v1';
const DEMO_STORAGE_KEY_AUTH = 'trendz_demo_auth_v2';
const DEMO_STORAGE_KEY_TODOS = 'trendz_demo_todos_v2';
const DEMO_STORAGE_KEY_RESOURCES = 'trendz_demo_resources_v2';
const DEMO_STORAGE_KEY_RESULTS = 'trendz_demo_results_v3';
const DEMO_STORAGE_KEY_AUDIT = 'trendz_demo_audit_v2';
const DEMO_STORAGE_KEY_SESSIONS = 'trendz_demo_sessions_v2';
const DEMO_STORAGE_KEY_ATTENDANCE = 'trendz_demo_attendance_v2';
const DEMO_STORAGE_KEY_TARGETS = 'trendz_demo_targets_v2';
const DEMO_STORAGE_KEY_WEEKLY_TESTS = 'trendz_demo_weekly_tests_v3';
const DEMO_STORAGE_KEY_WEEKLY_SCORES = 'trendz_demo_weekly_scores_v3';
const DEMO_STORAGE_KEY_WEEKLY_SECTIONS = 'trendz_demo_weekly_sections_v1';
const DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS = 'trendz_demo_weekly_attempts_v1';
const DEMO_STORAGE_KEY_WEEKLY_REMOVALS = 'trendz_demo_weekly_removals_v1';
const DEMO_STORAGE_KEY_WEEKLY_SESSIONS = 'trendz_demo_weekly_sessions_v1';
const DEMO_STORAGE_KEY_CATEGORY_ALIASES = 'trendz_demo_category_aliases_v1';
const DEMO_STORAGE_KEY_IMPORT_BATCHES = 'trendz_demo_import_batches_v1';
const DEMO_STORAGE_KEY_COMPETITION_SETTINGS = 'trendz_demo_competition_settings_v1';
const DEMO_STORAGE_KEY_REPORT_LOG = 'trendz_demo_report_log_v1';
const DEMO_STORAGE_KEY_ANNOUNCEMENTS = 'trendz_demo_announcements_v1';
const DEMO_STORAGE_KEY_STUDENT_MESSAGES = 'trendz_demo_student_messages_v1';
const DEMO_STORAGE_KEY_DISMISSED_NOTIFICATIONS = 'trendz_demo_dismissed_notifications_v1';

export const DEFAULT_ROUND_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'HCF and LCM', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Approximation', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const OLD_SIMULATOR_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'Currency', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Missing Figures', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const DEFAULT_BASICS_CATEGORIES = [
  '1d4r',
  '2d2r',
  '2d4r',
  '1dx1d',
  '2dx1d',
  '2dby1d',
  '3d/1d',
];

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
      { id: 'usr-101', student_code: 'STU101', full_name: 'Aarav Sharma', role: 'student', level: 'Level 3', active: true, leaderboard_visible: true, created_at: '2026-10-01T10:00:00.000Z' },
      { id: 'usr-102', student_code: 'STU102', full_name: 'Diya Patel', role: 'student', level: 'Level 2', active: true, leaderboard_visible: true, created_at: '2026-10-02T10:00:00.000Z' },
      { id: 'usr-103', student_code: 'STU103', full_name: 'Kabir Verma', role: 'student', level: 'Level 4', active: true, leaderboard_visible: true, created_at: '2026-10-03T10:00:00.000Z' },
      { id: 'usr-104', student_code: 'STU104', full_name: 'Ananya Iyer', role: 'student', level: 'Level 1', active: false, leaderboard_visible: false, created_at: '2026-10-04T10:00:00.000Z' },
      { id: 'usr-105', student_code: 'STU105', full_name: 'Rohan Mehra', role: 'student', level: 'Level 2', active: true, leaderboard_visible: true, created_at: '2026-10-05T10:00:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(initialStudents));
  } else {
    // Ensure existing stored demo students have boolean leaderboard_visible
    try {
      const existing = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS) || '[]');
      let mutated = false;
      existing.forEach(s => {
        if (typeof s.leaderboard_visible !== 'boolean') {
          s.leaderboard_visible = s.active !== false;
          mutated = true;
        }
      });
      if (mutated) {
        localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(existing));
      }
    } catch {
      // Ignore parse errors
    }
  }

  // 2. Initial Categories (24 New Simulator + 2 Old Simulator extras + 2 Basics)
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
    // Legacy Old simulator round categories
    initialCats.push({
      id: 'cat-rnd-25',
      name: 'Currency',
      section: 'round',
      sort_order: 25,
      active: true,
      created_at: '2026-10-01T00:00:00.000Z'
    });
    initialCats.push({
      id: 'cat-rnd-26',
      name: 'Missing Figures',
      section: 'round',
      sort_order: 26,
      active: true,
      created_at: '2026-10-01T00:00:00.000Z'
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

  // 2b. Initial Round Series (Old simulator & New simulator)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_ROUND_SERIES)) {
    const initialSeries = [
      { id: 'ser-old', name: 'Old simulator', sort_order: 1, is_current: false },
      { id: 'ser-new', name: 'New simulator', sort_order: 2, is_current: true }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_ROUND_SERIES, JSON.stringify(initialSeries));
  }

  // 2c. Initial Category Series Mappings
  if (!localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_SERIES)) {
    const cats = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES) || '[]');
    const nameToId = new Map(cats.map(c => [c.name, c.id]));
    const catSeries = [];

    DEFAULT_ROUND_CATEGORIES.forEach((name, idx) => {
      const catId = nameToId.get(name);
      if (catId) {
        catSeries.push({
          category_id: catId,
          series_id: 'ser-new',
          sort_order: idx + 1
        });
      }
    });

    OLD_SIMULATOR_CATEGORIES.forEach((name, idx) => {
      const catId = nameToId.get(name);
      if (catId) {
        catSeries.push({
          category_id: catId,
          series_id: 'ser-old',
          sort_order: idx + 1
        });
      }
    });

    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORY_SERIES, JSON.stringify(catSeries));
  }

  // 2d-alias. Initial Category Aliases (category_aliases)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_ALIASES)) {
    const initialAliases = [
      { alias: 'fracdiv', category_id: 'cat-rnd-12' },
      { alias: 'decimalpower', category_id: 'cat-rnd-17' },
      { alias: 'sumofsquare', category_id: 'cat-rnd-23' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORY_ALIASES, JSON.stringify(initialAliases));
  }

  // 2d. Initial Student Rounds (student_rounds)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS)) {
    const now = new Date();
    const studentRounds = [];

    // 5 rounds in New simulator for STU101 (Round 1 to Round 5)
    const newRoundNums = [1, 2, 3, 4, 5];
    newRoundNums.forEach((roundNum, rIdx) => {
      const daysAgo = (4 - rIdx) * 2;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      studentRounds.push({
        id: `sr-101-new-${roundNum}`,
        student_id: 'usr-101',
        series_id: 'ser-new',
        round_number: roundNum,
        round_date: roundDate,
        round_type: roundNum % 2 === 0 ? 'All at a time' : 'Category wise',
        time_taken_seconds: 1180 + roundNum * 15,
        created_at: new Date(now.getTime() - daysAgo * 86400000).toISOString()
      });
    });

    // 2 legacy rounds in Old simulator for STU101 (Round 1, Round 2)
    [1, 2].forEach((roundNum, rIdx) => {
      const daysAgo = 20 - rIdx * 3;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      studentRounds.push({
        id: `sr-101-old-${roundNum}`,
        student_id: 'usr-101',
        series_id: 'ser-old',
        round_number: roundNum,
        round_date: roundDate,
        round_type: 'Category wise',
        time_taken_seconds: 1320 - roundNum * 20,
        created_at: new Date(now.getTime() - daysAgo * 86400000).toISOString()
      });
    });

    // Sample rounds for other students
    ['usr-102', 'usr-103', 'usr-105', 'usr-107'].forEach((stuId) => {
      [1, 2].forEach((rNum) => {
        const daysAgo = (2 - rNum) * 2;
        studentRounds.push({
          id: `sr-${stuId}-new-${rNum}`,
          student_id: stuId,
          series_id: 'ser-new',
          round_number: rNum,
          round_date: new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0],
          round_type: 'Category wise',
          time_taken_seconds: 1200,
          created_at: new Date(now.getTime() - daysAgo * 86400000).toISOString()
        });
      });
    });

    localStorage.setItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS, JSON.stringify(studentRounds));
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
      { id: 'todo-1', title: 'Round Drill: Addition (ADD)', section: 'round', category_id: 'cat-rnd-1', activity_key: null, level: null, sort_order: 1, active: true },
      { id: 'todo-2', title: 'Round Drill: Subtraction (SUB)', section: 'round', category_id: 'cat-rnd-2', activity_key: null, level: null, sort_order: 2, active: true },
      { id: 'todo-3', title: 'Round Drill: Multiplication (MULT)', section: 'round', category_id: 'cat-rnd-4', activity_key: null, level: null, sort_order: 3, active: true },
      { id: 'todo-4', title: 'Round Drill: Division (DIV)', section: 'round', category_id: 'cat-rnd-5', activity_key: null, level: null, sort_order: 4, active: true },
      { id: 'todo-5', title: 'Mental Basics: 1-digit 4-rows (1d4r)', section: 'basics', category_id: 'cat-bas-1', activity_key: null, level: null, sort_order: 5, active: true },
      { id: 'todo-6', title: 'Mental Basics: 2-digit 2-rows (2d2r)', section: 'basics', category_id: 'cat-bas-2', activity_key: null, level: null, sort_order: 6, active: true },
      { id: 'todo-7', title: 'Any Round Competition Task', section: 'round', category_id: null, activity_key: null, level: null, sort_order: 7, active: true },
      { id: 'todo-8', title: 'Flash: 1 digit, 50 numbers, 0.5 s, add only', section: 'flash', category_id: null, activity_key: null, flash_digits: 1, flash_count: 50, flash_speed_ms: 500, flash_mode: 'add', required_count: 2, level: null, sort_order: 8, active: true }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_TODOS, JSON.stringify(initialTodos));
  }

  // 5. Initial Results (90-day sample data for STU101 across New/Old simulator rounds and daily basics)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_RESULTS)) {
    const sampleResults = [];
    const now = new Date();
    
    // Sample New simulator rounds: 1..5
    const rounds = [1, 2, 3, 4, 5];
    rounds.forEach((roundNum, rIdx) => {
      const daysAgo = (4 - rIdx) * 2;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      const studentRoundId = `sr-101-new-${roundNum}`;
      
      DEFAULT_ROUND_CATEGORIES.forEach((catName, cIdx) => {
        if (roundNum === 1 && cIdx > 18) return;
        if (roundNum === 2 && cIdx > 20) return;

        const total = 20;
        let correct = total;
        if (cIdx % 7 === 1) correct = 19;
        else if (cIdx % 7 === 3) correct = 18;
        else if (cIdx % 7 === 5) correct = 17;

        const isRound3AddIdenticalFixture = roundNum === 3 && cIdx === 0;
        const finalCorrect = isRound3AddIdenticalFixture ? 95 : correct;
        const finalTotal = isRound3AddIdenticalFixture ? 95 : total;
        const finalTime = isRound3AddIdenticalFixture ? 65 : 45 + (cIdx % 5) * 8;

        sampleResults.push({
          id: `res-rnd-${roundNum}-${cIdx + 1}`,
          student_id: 'usr-101',
          student_round_id: studentRoundId,
          category_id: `cat-rnd-${cIdx + 1}`,
          correct: finalCorrect,
          total: finalTotal,
          time_seconds: finalTime,
          note: null,
          entry_date: roundDate,
          created_at: new Date(now.getTime() - daysAgo * 86400000 + cIdx * 60000).toISOString(),
          verified_by: roundNum <= 2 ? 'usr-admin-1' : null,
          verified_at: roundNum <= 2 ? new Date(now.getTime() - (daysAgo - 1) * 86400000).toISOString() : null,
          corrected_by: roundNum === 3 && (cIdx === 2 || cIdx === 12) ? 'usr-admin-1' : null,
          corrected_at: roundNum === 3 && (cIdx === 2 || cIdx === 12) ? new Date(now.getTime() - 2 * 86400000).toISOString() : null,
          flagged: roundNum === 4 && cIdx === 4,
          flag_note: roundNum === 4 && cIdx === 4 ? 'Please re-verify your multiplication count against your practice worksheet.' : null
        });
      });
    });

    // Sample Old simulator results for STU101
    [1, 2].forEach((roundNum, rIdx) => {
      const daysAgo = 20 - rIdx * 3;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      const studentRoundId = `sr-101-old-${roundNum}`;
      const oldCatIds = ['cat-rnd-1', 'cat-rnd-2', 'cat-rnd-25', 'cat-rnd-26'];
      oldCatIds.forEach((catId, cIdx) => {
        sampleResults.push({
          id: `res-old-${roundNum}-${cIdx + 1}`,
          student_id: 'usr-101',
          student_round_id: studentRoundId,
          category_id: catId,
          correct: 19,
          total: 20,
          time_seconds: 50 + cIdx * 5,
          note: null,
          entry_date: roundDate,
          created_at: new Date(now.getTime() - daysAgo * 86400000 + cIdx * 60000).toISOString(),
          verified_by: 'usr-admin-1',
          verified_at: new Date(now.getTime() - (daysAgo - 1) * 86400000).toISOString(),
          corrected_by: null,
          corrected_at: null,
          flagged: false,
          flag_note: null
        });
      });
    });

    // Add diverse sample results for STU102, STU103, STU105, STU107
    const otherStudents = ['usr-102', 'usr-103', 'usr-105', 'usr-107'];
    otherStudents.forEach((stuId, sIdx) => {
      const stuRounds = [1, 2];
      stuRounds.forEach(rNum => {
        sampleResults.push({
          id: `res-rnd-${stuId}-${rNum}-1`,
          student_id: stuId,
          student_round_id: `sr-${stuId}-new-${rNum}`,
          category_id: 'cat-rnd-1',
          correct: 20,
          total: 20,
          time_seconds: 42 + sIdx * 3,
          note: null,
          entry_date: new Date(now.getTime() - (2 - rNum) * 86400000).toISOString().split('T')[0],
          created_at: new Date(now.getTime() - (2 - rNum) * 86400000 + sIdx * 3600000).toISOString(),
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
      const isSiteEntry = day === 0 || day === 3;
      // 1d4r entry
      sampleResults.push({
        id: `res-bas-1d-${day}`,
        student_id: 'usr-101',
        student_round_id: null,
        category_id: 'cat-bas-1',
        correct: 19 + (day % 2),
        total: 20,
        time_seconds: 32 + (day % 4),
        note: isSiteEntry ? null : 'Daily speed sprint',
        entry_date: dateStr,
        created_at: new Date(now.getTime() - day * 86400000 + 3600000).toISOString(),
        updated_at: new Date(now.getTime() - day * 86400000 + 3600000).toISOString(),
        source: isSiteEntry ? 'site' : 'typed',
        verified: isSiteEntry || day >= 7,
        verified_by: isSiteEntry ? null : (day >= 7 ? 'usr-admin-1' : null),
        verified_at: isSiteEntry ? null : (day >= 7 ? new Date(now.getTime() - (day - 1) * 86400000).toISOString() : null),
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
          student_round_id: null,
          category_id: 'cat-bas-2',
          correct: 18 + (day % 3 === 0 ? 2 : 1),
          total: 20,
          time_seconds: 40 + (day % 5),
          note: '2-digit concentration',
          entry_date: dateStr,
          created_at: new Date(now.getTime() - day * 86400000 + 7200000).toISOString(),
          updated_at: new Date(now.getTime() - day * 86400000 + 7200000).toISOString(),
          source: 'typed',
          verified: false,
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

  // 10. Initial Weekly Tests (Phase 4b + Phase 13a Online & Offline)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS)) {
    const todayIst = new Date(Date.now() + 330 * 60 * 1000).toISOString().split('T')[0];
    const initialWeeklyTests = [
      {
        id: 'wkt-online-1',
        test_date: todayIst,
        title: 'Online Speed Assessment #43',
        notes: 'Complete all 3 timed Basics sections today. Each section can be taken once.',
        test_type: 'online',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: new Date().toISOString()
      },
      {
        id: 'wkt-1',
        test_date: '2026-10-18',
        title: 'Weekly Speed & Accuracy Sprint #42',
        notes: 'Covers 1d4r basics and 2d2r mental calculation speed check.',
        test_type: 'offline',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: '2026-10-18T04:00:00.000Z'
      },
      {
        id: 'wkt-2',
        test_date: '2026-10-11',
        title: 'Sunday Competition Mock Test #41',
        notes: 'Preparation for National Abacus Qualifier.',
        test_type: 'offline',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: '2026-10-11T04:00:00.000Z'
      },
      {
        id: 'wkt-3',
        test_date: '2026-10-04',
        title: 'Flash & Mental Assessment #40',
        notes: 'Focus on times under 2:00.',
        test_type: 'offline',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: '2026-10-04T04:00:00.000Z'
      },
      {
        id: 'wkt-4',
        test_date: '2026-09-27',
        title: 'Monthly Evaluation Mock #39',
        notes: 'Diagnostic drill check across all sections.',
        test_type: 'offline',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: '2026-09-27T04:00:00.000Z'
      },
      {
        id: 'wkt-5',
        test_date: '2026-09-20',
        title: 'Speed Assessment Sprint #38',
        notes: 'Basics baseline benchmarks.',
        test_type: 'offline',
        audience_level: null,
        opens_at: null,
        closes_at: null,
        remind_days_before: 7,
        created_at: '2026-09-20T04:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(initialWeeklyTests));
  }

  // 10b. Initial Weekly Test Sections (Phase 13a + Phase 16a Multi-Kind Sections)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS)) {
    const initialSections = [
      // Online test wkt-online-1: Basics + Flash Anzan + Elements + Memoriad
      {
        id: 'wsec-1',
        test_id: 'wkt-online-1',
        position: 1,
        kind: 'basics',
        category_id: 'cat-bas-1',
        activity_key: null,
        seconds: 30,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-2',
        test_id: 'wkt-online-1',
        position: 2,
        kind: 'basics',
        category_id: 'cat-bas-2',
        activity_key: null,
        seconds: 60,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-3',
        test_id: 'wkt-online-1',
        position: 3,
        kind: 'flash',
        category_id: null,
        activity_key: null,
        seconds: null,
        flash_digits: 1,
        flash_count: 50,
        flash_speed_ms: 500,
        flash_mode: 'add',
        question_count: 5
      },
      {
        id: 'wsec-4',
        test_id: 'wkt-online-1',
        position: 4,
        kind: 'elements',
        category_id: null,
        activity_key: 'day_codes',
        seconds: null,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-5',
        test_id: 'wkt-online-1',
        position: 5,
        kind: 'memoriad',
        category_id: null,
        activity_key: 'additions',
        seconds: null,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      // Offline test wkt-1: Sections of every kind (Basics, Round, Flash, Elements, Memoriad)
      {
        id: 'wsec-off-1',
        test_id: 'wkt-1',
        position: 1,
        kind: 'basics',
        category_id: 'cat-bas-1',
        activity_key: null,
        seconds: 120,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-off-2',
        test_id: 'wkt-1',
        position: 2,
        kind: 'round',
        category_id: 'cat-rnd-1',
        activity_key: null,
        seconds: null,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-off-3',
        test_id: 'wkt-1',
        position: 3,
        kind: 'flash',
        category_id: null,
        activity_key: null,
        seconds: null,
        flash_digits: 2,
        flash_count: 25,
        flash_speed_ms: 800,
        flash_mode: 'add_sub',
        question_count: 5
      },
      {
        id: 'wsec-off-4',
        test_id: 'wkt-1',
        position: 4,
        kind: 'elements',
        category_id: null,
        activity_key: 'day_codes',
        seconds: null,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      },
      {
        id: 'wsec-off-5',
        test_id: 'wkt-1',
        position: 5,
        kind: 'memoriad',
        category_id: null,
        activity_key: 'calendar',
        seconds: null,
        flash_digits: null,
        flash_count: null,
        flash_speed_ms: null,
        flash_mode: null,
        question_count: null
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS, JSON.stringify(initialSections));
  }

  // 10c. Initial Weekly Test Attempts (Phase 13a + Phase 16a)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS)) {
    const initialAttempts = [
      {
        id: 'watt-1',
        test_id: 'wkt-online-1',
        student_id: 'usr-101',
        section_id: 'wsec-1',
        category_id: 'cat-bas-1',
        session_id: 'demo-wt-sess-1',
        status: 'submitted',
        tries_started: 1,
        tries_correct: 1,
        seconds_used: 30,
        started_at: '2026-10-30T05:00:00.000Z',
        finished_at: '2026-10-30T05:00:30.000Z'
      },
      {
        id: 'watt-2',
        test_id: 'wkt-online-1',
        student_id: 'usr-102',
        section_id: 'wsec-1',
        category_id: 'cat-bas-1',
        session_id: 'demo-wt-sess-2',
        status: 'started',
        tries_started: 1,
        tries_correct: 0,
        seconds_used: null,
        started_at: '2026-10-30T05:10:00.000Z',
        finished_at: null
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(initialAttempts));
  }

  // 10d. Initial Weekly Test Removals (Phase 13a)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS)) {
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS, JSON.stringify([]));
  }

  // 11. Initial Weekly Test Scores (Phase 4b + Phase 13a + Phase 16a)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES)) {
    const initialWeeklyScores = [
      // Online Test wkt-online-1: STU101 completed section 1 (1d4r: 18 of 20 in 30s)
      { id: 'sc-on-1', test_id: 'wkt-online-1', student_id: 'usr-101', section_id: 'wsec-1', category_id: 'cat-bas-1', correct: 18, total: 20, time_seconds: 30, source: 'online', created_at: '2026-10-30T05:00:30.000Z' },
      // Offline Test 1: wkt-1 (section-based scores across basics, round, flash, elements, memoriad)
      { id: 'sc-1-1', test_id: 'wkt-1', student_id: 'usr-102', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 95, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-2', test_id: 'wkt-1', student_id: 'usr-102', section_id: 'wsec-off-2', category_id: 'cat-rnd-1', correct: 18, total: 20, time_seconds: 110, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-3', test_id: 'wkt-1', student_id: 'usr-101', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 85, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-3b', test_id: 'wkt-1', student_id: 'usr-101', section_id: 'wsec-off-3', category_id: null, correct: 4, total: 5, time_seconds: 25, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-3c', test_id: 'wkt-1', student_id: 'usr-101', section_id: 'wsec-off-4', category_id: null, correct: 35, total: 36, time_seconds: 52, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-4', test_id: 'wkt-1', student_id: 'usr-103', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 17, total: 20, time_seconds: 135, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-5', test_id: 'wkt-1', student_id: 'usr-105', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 15, total: 20, time_seconds: 155, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-6', test_id: 'wkt-1', student_id: 'usr-106', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 18, total: 20, time_seconds: 115, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      { id: 'sc-1-7', test_id: 'wkt-1', student_id: 'usr-107', section_id: 'wsec-off-1', category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 78, source: 'teacher', created_at: '2026-10-18T05:00:00.000Z' },
      // Legacy Offline Tests without sections: wkt-2, wkt-3, wkt-4, wkt-5
      { id: 'sc-2-1', test_id: 'wkt-2', student_id: 'usr-102', section_id: null, category_id: 'cat-bas-1', correct: 20, total: 20, time_seconds: 88, source: 'teacher', created_at: '2026-10-11T05:00:00.000Z' },
      { id: 'sc-2-2', test_id: 'wkt-2', student_id: 'usr-102', section_id: null, category_id: 'cat-bas-2', correct: 19, total: 20, time_seconds: 105, source: 'teacher', created_at: '2026-10-11T05:00:00.000Z' },
      { id: 'sc-2-3', test_id: 'wkt-2', student_id: 'usr-101', section_id: null, category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 90, source: 'teacher', created_at: '2026-10-11T05:00:00.000Z' },
      // Test 3: wkt-3
      { id: 'sc-3-1', test_id: 'wkt-3', student_id: 'usr-102', section_id: null, category_id: 'cat-bas-1', correct: 18, total: 20, time_seconds: 102, source: 'teacher', created_at: '2026-10-04T05:00:00.000Z' },
      // Test 4: wkt-4
      { id: 'sc-4-1', test_id: 'wkt-4', student_id: 'usr-102', section_id: null, category_id: 'cat-bas-1', correct: 19, total: 20, time_seconds: 94, source: 'teacher', created_at: '2026-09-27T05:00:00.000Z' },
      // Test 5: wkt-5
      { id: 'sc-5-1', test_id: 'wkt-5', student_id: 'usr-102', section_id: null, category_id: 'cat-bas-1', correct: 17, total: 20, time_seconds: 115, source: 'teacher', created_at: '2026-09-20T05:00:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(initialWeeklyScores));
  }

  // 12. Initial Import Batches (Phase 4c-2b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_IMPORT_BATCHES)) {
    localStorage.setItem(DEMO_STORAGE_KEY_IMPORT_BATCHES, JSON.stringify([]));
  }

  // 13. Initial Competition Settings (Phase 5a, Phase 12a & Phase 12b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_COMPETITION_SETTINGS)) {
    const initialCompetitionSettings = [
      { key: 'weekly_test_multiplier', value: '2' },
      { key: 'attendance_present_points', value: '10' },
      { key: 'improved_min_entries', value: '5' },
      { key: 'leaderboard_names', value: 'first_name_initial' },
      { key: 'todo_streak_start', value: '2026-10-15' },
      { key: 'global_leaderboard', value: 'on' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_COMPETITION_SETTINGS, JSON.stringify(initialCompetitionSettings));
  }

  // 14. Initial Report Log (Phase 5b)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_REPORT_LOG)) {
    const initialReportLogs = [
      {
        id: 'rlog-1',
        week_start: '2026-10-12',
        kind: 'cron',
        status: 'sent',
        error: null,
        to_email: 'coach@trendzabacus.com',
        created_by: null,
        created_at: '2026-10-18T15:30:05.000Z',
        finished_at: '2026-10-18T15:30:07.000Z'
      },
      {
        id: 'rlog-2',
        week_start: '2026-10-05',
        kind: 'manual',
        status: 'sent',
        error: null,
        to_email: 'coach@trendzabacus.com',
        created_by: 'usr-admin-1',
        created_at: '2026-10-12T06:15:00.000Z',
        finished_at: '2026-10-12T06:15:02.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_REPORT_LOG, JSON.stringify(initialReportLogs));
  }
}

function loadDB() {
  initDemoStorage();
  const profiles = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS) || '[]');
  const weekly_tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
  const weekly_test_attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
  const weekly_test_sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
  const announcements = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ANNOUNCEMENTS) || 'null');
  const student_messages = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_MESSAGES) || '[]');
  const dismissed_notifications = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_DISMISSED_NOTIFICATIONS) || '{}');

  return {
    profiles,
    weekly_tests,
    weekly_test_attempts,
    weekly_test_sections,
    announcements,
    student_messages,
    dismissed_notifications,
  };
}

function saveDB(db) {
  if (!db || typeof localStorage === 'undefined') return;
  if (db.profiles) localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(db.profiles));
  if (db.weekly_tests) localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(db.weekly_tests));
  if (db.weekly_test_attempts) localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(db.weekly_test_attempts));
  if (db.weekly_test_sections) localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS, JSON.stringify(db.weekly_test_sections));
  if (db.announcements) localStorage.setItem(DEMO_STORAGE_KEY_ANNOUNCEMENTS, JSON.stringify(db.announcements));
  if (db.student_messages) localStorage.setItem(DEMO_STORAGE_KEY_STUDENT_MESSAGES, JSON.stringify(db.student_messages));
  if (db.dismissed_notifications) localStorage.setItem(DEMO_STORAGE_KEY_DISMISSED_NOTIFICATIONS, JSON.stringify(db.dismissed_notifications));
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
      leaderboard_visible: true,
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
  toggleStudentLeaderboardVisible(studentId, nextVisible) {
    const students = this.getStudents();
    const index = students.findIndex(s => s.id === studentId || s.student_code === studentId);
    if (index === -1) throw new Error('Student not found');
    students[index].leaderboard_visible =
      typeof nextVisible === 'boolean' ? nextVisible : !students[index].leaderboard_visible;
    this.saveStudents(students);
    return students[index];
  },
  resetStudentPassword(studentId) {
    const students = this.getStudents();
    const student = students.find(s => s.id === studentId || s.student_code === studentId);
    if (!student) throw new Error('Student not found');
    return true;
  },
  updateStudentProfile(studentId, changedFields = {}, adminId = 'usr-admin-1') {
    initDemoStorage();
    if ('student_code' in changedFields || 'role' in changedFields) {
      throw new Error('student_code and role cannot be changed from the application.');
    }
    const students = this.getStudents();
    const index = students.findIndex(s => s.id === studentId || s.student_code === studentId);
    if (index === -1) throw new Error('Student not found.');

    const current = students[index];
    const oldValues = {};
    const newValues = {};
    const allowedKeys = ['full_name', 'level', 'active', 'leaderboard_visible'];

    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(changedFields, key)) {
        oldValues[key] = current[key] ?? null;
        newValues[key] = changedFields[key];
        current[key] = changedFields[key];
      }
    }

    students[index] = current;
    this.saveStudents(students);

    if (Object.keys(newValues).length > 0) {
      const auditKey = 'trendz_demo_profile_audit_v1';
      const auditList = JSON.parse(localStorage.getItem(auditKey) || '[]');
      auditList.unshift({
        id: `pa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        profile_id: current.id,
        changed_by: adminId,
        changed_at: new Date().toISOString(),
        old_values: oldValues,
        new_values: newValues
      });
      localStorage.setItem(auditKey, JSON.stringify(auditList));
    }

    return current;
  },
  getProfileAudit(studentId) {
    initDemoStorage();
    const auditKey = 'trendz_demo_profile_audit_v1';
    const auditList = JSON.parse(localStorage.getItem(auditKey) || '[]');
    return auditList
      .filter(a => a.profile_id === studentId)
      .sort((a, b) => String(b.changed_at || '').localeCompare(String(a.changed_at || '')));
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
    return todos.filter(t => t.active).map((t, idx) => {
      const reqCount = Number(t.required_count) || 1;
      const isDone = idx < 4;
      return {
        task_id: t.id,
        task_title: t.title,
        task_section: t.section,
        task_category_id: t.category_id || null,
        task_activity_key: t.activity_key || null,
        flash_digits: t.flash_digits ?? null,
        flash_count: t.flash_count ?? null,
        flash_speed_ms: t.flash_speed_ms ?? null,
        flash_mode: t.flash_mode ?? null,
        required_count: reqCount,
        done_count: isDone ? reqCount : 0,
        done: isDone
      };
    });
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
  addTodo({
    title,
    section,
    category_id,
    activity_key,
    flash_digits = null,
    flash_count = null,
    flash_speed_ms = null,
    flash_mode = null,
    level,
    required_count = 1,
    active = true
  }) {
    if (!isDemoMode()) throw new Error('Blocked in production mode');
    const todos = this.getTodos();
    const newTodo = {
      id: `todo-${Date.now()}`,
      title: title.trim(),
      section,
      category_id: category_id || null,
      activity_key: activity_key || null,
      flash_digits: section === 'flash' ? (flash_digits ?? null) : null,
      flash_count: section === 'flash' ? (flash_count ?? null) : null,
      flash_speed_ms: section === 'flash' ? (flash_speed_ms ?? null) : null,
      flash_mode: section === 'flash' ? (flash_mode ?? null) : null,
      level: level ? level.trim() : null,
      required_count: Number(required_count) || 1,
      sort_order: todos.length + 1,
      active: Boolean(active),
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
    const targets = this.getBasicsThresholds().filter(t => t.active);

    const catMap = new Map(categories.map(c => [c.id, c]));
    const studentMap = new Map(students.map(s => [s.id, s]));

    // Join with category, student, and target benchmark (emulating results_with_target view)
    let list = results.map(r => {
      const cat = catMap.get(r.category_id) || { name: 'Unknown Category', section: 'other' };
      const student = studentMap.get(r.student_id) || { full_name: 'Unknown Student', student_code: '—', level: '—' };
      const isVerified = r.verified === true || !!r.verified_at || !!r.verified_by;
      const isCorrected = !!r.corrected_at || !!r.corrected_by;
      const isFlagged = r.flagged === true;
      const source = r.source || 'typed';

      const meetsTarget = r.meets_target !== undefined ? r.meets_target : null;

      return {
        ...r,
        source,
        verified: isVerified,
        category: cat,
        student,
        isVerified,
        isCorrected,
        isFlagged,
        meets_target: meetsTarget
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
      min_questions_per_minute:
        data.min_questions_per_minute !== undefined &&
        data.min_questions_per_minute !== null &&
        data.min_questions_per_minute !== ''
          ? Number(data.min_questions_per_minute)
          : null,
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
      min_questions_per_minute:
        updates.min_questions_per_minute !== undefined
          ? updates.min_questions_per_minute !== null && updates.min_questions_per_minute !== ''
            ? Number(updates.min_questions_per_minute)
            : null
          : current.min_questions_per_minute ?? null,
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
        test_type: t.test_type || 'offline',
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
      test_type: data.test_type || 'offline',
      audience_level: data.audience_level || null,
      opens_at: data.opens_at || null,
      closes_at: data.closes_at || null,
      remind_days_before: data.remind_days_before !== undefined ? Number(data.remind_days_before) : 7,
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
      notes: data.notes !== undefined ? (data.notes ? data.notes.trim() : null) : tests[idx].notes,
      test_type: data.test_type !== undefined ? data.test_type : (tests[idx].test_type || 'offline'),
      audience_level: data.audience_level !== undefined ? (data.audience_level || null) : (tests[idx].audience_level || null),
      opens_at: data.opens_at !== undefined ? (data.opens_at || null) : (tests[idx].opens_at || null),
      closes_at: data.closes_at !== undefined ? (data.closes_at || null) : (tests[idx].closes_at || null),
      remind_days_before: data.remind_days_before !== undefined ? Number(data.remind_days_before) : (tests[idx].remind_days_before ?? 7)
    };
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(tests));
    return tests[idx];
  },

  getWeeklyTestSections(testId) {
    initDemoStorage();
    const sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
    return sections
      .filter(s => s.test_id === testId)
      .map(s => ({
        ...s,
        kind: s.kind || 'basics',
        category_id: s.category_id || null,
        activity_key: s.activity_key || null,
        seconds: s.seconds != null ? Number(s.seconds) : null,
        flash_digits: s.flash_digits != null ? Number(s.flash_digits) : null,
        flash_count: s.flash_count != null ? Number(s.flash_count) : null,
        flash_speed_ms: s.flash_speed_ms != null ? Number(s.flash_speed_ms) : null,
        flash_mode: s.flash_mode || null,
        question_count: s.question_count != null ? Number(s.question_count) : null
      }))
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  },

  /**
   * Updates sections in place by id, inserts new ones, and deletes removed ones
   * ONLY when they have no scores or attempts (never deletes all and re-inserts).
   */
  saveWeeklyTestSections(testId, sectionsList) {
    initDemoStorage();
    let sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');

    const lockedIds = new Set();
    scores.filter(sc => sc.test_id === testId && sc.section_id).forEach(sc => lockedIds.add(sc.section_id));
    attempts.filter(at => at.test_id === testId && at.section_id).forEach(at => lockedIds.add(at.section_id));

    const existingForTest = sections.filter(s => s.test_id === testId);
    const incomingIds = new Set((sectionsList || []).map(s => s.id).filter(Boolean));

    // Refuse removing a locked section
    for (const oldSec of existingForTest) {
      if (!incomingIds.has(oldSec.id) && lockedIds.has(oldSec.id)) {
        throw new Error('Cannot remove a section that already has student scores or attempts.');
      }
    }

    // Remove unlocked sections that are no longer in incomingIds
    sections = sections.filter(s => s.test_id !== testId || incomingIds.has(s.id));

    (sectionsList || []).forEach((s, idx) => {
      const pos = Number(s.position) || idx + 1;
      const rowData = {
        test_id: testId,
        position: pos,
        kind: s.kind || 'basics',
        category_id: s.category_id || null,
        activity_key: s.activity_key || null,
        seconds: s.seconds !== null && s.seconds !== undefined && s.seconds !== '' ? Number(s.seconds) : null,
        flash_digits: s.flash_digits != null ? Number(s.flash_digits) : null,
        flash_count: s.flash_count != null ? Number(s.flash_count) : null,
        flash_speed_ms: s.flash_speed_ms != null ? Number(s.flash_speed_ms) : null,
        flash_mode: s.flash_mode || null,
        question_count: s.question_count != null ? Number(s.question_count) : null
      };

      if (s.id) {
        const existingIdx = sections.findIndex(ex => ex.id === s.id && ex.test_id === testId);
        if (existingIdx !== -1) {
          if (lockedIds.has(s.id)) {
            // Only position can change on a locked section
            sections[existingIdx].position = pos;
          } else {
            sections[existingIdx] = {
              ...sections[existingIdx],
              ...rowData
            };
          }
          return;
        }
      }

      sections.push({
        id: `wsec-${Date.now()}-${idx + 1}-${Math.random().toString(36).slice(2, 5)}`,
        ...rowData
      });
    });

    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS, JSON.stringify(sections));
    return true;
  },

  getWeeklyTestAttempts(testId) {
    initDemoStorage();
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    return attempts.filter(a => a.test_id === testId);
  },

  getAllWeeklyTestScoresForTest(testId) {
    initDemoStorage();
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    return scores.filter(s => s.test_id === testId);
  },

  resetWeeklyTestSectionAttempt(testId, studentId, categoryId = null, sectionId = null) {
    initDemoStorage();
    const matchesTarget = (row) => {
      if (row.test_id !== testId || row.student_id !== studentId) return false;
      if (sectionId && row.section_id === sectionId) return true;
      if (categoryId && (row.section_id === categoryId || row.category_id === categoryId)) return true;
      return false;
    };

    let attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    attempts = attempts.filter(a => !matchesTarget(a));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));

    let scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    scores = scores.filter(s => !matchesTarget(s));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(scores));
    return true;
  },

  getWeeklyTestRemovals() {
    initDemoStorage();
    const removals = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS) || '[]');
    return removals
      .filter(r => !r.restored_at)
      .sort((a, b) => String(b.removed_at || '').localeCompare(String(a.removed_at || '')));
  },

  mockAdminRemoveWeeklyTest(testId, reason = null, adminId = 'usr-admin-1') {
    initDemoStorage();
    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const target = tests.find(t => t.id === testId);
    if (!target) throw new Error('Weekly test not found.');

    const sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    const snapshotSections = sections.filter(s => s.test_id === testId);
    const snapshotAttempts = attempts.filter(a => a.test_id === testId);
    const snapshotScores = scores.filter(sc => sc.test_id === testId);

    const removals = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS) || '[]');
    removals.unshift({
      id: `wrem-${Date.now()}`,
      removed_by: adminId,
      removed_at: new Date().toISOString(),
      reason: reason || null,
      title: target.title,
      test_date: target.test_date,
      scores_count: snapshotScores.length,
      restored_at: null,
      snapshot: {
        test: target,
        sections: snapshotSections,
        attempts: snapshotAttempts,
        scores: snapshotScores
      }
    });

    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS, JSON.stringify(removals));
    localStorage.setItem(
      DEMO_STORAGE_KEY_WEEKLY_TESTS,
      JSON.stringify(tests.filter(t => t.id !== testId))
    );
    localStorage.setItem(
      DEMO_STORAGE_KEY_WEEKLY_SECTIONS,
      JSON.stringify(sections.filter(s => s.test_id !== testId))
    );
    localStorage.setItem(
      DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS,
      JSON.stringify(attempts.filter(a => a.test_id !== testId))
    );
    localStorage.setItem(
      DEMO_STORAGE_KEY_WEEKLY_SCORES,
      JSON.stringify(scores.filter(sc => sc.test_id !== testId))
    );
    return true;
  },

  mockAdminRestoreWeeklyTest(removalId) {
    initDemoStorage();
    const removals = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS) || '[]');
    const idx = removals.findIndex(r => r.id === removalId && !r.restored_at);
    if (idx === -1) throw new Error('Removed test snapshot not found.');

    const rem = removals[idx];
    const snap = rem.snapshot || {};
    if (!snap.test) throw new Error('Snapshot test data is missing.');

    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    tests.push(snap.test);
    sections.push(...(snap.sections || []));
    attempts.push(...(snap.attempts || []));
    scores.push(...(snap.scores || []));

    removals[idx].restored_at = new Date().toISOString();

    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_REMOVALS, JSON.stringify(removals));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_TESTS, JSON.stringify(tests));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS, JSON.stringify(sections));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(scores));

    return snap.test;
  },

  mockMyWeeklyTests(studentId = 'usr-101') {
    initDemoStorage();
    const students = this.getStudents();
    const student = students.find(s => s.id === studentId);
    const studentLevel = String(student?.level || '').trim().toLowerCase();

    const tests = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_TESTS) || '[]');
    const sections = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SECTIONS) || '[]');
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    const cats = this.getCategories();
    const catMap = new Map(cats.map(c => [c.id, c]));

    const todayIst = new Date(Date.now() + 330 * 60 * 1000).toISOString().split('T')[0];
    const nowMs = Date.now();

    return tests
      .filter(t => {
        if (!t.audience_level) return true;
        return String(t.audience_level).trim().toLowerCase() === studentLevel;
      })
      .map(t => {
        const isOnline = (t.test_type || 'offline') === 'online';
        let state = 'past';
        if (isOnline) {
          if (t.opens_at || t.closes_at) {
            const openMs = t.opens_at ? new Date(t.opens_at).getTime() : 0;
            const closeMs = t.closes_at ? new Date(t.closes_at).getTime() : Infinity;
            if (nowMs < openMs) state = 'upcoming';
            else if (nowMs <= closeMs) state = 'open';
            else state = 'closed';
          } else {
            if (t.test_date > todayIst) state = 'upcoming';
            else if (t.test_date === todayIst) state = 'open';
            else state = 'closed';
          }
        } else {
          if (t.test_date > todayIst) state = 'upcoming';
          else if (t.test_date === todayIst) state = 'today';
          else state = 'past';
        }

        const rawTestSecs = sections
          .filter(s => s.test_id === t.id)
          .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

        const secMap = new Map(rawTestSecs.map(s => [s.id, s]));

        const testSections = rawTestSecs.map(s => {
          const kind = s.kind || 'basics';
          const cat = s.category_id ? catMap.get(s.category_id) : null;
          const att = attempts.find(
            a =>
              a.test_id === t.id &&
              a.student_id === studentId &&
              ((a.section_id && a.section_id === s.id) ||
                (!a.section_id && s.category_id && a.category_id === s.category_id))
          );
          const sc = scores.find(
            r =>
              r.test_id === t.id &&
              r.student_id === studentId &&
              ((r.section_id && r.section_id === s.id) ||
                (!r.section_id && s.category_id && r.category_id === s.category_id))
          );
          return {
            section_id: s.id,
            kind,
            category_id: s.category_id || null,
            name: cat ? cat.name : null,
            activity_key: s.activity_key || null,
            seconds: s.seconds != null ? Number(s.seconds) : null,
            position: Number(s.position) || 1,
            flash_digits: s.flash_digits != null ? Number(s.flash_digits) : null,
            flash_count: s.flash_count != null ? Number(s.flash_count) : null,
            flash_speed_ms: s.flash_speed_ms != null ? Number(s.flash_speed_ms) : null,
            flash_mode: s.flash_mode || null,
            question_count: s.question_count != null ? Number(s.question_count) : null,
            attempt: att ? att.status : null,
            tries_started: att?.tries_started != null ? Number(att.tries_started) : 0,
            tries_correct: att?.tries_correct != null ? Number(att.tries_correct) : 0,
            correct: sc ? Number(sc.correct) : null,
            total: sc ? Number(sc.total) : null,
            time_seconds: sc && sc.time_seconds != null ? Number(sc.time_seconds) : null
          };
        });

        const testScores = scores
          .filter(r => r.test_id === t.id && r.student_id === studentId)
          .map(r => {
            const sec = r.section_id ? secMap.get(r.section_id) : null;
            const catId = r.category_id || sec?.category_id || null;
            const cat = catId ? catMap.get(catId) : null;
            const kind = sec?.kind || (cat?.section === 'round' ? 'round' : 'basics');
            return {
              section_id: r.section_id || null,
              category_id: catId,
              category: cat ? cat.name : null,
              kind,
              activity_key: sec?.activity_key || null,
              flash_digits: sec?.flash_digits ?? null,
              flash_count: sec?.flash_count ?? null,
              flash_speed_ms: sec?.flash_speed_ms ?? null,
              flash_mode: sec?.flash_mode ?? null,
              question_count: sec?.question_count ?? null,
              seconds: sec?.seconds ?? null,
              correct: Number(r.correct),
              total: Number(r.total),
              time_seconds: r.time_seconds != null ? Number(r.time_seconds) : null,
              source: r.source || 'teacher'
            };
          });

        const leaderboardReady = !isOnline || state === 'closed';

        return {
          id: t.id,
          title: t.title,
          notes: t.notes || null,
          test_date: t.test_date,
          type: isOnline ? 'online' : 'offline',
          opens_at: t.opens_at || null,
          closes_at: t.closes_at || null,
          state,
          leaderboard_ready: leaderboardReady,
          sections: testSections,
          scores: testScores
        };
      });
  },

  mockStartWeeklyTestSection(studentId, testId, categoryId, sectionId = null) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    initDemoStorage();
    const myTests = this.mockMyWeeklyTests(studentId);
    const test = myTests.find(t => t.id === testId);
    if (!test || test.type !== 'online') {
      throw new Error('Online weekly test not found.');
    }
    if (test.state !== 'open') {
      throw new Error('This weekly test is not currently open.');
    }
    const sec = (test.sections || []).find(
      s => (sectionId && s.section_id === sectionId) || (!sectionId && s.category_id === categoryId)
    );
    if (!sec) {
      throw new Error('Section not found in this weekly test.');
    }
    const kind = String(sec.kind || 'basics').toLowerCase();
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    const sessions = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS) || '{}');
    const sessionId = `demo-wt-sess-${Date.now()}`;
    const startedAt = new Date().toISOString();

    if (kind === 'flash') {
      const qCount = Math.max(1, Number(sec.question_count) || 5);
      const attIdx = attempts.findIndex(
        a =>
          a.test_id === testId &&
          a.student_id === studentId &&
          ((sec.section_id && a.section_id === sec.section_id) ||
            (!sec.section_id && sec.category_id && a.category_id === sec.category_id))
      );

      let nextTryNo = 1;
      let triesCorrect = 0;
      let secondsUsed = 0;

      if (attIdx >= 0) {
        const existingAtt = attempts[attIdx];
        if (existingAtt.status === 'submitted' || Number(existingAtt.tries_started) >= qCount) {
          throw new Error('You have already finished this Flash Anzan section.');
        }
        nextTryNo = (Number(existingAtt.tries_started) || 0) + 1;
        triesCorrect = Number(existingAtt.tries_correct) || 0;
        secondsUsed = Number(existingAtt.seconds_used) || 0;
        attempts[attIdx].tries_started = nextTryNo;
        attempts[attIdx].session_id = sessionId;
      } else {
        attempts.push({
          id: `watt-${Date.now()}`,
          test_id: testId,
          student_id: studentId,
          section_id: sec.section_id || null,
          category_id: null,
          session_id: sessionId,
          status: 'started',
          tries_started: 1,
          tries_correct: 0,
          seconds_used: 0,
          started_at: startedAt,
          finished_at: null,
        });
        const scIdx = scores.findIndex(
          r => r.test_id === testId && r.student_id === studentId && r.section_id === sec.section_id
        );
        const partialScore = {
          id: scIdx >= 0 ? scores[scIdx].id : `sc-on-${Date.now()}`,
          test_id: testId,
          student_id: studentId,
          section_id: sec.section_id || null,
          category_id: null,
          correct: 0,
          total: qCount,
          time_seconds: 0,
          source: 'online',
          created_at: startedAt,
        };
        if (scIdx >= 0) scores[scIdx] = partialScore;
        else scores.push(partialScore);
        localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(scores));
      }
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));

      const flashSettings = {
        digits: Number(sec.flash_digits) || 2,
        count: Number(sec.flash_count) || 5,
        speed_ms: Number(sec.flash_speed_ms) || 1000,
        mode: sec.flash_mode === 'add_sub' ? 'add_sub' : 'add',
        question_count: qCount,
      };
      const flashStart = this.mockFlashStart(flashSettings, studentId);
      const expectedSum = (flashStart.numbers || []).reduce((acc, n) => acc + Number(n), 0);

      sessions[sessionId] = {
        kind: 'flash',
        test_id: testId,
        title: test.title,
        student_id: studentId,
        section_id: sec.section_id || null,
        try_no: nextTryNo,
        question_count: qCount,
        tries_correct: triesCorrect,
        seconds_used: secondsUsed,
        expected: expectedSum,
        settings: flashSettings,
        started_at: startedAt,
      };
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS, JSON.stringify(sessions));

      return {
        ok: true,
        session_id: sessionId,
        kind: 'flash',
        test_id: testId,
        section_id: sec.section_id || null,
        title: test.title,
        try_no: nextTryNo,
        question_count: qCount,
        tries_correct: triesCorrect,
        numbers: flashStart.numbers,
        settings: flashSettings,
      };
    }

    if (sec.attempt) {
      throw new Error('You have already started this section.');
    }

    attempts.push({
      id: `watt-${Date.now()}`,
      test_id: testId,
      student_id: studentId,
      section_id: sec.section_id || null,
      category_id: sec.category_id || categoryId || null,
      session_id: sessionId,
      status: 'started',
      tries_started: 1,
      tries_correct: 0,
      seconds_used: null,
      started_at: startedAt,
      finished_at: null,
    });
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));

    if (kind === 'elements') {
      const elemStart = this.mockElementDrillStart(sec.activity_key || 'day_codes');
      sessions[sessionId] = {
        kind: 'elements',
        test_id: testId,
        title: test.title,
        student_id: studentId,
        section_id: sec.section_id || null,
        drill: sec.activity_key || 'day_codes',
        drill_title: elemStart.title,
        time_limit_seconds: elemStart.time_limit_seconds,
        started_at: startedAt,
      };
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS, JSON.stringify(sessions));
      return {
        ok: true,
        session_id: sessionId,
        kind: 'elements',
        test_id: testId,
        section_id: sec.section_id || null,
        title: test.title,
        drill: sec.activity_key || 'day_codes',
        drill_title: elemStart.title,
        questions: elemStart.questions,
        time_limit_seconds: elemStart.time_limit_seconds,
        hint: elemStart.hint,
      };
    }

    if (kind === 'memoriad') {
      const mod = sec.activity_key || 'calendar';
      const memStart = this.mockMemoriadStart(mod, { concentration_seconds: 5 });
      const fixedSettings = {
        dates: 125,
        typing_direction: 'rtl',
        additions_columns: 1,
        concentration_seconds: 5,
        show_timer: true,
      };
      sessions[sessionId] = {
        kind: 'memoriad',
        test_id: testId,
        title: test.title,
        student_id: studentId,
        section_id: sec.section_id || null,
        module: mod,
        module_title: memStart.title,
        time_limit_seconds: memStart.time_limit_seconds,
        started_at: startedAt,
      };
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS, JSON.stringify(sessions));
      return {
        ok: true,
        session_id: sessionId,
        kind: 'memoriad',
        test_id: testId,
        section_id: sec.section_id || null,
        title: test.title,
        module: mod,
        module_title: memStart.title,
        questions: memStart.questions,
        time_limit_seconds: memStart.time_limit_seconds,
        limits: {
          time_limit_seconds: memStart.time_limit_seconds,
          questions_total: Array.isArray(memStart.questions) ? memStart.questions.length : 10,
        },
        settings: fixedSettings,
      };
    }

    // Default: basics
    const drillStart = this.mockBasicsDrillStart(sec.category_id || categoryId, 'timed', sec.seconds);
    sessions[sessionId] = {
      kind: 'basics',
      test_id: testId,
      title: test.title,
      student_id: studentId,
      section_id: sec.section_id || null,
      category_id: sec.category_id || categoryId,
      seconds: sec.seconds,
      started_at: startedAt,
      drill_session_id: drillStart.session_id,
    };
    localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS, JSON.stringify(sessions));

    return {
      ok: true,
      session_id: sessionId,
      kind: 'basics',
      test_id: testId,
      section_id: sec.section_id || null,
      title: test.title,
      category_name: sec.name,
      seconds: sec.seconds,
      questions: drillStart.questions,
    };
  },

  mockSubmitWeeklyTestSection(studentId, sessionId, answers = []) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    initDemoStorage();
    const sessions = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SESSIONS) || '{}');
    const sess = sessions[sessionId];
    if (!sess) {
      throw new Error('Weekly test session not found.');
    }

    const kind = String(sess.kind || 'basics').toLowerCase();
    const attempts = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS) || '[]');
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    const upsertScoreRow = (correct, total, timeSeconds, categoryId = null) => {
      const existingIdx = scores.findIndex(
        sc =>
          sc.test_id === sess.test_id &&
          sc.student_id === studentId &&
          ((sess.section_id && sc.section_id === sess.section_id) ||
            (!sess.section_id && categoryId && sc.category_id === categoryId))
      );
      const row = {
        id: existingIdx >= 0 ? scores[existingIdx].id : `sc-on-${Date.now()}`,
        test_id: sess.test_id,
        student_id: studentId,
        section_id: sess.section_id || null,
        category_id: categoryId || null,
        correct,
        total,
        time_seconds: timeSeconds,
        source: 'online',
        created_at: new Date().toISOString(),
      };
      if (existingIdx >= 0) scores[existingIdx] = row;
      else scores.push(row);
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_SCORES, JSON.stringify(scores));
    };

    if (kind === 'flash') {
      const givenNum =
        answers !== null && answers !== undefined && String(answers).trim() !== ''
          ? Number(String(answers).trim())
          : NaN;
      const isCorrect = Number.isFinite(givenNum) && givenNum === Number(sess.expected);
      const trySec = Math.max(1, Math.round((Date.now() - new Date(sess.started_at).getTime()) / 1000));
      const newTriesCorrect = (Number(sess.tries_correct) || 0) + (isCorrect ? 1 : 0);
      const newSecondsUsed = (Number(sess.seconds_used) || 0) + trySec;
      const tryNo = Number(sess.try_no) || 1;
      const qCount = Number(sess.question_count) || 5;
      const done = tryNo >= qCount;

      const attIdx = attempts.findIndex(
        a => a.test_id === sess.test_id && a.student_id === studentId && a.section_id === sess.section_id
      );
      if (attIdx >= 0) {
        attempts[attIdx].tries_correct = newTriesCorrect;
        attempts[attIdx].seconds_used = newSecondsUsed;
        if (done) {
          attempts[attIdx].status = 'submitted';
          attempts[attIdx].finished_at = new Date().toISOString();
        }
        localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));
      }

      upsertScoreRow(newTriesCorrect, qCount, newSecondsUsed, null);

      if (!done) {
        return {
          ok: true,
          kind: 'flash',
          done: false,
          try_no: tryNo,
          question_count: qCount,
          title: sess.title || 'Weekly Test',
        };
      }
      return {
        ok: true,
        kind: 'flash',
        done: true,
        try_no: tryNo,
        question_count: qCount,
        tries_correct: newTriesCorrect,
        correct: newTriesCorrect,
        total: qCount,
        seconds_used: newSecondsUsed,
        title: sess.title || 'Weekly Test',
      };
    }

    if (kind === 'elements') {
      const fixedResult = {
        ok: true,
        kind: 'elements',
        title: sess.title || 'Weekly Test',
        correct: 4,
        attempted: 5,
        questions_total: 5,
        accuracy: 80.0,
        seconds: 18,
        detail: [
          { question: 'Sunday', expected_display: '1', given: answers?.[0] ?? '1', correct: true },
          { question: 'Saturday', expected_display: '0', given: answers?.[1] ?? '0', correct: true },
          { question: 'February (02)', expected_display: '4', given: answers?.[2] ?? '4', correct: true },
          { question: '47', expected_display: '2209', given: answers?.[3] ?? '2209', correct: true },
          { question: '97 / 4', expected_display: '24', given: answers?.[4] ?? '23', correct: false },
        ],
      };
      const attIdx = attempts.findIndex(
        a => a.test_id === sess.test_id && a.student_id === studentId && a.section_id === sess.section_id
      );
      if (attIdx >= 0) {
        attempts[attIdx].status = 'submitted';
        attempts[attIdx].seconds_used = fixedResult.seconds;
        attempts[attIdx].finished_at = new Date().toISOString();
        localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));
      }
      upsertScoreRow(fixedResult.correct, fixedResult.questions_total, fixedResult.seconds, null);
      return fixedResult;
    }

    if (kind === 'memoriad') {
      const mod = sess.module || 'calendar';
      const totalQ = mod === 'calendar' ? 25 : 10;
      const correctQ = mod === 'calendar' ? 24 : mod === 'square_roots' ? 8 : 9;
      const usedSec = mod === 'calendar' ? 31.42 : 118.65;
      const attIdx = attempts.findIndex(
        a => a.test_id === sess.test_id && a.student_id === studentId && a.section_id === sess.section_id
      );
      if (attIdx >= 0) {
        attempts[attIdx].status = 'submitted';
        attempts[attIdx].seconds_used = Math.round(usedSec);
        attempts[attIdx].finished_at = new Date().toISOString();
        localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));
      }
      upsertScoreRow(correctQ, totalQ, Math.round(usedSec), null);
      return {
        ok: true,
        kind: 'memoriad',
        module: mod,
        title: sess.module_title || 'Mental Calendar Dates',
        test_title: sess.title || 'Weekly Test',
        questions_total: totalQ,
        attempted: totalQ,
        correct: correctQ,
        wrong: totalQ - correctQ,
        score: mod === 'square_roots' ? 312 : correctQ,
        used_seconds: usedSec,
        saved: true,
        detail: [],
      };
    }

    const attempted = Array.isArray(answers) ? answers.length : 0;
    const elapsedSec = Math.max(
      1,
      Math.round(
        Math.min(
          Number(sess.seconds) || 60,
          (Date.now() - new Date(sess.started_at).getTime()) / 1000
        )
      )
    );

    const attIdx = attempts.findIndex(
      a =>
        a.test_id === sess.test_id &&
        a.student_id === studentId &&
        ((sess.section_id && a.section_id === sess.section_id) ||
          (!sess.section_id && a.category_id === sess.category_id))
    );
    if (attIdx >= 0) {
      attempts[attIdx].status = 'submitted';
      attempts[attIdx].seconds_used = elapsedSec;
      attempts[attIdx].finished_at = new Date().toISOString();
      localStorage.setItem(DEMO_STORAGE_KEY_WEEKLY_ATTEMPTS, JSON.stringify(attempts));
    }

    if (attempted === 0) {
      return {
        ok: true,
        kind: 'basics',
        title: sess.title || 'Weekly Test',
        correct: 0,
        attempted: 0,
        accuracy: 0,
        used_seconds: elapsedSec,
      };
    }

    const demoDrillSessions = JSON.parse(
      localStorage.getItem('trendz_demo_drill_sessions_v1') || '{}'
    );
    const rawDrill = demoDrillSessions[sess.drill_session_id];
    const expectedList = rawDrill?.expected || [];
    let correct = 0;
    for (let i = 0; i < attempted; i++) {
      const ans = answers[i];
      if (ans !== null && ans !== undefined && String(ans).trim() !== '') {
        if (Number(String(ans).trim()) === Number(expectedList[i])) {
          correct += 1;
        }
      }
    }

    const accuracy = Math.round((correct / attempted) * 1000) / 10;
    upsertScoreRow(correct, attempted, elapsedSec, sess.category_id);

    return {
      ok: true,
      kind: 'basics',
      title: sess.title || 'Weekly Test',
      correct,
      attempted,
      accuracy,
      used_seconds: elapsedSec,
    };
  },

  getWeeklyTestScores(testId, categoryId = null, sectionId = null) {
    initDemoStorage();
    const scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
    if (sectionId) {
      return scores.filter(
        s =>
          s.test_id === testId &&
          (s.section_id === sectionId || (!s.section_id && categoryId && s.category_id === categoryId))
      );
    }
    return scores.filter(s => s.test_id === testId && s.category_id === categoryId);
  },

  saveWeeklyTestScores(testId, categoryId = null, scoresList = [], sectionId = null) {
    initDemoStorage();
    let scores = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');

    scoresList.forEach(item => {
      const idx = scores.findIndex(s => {
        if (s.test_id !== testId || s.student_id !== item.student_id) return false;
        if (sectionId) {
          return s.section_id === sectionId || (!s.section_id && categoryId && s.category_id === categoryId);
        }
        return s.category_id === categoryId;
      });

      if (item.correct === null || item.correct === '' || item.total === null || item.total === '') {
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
            section_id: sectionId || scores[idx].section_id || null,
            category_id: categoryId !== undefined ? categoryId : scores[idx].category_id,
            correct: correctNum,
            total: totalNum,
            time_seconds: timeSec,
            source: 'teacher'
          };
        } else {
          scores.push({
            id: `sc-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            test_id: testId,
            student_id: item.student_id,
            section_id: sectionId || null,
            category_id: categoryId || null,
            correct: correctNum,
            total: totalNum,
            time_seconds: timeSec,
            source: 'teacher',
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

        const minAcc = effective ? effective.min_accuracy : null;
        const maxTime = effective ? effective.max_time_seconds : null;
        const minQpm = effective ? (effective.min_questions_per_minute ?? null) : null;
        const meets = r.meets_target !== undefined ? r.meets_target : (effective ? true : null);

        return {
          ...r,
          source: r.source || 'typed',
          practice_mode: r.practice_mode || null,
          verified: r.verified === true || !!r.verified_at || !!r.verified_by,
          categories: cat ? { id: cat.id, name: cat.name, section: cat.section } : null,
          min_accuracy: minAcc,
          min_questions_per_minute: minQpm,
          max_time_seconds: maxTime,
          meets_target: meets
        };
      })
      .filter(r => !section || (r.categories && r.categories.section === section));
  },

  // ==================== PHASE 4c-0: ROUND SERIES, CATEGORY SERIES & STUDENT ROUNDS ====================

  getRoundSeries() {
    initDemoStorage();
    const list = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ROUND_SERIES) || '[]');
    return list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  },

  getCategorySeries() {
    initDemoStorage();
    const list = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_SERIES) || '[]');
    return list.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  },

  getCategoryAliases() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_ALIASES) || '[]');
  },

  saveCategoryAliases(list) {
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORY_ALIASES, JSON.stringify(list));
  },

  upsertCategoryAlias(alias, categoryId) {
    initDemoStorage();
    const key = String(alias || '')
      .toLowerCase()
      .replace(/\s+/g, '');
    if (!key || !categoryId) {
      throw new Error('Both alias and category_id are required.');
    }
    const list = this.getCategoryAliases();
    const idx = list.findIndex(a => String(a.alias || '').toLowerCase().replace(/\s+/g, '') === key);
    if (idx >= 0) {
      list[idx] = { alias: key, category_id: categoryId };
    } else {
      list.push({ alias: key, category_id: categoryId });
    }
    this.saveCategoryAliases(list);
    return { alias: key, category_id: categoryId };
  },

  deleteCategoryAlias(alias) {
    initDemoStorage();
    const key = String(alias || '')
      .toLowerCase()
      .replace(/\s+/g, '');
    const list = this.getCategoryAliases().filter(
      a => String(a.alias || '').toLowerCase().replace(/\s+/g, '') !== key
    );
    this.saveCategoryAliases(list);
    return true;
  },

  getImportBatches(studentId = null) {
    initDemoStorage();
    let list = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_IMPORT_BATCHES) || '[]');
    if (studentId) {
      list = list.filter(b => b.student_id === studentId);
    }
    return list.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  },

  saveImportBatches(list) {
    localStorage.setItem(DEMO_STORAGE_KEY_IMPORT_BATCHES, JSON.stringify(list));
  },

  adminStartImport({
    p_student,
    p_file_name,
    p_name_in_file,
    p_mark_verified,
    p_rows_found,
    p_summary
  }, adminId = 'usr-admin-1') {
    initDemoStorage();
    if (!p_student) throw new Error('Student is required to start an import batch.');
    const batches = this.getImportBatches();
    const newBatch = {
      id: `batch-demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      student_id: p_student,
      file_name: String(p_file_name || 'scoresheet.csv'),
      name_in_file: p_name_in_file ? String(p_name_in_file) : null,
      mark_verified: Boolean(p_mark_verified),
      rows_found: Number(p_rows_found) || 0,
      summary: p_summary || {},
      status: 'started',
      rounds_created: 0,
      rounds_merged: 0,
      rounds_skipped: 0,
      cells_inserted: 0,
      cells_skipped: 0,
      created_at: new Date().toISOString(),
      created_by: adminId,
      finished_at: null,
      undone_at: null,
      undone_by: null,
      undo_reason: null,
      results_deleted: 0,
      results_kept: 0,
      rounds_deleted: 0
    };
    batches.unshift(newBatch);
    this.saveImportBatches(batches);
    return newBatch.id;
  },

  adminImportEnsureCategory({
    p_batch,
    p_series,
    p_category = null,
    p_new_name = null
  }) {
    initDemoStorage();
    if (!p_batch || !p_series) {
      throw new Error('Batch ID and Series ID are required for admin_import_ensure_category.');
    }
    const categories = this.getCategories();
    const catSeries = this.getCategorySeries();

    let targetCatId = null;

    if (p_category) {
      const existingCat = categories.find(c => c.id === p_category && c.section === 'round');
      if (!existingCat) {
        throw new Error(`Round category "${p_category}" not found.`);
      }
      targetCatId = existingCat.id;
    } else if (p_new_name && String(p_new_name).trim()) {
      const cleanName = String(p_new_name).trim();
      const matchKey = cleanName.toLowerCase().replace(/\s+/g, '');
      let existingCat = categories.find(
        c => c.section === 'round' && String(c.name || '').toLowerCase().replace(/\s+/g, '') === matchKey
      );
      if (!existingCat) {
        const roundCats = categories.filter(c => c.section === 'round');
        const maxSort = roundCats.reduce((m, c) => Math.max(m, c.sort_order || 0), 0);
        existingCat = {
          id: `cat-rnd-hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: cleanName,
          section: 'round',
          sort_order: maxSort + 1,
          active: false, // Historical imported categories are created INACTIVE
          import_batch_id: p_batch,
          created_at: new Date().toISOString()
        };
        categories.push(existingCat);
        this.saveCategories(categories);
      }
      targetCatId = existingCat.id;
    } else {
      throw new Error('Either p_category or p_new_name must be provided.');
    }

    // Link targetCatId to p_series in category_series if not already linked
    const alreadyLinked = catSeries.some(
      cs => cs.category_id === targetCatId && cs.series_id === p_series
    );
    if (!alreadyLinked) {
      const seriesItems = catSeries.filter(cs => cs.series_id === p_series);
      const maxSort = seriesItems.reduce((m, cs) => Math.max(m, cs.sort_order || 0), 0);
      catSeries.push({
        category_id: targetCatId,
        series_id: p_series,
        sort_order: maxSort + 1
      });
      this.saveCategorySeries(catSeries);
    }

    return targetCatId;
  },

  adminImportRounds({
    p_batch,
    p_series,
    p_rounds,
    p_on_date_conflict = 'use_existing'
  }) {
    initDemoStorage();
    if (!p_batch || !p_series) {
      throw new Error('p_batch and p_series are required.');
    }
    if (!Array.isArray(p_rounds) || p_rounds.length < 1 || p_rounds.length > 100) {
      throw new Error('admin_import_rounds accepts between 1 and 100 rounds per call.');
    }
    if (p_on_date_conflict !== 'skip' && p_on_date_conflict !== 'use_existing') {
      throw new Error("p_on_date_conflict must be 'skip' or 'use_existing'.");
    }

    let totalCellsInCall = 0;
    for (const rnd of p_rounds) {
      if (!rnd || !Number.isFinite(Number(rnd.round_number)) || !rnd.round_date) {
        throw new Error('Each round must include a valid round_number and round_date.');
      }
      const cells = Array.isArray(rnd.cells) ? rnd.cells : [];
      totalCellsInCall += cells.length;
    }
    if (totalCellsInCall > 3000) {
      throw new Error('admin_import_rounds accepts at most 3000 cells per call.');
    }

    const batches = this.getImportBatches();
    const batchIdx = batches.findIndex(b => b.id === p_batch);
    if (batchIdx === -1) {
      throw new Error(`Import batch "${p_batch}" not found.`);
    }
    const batch = batches[batchIdx];
    const studentId = batch.student_id;

    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const allResults = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const nowISO = new Date().toISOString();

    let rounds_created = 0;
    let rounds_merged = 0;
    let rounds_skipped = 0;
    let cells_inserted = 0;
    let cells_skipped = 0;

    for (const rnd of p_rounds) {
      const rNum = Number(rnd.round_number);
      const rDate = String(rnd.round_date);
      const rType = rnd.round_type ? String(rnd.round_type).trim() : 'Category wise';
      const rTime =
        rnd.time_taken_seconds !== null && rnd.time_taken_seconds !== undefined
          ? Number(rnd.time_taken_seconds)
          : null;
      const cells = Array.isArray(rnd.cells) ? rnd.cells : [];

      let targetRound = allRounds.find(
        sr =>
          sr.student_id === studentId &&
          sr.series_id === p_series &&
          Number(sr.round_number) === rNum
      );

      if (targetRound) {
        const hasDateConflict = Boolean(
          targetRound.round_date && rDate && targetRound.round_date !== rDate
        );
        if (hasDateConflict && p_on_date_conflict === 'skip') {
          rounds_skipped += 1;
          cells_skipped += cells.length;
          continue;
        }
        // Merge into existing round (never overwrite existing round date; fill time_taken_seconds if missing)
        if (
          (targetRound.time_taken_seconds === null || targetRound.time_taken_seconds === undefined) &&
          rTime !== null
        ) {
          targetRound.time_taken_seconds = rTime;
        }
        rounds_merged += 1;
      } else {
        targetRound = {
          id: `sr-imp-${studentId}-${rNum}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          student_id: studentId,
          series_id: p_series,
          round_number: rNum,
          round_date: rDate,
          round_type: rType,
          time_taken_seconds: rTime,
          import_batch_id: p_batch,
          created_at: nowISO
        };
        allRounds.push(targetRound);
        rounds_created += 1;
      }

      for (const cell of cells) {
        if (!cell || !cell.category_id) {
          throw new Error(`Invalid cell in Round ${rNum}: missing category_id.`);
        }
        const existingRes = allResults.find(
          r => r.student_round_id === targetRound.id && r.category_id === cell.category_id
        );
        if (existingRes) {
          // Never overwrite existing cells
          cells_skipped += 1;
        } else {
          allResults.push({
            id: `res-imp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            student_id: studentId,
            student_round_id: targetRound.id,
            category_id: cell.category_id,
            correct: cell.correct !== null && cell.correct !== undefined ? Number(cell.correct) : null,
            total: cell.total !== null && cell.total !== undefined ? Number(cell.total) : null,
            time_seconds:
              cell.time_seconds !== null && cell.time_seconds !== undefined
                ? Number(cell.time_seconds)
                : null,
            note: cell.note ? String(cell.note) : null,
            entry_date: targetRound.round_date,
            created_at: nowISO,
            verified: Boolean(batch.mark_verified),
            verified_by: batch.mark_verified ? batch.created_by : null,
            verified_at: batch.mark_verified ? nowISO : null,
            corrected_by: null,
            corrected_at: null,
            flagged: false,
            flag_note: null,
            import_batch_id: p_batch
          });
          cells_inserted += 1;
        }
      }
    }

    this.saveStudentRounds(allRounds);
    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(allResults));

    // Update cumulative counts on batch
    batch.rounds_created = (batch.rounds_created || 0) + rounds_created;
    batch.rounds_merged = (batch.rounds_merged || 0) + rounds_merged;
    batch.rounds_skipped = (batch.rounds_skipped || 0) + rounds_skipped;
    batch.cells_inserted = (batch.cells_inserted || 0) + cells_inserted;
    batch.cells_skipped = (batch.cells_skipped || 0) + cells_skipped;
    batches[batchIdx] = batch;
    this.saveImportBatches(batches);

    return {
      rounds_created,
      rounds_merged,
      rounds_skipped,
      cells_inserted,
      cells_skipped
    };
  },

  adminFinishImport({ p_batch }) {
    initDemoStorage();
    const batches = this.getImportBatches();
    const idx = batches.findIndex(b => b.id === p_batch);
    if (idx === -1) throw new Error(`Import batch "${p_batch}" not found.`);
    batches[idx].status = 'completed';
    batches[idx].finished_at = new Date().toISOString();
    this.saveImportBatches(batches);
    return true;
  },

  adminUndoImport({ p_batch, p_reason }, adminId = 'usr-admin-1') {
    initDemoStorage();
    if (!p_batch) throw new Error('Batch ID is required to undo an import.');
    const cleanReason = String(p_reason || '').trim();
    if (!cleanReason) {
      throw new Error('A reason is required to undo an import batch.');
    }

    const batches = this.getImportBatches();
    const idx = batches.findIndex(b => b.id === p_batch);
    if (idx === -1) throw new Error(`Import batch "${p_batch}" not found.`);
    const batch = batches[idx];
    if (batch.status === 'undone' || batch.undone_at) {
      throw new Error('This import batch has already been undone.');
    }

    const allResults = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');

    let results_deleted = 0;
    let results_kept = 0;
    const nextResults = [];

    for (const res of allResults) {
      if (res.import_batch_id === p_batch) {
        // Keep results that were subsequently corrected or verified after an unverified import
        const wasCorrected = Boolean(res.corrected_at || res.corrected_by);
        const wasVerifiedLater = Boolean(!batch.mark_verified && (res.verified_at || res.verified_by));
        if (wasCorrected || wasVerifiedLater) {
          results_kept += 1;
          nextResults.push(res);
        } else {
          results_deleted += 1;
        }
      } else {
        nextResults.push(res);
      }
    }

    const remainingRoundIdsWithResults = new Set(
      nextResults.map(r => r.student_round_id).filter(Boolean)
    );

    let rounds_deleted = 0;
    const nextRounds = [];
    for (const rnd of allRounds) {
      if (rnd.import_batch_id === p_batch && !remainingRoundIdsWithResults.has(rnd.id)) {
        rounds_deleted += 1;
      } else {
        nextRounds.push(rnd);
      }
    }

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(nextResults));
    this.saveStudentRounds(nextRounds);

    batch.status = 'undone';
    batch.undone_at = new Date().toISOString();
    batch.undone_by = adminId;
    batch.undo_reason = cleanReason;
    batch.results_deleted = results_deleted;
    batch.results_kept = results_kept;
    batch.rounds_deleted = rounds_deleted;
    batches[idx] = batch;
    this.saveImportBatches(batches);

    return {
      results_deleted,
      results_kept,
      rounds_deleted
    };
  },

  saveCategorySeries(list) {
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORY_SERIES, JSON.stringify(list));
  },

  toggleCategorySeriesMembership(categoryId, seriesId, shouldBelong) {
    initDemoStorage();
    let list = this.getCategorySeries();
    const existingIdx = list.findIndex(cs => cs.category_id === categoryId && cs.series_id === seriesId);
    if (shouldBelong && existingIdx === -1) {
      const seriesItems = list.filter(cs => cs.series_id === seriesId);
      const maxSort = seriesItems.reduce((m, cs) => Math.max(m, cs.sort_order || 0), 0);
      list.push({
        category_id: categoryId,
        series_id: seriesId,
        sort_order: maxSort + 1
      });
      this.saveCategorySeries(list);
    } else if (!shouldBelong && existingIdx !== -1) {
      list.splice(existingIdx, 1);
      this.saveCategorySeries(list);
    }
    return this.getCategorySeries();
  },

  reorderCategoryInSeries(categoryId, seriesId, direction) {
    initDemoStorage();
    const list = this.getCategorySeries();
    const seriesItems = list
      .filter(cs => cs.series_id === seriesId)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    const idx = seriesItems.findIndex(cs => cs.category_id === categoryId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= seriesItems.length) return;

    const cur = seriesItems[idx];
    const target = seriesItems[targetIdx];
    const tmp = cur.sort_order;
    cur.sort_order = target.sort_order;
    target.sort_order = tmp;
    this.saveCategorySeries(list);
  },

  getStudentRounds(studentId = null, seriesId = null) {
    initDemoStorage();
    let list = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const seriesList = this.getRoundSeries();
    const seriesMap = new Map(seriesList.map(s => [s.id, s]));

    if (studentId) {
      list = list.filter(sr => sr.student_id === studentId);
    }
    if (seriesId && seriesId !== 'all') {
      list = list.filter(sr => sr.series_id === seriesId);
    }

    return list
      .map(sr => {
        const count = results.filter(r => r.student_round_id === sr.id).length;
        const ser = seriesMap.get(sr.series_id) || null;
        return {
          ...sr,
          series: ser,
          scores_count: count
        };
      })
      .sort((a, b) => {
        if (a.series_id !== b.series_id) {
          const ordA = a.series?.sort_order ?? 0;
          const ordB = b.series?.sort_order ?? 0;
          if (ordA !== ordB) return ordB - ordA;
        }
        return (b.round_number || 0) - (a.round_number || 0);
      });
  },

  saveStudentRounds(list) {
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS, JSON.stringify(list));
  },

  async mockStartRound(studentId, roundType = 'Category wise') {
    initDemoStorage();
    const todayIST = await this.mockTodayIST();
    const seriesList = this.getRoundSeries();
    const currentSeries = seriesList.find(s => s.is_current) || seriesList[seriesList.length - 1];
    if (!currentSeries) throw new Error('No current round series configured.');

    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');

    // Reuse today's empty round in the current series if one exists
    const studentCurrentRounds = allRounds.filter(
      sr => sr.student_id === studentId && sr.series_id === currentSeries.id
    );

    const todayEmpty = studentCurrentRounds.find(sr => {
      if (sr.round_date !== todayIST) return false;
      const hasScores = results.some(r => r.student_round_id === sr.id);
      return !hasScores;
    });

    if (todayEmpty) {
      return todayEmpty.id;
    }

    const maxNum = studentCurrentRounds.reduce((m, sr) => Math.max(m, sr.round_number || 0), 0);
    const newRound = {
      id: `sr-${studentId}-new-${maxNum + 1}-${Date.now()}`,
      student_id: studentId,
      series_id: currentSeries.id,
      round_number: maxNum + 1,
      round_date: todayIST,
      round_type: roundType || 'Category wise',
      time_taken_seconds: null,
      created_at: new Date().toISOString()
    };

    allRounds.push(newRound);
    this.saveStudentRounds(allRounds);
    return newRound.id;
  },

  createStudentRoundAdmin({ student_id, series_id, round_number, round_date, round_type, time_taken_seconds }) {
    initDemoStorage();
    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const dup = allRounds.find(
      sr => sr.student_id === student_id && sr.series_id === series_id && Number(sr.round_number) === Number(round_number)
    );
    if (dup) {
      throw new Error(`Round ${round_number} already exists for this student in this series.`);
    }
    const newRound = {
      id: `sr-${student_id}-${Date.now()}`,
      student_id,
      series_id,
      round_number: Number(round_number),
      round_date,
      round_type: (round_type || 'Category wise').trim(),
      time_taken_seconds: time_taken_seconds !== null && time_taken_seconds !== undefined && time_taken_seconds !== '' ? Number(time_taken_seconds) : null,
      created_at: new Date().toISOString()
    };
    allRounds.push(newRound);
    this.saveStudentRounds(allRounds);
    return newRound;
  },

  updateStudentRound(roundId, updates) {
    initDemoStorage();
    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const idx = allRounds.findIndex(sr => sr.id === roundId);
    if (idx === -1) throw new Error('Round not found.');

    allRounds[idx] = {
      ...allRounds[idx],
      ...(updates.round_date !== undefined ? { round_date: updates.round_date } : {}),
      ...(updates.round_type !== undefined ? { round_type: updates.round_type } : {}),
      ...(updates.time_taken_seconds !== undefined ? { time_taken_seconds: updates.time_taken_seconds } : {})
    };
    this.saveStudentRounds(allRounds);
    return allRounds[idx];
  },

  deleteStudentRoundAdmin(roundId) {
    initDemoStorage();
    const allRounds = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    const hasScores = results.some(r => r.student_round_id === roundId);
    if (hasScores) {
      throw new Error('Cannot delete a round that already has recorded scores.');
    }
    const next = allRounds.filter(sr => sr.id !== roundId);
    this.saveStudentRounds(next);
    return true;
  },

  getRoundResults(studentRoundId) {
    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    return results.filter(r => r.student_round_id === studentRoundId);
  },

  saveRoundResults(studentRoundId, updates = [], inserts = []) {
    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    updates.forEach(up => {
      const idx = results.findIndex(r => r.id === up.id);
      if (idx !== -1) {
        results[idx] = { ...results[idx], ...up };
      }
    });
    inserts.forEach(ins => {
      results.push({
        id: `res-demo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...ins,
        student_round_id: studentRoundId,
        entry_date: ins.entry_date || new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString(),
        verified: false,
        verified_by: null,
        verified_at: null,
        corrected_by: null,
        corrected_at: null,
        flagged: false,
        flag_note: null
      });
    });
    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));
    return true;
  },

  // ==================== PHASE 5a: COMPETITION SETTINGS & LEADERBOARDS ====================
  // Fixed static sample data for Demo Mode only. Zero formula/points/rank calculation in JS.

  getCompetitionSettings() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_COMPETITION_SETTINGS) || '[]');
  },

  updateCompetitionSetting(key, value) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    initDemoStorage();
    const validKeys = [
      'weekly_test_multiplier',
      'attendance_present_points',
      'improved_min_entries',
      'leaderboard_names',
      'todo_streak_start',
      'global_leaderboard'
    ];
    if (!validKeys.includes(key)) {
      throw new Error(`Unknown competition setting key "${key}".`);
    }
    const cleanVal = String(value ?? '').trim();
    if (key === 'leaderboard_names') {
      if (cleanVal !== 'first_name_initial' && cleanVal !== 'student_code') {
        throw new Error('Leaderboard display name mode must be "first_name_initial" or "student_code".');
      }
    } else if (key === 'global_leaderboard') {
      if (cleanVal !== 'on' && cleanVal !== 'off') {
        throw new Error('Global leaderboard setting must be "on" or "off".');
      }
    } else if (key === 'todo_streak_start') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanVal)) {
        throw new Error('To-do streak start date must be in YYYY-MM-DD format.');
      }
    } else {
      const num = Number(cleanVal);
      if (!cleanVal || !Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
        throw new Error(`Value for "${key}" must be a whole non-negative number.`);
      }
      if (key === 'improved_min_entries' && num < 1) {
        throw new Error('Minimum entries for Most Improved must be at least 1.');
      }
    }

    const list = this.getCompetitionSettings();
    const idx = list.findIndex(item => item.key === key);
    if (idx !== -1) {
      list[idx].value = cleanVal;
    } else {
      list.push({ key, value: cleanVal });
    }
    localStorage.setItem(DEMO_STORAGE_KEY_COMPETITION_SETTINGS, JSON.stringify(list));
    return { key, value: cleanVal };
  },

  mockCompetitionRules() {
    const list = this.getCompetitionSettings();
    const map = new Map(list.map(i => [i.key, i.value]));
    return {
      weekly_test_multiplier: Number(map.get('weekly_test_multiplier') ?? 2),
      attendance_present_points: Number(map.get('attendance_present_points') ?? 10),
      improved_min_entries: Number(map.get('improved_min_entries') ?? 5),
      leaderboard_names: map.get('leaderboard_names') || 'first_name_initial',
      todo_streak_start: map.get('todo_streak_start') || '2026-10-15',
      global_leaderboard: map.get('global_leaderboard') || 'on'
    };
  },

  mockGlobalLeaderboardEnabled() {
    initDemoStorage();
    const list = this.getCompetitionSettings();
    const map = new Map(list.map(i => [i.key, i.value]));
    return (map.get('global_leaderboard') || 'on') !== 'off';
  },

  mockLeaderboard(
    {
      p_board = 'points',
      p_period = 'week',
      p_level = null,
      p_limit = 10,
      p_scope = 'level',
      p_task_id = null
    } = {},
    callerProfile = null
  ) {
    initDemoStorage();
    const rules = this.mockCompetitionRules();
    const useCode = rules.leaderboard_names === 'student_code';
    const isAdmin = callerProfile?.role === 'admin';
    const callerId = callerProfile?.id || 'usr-101';
    const callerLevel = callerProfile?.level || 'Level 3';
    const scope = p_scope === 'global' ? 'global' : 'level';

    // When the global board is switched off, a student asking for 'global' gets the error "The global leaderboard is switched off."
    if (!isAdmin && scope === 'global' && !this.mockGlobalLeaderboardEnabled()) {
      throw new Error('The global leaderboard is switched off.');
    }

    // Check if any demo student was hidden by admin on /pages/students.html
    const storedStudents = this.getStudents();
    const hiddenSet = new Set(
      storedStudents.filter(s => s.leaderboard_visible === false || s.active === false).map(s => s.id)
    );

    // Fixed static pre-baked entries (never computed from scores or streaks in JS)
    // Display names are strictly pre-formatted as First Name + Initial or Student Code, NEVER full names.
    const STATIC_FIXTURES = {
      points: {
        week: [
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 112 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 96 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 84 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 78 },
          { student_id: 'usr-303', name_initial: 'Devansh M.', code: 'STU303', level: 'Level 3', value: 72 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 94 },
          { student_id: 'usr-108', name_initial: 'Riya S.', code: 'STU108', level: 'Level 2', value: 82 },
          { student_id: 'usr-105', name_initial: 'Rohan M.', code: 'STU105', level: 'Level 2', value: 60 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 104 },
          { student_id: 'usr-110', name_initial: 'Meera R.', code: 'STU110', level: 'Level 4', value: 90 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 120 }
        ],
        month: [
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 380 },
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 364 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 310 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 290 },
          { student_id: 'usr-303', name_initial: 'Devansh M.', code: 'STU303', level: 'Level 3', value: 265 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 342 },
          { student_id: 'usr-108', name_initial: 'Riya S.', code: 'STU108', level: 'Level 2', value: 298 },
          { student_id: 'usr-105', name_initial: 'Rohan M.', code: 'STU105', level: 'Level 2', value: 220 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 392 },
          { student_id: 'usr-110', name_initial: 'Meera R.', code: 'STU110', level: 'Level 4', value: 356 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 440 }
        ],
        all: [
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 1420 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 1380 },
          { student_id: 'usr-303', name_initial: 'Devansh M.', code: 'STU303', level: 'Level 3', value: 1310 },
          { student_id: 'usr-304', name_initial: 'Saanvi G.', code: 'STU304', level: 'Level 3', value: 1290 },
          { student_id: 'usr-305', name_initial: 'Atharv B.', code: 'STU305', level: 'Level 3', value: 1250 },
          { student_id: 'usr-306', name_initial: 'Navya D.', code: 'STU306', level: 'Level 3', value: 1210 },
          { student_id: 'usr-307', name_initial: 'Reyansh T.', code: 'STU307', level: 'Level 3', value: 1180 },
          { student_id: 'usr-308', name_initial: 'Kiara S.', code: 'STU308', level: 'Level 3', value: 1150 },
          { student_id: 'usr-309', name_initial: 'Vihaan L.', code: 'STU309', level: 'Level 3', value: 1120 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 1090 },
          { student_id: 'usr-310', name_initial: 'Prisha N.', code: 'STU310', level: 'Level 3', value: 1040 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 980 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 1190 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 1460 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 1680 }
        ]
      },
      streak: {
        default: [
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 14 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 8 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 6 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 4 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 5 },
          { student_id: 'usr-108', name_initial: 'Riya S.', code: 'STU108', level: 'Level 2', value: 3 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 12 },
          { student_id: 'usr-110', name_initial: 'Meera R.', code: 'STU110', level: 'Level 4', value: 15 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 22 }
        ]
      },
      practice_days: {
        week: [
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 6 },
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 6 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 5 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 4 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 5 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 6 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 7 }
        ],
        month: [
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 24 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 22 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 19 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 16 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 20 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 25 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 28 }
        ],
        all: [
          { student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 92 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 86 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 79 },
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 64 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 74 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 98 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 115 }
        ]
      },
      todo: {
        week: [
          { rank: 1, student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 6 },
          { rank: 2, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 5 },
          { rank: 3, student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 5 },
          { rank: 4, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 4 },
          { rank: 5, student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 4 },
          { rank: 6, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 3 },
          { rank: 7, student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 3 },
          { rank: 8, student_id: 'usr-108', name_initial: 'Riya S.', code: 'STU108', level: 'Level 2', value: 2 }
        ],
        month: [
          { rank: 1, student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 24 },
          { rank: 2, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 21 },
          { rank: 3, student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 20 },
          { rank: 4, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 18 },
          { rank: 5, student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 16 },
          { rank: 6, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 15 }
        ],
        all: [
          { rank: 1, student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 88 },
          { rank: 2, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', value: 76 },
          { rank: 3, student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 74 },
          { rank: 4, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 68 },
          { rank: 5, student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 62 },
          { rank: 6, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 55 }
        ]
      },
      improved: {
        default: [
          { student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', value: 6.4 },
          { student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', value: 4.2 },
          { student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', value: 2.8 },
          { student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', value: 5.1 },
          { student_id: 'usr-108', name_initial: 'Riya S.', code: 'STU108', level: 'Level 2', value: 3.5 },
          { student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', value: 3.9 },
          { student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', value: 2.1 }
        ]
      }
    };

    const boardGroup = STATIC_FIXTURES[p_board] || STATIC_FIXTURES.points;
    let rawPool = [];
    if (p_board === 'streak' || p_board === 'improved') {
      rawPool = boardGroup.default || [];
    } else {
      rawPool = boardGroup[p_period] || boardGroup.week || [];
    }

    // Filter out hidden students and zero values
    let pool = rawPool.filter(item => !hiddenSet.has(item.student_id) && item.value > 0);

    // Level & Scope filtering:
    // - For students: 'level' returns their own level only; 'global' returns all active visible trainees
    // - For admins: p_level null or 'all' means every level; otherwise filter by p_level
    if (!isAdmin) {
      if (scope !== 'global') {
        pool = pool.filter(item => item.level === callerLevel);
      }
    } else if (p_level && p_level !== 'all') {
      pool = pool.filter(item => item.level === p_level);
    }

    const ranked = pool.map((item, idx) => ({
      rank: item.rank ?? idx + 1,
      student_id: isAdmin ? item.student_id : null,
      display_name: useCode ? item.code : item.name_initial,
      value: item.value,
      is_me: !isAdmin && item.student_id === callerId,
      level: item.level
    }));

    if (isAdmin) {
      const cap = Math.min(200, Number(p_limit) || 200);
      return ranked.slice(0, cap);
    }

    // For students: top N (default 10, or 3 on dashboard card) plus their own row if outside top N
    const topLimit = Math.min(10, Number(p_limit) || 10);
    const topRows = ranked.slice(0, topLimit);
    const ownRow = ranked.find(r => r.is_me);
    if (ownRow && !topRows.some(r => r.is_me)) {
      topRows.push(ownRow);
    }
    return topRows;
  },

  mockTodoTaskLeaderboard(
    {
      p_task = null,
      p_period = 'week',
      p_level = null,
      p_limit = 10,
      p_scope = 'level'
    } = {},
    callerProfile = null
  ) {
    initDemoStorage();
    const rules = this.mockCompetitionRules();
    const useCode = rules.leaderboard_names === 'student_code';
    const isAdmin = callerProfile?.role === 'admin';
    const callerId = callerProfile?.id || 'usr-101';
    const callerLevel = callerProfile?.level || 'Level 3';
    const scope = p_scope === 'global' ? 'global' : 'level';

    if (!isAdmin && scope === 'global' && !this.mockGlobalLeaderboardEnabled()) {
      throw new Error('The global leaderboard is switched off.');
    }

    const tasks = this.getTodos();
    const task = tasks.find(t => String(t.id) === String(p_task));
    const sec = task ? String(task.section || '').trim().toLowerCase() : '';
    const isRankable =
      (sec === 'basics' && Boolean(task?.category_id)) ||
      (sec === 'elements' && Boolean(task?.activity_key)) ||
      sec === 'flash';
    if (!task || !isRankable) {
      throw new Error('Speed ranking is available for basics tasks with a category only.');
    }

    const storedStudents = this.getStudents();
    const hiddenSet = new Set(
      storedStudents.filter(s => s.leaderboard_visible === false || s.active === false).map(s => s.id)
    );

    // Pre-baked static rows representing website rounds (source 'site', >=10 questions, >=20 seconds)
    // ranked by correct answers per minute in SQL.
    const TASK_FIXTURES = {
      'todo-5': [
        { rank: 1, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', best_per_minute: 42, correct: 21, attempted: 22, seconds: 30, attempts: 5 },
        { rank: 2, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', best_per_minute: 38, correct: 19, attempted: 20, seconds: 30, attempts: 4 },
        { rank: 3, student_id: 'usr-302', name_initial: 'Tanvi R.', code: 'STU302', level: 'Level 3', best_per_minute: 34, correct: 17, attempted: 18, seconds: 30, attempts: 3 },
        { rank: 4, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', best_per_minute: 32, correct: 16, attempted: 17, seconds: 30, attempts: 2 }
      ],
      'todo-6': [
        { rank: 1, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', best_per_minute: 36, correct: 36, attempted: 38, seconds: 60, attempts: 3 },
        { rank: 2, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', best_per_minute: 34, correct: 34, attempted: 35, seconds: 60, attempts: 4 },
        { rank: 3, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', best_per_minute: 30, correct: 30, attempted: 32, seconds: 60, attempts: 2 }
      ]
    };

    const rawPool = TASK_FIXTURES[p_task] || TASK_FIXTURES['todo-5'] || [];
    let pool = rawPool.filter(item => !hiddenSet.has(item.student_id));

    if (!isAdmin) {
      if (scope !== 'global') {
        pool = pool.filter(item => item.level === callerLevel);
      }
    } else if (p_level && p_level !== 'all') {
      pool = pool.filter(item => item.level === p_level);
    }

    const mapped = pool.map((item, idx) => ({
      rank: idx + 1,
      student_id: isAdmin ? item.student_id : null,
      display_name: useCode ? item.code : item.name_initial,
      level: item.level,
      best_per_minute: item.best_per_minute,
      correct: item.correct,
      attempted: item.attempted,
      seconds: item.seconds,
      attempts: item.attempts,
      is_me: !isAdmin && item.student_id === callerId
    }));

    if (isAdmin) {
      const cap = Math.min(200, Number(p_limit) || 200);
      return mapped.slice(0, cap);
    }

    const topLimit = Math.min(10, Number(p_limit) || 10);
    const topRows = mapped.slice(0, topLimit);
    const ownRow = mapped.find(r => r.is_me);
    if (ownRow && !topRows.some(r => r.is_me)) {
      topRows.push(ownRow);
    }
    return topRows;
  },

  /**
   * Phase 16a Demo Mode: Fixed pre-baked Weekly Test Leaderboard rows.
   * Zero point or rank calculation in JavaScript.
   */
  mockWeeklyTestLeaderboard(
    {
      p_test = null,
      p_period = 'month',
      p_level = null,
      p_limit = 10,
      p_scope = 'level'
    } = {},
    callerProfile = null
  ) {
    initDemoStorage();
    const rules = this.mockCompetitionRules();
    const useCode = rules.leaderboard_names === 'student_code';
    const isAdmin = callerProfile?.role === 'admin';
    const callerId = callerProfile?.id || 'usr-101';
    const callerLevel = callerProfile?.level || 'Level 3';
    const scope = p_scope === 'global' ? 'global' : 'level';

    if (!isAdmin && scope === 'global' && !this.mockGlobalLeaderboardEnabled()) {
      throw new Error('The global leaderboard is switched off.');
    }

    if (p_test && !isAdmin) {
      const myTests = this.mockMyWeeklyTests(callerId);
      const targetTest = myTests.find(t => t.id === p_test);
      if (targetTest && targetTest.type === 'online' && !targetTest.leaderboard_ready) {
        throw new Error('The leaderboard of an online test appears after the test closes.');
      }
    }

    const storedStudents = this.getStudents();
    const hiddenSet = new Set(
      storedStudents.filter(s => s.leaderboard_visible === false || s.active === false).map(s => s.id)
    );

    const WEEKLY_BOARD_FIXTURES = {
      'wkt-1': [
        { rank: 1, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', points: 114, correct: 59, attempted: 61, seconds: 162, tests: 1 },
        { rank: 2, student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', points: 40, correct: 20, attempted: 20, seconds: 78, tests: 1 },
        { rank: 3, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', points: 68, correct: 37, attempted: 40, seconds: 205, tests: 1 },
        { rank: 4, student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', points: 32, correct: 18, attempted: 20, seconds: 115, tests: 1 },
        { rank: 5, student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', points: 28, correct: 17, attempted: 20, seconds: 135, tests: 1 },
        { rank: 6, student_id: 'usr-105', name_initial: 'Rohan M.', code: 'STU105', level: 'Level 2', points: 20, correct: 15, attempted: 20, seconds: 155, tests: 1 }
      ],
      'wkt-online-1': [
        { rank: 1, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', points: 32, correct: 18, attempted: 20, seconds: 30, tests: 1 }
      ],
      default: [
        { rank: 1, student_id: 'usr-101', name_initial: 'Aarav S.', code: 'STU101', level: 'Level 3', points: 150, correct: 78, attempted: 81, seconds: 252, tests: 2 },
        { rank: 2, student_id: 'usr-301', name_initial: 'Ishaan K.', code: 'STU301', level: 'Level 3', points: 144, correct: 75, attempted: 78, seconds: 240, tests: 2 },
        { rank: 3, student_id: 'usr-102', name_initial: 'Diya P.', code: 'STU102', level: 'Level 2', points: 142, correct: 76, attempted: 80, seconds: 398, tests: 2 },
        { rank: 4, student_id: 'usr-107', name_initial: 'Arjun N.', code: 'STU107', level: 'Master', points: 120, correct: 60, attempted: 60, seconds: 210, tests: 2 },
        { rank: 5, student_id: 'usr-106', name_initial: 'Mira J.', code: 'STU106', level: 'Level 3', points: 96, correct: 52, attempted: 56, seconds: 290, tests: 2 },
        { rank: 6, student_id: 'usr-103', name_initial: 'Kabir V.', code: 'STU103', level: 'Level 4', points: 88, correct: 48, attempted: 52, seconds: 310, tests: 2 }
      ]
    };

    const rawPool = (p_test && WEEKLY_BOARD_FIXTURES[p_test]) || WEEKLY_BOARD_FIXTURES.default;
    let pool = rawPool.filter(item => !hiddenSet.has(item.student_id));

    if (!isAdmin) {
      if (scope !== 'global') {
        pool = pool.filter(item => item.level === callerLevel);
      }
    } else if (p_level && p_level !== 'all') {
      pool = pool.filter(item => item.level === p_level);
    }

    const mapped = pool.map((item, idx) => ({
      rank: idx + 1,
      student_id: isAdmin ? item.student_id : null,
      display_name: useCode ? item.code : item.name_initial,
      level: item.level,
      points: item.points,
      correct: item.correct,
      attempted: item.attempted,
      seconds: item.seconds,
      tests: item.tests,
      is_me: !isAdmin && item.student_id === callerId
    }));

    if (isAdmin) {
      const cap = Math.min(200, Number(p_limit) || 200);
      return mapped.slice(0, cap);
    }

    const topLimit = Math.min(10, Number(p_limit) || 10);
    const topRows = mapped.slice(0, topLimit);
    const ownRow = mapped.find(r => r.is_me);
    if (ownRow && !topRows.some(r => r.is_me)) {
      topRows.push(ownRow);
    }
    return topRows;
  },

  // ==================== PHASE 5b: WEEKLY REPORT, MONTHLY REPORT & MILESTONES ====================
  // Fixed static sample data for Demo Mode only. Zero formula/streak/points/accuracy calculation in JS.

  mockWeeklyReportData() {
    initDemoStorage();
    return {
      week_start: '2026-10-12',
      week_end: '2026-10-18',
      generated_on: '2026-10-19',
      summary: {
        active_students: 8,
        students_with_entries: 6,
        accuracy: 92.4
      },
      students: [
        { code: 'STU102', name: 'Diya Patel', level: 'Level 2', practice_days: 5, entries: 18, accuracy: 91.2, qpm: 16.4, streak: 5, points: 94 },
        { code: 'STU105', name: 'Rohan Mehra', level: 'Level 2', practice_days: 0, entries: 0, accuracy: null, qpm: null, streak: 0, points: 60 },
        { code: 'STU108', name: 'Riya Sen', level: 'Level 2', practice_days: 4, entries: 12, accuracy: 89.5, qpm: 15.1, streak: 3, points: 82 },
        { code: 'STU101', name: 'Aarav Sharma', level: 'Level 3', practice_days: 6, entries: 26, accuracy: 94.6, qpm: 19.8, streak: 25, points: 96 },
        { code: 'STU106', name: 'Mira Joshi', level: 'Level 3', practice_days: 4, entries: 15, accuracy: 90.8, qpm: 17.2, streak: 4, points: 84 },
        { code: 'STU103', name: 'Kabir Verma', level: 'Level 4', practice_days: 6, entries: 24, accuracy: 93.5, qpm: 21.0, streak: 50, points: 104 },
        { code: 'STU110', name: 'Meera Rao', level: 'Level 4', practice_days: 0, entries: 0, accuracy: null, qpm: null, streak: 0, points: 90 },
        { code: 'STU107', name: 'Arjun Nair', level: 'Master', practice_days: 7, entries: 32, accuracy: 96.8, qpm: 24.5, streak: 100, points: 120 }
      ],
      needs_attention: [
        { code: 'STU105', name: 'Rohan Mehra', level: 'Level 2', last_entry: '2026-10-12', days_ago: 7 },
        { code: 'STU110', name: 'Meera Rao', level: 'Level 4', last_entry: null, days_ago: null }
      ],
      milestones: [
        { code: 'STU107', name: 'Arjun Nair', level: 'Master', milestone: 100, streak: 100 },
        { code: 'STU103', name: 'Kabir Verma', level: 'Level 4', milestone: 50, streak: 50 },
        { code: 'STU101', name: 'Aarav Sharma', level: 'Level 3', milestone: 25, streak: 25 }
      ],
      sessions: [
        { date: '2026-10-18', title: 'Sunday Competition Prep & Finals Workshop', type: 'workshop', present: 7, absent: 1, excused: 1 },
        { date: '2026-10-16', title: 'Friday Speed Drills & Flash Mental Class', type: 'class', present: 8, absent: 1, excused: 0 },
        { date: '2026-10-14', title: 'Wednesday Prime Factors & HCF-LCM Masterclass', type: 'class', present: 7, absent: 1, excused: 1 }
      ],
      weekly_tests: [
        { date: '2026-10-18', title: 'Weekly Assessment #14 (Speed Basics)', scores: 7 }
      ],
      backup: {
        last_google_at: '2026-10-18T20:30:12.000Z',
        last_export_at: '2026-10-17T14:15:00.000Z',
        days_since_backup: 1
      }
    };
  },

  mockAdminMilestones(p_days = 7) {
    initDemoStorage();
    const days = Number(p_days) || 7;
    if (days <= 0) return [];
    return [
      {
        student_id: 'usr-107',
        student_code: 'STU107',
        full_name: 'Arjun Nair',
        level: 'Master',
        current_streak: 100,
        milestone: 100
      },
      {
        student_id: 'usr-103',
        student_code: 'STU103',
        full_name: 'Kabir Verma',
        level: 'Level 4',
        current_streak: 52,
        milestone: 50
      },
      {
        student_id: 'usr-101',
        student_code: 'STU101',
        full_name: 'Aarav Sharma',
        level: 'Level 3',
        current_streak: 25,
        milestone: 25
      }
    ];
  },

  getReportLogs() {
    initDemoStorage();
    const list = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_REPORT_LOG) || '[]');
    return list.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  },

  addReportLog(entry = {}) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    initDemoStorage();
    const list = this.getReportLogs();
    const nowIso = new Date().toISOString();
    const newRow = {
      id: `rlog-${Date.now()}`,
      week_start: entry.week_start || '2026-10-12',
      kind: entry.kind || 'manual',
      status: entry.status || 'sent',
      error: entry.error || null,
      to_email: entry.to_email || 'coach@trendzabacus.com',
      created_by: entry.created_by || 'usr-admin-1',
      created_at: nowIso,
      finished_at: nowIso
    };
    list.unshift(newRow);
    localStorage.setItem(DEMO_STORAGE_KEY_REPORT_LOG, JSON.stringify(list));
    return newRow;
  },

  mockStudentMonthReport(studentId = 'usr-101', pMonth = null) {
    initDemoStorage();
    const students = this.getStudents();
    const stu = students.find(s => s.id === studentId || s.student_code === studentId) || {
      id: 'usr-101',
      student_code: 'STU101',
      full_name: 'Aarav Sharma',
      level: 'Level 3'
    };

    const monthPrefix =
      typeof pMonth === 'string' && /^\d{4}-\d{2}/.test(pMonth.trim())
        ? pMonth.trim().slice(0, 7)
        : '2026-10';

    if (monthPrefix === '2026-09') {
      return {
        student: {
          name: stu.full_name,
          code: stu.student_code,
          level: stu.level || 'Level 3'
        },
        month_start: '2026-09-01',
        month_end: '2026-09-30',
        days_elapsed: 30,
        practice: {
          entries: 84,
          correct: 1512,
          total: 1680,
          accuracy: 90.0,
          qpm: 17.6,
          rounds: 3,
          practice_days: 19
        },
        previous: {
          entries: 72,
          accuracy: 88.2,
          qpm: 16.4,
          practice_days: 16
        },
        streak: {
          current: 8,
          best: 14
        },
        attendance: {
          present: 7,
          absent: 1,
          excused: 0,
          percent: 87.5
        },
        points: 310,
        weeks: [
          { week_start: '2026-08-31', entries: 18, accuracy: 88.5 },
          { week_start: '2026-09-07', entries: 22, accuracy: 89.8 },
          { week_start: '2026-09-14', entries: 20, accuracy: 90.4 },
          { week_start: '2026-09-21', entries: 24, accuracy: 91.2 }
        ],
        categories: [
          { name: 'Cube root', section: 'round', entries: 3, accuracy: 82.0, wrong: 9 },
          { name: 'Square Root', section: 'round', entries: 3, accuracy: 85.3, wrong: 11 },
          { name: 'FRAC ÷', section: 'round', entries: 3, accuracy: 88.0, wrong: 6 },
          { name: '2d2r', section: 'basics', entries: 8, accuracy: 91.5, wrong: 14 },
          { name: '1d4r', section: 'basics', entries: 10, accuracy: 94.0, wrong: 12 },
          { name: 'ADD', section: 'round', entries: 3, accuracy: 96.7, wrong: 3 }
        ],
        targets: {
          measured: 18,
          met: 14
        },
        weekly_tests: [
          { title: 'Weekly Assessment #11 (Speed Basics)', date: '2026-09-27', category: '1d4r', correct: 19, total: 20, time_seconds: 94 },
          { title: 'Weekly Assessment #10 (Opening Baseline)', date: '2026-09-20', category: '1d4r', correct: 17, total: 20, time_seconds: 115 }
        ]
      };
    }

    // Default: October 2026 (Current Month Static Sample)
    return {
      student: {
        name: stu.full_name,
        code: stu.student_code,
        level: stu.level || 'Level 3'
      },
      month_start: `${monthPrefix}-01`,
      month_end: `${monthPrefix}-31`,
      days_elapsed: 19,
      practice: {
        entries: 96,
        correct: 1810,
        total: 1920,
        accuracy: 94.3,
        qpm: 19.4,
        rounds: 4,
        practice_days: 15
      },
      previous: {
        entries: 84,
        accuracy: 90.0,
        qpm: 17.6,
        practice_days: 19
      },
      streak: {
        current: 8,
        best: 14
      },
      attendance: {
        present: 6,
        absent: 1,
        excused: 1,
        percent: 85.7
      },
      points: 380,
      weeks: [
        { week_start: '2026-09-28', entries: 18, accuracy: 92.1 },
        { week_start: '2026-10-05', entries: 38, accuracy: 94.2 },
        { week_start: '2026-10-12', entries: 40, accuracy: 95.4 }
      ],
      categories: [
        { name: 'Cube root', section: 'round', entries: 4, accuracy: 85.0, wrong: 12 },
        { name: 'Approximation', section: 'round', entries: 4, accuracy: 87.5, wrong: 10 },
        { name: 'Square Root', section: 'round', entries: 4, accuracy: 89.0, wrong: 9 },
        { name: 'HCF and LCM', section: 'round', entries: 4, accuracy: 92.5, wrong: 6 },
        { name: '2d2r', section: 'basics', entries: 6, accuracy: 94.0, wrong: 7 },
        { name: '1d4r', section: 'basics', entries: 8, accuracy: 96.5, wrong: 6 },
        { name: 'MULT', section: 'round', entries: 4, accuracy: 97.5, wrong: 2 },
        { name: 'ADD', section: 'round', entries: 4, accuracy: 98.8, wrong: 1 }
      ],
      targets: {
        measured: 14,
        met: 12
      },
      weekly_tests: [
        { title: 'Weekly Assessment #14 (Speed Basics)', date: '2026-10-18', category: '1d4r', correct: 20, total: 20, time_seconds: 85 },
        { title: 'Weekly Assessment #13 (Round Core)', date: '2026-10-11', category: '1d4r', correct: 19, total: 20, time_seconds: 90 },
        { title: 'Weekly Assessment #12 (Mixed Drills)', date: '2026-10-04', category: '1d4r', correct: 18, total: 20, time_seconds: 102 }
      ]
    };
  },

  // ==================== PHASE 5c: BACKUP & EXPORT DEMO FIXTURES ====================
  getBackupTableRows(tableName) {
    initDemoStorage();
    switch (tableName) {
      case 'profiles':
        return this.getStudents();
      case 'round_series':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ROUND_SERIES) || '[]');
      case 'categories':
        return this.getCategories();
      case 'category_series':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_SERIES) || '[]');
      case 'basics_thresholds':
        return this.getBasicsThresholds();
      case 'daily_tasks':
        return this.getTodos();
      case 'resources':
        return this.getResources();
      case 'competition_settings':
        return this.getCompetitionSettings();
      case 'category_aliases':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORY_ALIASES) || '[]');
      case 'attendance_sessions':
        return this.getSessions();
      case 'weekly_tests':
        return this.getWeeklyTests();
      case 'import_batches':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_IMPORT_BATCHES) || '[]');
      case 'student_rounds':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENT_ROUNDS) || '[]');
      case 'results':
        return this.getResults();
      case 'weekly_test_scores':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_WEEKLY_SCORES) || '[]');
      case 'attendance':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_ATTENDANCE) || '[]');
      case 'activity_results':
        return this.getActivityResults();
      case 'result_audit':
        return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUDIT) || '[]');
      default:
        return [];
    }
  },

  // ==================== PHASE 7: FLASH ANZAN DEMO RPC FIXTURES ====================
  getActivityResults(studentId = null, activityType = null) {
    initDemoStorage();
    const key = 'trendz_demo_activity_results_v1';
    let list = JSON.parse(localStorage.getItem(key) || 'null');
    const nowIso = new Date().toISOString();
    const yestIso = new Date(Date.now() - 86400000).toISOString();
    const twoDaysIso = new Date(Date.now() - 2 * 86400000).toISOString();
    if (!Array.isArray(list)) {
      list = [
        {
          id: 'act-demo-1',
          student_id: 'usr-101',
          activity_type: 'flash_anzan',
          activity_name: 'Flash Anzan',
          correct: 1,
          total: 1,
          time_seconds: 12,
          settings: { digits: 2, count: 10, speed_ms: 1000, mode: 'add' },
          created_at: nowIso,
          updated_at: nowIso
        },
        {
          id: 'act-demo-2',
          student_id: 'usr-101',
          activity_type: 'flash_anzan',
          activity_name: 'Flash Anzan',
          correct: 9,
          total: 10,
          time_seconds: 112,
          settings: { digits: 2, count: 10, speed_ms: 1000, questions: 10, mode: 'add' },
          created_at: yestIso,
          updated_at: yestIso
        },
        {
          id: 'act-demo-elem-1',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Day Codes',
          correct: 54,
          total: 56,
          time_seconds: 48,
          settings: { drill: 'day_codes', questions: 56, time_limit_seconds: 60, attempted: 56 },
          created_at: nowIso,
          updated_at: nowIso
        },
        {
          id: 'act-demo-elem-stage-1',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Square - Stage 1 (1-25)',
          correct: 25,
          total: 25,
          time_seconds: 42,
          settings: { drill: 'squares_stage_1', questions: 25, time_limit_seconds: 60, attempted: 25 },
          created_at: yestIso,
          updated_at: yestIso
        },
        {
          id: 'act-demo-elem-2',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Square (11-50)',
          correct: 49,
          total: 50,
          time_seconds: 95,
          settings: { drill: 'squares_11_50', questions: 50, time_limit_seconds: 120, attempted: 50 },
          created_at: twoDaysIso,
          updated_at: twoDaysIso
        }
      ];
      localStorage.setItem(key, JSON.stringify(list));
    } else if (!list.some(r => r && r.activity_type === 'element')) {
      list.push(
        {
          id: 'act-demo-elem-1',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Day Codes',
          correct: 54,
          total: 56,
          time_seconds: 48,
          settings: { drill: 'day_codes', questions: 56, time_limit_seconds: 60, attempted: 56 },
          created_at: nowIso,
          updated_at: nowIso
        },
        {
          id: 'act-demo-elem-stage-1',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Square - Stage 1 (1-25)',
          correct: 25,
          total: 25,
          time_seconds: 42,
          settings: { drill: 'squares_stage_1', questions: 25, time_limit_seconds: 60, attempted: 25 },
          created_at: yestIso,
          updated_at: yestIso
        },
        {
          id: 'act-demo-elem-2',
          student_id: 'usr-101',
          activity_type: 'element',
          activity_name: 'Square (11-50)',
          correct: 49,
          total: 50,
          time_seconds: 95,
          settings: { drill: 'squares_11_50', questions: 50, time_limit_seconds: 120, attempted: 50 },
          created_at: twoDaysIso,
          updated_at: twoDaysIso
        }
      );
      localStorage.setItem(key, JSON.stringify(list));
    }

    if (!list.some(r => r && r.activity_type === 'memoriad')) {
      list.push(
        {
          id: 'act-demo-mem-cal-1',
          student_id: 'usr-101',
          activity_type: 'memoriad',
          activity_name: 'Mental Calendar Dates',
          correct: 23,
          total: 25,
          time_seconds: 34,
          settings: {
            module: 'calendar',
            questions: 25,
            dates: 25,
            attempted: 25,
            correct: 23,
            score: 23,
            used_seconds: 34.18,
            concentration_seconds: 5,
          },
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          id: 'act-demo-mem-add-1',
          student_id: 'usr-101',
          activity_type: 'memoriad',
          activity_name: 'Mental Additions',
          correct: 9,
          total: 10,
          time_seconds: 128,
          settings: {
            module: 'additions',
            questions: 10,
            attempted: 10,
            correct: 9,
            score: 9,
            used_seconds: 128.45,
            concentration_seconds: 5,
          },
          created_at: yestIso,
          updated_at: yestIso,
        },
        {
          id: 'act-demo-mem-mul-1',
          student_id: 'usr-101',
          activity_type: 'memoriad',
          activity_name: 'Mental Multiplications',
          correct: 8,
          total: 10,
          time_seconds: 312,
          settings: {
            module: 'multiplications',
            questions: 10,
            attempted: 10,
            correct: 8,
            wrong: 2,
            score: 8,
            used_seconds: 312.4,
            concentration_seconds: 5,
          },
          created_at: yestIso,
          updated_at: yestIso,
        },
        {
          id: 'act-demo-mem-sqrt-1',
          student_id: 'usr-101',
          activity_type: 'memoriad',
          activity_name: 'Mental Square Roots',
          correct: 6,
          total: 9,
          time_seconds: 420,
          settings: {
            module: 'square_roots',
            questions: 10,
            attempted: 9,
            correct: 6,
            wrong: 3,
            score: 267,
            digits_total: 62,
            used_seconds: 420.15,
            concentration_seconds: 5,
          },
          created_at: twoDaysIso,
          updated_at: twoDaysIso,
        }
      );
      localStorage.setItem(key, JSON.stringify(list));
    }

    return list.filter(r => {
      if (studentId && r.student_id !== studentId) return false;
      if (activityType && r.activity_type !== activityType) return false;
      return true;
    });
  },

  /**
   * Phase 7b Demo Mode: Fixed sample Flash Anzan try (does NOT re-implement number generation or checking).
   */
  mockFlashStart(p_settings = {}, studentId = 'usr-101') {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const cleanSettings = {
      digits: Number(p_settings?.digits) || 2,
      count: Number(p_settings?.count) || 5,
      speed_ms: Number(p_settings?.speed_ms) || 1000,
      mode: p_settings?.mode === 'add_sub' ? 'add_sub' : 'add',
    };
    const fixedSampleNumbers =
      cleanSettings.mode === 'add_sub'
        ? [24, 15, -12, 31, -8]
        : [12, 25, 18, 14, 21];

    return {
      session_id: 'demo-flash-session-fixed',
      numbers: fixedSampleNumbers,
      settings: cleanSettings,
    };
  },

  /**
   * Phase 7b Demo Mode: Fixed fake Flash Anzan submission result (does NOT calculate sums or correctness).
   */
  mockFlashSubmit(p_session, p_answer = null, studentId = 'usr-101') {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const givenVal =
      p_answer === null || p_answer === undefined || p_answer === ''
        ? null
        : Number(p_answer);

    // Fixed fake result in Demo Mode
    const fixedResult = {
      correct: true,
      expected: 90,
      given: givenVal !== null && Number.isFinite(givenVal) ? givenVal : 90,
      seconds: 6,
    };

    const actKey = 'trendz_demo_activity_results_v1';
    const currentList = this.getActivityResults();
    const nowIso = new Date().toISOString();
    currentList.unshift({
      id: `act-demo-flash-${Date.now()}`,
      student_id: studentId || 'usr-101',
      activity_type: 'flash_anzan',
      activity_name: 'Flash Anzan',
      correct: 1,
      total: 1,
      time_seconds: fixedResult.seconds,
      settings: { digits: 2, count: 5, speed_ms: 1000, mode: 'add' },
      created_at: nowIso,
      updated_at: nowIso,
    });
    localStorage.setItem(actKey, JSON.stringify(currentList));

    return fixedResult;
  },

  getBackupStatus() {
    initDemoStorage();
    const runsKey = 'trendz_demo_backup_runs_v1';
    let runs = JSON.parse(localStorage.getItem(runsKey) || 'null');
    if (!Array.isArray(runs)) {
      runs = [
        {
          id: 'brun-demo-1',
          kind: 'cron',
          status: 'done',
          started_at: '2026-10-18T20:30:01.000Z',
          finished_at: '2026-10-18T20:30:06.000Z',
          rows_written: 186,
          tables: { profiles: { mode: 'snapshot', rows: 5 }, results: { mode: 'append', rows_appended: 42 } },
          error: null,
          created_by: null
        },
        {
          id: 'brun-demo-2',
          kind: 'export',
          status: 'done',
          started_at: '2026-10-17T14:15:00.000Z',
          finished_at: '2026-10-17T14:15:02.000Z',
          rows_written: 144,
          tables: { profiles: 5, results: 98 },
          error: null,
          created_by: 'usr-admin-1'
        }
      ];
      localStorage.setItem(runsKey, JSON.stringify(runs));
    }

    const tableNames = [
      { name: 'profiles', mode: 'snapshot' },
      { name: 'round_series', mode: 'snapshot' },
      { name: 'categories', mode: 'snapshot' },
      { name: 'category_series', mode: 'snapshot' },
      { name: 'basics_thresholds', mode: 'snapshot' },
      { name: 'daily_tasks', mode: 'snapshot' },
      { name: 'resources', mode: 'snapshot' },
      { name: 'competition_settings', mode: 'snapshot' },
      { name: 'category_aliases', mode: 'snapshot' },
      { name: 'attendance_sessions', mode: 'snapshot' },
      { name: 'weekly_tests', mode: 'snapshot' },
      { name: 'import_batches', mode: 'snapshot' },
      { name: 'student_rounds', mode: 'append', cursor_column: 'updated_at' },
      { name: 'results', mode: 'append', cursor_column: 'updated_at' },
      { name: 'weekly_test_scores', mode: 'append', cursor_column: 'updated_at' },
      { name: 'attendance', mode: 'append', cursor_column: 'updated_at' },
      { name: 'activity_results', mode: 'append', cursor_column: 'updated_at' },
      { name: 'result_audit', mode: 'append', cursor_column: 'changed_at' }
    ];

    let totalCells = 0;
    const tables = tableNames.map(t => {
      const rows = this.getBackupTableRows(t.name);
      const colCount = rows.length > 0 ? Object.keys(rows[0]).length : 5;
      const cells = (rows.length + 1) * colCount;
      totalCells += cells;
      return {
        table_name: t.name,
        mode: t.mode,
        cursor_column: t.cursor_column || null,
        cursor_value: t.mode === 'append' ? '2026-10-18T20:29:00.000000+00:00' : null,
        cursor_id: null,
        rows_waiting: 0,
        rows_written: rows.length,
        cells_written: cells,
        last_run_at: '2026-10-18T20:30:06.000Z',
        last_error: null
      };
    });

    const lastGoogle = runs.find(r => (r.kind === 'cron' || r.kind === 'manual') && r.status === 'done');
    const lastExport = runs.find(r => r.kind === 'export' && r.status === 'done');

    return {
      ok: true,
      configured: false,
      sheetUrl: null,
      lastSuccessAt: lastGoogle?.finished_at || null,
      lastExportAt: lastExport?.finished_at || null,
      totalCellsWritten: totalCells,
      cellLimit: 10000000,
      cellWarnRatio: 0.7,
      tables,
      runs: runs.slice(0, 10),
      mirror: {
        configured: false,
        sheetUrl: null,
        total: 4,
        upToDate: 4,
        rebuilt: 0,
        remaining: 0,
        lastBuiltAt: lastGoogle?.finished_at || '2026-10-18T20:30:06.000Z',
        lastError: null,
        errors: []
      }
    };
  },

  logBackupExport(p_rows = 0, p_tables = {}) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const status = this.getBackupStatus();
    const runsKey = 'trendz_demo_backup_runs_v1';
    const nowIso = new Date().toISOString();
    const newRun = {
      id: `brun-exp-${Date.now()}`,
      kind: 'export',
      status: 'done',
      started_at: nowIso,
      finished_at: nowIso,
      rows_written: Number(p_rows) || 0,
      tables: p_tables || {},
      error: null,
      created_by: 'usr-admin-1'
    };
    const updated = [newRun, ...(status.runs || [])].slice(0, 20);
    localStorage.setItem(runsKey, JSON.stringify(updated));
    return newRun;
  },

  // ==================== PHASE 8: ELEMENTS DRILLS DEMO FIXTURES ====================
  // Fixed sample questions and fixed fake result (never re-implements generation or checking).
  mockElementDrillStart(drillKey = 'day_codes', drillMeta = null) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const title = drillMeta?.title || 'Day Codes (Demo Sample)';
    const timeLimitSeconds = Number(drillMeta?.time_limit_seconds) || 60;
    const hint =
      drillMeta?.hint ||
      'Demo sample set (5 fixed questions). Live server generates and grades full sets.';

    return {
      session_id: `demo-elem-session-${Date.now()}`,
      drill: drillKey,
      title,
      questions: ['Sunday', 'Saturday', 'February (02)', '47', '97 / 4'],
      time_limit_seconds: timeLimitSeconds,
      hint,
    };
  },

  mockElementDrillSubmit(sessionId, answers = [], studentId = 'usr-101', drillMeta = null) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const drillKey = drillMeta?.key || 'day_codes';
    const title = drillMeta?.title || 'Day Codes';
    const timeLimitSeconds = Number(drillMeta?.time_limit_seconds) || 60;

    // Fixed fake result per specification (no client-side grading or generation)
    const fixedResult = {
      correct: 4,
      attempted: 5,
      questions_total: 5,
      accuracy: 80.0,
      seconds: 18,
      detail: [
        { question: 'Sunday', expected_display: '1', given: answers[0] ?? '1', correct: true },
        { question: 'Saturday', expected_display: '0', given: answers[1] ?? '0', correct: true },
        { question: 'February (02)', expected_display: '4', given: answers[2] ?? '4', correct: true },
        { question: '47', expected_display: '2209', given: answers[3] ?? '2209', correct: true },
        { question: '97 / 4', expected_display: '24', given: answers[4] ?? '23', correct: false },
      ],
    };

    const actKey = 'trendz_demo_activity_results_v1';
    const currentList = this.getActivityResults();
    const nowIso = new Date().toISOString();
    currentList.unshift({
      id: `act-elem-${Date.now()}`,
      student_id: studentId || 'usr-101',
      activity_type: 'element',
      activity_name: title,
      correct: fixedResult.correct,
      total: fixedResult.attempted,
      time_seconds: fixedResult.seconds,
      settings: {
        drill: drillKey,
        questions: fixedResult.questions_total,
        time_limit_seconds: timeLimitSeconds,
        attempted: fixedResult.attempted,
        session_id: sessionId || 'demo-session',
      },
      created_at: nowIso,
      updated_at: nowIso,
    });
    localStorage.setItem(actKey, JSON.stringify(currentList));

    return fixedResult;
  },

  // ==================== PHASE 9A: ONLINE BASICS PRACTICE DEMO FIXTURES ====================
  // Fixed demo practice set and fixed result (no generation or checking in the browser).
  mockBasicsDrillStart(categoryId = 'cat-bas-1', mode = 'timed', seconds = 60) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const cats = this.getCategories();
    const cat = cats.find((c) => c.id === categoryId) || { id: categoryId, name: '1d4r' };
    const nameLower = String(cat.name || '').toLowerCase();

    // Fixed sample display questions (no expected answers returned)
    let questions = [
      { type: 'add_sub', rows: [4, 7, -3, 8], text: '+4 +7 -3 +8' },
      { type: 'add_sub', rows: [9, -5, 6, 2], text: '+9 -5 +6 +2' },
      { type: 'add_sub', rows: [6, 8, -4, 5], text: '+6 +8 -4 +5' },
      { type: 'add_sub', rows: [7, -2, 9, -6], text: '+7 -2 +9 -6' },
      { type: 'add_sub', rows: [5, 4, 8, -7], text: '+5 +4 +8 -7' },
    ];

    if (nameLower.includes('x') || nameLower.includes('*') || nameLower.includes('×')) {
      questions = [
        { type: 'mul', a: 47, b: 8, text: '47 x 8' },
        { type: 'mul', a: 36, b: 7, text: '36 x 7' },
        { type: 'mul', a: 64, b: 6, text: '64 x 6' },
        { type: 'mul', a: 29, b: 9, text: '29 x 9' },
        { type: 'mul', a: 83, b: 4, text: '83 x 4' },
      ];
    } else if (nameLower.includes('/') || nameLower.includes('÷')) {
      questions = [
        { type: 'div', dividend: 84, divisor: 7, text: '84 / 7' },
        { type: 'div', dividend: 144, divisor: 6, text: '144 / 6' },
        { type: 'div', dividend: 216, divisor: 8, text: '216 / 8' },
        { type: 'div', dividend: 315, divisor: 9, text: '315 / 9' },
        { type: 'div', dividend: 196, divisor: 4, text: '196 / 4' },
      ];
    }

    const poolMap = { 30: 50, 60: 100, 120: 200, 300: 500 };
    const normMode = mode === 'unlimited' ? 'unlimited' : 'timed';
    const normSeconds = normMode === 'timed' ? (Number(seconds) || 60) : null;
    const pool = normMode === 'unlimited' ? 1000 : (poolMap[normSeconds] || 100);

    return {
      session_id: `demo-basics-session-${Date.now()}`,
      title: cat.name,
      questions,
      mode: normMode,
      seconds: normSeconds,
      pool,
      target: { min_accuracy: 90, min_questions_per_minute: 40 },
    };
  },

  mockBasicsDrillSubmit(
    sessionId,
    answers = [],
    studentId = 'usr-101',
    categoryId = 'cat-bas-1',
    mode = 'timed'
  ) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }

    const resultId = `res-bas-site-${Date.now()}`;
    const fixedDetail = [
      {
        question: '+4 +7 -3 +8',
        expected_display: '16',
        given: answers[0] ?? '16',
        correct: true,
      },
      {
        question: '+9 -5 +6 +2',
        expected_display: '12',
        given: answers[1] ?? '12',
        correct: true,
      },
      {
        question: '+6 +8 -4 +5',
        expected_display: '15',
        given: answers[2] ?? '15',
        correct: true,
      },
      {
        question: '+7 -2 +9 -6',
        expected_display: '8',
        given: answers[3] ?? '8',
        correct: true,
      },
      {
        question: '+5 +4 +8 -7',
        expected_display: '10',
        given: answers[4] ?? '9',
        correct: false,
      },
    ];

    const nowIso = new Date().toISOString();
    const todayIstStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const practiceMode = mode === 'unlimited' ? 'unlimited' : 'timed';

    initDemoStorage();
    const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
    results.unshift({
      id: resultId,
      student_id: studentId || 'usr-101',
      student_round_id: null,
      category_id: categoryId || 'cat-bas-1',
      correct: 4,
      total: 5,
      time_seconds: 30,
      note: null,
      entry_date: todayIstStr,
      created_at: nowIso,
      updated_at: nowIso,
      source: 'site',
      practice_mode: practiceMode,
      verified: true,
      verified_by: null,
      verified_at: null,
      corrected_by: null,
      corrected_at: null,
      flagged: false,
      flag_note: null,
      meets_target: true,
    });
    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));

    return {
      correct: 4,
      attempted: 5,
      accuracy: 80.0,
      used_seconds: 30,
      correct_per_minute: 8.0,
      attempted_per_minute: 10.0,
      detail: fixedDetail,
      result_id: resultId,
    };
  },

  // ==================== PHASE 9b-1: MEMORIAD COMPETITION DEMO FIXTURES ====================
  // Fixed pre-baked sets and fixed fake evaluation (never generates or calculates scores in browser).
  mockMemoriadStart(moduleKey = 'calendar', settings = {}) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const allowedMods = ['calendar', 'additions', 'multiplications', 'square_roots'];
    const mod = allowedMods.includes(moduleKey) ? moduleKey : 'calendar';
    const conc = Number.isInteger(Number(settings?.concentration_seconds))
      ? Number(settings.concentration_seconds)
      : 5;

    if (mod === 'calendar') {
      const fixedDates25 = [
        [2000, 1, 1], [1969, 7, 20], [1600, 1, 1], [1947, 8, 15], [1950, 1, 26],
        [1776, 7, 4], [1857, 5, 10], [1989, 11, 9], [2024, 2, 29], [2099, 12, 31],
        [1642, 12, 25], [1789, 7, 14], [1815, 6, 18], [1869, 10, 2], [1905, 6, 30],
        [1918, 11, 11], [1945, 5, 8], [1953, 5, 29], [1961, 4, 12], [1971, 12, 16],
        [1983, 6, 25], [1991, 12, 26], [2008, 8, 8], [2011, 4, 2], [2026, 10, 20],
      ];
      return {
        session_id: 'demo-memoriad-cal-session',
        module: 'calendar',
        title: 'Mental Calendar Dates',
        questions: fixedDates25,
        time_limit_seconds: 60,
        settings: {
          dates: 25,
          concentration_seconds: conc,
        },
      };
    }

    if (mod === 'multiplications') {
      const fixedMultiplications10 = [
        ['39951857', '81044514'],
        ['48291034', '62718392'],
        ['71502948', '53829104'],
        ['29481756', '91827364'],
        ['64738291', '38475629'],
        ['85940312', '47281935'],
        ['51928374', '73645281'],
        ['92837465', '26374859'],
        ['37485961', '84930217'],
        ['76543219', '59483726'],
      ];
      return {
        session_id: 'demo-memoriad-mul-session',
        module: 'multiplications',
        title: 'Mental Multiplications',
        questions: fixedMultiplications10,
        time_limit_seconds: 900,
        settings: {
          concentration_seconds: conc,
        },
      };
    }

    if (mod === 'square_roots') {
      const fixedSquareRoots10 = [
        258524, 850772, 115456, 457832, 453077,
        198432, 624518, 731905, 884210, 319482,
      ];
      return {
        session_id: 'demo-memoriad-sqrt-session',
        module: 'square_roots',
        title: 'Mental Square Roots',
        questions: fixedSquareRoots10,
        time_limit_seconds: 900,
        settings: {
          concentration_seconds: conc,
        },
      };
    }

    const fixedAdditions10 = Array.from({ length: 10 }, (_, idx) => [
      `123456789${idx}`,
      `234567890${idx}`,
      `345678901${idx}`,
      `456789012${idx}`,
      `567890123${idx}`,
      `678901234${idx}`,
      `789012345${idx}`,
      `890123456${idx}`,
      `901234567${idx}`,
      `112345678${idx}`,
    ]);

    return {
      session_id: 'demo-memoriad-add-session',
      module: 'additions',
      title: 'Mental Additions',
      questions: fixedAdditions10,
      time_limit_seconds: 600,
      settings: {
        concentration_seconds: conc,
      },
    };
  },

  mockMemoriadSubmit(
    sessionId,
    moduleKey = 'calendar',
    answers = [],
    studentId = 'usr-101',
    settings = {},
    finishedBy = 'finish'
  ) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
    const allowedMods = ['calendar', 'additions', 'multiplications', 'square_roots'];
    const mod = allowedMods.includes(moduleKey) ? moduleKey : 'calendar';
    const rawAnswers = Array.isArray(answers) ? answers : [];
    const nonNullCount = rawAnswers.filter(
      (a) => a !== null && a !== undefined && String(a).replace(/_/g, '').trim() !== ''
    ).length;
    const normFinishedBy = finishedBy === 'time_up' ? 'time_up' : 'finish';

    const titleMap = {
      calendar: 'Mental Calendar Dates',
      additions: 'Mental Additions',
      multiplications: 'Mental Multiplications',
      square_roots: 'Mental Square Roots',
    };
    const title = titleMap[mod] || 'Mental Calendar Dates';

    if (nonNullCount === 0) {
      return {
        module: mod,
        title,
        questions_total: mod === 'calendar' ? 25 : 10,
        attempted: 0,
        correct: 0,
        wrong: 0,
        score: 0,
        ...(mod === 'square_roots' ? { digits_total: 0 } : {}),
        used_seconds: 12.5,
        finished_by: normFinishedBy,
        saved: false,
        result_id: null,
        message: 'No questions were attempted, so no score was saved.',
        detail: [],
      };
    }

    const fixedAttempted = mod === 'calendar' ? 25 : 10;
    const fixedCorrect = mod === 'calendar' ? 24 : mod === 'square_roots' ? 8 : 9;
    const fixedWrong = fixedAttempted - fixedCorrect;
    const fixedScore = mod === 'square_roots' ? 312 : fixedCorrect;
    const fixedDigitsTotal = mod === 'square_roots' ? 72 : undefined;
    const fixedUsedSeconds =
      mod === 'calendar'
        ? 31.42
        : mod === 'additions'
          ? 118.65
          : mod === 'multiplications'
            ? 245.8
            : 310.25;

    const actKey = 'trendz_demo_activity_results_v1';
    const currentList = this.getActivityResults();
    const nowIso = new Date().toISOString();
    const newId = `act-demo-mem-${Date.now()}`;

    const rowSettings = {
      module: mod,
      questions: fixedAttempted,
      attempted: fixedAttempted,
      correct: fixedCorrect,
      wrong: fixedWrong,
      score: fixedScore,
      used_seconds: fixedUsedSeconds,
      concentration_seconds: Number(settings?.concentration_seconds) || 5,
      finished_by: normFinishedBy,
      ...(mod === 'calendar' ? { dates: 25 } : {}),
      ...(mod === 'square_roots' ? { digits_total: fixedDigitsTotal } : {}),
    };

    const newActivityRow = {
      id: newId,
      student_id: studentId || 'usr-101',
      activity_type: 'memoriad',
      activity_name: title,
      correct: fixedCorrect,
      total: fixedAttempted,
      time_seconds: Math.round(fixedUsedSeconds),
      settings: rowSettings,
      created_at: nowIso,
      updated_at: nowIso,
    };

    currentList.unshift(newActivityRow);
    localStorage.setItem(actKey, JSON.stringify(currentList));

    const detail = Array.from({ length: fixedAttempted }, (_, idx) => {
      if (mod === 'calendar') {
        return {
          index: idx + 1,
          question_summary: `2000-01-${String((idx % 28) + 1).padStart(2, '0')}`,
          expected: 5,
          expected_display: 'Saturday',
          given: idx === 0 ? 4 : 5,
          given_display: idx === 0 ? 'Friday' : 'Saturday',
          attempted: true,
          correct: idx !== 0,
        };
      }
      if (mod === 'multiplications') {
        return {
          index: idx + 1,
          question_summary: idx === 0 ? '39951857 × 81044514' : `Factor Pair ${idx + 1} (8d × 8d)`,
          expected: '3237878833962498',
          expected_display: '3237878833962498',
          given: idx === 0 ? '3237878833962400' : '3237878833962498',
          given_display: idx === 0 ? '3237878833962400' : '3237878833962498',
          attempted: true,
          correct: idx !== 0,
        };
      }
      if (mod === 'square_roots') {
        const isPartial = idx < 2;
        return {
          index: idx + 1,
          question_summary: idx === 0 ? '√258524' : `√${100000 + idx * 75123}`,
          expected: '508.45255',
          expected_display: '508.45255',
          given: isPartial ? '508.4__' : '508.45255',
          given_display: isPartial ? '508.4' : '508.45255',
          attempted: true,
          correct: !isPartial,
          correct_digits: isPartial ? 4 : 8,
          points: isPartial ? 10 : 36,
        };
      }
      return {
        index: idx + 1,
        question_summary: `Question ${idx + 1} (10 × 10d)`,
        expected: '51000000000',
        expected_display: '51000000000',
        given: idx === 0 ? '50000000000' : '51000000000',
        given_display: idx === 0 ? '50000000000' : '51000000000',
        attempted: true,
        correct: idx !== 0,
      };
    });

    return {
      module: mod,
      title,
      questions_total: fixedAttempted,
      attempted: fixedAttempted,
      correct: fixedCorrect,
      wrong: fixedWrong,
      score: fixedScore,
      ...(mod === 'square_roots' ? { digits_total: fixedDigitsTotal } : {}),
      used_seconds: fixedUsedSeconds,
      finished_by: normFinishedBy,
      saved: true,
      result_id: newId,
      activity_row: newActivityRow,
      message: 'Saved to your scores.',
      detail,
    };
  },

  // --- PHASE 13B: ANNOUNCEMENTS & NOTIFICATIONS ---
  getAnnouncements() {
    const db = loadDB();
    if (!Array.isArray(db.announcements)) {
      const nowMs = Date.now();
      db.announcements = [
        {
          id: 'ann-demo-1',
          title: 'Sunday Practice Workshop at 10:00 AM',
          body: 'Please bring your soroban and speed calculation sheets for a 60-minute revision session before the weekly test.',
          audience_level: null,
          starts_at: new Date(nowMs - 2 * 3600 * 1000).toISOString(),
          expires_at: new Date(nowMs + 5 * 86400 * 1000).toISOString(),
          created_by: 'usr-admin-1',
          created_at: new Date(nowMs - 2 * 3600 * 1000).toISOString(),
        },
        {
          id: 'ann-demo-2',
          title: 'Level 3 Speed Challenge Tips Posted',
          body: 'Check the Resources tab for the new 2-digit 2-row rhythm guide.',
          audience_level: 'Level 3',
          starts_at: new Date(nowMs - 24 * 3600 * 1000).toISOString(),
          expires_at: new Date(nowMs + 10 * 86400 * 1000).toISOString(),
          created_by: 'usr-admin-1',
          created_at: new Date(nowMs - 24 * 3600 * 1000).toISOString(),
        },
      ];
      saveDB(db);
    }
    return [...db.announcements].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
  },

  insertAnnouncement(payload) {
    const db = loadDB();
    const list = this.getAnnouncements();
    const nowIso = new Date().toISOString();
    const row = {
      id: 'ann-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      title: String(payload.title || '').trim(),
      body: String(payload.body || '').trim(),
      audience_level: payload.audience_level || null,
      starts_at: payload.starts_at || nowIso,
      expires_at: payload.expires_at || null,
      created_by: payload.created_by || 'usr-admin-1',
      created_at: nowIso,
    };
    db.announcements = [row, ...list];
    saveDB(db);
    return row;
  },

  deleteAnnouncement(id) {
    const db = loadDB();
    const list = this.getAnnouncements();
    db.announcements = list.filter((a) => a.id !== id);
    saveDB(db);
    return true;
  },

  mockMyNotifications(studentId = 'usr-101') {
    const db = loadDB();
    const dismissedMap = db.dismissed_notifications || {};
    const studentDismissed = Array.isArray(dismissedMap[studentId]) ? dismissedMap[studentId] : [];
    const profile = (db.profiles || []).find((p) => p.id === studentId) || { level: 'Level 3' };
    const studentLevel = profile.level || null;

    const todayStr = this.getTodayIST();
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const todayUtcMs = Date.UTC(ty, tm - 1, td);

    const items = [];

    // 1. Weekly test reminders (derived live from weekly_tests)
    const tests = Array.isArray(db.weekly_tests) ? db.weekly_tests : [];
    const attempts = Array.isArray(db.weekly_test_attempts) ? db.weekly_test_attempts : [];
    const sections = Array.isArray(db.weekly_test_sections) ? db.weekly_test_sections : [];

    for (const t of tests) {
      if (t.audience_level && t.audience_level !== studentLevel) continue;
      if (!t.test_date || !/^\d{4}-\d{2}-\d{2}$/.test(t.test_date)) continue;
      const [y, m, d] = t.test_date.split('-').map(Number);
      const testUtcMs = Date.UTC(y, m - 1, d);
      const daysLeft = Math.round((testUtcMs - todayUtcMs) / 86400000);
      const remindDays = t.remind_days_before !== undefined && t.remind_days_before !== null ? Number(t.remind_days_before) : 7;

      if (daysLeft < 0 || daysLeft > remindDays) continue;

      const isOnline = t.test_type === 'online';
      if (daysLeft === 0 && isOnline) {
        const testSecs = sections.filter((s) => s.test_id === t.id);
        if (testSecs.length > 0) {
          const doneCount = testSecs.filter((s) =>
            attempts.some(
              (a) =>
                a.test_id === t.id &&
                a.student_id === studentId &&
                a.category_id === s.category_id &&
                a.status === 'submitted'
            )
          ).length;
          if (doneCount >= testSecs.length) continue;
        }
      }

      const stage = daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : 'upcoming';
      const ref = `test:${t.id}:${stage}`;
      if (studentDismissed.includes(ref)) continue;

      const kind = daysLeft === 0 ? 'test_today' : 'test_upcoming';
      const typeLabel = isOnline
        ? 'Online test on Trendz Tracker.'
        : 'Offline test with your trainer.';
      const bodyParts = [typeLabel];
      if (t.notes) bodyParts.push(String(t.notes).trim());

      items.push({
        ref,
        kind,
        title: t.title || 'Weekly Test',
        body: bodyParts.join(' '),
        link: '/pages/weekly-test.html',
        event_date: t.test_date,
        days_left: daysLeft,
        created_at: t.created_at || new Date().toISOString(),
      });
    }

    // 2. Active announcements matching audience
    const anns = this.getAnnouncements();
    const nowMs = Date.now();
    for (const a of anns) {
      if (a.audience_level && a.audience_level !== studentLevel) continue;
      const startMs = a.starts_at ? Date.parse(a.starts_at) : 0;
      const expMs = a.expires_at ? Date.parse(a.expires_at) : null;
      if (Number.isFinite(startMs) && startMs > nowMs) continue;
      if (expMs !== null && Number.isFinite(expMs) && expMs <= nowMs) continue;

      const ref = `ann:${a.id}`;
      if (studentDismissed.includes(ref)) continue;

      items.push({
        ref,
        kind: 'announcement',
        title: a.title,
        body: a.body,
        link: '/pages/student.html',
        event_date: a.starts_at ? a.starts_at.slice(0, 10) : todayStr,
        days_left: null,
        created_at: a.created_at || new Date().toISOString(),
      });
    }

    // 3. Private messages from trainer
    const msgs = Array.isArray(db.student_messages) ? db.student_messages : [];
    for (const m of msgs) {
      if (m.student_id !== studentId) continue;
      const ref = `msg:${m.id}`;
      if (studentDismissed.includes(ref) || m.dismissed_at) continue;

      items.unshift({
        ref,
        id: m.id,
        kind: 'private_message',
        title: m.title,
        body: m.body,
        link: m.link || '/pages/student.html',
        event_date: m.created_at ? m.created_at.slice(0, 10) : todayStr,
        days_left: 0,
        created_at: m.created_at || new Date().toISOString(),
        needs_attention: Boolean(m.needs_attention),
        attention_reason: m.attention_reason || null,
        read_at: m.read_at || null,
      });
    }

    return items;
  },

  mockDismissNotification(arg1 = 'usr-101', arg2 = '') {
    let studentId = arg1;
    let ref = arg2;
    if (typeof arg1 === 'string' && (arg1.startsWith('msg:') || arg1.startsWith('ann:') || arg1.startsWith('test:'))) {
      ref = arg1;
      studentId = 'usr-101';
    }
    if (!ref) return false;
    const db = loadDB();
    if (!db.dismissed_notifications) db.dismissed_notifications = {};
    const current = Array.isArray(db.dismissed_notifications[studentId])
      ? db.dismissed_notifications[studentId]
      : [];
    if (!current.includes(ref)) {
      current.push(ref);
    }
    db.dismissed_notifications[studentId] = current;

    if (ref.startsWith('msg:')) {
      const msgId = ref.slice(4);
      const msgs = Array.isArray(db.student_messages) ? db.student_messages : [];
      const msg = msgs.find((m) => m.id === msgId && (!studentId || m.student_id === studentId));
      if (msg) {
        msg.dismissed_at = new Date().toISOString();
      }
    }

    saveDB(db);
    return true;
  },

  getStudentMessages(studentId) {
    const db = loadDB();
    const msgs = Array.isArray(db.student_messages) ? db.student_messages : [];
    if (!studentId) return msgs.filter((m) => !m.dismissed_at);
    return msgs.filter((m) => m.student_id === studentId && !m.dismissed_at);
  },

  markStudentMessageRead(arg1, arg2) {
    const messageId = arg2 || arg1;
    const studentId = arg2 ? arg1 : null;
    const db = loadDB();
    const msgs = Array.isArray(db.student_messages) ? db.student_messages : [];
    const msg = msgs.find((m) => m.id === messageId && (!studentId || m.student_id === studentId));
    if (msg) {
      msg.read_at = msg.read_at || new Date().toISOString();
      saveDB(db);
      return true;
    }
    return false;
  },

  sendStudentMessage({
    studentId,
    title,
    body,
    needsAttention = false,
    attentionReason = null,
    linkedType = null,
    linkedId = null,
    senderId = 'admin-demo-uuid',
    clientNonce = null,
  }) {
    const db = loadDB();
    if (!db.student_messages) db.student_messages = [];

    // Check student existence
    const student = (db.profiles || []).find((p) => p.id === studentId);
    if (!student || student.role !== 'student' || student.active === false) {
      throw new Error('Recipient student not found or deactivated');
    }

    const cleanTitle = String(title || '').trim();
    const cleanBody = String(body || '').trim();
    const cleanReason = attentionReason ? String(attentionReason).trim() : null;
    if (!cleanTitle || cleanTitle.length > 120) {
      throw new Error('Title must be between 1 and 120 characters');
    }
    if (!cleanBody || cleanBody.length > 2000) {
      throw new Error('Body must be between 1 and 2000 characters');
    }

    // Idempotency & nonce reuse protection
    if (clientNonce) {
      const existing = db.student_messages.find(
        (m) => m.sender_id === senderId && m.client_nonce === clientNonce
      );
      if (existing) {
        if (
          existing.student_id !== studentId ||
          existing.title !== cleanTitle ||
          existing.body !== cleanBody ||
          Boolean(existing.needs_attention) !== Boolean(needsAttention) ||
          (existing.attention_reason || null) !== (cleanReason || null) ||
          (existing.linked_type || null) !== (linkedType || null) ||
          (existing.linked_id || null) !== (linkedId || null)
        ) {
          throw new Error('Nonce reuse detected: client_nonce has already been used with different parameters');
        }
        return existing;
      }
    }

    let link = '/pages/student.html';

    // Linked record validation
    if (linkedType === 'score') {
      if (!linkedId) throw new Error('Missing linked score ID');
      const results = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
      const score = results.find((r) => r.id === linkedId);
      if (!score) throw new Error('Linked score not found');
      if (score.student_id !== studentId) {
        throw new Error('Linked score does not belong to the recipient student');
      }

      const categories = this.getCategories();
      const cat = categories.find((c) => c.id === score.category_id);
      if (cat && cat.section === 'round') {
        if (score.student_round_id) {
          link = `/pages/round-scores.html?roundId=${score.student_round_id}&resultId=${score.id}`;
        } else {
          link = `/pages/round-scores.html?resultId=${score.id}`;
        }
      } else {
        link = `/pages/basics.html?resultId=${score.id}`;
      }

      if (needsAttention) {
        score.flagged = true;
        score.flag_note = cleanReason || cleanTitle;
        localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(results));
      }
    } else if (linkedType === 'attempt') {
      if (!linkedId) throw new Error('Missing linked attempt ID');
      const attempts = Array.isArray(db.weekly_test_attempts) ? db.weekly_test_attempts : [];
      const att = attempts.find((a) => a.id === linkedId);
      if (!att) throw new Error('Linked weekly test attempt not found');
      if (att.student_id !== studentId) {
        throw new Error('Linked attempt does not belong to the recipient student');
      }
      link = `/pages/weekly-test.html?testId=${att.test_id}&attemptId=${att.id}`;
    } else if (linkedType === 'weekly_test') {
      if (!linkedId) throw new Error('Missing linked weekly test ID');
      const tests = Array.isArray(db.weekly_tests) ? db.weekly_tests : [];
      const test = tests.find((t) => t.id === linkedId);
      if (!test) throw new Error('Linked weekly test not found');
      if (test.audience_level && (!student.level || test.audience_level !== student.level)) {
        throw new Error('Weekly test is not assigned to recipient student level');
      }
      link = `/pages/weekly-test.html?testId=${test.id}`;
    }

    const newMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      student_id: studentId,
      sender_id: senderId,
      title: cleanTitle,
      body: cleanBody,
      needs_attention: Boolean(needsAttention),
      attention_reason: attentionReason ? String(attentionReason).trim() : null,
      linked_type: linkedType || null,
      linked_id: linkedId || null,
      link,
      client_nonce: clientNonce || null,
      read_at: null,
      dismissed_at: null,
      created_at: new Date().toISOString(),
    };

    db.student_messages.push(newMsg);
    saveDB(db);
    return newMsg;
  },
};

