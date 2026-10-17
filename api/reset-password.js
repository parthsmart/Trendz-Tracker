/**
 * Vercel Serverless Function: /api/reset-password
 * Resets a student's password using Supabase Service Role Key.
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
    const { student_id, new_password } = req.body || {};

    if (!student_id || !new_password) {
      return res.status(400).json({ error: 'Student ID and new password are required.' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const supabaseAdmin = getAdminClient();

    // 3. Update password in Supabase Auth
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(student_id, {
      password: new_password.trim()
    });

    if (updateError) {
      return res.status(400).json({ error: updateError.message });
    }

    return res.status(200).json({
      success: true,
      message: 'Student password has been updated successfully.'
    });
  } catch (err) {
    console.error('Error in /api/reset-password:', err);
    return res.status(err.message.includes('Unauthorized') ? 401 : 403).json({
      error: err.message || 'Internal Server Error'
    });
  }
}
