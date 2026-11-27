/**
 * Vercel Serverless Function: /api/create-student
 * Creates a student in Supabase Auth & public.profiles using the Service Role Key.
 * Verifies the caller first: owners and directors may add a student to any
 * active centre (centre_id), centre heads and vice heads only to their own.
 */

import { getAdminClient, verifyStaffCaller } from './_supabaseAdmin.js';
import { resolveCreateCentre } from './_centreScope.js';
import { validateLevel } from '../shared/levels.js';

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verify caller is active staff ranked vice centre head or above
    const caller = await verifyStaffCaller(req, { minRole: 'vice_centre_head' });

    // 2. Parse payload
    const { student_code, full_name, level, password, centre_id } = req.body || {};

    if (!student_code || !full_name || !password) {
      return res.status(400).json({ error: 'Student code, full name, and temporary password are required.' });
    }

    const cleanCode = student_code.trim().toUpperCase();
    const cleanName = full_name.trim();
    const levelCheck = validateLevel(level);
    if (levelCheck.error) {
      return res.status(400).json({ error: levelCheck.error });
    }
    const cleanLevel = levelCheck.value;
    const email = `${cleanCode.toLowerCase()}@trendz.local`;

    const supabaseAdmin = getAdminClient();
    // null = the default centre (set by the database)
    const centreId = await resolveCreateCentre(caller, centre_id, supabaseAdmin);

    // A deleted student keeps their code; point the admin to Restore instead of a vague auth error.
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id, deleted_at')
      .eq('student_code', cleanCode)
      .maybeSingle();
    if (existing?.deleted_at) {
      return res.status(409).json({
        error: `Student code "${cleanCode}" belongs to a deleted student. Restore them from "Deleted students" instead.`,
      });
    }

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
        active: true,
        ...(centreId ? { centre_id: centreId } : {})
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
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : 403);
    return res.status(status).json({
      error: err.message || 'Internal Server Error'
    });
  }
}
