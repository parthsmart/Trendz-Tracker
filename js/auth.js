/**
 * Trendz Tracker - Authentication Module
 * Handles login, session management, ID-to-email mapping, and role checking.
 */

import { AUTH_EMAIL_DOMAIN, isSupabaseConfigured, isDemoAllowedHost, ensurePreviewConfigLoaded } from './config.js';
import { getSupabase, DemoDB, clearStaleSupabaseSession } from './supabaseClient.js';
import { isDemoMode } from './demoDb.js';

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
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', authData.user.id)
      .single();

    if (profileError || !profile) {
      await supabase.auth.signOut();
      throw new Error('Profile record not found. Please contact your administrator.');
    }

    if (!profile.active) {
      await supabase.auth.signOut();
      throw new Error('Your account is deactivated. Please contact your Trendz Abacus teacher.');
    }

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
      return { user: { id: adminProfile.id, email }, profile: adminProfile };
    } else {
      throw new Error('Invalid password for Admin. (Demo password: admin123)');
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
  return { user: { id: matchedStudent.id, email }, profile: matchedStudent };
}

/**
 * Get current authenticated user profile
 */
export async function getCurrentProfile() {
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
          clearStaleSupabaseSession();
          await supabase.auth.signOut().catch(() => {});
        }
        return null;
      }

      const session = data?.session;
      if (!session?.user) return null;

      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

      if (profileErr) {
        console.warn('Profile retrieval error:', profileErr.message);
        clearStaleSupabaseSession();
        await supabase.auth.signOut().catch(() => {});
        return null;
      }

      return profile || null;
    } catch (err) {
      console.warn('Error reading current profile:', err);
      if (err?.message?.includes('Refresh Token') || err?.name === 'AuthApiError') {
        clearStaleSupabaseSession();
      }
      return null;
    }
  }

  if (!isDemoAllowedHost()) {
    return null;
  }

  return DemoDB.getDemoAuth();
}

/**
 * Sign out the current user
 */
export async function logoutUser() {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (supabase) {
        await supabase.auth.signOut();
      }
    } catch (err) {
      console.warn('Sign out error:', err);
    }
  }
  clearStaleSupabaseSession();
  DemoDB.setDemoAuth(null);
  window.location.href = '/index.html';
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
  } else {
    window.location.href = '/pages/student.html';
  }
}
