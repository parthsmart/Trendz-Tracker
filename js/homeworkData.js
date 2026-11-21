/**
 * Trendz Tracker — Homework Data & API Helpers (js/homeworkData.js)
 *
 * Implements homework strictly isolated from daily tasks and streaks:
 * - Admins can assign to all, any level, or any student
 * - Teachers can assign only to students in their authorized roster
 * - Zero impact on daily_tasks, daily_todo_log, streaks, or streak leaderboards
 * - Server-side validation via submit_homework_completion RPC (no direct student writes)
 * - Offline homework uses manual score workflow with pending review & teacher verification
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';

export const HOMEWORK_ACTIVITY_TYPES = Object.freeze([
  { id: 'basics', label: 'Basics Online Practice' },
  { id: 'flash', label: 'Flash Anzan' },
  { id: 'element', label: 'Elements Worksheet' },
  { id: 'memoriad', label: 'Memoriad Module' },
  { id: 'round', label: 'Main Round (Scoresheet)' },
  { id: 'paper', label: 'Paper Worksheet / Textbook' },
  { id: 'custom', label: 'Custom Homework' },
]);

export function formatHomeworkTypeLabel(type) {
  const found = HOMEWORK_ACTIVITY_TYPES.find((t) => t.id === type);
  return found ? found.label : type || 'Homework';
}

/**
 * Validates whether a teacher or admin is authorized to assign homework to a target student or level.
 * @param {Object} callerProfile
 * @param {Array<string>} teacherStudentIds
 * @param {'all'|'level'|'student'} targetType
 * @param {string|null} targetStudentId
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTeacherHomeworkAuthorization(
  callerProfile,
  teacherStudentIds = [],
  targetType = 'all',
  targetStudentId = null
) {
  if (!callerProfile) {
    return { valid: false, error: 'Authentication required.' };
  }
  if (callerProfile.role === 'admin') {
    return { valid: true };
  }
  if (callerProfile.role !== 'teacher') {
    return { valid: false, error: 'Only admins and teachers can assign homework.' };
  }

  // Teacher role: check permissions
  if (callerProfile.teacher_permissions?.can_manage_tasks === false) {
    return { valid: false, error: 'Teacher lacks can_manage_tasks permission.' };
  }

  // For teachers, must have at least one assigned student in roster
  if (teacherStudentIds.length === 0) {
    return { valid: false, error: 'You do not have any students assigned to your roster.' };
  }

  // If assigning to specific student, verify student is in teacher's roster
  if (targetType === 'student') {
    if (!targetStudentId) {
      return { valid: false, error: 'Please choose a student.' };
    }
    const isAssigned = teacherStudentIds.includes(targetStudentId);
    if (!isAssigned) {
      return { valid: false, error: 'You can only assign homework to students assigned to you.' };
    }
  }

  return { valid: true };
}

/**
 * Fetches homework assigned to a specific student, including completion status.
 *
 * @param {string} studentId
 * @param {string|null} studentLevel
 * @returns {Promise<Array<Object>>}
 */
export async function fetchStudentHomework(studentId, studentLevel = null) {
  if (!studentId) return [];

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      try {
        // Fetch all completions for this student to lock in recipient history
        const { data: completions, error: cError } = await supabase
          .from('homework_completions')
          .select('*')
          .eq('student_id', studentId);

        if (cError) throw cError;

        const compMap = new Map();
        for (const c of completions || []) {
          compMap.set(c.assignment_id, c);
        }

        // Query assignments applicable to this student
        const { data: assignments, error: aError } = await supabase
          .from('homework_assignments')
          .select(`
            id,
            title,
            instructions,
            assigned_by,
            target_type,
            target_level,
            target_student_id,
            activity_type,
            category_id,
            settings,
            duration_seconds,
            required_count,
            assigned_date,
            due_date,
            created_at,
            assigner:profiles!assigned_by (full_name, student_code)
          `)
          .order('created_at', { ascending: false });

        if (aError) throw aError;

        // Preserve intended recipients and history: if student has a completion row,
        // they were an authorized recipient and their history must be preserved even if level or roster changed!
        const applicableAssignments = (assignments || []).filter((a) => {
          if (compMap.has(a.id)) return true;
          if (a.target_type === 'all') return true;
          if (a.target_type === 'student' && a.target_student_id === studentId) return true;
          if (a.target_type === 'level' && studentLevel && a.target_level === studentLevel) return true;
          return false;
        });

        if (applicableAssignments.length === 0) return [];

        return applicableAssignments.map((a) => {
          const comp = compMap.get(a.id) || null;
          return {
            ...a,
            completion: comp,
            isCompleted: Boolean(comp && comp.status === 'completed'),
            isPendingReview: Boolean(comp && comp.status === 'pending_review'),
            progressCount: comp ? Number(comp.progress_count) || 0 : 0,
            submissionHistory: comp ? (comp.submission_history || []) : [],
          };
        });
      } catch (err) {
        console.warn('Supabase homework fetch failed, checking demo fallback:', err);
      }
    }
  }

  // DemoDB fallback
  if (isDemoAllowedHost() && DemoDB && typeof DemoDB.getStudentHomework === 'function') {
    return DemoDB.getStudentHomework(studentId, studentLevel);
  }

  return [];
}

/**
 * Submits homework completion authoritatively through the restricted database RPC.
 * Validates assignment, recipient, session, duration, settings, and prevents replay attacks.
 *
 * @param {string} assignmentId
 * @param {Object} details - { sessionId, resultId, activityResultId, notes }
 * @returns {Promise<Object>}
 */
export async function submitHomeworkCompletion(assignmentId, details = {}) {
  if (!assignmentId) {
    throw new Error('Assignment ID is required.');
  }

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase.rpc('submit_homework_completion', {
        p_assignment_id: assignmentId,
        p_session_id: details.sessionId || null,
        p_result_id: details.resultId || null,
        p_activity_result_id: details.activityResultId || null,
        p_notes: details.notes || null,
      });

      if (error) throw error;
      return data;
    }
  }

  if (isDemoAllowedHost() && DemoDB && typeof DemoDB.submitHomeworkCompletion === 'function') {
    return DemoDB.submitHomeworkCompletion(assignmentId, details);
  }

  throw new Error('Database unavailable to save homework completion.');
}

/**
 * Backward compatibility alias for submitHomeworkCompletion
 */
export async function recordHomeworkCompletion(assignmentId, studentId, details = {}) {
  return submitHomeworkCompletion(assignmentId, details);
}

/**
 * Teacher or Admin verifies an offline homework submission.
 *
 * @param {string} completionId
 * @param {'approve'|'reject'} decision
 * @param {string|null} notes
 * @returns {Promise<Object>}
 */
export async function verifyHomeworkCompletion(completionId, decision = 'approve', notes = null) {
  if (!completionId) {
    throw new Error('Completion ID is required.');
  }

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase.rpc('verify_homework_completion', {
        p_completion_id: completionId,
        p_decision: decision,
        p_notes: notes,
      });

      if (error) throw error;
      return data;
    }
  }

  if (isDemoAllowedHost() && DemoDB && typeof DemoDB.verifyHomeworkCompletion === 'function') {
    return DemoDB.verifyHomeworkCompletion(completionId, decision, notes);
  }

  throw new Error('Database unavailable to verify homework completion.');
}

/**
 * Creates a new homework assignment.
 *
 * @param {Object} assignmentData
 * @param {Object} callerProfile
 * @param {Array<string>} [teacherStudentIds]
 * @returns {Promise<Object>}
 */
export async function createHomeworkAssignment(
  assignmentData,
  callerProfile,
  teacherStudentIds = []
) {
  const authCheck = validateTeacherHomeworkAuthorization(
    callerProfile,
    teacherStudentIds,
    assignmentData.targetType,
    assignmentData.targetStudentId
  );

  if (!authCheck.valid) {
    throw new Error(authCheck.error || 'Unauthorized to assign homework.');
  }

  const title = String(assignmentData.title || '').trim();
  if (!title) {
    throw new Error('Homework title is required.');
  }

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  const payload = {
    title,
    instructions: String(assignmentData.instructions || '').trim() || null,
    assigned_by: callerProfile.id,
    target_type: assignmentData.targetType || 'all',
    target_level: assignmentData.targetType === 'level' ? assignmentData.targetLevel : null,
    target_student_id: assignmentData.targetType === 'student' ? assignmentData.targetStudentId : null,
    activity_type: assignmentData.activityType || 'paper',
    category_id: assignmentData.categoryId || null,
    settings: assignmentData.settings || {},
    duration_seconds: assignmentData.durationSeconds ? Number(assignmentData.durationSeconds) : null,
    required_count: Math.max(1, Number(assignmentData.requiredCount) || 1),
    assigned_date: assignmentData.assignedDate || todayIST,
    due_date: assignmentData.dueDate || null,
  };

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (supabase) {
      const { data, error } = await supabase
        .from('homework_assignments')
        .insert(payload)
        .select()
        .single();

      if (error) throw error;
      return data;
    }
  }

  if (isDemoAllowedHost() && DemoDB && typeof DemoDB.createHomeworkAssignment === 'function') {
    return DemoDB.createHomeworkAssignment(payload, callerProfile);
  }

  throw new Error('Database unavailable to save homework assignment.');
}
