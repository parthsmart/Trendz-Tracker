/**
 * Trendz Tracker - API Client
 * Calls the secure backend serverless functions (/api/create-student and /api/reset-password)
 * which use the Supabase Service Role Key after verifying the caller is an admin.
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';
import { getSupabase, DemoDB } from './supabaseClient.js';
import { clearProfileCache } from './profileCache.js';

/**
 * Creates a new student user in Supabase Auth & public.profiles
 * @param {Object} data - { student_code, full_name, level, password }
 */
export async function createStudent(data) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    // Demo Mode simulation (only on localhost or run.app)
    return DemoDB.addStudent(data);
  }

  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/create-student', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(data)
  });

  let result = null;
  const rawText = await response.text();
  try {
    result = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    result = null;
  }

  if (!response.ok || !result || !result.success) {
    throw new Error(result?.error || `Failed to create student account (Status ${response.status})`);
  }

  return result.student;
}

/**
 * Resets a student's password
 * @param {string} studentId - The UUID of the student in profiles/auth.users
 * @param {string} newPassword - The new temporary password
 */
export async function resetStudentPassword(studentId, newPassword) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    clearProfileCache();
    // Demo Mode simulation (only on localhost or run.app)
    return DemoDB.resetStudentPassword(studentId);
  }

  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/reset-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify({
      student_id: studentId,
      new_password: newPassword
    })
  });

  let result = null;
  const rawText = await response.text();
  try {
    result = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    result = null;
  }

  if (!response.ok || !result || !result.success) {
    throw new Error(result?.error || `Failed to reset password (Status ${response.status})`);
  }

  clearProfileCache();
  return true;
}

/**
 * Toggles a student's active status.
 * Can be performed via standard Supabase client because admin has RLS write permissions on profiles.
 * @param {string} studentId
 * @param {boolean} currentActive
 */
export async function toggleStudentActive(studentId, currentActive) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    clearProfileCache();
    return DemoDB.toggleStudentActive(studentId);
  }

  const supabase = await getSupabase();
  const nextStatus = !currentActive;

  const { data, error } = await supabase
    .from('profiles')
    .update({ active: nextStatus })
    .eq('id', studentId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  clearProfileCache();
  return data;
}

/**
 * Toggles whether a student appears on any leaderboard (profiles.leaderboard_visible).
 * @param {string} studentId
 * @param {boolean} currentVisible
 */
export async function toggleStudentLeaderboardVisible(studentId, currentVisible) {
  const nextVisible = !currentVisible;

  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    clearProfileCache();
    return DemoDB.toggleStudentLeaderboardVisible(studentId, nextVisible);
  }

  const supabase = await getSupabase();

  const { data, error } = await supabase
    .from('profiles')
    .update({ leaderboard_visible: nextVisible })
    .eq('id', studentId)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  clearProfileCache();
  return data;
}

/**
 * Creates a new teacher user in Supabase Auth & public.profiles
 * @param {Object} data - { teacher_code, full_name, password, permissions, assigned_student_ids }
 */
export async function createTeacher(data) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return {
      id: 'demo-teacher-' + Date.now(),
      student_code: data.teacher_code?.toUpperCase(),
      full_name: data.full_name,
      role: 'teacher',
      level: 'Teacher',
      active: true,
    };
  }

  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/create-teacher', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(data)
  });

  let result = null;
  const rawText = await response.text();
  try {
    result = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    result = null;
  }

  if (!response.ok || !result || !result.success) {
    throw new Error(result?.error || `Failed to create teacher account (Status ${response.status})`);
  }

  clearProfileCache();
  return result;
}

/**
 * Executes a teacher management action:
 * - update_assignments
 * - update_permissions
 * - set_active
 * - get_audit_log
 * - get_teacher_details
 * @param {Object} payload - { action, teacher_id, ... }
 */
export async function manageTeacher(payload) {
  if (!isSupabaseConfigured()) {
    if (!isDemoAllowedHost()) {
      throw new Error('Configuration error - contact the administrator.');
    }
    return { success: true, message: 'Demo mode simulated action' };
  }

  const supabase = await getSupabase();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('Authentication required. Please sign in as an admin.');
  }

  const response = await fetch('/api/manage-teacher', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(payload)
  });

  let result = null;
  const rawText = await response.text();
  try {
    result = rawText && rawText.trim() ? JSON.parse(rawText) : null;
  } catch {
    result = null;
  }

  if (!response.ok || !result || !result.success) {
    throw new Error(result?.error || `Failed to manage teacher (Status ${response.status})`);
  }

  clearProfileCache();
  return result;
}

/**
 * Resets a teacher's password
 * @param {string} teacherId - The UUID of the teacher in profiles/auth.users
 * @param {string} newPassword - The new temporary password
 */
export async function resetTeacherPassword(teacherId, newPassword) {
  return resetStudentPassword(teacherId, newPassword);
}


