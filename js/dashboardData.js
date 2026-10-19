/**
 * Trendz Tracker - Shared Dashboard Data Loader (js/dashboardData.js)
 * 
 * Provides unified, authoritative data fetching for student dashboards:
 * - Database RPCs: today_ist(), streak_for(p_student), todo_for(p_student)
 * - Categories and Resources tables
 * - 90-day Results for the target student
 * 
 * Used identically by:
 * - /pages/student.html (student self-view)
 * - /pages/student-detail.html?id=... (teacher read-only view)
 */

import { getSupabase, DemoDB } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { getISTDateString } from './stats.js';

/**
 * Loads all dashboard data in parallel for a given student ID.
 * 
 * @param {string} studentId - The UUID or ID of the student
 * @returns {Promise<{
 *   studentId: string,
 *   todayIST: string,
 *   streak: object,
 *   todos: Array<object>,
 *   categories: Array<object>,
 *   resources: Array<object>,
 *   results: Array<object>
 * }>}
 */
export async function fetchStudentDashboardData(studentId) {
  if (!studentId) {
    throw new Error('studentId is required for fetchStudentDashboardData');
  }

  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  // 90 days ago cutoff in IST
  const d90 = new Date(Date.now() - 90 * 86400000);
  const ninetyDaysAgo = getISTDateString(d90);

  const [
    todayRes,
    streakRes,
    todoRes,
    categoriesRes,
    roundSeriesRes,
    categorySeriesRes,
    studentRoundsRes,
    resourcesRes,
    resultsRes,
    attendanceRes,
    weeklyTestsRes,
    activityResultsRes
  ] = await Promise.all([
    // 1. Authoritative today in IST via RPC
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase.rpc('today_ist');
          if (!error && data) return String(data).trim();
        } catch {
          // fall through
        }
      }
      return getISTDateString(new Date());
    })(),

    // 2. Authoritative streak & shield status via RPC
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase.rpc('streak_for', { p_student: studentId });
          if (!error && data) {
            return Array.isArray(data) ? data[0] : data;
          }
        } catch {
          // fall through
        }
      }
      return await DemoDB.mockStreakFor(studentId);
    })(),

    // 3. Authoritative to-do status via RPC
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase.rpc('todo_for', { p_student: studentId });
          if (!error && data) {
            return Array.isArray(data) ? data : [data];
          }
        } catch {
          // fall through
        }
      }
      return await DemoDB.mockTodoFor(studentId);
    })(),

    // 4. Categories table (all categories including inactive historical ones so Old simulator rounds display properly)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('categories')
            .select('*')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return DemoDB.getCategories();
    })(),

    // 4b. Round Series table
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('round_series')
            .select('*')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return DemoDB.getRoundSeries();
    })(),

    // 4c. Category Series mapping table
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('category_series')
            .select('*')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return DemoDB.getCategorySeries();
    })(),

    // 4d. Student Rounds table for this student
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('student_rounds')
            .select('*')
            .eq('student_id', studentId)
            .order('round_number', { ascending: false });
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      const matchedRounds = DemoDB.getStudentRounds(studentId);
      return matchedRounds.length > 0 ? matchedRounds : DemoDB.getStudentRounds('usr-101');
    })(),

    // 5. Resources table (active, ordered by sort_order)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('resources')
            .select('*')
            .eq('active', true)
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return DemoDB.getResources().filter(r => r.active !== false);
    })(),

    // 6. Results (from results_with_target view for this student)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('results_with_target')
            .select('*')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false });
          if (!error && data) return data;

          const { data: fallbackData, error: fallbackErr } = await supabase
            .from('results')
            .select('*')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false });
          if (!fallbackErr && fallbackData) return fallbackData;
        } catch {
          // fall through
        }
      }
      // DemoDB results with target status: match studentId or fallback to sample usr-101 results
      const matched = DemoDB.getResultsWithTarget(studentId, null);
      return matched.length > 0 ? matched : DemoDB.getResultsWithTarget('usr-101', null);
    })(),

    // 7. Authoritative Attendance summary via RPC attendance_summary(p_student, p_from, p_to)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase.rpc('attendance_summary', {
            p_student: studentId,
            p_from: ninetyDaysAgo,
            p_to: getISTDateString(new Date())
          });
          if (!error && data) {
            return Array.isArray(data) ? data[0] : data;
          }
        } catch {
          // fall through
        }
      }
      return DemoDB.mockAttendanceSummary(studentId);
    })(),

    // 8. Weekly Tests & Student's Weekly Test Scores (Phase 4b)
    (async () => {
      if (supabase) {
        try {
          const [testsQuery, scoresQuery] = await Promise.all([
            supabase
              .from('weekly_tests')
              .select('*')
              .order('test_date', { ascending: false }),
            supabase
              .from('weekly_test_scores')
              .select('*')
              .eq('student_id', studentId)
          ]);
          if (!testsQuery.error && !scoresQuery.error) {
            return {
              tests: testsQuery.data || [],
              scores: scoresQuery.data || []
            };
          }
        } catch {
          // fall through
        }
      }
      const demoTests = DemoDB.getWeeklyTests();
      const testIds = demoTests.map(t => t.id);
      let demoScores = DemoDB.getStudentWeeklyTestScores(studentId, testIds);
      if (demoScores.length === 0 && studentId !== 'usr-104') {
        demoScores = DemoDB.getStudentWeeklyTestScores('usr-102', testIds);
      }
      return {
        tests: demoTests,
        scores: demoScores
      };
    })(),

    // 9. Flash Anzan Activity Results (Phase 7, read-only from activity_results)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('activity_results')
            .select('id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
            .eq('student_id', studentId)
            .eq('activity_type', 'flash_anzan')
            .order('created_at', { ascending: false })
            .limit(30);
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return DemoDB.getActivityResults(studentId, 'flash_anzan');
    })()
  ]);

  return {
    studentId,
    todayIST: todayRes || getISTDateString(new Date()),
    streak: streakRes || { current_streak: 0, best_streak: 0, shields: 0, active_today: false },
    todos: todoRes || [],
    categories: categoriesRes || [],
    roundSeries: roundSeriesRes || [],
    categorySeries: categorySeriesRes || [],
    studentRounds: studentRoundsRes || [],
    resources: resourcesRes || [],
    results: resultsRes || [],
    attendance: attendanceRes || { present_count: 0, absent_count: 0, excused_count: 0, attendance_pct: null },
    weeklyTests: weeklyTestsRes || { tests: [], scores: [] },
    activityResults: activityResultsRes || []
  };
}

/**
 * Resolves a student's profile information by ID.
 * Returns null if not found or if the role is not 'student'.
 */
export async function resolveStudentProfile(studentId) {
  if (!studentId) return null;

  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', studentId)
          .eq('role', 'student')
          .single();
        if (!error && data) return data;
      }
    } catch {
      // fall through
    }
  }

  // DemoDB fallback
  const demoStudents = DemoDB.getStudents();
  return demoStudents.find(s => s.id === studentId && (s.role === 'student' || !s.role)) || null;
}
