/**
 * Vercel Serverless Function: /api/create-student
 * Creates a student in Supabase Auth & public.profiles using the Service Role Key.
 * Verifies caller is an authenticated admin first.
 */

import { getAdminClient, verifyAdminCaller } from './_supabaseAdmin.js';

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verify caller is an active admin
    await verifyAdminCaller(req);

    // 2. Parse payload
    const { student_code, full_name, level, password } = req.body || {};

    if (!student_code || !full_name || !password) {
      return res.status(400).json({ error: 'Student code, full name, and temporary password are required.' });
    }

    const cleanCode = student_code.trim().toUpperCase();
    const cleanName = full_name.trim();
    const cleanLevel = level ? level.trim() : null;
    const email = `${cleanCode.toLowerCase()}@trendz.local`;

    const supabaseAdmin = getAdminClient();

    // 3. Create user in Supabase Auth
    const { data: authUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: password.trim(),
      email_confirm: true,
      user_metadata: {
        student_code: cleanCode,
        full_name: cleanName,
        level: cleanLevel,
        role: 'student'
      }
    });

    if (createAuthError) {
      return res.status(400).json({ error: createAuthError.message });
    }

    // 4. Ensure profile row exists in public.profiles (upsert)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: authUser.user.id,
        student_code: cleanCode,
        full_name: cleanName,
        role: 'student',
        level: cleanLevel,
        active: true
      })
      .select()
      .single();

    if (profileError) {
      // Rollback auth user if profile insert failed
      await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      return res.status(500).json({ error: 'Failed to create student profile: ' + profileError.message });
    }

    return res.status(200).json({
      success: true,
      student: profile
    });
  } catch (err) {
    console.error('Error in /api/create-student:', err);
    return res.status(err.message.includes('Unauthorized') ? 401 : 403).json({
      error: err.message || 'Internal Server Error'
    });
  }
}
