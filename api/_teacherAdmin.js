/**
 * Trendz Tracker — Server-Side Teacher Administration Handlers (api/_teacherAdmin.js)
 * Internal server-only module (prefixed with _ so Vercel does not count as a function).
 *
 * Implements:
 * 1. createTeacher:
 *    - Validates inputs (teacher_code, full_name, password >= 6 chars)
 *    - Creates Auth user with service role (email = <code lower>@trendz.local)
 *    - Initializes the new teacher through the service client and records the verified admin
 *    - Executes compensating cleanup (deletes Auth user) if database initialization fails
 * 2. manageTeacher:
 *    - Validates target teacher profile
 *    - Dispatches to transactional RPCs:
 *        * update_assignments -> admin_replace_teacher_assignments
 *        * update_permissions -> admin_update_teacher_permissions
 *        * set_active -> admin_set_teacher_active
 *        * reset_password -> updateUserById + teacher_audit_log
 *        * get_audit_log -> queries teacher_audit_log
 *        * get_teacher_details -> queries profile, permissions, assignments
 * 3. teacherEndpointHandler:
 *    - Unified HTTP handler verifying POST and active admin authorization
 *    - Routes action: 'create' / 'create_teacher' / create payload to createTeacher
 *    - Routes 'create_staff' to createStaff (api/_networkStaff.js)
 *    - Routes management actions to manageTeacher
 */

import { getAdminClient, getCallerClient, verifyAdminCaller, verifyStaffCaller } from './_supabaseAdmin.js';
import { getTeacherWebinarEmail, normalizeCohostEmail } from './_teacherWebinarEmail.js';
import { createStaff } from './_networkStaff.js';

/**
 * Handles teacher creation with compensating cleanup on database failure
 */
export async function createTeacher(req, res, adminCaller = null) {
  const caller = adminCaller || (await verifyAdminCaller(req));

  const {
    teacher_code,
    full_name,
    password,
    webinar_email,
    permissions = {},
    assigned_student_ids = []
  } = req.body || {};

  if (!teacher_code || !full_name || !password) {
    return res.status(400).json({
      error: 'Teacher code, full name, and initial password are required.'
    });
  }

  if (String(password).trim().length < 6) {
    return res.status(400).json({
      error: 'Password must be at least 6 characters long.'
    });
  }

  const cleanCode = teacher_code.trim().toUpperCase();
  const cleanName = full_name.trim();
  const email = `${cleanCode.toLowerCase()}@trendz.local`;
  const webinarEmail = normalizeCohostEmail(webinar_email);
  if (webinar_email && (!webinarEmail || webinarEmail === normalizeCohostEmail(process.env.WEBINAR_GG_HOST_EMAIL))) {
    return res.status(400).json({ error: 'Enter the teacher’s own email for Webinar.gg.' });
  }

  const supabaseAdmin = getAdminClient();

  // 1. Create user in Supabase Auth (server-side administrative Auth)
  const { data: authUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: password.trim(),
    email_confirm: true,
    ...(webinarEmail ? { app_metadata: { webinar_cohost_email: webinarEmail } } : {}),
    user_metadata: {
      teacher_code: cleanCode,
      full_name: cleanName,
      role: 'teacher'
    }
  });

  if (createAuthError) {
    return res.status(400).json({ error: createAuthError.message });
  }

  const teacherUserId = authUser.user.id;

  // 2. Validate & clean student IDs array
  const validStudentIds = Array.isArray(assigned_student_ids)
    ? assigned_student_ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
    : [];

  // Auth may have created a default student profile. Initialize only this new user
  // through the server-only client, with the verified admin as the audit actor.
  const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
    'admin_create_teacher_entry',
    {
      p_teacher_id: teacherUserId,
      p_teacher_code: cleanCode,
      p_full_name: cleanName,
      p_permissions: permissions,
      p_student_ids: validStudentIds,
      p_actor_id: caller.id,
    }
  );

  if (rpcError) {
    // Checked compensating cleanup: delete Auth user so no orphaned auth row remains
    console.warn('Compensating cleanup: Deleting Auth user after DB initialization failure:', rpcError.message);
    const { error: delAuthErr } = await supabaseAdmin.auth.admin.deleteUser(teacherUserId);
    if (delAuthErr) {
      console.error('Failed compensating auth cleanup:', delAuthErr);
    }

    return res.status(400).json({
      error: 'Failed to initialize teacher in database: ' + (rpcError.message || 'Unknown error')
    });
  }

  // 4. Fetch created profile to return to client
  const { data: teacherProfile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', teacherUserId)
    .single();

  return res.status(200).json({
    success: true,
    teacher: teacherProfile,
    permissions: rpcData?.permissions || permissions,
    assigned_count: rpcData?.assigned_count || 0
  });
}

/**
 * Handles teacher management actions (assignments, permissions, status, password, details)
 */
export async function manageTeacher(req, res, adminCaller = null) {
  const caller = adminCaller || (await verifyAdminCaller(req));

  const { action, teacher_id } = req.body || {};

  if (!action || !teacher_id) {
    return res.status(400).json({ error: 'Action and teacher_id are required.' });
  }

  const supabaseAdmin = getAdminClient();
  const dbClient = getCallerClient(caller.accessToken);

  // Verify target is a valid teacher profile
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

  if (action === 'get_webinar_email') {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(teacher_id);
    if (error || !data?.user) {
      return res.status(502).json({ error: 'Could not load the teacher’s Webinar email. Try again.' });
    }
    return res.status(200).json({ success: true, webinar_email: getTeacherWebinarEmail(data.user) });
  }

  if (action === 'set_webinar_email') {
    const email = normalizeCohostEmail(req.body.webinar_email);
    if (!email || email === normalizeCohostEmail(process.env.WEBINAR_GG_HOST_EMAIL)) {
      return res.status(400).json({ error: 'Enter the teacher’s own email for Webinar.gg.' });
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(teacher_id, {
      app_metadata: { webinar_cohost_email: email },
    });
    if (error) {
      return res.status(502).json({ error: 'Could not save the teacher’s Webinar email. Try again.' });
    }
    return res.status(200).json({ success: true });
  }

  // Action: Update Assignments (Transactional Replacement)
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
        p_actor_id: caller.id,
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

  // Action: Update Permissions
  if (action === 'update_permissions') {
    const { permissions = {} } = req.body;

    const { data: rpcData, error: rpcErr } = await dbClient.rpc(
      'admin_update_teacher_permissions',
      {
        p_teacher_id: teacher_id,
        p_permissions: permissions,
        p_actor_id: caller.id,
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

  // Action: Toggle Active State
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
        p_actor_id: caller.id,
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

  // Action: Reset Password
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
      actor_id: caller.id,
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

  // Action: Fetch Audit Logs
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

  // Action: Fetch Teacher Details
  if (action === 'get_teacher_details') {
    const [permsRes, assignRes] = await Promise.all([
      supabaseAdmin.from('teacher_permissions').select('*').eq('teacher_id', teacher_id).maybeSingle(),
      supabaseAdmin
        .from('teacher_student_assignments')
        .select('student_id, profiles!teacher_student_assignments_student_id_fkey!inner(id, student_code, full_name, level, active)')
        .is('profiles.deleted_at', null)
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
}

/**
 * Dedicated createTeacherHandler for standalone/test calls with complete error handling
 */
export async function createTeacherHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    const adminCaller = await verifyAdminCaller(req);
    return await createTeacher(req, res, adminCaller);
  } catch (err) {
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : err.message?.includes('Forbidden') ? 403 : 500);
    return res.status(status).json({
      error: err.message || 'Internal Server Error',
    });
  }
}

/**
 * Unified deployed endpoint handler
 */
export async function teacherEndpointHandler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body || {};
    const action = body.action;

    // Owners and directors creating network or centre staff
    if (action === 'create_staff') {
      const staffCaller = await verifyStaffCaller(req, { minRole: 'director' });
      return await createStaff(req, res, staffCaller);
    }

    // 1. Verify caller is an authenticated active admin
    const adminCaller = await verifyAdminCaller(req);

    // Creation dispatch: explicit action or creation payload fields
    if (action === 'create' || action === 'create_teacher' || (!action && body.teacher_code && body.password)) {
      return await createTeacher(req, res, adminCaller);
    }

    // Management dispatch
    return await manageTeacher(req, res, adminCaller);
  } catch (err) {
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : err.message?.includes('Forbidden') ? 403 : 500);
    return res.status(status).json({
      error: err.message || 'Internal Server Error',
    });
  }
}
