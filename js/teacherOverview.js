/**
 * Trendz Tracker — Teacher Overview Controller (js/teacherOverview.js)
 *
 * Scoped strictly to assigned students for the logged-in teacher (or all for admin preview).
 * Fetches and displays:
 * 1. Assigned students who have not practiced today
 * 2. Students needing attention (flagged results / attention messages)
 * 3. Scores pending review (unverified entries from last 7 days)
 * 4. Upcoming weekly tests
 */

import { requireAuth } from './guard.js';
import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';
import { DemoDB } from './demoDb.js';

let currentProfile = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Returns current date formatted in IST (YYYY-MM-DD).
 */
export function getTodayIst() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Loads teacher overview data from RPC or database queries.
 */
export async function loadTeacherOverviewData(supabase, profile) {
  const todayIst = getTodayIst();

  if (!isSupabaseConfigured()) {
    // Demo Mode simulation
    const students = DemoDB.getStudents ? DemoDB.getStudents() : [];
    const activeStudents = students.filter((s) => s.active !== false);
    return {
      assigned_count: activeStudents.length,
      not_practiced_today: activeStudents.slice(0, 5).map((s) => ({
        id: s.id,
        student_code: s.student_code,
        full_name: s.full_name,
        level: s.level,
      })),
      needs_attention: [
        {
          entry_date: todayIst,
          student_name: 'Diya Patel',
          student_code: 'STU102',
          flag_note: 'Unusually high speed flagged for review',
        },
      ],
      pending_review: [
        {
          entry_date: todayIst,
          student_name: 'Aarav Sharma',
          student_code: 'STU101',
          correct: 19,
          total: 20,
        },
        {
          entry_date: todayIst,
          student_name: 'Kabir Verma',
          student_code: 'STU103',
          correct: 18,
          total: 20,
        },
      ],
      upcoming_tests: [
        {
          id: 'demo-test-1',
          title: 'Week 1 — Speed Drill Challenge',
          test_date: todayIst,
          test_type: 'online',
        },
      ],
    };
  }

  // 1. Try teacher_get_overview RPC
  try {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('teacher_get_overview');
    if (!rpcErr && rpcData) {
      return rpcData;
    }
  } catch (err) {
    console.warn('teacher_get_overview RPC call skipped or failed, using query fallback:', err);
  }

  // 2. Query fallback
  let assignedIds = [];

  if (profile.role === 'admin') {
    const { data: allStudents } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'student')
      .eq('active', true);
    assignedIds = (allStudents || []).map((s) => s.id);
  } else {
    const { data: assignments } = await supabase
      .from('teacher_student_assignments')
      .select('student_id')
      .eq('teacher_id', profile.id);
    assignedIds = (assignments || []).map((a) => a.student_id);
  }

  if (assignedIds.length === 0) {
    return {
      assigned_count: 0,
      not_practiced_today: [],
      needs_attention: [],
      pending_review: [],
      upcoming_tests: [],
    };
  }

  const [studentsRes, todayResultsRes, flaggedRes, pendingRes, testsRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, student_code, full_name, level')
      .in('id', assignedIds)
      .eq('active', true)
      .order('full_name', { ascending: true }),

    supabase
      .from('results')
      .select('student_id')
      .in('student_id', assignedIds)
      .eq('entry_date', todayIst),

    supabase
      .from('results')
      .select('id, student_id, flag_note, entry_date, profiles!results_student_id_fkey(full_name, student_code)')
      .in('student_id', assignedIds)
      .eq('flagged', true)
      .order('entry_date', { ascending: false })
      .limit(20),

    supabase
      .from('results')
      .select('id, student_id, correct, total, entry_date, profiles!results_student_id_fkey(full_name, student_code)')
      .in('student_id', assignedIds)
      .eq('verified', false)
      .gte('entry_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .order('entry_date', { ascending: false })
      .limit(25),

    supabase
      .from('weekly_tests')
      .select('id, title, test_date, opens_at, closes_at, test_type')
      .gte('test_date', todayIst)
      .order('test_date', { ascending: true })
      .limit(10),
  ]);

  const practicedStudentIdSet = new Set((todayResultsRes.data || []).map((r) => r.student_id));
  const notPracticed = (studentsRes.data || []).filter((s) => !practicedStudentIdSet.has(s.id));

  const needsAttention = (flaggedRes.data || []).map((r) => ({
    result_id: r.id,
    student_id: r.student_id,
    student_name: r.profiles?.full_name || 'Student',
    student_code: r.profiles?.student_code || '',
    flag_note: r.flag_note,
    entry_date: r.entry_date,
  }));

  const pendingReview = (pendingRes.data || []).map((r) => ({
    result_id: r.id,
    student_id: r.student_id,
    student_name: r.profiles?.full_name || 'Student',
    student_code: r.profiles?.student_code || '',
    correct: r.correct,
    total: r.total,
    entry_date: r.entry_date,
  }));

  return {
    assigned_count: assignedIds.length,
    not_practiced_today: notPracticed,
    needs_attention: needsAttention,
    pending_review: pendingReview,
    upcoming_tests: testsRes.data || [],
  };
}

/**
 * Initializes and renders the Teacher Overview page.
 */
export async function initTeacherOverview() {
  currentProfile = await requireAuth(['teacher', 'admin']);
  if (!currentProfile) return;

  const todayIst = getTodayIst();
  const dateEl = document.getElementById('overview-today-ist');
  if (dateEl) {
    dateEl.textContent = todayIst;
  }

  const supabase = await getSupabase();
  const data = await loadTeacherOverviewData(supabase, currentProfile);

  renderOverview(data);
}

export function renderOverview(data) {
  const assignedCount = data.assigned_count || 0;
  const notPracticed = data.not_practiced_today || [];
  const needsAttention = data.needs_attention || [];
  const pendingReview = data.pending_review || [];
  const upcomingTests = data.upcoming_tests || [];

  // Update Stat Values
  const statAssigned = document.getElementById('stat-assigned-students');
  const statNotPracticed = document.getElementById('stat-not-practiced');
  const statPending = document.getElementById('stat-pending-review');
  const statAttention = document.getElementById('stat-needs-attention');

  if (statAssigned) statAssigned.textContent = String(assignedCount);
  if (statNotPracticed) statNotPracticed.textContent = String(notPracticed.length);
  if (statPending) statPending.textContent = String(pendingReview.length);
  if (statAttention) statAttention.textContent = String(needsAttention.length);

  // Update Badges
  const badgeNotPracticed = document.getElementById('badge-not-practiced-count');
  const badgeAttention = document.getElementById('badge-attention-count');
  const badgePending = document.getElementById('badge-pending-count');

  if (badgeNotPracticed) badgeNotPracticed.textContent = String(notPracticed.length);
  if (badgeAttention) badgeAttention.textContent = String(needsAttention.length);
  if (badgePending) badgePending.textContent = String(pendingReview.length);

  // 1. Render Not Practiced Today
  const containerNotPracticed = document.getElementById('container-not-practiced');
  if (containerNotPracticed) {
    if (notPracticed.length === 0) {
      containerNotPracticed.innerHTML = `
        <div class="empty-state" style="padding: var(--space-4); color: var(--color-success-text, #16a34a);">
          🎉 All assigned students have logged practice today!
        </div>
      `;
    } else {
      containerNotPracticed.innerHTML = `
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Student Code</th>
                <th>Full Name</th>
                <th>Level</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${notPracticed
                .map(
                  (s) => `
                <tr>
                  <td><span class="badge badge-neutral num">${escapeHtml(s.student_code || '—')}</span></td>
                  <td><strong>${escapeHtml(s.full_name || 'Student')}</strong></td>
                  <td>${escapeHtml(s.level || '—')}</td>
                  <td style="text-align: right;">
                    <a href="/pages/student-detail.html?id=${encodeURIComponent(s.id)}" class="btn btn-outline btn-sm">
                      View Profile
                    </a>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // 2. Render Students Needing Attention
  const containerAttention = document.getElementById('container-needs-attention');
  if (containerAttention) {
    if (needsAttention.length === 0) {
      containerAttention.innerHTML = `
        <div class="empty-state" style="padding: var(--space-4);">
          No students currently require attention.
        </div>
      `;
    } else {
      containerAttention.innerHTML = `
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Student</th>
                <th>Reason / Flag Note</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${needsAttention
                .map(
                  (item) => `
                <tr>
                  <td class="num">${escapeHtml(item.entry_date || '—')}</td>
                  <td>
                    <strong>${escapeHtml(item.student_name || 'Student')}</strong>
                    <span class="badge badge-neutral num" style="margin-left: 6px;">${escapeHtml(item.student_code || '')}</span>
                  </td>
                  <td><span class="badge badge-warning">${escapeHtml(item.flag_note || 'Flagged for review')}</span></td>
                  <td style="text-align: right;">
                    <a href="/pages/review.html" class="btn btn-outline btn-sm">
                      Review Flag
                    </a>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // 3. Render Scores Pending Review
  const containerPending = document.getElementById('container-pending-review');
  if (containerPending) {
    if (pendingReview.length === 0) {
      containerPending.innerHTML = `
        <div class="empty-state" style="padding: var(--space-4);">
          No scores pending review in the last 7 days.
        </div>
      `;
    } else {
      containerPending.innerHTML = `
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Student</th>
                <th>Score</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${pendingReview
                .map(
                  (item) => `
                <tr>
                  <td class="num">${escapeHtml(item.entry_date || '—')}</td>
                  <td>
                    <strong>${escapeHtml(item.student_name || 'Student')}</strong>
                    <span class="badge badge-neutral num" style="margin-left: 6px;">${escapeHtml(item.student_code || '')}</span>
                  </td>
                  <td class="num">${escapeHtml(item.correct ?? '—')} / ${escapeHtml(item.total ?? '—')}</td>
                  <td style="text-align: right;">
                    <a href="/pages/review.html" class="btn btn-outline btn-sm">
                      Verify Score
                    </a>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // 4. Render Upcoming Weekly Tests
  const containerTests = document.getElementById('container-upcoming-tests');
  if (containerTests) {
    if (upcomingTests.length === 0) {
      containerTests.innerHTML = `
        <div class="empty-state" style="padding: var(--space-4);">
          No upcoming weekly tests scheduled.
        </div>
      `;
    } else {
      containerTests.innerHTML = `
        <div class="table-container">
          <table class="data-table">
            <thead>
              <tr>
                <th>Test Title</th>
                <th>Test Date</th>
                <th>Type</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${upcomingTests
                .map(
                  (t) => `
                <tr>
                  <td><strong>${escapeHtml(t.title || 'Weekly Test')}</strong></td>
                  <td class="num">${escapeHtml(t.test_date || '—')}</td>
                  <td><span class="badge badge-neutral">${escapeHtml(t.test_type || 'standard')}</span></td>
                  <td style="text-align: right;">
                    <a href="/pages/weekly-tests.html" class="btn btn-outline btn-sm">
                      View Details
                    </a>
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }
}

if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    initTeacherOverview();
  });
}
