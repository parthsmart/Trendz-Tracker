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
const RESULTS_COLUMNS =
  'id, student_id, student_round_id, category_id, correct, total, time_seconds, entry_date, created_at, source, practice_mode, verified, flagged, min_accuracy, min_questions_per_minute, max_time_seconds, meets_target';

/**
 * Lazily loads the Score Sheet & Resources data (`round_series`, `category_series`, `student_rounds`, `resources`,
 * and full results if needed) when the "Score Sheet & Progress" tab is opened on Student Home.
 *
 * @param {string} studentId
 * @returns {Promise<{
 *   roundSeries: Array<object>,
 *   categorySeries: Array<object>,
 *   studentRounds: Array<object>,
 *   resources: Array<object>,
 *   allResults: Array<object> | null
 * }>}
 */
export async function fetchStudentScoreSheetData(studentId) {
  const supabase = isSupabaseConfigured() ? await getSupabase() : null;

  const [roundSeries, categorySeries, studentRounds, resources, allResults] = await Promise.all([
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('round_series')
            .select('id, name, sort_order, is_current')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      return DemoDB.getRoundSeries();
    })(),
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('category_series')
            .select('series_id, category_id, sort_order')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      return DemoDB.getCategorySeries();
    })(),
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('student_rounds')
            .select('id, student_id, series_id, round_number, entry_date, created_at')
            .eq('student_id', studentId)
            .order('round_number', { ascending: false })
            .limit(200);
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      const matchedRounds = DemoDB.getStudentRounds(studentId);
      return matchedRounds.length > 0 ? matchedRounds : DemoDB.getStudentRounds('usr-101');
    })(),
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('resources')
            .select('id, title, url, topic, description, sort_order, active')
            .eq('active', true)
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      return DemoDB.getResources().filter((r) => r.active !== false);
    })(),
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('results_with_target')
            .select(RESULTS_COLUMNS)
            .eq('student_id', studentId)
            .order('created_at', { ascending: false })
            .limit(500);
          if (!error && data) return data;
        } catch {
          // fall through
        }
      }
      return null;
    })(),
  ]);

  return {
    roundSeries: roundSeries || [],
    categorySeries: categorySeries || [],
    studentRounds: studentRounds || [],
    resources: resources || [],
    allResults: allResults || null,
  };
}

/**
 * Loads dashboard data in parallel for a given student ID.
 * When `includeScoreSheet` is false (default on Student Home initial "Today's Focus" tab),
 * defers Score Sheet & Resources queries until the user opens the "Score Sheet & Progress" tab,
 * and bounds `results_with_target` to the last 90 days.
 *
 * @param {string} studentId - The UUID or ID of the student
 * @param {{ includeScoreSheet?: boolean }} [options]
 */
export async function fetchStudentDashboardData(studentId, { includeScoreSheet = true } = {}) {
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
    scoreSheetBundle,
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
        return { current_streak: 0, best_streak: 0, shields: 0, active_today: false };
      }
      return await DemoDB.mockStreakFor(studentId);
    })(),

    // 3. Authoritative to-do status via RPC + one query on daily_tasks for Flash Anzan settings
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase.rpc('todo_for', { p_student: studentId });
          if (!error && data) {
            const rows = Array.isArray(data) ? data : [data];
            const taskIds = Array.from(
              new Set(rows.map((r) => r && (r.task_id || r.id)).filter(Boolean))
            );
            if (taskIds.length > 0) {
              try {
                const { data: taskRows, error: taskErr } = await supabase
                  .from('daily_tasks')
                  .select('id, flash_digits, flash_count, flash_speed_ms, flash_mode')
                  .in('id', taskIds);
                if (!taskErr && Array.isArray(taskRows)) {
                  const taskMap = new Map(taskRows.map((tr) => [String(tr.id), tr]));
                  return rows.map((r) => {
                    const tid = String(r.task_id || r.id || '');
                    const extra = taskMap.get(tid);
                    return extra
                      ? {
                          ...r,
                          flash_digits: extra.flash_digits ?? null,
                          flash_count: extra.flash_count ?? null,
                          flash_speed_ms: extra.flash_speed_ms ?? null,
                          flash_mode: extra.flash_mode ?? null,
                        }
                      : r;
                  });
                }
              } catch {
                // Return todo_for rows even if daily_tasks enrichment fails
              }
            }
            return rows;
          }
        } catch {
          // fall through
        }
        return [];
      }
      const demoRows = await DemoDB.mockTodoFor(studentId);
      const demoTasks = DemoDB.getTodos ? DemoDB.getTodos() : [];
      const demoMap = new Map(demoTasks.map((tr) => [String(tr.id), tr]));
      return (Array.isArray(demoRows) ? demoRows : []).map((r) => {
        const tid = String(r.task_id || r.id || '');
        const extra = demoMap.get(tid);
        return extra
          ? {
              ...r,
              flash_digits: extra.flash_digits ?? r.flash_digits ?? null,
              flash_count: extra.flash_count ?? r.flash_count ?? null,
              flash_speed_ms: extra.flash_speed_ms ?? r.flash_speed_ms ?? null,
              flash_mode: extra.flash_mode ?? r.flash_mode ?? null,
            }
          : r;
      });
    })(),

    // 4. Categories table (needed columns only)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('categories')
            .select('id, name, section, sort_order, active')
            .order('sort_order', { ascending: true });
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      return DemoDB.getCategories();
    })(),

    // 4b-5. Score Sheet & Resources bundle (deferred when includeScoreSheet === false)
    (async () => {
      if (!includeScoreSheet) {
        return {
          roundSeries: [],
          categorySeries: [],
          studentRounds: [],
          resources: [],
        };
      }
      return await fetchStudentScoreSheetData(studentId);
    })(),

    // 6. Bounded 90-day Results (from results_with_target view with explicit columns)
    (async () => {
      if (supabase) {
        try {
          let query = supabase
            .from('results_with_target')
            .select(RESULTS_COLUMNS)
            .eq('student_id', studentId)
            .order('created_at', { ascending: false });

          if (!includeScoreSheet) {
            query = query.gte('entry_date', ninetyDaysAgo).limit(300);
          } else {
            query = query.limit(500);
          }

          const { data, error } = await query;
          if (!error && data) return data;

          const { data: fallbackData, error: fallbackErr } = await supabase
            .from('results')
            .select('id, student_id, student_round_id, category_id, correct, total, time_seconds, entry_date, created_at, source, practice_mode, verified, flagged')
            .eq('student_id', studentId)
            .gte('entry_date', ninetyDaysAgo)
            .order('created_at', { ascending: false })
            .limit(300);
          if (!fallbackErr && fallbackData) return fallbackData;
        } catch {
          // fall through
        }
        return [];
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
        return { present_count: 0, absent_count: 0, excused_count: 0, attendance_pct: null };
      }
      return DemoDB.mockAttendanceSummary(studentId);
    })(),

    // 8. Weekly Tests & Student's Weekly Test Scores (bounded & explicit columns)
    (async () => {
      if (supabase) {
        try {
          const [testsQuery, scoresQuery] = await Promise.all([
            supabase
              .from('weekly_tests')
              .select('id, title, test_date, test_type, audience_level')
              .order('test_date', { ascending: false })
              .limit(20),
            supabase
              .from('weekly_test_scores')
              .select('id, test_id, student_id, category_id, correct, total, time_seconds')
              .eq('student_id', studentId)
              .limit(100)
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
        return { tests: [], scores: [] };
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

    // 9. Activity Results (Flash Anzan, Elements, Memoriad — bounded to 100 recent rows)
    (async () => {
      if (supabase) {
        try {
          const { data, error } = await supabase
            .from('activity_results')
            .select('id, student_id, activity_type, activity_name, correct, total, time_seconds, settings, created_at')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false })
            .limit(100);
          if (!error && data) return data;
        } catch {
          // fall through
        }
        return [];
      }
      return DemoDB.getActivityResults(studentId);
    })()
  ]);

  return {
    studentId,
    todayIST: todayRes || getISTDateString(new Date()),
    streak: streakRes || { current_streak: 0, best_streak: 0, shields: 0, active_today: false },
    todos: todoRes || [],
    categories: categoriesRes || [],
    roundSeries: scoreSheetBundle?.roundSeries || [],
    categorySeries: scoreSheetBundle?.categorySeries || [],
    studentRounds: scoreSheetBundle?.studentRounds || [],
    resources: scoreSheetBundle?.resources || [],
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
          .select('id, student_code, full_name, role, level, active, leaderboard_visible, created_at')
          .eq('id', studentId)
          .eq('role', 'student')
          .single();
        if (!error && data) return data;
      }
    } catch {
      // fall through
    }
    return null;
  }

  // DemoDB fallback
  const demoStudents = DemoDB.getStudents();
  return demoStudents.find(s => s.id === studentId && (s.role === 'student' || !s.role)) || null;
}
