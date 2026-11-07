/**
 * Trendz Tracker — Server-Authoritative Daily Task Validation Helper (api/_dailyTasks.js)
 *
 * Validates daily task assignments for practice endpoints (Basics, Elements, Memoriad, Flash):
 * - Confirms task exists, is active, and matches the requested section and category/drill
 * - Enforces targeting: targeted student recipient check (using composite PK (task_id, student_id))
 *   or level eligibility
 * - Rejects forged, inactive, mismatched, or unassigned tasks with authoritative HTTP status codes (400, 403, 404, 500)
 * - Returns null cleanly when no task ID is supplied (free practice mode)
 */

/**
 * Validates an assigned daily task for a student session.
 *
 * @param {object} adminSupabase - Privileged Supabase client
 * @param {string|null|undefined} todoTaskId - Task UUID provided by caller
 * @param {object} student - Verified student profile { id, level, ... }
 * @param {string} [expectedSection] - Expected section ('basics', 'elements', 'memoriad', 'flash')
 * @param {string|null} [expectedKeyOrCat] - Expected category_id or activity_key
 * @returns {Promise<{
 *   ok: boolean,
 *   statusCode?: number,
 *   error?: string,
 *   task?: object|null
 * }>}
 */
export async function resolveAndValidateDailyTask(
  adminSupabase,
  todoTaskId,
  student,
  expectedSection = null,
  expectedKeyOrCat = null
) {
  if (todoTaskId === null || todoTaskId === undefined) {
    return { ok: true, task: null };
  }

  // Reject supplied non-string or blank task IDs explicitly
  if (typeof todoTaskId !== 'string' || !todoTaskId.trim()) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Invalid daily task ID: must be a non-empty string.',
    };
  }

  const cleanId = todoTaskId.trim();

  // 1. UUID syntax check
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(cleanId)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Invalid daily task ID format.',
    };
  }

  if (!student || !student.id) {
    return {
      ok: false,
      statusCode: 401,
      error: 'Student authentication required to validate assigned daily task.',
    };
  }

  try {
    // 2. Fetch the task
    const { data: task, error: dbErr } = await adminSupabase
      .from('daily_tasks')
      .select('id, title, section, category_id, activity_key, duration_seconds, level, target_scope, active, flash_digits, flash_count, flash_speed_ms, flash_mode')
      .eq('id', cleanId)
      .maybeSingle();

    if (dbErr) {
      return {
        ok: false,
        statusCode: 500,
        error: 'Database error looking up assigned daily task.',
      };
    }

    if (!task || task.active === false) {
      return {
        ok: false,
        statusCode: 404,
        error: 'Assigned daily task not found or is no longer active.',
      };
    }

    // 3. Validate Section
    if (expectedSection && task.section !== expectedSection) {
      return {
        ok: false,
        statusCode: 400,
        error: `Daily task section mismatch (expected ${task.section}, requested ${expectedSection}).`,
      };
    }

    // 4. Validate Category / Drill / Module
    if (expectedKeyOrCat) {
      if (expectedSection === 'basics') {
        if (task.category_id && String(task.category_id).trim() !== String(expectedKeyOrCat).trim()) {
          return {
            ok: false,
            statusCode: 400,
            error: 'Daily task category mismatch.',
          };
        }
      } else if (expectedSection === 'elements') {
        if (task.activity_key && String(task.activity_key).trim() !== String(expectedKeyOrCat).trim()) {
          return {
            ok: false,
            statusCode: 400,
            error: `Daily task drill mismatch (expected ${task.activity_key}, requested ${expectedKeyOrCat}).`,
          };
        }
      } else if (expectedSection === 'memoriad') {
        if (task.activity_key && String(task.activity_key).trim().toLowerCase() !== String(expectedKeyOrCat).trim().toLowerCase()) {
          return {
            ok: false,
            statusCode: 400,
            error: `Daily task module mismatch (expected ${task.activity_key}, requested ${expectedKeyOrCat}).`,
          };
        }
      }
    }

    // 5. Targeting Enforcement
    if (task.target_scope === 'targeted') {
      // NOTE: daily_task_recipients has composite PK (task_id, student_id) and NO 'id' column!
      const { data: rec, error: recErr } = await adminSupabase
        .from('daily_task_recipients')
        .select('student_id')
        .eq('task_id', task.id)
        .eq('student_id', student.id)
        .maybeSingle();

      if (recErr) {
        return {
          ok: false,
          statusCode: 500,
          error: 'Database error checking daily task assignment.',
        };
      }

      if (!rec) {
        return {
          ok: false,
          statusCode: 403,
          error: 'You are not assigned to this daily task.',
        };
      }
    } else {
      // Level targeting
      if (task.level && String(task.level).trim()) {
        const studentLevel = String(student.level || '').trim().toLowerCase();
        const taskLevel = String(task.level).trim().toLowerCase();
        if (studentLevel !== taskLevel) {
          return {
            ok: false,
            statusCode: 403,
            error: `This daily task is assigned to level ${task.level}, but your profile is level ${student.level || 'unassigned'}.`,
          };
        }
      }
    }

    return {
      ok: true,
      task,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 500,
      error: 'Unexpected error validating assigned daily task.',
    };
  }
}
