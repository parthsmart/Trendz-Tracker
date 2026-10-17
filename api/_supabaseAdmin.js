/**
 * Trendz Tracker - Server-Side Supabase Admin Helper
 * Uses the Service Role Key to execute administrative Auth operations.
 * Strictly verifies the incoming JWT belongs to a user with role === 'admin'.
 */

import { createClient } from '@supabase/supabase-js';

function getCleanUrl() {
  const rawUrl = process.env.SUPABASE_URL || '';
  return rawUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

export function getAdminClient() {
  const supabaseUrl = getCleanUrl();
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim() : '';

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Server configuration error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment variables.');
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Extracts and verifies the Bearer JWT token from the Request header,
 * checking that the user exists and has role === 'admin' in public.profiles.
 * @param {Request | Object} req
 * @returns {Promise<Object>} The authenticated admin profile
 */
export async function verifyAdminCaller(req) {
  // Support both Node/Express (req.headers.authorization) and Fetch Request (req.headers.get)
  let authHeader = '';
  if (req.headers) {
    if (typeof req.headers.get === 'function') {
      authHeader = req.headers.get('authorization') || '';
    } else {
      authHeader = req.headers.authorization || req.headers.Authorization || '';
    }
  }

  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized: Missing or invalid Bearer token.');
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const supabase = getAdminClient();

  // 1. Verify token with Supabase Auth
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    throw new Error('Unauthorized: Invalid authentication session.');
  }

  // 2. Query public.profiles to verify role is admin
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, student_code, role, active')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    throw new Error('Forbidden: Caller profile not found.');
  }

  if (profile.role !== 'admin' || !profile.active) {
    throw new Error('Forbidden: Admin access required.');
  }

  return profile;
}
