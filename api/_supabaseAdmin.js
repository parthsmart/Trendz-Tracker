/**
 * Trendz Tracker - Server-Side Supabase Admin Helper
 * Uses the Service Role Key to execute administrative Auth operations.
 * Strictly verifies the incoming JWT belongs to a user with role === 'admin'.
 */

import { createClient } from '@supabase/supabase-js';
import {
  getSupabaseAdminConfig,
  getSupabaseServerConfig,
  hasSupabaseAdminConfig,
} from './_configHelper.js';

export function getAdminClient() {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

/**
 * Creates a server-side Supabase client authenticated with the caller's Bearer JWT
 * using the public URL and Anon Key. Used when verifying admin sessions or executing
 * admin-authorized queries when SUPABASE_SERVICE_ROLE_KEY is not configured.
 * @param {string} token
 */
export function getCallerClient(token) {
  const { url, anonKey } = getSupabaseServerConfig();

  return createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  });
}

/**
 * Extracts and verifies the Bearer JWT token from the Request header,
 * checking that the user exists and has role === 'admin' in public.profiles.
 * @param {Request | Object} req
 * @returns {Promise<Object>} The authenticated admin profile (including accessToken)
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
  const supabase = hasSupabaseAdminConfig() ? getAdminClient() : getCallerClient(token);

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

  return {
    ...profile,
    accessToken: token,
  };
}
