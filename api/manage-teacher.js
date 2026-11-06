/**
 * Vercel Serverless Function: /api/manage-teacher
 * Administrative endpoint to manage teachers using transactional RPCs:
 * - update_assignments: atomically validates, replaces assignments, and logs assign_students
 * - update_permissions: atomically updates permissions and logs update_permissions
 * - set_active: atomically toggles active state and logs activate/deactivate
 * - get_audit_log: returns activity logs for a teacher
 * - get_teacher_details: returns profile, permissions, and assigned students
 *
 * Verifies caller is an authenticated active admin first.
 */

import { getAdminClient, getCallerClient, verifyAdminCaller } from './_supabaseAdmin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Verify caller is an active admin
    const adminCaller = await verifyAdminCaller(req);

    // 2. Parse payload
    const { action, teacher_id } = req.body || {};

    if (!action || !teacher_id) {
      return res.status(400).json({ error: 'Action and teacher_id are required.' });
    }

    const supabaseAdmin = getAdminClient();
    const dbClient = getCallerClient(adminCaller.accessToken);

    // 3. Verify target is a valid teacher profile
    const { data: teacherProfile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('id, student_code, full_name, role, active')
      .eq('id', teacher_id)
      .single();

    if (profileErr || !teacherProfile) {
      return res.status(404).json({ error: 'Teacher profile not found.' });
    }

    if (teacherProfile.role !== 'teacher') {
      return res.status(400).json({ error: 'Target user is not a teacher.' });
    }

    // 4. Handle actions via transactional RPCs

    // Action A: Update Assignments (Transactional Replacement)
    if (action === 'update_assignments') {
      const { assigned_student_ids = [] } = req.body;
      const validStudentIds = Array.isArray(assigned_student_ids)
        ? assigned_student_ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
        : [];

      const { data: rpcData, error: rpcErr } = await dbClient.rpc(
        'admin_replace_teacher_assignments',
        {
          p_teacher_id: teacher_id,
          p_student_ids: validStudentIds,
          p_actor_id: adminCaller.id,
        }
      );

      if (rpcErr) {
        console.error('Failed to replace teacher assignments:', rpcErr);
        return res.status(400).json({
          error: 'Failed to update student assignments: ' + rpcErr.message,
        });
      }

      const assignedCount = rpcData?.assigned_count ?? validStudentIds.length;
      return res.status(200).json({
        success: true,
        message: `Assigned ${assignedCount} student(s) to ${teacherProfile.full_name}.`,
        assigned_count: assignedCount,
      });
    }

    // Action B: Update Permissions
    if (action === 'update_permissions') {
      const { permissions = {} } = req.body;

      const { data: rpcData, error: rpcErr } = await dbClient.rpc(
        'admin_update_teacher_permissions',
        {
          p_teacher_id: teacher_id,
          p_permissions: permissions,
          p_actor_id: adminCaller.id,
        }
      );

      if (rpcErr) {
        console.error('Failed to update teacher permissions:', rpcErr);
        return res.status(400).json({
          error: 'Failed to update permissions: ' + rpcErr.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Teacher permissions updated successfully.',
        permissions: rpcData?.permissions || permissions,
      });
    }

    // Action C: Toggle Active State
    if (action === 'set_active') {
      const { active } = req.body;
      if (typeof active !== 'boolean') {
        return res.status(400).json({ error: 'Field "active" must be a boolean.' });
      }

      const { data: rpcData, error: rpcErr } = await dbClient.rpc(
        'admin_set_teacher_active',
        {
          p_teacher_id: teacher_id,
          p_active: active,
          p_actor_id: adminCaller.id,
        }
      );

      if (rpcErr) {
        console.error('Failed to update teacher active state:', rpcErr);
        return res.status(400).json({
          error: 'Failed to update teacher active state: ' + rpcErr.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: `Teacher ${active ? 'activated' : 'deactivated'} successfully.`,
        active: rpcData?.active ?? active,
      });
    }

    // Action D: Reset Password
    if (action === 'reset_password') {
      const { new_password } = req.body;
      if (!new_password || String(new_password).trim().length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      }

      const { error: updateAuthErr } = await supabaseAdmin.auth.admin.updateUserById(teacher_id, {
        password: new_password.trim(),
      });

      if (updateAuthErr) {
        return res.status(400).json({ error: 'Failed to reset password: ' + updateAuthErr.message });
      }

      // Record audit log for password reset without storing the password
      const { error: auditErr } = await supabaseAdmin.from('teacher_audit_log').insert({
        teacher_id,
        actor_id: adminCaller.id,
        action: 'reset_password',
        details: { success: true },
      });
      if (auditErr) {
        console.warn('Could not record teacher password reset audit log:', auditErr.message);
      }

      return res.status(200).json({
        success: true,
        message: 'Teacher password reset successfully.',
      });
    }

    // Action D: Fetch Audit Logs
    if (action === 'get_audit_log') {
      const { data: logs, error: logErr } = await supabaseAdmin
        .from('teacher_audit_log')
        .select('*')
        .eq('teacher_id', teacher_id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (logErr) {
        return res.status(500).json({ error: 'Failed to fetch audit logs: ' + logErr.message });
      }

      return res.status(200).json({
        success: true,
        logs: logs || [],
      });
    }

    // Action E: Fetch Teacher Details
    if (action === 'get_teacher_details') {
      const [permsRes, assignRes] = await Promise.all([
        supabaseAdmin.from('teacher_permissions').select('*').eq('teacher_id', teacher_id).maybeSingle(),
        supabaseAdmin
          .from('teacher_student_assignments')
          .select('student_id, profiles!teacher_student_assignments_student_id_fkey(id, student_code, full_name, level, active)')
          .eq('teacher_id', teacher_id),
      ]);

      return res.status(200).json({
        success: true,
        teacher: teacherProfile,
        permissions: permsRes.data || null,
        assignments: assignRes.data || [],
      });
    }

    return res.status(400).json({ error: `Unknown action "${action}".` });
  } catch (err) {
    console.error('Error in /api/manage-teacher:', err);
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : err.message?.includes('Forbidden') ? 403 : 500);
    return res.status(status).json({
      error: err.message || 'Internal Server Error',
    });
  }
}
