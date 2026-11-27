/**
 * Vercel Serverless Function: /api/reset-password
 * Resets a student's or teacher's password using Supabase Service Role Key.
 * Verifies the caller first. Owners and directors may reset anyone ranked below
 * them (owners also other owners); centre heads and vice heads only students
 * and teachers of their own centre.
 * If target is a teacher, records an audit log entry in public.teacher_audit_log
 * with action 'reset_password' (never storing the password).
 */

import { getAdminClient, verifyStaffCaller } from './_supabaseAdmin.js';
import { canManageTarget } from './_centreScope.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verify caller is active staff ranked vice centre head or above
    const adminProfile = await verifyStaffCaller(req, { minRole: 'vice_centre_head' });

    // 2. Parse payload
    const { student_id, user_id, teacher_id, new_password } = req.body || {};
    const targetUserId = user_id || teacher_id || student_id;

    if (!targetUserId || !new_password) {
      return res.status(400).json({ error: 'Target ID and new password are required.' });
    }

    if (String(new_password).trim().length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const supabaseAdmin = getAdminClient();

    // 3. Check target user role
    const { data: targetProfile } = await supabaseAdmin
      .from('profiles')
      .select('id, student_code, full_name, role, centre_id')
      .eq('id', targetUserId)
      .maybeSingle();

    if (!targetProfile) {
      return res.status(404).json({ error: 'Person not found.' });
    }
    if (!canManageTarget(adminProfile, targetProfile)) {
      return res.status(403).json({ error: 'Forbidden: You cannot reset this person’s password.' });
    }

    // 4. Update password in Supabase Auth
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, {
      password: new_password.trim(),
    });

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    // 5. If target is a teacher, record in teacher_audit_log
    if (targetProfile?.role === 'teacher') {
      const { error: auditError } = await supabaseAdmin.from('teacher_audit_log').insert({
        teacher_id: targetUserId,
        actor_id: adminProfile.id,
        action: 'reset_password',
        details: {
          target_code: targetProfile.student_code,
          reset_by: adminProfile.student_code || adminProfile.full_name,
          timestamp: new Date().toISOString(),
        },
      });

      if (auditError) {
        console.error('Failed to record teacher password reset audit:', auditError);
        return res.status(500).json({
          error: 'Password reset succeeded, but audit log write failed: ' + auditError.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Password has been updated successfully.',
    });
  } catch (err) {
    console.error('Error in /api/reset-password:', err);
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : err.message?.includes('Forbidden') ? 403 : 500);
    return res.status(status).json({
      error: err.message || 'Internal Server Error',
    });
  }
}
