/**
 * Trendz Tracker - Authentication Module
 * Handles login, session management, ID-to-email mapping, and role checking.
 */

import { AUTH_EMAIL_DOMAIN, isSupabaseConfigured, isDemoAllowedHost, ensurePreviewConfigLoaded } from './config.js';
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';
import { isDemoMode } from './demoDb.js';
import { readProfileCache, writeProfileCache, clearProfileCache } from './profileCache.js';
import { clearNotificationsCache } from './notificationBadge.js';
import { clearAllJmcwcLocalRecovery, syncJmcwcRecoveryUserScope } from './jmcwcClient.js';

let inFlightProfilePromise = null;
let inFlightProfileUserId = null;

async function fetchProfileFromSupabase(supabase, userId) {
  if (inFlightProfilePromise && inFlightProfileUserId === userId) {
    return inFlightProfilePromise;
  }

  inFlightProfileUserId = userId;
  inFlightProfilePromise = (async () => {
    try {
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('id, student_code, full_name, role, level, active, leaderboard_visible, created_at')
        .eq('id', userId)
        .single();

      if (profileErr || !profile) {
        return { profile: null, error: profileErr || new Error('Profile not found') };
      }

      if (profile.role === 'teacher') {
        try {
          const { data: perms } = await supabase
            .from('teacher_permissions')
            .select('*')
            .eq('teacher_id', userId)
            .maybeSingle();

          profile.permissions = perms || {
            can_view_students: true,
            can_mark_attendance: true,
            can_correct_attendance: true,
            can_generate_reports: true,
            can_manage_tasks: true,
            can_manage_tests: true,
            can_publish_announcements: true,
            can_manage_resources: true,
            can_review_scores: true,
            can_request_corrections: true,
          };
        } catch (permErr) {
          console.warn('Teacher permissions fetch error:', permErr);
          profile.permissions = {
            can_view_students: true,
            can_mark_attendance: true,
            can_correct_attendance: true,
            can_generate_reports: true,
            can_manage_tasks: true,
            can_manage_tests: true,
            can_publish_announcements: true,
            can_manage_resources: true,
            can_review_scores: true,
            can_request_corrections: true,
          };
        }
      }

      return { profile, error: null };
    } finally {
      inFlightProfilePromise = null;
      inFlightProfileUserId = null;
    }
  })();

  return inFlightProfilePromise;
}

/**
 * Normalizes a student or admin identifier into a Supabase auth email.
 * E.g., "STU-101" -> "stu-101@trendz.local"
 * If an email was already entered (e.g. "admin@trendz.local"), it is preserved.
 */
export function formatLoginEmail(identifier) {
  const clean = identifier.trim().toLowerCase();
  if (clean.includes('@')) {
    return clean;
  }
  return `${clean}@${AUTH_EMAIL_DOMAIN}`;
}

/**
 * Log in using Student ID and password.
 * @param {string} studentId - e.g. "STU101" or "admin01"
 * @param {string} password - e.g. "student123"
 */
export async function loginWithStudentId(studentId, password) {
  if (!studentId || !password) {
    throw new Error('Please enter both your Student ID and password.');
  }

  const email = formatLoginEmail(studentId);

  await ensurePreviewConfigLoaded();

  // 1. If Supabase is configured, use live auth
  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (!supabase) {
      throw new Error('Could not connect to Supabase. Check your configuration.');
    }

    // Clear any stale local storage tokens before attempting new authentication
    clearStaleSupabaseSession();
    clearProfileCache();

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      if (authError.message.toLowerCase().includes('invalid login credentials')) {
        throw new Error('Invalid Student ID or password. Please try again.');
      }
      throw new Error(authError.message);
    }

    // Fetch user profile from public.profiles
    const { profile, error: profileError } = await fetchProfileFromSupabase(
      supabase,
      authData.user.id
    );

    if (profileError || !profile) {
      clearProfileCache();
      await supabase.auth.signOut();
      throw new Error('Profile record not found. Please contact your administrator.');
    }

    if (!profile.active) {
      clearProfileCache();
      await supabase.auth.signOut();
      throw new Error('Your account is deactivated. Please contact your Trendz Abacus teacher.');
    }

    syncJmcwcRecoveryUserScope(profile.id);
    writeProfileCache(profile);
    return { user: authData.user, profile };
  }

  // 2. Demo Mode simulation (Allowed ONLY on localhost or run.app hosts)
  if (!isDemoAllowedHost()) {
    throw new Error('Configuration error - contact the administrator.');
  }

  const cleanId = studentId.trim().toUpperCase();

  // Admin login check in Demo Mode
  if (cleanId === 'ADMIN' || cleanId === 'ADMIN01') {
    if (password === 'admin123' || password === 'admin') {
      const adminProfile = {
        id: 'admin-demo-uuid',
        student_code: 'ADMIN01',
        full_name: 'Master Teacher (Admin)',
        role: 'admin',
        level: 'Instructor',
        active: true,
        created_at: new Date().toISOString()
      };
      DemoDB.setDemoAuth(adminProfile);
      syncJmcwcRecoveryUserScope(adminProfile.id);
      writeProfileCache(adminProfile);
      return { user: { id: adminProfile.id, email }, profile: adminProfile };
    } else {
      throw new Error('Invalid password for Admin. (Demo password: admin123)');
    }
  }

  // Teacher login check in Demo Mode
  if (cleanId === 'TEACHER' || cleanId === 'TCH01') {
    if (password === 'teacher123' || password === 'teacher') {
      const teacherProfile = {
        id: 'teacher-demo-uuid',
        student_code: 'TCH01',
        full_name: 'Anita Sharma (Teacher)',
        role: 'teacher',
        level: 'Teacher',
        active: true,
        created_at: new Date().toISOString(),
        permissions: {
          can_view_students: true,
          can_mark_attendance: true,
          can_correct_attendance: true,
          can_generate_reports: true,
          can_manage_tasks: true,
          can_manage_tests: true,
          can_publish_announcements: true,
          can_manage_resources: true,
          can_review_scores: true,
          can_request_corrections: true,
        }
      };
      DemoDB.setDemoAuth(teacherProfile);
      syncJmcwcRecoveryUserScope(teacherProfile.id);
      writeProfileCache(teacherProfile);
      return { user: { id: teacherProfile.id, email }, profile: teacherProfile };
    } else {
      throw new Error('Invalid password for Teacher. (Demo password: teacher123)');
    }
  }

  // Student login check in Demo Mode
  const demoStudents = DemoDB.getStudents();
  const matchedStudent = demoStudents.find(
    s => s.student_code.toUpperCase() === cleanId
  );

  if (!matchedStudent) {
    throw new Error(`Student ID "${cleanId}" not found. (In demo mode, try STU101 or ADMIN01)`);
  }

  if (password !== 'student123' && password !== 'password123' && password !== 'temp123') {
    throw new Error('Invalid password. (Demo password: student123)');
  }

  if (!matchedStudent.active) {
    throw new Error('Your account is deactivated. Please contact your Trendz Abacus teacher.');
  }

  DemoDB.setDemoAuth(matchedStudent);
  syncJmcwcRecoveryUserScope(matchedStudent.id);
  writeProfileCache(matchedStudent);
  return { user: { id: matchedStudent.id, email }, profile: matchedStudent };
}

/**
 * Get current authenticated user profile.
 * Uses the 2-minute sessionStorage profile cache for fast initial rendering when available,
 * and always revalidates in the background against Supabase.
 *
 * @param {{ allowCached?: boolean, onRevalidated?: ((profile: any) => void) | null }} [options]
 */
export async function getCurrentProfile({ allowCached = true, onRevalidated = null } = {}) {
  await ensurePreviewConfigLoaded();
  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (!supabase) return null;

      const { data, error } = await supabase.auth.getSession();
      if (error) {
        console.warn('Session check encountered an error:', error.message);
        if (
          error.message?.includes('Refresh Token') ||
          error.message?.includes('refresh_token') ||
          error.status === 400
        ) {
          clearProfileCache();
          clearStaleSupabaseSession();
          await supabase.auth.signOut().catch(() => {});
        }
        return null;
      }

      const session = data?.session;
      if (!session?.user) {
        clearProfileCache();
        return null;
      }

      const userId = session.user.id;

      // Fast path: return valid 2-minute cached profile immediately and revalidate in background
      if (allowCached) {
        const cached = readProfileCache(userId);
        if (cached && cached.active !== false) {
          fetchProfileFromSupabase(supabase, userId)
            .then(async ({ profile: freshProfile, error: profileErr }) => {
              if (profileErr || !freshProfile || freshProfile.active === false) {
                clearProfileCache();
                clearStaleSupabaseSession();
                await supabase.auth.signOut().catch(() => {});
                if (typeof window !== 'undefined') {
                  window.location.replace('/index.html');
                }
                return;
              }
              writeProfileCache(freshProfile);
              if (typeof onRevalidated === 'function') {
                onRevalidated(freshProfile);
              }
            })
            .catch(() => {
              // Ignore transient network errors during background revalidation
            });

          return cached;
        }
      }

      const { profile, error: profileErr } = await fetchProfileFromSupabase(supabase, userId);

      if (profileErr || !profile) {
        console.warn('Profile retrieval error:', profileErr?.message);
        clearProfileCache();
        clearStaleSupabaseSession();
        await supabase.auth.signOut().catch(() => {});
        return null;
      }

      if (profile.active === false) {
        clearProfileCache();
        clearStaleSupabaseSession();
        await supabase.auth.signOut().catch(() => {});
        return null;
      }

      syncJmcwcRecoveryUserScope(profile.id);
      writeProfileCache(profile);
      return profile;
    } catch (err) {
      console.warn('Error reading current profile:', err);
      if (err?.message?.includes('Refresh Token') || err?.name === 'AuthApiError') {
        clearProfileCache();
        clearStaleSupabaseSession();
      }
      return null;
    }
  }

  if (!isDemoAllowedHost()) {
    return null;
  }

  const demoProfile = DemoDB.getDemoAuth();
  if (demoProfile) {
    syncJmcwcRecoveryUserScope(demoProfile.id);
    writeProfileCache(demoProfile);
  }
  return demoProfile;
}

let isLoggingOut = false;

/**
 * Sign out the current user
 */
export async function logoutUser() {
  if (isLoggingOut) return;
  isLoggingOut = true;

  clearProfileCache();
  clearNotificationsCache();
  clearAllJmcwcLocalRecovery();

  try {
    await ensurePreviewConfigLoaded();
    if (isSupabaseConfigured()) {
      const supabase = await getSupabase();
      if (supabase) {
        // Clear local session immediately, then best-effort revoke on server with a short timeout
        await Promise.race([
          supabase.auth.signOut(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]).catch((err) => {
          console.warn('Sign out warning:', err);
        });
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('Sign out error:', err);
  } finally {
    clearProfileCache();
    clearNotificationsCache();
    clearAllJmcwcLocalRecovery();
    clearStaleSupabaseSession();
    try {
      if (DemoDB && typeof DemoDB.setDemoAuth === 'function') {
        DemoDB.setDemoAuth(null);
      }
    } catch {
      // ignore in production stub
    }
    isLoggingOut = false;
    window.location.replace('/index.html');
  }
}

/**
 * Redirect user to their corresponding home page based on role
 */
export function redirectByRole(profile) {
  if (!profile) {
    window.location.href = '/index.html';
    return;
  }
  if (profile.role === 'admin') {
    window.location.href = '/pages/admin.html';
  } else if (profile.role === 'teacher') {
    window.location.href = '/pages/teacher.html';
  } else {
    window.location.href = '/pages/student.html';
  }
}
