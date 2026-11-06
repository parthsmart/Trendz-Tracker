/**
 * Vercel Serverless Function: /api/create-teacher
 * Creates a teacher in Supabase Auth and invokes public.admin_create_teacher_entry
 * to atomically initialize public.profiles, public.teacher_permissions,
 * public.teacher_student_assignments, and public.teacher_audit_log.
 *
 * If database initialization fails, a checked compensating cleanup deletes the
 * Auth user and returns a descriptive error.
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
    const {
      teacher_code,
      full_name,
      password,
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

    const supabaseAdmin = getAdminClient();

    // 3. Create user in Supabase Auth (server-side administrative Auth)
    const { data: authUser, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: password.trim(),
      email_confirm: true,
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

    // 4. Validate & clean student IDs array
    const validStudentIds = Array.isArray(assigned_student_ids)
      ? assigned_student_ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];

    // 5. Invoke atomic database initialization RPC
    // Use the verified administrator's authenticated caller context
    const dbClient = getCallerClient(adminCaller.accessToken);

    const { data: rpcData, error: rpcError } = await dbClient.rpc(
      'admin_create_teacher_entry',
      {
        p_teacher_id: teacherUserId,
        p_teacher_code: cleanCode,
        p_full_name: cleanName,
        p_permissions: permissions,
        p_student_ids: validStudentIds,
        p_actor_id: adminCaller.id,
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

    // 6. Fetch created profile to return to client
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
  } catch (err) {
    console.error('Error in /api/create-teacher:', err);
    const status = err.statusCode || (err.message?.includes('Unauthorized') ? 401 : err.message?.includes('Forbidden') ? 403 : 500);
    return res.status(status).json({
      error: err.message || 'Internal Server Error'
    });
  }
}
